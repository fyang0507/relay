// Domain types for relay-core. See relay.md for the full design.

// Per-type delivery policy. See relay.md §Provider contract: the four primitives.
export type Tier = 'silent' | 'notify' | 'ignore';

// Provider settings for one source. Discriminated by `type`. Each provider
// owns its own sub-schema so the top-level `SourceConfig` stays provider-
// agnostic — adding a Slack / Discord / email provider is a new variant
// here, not another special-case on SourceConfig.
export type ProviderConfig =
  | { type: 'telegram'; groupId: number }
  | { type: 'stdout' };

// One entry of `sources[]` in relay.config.yaml. See relay.md §Configuration schema.
//
// Phase 2: credentials (bot tokens) live in the relay repo's own `.env` via
// `src/credentials.ts`, not in the config file.
//
// Phase 3 (issue #6): provider settings are nested under `provider:` so the
// top-level object carries only provider-agnostic fields. Telegram-specific
// `group_id` lives on `provider`, not at the source root.
export interface SourceConfig {
  name: string;
  pathGlob: string;
  provider: ProviderConfig;
  inboundTypes: string[];
  tiers: Record<string, Tier>;
  // Field name to consult on each JSONL entry for loopback/tier lookups and
  // inbound appends. Defaults to `"type"` at the consumer site (see
  // src/dispatch.ts). Optional at the interface so an unset config stays
  // idiomatic.
  tierKey?: string;
  // Outbound field allowlist. When set, renderLine projects each parsed entry
  // to these top-level keys (in this order) before stringifying. Missing keys
  // are silently absent. The filter is source-wide, so operators whose source
  // emits multiple line shapes must pick a union that covers all of them.
  // Nested paths are not supported. See src/render.ts.
  deliverFields?: string[];
  // Per-field character cap. Only valid alongside `deliverFields`. Each listed
  // field's rendered value is individually capped at this many chars (strings
  // truncated + '...'; non-string values probed via JSON.stringify and
  // replaced with a truncated stringified form if over). Prevents one large
  // field from starving the rest. See src/render.ts.
  deliverFieldMaxChars?: number;
  backfill?: boolean;
}

// Top-level shape of relay.config.yaml. See relay.md §Configuration schema.
// Phase 2: there is no top-level `providers:` block anymore; the file
// declares only sources, and credentials come from `.env` (see
// src/credentials.ts).
export interface RelayConfig {
  sources: SourceConfig[];
}

// Minimum shape every JSONL line must carry. See relay.md §Data contract.
// `timestamp` is optional at the type level (relay's outbound rendering no
// longer depends on it — the Telegram client stamps messages itself). The
// inbound-append path still writes a `timestamp` so consumer agents can
// detect what's new on resume.
export interface JsonlEntry {
  type: string;
  timestamp?: string;
  [k: string]: unknown;
}

// Passed to provider.provision when a new source file is discovered. See relay.md §Startup and backfill behavior.
//
// Phase 2: the former `providerGroup` field is gone. Providers that need a
// per-source destination address (Telegram's numeric chat id) read it from
// the `SourceConfig` passed alongside `SourceMetadata` at provision time —
// the runtime hands both in. That keeps `SourceMetadata` focused on
// file-identity fields and leaves provider-specific wiring on the config
// object the caller already holds.
//
// Topic titles are always derived from `filenameStem` by providers that need a
// user-visible title (e.g. Telegram forum topics). Developers who want a
// custom title rename the file.
export interface SourceMetadata {
  sourceName: string;
  filenameStem: string;
  filePath: string;
}
