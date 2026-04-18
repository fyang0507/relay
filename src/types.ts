// Domain types for relay-core. See relay.md for the full design.

// Per-type delivery policy. See relay.md §Provider contract: the four primitives.
export type Tier = 'silent' | 'notify' | 'ignore';

// Telegram provider credentials and named group IDs. See relay.md §Configuration schema.
export interface TelegramProviderConfig {
  botToken: string;
  groups: Record<string, number>;
}

// One entry of `sources[]` in relay.config.yaml. See relay.md §Configuration schema.
export interface SourceConfig {
  name: string;
  pathGlob: string;
  provider: string;
  group: string;
  inboundTypes: string[];
  tiers: Record<string, Tier>;
  // Field name to consult on each JSONL entry for loopback/tier lookups and
  // inbound appends. Defaults to `"type"` at the consumer site (see
  // src/dispatch.ts). Optional at the interface so an unset config stays
  // idiomatic.
  tierKey?: string;
  backfill?: boolean;
}

// Top-level shape of relay.config.yaml. See relay.md §Configuration schema.
export interface RelayConfig {
  providers: {
    telegram?: TelegramProviderConfig;
  };
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
// `providerGroup` is the name of the provider-side group/channel/space the source
// belongs to (e.g. Telegram's `groups` map key). It is optional on the interface
// because not every provider needs it (iMessage, email have no group concept),
// but the Telegram provider requires it to resolve `groups[providerGroup]` →
// numeric chat id. Core populates it from `SourceConfig.group`.
//
// Topic titles are always derived from `filenameStem` by providers that need a
// user-visible title (e.g. Telegram forum topics). Developers who want a
// custom title rename the file.
export interface SourceMetadata {
  sourceName: string;
  filenameStem: string;
  filePath: string;
  providerGroup?: string;
}
