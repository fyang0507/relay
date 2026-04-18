// Tests for src/config.ts. Uses node:test.
//
// Phase 2: the YAML config declares only sources. Bot tokens live in the
// relay repo's own `.env` (see src/credentials.ts), and each source carries
// its destination `group_id` (raw numeric chat id) directly.

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
    provider: telegram
    group_id: -1003975893613
    inbound_types: [human_input]
    tiers:
      call.placed: silent
      call.outcome: notify
`,
  );

  const { config, warnings } = await loadConfig(fp);

  assert.equal(warnings.length, 0);
  assert.equal(config.sources.length, 1);
  const src = config.sources[0];
  assert.equal(src.name, 'outreach-campaigns');
  assert.equal(src.pathGlob, '/tmp/relay-test-campaigns/*.jsonl');
  assert.equal(src.provider, 'telegram');
  assert.equal(src.groupId, -1003975893613);
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
    provider: telegram
    group_id: -1
    inbound_types: [human_input]
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
    provider: telegram
    group_id: -1
    inbound_types: [human_input]
    tiers:
      call.placed: silent
  - name: b
    path_glob: /tmp/b/*.jsonl
    provider: telegram
    group_id: -1
    inbound_types: [human_input]
    tiers:
      call.placed: silent
  - name: c
    path_glob: /tmp/c/*.jsonl
    provider: telegram
    group_id: -1
    inbound_types: [human_input]
    tiers:
      call.outcome: bogus
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
    provider: telegram
    group_id: -1
    inbound_types: []
    tiers: {}
`,
  );
  const { config, warnings } = await loadConfig(fp);
  assert.deepEqual(config.sources[0].inboundTypes, ['human_input']);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /auto-injected/);
  assert.match(warnings[0], /human_input/);
});

test('telegram source without group_id throws with JSON path', async () => {
  const fp = await mkTmpConfig(
    'no-group-id',
    `
sources:
  - name: s
    path_glob: /tmp/*.jsonl
    provider: telegram
    inbound_types: [human_input]
`,
  );
  await assert.rejects(
    () => loadConfig(fp),
    /sources\[0\]\.group_id/,
  );
});

test('group_id accepts negative integers (real Telegram supergroup id)', async () => {
  const fp = await mkTmpConfig(
    'neg-int',
    `
sources:
  - name: s
    path_glob: /tmp/*.jsonl
    provider: telegram
    group_id: -1003975893613
    inbound_types: [human_input]
`,
  );
  const { config } = await loadConfig(fp);
  assert.equal(config.sources[0].groupId, -1003975893613);
});

test('group_id rejects non-number with JSON path', async () => {
  const fp = await mkTmpConfig(
    'bad-group-id-string',
    `
sources:
  - name: s
    path_glob: /tmp/*.jsonl
    provider: telegram
    group_id: "not-a-number"
    inbound_types: [human_input]
`,
  );
  await assert.rejects(
    () => loadConfig(fp),
    /sources\[0\]\.group_id/,
  );
});

test('group_id rejects non-integer (float) with JSON path', async () => {
  const fp = await mkTmpConfig(
    'bad-group-id-float',
    `
sources:
  - name: s
    path_glob: /tmp/*.jsonl
    provider: telegram
    group_id: -100.5
    inbound_types: [human_input]
`,
  );
  await assert.rejects(
    () => loadConfig(fp),
    /sources\[0\]\.group_id/,
  );
});

test('group_id rejects positive id for telegram (must be negative)', async () => {
  const fp = await mkTmpConfig(
    'positive-group-id',
    `
sources:
  - name: s
    path_glob: /tmp/*.jsonl
    provider: telegram
    group_id: 12345
    inbound_types: [human_input]
`,
  );
  await assert.rejects(
    () => loadConfig(fp),
    /sources\[0\]\.group_id.*negative/,
  );
});

test('duplicate source names throw', async () => {
  const fp = await mkTmpConfig(
    'dup',
    `
sources:
  - name: same
    path_glob: /tmp/a/*.jsonl
    provider: telegram
    group_id: -1
    inbound_types: [human_input]
  - name: same
    path_glob: /tmp/b/*.jsonl
    provider: telegram
    group_id: -1
    inbound_types: [human_input]
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
    provider: telegram
    group_id: -1
    tier_key: event_type
    inbound_types: [human_input]
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
    provider: telegram
    group_id: -1
    inbound_types: [human_input]
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
    provider: telegram
    group_id: -1
    tier_key: 42
    inbound_types: [human_input]
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
    provider: telegram
    group_id: -1
    inbound_types: [human_input]
`,
  );
  const { config } = await loadConfig(fp);
  assert.deepEqual(config.sources[0].tiers, {});
});

test('stdout provider does not require group_id', async () => {
  // Non-telegram providers pass through without a group_id requirement.
  const fp = await mkTmpConfig(
    'stdout-no-group',
    `
sources:
  - name: s
    path_glob: /tmp/*.jsonl
    provider: stdout
    inbound_types: [human_input]
`,
  );
  const { config } = await loadConfig(fp);
  assert.equal(config.sources[0].provider, 'stdout');
  assert.equal(config.sources[0].groupId, undefined);
});
