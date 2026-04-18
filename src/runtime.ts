// Long-running orchestrator with a dynamic source registry. See relay.md
// §Architecture and §Startup and backfill behavior.
//
// Phase 1a: the runtime no longer takes a static `config` at construction;
// the CLI/socket layer (P1b+P4) hands sources in at runtime via addSource()
// and yanks them via removeSource(). On start(), the runtime replays the
// persisted registry so the set of live sources survives restarts.
//
// Responsibility split vs. dispatch:
//   - Runtime owns 'fileDiscovered' (resolve source, provision destination,
//     decide starting offset, call state.setSource with a relayId, call
//     watcher.trackFile).
//   - Runtime owns 'truncated' (log a warning; V1 halts tailing — watcher has
//     already done this. We deliberately do NOT reset state; a human must
//     decide whether to re-enable the source.)
//   - Dispatcher owns 'line' and inbound. See src/dispatch.ts.
//
// Provision failures are logged and the file is NOT tracked. Future V2: retry
// queue with backoff.

import fsp from 'node:fs/promises';
import path from 'node:path';

import type { SourceConfig } from './types.ts';
import type { RelayState, RegistryEntry } from './state.ts';
import type { RelayWatcher } from './watch.ts';
import type { RelayDispatcher } from './dispatch.ts';
import type { Provider } from './providers/types.ts';

export interface RelayOptions {
  // Force backfill from offset 0 for every newly-discovered source. Overrides
  // the default "mark-as-read on first discovery" policy (see relay.md).
  backfill?: boolean;
}

export interface RelayConstructorOpts {
  state: RelayState;
  providers: Map<string, Provider>;
  watcher: RelayWatcher;
  dispatcher: RelayDispatcher;
  options?: RelayOptions;
}

// Flat projection of a live registered source for CLI consumption (P4).
// Phase 2: the old `group` (named reference) is gone; we expose `groupId`
// directly when the source has one (telegram sources always will).
// Phase 3 (#6): `provider` is now the provider type (`"telegram"`, etc.);
// `groupId` is pulled out of the nested `provider.groupId` for Telegram so
// the wire shape the CLI renders stays flat and unchanged from v2.
export interface ListedSource {
  id: string;
  configPath: string;
  sourceName: string;
  provider: string;
  groupId?: number;
  filesTracked: number;
  filesDisabled: number;
  disabled: boolean;
}

export class Relay {
  private readonly state: RelayState;
  private readonly providers: Map<string, Provider>;
  private readonly watcher: RelayWatcher;
  private readonly dispatcher: RelayDispatcher;
  private readonly options: RelayOptions;

  // Bound handlers so start() and stop() attach/detach the same references.
  private readonly onFileDiscovered: (
    filePath: string,
    sourceName: string,
    wasPreexisting: boolean,
  ) => void;
  private readonly onTruncated: (filePath: string) => void;

  private started = false;
  private stopped = false;

