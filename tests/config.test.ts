// Tests for src/config.ts. Uses node:test.
//
// Phase 2: the YAML config declares only sources. Bot tokens live in the
// relay repo's own `.env` (see src/credentials.ts).
//
// Phase 3 (#6): provider-specific settings (Telegram `group_id`, etc.)
// nest under a `provider:` block keyed by `type`. The top-level object
// stays provider-agnostic.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { loadConfig } from '../src/config.ts';

async function mkTmpConfig(label: string, yaml: string): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), `relay-config-${label}-`));
  const fp = path.join(dir, 'relay.config.yaml');
  await fsp.writeFile(fp, yaml);
  return fp;
}

test('loads a well-formed minimal config and camelCases keys', async () => {
  const fp = await mkTmpConfig(
    'minimal',
    `
sources:
  - name: outreach-campaigns
    path_glob: /tmp/relay-test-campaigns/*.jsonl
    inbound_types: [human_input]
    tiers:
      call.placed: silent
      call.outcome: notify
    provider:
      type: telegram
      group_id: -1003975893613
`,
  );

  const { config, warnings } = await loadConfig(fp);

  assert.equal(warnings.length, 0);
  assert.equal(config.sources.length, 1);
  const src = config.sources[0];
  assert.equal(src.name, 'outreach-campaigns');
  assert.equal(src.pathGlob, '/tmp/relay-test-campaigns/*.jsonl');
  assert.deepEqual(src.provider, {
    type: 'telegram',
    groupId: -1003975893613,
  });
  assert.deepEqual(src.inboundTypes, ['human_input']);
  assert.deepEqual(src.tiers, {
    'call.placed': 'silent',
    'call.outcome': 'notify',
  });
});

test('missing env var throws with variable name in message', async () => {
  delete process.env.RELAY_TEST_MISSING_VAR;
  // env expansion still applies to any string fields (e.g. a dynamic
  // path_glob). Missing vars surface at load time with the variable name.
  const fp = await mkTmpConfig(
    'missing-env',
    `
sources:
  - name: s
    path_glob: /tmp/\${RELAY_TEST_MISSING_VAR}/*.jsonl
    inbound_types: [human_input]
    provider:
      type: telegram
      group_id: -1
`,
  );
  await assert.rejects(
    () => loadConfig(fp),
    /RELAY_TEST_MISSING_VAR/,
  );
});

test('invalid tier value throws with JSON path', async () => {
  const fp = await mkTmpConfig(
    'bad-tier',
    `
sources:
  - name: a
    path_glob: /tmp/a/*.jsonl
    inbound_types: [human_input]
    tiers:
      call.placed: silent
    provider:
      type: telegram
      group_id: -1
  - name: b
    path_glob: /tmp/b/*.jsonl
    inbound_types: [human_input]
    tiers:
      call.placed: silent
    provider:
      type: telegram
      group_id: -1
  - name: c
    path_glob: /tmp/c/*.jsonl
    inbound_types: [human_input]
    tiers:
      call.outcome: bogus
    provider:
      type: telegram
      group_id: -1
`,
  );
  await assert.rejects(
    () => loadConfig(fp),
    /sources\[2\]\.tiers\.call\.outcome/,
  );
});

test('empty inbound_types auto-injects [human_input] and emits warning', async () => {
  const fp = await mkTmpConfig(
    'empty-inbound',
    `
sources:
  - name: s
    path_glob: /tmp/*.jsonl
    inbound_types: []
    tiers: {}
    provider:
      type: telegram
      group_id: -1
`,
  );
  const { config, warnings } = await loadConfig(fp);
  assert.deepEqual(config.sources[0].inboundTypes, ['human_input']);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /auto-injected/);
  assert.match(warnings[0], /human_input/);
});

test('telegram provider without group_id throws with JSON path', async () => {
  const fp = await mkTmpConfig(
    'no-group-id',
    `
sources:
  - name: s
    path_glob: /tmp/*.jsonl
    inbound_types: [human_input]
    provider:
      type: telegram
`,
  );
  await assert.rejects(
    () => loadConfig(fp),
    /sources\[0\]\.provider\.group_id/,
  );
});

test('group_id accepts negative integers (real Telegram supergroup id)', async () => {
  const fp = await mkTmpConfig(
    'neg-int',
    `
sources:
  - name: s
    path_glob: /tmp/*.jsonl
    inbound_types: [human_input]
    provider:
      type: telegram
      group_id: -1003975893613
`,
  );
  const { config } = await loadConfig(fp);
  assert.deepEqual(config.sources[0].provider, {
    type: 'telegram',
    groupId: -1003975893613,
  });
});

test('group_id rejects non-number with JSON path', async () => {
  const fp = await mkTmpConfig(
    'bad-group-id-string',
    `
sources:
  - name: s
    path_glob: /tmp/*.jsonl
    inbound_types: [human_input]
    provider:
      type: telegram
      group_id: "not-a-number"
`,
  );
  await assert.rejects(
    () => loadConfig(fp),
    /sources\[0\]\.provider\.group_id/,
  );
});

