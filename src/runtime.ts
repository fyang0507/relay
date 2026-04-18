// Startup orchestrator. Wires config → state → providers → watcher → dispatcher
// and owns file-discovery/provisioning. See relay.md §Startup and backfill
// behavior and §Viewer-side reconciliation.
//
// Responsibility split vs. dispatch:
//   - Runtime owns 'fileDiscovered' (resolve source, provision destination,
//     decide starting offset, call state.setSource, call watcher.trackFile).
//   - Runtime owns 'truncated' (log a warning; V1 halts tailing — watcher has
//     already done this. We deliberately do NOT reset state; a human must
//     decide whether to re-enable the source.)
//   - Dispatcher owns 'line' and inbound. See src/dispatch.ts.
//
// Provision failures are logged and the file is NOT tracked. Future V2: retry
// queue with backoff.

import fsp from 'node:fs/promises';
import path from 'node:path';

import type { RelayConfig, SourceConfig } from './types.ts';
import type { RelayState } from './state.ts';
import type { RelayWatcher } from './watch.ts';
import type { RelayDispatcher } from './dispatch.ts';
import type { Provider } from './providers/types.ts';

export interface RelayOptions {
  // Force backfill from offset 0 for every newly-discovered source. Overrides
  // the default "mark-as-read on first discovery" policy (see relay.md).
  backfill?: boolean;
}

export interface RelayConstructorOpts {
  config: RelayConfig;
  state: RelayState;
  providers: Map<string, Provider>;
  watcher: RelayWatcher;
  dispatcher: RelayDispatcher;
  options?: RelayOptions;
}

export class Relay {
  private readonly config: RelayConfig;
  private readonly state: RelayState;
  private readonly providers: Map<string, Provider>;
  private readonly watcher: RelayWatcher;
  private readonly dispatcher: RelayDispatcher;
  private readonly options: RelayOptions;

  private readonly sourcesByName: Map<string, SourceConfig>;

  // Bound handlers so start() and stop() attach/detach the same references.
  private readonly onFileDiscovered: (filePath: string, sourceName: string) => void;
  private readonly onTruncated: (filePath: string) => void;

  private started = false;
  private stopped = false;

  constructor(opts: RelayConstructorOpts) {
    this.config = opts.config;
    this.state = opts.state;
    this.providers = opts.providers;
    this.watcher = opts.watcher;
    this.dispatcher = opts.dispatcher;
    this.options = opts.options ?? {};
    this.sourcesByName = new Map(this.config.sources.map((s) => [s.name, s]));

    this.onFileDiscovered = (filePath, sourceName) => {
      // Fire-and-forget: the watcher emits synchronously but provisioning may
      // involve network I/O. State writes are serialized internally.
      void this.handleFileDiscovered(filePath, sourceName).catch((err) => {
        console.warn(
          `[runtime] uncaught error while handling fileDiscovered for ${filePath}: ${(err as Error).message}`,
        );
      });
    };
    this.onTruncated = (filePath) => {
      // V1: watcher already halted tailing. We warn; an operator must decide
      // whether to reset state to resume (e.g. by manually editing state.json).
      console.warn(
        `[runtime] file truncated or rotated: ${filePath}. Halting tail; file state preserved. V1 does not auto-recover; operator intervention required.`,
      );
    };
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    // Attach handlers BEFORE starting watcher so pre-existing files get
    // provisioned on the initial scan.
    this.watcher.on('fileDiscovered', this.onFileDiscovered);
    this.watcher.on('truncated', this.onTruncated);

    // Start the dispatcher first so inbound loops are live and the 'line'
    // handler is attached before the watcher starts emitting.
    await this.dispatcher.start();

    // Now start the watcher. It will emit 'fileDiscovered' for every
    // pre-existing matching file and subsequently for new ones.
    await this.watcher.start();
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;

    // Detach our handlers so a stray late event can't race with teardown.
    this.watcher.off('fileDiscovered', this.onFileDiscovered);
    this.watcher.off('truncated', this.onTruncated);

    // Order matters: stop inbound loops, stop watcher (no more outbound
    // events), close providers (release sockets/handles), flush state.
    await this.dispatcher.stop();
    await this.watcher.stop();
    for (const provider of this.providers.values()) {
      if (typeof provider.close === 'function') {
        try {
          await provider.close();
        } catch (err) {
          console.warn(
            `[runtime] provider "${provider.name}".close() threw: ${(err as Error).message}`,
          );
        }
      }
    }
    await this.state.flush();
  }

