// Tests for src/config.ts. Uses node:test.

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

test('loads a well-formed minimal config and camelCases keys', async (t) => {
  process.env.TEST_TG_TOKEN = 'abc123';
  t.after(() => {
    delete process.env.TEST_TG_TOKEN;
  });

  const fp = await mkTmpConfig(
    'minimal',
    `
providers:
  telegram:
    bot_token: \${TEST_TG_TOKEN}
    groups:
      outreach: -100123
sources:
  - name: outreach-campaigns
    path_glob: /tmp/relay-test-campaigns/*.jsonl
    provider: telegram
    group: outreach
    inbound_types: [human_input]
    tiers:
      call.placed: silent
      call.outcome: notify
`,
  );

  const { config, warnings } = await loadConfig(fp);

  assert.equal(warnings.length, 0);
  assert.equal(config.providers.telegram?.botToken, 'abc123');
  assert.deepEqual(config.providers.telegram?.groups, { outreach: -100123 });
  assert.equal(config.sources.length, 1);
  const src = config.sources[0];
  assert.equal(src.name, 'outreach-campaigns');
  assert.equal(src.pathGlob, '/tmp/relay-test-campaigns/*.jsonl');
  assert.equal(src.provider, 'telegram');
  assert.equal(src.group, 'outreach');
  assert.deepEqual(src.inboundTypes, ['human_input']);
  assert.deepEqual(src.tiers, {
    'call.placed': 'silent',
    'call.outcome': 'notify',
  });
});

test('missing env var throws with variable name in message', async () => {
  delete process.env.RELAY_TEST_MISSING_VAR;
  const fp = await mkTmpConfig(
    'missing-env',
    `
providers:
  telegram:
    bot_token: \${RELAY_TEST_MISSING_VAR}
    groups:
      g: -1
sources:
  - name: s
    path_glob: /tmp/*.jsonl
    provider: telegram
    group: g
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
providers:
  telegram:
    bot_token: tok
    groups:
      g: -1
sources:
  - name: a
    path_glob: /tmp/a/*.jsonl
    provider: telegram
    group: g
    inbound_types: [human_input]
    tiers:
      call.placed: silent
  - name: b
    path_glob: /tmp/b/*.jsonl
    provider: telegram
    group: g
    inbound_types: [human_input]
    tiers:
      call.placed: silent
  - name: c
    path_glob: /tmp/c/*.jsonl
    provider: telegram
    group: g
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
providers:
  telegram:
    bot_token: tok
    groups:
      g: -1
sources:
  - name: s
    path_glob: /tmp/*.jsonl
    provider: telegram
    group: g
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

test('source references unknown provider throws', async () => {
  const fp = await mkTmpConfig(
    'unknown-provider',
    `
providers:
  telegram:
    bot_token: tok
    groups:
      g: -1
sources:
  - name: s
    path_glob: /tmp/*.jsonl
    provider: slack
    group: g
    inbound_types: [human_input]
`,
  );
  await assert.rejects(
    () => loadConfig(fp),
    /sources\[0\]\.provider/,
  );
});

test('source references unknown group for telegram throws', async () => {
  const fp = await mkTmpConfig(
    'unknown-group',
    `
providers:
  telegram:
    bot_token: tok
    groups:
      outreach: -100123
sources:
  - name: s
    path_glob: /tmp/*.jsonl
    provider: telegram
    group: not-a-group
    inbound_types: [human_input]
`,
  );
  await assert.rejects(
    () => loadConfig(fp),
    /sources\[0\]\.group/,
  );
});

test('duplicate source names throw', async () => {
  const fp = await mkTmpConfig(
    'dup',
    `
providers:
  telegram:
    bot_token: tok
    groups:
      g: -1
sources:
  - name: same
    path_glob: /tmp/a/*.jsonl
    provider: telegram
    group: g
    inbound_types: [human_input]
  - name: same
    path_glob: /tmp/b/*.jsonl
    provider: telegram
    group: g
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
providers:
  telegram:
    bot_token: tok
    groups:
      g: -1
sources:
  - name: s
    path_glob: /tmp/*.jsonl
    provider: telegram
    group: g
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
providers:
  telegram:
    bot_token: tok
    groups:
      g: -1
sources:
  - name: s
    path_glob: /tmp/*.jsonl
    provider: telegram
    group: g
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
providers:
  telegram:
    bot_token: tok
    groups:
      g: -1
sources:
  - name: s
    path_glob: /tmp/*.jsonl
    provider: telegram
    group: g
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
providers:
  telegram:
    bot_token: tok
    groups:
      g: -1
sources:
  - name: s
    path_glob: /tmp/*.jsonl
    provider: telegram
    group: g
    inbound_types: [human_input]
`,
  );
  const { config } = await loadConfig(fp);
  assert.deepEqual(config.sources[0].tiers, {});
});
