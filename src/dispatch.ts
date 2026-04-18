// Core dispatch layer. Wires the watcher, state store, and providers
// together. See relay.md §Architecture ("relay-core owns") and §Data contract.
//
// Responsibilities:
//  - Subscribe to RelayWatcher 'line' events, apply tier policy, call
//    provider.deliver, and advance the per-file offset on success.
//  - Drive an inbound loop per provider with a `receive` implementation,
//    appending inbound text back to the mapped source file (which the
//    watcher will then emit as a normal line — our loopback guard in
//    'line' handling prevents re-publish).
//
// File-discovery / provisioning is deliberately NOT handled here; that
// belongs to the runtime module that also owns startup-scan and backfill.
// Dispatch cares only about 'line' events and inbound events.
//
// Error / retry policy:
//   - deliver → { ok: false, disableMapping: true }: call state.disableSource,
//     do NOT advance offset. On reconfig + re-enable, the same line retries.
//   - deliver → { ok: false } (transient): do NOT advance offset. V1 relies
//     on the next append to trigger another 'line' event which re-enters
//     dispatch. TODO(V2): a retry queue so a source with no further appends
//     isn't stranded on a transient failure.

import { promises as fsp } from 'node:fs';
import type { SourceConfig } from './types.js';
import type { LineEvent, RelayWatcher } from './watch.js';
import type { Provider } from './providers/types.js';
import type { RelayState, SourceState } from './state.js';
import { renderLine } from './render.ts';

export interface RelayDispatcherOptions {
  sources: SourceConfig[];
  state: RelayState;
  providers: Map<string, Provider>;
  watcher: RelayWatcher;
}

export class RelayDispatcher {
  private readonly sources: SourceConfig[];
  private readonly state: RelayState;
  private readonly providers: Map<string, Provider>;
  private readonly watcher: RelayWatcher;

  // Indexed once at construction for O(1) source lookup on every 'line' event.
  private readonly sourcesByName: Map<string, SourceConfig>;

  // Bound handler kept on `this` so start()/stop() can add/remove the same
  // function reference.
  private readonly onLine: (ev: LineEvent) => void;

  // One AbortController per active inbound loop. Populated by start() and
  // drained by stop().
  private readonly inboundControllers: AbortController[] = [];
  private readonly inboundLoops: Promise<void>[] = [];

  private started = false;
  private stopped = false;

