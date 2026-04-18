// Tests for src/runtime.ts. Uses node:test.
//
// Exercises the startup orchestrator against a real RelayWatcher wired to a
// tmp directory, a real RelayState on disk, a real RelayDispatcher, and a
// stub provider so we can observe provision calls deterministically.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { Relay } from '../src/runtime.ts';
import { RelayDispatcher } from '../src/dispatch.ts';
import { RelayState } from '../src/state.ts';
import { RelayWatcher } from '../src/watch.ts';
import type { RelayConfig, SourceConfig } from '../src/types.ts';
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
    group: '',
    inboundTypes: ['human_input'],
    tiers: {},
    ...overrides,
  };
}

function makeConfig(source: SourceConfig): RelayConfig {
  return { providers: {}, sources: [source] };
}

// A minimal provider that records provision/deliver calls for assertion.
class StubProvider implements Provider {
  public readonly name = 'stub';
  public provisionCalls: Array<{
    sourceName: string;
    filenameStem: string;
    filePath: string;
  }> = [];

  destinationKey(d: Destination): string {
    return `stub://${(d as { sourceName: string }).sourceName}/${(d as { filenameStem: string }).filenameStem}`;
  }

  async provision(meta: {
    sourceName: string;
    filenameStem: string;
    filePath: string;
  }): Promise<Destination> {
    this.provisionCalls.push({
      sourceName: meta.sourceName,
      filenameStem: meta.filenameStem,
      filePath: meta.filePath,
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

function buildRuntime(config: RelayConfig, state: RelayState, provider: Provider, options?: { backfill?: boolean }): {
  relay: Relay;
  watcher: RelayWatcher;
  dispatcher: RelayDispatcher;
  providers: Map<string, Provider>;
} {
  const providers = new Map<string, Provider>([[provider.name, provider]]);
  const watcher = new RelayWatcher(config.sources);
  const dispatcher = new RelayDispatcher({
    sources: config.sources,
    state,
    providers,
    watcher,
  });
  const relay = new Relay({
    config,
    state,
    providers,
    watcher,
    dispatcher,
    options,
  });
  return { relay, watcher, dispatcher, providers };
}

test('happy path: provisions destination and tracks pre-existing file', async (t) => {
  const dir = await mkTmpDir('happy');
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const statePath = path.join(dir, 'state.json');

  const filePath = path.join(dir, 'outreach.jsonl');
  await fsp.writeFile(filePath, ''); // empty pre-existing file

  const state = await RelayState.load(statePath);
  const source = makeSource(dir, { name: 'outreach' });
  const provider = new StubProvider();

  const { relay } = buildRuntime(makeConfig(source), state, provider);

  await relay.start();
  await delay(SETTLE_MS);

  assert.equal(provider.provisionCalls.length, 1);
  assert.equal(provider.provisionCalls[0].sourceName, 'outreach');
  assert.equal(provider.provisionCalls[0].filenameStem, 'outreach');
  assert.equal(provider.provisionCalls[0].filePath, filePath);

  const ss = state.getSource(filePath);
  assert.ok(ss, 'state should have an entry for the provisioned file');
  assert.equal(ss.sourceName, 'outreach');
  assert.equal(ss.destinationKey, 'stub://outreach/outreach');

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
  // Pre-populate state so runtime sees this as a resume.
  state.setSource(filePath, {
    sourceName: 'resume-src',
    offset: 14,
    destination: { sourceName: 'resume-src', filenameStem: 'resume' },
    destinationKey: 'stub://resume-src/resume',
  });
  await state.flush();

  const provider = new StubProvider();
  const { relay } = buildRuntime(makeConfig(source), state, provider);

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

  const { relay, watcher } = buildRuntime(
    makeConfig(source),
    state,
    provider,
    { backfill: true },
  );

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
  const { relay } = buildRuntime(makeConfig(source), state, provider);

  await relay.start();
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
  const { relay } = buildRuntime(makeConfig(source), state, provider);

  await relay.start();
  await delay(SETTLE_MS);

  assert.equal(provider.provisionCalls.length, 1);
  assert.equal(
    provider.provisionCalls[0].filenameStem,
    '2026-04-17-alpha',
    'provider must receive the file stem as topic identifier',
  );

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
  state.setSource(filePath, {
    sourceName: 'dis-src',
    offset: 5,
    destination: { sourceName: 'dis-src', filenameStem: 'disabled' },
    destinationKey: 'stub://dis-src/disabled',
    disabled: true,
    disabledReason: 'topic deleted',
  });
  await state.flush();

  const provider = new StubProvider();
  const { relay, watcher } = buildRuntime(makeConfig(source), state, provider);

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
