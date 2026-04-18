// Tests for src/runtime.ts. Uses node:test.
//
// Exercises the dynamic-registry startup orchestrator against a real
// RelayWatcher wired to a tmp directory, a real RelayState on disk, a real
// RelayDispatcher, and a stub provider so we can observe provision calls
// deterministically.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { Relay, buildResolveSource } from '../src/runtime.ts';
import { RelayDispatcher } from '../src/dispatch.ts';
import { RelayState } from '../src/state.ts';
import { RelayWatcher } from '../src/watch.ts';
import type { SourceConfig } from '../src/types.ts';
import type {
  Destination,
  DeliverResult,
  InboundEvent,
  Provider,
} from '../src/providers/types.ts';

// Chokidar events lag on macOS; match the watcher tests' settle window.
const SETTLE_MS = 300;

async function mkTmpDir(label: string): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), `relay-runtime-${label}-`));
}

function makeSource(dir: string, overrides: Partial<SourceConfig> = {}): SourceConfig {
  return {
    name: 'test-src',
    pathGlob: path.join(dir, '*.jsonl'),
    provider: 'stub',
    inboundTypes: ['human_input'],
    tiers: {},
    ...overrides,
  };
}

// A minimal provider that records provision/deliver calls for assertion.
class StubProvider implements Provider {
  public readonly name = 'stub';
  public provisionCalls: Array<{
    sourceName: string;
    filenameStem: string;
    filePath: string;
    sourceConfigName: string;
  }> = [];

  destinationKey(d: Destination): string {
    return `stub://${(d as { sourceName: string }).sourceName}/${(d as { filenameStem: string }).filenameStem}`;
  }

  async provision(
    meta: {
      sourceName: string;
      filenameStem: string;
      filePath: string;
    },
    sourceConfig: SourceConfig,
  ): Promise<Destination> {
    this.provisionCalls.push({
      sourceName: meta.sourceName,
      filenameStem: meta.filenameStem,
      filePath: meta.filePath,
      sourceConfigName: sourceConfig.name,
    });
    return { sourceName: meta.sourceName, filenameStem: meta.filenameStem };
  }

  async deliver(
    _destination: Destination,
    _text: string,
    _tier: string,
  ): Promise<DeliverResult> {
    return { ok: true };
  }

  async *receive(signal: AbortSignal): AsyncIterable<InboundEvent> {
    if (signal.aborted) return;
    await new Promise<void>((resolve) => {
      signal.addEventListener('abort', () => resolve(), { once: true });
    });
  }

  async close(): Promise<void> {
    // no-op
  }
}

// Build a complete runtime wired to a real watcher + dispatcher over a given
// RelayState. No static sources — callers use relay.addSource() to register
// dynamically (this is the whole point of Phase 1a).
function buildRuntime(
  state: RelayState,
  provider: Provider,
  options?: { backfill?: boolean },
): {
  relay: Relay;
  watcher: RelayWatcher;
  dispatcher: RelayDispatcher;
  providers: Map<string, Provider>;
} {
  const providers = new Map<string, Provider>([[provider.name, provider]]);
  const watcher = new RelayWatcher();
  const dispatcher = new RelayDispatcher({
    resolveSource: buildResolveSource(state),
    state,
    providers,
    watcher,
  });
  const relay = new Relay({
    state,
    providers,
    watcher,
    dispatcher,
    options,
  });
  return { relay, watcher, dispatcher, providers };
}

test('happy path: addSource provisions destination and tracks pre-existing file', async (t) => {
  const dir = await mkTmpDir('happy');
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const statePath = path.join(dir, 'state.json');

  const filePath = path.join(dir, 'outreach.jsonl');
  await fsp.writeFile(filePath, ''); // empty pre-existing file

  const state = await RelayState.load(statePath);
  const source = makeSource(dir, { name: 'outreach' });
  const provider = new StubProvider();

  const { relay } = buildRuntime(state, provider);

  await relay.start();
  const id = await relay.addSource(source, '/virtual/config.yaml');
  await delay(SETTLE_MS);

  assert.match(id, /^rl_[0-9a-f]{6}$/);
  assert.equal(provider.provisionCalls.length, 1);
  assert.equal(provider.provisionCalls[0].sourceName, 'outreach');
  assert.equal(provider.provisionCalls[0].filenameStem, 'outreach');
  assert.equal(provider.provisionCalls[0].filePath, filePath);

  const ss = state.getSource(filePath);
  assert.ok(ss, 'state should have an entry for the provisioned file');
  assert.equal(ss.sourceName, 'outreach');
  assert.equal(ss.destinationKey, 'stub://outreach/outreach');
  assert.equal(ss.relayId, id, 'state entry must carry the relayId');

  // Registry entry persisted.
  const reg = state.getRegistry(id);
  assert.ok(reg);
  assert.equal(reg.configPath, '/virtual/config.yaml');
  assert.equal(reg.sourceConfig.name, 'outreach');

  await relay.stop();
});

