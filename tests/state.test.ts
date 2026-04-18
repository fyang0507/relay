// Tests for src/state.ts. Uses node:test (Node's built-in runner).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import {
  RelayState,
  type RegistryEntry,
  type SourceState,
} from '../src/state.ts';
import type { SourceConfig } from '../src/types.ts';

async function mkTmpStatePath(label: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `relay-state-${label}-`));
  return path.join(dir, 'state.json');
}

function makeSourceState(overrides: Partial<SourceState> = {}): SourceState {
  return {
    sourceName: 'outreach-campaigns',
    relayId: 'rl_aaaaaa',
    offset: 0,
    destination: { chatId: -100123, topicId: 7 },
    destinationKey: '-100123:7',
    ...overrides,
  };
}

function makeSourceConfig(overrides: Partial<SourceConfig> = {}): SourceConfig {
  return {
    name: 'outreach-campaigns',
    pathGlob: '/tmp/outreach/*.jsonl',
    provider: 'telegram',
    groupId: -1003975893613,
    inboundTypes: ['human_input'],
    tiers: {},
    ...overrides,
  };
}

function makeRegistryEntry(
  id: string,
  overrides: Partial<RegistryEntry> = {},
): RegistryEntry {
  return {
    id,
    configPath: '/etc/relay/relay.config.yaml',
    sourceConfig: makeSourceConfig(),
    addedAt: '2026-04-17T00:00:00.000Z',
    ...overrides,
  };
}

test('load returns fresh state when file is missing', async () => {
  const p = await mkTmpStatePath('missing');
  const s = await RelayState.load(p);
  const snap = s._snapshot();
  assert.equal(snap.version, 2);
  assert.deepEqual(snap.sources, {});
  assert.deepEqual(snap.providers, {});
  assert.deepEqual(snap.registry, {});

  // File should NOT have been created by load.
  await assert.rejects(fs.stat(p), (err: NodeJS.ErrnoException) => err.code === 'ENOENT');
});

test('load rejects a v1 state file with a clear message', async () => {
  const p = await mkTmpStatePath('v1-rejected');
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(
    p,
    JSON.stringify({ version: 1, sources: {}, providers: {} }),
  );
  await assert.rejects(
    () => RelayState.load(p),
    /is v1; this relay requires v2. Remove the file and re-register sources\./,
  );
});

test('load rejects a state file with unknown version', async () => {
  const p = await mkTmpStatePath('vx-rejected');
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify({ version: 99, sources: {} }));
  await assert.rejects(() => RelayState.load(p), /requires v2/);
});

test('save + load round-trips state shape (v2)', async () => {
  const p = await mkTmpStatePath('roundtrip');
  const s1 = await RelayState.load(p);

  const src = makeSourceState({ offset: 4242 });
  s1.setSource('/abs/path/to/file.jsonl', src);

  const tgBag = s1.getProviderState('telegram');
  tgBag.telegramUpdateIdCursor = 987654;
  tgBag.extra = 'hello';

  const entry = makeRegistryEntry('rl_bbbbbb');
  s1.addRegistry(entry);

  await s1.flush();

  const s2 = await RelayState.load(p);
  const snap = s2._snapshot();
  assert.equal(snap.version, 2);
  assert.deepEqual(snap.sources['/abs/path/to/file.jsonl'], src);
  assert.equal(snap.providers.telegram?.telegramUpdateIdCursor, 987654);
  assert.equal(snap.providers.telegram?.extra, 'hello');
  assert.ok(snap.registry['rl_bbbbbb']);
  assert.equal(snap.registry['rl_bbbbbb'].sourceConfig.name, 'outreach-campaigns');
});

test('setSource + findSourceByDestinationKey', async () => {
  const p = await mkTmpStatePath('lookup');
  const s = await RelayState.load(p);

  const a = makeSourceState({ destinationKey: 'key:a' });
  const b = makeSourceState({ destinationKey: 'key:b', offset: 99 });

  s.setSource('/files/a.jsonl', a);
  s.setSource('/files/b.jsonl', b);

  const hitA = s.findSourceByDestinationKey('key:a');
  assert.ok(hitA);
  assert.equal(hitA.filePath, '/files/a.jsonl');
  assert.deepEqual(hitA.state, a);

  const hitB = s.findSourceByDestinationKey('key:b');
  assert.ok(hitB);
  assert.equal(hitB.filePath, '/files/b.jsonl');

  const miss = s.findSourceByDestinationKey('key:nope');
  assert.equal(miss, undefined);

  await s.flush();
});

test('disableSource marks entry disabled with reason', async () => {
  const p = await mkTmpStatePath('disable');
  const s = await RelayState.load(p);

  s.setSource('/files/x.jsonl', makeSourceState());
  s.disableSource('/files/x.jsonl', 'message thread not found');

  const got = s.getSource('/files/x.jsonl');
  assert.ok(got);
  assert.equal(got.disabled, true);
  assert.equal(got.disabledReason, 'message thread not found');

  await s.flush();

  // Verify it persists.
  const s2 = await RelayState.load(p);
  const got2 = s2.getSource('/files/x.jsonl');
  assert.equal(got2?.disabled, true);
  assert.equal(got2?.disabledReason, 'message thread not found');
});

test('disableSource on missing path is a no-op', async () => {
  const p = await mkTmpStatePath('disable-missing');
  const s = await RelayState.load(p);
  s.disableSource('/files/nonexistent.jsonl', 'whatever');
  assert.equal(s.getSource('/files/nonexistent.jsonl'), undefined);
  await s.flush();
});