  private async handleFileDiscovered(
    filePath: string,
    sourceName: string,
  ): Promise<void> {
    const source = this.sourcesByName.get(sourceName);
    if (!source) {
      console.warn(
        `[runtime] fileDiscovered for unknown source "${sourceName}" (${filePath}); ignoring`,
      );
      return;
    }

    const existing = this.state.getSource(filePath);
    if (existing) {
      if (existing.disabled) {
        // Mapping was disabled (e.g. topic deleted). Do NOT re-provision or
        // track — requires human reconfig per relay.md §Viewer-side
        // reconciliation.
        console.warn(
          `[runtime] source mapping for ${filePath} is disabled (${existing.disabledReason ?? 'no reason recorded'}); skipping trackFile`,
        );
        return;
      }
      // Resume: we've seen this file before — keep its stored offset and
      // destination; just resume tailing.
      this.watcher.trackFile(filePath, existing.offset, sourceName);
      return;
    }

    // Fresh file — provision a destination.
    const provider = this.providers.get(source.provider);
    if (!provider) {
      console.warn(
        `[runtime] no provider "${source.provider}" registered for source "${sourceName}"; cannot provision ${filePath}`,
      );
      return;
    }

    const filenameStem = path.basename(filePath, path.extname(filePath));
    // Providers that have a user-visible topic/channel name (e.g. Telegram
    // forum topics) derive it from `meta.filenameStem`. Developers who want a
    // custom title rename the file — collisions are a config mistake, not a
    // runtime concern.

    let destination;
    try {
      destination = await provider.provision({
        sourceName,
        filenameStem,
        filePath,
        providerGroup: source.group || undefined,
      });
    } catch (err) {
      // Loud log; do NOT track. V2: queue for retry with backoff.
      console.warn(
        `[runtime] provider "${provider.name}".provision failed for ${filePath}: ${(err as Error).message}. File NOT tracked.`,
      );
      return;
    }

    // Starting offset: backfill from 0 if either the global flag or the
    // per-source flag is set; otherwise mark-as-read (stat the file and use
    // its current size). See relay.md §Startup and backfill behavior.
    const shouldBackfill =
      this.options.backfill === true || source.backfill === true;
    let offset = 0;
    if (!shouldBackfill) {
      try {
        const stat = await fsp.stat(filePath);
        offset = stat.size;
      } catch (err) {
        // File may have disappeared between discovery and stat. Fall back to 0.
        console.warn(
          `[runtime] stat failed for ${filePath}: ${(err as Error).message}; starting at offset 0`,
        );
        offset = 0;
      }
    }

    const destinationKey = provider.destinationKey(destination);
    this.state.setSource(filePath, {
      sourceName,
      offset,
      destination,
      destinationKey,
    });
    this.watcher.trackFile(filePath, offset, sourceName);
  }
}

// Wire SIGINT/SIGTERM → relay.stop() → process.exit. On any exception during
// shutdown we still want the daemon to exit; use a non-zero code so a
// supervisor (launchd/systemd) sees the failure.
export function installSignalHandlers(relay: Relay): void {
  const shutdown = (sig: string) => {
    // Fire once per signal, but defend against duplicate handler invocations
    // from multiple signals arriving in quick succession.
    console.warn(`[runtime] received ${sig}; shutting down`);
    relay
      .stop()
      .then(() => process.exit(0))
      .catch((err) => {
        console.error(
          `[runtime] error during shutdown: ${(err as Error).message}`,
        );
        process.exit(1);
      });
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}