test('group_id rejects non-integer (float) with JSON path', async () => {
  const fp = await mkTmpConfig(
    'bad-group-id-float',
    `
sources:
  - name: s
    path_glob: /tmp/*.jsonl
    inbound_types: [human_input]
    provider:
      type: telegram
      group_id: -100.5
`,
  );
  await assert.rejects(
    () => loadConfig(fp),
    /sources\[0\]\.provider\.group_id/,
  );
});

test('group_id rejects positive id for telegram (must be negative)', async () => {
  const fp = await mkTmpConfig(
    'positive-group-id',
    `
sources:
  - name: s
    path_glob: /tmp/*.jsonl
    inbound_types: [human_input]
    provider:
      type: telegram
      group_id: 12345
`,
  );
  await assert.rejects(
    () => loadConfig(fp),
    /sources\[0\]\.provider\.group_id.*negative/,
  );
});

test('duplicate source names throw', async () => {
  const fp = await mkTmpConfig(
    'dup',
    `
sources:
  - name: same
    path_glob: /tmp/a/*.jsonl
    inbound_types: [human_input]
    provider:
      type: telegram
      group_id: -1
  - name: same
    path_glob: /tmp/b/*.jsonl
    inbound_types: [human_input]
    provider:
      type: telegram
      group_id: -1
`,
  );
  await assert.rejects(
    () => loadConfig(fp),
    /duplicate source name/,
  );
});

test('tier_key present: parsed to camelCase tierKey', async () => {
  const fp = await mkTmpConfig(
    'tier-key-present',
    `
sources:
  - name: s
    path_glob: /tmp/*.jsonl
    tier_key: event_type
    inbound_types: [human_input]
    provider:
      type: telegram
      group_id: -1
`,
  );
  const { config } = await loadConfig(fp);
  assert.equal(config.sources[0].tierKey, 'event_type');
});

test('tier_key absent: tierKey is undefined (consumer defaults to "type")', async () => {
  const fp = await mkTmpConfig(
    'tier-key-absent',
    `
sources:
  - name: s
    path_glob: /tmp/*.jsonl
    inbound_types: [human_input]
    provider:
      type: telegram
      group_id: -1
`,
  );
  const { config } = await loadConfig(fp);
  assert.equal(config.sources[0].tierKey, undefined);
});

test('tier_key must be a string when present', async () => {
  const fp = await mkTmpConfig(
    'tier-key-bad',
    `
sources:
  - name: s
    path_glob: /tmp/*.jsonl
    tier_key: 42
    inbound_types: [human_input]
    provider:
      type: telegram
      group_id: -1
`,
  );
  await assert.rejects(
    () => loadConfig(fp),
    /sources\[0\]\.tier_key/,
  );
});

test('tiers default to empty object when omitted', async () => {
  const fp = await mkTmpConfig(
    'defaults',
    `
sources:
  - name: s
    path_glob: /tmp/*.jsonl
    inbound_types: [human_input]
    provider:
      type: telegram
      group_id: -1
`,
  );
  const { config } = await loadConfig(fp);
  assert.deepEqual(config.sources[0].tiers, {});
});

test('stdout provider does not require group_id', async () => {
  // The stdout provider sub-schema takes nothing beyond `type`.
  const fp = await mkTmpConfig(
    'stdout-no-group',
    `
sources:
  - name: s
    path_glob: /tmp/*.jsonl
    inbound_types: [human_input]
    provider:
      type: stdout
`,
  );
  const { config } = await loadConfig(fp);
  assert.deepEqual(config.sources[0].provider, { type: 'stdout' });
});

test('unknown provider type throws with the list of known types', async () => {
  const fp = await mkTmpConfig(
    'unknown-provider',
    `
sources:
  - name: s
    path_glob: /tmp/*.jsonl
    inbound_types: [human_input]
    provider:
      type: carrier-pigeon
`,
  );
  await assert.rejects(
    () => loadConfig(fp),
    /sources\[0\]\.provider\.type.*unknown provider type "carrier-pigeon"/,
  );
});

test('missing provider block throws with actionable message', async () => {
  const fp = await mkTmpConfig(
    'no-provider',
    `
sources:
  - name: s
    path_glob: /tmp/*.jsonl
    inbound_types: [human_input]
`,
  );
  await assert.rejects(
    () => loadConfig(fp),
    /sources\[0\]\.provider.*required/,
  );
});

test('old flat `provider: telegram` + top-level `group_id` shape: rejected with migration hint', async () => {
  // Schema bump in v3 (#6): the old flat form must fail loudly rather than
  // silently misbehave. The error should point the reader at relay.md.
  const fp = await mkTmpConfig(
    'legacy-flat-provider',
    `
sources:
  - name: s
    path_glob: /tmp/*.jsonl
    provider: telegram
    group_id: -1001
    inbound_types: [human_input]
`,
  );
  await assert.rejects(
    () => loadConfig(fp),
    /sources\[0\]\.provider.*expected nested object.*v3.*Configuration schema/s,
  );
});