test('addSource is idempotent by (configPath, sourceConfig.name)', async (t) => {
  const dir = await mkTmpDir('idempotent');
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const statePath = path.join(dir, 'state.json');
  await fsp.writeFile(path.join(dir, 'a.jsonl'), '');

  const state = await RelayState.load(statePath);
  const provider = new StubProvider();
  const source = makeSource(dir, { name: 'dup' });

  const { relay } = buildRuntime(state, provider);
  await relay.start();

  const id1 = await relay.addSource(source, '/conf/path.yaml');
  const id2 = await relay.addSource(source, '/conf/path.yaml');
  assert.equal(id1, id2, 'same (configPath, name) must return the same id');

  // Only one registry entry exists.
  const listed = state.listRegistry();
  assert.equal(listed.length, 1);

  // A different configPath with the same source name is considered distinct.
  const id3 = await relay.addSource(source, '/conf/other.yaml');
  assert.notEqual(id1, id3);
  assert.equal(state.listRegistry().length, 2);

  await relay.stop();
});

test('removeSource: watcher stops, registry + state cleared', async (t) => {
  const dir = await mkTmpDir('remove');
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const statePath = path.join(dir, 'state.json');

  const filePath = path.join(dir, 'remove.jsonl');
  await fsp.writeFile(filePath, '');

  const state = await RelayState.load(statePath);
  const source = makeSource(dir, { name: 'to-remove' });
  const provider = new StubProvider();

  const { relay } = buildRuntime(state, provider);
  await relay.start();

  const id = await relay.addSource(source, '/conf/x.yaml');
  await delay(SETTLE_MS);
  assert.ok(state.getSource(filePath), 'file tracked after addSource');
  assert.ok(state.getRegistry(id), 'registry entry present');

  const removed = await relay.removeSource(id);
  assert.equal(removed, true);

  // Registry entry gone.
  assert.equal(state.getRegistry(id), undefined);
  // Cascade: the sources[filePath] entry was dropped because its relayId
  // matched the removed registry id.
  assert.equal(
    state.getSource(filePath),
    undefined,
    'sources entry cascaded away',
  );

  // removeSource on an unknown id returns false.
  const gone = await relay.removeSource('rl_nope00');
  assert.equal(gone, false);

  await relay.stop();
});

test('restart: pre-existing registry replays sources and re-tracks files', async (t) => {
  const dir = await mkTmpDir('restart');
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const statePath = path.join(dir, 'state.json');

  const filePath = path.join(dir, 'persist.jsonl');
  await fsp.writeFile(filePath, '');

  // First runtime: register a source and stop.
  {
    const state = await RelayState.load(statePath);
    const provider = new StubProvider();
    const { relay } = buildRuntime(state, provider);
    await relay.start();
    await relay.addSource(
      makeSource(dir, { name: 'survive' }),
      '/conf/survive.yaml',
    );
    await delay(SETTLE_MS);
    assert.ok(state.getRegistry('' /* dummy */) === undefined); // sanity
    assert.equal(provider.provisionCalls.length, 1);
    await relay.stop();
  }

  // Second runtime over the same state file: registry should replay and the
  // previously-tracked file should resume without re-provisioning.
  {
    const state = await RelayState.load(statePath);
    assert.equal(state.listRegistry().length, 1, 'registry persisted');
    const ss = state.getSource(filePath);
    assert.ok(ss, 'sources entry persisted');
    const priorOffset = ss.offset;

    const provider = new StubProvider();
    const { relay } = buildRuntime(state, provider);
    await relay.start();
    await delay(SETTLE_MS);

    assert.equal(
      provider.provisionCalls.length,
      0,
      'restart should NOT re-provision — file is already known to state',
    );
    // Offset unchanged on restart.
    assert.equal(state.getSource(filePath)?.offset, priorOffset);

    await relay.stop();
  }
});