  constructor(opts: RelayConstructorOpts) {
    this.state = opts.state;
    this.providers = opts.providers;
    this.watcher = opts.watcher;
    this.dispatcher = opts.dispatcher;
    this.options = opts.options ?? {};

    this.onFileDiscovered = (filePath, sourceName, wasPreexisting) => {
      // Fire-and-forget: the watcher emits synchronously but provisioning may
      // involve network I/O. State writes are serialized internally.
      void this.handleFileDiscovered(filePath, sourceName, wasPreexisting).catch(
        (err) => {
          console.warn(
            `[runtime] uncaught error while handling fileDiscovered for ${filePath}: ${(err as Error).message}`,
          );
        },
      );
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

    // Attach handlers BEFORE wiring any source into the watcher so
    // pre-existing files get provisioned on the initial scan.
    this.watcher.on('fileDiscovered', this.onFileDiscovered);
    this.watcher.on('truncated', this.onTruncated);

    // Start the dispatcher first so inbound loops are live and the 'line'
    // handler is attached before any source emits.
    this.dispatcher.start();

    // Base watcher lifecycle (no-op today, but preserve the hook).
    await this.watcher.start();

    // Replay registry: for each persisted entry, attach its source to the
    // watcher so pre-existing files are rediscovered and re-tracked. The
    // provision path in handleFileDiscovered checks state.getSource and
    // resumes from the stored offset when one exists.
    for (const entry of this.state.listRegistry()) {
      try {
        await this.watcher.addSource(entry.sourceConfig);
      } catch (err) {
        console.warn(
          `[runtime] failed to re-attach source "${entry.sourceConfig.name}" (id=${entry.id}) during start: ${(err as Error).message}`,
        );
      }
    }
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

  // ---- dynamic source registration ---------------------------------------

  // Register a new source at runtime. Idempotent by (configPath,
  // sourceConfig.name): if an entry with the same pair already exists,
  // returns its id without creating a duplicate or re-attaching the
  // watcher. Otherwise generates a fresh `rl_xxx` id, persists the
  // registry entry, and attaches the source to the watcher (which will
  // begin emitting 'fileDiscovered').
  async addSource(
    sourceConfig: SourceConfig,
    configPath: string,
  ): Promise<string> {
    const existing = this.state
      .listRegistry()
      .find(
        (e) =>
          e.configPath === configPath && e.sourceConfig.name === sourceConfig.name,
      );
    if (existing) return existing.id;

    const id = this.state.generateRelayId();
    const entry: RegistryEntry = {
      id,
      configPath,
      sourceConfig,
      addedAt: new Date().toISOString(),
    };
    this.state.addRegistry(entry);
    await this.watcher.addSource(sourceConfig);
    return id;
  }

  // Unregister a source. Returns true if the id was found (and removed),
  // false otherwise. Cascades: stops the directory watcher, untracks tailed
  // files, drops the registry entry, and drops every sources[filePath]
  // entry whose relayId matches (the cascade is driven by
  // state.removeRegistry). State is persisted via the autosave pipeline
  // plus an explicit flush so callers see durable state on return.
  async removeSource(id: string): Promise<boolean> {
    const entry = this.state.getRegistry(id);
    if (!entry) return false;

    // Stop the directory watcher + untrack tails. Do this before dropping
    // state so the watcher's own cleanup doesn't race with state mutation.
    try {
      await this.watcher.removeSource(entry.sourceConfig.name);
    } catch (err) {
      console.warn(
        `[runtime] watcher.removeSource("${entry.sourceConfig.name}") threw: ${(err as Error).message}`,
      );
    }

    // Snapshot the per-file tracking entries before removeRegistry cascades
    // them away — we don't need them for anything beyond logging, but having
    // them on hand makes debug traces useful.
    const tracked = this.state.listSourcesByRelayId(id);
    void tracked; // reserved for future debug logging

    this.state.removeRegistry(id);
    await this.state.flush();
    return true;
  }

  // Flat projection from registry + state. `filesTracked` counts
  // sources[filePath] entries whose relayId matches; `disabled` is true if
  // every tracked file is disabled (or there are no tracked files and the
  // entry is disabled-by-default, which is never the case here — so in
  // practice: true iff there is at least one tracked file and they are all
  // disabled). Conservative: `false` when there are zero tracked files.
  listSources(): ListedSource[] {
    const out: ListedSource[] = [];
    for (const entry of this.state.listRegistry()) {
      const files = this.state.listSourcesByRelayId(entry.id);
      const filesTracked = files.length;
      const filesDisabled = files.filter((f) => f.state.disabled === true).length;
      const disabled = filesTracked > 0 && filesDisabled === filesTracked;
      const listed: ListedSource = {
        id: entry.id,
        configPath: entry.configPath,
        sourceName: entry.sourceConfig.name,
        provider: entry.sourceConfig.provider.type,
        filesTracked,
        filesDisabled,
        disabled,
      };
      if (entry.sourceConfig.provider.type === 'telegram') {
        listed.groupId = entry.sourceConfig.provider.groupId;
      }
      out.push(listed);
    }
    return out;
  }

  // ---- internals ---------------------------------------------------------

  private async handleFileDiscovered(
    filePath: string,
    sourceName: string,
    wasPreexisting: boolean,
  ): Promise<void> {
    // Look up the registry entry by source name. Registry is the single
    // source of truth; we need the relayId to stamp on SourceState.
    const entry = this.state
      .listRegistry()
      .find((e) => e.sourceConfig.name === sourceName);
    if (!entry) {
      console.warn(
        `[runtime] fileDiscovered for unregistered source "${sourceName}" (${filePath}); ignoring`,
      );
      return;
    }
    const source = entry.sourceConfig;

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
    const provider = this.providers.get(source.provider.type);
    if (!provider) {
      console.warn(
        `[runtime] no provider "${source.provider.type}" registered for source "${sourceName}"; cannot provision ${filePath}`,
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
      destination = await provider.provision(
        {
          sourceName,
          filenameStem,
          filePath,
        },
        source,
      );
    } catch (err) {
      // Loud log; do NOT track. V2: queue for retry with backoff.
      console.warn(
        `[runtime] provider "${provider.name}".provision failed for ${filePath}: ${(err as Error).message}. File NOT tracked.`,
      );
      return;
    }

    // Starting offset policy (see relay.md §Startup and backfill behavior,
    // and GH #4 for the "new file" carve-out):
    //   - File created while we're watching (wasPreexisting=false)
    //       → offset 0 unconditionally. We're there to observe it from birth;
    //         stat.size races with the creating write and loses the first line.
    //   - Pre-existing file + backfill flag      → offset 0 (read history).
    //   - Pre-existing file + no backfill (default) → offset = stat.size
    //         (mark-as-read; don't replay the past on startup).
    const shouldBackfill =
      this.options.backfill === true || source.backfill === true;
    let offset = 0;
    if (wasPreexisting && !shouldBackfill) {
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
      relayId: entry.id,
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

// Helper: build the `resolveSource` closure the dispatcher expects. Runtime
// consumers wire it as `new RelayDispatcher({ resolveSource: buildResolveSource(state), ... })`.
// Isolated here rather than inlined at the call site so callers (tests,
// future CLI) don't re-implement the same lambda.
export function buildResolveSource(
  state: RelayState,
): (sourceName: string) => SourceConfig | undefined {
  return (sourceName: string) =>
    state
      .listRegistry()
      .map((e) => e.sourceConfig)
      .find((s) => s.name === sourceName);
}