test('accepts deliver_fields + deliver_field_max_chars and camelCases', async () => {
  const fp = await mkTmpConfig(
    'deliver-fields',
    `
sources:
  - name: s
    path_glob: /tmp/*.jsonl
    inbound_types: [human_input]
    provider:
      type: telegram
      group_id: -1
    deliver_fields: [tool, args, notes]
    deliver_field_max_chars: 500
`,
  );
  const { config } = await loadConfig(fp);
  assert.deepEqual(config.sources[0].deliverFields, ['tool', 'args', 'notes']);
  assert.equal(config.sources[0].deliverFieldMaxChars, 500);
});

test('omitting deliver_fields leaves both fields unset', async () => {
  const fp = await mkTmpConfig(
    'deliver-omitted',
    `
sources:
  - name: s
    path_glob: /tmp/*.jsonl
    inbound_types: [human_input]
    provider:
      type: telegram
      group_id: -1
`,
  );
  const { config } = await loadConfig(fp);
  assert.equal(config.sources[0].deliverFields, undefined);
  assert.equal(config.sources[0].deliverFieldMaxChars, undefined);
});

test('deliver_fields: rejects empty array', async () => {
  const fp = await mkTmpConfig(
    'deliver-empty',
    `
sources:
  - name: s
    path_glob: /tmp/*.jsonl
    inbound_types: [human_input]
    provider:
      type: telegram
      group_id: -1
    deliver_fields: []
`,
  );
  await assert.rejects(
    () => loadConfig(fp),
    /sources\[0\]\.deliver_fields.*non-empty/s,
  );
});

test('deliver_fields: rejects non-array', async () => {
  const fp = await mkTmpConfig(
    'deliver-not-array',
    `
sources:
  - name: s
    path_glob: /tmp/*.jsonl
    inbound_types: [human_input]
    provider:
      type: telegram
      group_id: -1
    deliver_fields: "tool"
`,
  );
  await assert.rejects(
    () => loadConfig(fp),
    /sources\[0\]\.deliver_fields.*expected array/s,
  );
});

test('deliver_fields: rejects empty-string entry', async () => {
  const fp = await mkTmpConfig(
    'deliver-empty-string',
    `
sources:
  - name: s
    path_glob: /tmp/*.jsonl
    inbound_types: [human_input]
    provider:
      type: telegram
      group_id: -1
    deliver_fields: [tool, ""]
`,
  );
  await assert.rejects(
    () => loadConfig(fp),
    /sources\[0\]\.deliver_fields\[1\].*non-empty/s,
  );
});

test('deliver_fields: rejects duplicates', async () => {
  const fp = await mkTmpConfig(
    'deliver-dup',
    `
sources:
  - name: s
    path_glob: /tmp/*.jsonl
    inbound_types: [human_input]
    provider:
      type: telegram
      group_id: -1
    deliver_fields: [tool, args, tool]
`,
  );
  await assert.rejects(
    () => loadConfig(fp),
    /sources\[0\]\.deliver_fields\[2\].*duplicate/s,
  );
});

test('deliver_field_max_chars: rejected when deliver_fields is not set', async () => {
  const fp = await mkTmpConfig(
    'cap-orphan',
    `
sources:
  - name: s
    path_glob: /tmp/*.jsonl
    inbound_types: [human_input]
    provider:
      type: telegram
      group_id: -1
    deliver_field_max_chars: 500
`,
  );
  await assert.rejects(
    () => loadConfig(fp),
    /deliver_field_max_chars.*only valid when deliver_fields/s,
  );
});

test('deliver_field_max_chars: rejects non-integer', async () => {
  const fp = await mkTmpConfig(
    'cap-float',
    `
sources:
  - name: s
    path_glob: /tmp/*.jsonl
    inbound_types: [human_input]
    provider:
      type: telegram
      group_id: -1
    deliver_fields: [tool]
    deliver_field_max_chars: 12.5
`,
  );
  await assert.rejects(
    () => loadConfig(fp),
    /deliver_field_max_chars.*expected integer/s,
  );
});

test('deliver_field_max_chars: rejects out-of-range (too low)', async () => {
  const fp = await mkTmpConfig(
    'cap-low',
    `
sources:
  - name: s
    path_glob: /tmp/*.jsonl
    inbound_types: [human_input]
    provider:
      type: telegram
      group_id: -1
    deliver_fields: [tool]
    deliver_field_max_chars: 10
`,
  );
  await assert.rejects(
    () => loadConfig(fp),
    /deliver_field_max_chars.*\[20, 4096\]/s,
  );
});

test('deliver_field_max_chars: rejects out-of-range (too high)', async () => {
  const fp = await mkTmpConfig(
    'cap-high',
    `
sources:
  - name: s
    path_glob: /tmp/*.jsonl
    inbound_types: [human_input]
    provider:
      type: telegram
      group_id: -1
    deliver_fields: [tool]
    deliver_field_max_chars: 5000
`,
  );
  await assert.rejects(
    () => loadConfig(fp),
    /deliver_field_max_chars.*\[20, 4096\]/s,
  );
});