test('listSources returns flat projection of registry + tracking state', async (t) => {
  const dir = await mkTmpDir('list');
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const statePath = path.join(dir, 'state.json');
  const filePath = path.join(dir, 'live.jsonl');
  await fsp.writeFile(filePath, '');

  const state = await RelayState.load(statePath);
  const provider = new StubProvider();
  const { relay } = buildRuntime(state, provider);
  await relay.start();

  const id = await relay.addSource(
    makeSource(dir, { name: 'listme' }),
    '/conf/list.yaml',
  );
  await delay(SETTLE_MS);

  const listed = relay.listSources();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, id);
  assert.equal(listed[0].configPath, '/conf/list.yaml');
  assert.equal(listed[0].sourceName, 'listme');
  assert.equal(listed[0].provider, 'stub');
  assert.equal(listed[0].groupId, undefined, 'stub provider has no group_id');
  assert.equal(listed[0].filesTracked, 1);
  assert.equal(listed[0].disabled, false);

  await relay.stop();
});

test('resume: pre-populated state skips re-provision', async (t) => {
  const dir = await mkTmpDir('resume');
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const statePath = path.join(dir, 'state.json');

  const filePath = path.join(dir, 'resume.jsonl');
  await fsp.writeFile(filePath, 'prior-content\n');

  const state = await RelayState.load(statePath);
  const source = makeSource(dir, { name: 'resume-src' });

  // Pre-populate registry + state so runtime sees this as a resume.
  const preId = state.generateRelayId();
  state.addRegistry({
    id: preId,
    configPath: '/conf/resume.yaml',
    sourceConfig: source,
    addedAt: new Date().toISOString(),
  });
  state.setSource(filePath, {
    sourceName: source.name,
    relayId: preId,
    offset: 14,
    destination: { sourceName: source.name, filenameStem: 'resume' },
    destinationKey: `stub://${source.name}/resume`,
  });
  await state.flush();

  const provider = new StubProvider();
  const { relay } = buildRuntime(state, provider);

  await relay.start();
  await delay(SETTLE_MS);

  assert.equal(
    provider.provisionCalls.length,
    0,
    'provision must not be called when resuming a known file',
  );
  // Offset should remain what it was.
  assert.equal(state.getSource(filePath)?.offset, 14);

  await relay.stop();
});

test('backfill=true: trackFile invoked with offset 0 for newly-discovered file', async (t) => {
  const dir = await mkTmpDir('backfill');
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const statePath = path.join(dir, 'state.json');

  const filePath = path.join(dir, 'backfill.jsonl');
  await fsp.writeFile(
    filePath,
    '{"type":"call.placed","timestamp":"t"}\n{"type":"call.placed","timestamp":"t"}\n',
  );

  const state = await RelayState.load(statePath);
  const source = makeSource(dir, { name: 'bf-src' });
  const provider = new StubProvider();

  const { relay, watcher } = buildRuntime(state, provider, { backfill: true });

  // Intercept trackFile to observe the starting offset the runtime chose.
  // (State offset can advance before we assert as the watcher/dispatcher
  // drain the file, so we capture the initial starting point here.)
  const trackCalls: Array<{ filePath: string; offset: number }> = [];
  const origTrack = watcher.trackFile.bind(watcher);
  watcher.trackFile = (fp: string, off: number, sn: string) => {
    trackCalls.push({ filePath: fp, offset: off });
    return origTrack(fp, off, sn);
  };

  await relay.start();
  await relay.addSource(source, '/conf/bf.yaml');
  await delay(SETTLE_MS);

  assert.equal(provider.provisionCalls.length, 1);
  assert.equal(trackCalls.length, 1);
  assert.equal(
    trackCalls[0].offset,
    0,
    'backfill=true should pass offset 0 to trackFile',
  );

  await relay.stop();
});

test('mark-as-read default: offset equals fileSize for new file', async (t) => {
  const dir = await mkTmpDir('mark-read');
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const statePath = path.join(dir, 'state.json');

  const filePath = path.join(dir, 'mark.jsonl');
  const body = '{"type":"call.placed","timestamp":"t"}\n';
  await fsp.writeFile(filePath, body);
  const expectedSize = Buffer.byteLength(body, 'utf8');

  const state = await RelayState.load(statePath);
  const source = makeSource(dir, { name: 'mr-src' });
  const provider = new StubProvider();
  const { relay } = buildRuntime(state, provider);

  await relay.start();
  await relay.addSource(source, '/conf/mr.yaml');
  await delay(SETTLE_MS);

  const ss = state.getSource(filePath);
  assert.ok(ss);
  assert.equal(ss.offset, expectedSize, 'default should skip to EOF');

  await relay.stop();
});

