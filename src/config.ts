// YAML config loader + validator for relay.
//
// See relay.md §Configuration schema and §Startup and backfill behavior.
//
// Design notes:
//  - No zod/schema lib — we hand-roll validation so the dep count stays low
//    and error messages include a useful JSON path (e.g.
//    `sources[2].tiers.call.outcome`).
//  - Snake_case YAML keys map to camelCase on the TypeScript types (see
//    src/types.ts). The mapping is explicit to keep YAML idiomatic while the
//    rest of the code stays in camelCase.
//  - `${VAR}` references inside string values are expanded from
//    `process.env` before validation. Missing env vars throw with a clear
//    message so operators see the name of the variable they forgot.
//  - Echo-loop safeguard: if `inbound_types` is empty for a source, we
//    auto-inject `['human_input']` and emit a warning. The dispatcher falls
//    back to `'human_input'` when appending an inbound line, and if the
//    list doesn't contain that type, the line it just wrote would be
//    republished as a new outbound message — a classic echo loop. We prefer
//    quiet correctness (inject + warn) over rejecting the config, since
//    rejecting would block startup on a warning-severity misconfiguration.
//
// Phase 2 split: the config file no longer declares provider credentials or
// named group references. Bot tokens live in the relay repo's own `.env`
// (see src/credentials.ts), and each source carries its raw destination
// `group_id` directly. The top-level `providers:` block has been removed.

import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';

import type { RelayConfig, SourceConfig, Tier } from './types.ts';

// Return shape of loadConfig. `warnings` may include the echo-loop auto-inject
// notice and any other non-fatal diagnostics.
export interface LoadConfigResult {
  config: RelayConfig;
  warnings: string[];
}

const VALID_TIERS: ReadonlyArray<Tier> = ['silent', 'notify', 'ignore'];

// Providers the loader knows have group-id semantics. Other providers
// (stdout) don't require a `group_id`.
const PROVIDERS_REQUIRING_GROUP_ID: ReadonlySet<string> = new Set(['telegram']);

function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

// Recursively walk an unknown value and expand any `${VAR}` references inside
// strings. Throws if an env var referenced by name is not set.
function expandEnv(value: unknown, pathStr: string): unknown {
  if (typeof value === 'string') {
    return value.replace(/\$\{([^}]+)\}/g, (_match, varName: string) => {
      const envValue = process.env[varName];
      if (envValue === undefined) {
        throw new Error(
          `Config error at ${pathStr}: environment variable "${varName}" is not set`,
        );
      }
      return envValue;
    });
  }
  if (Array.isArray(value)) {
    return value.map((v, i) => expandEnv(v, `${pathStr}[${i}]`));
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = expandEnv(v, pathStr === '' ? k : `${pathStr}.${k}`);
    }
    return out;
  }
  return value;
}

// Small helpers for validation. Each throws with the JSON path on failure.
function requireObject(
  v: unknown,
  pathStr: string,
): Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) {
    throw new Error(`Invalid config at ${pathStr}: expected object`);
  }
  return v as Record<string, unknown>;
}

function requireString(v: unknown, pathStr: string): string {
  if (typeof v !== 'string') {
    throw new Error(`Invalid config at ${pathStr}: expected string`);
  }
  return v;
}

function requireNonEmptyString(v: unknown, pathStr: string): string {
  const s = requireString(v, pathStr);
  if (s.length === 0) {
    throw new Error(`Invalid config at ${pathStr}: must be a non-empty string`);
  }
  return s;
}

function requireArray(v: unknown, pathStr: string): unknown[] {
  if (!Array.isArray(v)) {
    throw new Error(`Invalid config at ${pathStr}: expected array`);
  }
  return v;
}

function validateTiers(
  raw: unknown,
  pathStr: string,
): Record<string, Tier> {
  const obj = requireObject(raw, pathStr);
  const out: Record<string, Tier> = {};
  for (const [type, val] of Object.entries(obj)) {
    if (typeof val !== 'string' || !VALID_TIERS.includes(val as Tier)) {
      throw new Error(
        `Invalid config at ${pathStr}.${type}: must be 'silent' | 'notify' | 'ignore'`,
      );
    }
    out[type] = val as Tier;
  }
  return out;
}