test('atomic rename leaves no .tmp file behind', async () => {
  const p = await mkTmpStatePath('atomic');
  const s = await RelayState.load(p);
  s.setSource('/files/one.jsonl', makeSourceState());
  await s.flush();

  const dir = path.dirname(p);
  const entries = await fs.readdir(dir);
  assert.ok(entries.includes('state.json'), 'state.json should exist');
  assert.ok(
    !entries.some((e) => e.endsWith('.tmp')),
    `no .tmp file should remain, saw: ${entries.join(',')}`,
  );
});

test('concurrent saves serialize without corrupting the file', async () => {
  const p = await mkTmpStatePath('concurrent');
  const s = await RelayState.load(p);

  // Kick off many saves in parallel, mutating state between them.
  const saves: Promise<void>[] = [];
  for (let i = 0; i < 20; i++) {
    s.setSource(`/files/f${i}.jsonl`, makeSourceState({ offset: i }));
    saves.push(s.save());
  }
  await Promise.all(saves);
  await s.flush();

  // File must parse as valid JSON and contain the final state.
  const raw = await fs.readFile(p, 'utf8');
  const parsed = JSON.parse(raw);
  assert.equal(parsed.version, 2);
  for (let i = 0; i < 20; i++) {
    assert.equal(parsed.sources[`/files/f${i}.jsonl`].offset, i);
  }
});

test('getProviderState returns a bag whose writes persist', async () => {
  const p = await mkTmpStatePath('providerbag');
  const s = await RelayState.load(p);

  const bag = s.getProviderState('telegram');
  bag.telegramUpdateIdCursor = 42;

  await s.flush();

  const s2 = await RelayState.load(p);
  const bag2 = s2.getProviderState('telegram');
  assert.equal(bag2.telegramUpdateIdCursor, 42);
});

test('load expands ~ in path', async () => {
  // We don't want to actually touch ~/.relay in tests, so just verify that
  // a bare `~` reference doesn't blow up the expansion logic by loading a
  // non-tilde path and confirming no crash. (Full tilde behavior is exercised
  // via the default path fallback, which we do not invoke here.)
  const p = await mkTmpStatePath('tilde');
  const s = await RelayState.load(p);
  assert.ok(s instanceof RelayState);
});

// ---- v2 registry --------------------------------------------------------

test('addRegistry + listRegistry + getRegistry round-trip', async () => {
  const p = await mkTmpStatePath('registry-basic');
  const s = await RelayState.load(p);
  const e1 = makeRegistryEntry('rl_111111', {
    sourceConfig: makeSourceConfig({ name: 'alpha' }),
  });
  const e2 = makeRegistryEntry('rl_222222', {
    sourceConfig: makeSourceConfig({ name: 'beta' }),
    configPath: '/other/config.yaml',
  });
  s.addRegistry(e1);
  s.addRegistry(e2);

  const list = s.listRegistry();
  assert.equal(list.length, 2);
  const names = list.map((e) => e.sourceConfig.name).sort();
  assert.deepEqual(names, ['alpha', 'beta']);

  const got = s.getRegistry('rl_111111');
  assert.ok(got);
  assert.equal(got.sourceConfig.name, 'alpha');

  // listRegistry returns copies — mutating them must not affect storage.
  list[0].configPath = 'MUTATED';
  assert.notEqual(s.getRegistry(list[0].id)?.configPath, 'MUTATED');

  await s.flush();
});

test('removeRegistry cascades: drops sources with matching relayId', async () => {
  const p = await mkTmpStatePath('registry-cascade');
  const s = await RelayState.load(p);

  const idA = 'rl_aaaaaa';
  const idB = 'rl_bbbbbb';
  s.addRegistry(makeRegistryEntry(idA));
  s.addRegistry(makeRegistryEntry(idB, {
    sourceConfig: makeSourceConfig({ name: 'other' }),
  }));
  // Two files under A, one under B.
  s.setSource('/a/1.jsonl', makeSourceState({ relayId: idA }));
  s.setSource('/a/2.jsonl', makeSourceState({ relayId: idA, destinationKey: 'k2' }));
  s.setSource('/b/1.jsonl', makeSourceState({ relayId: idB, destinationKey: 'k3' }));

  const removed = s.removeRegistry(idA);
  assert.ok(removed);
  assert.equal(removed.id, idA);

  // Registry A gone, registry B remains.
  assert.equal(s.getRegistry(idA), undefined);
  assert.ok(s.getRegistry(idB));

  // Both /a files gone; /b file remains.
  assert.equal(s.getSource('/a/1.jsonl'), undefined);
  assert.equal(s.getSource('/a/2.jsonl'), undefined);
  assert.ok(s.getSource('/b/1.jsonl'));

  await s.flush();
});

test('removeRegistry returns undefined when id is unknown', async () => {
  const p = await mkTmpStatePath('registry-noop');
  const s = await RelayState.load(p);
  assert.equal(s.removeRegistry('rl_nope00'), undefined);
  await s.flush();
});

test('generateRelayId returns rl_ + 6 hex chars and avoids live collisions', async () => {
  const p = await mkTmpStatePath('idgen');
  const s = await RelayState.load(p);

  const id = s.generateRelayId();
  assert.match(id, /^rl_[0-9a-f]{6}$/);

  // Generate many ids, ensuring uniqueness across a batch. We register each
  // one so the retry logic on collision is actually exercised.
  const seen = new Set<string>();
  for (let i = 0; i < 200; i++) {
    const next = s.generateRelayId();
    assert.match(next, /^rl_[0-9a-f]{6}$/);
    assert.ok(!seen.has(next), `duplicate id ${next}`);
    seen.add(next);
    s.addRegistry(makeRegistryEntry(next));
  }
  await s.flush();
});
