// Provider interface. See relay.md §Provider contract: the four primitives.

import type { SourceMetadata, Tier } from '../types.js';

// Opaque, provider-defined address for a destination (e.g. Telegram topic handle).
// See relay.md §Provider contract: the four primitives.
export type Destination = Record<string, unknown>;

// Outcome of a deliver attempt. `disableMapping` signals the destination is
// permanently gone (e.g. deleted topic) — core disables the source mapping.
// See relay.md §Viewer-side reconciliation.
export type DeliverResult =
  | { ok: true }
  | { ok: false; reason: string; disableMapping?: boolean };

// An inbound event produced by `receive`. See relay.md §Provider contract: the four primitives.
export interface InboundEvent {
  destination: Destination;
  text: string;
  raw: unknown;
}

// The four-primitive provider contract. See relay.md §Provider contract: the four primitives.
export interface Provider {
  name: string;
  deliver(destination: Destination, text: string, tier: Tier): Promise<DeliverResult>;
  provision(meta: SourceMetadata): Promise<Destination>;
  receive(signal: AbortSignal): AsyncIterable<InboundEvent>;
  // Stable string key for a destination. Core dispatch uses this to look up
  // source-by-destination on inbound events. Must be deterministic per destination.
  destinationKey(d: Destination): string;
  close?(): Promise<void>;
}