function validateSource(
  raw: unknown,
  pathStr: string,
  warnings: string[],
): SourceConfig {
  const obj = requireObject(raw, pathStr);
  const name = requireNonEmptyString(obj.name, `${pathStr}.name`);
  const pathGlob = requireNonEmptyString(obj.path_glob, `${pathStr}.path_glob`);
  const provider = requireNonEmptyString(obj.provider, `${pathStr}.provider`);

  // `group_id` validation. For providers that require one (telegram), the
  // value must be a finite integer. Telegram supergroup ids are negative
  // (start with -100...), so we enforce that too — a positive id is almost
  // certainly a misconfiguration (e.g. a user id, not a chat id).
  let groupId: number | undefined;
  if (obj.group_id !== undefined) {
    if (typeof obj.group_id !== 'number' || !Number.isFinite(obj.group_id)) {
      throw new Error(
        `Invalid config at ${pathStr}.group_id: expected number (chat id)`,
      );
    }
    if (!Number.isInteger(obj.group_id)) {
      throw new Error(
        `Invalid config at ${pathStr}.group_id: expected integer, got ${obj.group_id}`,
      );
    }
    groupId = obj.group_id;
  }
  if (PROVIDERS_REQUIRING_GROUP_ID.has(provider)) {
    if (groupId === undefined) {
      throw new Error(
        `Invalid config at ${pathStr}.group_id: required for provider "${provider}"`,
      );
    }
    if (provider === 'telegram' && groupId >= 0) {
      throw new Error(
        `Invalid config at ${pathStr}.group_id: Telegram supergroup ids are negative (start with -100...); got ${groupId}`,
      );
    }
  }

  let inboundTypes: string[];
  if (obj.inbound_types === undefined) {
    inboundTypes = [];
  } else {
    const arr = requireArray(obj.inbound_types, `${pathStr}.inbound_types`);
    inboundTypes = arr.map((v, i) =>
      requireString(v, `${pathStr}.inbound_types[${i}]`),
    );
  }

  // Echo-loop safeguard: an empty inbound_types means the line the dispatcher
  // writes on inbound (type defaults to 'human_input') would be re-published
  // back out as an outbound message. Auto-inject 'human_input' so the
  // loopback guard in dispatch.handleLine catches it, and warn loudly.
  if (inboundTypes.length === 0) {
    inboundTypes = ['human_input'];
    warnings.push(
      `source "${name}" at ${pathStr}: inbound_types was empty; auto-injected ['human_input'] to prevent echo loop. Set it explicitly to silence this warning.`,
    );
  }

  const tiers =
    obj.tiers === undefined
      ? {}
      : validateTiers(obj.tiers, `${pathStr}.tiers`);

  const out: SourceConfig = {
    name,
    pathGlob,
    provider,
    inboundTypes,
    tiers,
  };
  if (groupId !== undefined) {
    out.groupId = groupId;
  }
  // Optional per-source `tier_key`. When absent, consumers default to `"type"`
  // at the call site (see src/dispatch.ts and src/render.ts) — we deliberately
  // do NOT inject a default here so the raw config stays a faithful view of
  // the YAML.
  if (obj.tier_key !== undefined) {
    out.tierKey = requireNonEmptyString(obj.tier_key, `${pathStr}.tier_key`);
  }

  // Optional outbound field allowlist. Non-empty array of non-empty strings
  // with no duplicates (duplicates usually signal a typo, not intent).
  if (obj.deliver_fields !== undefined) {
    const arr = requireArray(obj.deliver_fields, `${pathStr}.deliver_fields`);
    if (arr.length === 0) {
      throw new Error(
        `Invalid config at ${pathStr}.deliver_fields: must be non-empty when set (omit the key to deliver all fields)`,
      );
    }
    const fields: string[] = [];
    const seenFields = new Set<string>();
    for (let i = 0; i < arr.length; i++) {
      const field = requireNonEmptyString(
        arr[i],
        `${pathStr}.deliver_fields[${i}]`,
      );
      if (seenFields.has(field)) {
        throw new Error(
          `Invalid config at ${pathStr}.deliver_fields[${i}]: duplicate field "${field}"`,
        );
      }
      seenFields.add(field);
      fields.push(field);
    }
    out.deliverFields = fields;
  }

  // Optional per-field character cap. Only meaningful alongside
  // `deliver_fields`; reject it standalone so operators don't quietly get
  // "the cap is set but nothing is being projected" when they forget the
  // companion key.
  if (obj.deliver_field_max_chars !== undefined) {
    if (out.deliverFields === undefined) {
      throw new Error(
        `Invalid config at ${pathStr}.deliver_field_max_chars: only valid when deliver_fields is also set`,
      );
    }
    const v = obj.deliver_field_max_chars;
    if (typeof v !== 'number' || !Number.isFinite(v) || !Number.isInteger(v)) {
      throw new Error(
        `Invalid config at ${pathStr}.deliver_field_max_chars: expected integer, got ${String(v)}`,
      );
    }
    if (v < 20 || v > 4096) {
      throw new Error(
        `Invalid config at ${pathStr}.deliver_field_max_chars: must be in [20, 4096], got ${v}`,
      );
    }
    out.deliverFieldMaxChars = v;
  }

  if (obj.backfill !== undefined) {
    if (typeof obj.backfill !== 'boolean') {
      throw new Error(
        `Invalid config at ${pathStr}.backfill: expected boolean`,
      );
    }
    out.backfill = obj.backfill;
  }
  return out;
}

export async function loadConfig(
  configPath: string,
): Promise<LoadConfigResult> {
  const resolved = expandHome(configPath);
  let raw: string;
  try {
    raw = await fsp.readFile(resolved, 'utf8');
  } catch (err) {
    throw new Error(
      `Failed to read config at ${resolved}: ${(err as Error).message}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = YAML.parse(raw);
  } catch (err) {
    throw new Error(
      `Failed to parse YAML at ${resolved}: ${(err as Error).message}`,
    );
  }

  // Expand ${VAR} refs before validation so required-string checks see the
  // fully-resolved text and env-missing errors include the YAML path.
  const expanded = expandEnv(parsed, '');

  const top = requireObject(expanded, '<root>');

  const sourcesRaw = requireArray(top.sources, 'sources');
  if (sourcesRaw.length === 0) {
    throw new Error(`Invalid config at sources: must contain at least one entry`);
  }

  const warnings: string[] = [];
  const seenNames = new Set<string>();
  const sources: SourceConfig[] = [];
  for (let i = 0; i < sourcesRaw.length; i++) {
    const src = validateSource(sourcesRaw[i], `sources[${i}]`, warnings);
    if (seenNames.has(src.name)) {
      throw new Error(
        `Invalid config at sources[${i}].name: duplicate source name "${src.name}"`,
      );
    }
    seenNames.add(src.name);
    sources.push(src);
  }

  return {
    config: { sources },
    warnings,
  };
}
