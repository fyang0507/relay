// Stdout (dry-run) provider. Implements the four-primitive Provider contract
// by writing delivered messages to process.stdout. Useful for smoke-testing
// relay-core end-to-end without a real messaging backend.
//
// See relay.md §Implementation phases — Phase 1 "Dry-run / stdout provider".

import type { SourceMetadata, Tier } from '../types.js';
import type {
  Destination,
  DeliverResult,
  InboundEvent,
  Provider,
} from './types.js';

// Shape of a stdout destination. We only need the source name so the
// destinationKey is stable and the printed prefix stays informative.
export interface StdoutDestination extends Record<string, unknown> {
  sourceName: string;
}

export class StdoutProvider implements Provider {
  public readonly name = 'stdout';

  // Stable per-source key. Used by core dispatch to look up sources from
  // inbound events — which is a no-op here since stdout never yields any.
  destinationKey(d: Destination): string {
    const sd = d as StdoutDestination;
    return `stdout://${sd.sourceName}`;
  }

  // Provisioning a stdout destination is trivial: just carry the source name.
  async provision(meta: SourceMetadata): Promise<Destination> {
    const dest: StdoutDestination = { sourceName: meta.sourceName };
    return dest;
  }

  // Write to stdout with a prefix so multiple sources interleaved in a
  // terminal session remain distinguishable.
  async deliver(
    destination: Destination,
    text: string,
    tier: Tier,
  ): Promise<DeliverResult> {
    const sd = destination as StdoutDestination;
    process.stdout.write(`[stdout][${sd.sourceName}][${tier}] ${text}\n`);
    return { ok: true };
  }

  // Stdout has no inbound channel. We still need to honor the contract:
  // return an async iterable that yields nothing and completes when the
  // caller aborts. This lets `startInbound` treat all providers uniformly.
  async *receive(signal: AbortSignal): AsyncIterable<InboundEvent> {
    if (signal.aborted) return;
    await new Promise<void>((resolve) => {
      const onAbort = () => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      };
      signal.addEventListener('abort', onAbort, { once: true });
    });
    // Intentionally yield nothing.
  }

  async close(): Promise<void> {
    // no-op
  }
}