  constructor(opts: RelayDispatcherOptions) {
    this.sources = opts.sources;
    this.state = opts.state;
    this.providers = opts.providers;
    this.watcher = opts.watcher;
    this.sourcesByName = new Map(this.sources.map((s) => [s.name, s]));
    this.onLine = (ev) => {
      // Fire-and-forget: the watcher emits synchronously, but our handler is
      // async. We intentionally do NOT block the event loop here. The state
      // store serializes its own writes, so interleaving is safe.
      void this.handleLine(ev);
    };
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.watcher.on('line', this.onLine);

    // Spin up one inbound loop per provider that offers `receive`.
    for (const provider of this.providers.values()) {
      if (typeof provider.receive !== 'function') continue;
      const ac = new AbortController();
      this.inboundControllers.push(ac);
      this.inboundLoops.push(this.runInboundLoop(provider, ac.signal));
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.watcher.off('line', this.onLine);
    for (const ac of this.inboundControllers) {
      try {
        ac.abort();
      } catch {
        // ignore
      }
    }
    // Wait for every inbound loop to finish. We swallow errors here — they
    // will have already been surfaced via whatever logging each loop does.
    await Promise.allSettled(this.inboundLoops);
  }

  // --- outbound (watcher → provider) ---------------------------------------

  private async handleLine(ev: LineEvent): Promise<void> {
    const source = this.sourcesByName.get(ev.sourceName);
    if (!source) {
      // Unknown source — log and skip. Advancing offset would require a
      // state entry we don't have, so this is effectively a no-op.
      console.warn(
        `[dispatch] dropping line from unknown source "${ev.sourceName}" (${ev.filePath})`,
      );
      return;
    }

    const current = this.state.getSource(ev.filePath);
    if (!current) {
      // File not provisioned yet — the runtime module hasn't called
      // state.setSource() for this filePath. Drop silently; runtime will
      // replay by trackFile-from-stored-offset once it is provisioned.
      console.warn(
        `[dispatch] dropping line for unprovisioned file ${ev.filePath}`,
      );
      return;
    }
    if (current.disabled) {
      // Mapping was disabled (e.g. topic deleted). Do nothing; the runtime
      // module is responsible for untracking the file.
      return;
    }

    // Malformed line: advance offset so we don't block on it forever, but
    // do not attempt to deliver.
    if (ev.parsed === null) {
      console.warn(
        `[dispatch] malformed JSON at ${ev.filePath} offset ${ev.lineStartOffset}; skipping`,
      );
      this.advanceOffset(ev.filePath, current, ev.lineEndOffset);
      return;
    }

    // `tier_key` is configurable per-source so consumers can discriminate by
    // their own field (e.g. `event_type`). Default to `"type"` here rather
    // than at config-load so the raw config stays a faithful view of the YAML.
    const keyField = source.tierKey ?? 'type';
    const keyValue = (ev.parsed as Record<string, unknown>)[keyField];

    // Loopback guard: relay itself wrote this line (inbound handler below),
    // so republishing would create an echo. Skip deliver but advance offset.
    if (typeof keyValue === 'string' && source.inboundTypes.includes(keyValue)) {
      this.advanceOffset(ev.filePath, current, ev.lineEndOffset);
      return;
    }

    // Tier policy. Unknown types default to 'silent' per relay.md
    // §Configuration schema ("anything not listed defaults to silent").
    const tier =
      (typeof keyValue === 'string' ? source.tiers[keyValue] : undefined) ??
      'silent';
    if (tier === 'ignore') {
      this.advanceOffset(ev.filePath, current, ev.lineEndOffset);
      return;
    }

    const provider = this.providers.get(source.provider);
    if (!provider) {
      console.warn(
        `[dispatch] no provider "${source.provider}" registered for source "${source.name}"; leaving line for retry`,
      );
      return;
    }

    const text = renderLine(ev.parsed, ev.raw, keyField);

    let result;
    try {
      result = await provider.deliver(current.destination, text, tier);
    } catch (err) {
      // An exception from deliver is treated the same as a transient failure:
      // we don't advance the offset. TODO(V2): retry queue so we don't rely
      // on a subsequent append to drive progress.
      console.warn(
        `[dispatch] provider.deliver threw for ${ev.filePath}: ${(err as Error).message}`,
      );
      return;
    }

    if (result.ok) {
      this.advanceOffset(ev.filePath, current, ev.lineEndOffset);
      return;
    }

    if (result.disableMapping) {
      this.state.disableSource(ev.filePath, result.reason);
      // Do NOT advance offset: once the user reconfigures and we re-enable
      // the mapping, this same line should retry from its original position.
      return;
    }

    // Transient failure: leave offset where it is. A subsequent append will
    // re-enter dispatch; this line will be re-read and re-delivered.
    // TODO(V2): implement a proper retry queue so sources without further
    // appends are not stranded.
    console.warn(
      `[dispatch] transient deliver failure for ${ev.filePath}: ${result.reason}`,
    );
  }

  // Centralized offset advance so we always persist the new value through
  // the state store's own autosave.
  private advanceOffset(
    filePath: string,
    current: SourceState,
    newOffset: number,
  ): void {
    // Guard against out-of-order events where the new offset would move
    // backwards (shouldn't happen with RelayWatcher but defense in depth).
    if (newOffset <= current.offset) return;
    const next: SourceState = { ...current, offset: newOffset };
    this.state.setSource(filePath, next);
  }

  // --- inbound (provider → file) -------------------------------------------

  private async runInboundLoop(
    provider: Provider,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      for await (const event of provider.receive(signal)) {
        if (signal.aborted) return;
        await this.handleInbound(provider, event).catch((err) => {
          console.warn(
            `[dispatch] inbound handler error for provider "${provider.name}": ${(err as Error).message}`,
          );
        });
      }
    } catch (err) {
      if (signal.aborted) return;
      console.warn(
        `[dispatch] inbound loop for "${provider.name}" exited with error: ${(err as Error).message}`,
      );
    }
  }

  private async handleInbound(
    provider: Provider,
    event: { destination: Record<string, unknown>; text: string; raw: unknown },
  ): Promise<void> {
    const key = provider.destinationKey(event.destination);
    const hit = this.state.findSourceByDestinationKey(key);
    if (!hit) {
      console.warn(
        `[dispatch] inbound event for unknown destination key "${key}" (provider ${provider.name}); skipping`,
      );
      return;
    }

    const source = this.sourcesByName.get(hit.state.sourceName);
    if (!source) {
      console.warn(
        `[dispatch] inbound event mapped to unknown source "${hit.state.sourceName}"; skipping`,
      );
      return;
    }

    // Use the first configured inbound type, or fall back to 'human_input'
    // (relay.md uses this type in its sample config). The discriminator field
    // is whatever the source's `tier_key` configures (default `"type"`), so
    // the appended line matches the shape the loopback guard and tier lookup
    // will see when this line is observed back through the watcher.
    //
    // Timestamp is preserved on the inbound side even though outbound
    // rendering drops it: consumer agents use it to decide what's new on
    // resume.
    const keyField = source.tierKey ?? 'type';
    const inboundType = source.inboundTypes[0] ?? 'human_input';
    const line: Record<string, unknown> = {
      [keyField]: inboundType,
      timestamp: new Date().toISOString(),
      text: event.text,
      source: 'relay-inbound',
    };

    // Append to the mapped file. The watcher will observe this append and
    // emit a 'line' event; our loopback guard in handleLine (inboundTypes)
    // prevents it from being re-published back out.
    await fsp.appendFile(hit.filePath, JSON.stringify(line) + '\n');
  }
}