test('provision receives filenameStem as the topic identifier', async (t) => {
  const dir = await mkTmpDir('filename-stem');
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const statePath = path.join(dir, 'state.json');

  const filePath = path.join(dir, '2026-04-17-alpha.jsonl');
  await fsp.writeFile(filePath, '');

  const state = await RelayState.load(statePath);
  const source = makeSource(dir, { name: 'outreach' });
  const provider = new StubProvider();
  const { relay } = buildRuntime(state, provider);

  await relay.start();
  await relay.addSource(source, '/conf/fs.yaml');
  await delay(SETTLE_MS);

  assert.equal(provider.provisionCalls.length, 1);
  assert.equal(
    provider.provisionCalls[0].filenameStem,
    '2026-04-17-alpha',
    'provider must receive the file stem as topic identifier',
  );

  await relay.stop();
});

test('telegram source without groupId: runtime logs and does NOT track file', async (t) => {
  // Phase 2 guard: a hand-crafted SourceConfig that bypasses loadConfig and
  // declares provider=telegram with no groupId should fail localized in the
  // runtime (no cryptic downstream API error).
  const dir = await mkTmpDir('tg-no-group-id');
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const statePath = path.join(dir, 'state.json');

  const filePath = path.join(dir, 'tg.jsonl');
  await fsp.writeFile(filePath, '');

  const state = await RelayState.load(statePath);
  // Register a telegram-provider source with no groupId. We use the StubProvider
  // but name it 'telegram' so the runtime's guard fires.
  const provider = new StubProvider();
  (provider as { name: string }).name = 'telegram';
  const source = makeSource(dir, { name: 'tg-src', provider: 'telegram' });

  const { relay } = buildRuntime(state, provider);

  // Capture console.warn so we can assert the runtime logged the missing
  // group_id rather than calling provision.
  const warnings: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(' '));
  };
  t.after(() => {
    console.warn = origWarn;
  });

  await relay.start();
  await relay.addSource(source, '/conf/tg.yaml');
  await delay(SETTLE_MS);

  assert.equal(
    provider.provisionCalls.length,
    0,
    'provision must not run when telegram source is missing group_id',
  );
  assert.ok(
    warnings.some((w) => /missing group_id/.test(w)),
    `expected a "missing group_id" warning; got: ${JSON.stringify(warnings)}`,
  );
  // No state entry for the file since it was never provisioned.
  assert.equal(state.getSource(filePath), undefined);

  await relay.stop();
});

test('disabled source: runtime does NOT track file', async (t) => {
  const dir = await mkTmpDir('disabled');
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const statePath = path.join(dir, 'state.json');

  const filePath = path.join(dir, 'disabled.jsonl');
  await fsp.writeFile(filePath, 'some content\n');

  const state = await RelayState.load(statePath);
  const source = makeSource(dir, { name: 'dis-src' });

  // Pre-register registry + disabled state entry.
  const preId = state.generateRelayId();
  state.addRegistry({
    id: preId,
    configPath: '/conf/dis.yaml',
    sourceConfig: source,
    addedAt: new Date().toISOString(),
  });
  state.setSource(filePath, {
    sourceName: 'dis-src',
    relayId: preId,
    offset: 5,
    destination: { sourceName: 'dis-src', filenameStem: 'disabled' },
    destinationKey: 'stub://dis-src/disabled',
    disabled: true,
    disabledReason: 'topic deleted',
  });
  await state.flush();

  const provider = new StubProvider();
  const { relay, watcher } = buildRuntime(state, provider);

  // Observe 'line' events — none should fire for the disabled file, since
  // the runtime should not call watcher.trackFile.
  const lines: unknown[] = [];
  watcher.on('line', (ev) => lines.push(ev));

  await relay.start();
  await delay(SETTLE_MS);

  assert.equal(provider.provisionCalls.length, 0, 'no provision on disabled');
  assert.equal(lines.length, 0, 'no line events for untracked file');
  // State should remain disabled and offset untouched.
  const ss = state.getSource(filePath);
  assert.equal(ss?.disabled, true);
  assert.equal(ss?.offset, 5);

  await relay.stop();
});
