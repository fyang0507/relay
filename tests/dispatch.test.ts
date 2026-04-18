// Tests for src/dispatch.ts and src/providers/stdout.ts.
//
// These exercise the core dispatch layer end-to-end against a synthetic
// watcher (a plain EventEmitter) and minimal stub providers. The RelayState
// is loaded against a per-test tmp file so autosaves are real but isolated.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { RelayDispatcher } from '../src/dispatch.ts';
import { renderLine } from '../src/render.ts';
import { StdoutProvider } from '../src/providers/stdout.ts';
import { RelayState, type SourceState } from '../src/state.ts';
import type { SourceConfig } from '../src/types.ts';
import type { RelayWatcher, LineEvent } from '../src/watch.ts';
import type {
  DeliverResult,
  Destination,
  InboundEvent,
  Provider,
} from '../src/providers/types.ts';

// The dispatcher only uses `.on`, `.off`, and `.emit` on the watcher. A
// plain EventEmitter cast to the watcher type is enough to drive tests
// without spinning up chokidar.
function fakeWatcher(): RelayWatcher {
  return new EventEmitter() as unknown as RelayWatcher;
}

async function mkTmpStatePath(label: string): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), `relay-dispatch-${label}-`));
  return path.join(dir, 'state.json');
}

async function mkTmpFile(label: string, contents = ''): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), `relay-dispatch-${label}-`));
  const fp = path.join(dir, 'log.jsonl');
  await fsp.writeFile(fp, contents);
  return fp;
}

function makeSource(overrides: Partial<SourceConfig> = {}): SourceConfig {
  return {
    name: 'test-src',
    pathGlob: '/unused/*.jsonl',
    provider: 'stub',
    group: 'grp',
    inboundTypes: ['human_input'],
    tiers: { 'call.placed': 'silent', 'call.outcome': 'notify', noisy: 'ignore' },
    ...overrides,
  };
}

function lineEvent(overrides: Partial<LineEvent>): LineEvent {
  const defaults: LineEvent = {
    filePath: '/tmp/fake.jsonl',
    sourceName: 'test-src',
    lineStartOffset: 0,
    lineEndOffset: 50,
    parsed: { type: 'call.placed', timestamp: '2026-04-17T00:00:00Z' },
    raw: '{"type":"call.placed","timestamp":"2026-04-17T00:00:00Z"}',
  };
  return { ...defaults, ...overrides };
}

// A flexible stub provider whose `deliver` is injectable per-test.
class StubProvider implements Provider {
  public readonly name = 'stub';
  public calls: Array<{ destination: Destination; text: string; tier: string }> =
    [];
  public deliverImpl: (
    destination: Destination,
    text: string,
    tier: string,
  ) => Promise<DeliverResult> = async () => ({ ok: true });
  public receiveFn?: (signal: AbortSignal) => AsyncIterable<InboundEvent>;

  destinationKey(d: Destination): string {
    return `stub://${(d as { key?: string }).key ?? 'default'}`;
  }

  async provision(): Promise<Destination> {
    return { key: 'default' };
  }

  async deliver(
    destination: Destination,
    text: string,
    tier: string,
  ): Promise<DeliverResult> {
    this.calls.push({ destination, text, tier });
    return this.deliverImpl(destination, text, tier);
  }

  receive(signal: AbortSignal): AsyncIterable<InboundEvent> {
    if (this.receiveFn) return this.receiveFn(signal);
    return defaultEmptyReceive(signal);
  }
}

async function* defaultEmptyReceive(
  signal: AbortSignal,
): AsyncIterable<InboundEvent> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

// Give the debounced autosave a chance to run before we read back state.
const SAVE_DEBOUNCE_MS = 550;

// ---------------------------------------------------------------------------
// StdoutProvider unit tests
// ---------------------------------------------------------------------------

describe('StdoutProvider', () => {
  let origWrite: typeof process.stdout.write;
  let captured: string[];

  beforeEach(() => {
    captured = [];
    origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      captured.push(
        typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString(),
      );
      return true;
    }) as typeof process.stdout.write;
  });
  afterEach(() => {
    process.stdout.write = origWrite;
  });

  it('deliver writes the expected prefixed line and returns ok', async () => {
    const p = new StdoutProvider();
    const dest = await p.provision({
      sourceName: 'outreach-campaigns',
      filenameStem: '2026-04-17-dental',
      filePath: '/tmp/x.jsonl',
    });
    const result = await p.deliver(dest, 'hello world', 'silent');
    assert.deepEqual(result, { ok: true });
    assert.equal(captured.length, 1);
    assert.equal(
      captured[0],
      '[stdout][outreach-campaigns][silent] hello world\n',
    );
  });

  it('destinationKey is stable and scoped per source', async () => {
    const p = new StdoutProvider();
    const da = await p.provision({
      sourceName: 'a',
      filenameStem: 'x',
      filePath: '/tmp/a.jsonl',
    });
    const db = await p.provision({
      sourceName: 'b',
      filenameStem: 'x',
      filePath: '/tmp/b.jsonl',
    });
    assert.equal(p.destinationKey(da), 'stdout://a');
    assert.equal(p.destinationKey(db), 'stdout://b');
    assert.equal(p.destinationKey(da), p.destinationKey(da));
  });

  it('receive yields nothing and resolves when aborted', async () => {
    const p = new StdoutProvider();
    const ac = new AbortController();
    const events: InboundEvent[] = [];
    const runner = (async () => {
      for await (const ev of p.receive(ac.signal)) events.push(ev);
    })();
    // Abort on the next tick; the iterator must complete cleanly.
    setTimeout(() => ac.abort(), 10);
    await runner;
    assert.equal(events.length, 0);
  });
});

// ---------------------------------------------------------------------------
// RelayDispatcher tests
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// renderLine unit tests
// ---------------------------------------------------------------------------

describe('renderLine', () => {
  it('prepends [keyValue] header (no timestamp) and pretty-prints JSON', () => {
    const out = renderLine(
      { type: 'call.placed', timestamp: '2026-04-17T00:00:00Z', id: 'X' },
      '<raw>',
      'type',
    );
    const [header, ...rest] = out.split('\n');
    assert.equal(header, '[call.placed]');
    // Pretty JSON has 2-space indentation on nested keys.
    assert.ok(rest.join('\n').includes('  "id": "X"'));
  });

  it('hard-truncates with "..." when single-line JSON still exceeds the cap', () => {
    const big = { type: 't', timestamp: 'ts', payload: 'z'.repeat(4000) };
    const out = renderLine(big, '<raw>', 'type');
    assert.ok(out.length <= 3500, `got length ${out.length}`);
    assert.ok(out.endsWith('...'));
    // Header still prepended (no timestamp segment).
    assert.ok(out.startsWith('[t]\n'));
  });

  it('uses a custom key field when supplied', () => {
    const out = renderLine(
      { type: 'ignored', event_type: 'trade.filled', qty: 1 } as never,
      '<raw>',
      'event_type',
    );
    assert.ok(out.startsWith('[trade.filled]\n'));
  });

  it('falls back to "(no-type)" when the key field is missing or non-string', () => {
    const missing = renderLine(
      { type: 'ok' } as never,
      '<raw>',
      'event_type',
    );
    assert.ok(missing.startsWith('[(no-type)]\n'));

    const nonString = renderLine(
      { type: 42 } as never,
      '<raw>',
      'type',
    );
    assert.ok(nonString.startsWith('[(no-type)]\n'));
  });
});

describe('RelayDispatcher outbound', () => {
  it('happy path: delivers, advances offset, persists', async () => {
    const statePath = await mkTmpStatePath('happy');
    const state = await RelayState.load(statePath);
    const source = makeSource();
    const provider = new StubProvider();
    const watcher = fakeWatcher();

    const filePath = '/tmp/happy.jsonl';
    const initial: SourceState = {
      sourceName: source.name,
      offset: 0,
      destination: { key: 'k1' },
      destinationKey: 'stub://k1',
    };
    state.setSource(filePath, initial);

    const dispatcher = new RelayDispatcher({
      sources: [source],
      state,
      providers: new Map([['stub', provider]]),
      watcher,
    });
    dispatcher.start();

    const ev = lineEvent({
      filePath,
      lineStartOffset: 0,
      lineEndOffset: 57,
      parsed: { type: 'call.placed', timestamp: 'ts-1', id: 'A' },
    });
    watcher.emit('line', ev);

    await delay(20);

    assert.equal(provider.calls.length, 1);
    assert.equal(provider.calls[0].tier, 'silent');
    assert.match(provider.calls[0].text, /^\[call\.placed\]\n/);
    assert.deepEqual(provider.calls[0].destination, { key: 'k1' });

    const after = state.getSource(filePath);
    assert.equal(after?.offset, 57);

    await dispatcher.stop();
    await state.flush();
  });

  it('applies configured tier for the entry type', async () => {
    const statePath = await mkTmpStatePath('tier');
    const state = await RelayState.load(statePath);
    const source = makeSource();
    const provider = new StubProvider();
    const watcher = fakeWatcher();

    const filePath = '/tmp/tier.jsonl';
    state.setSource(filePath, {
      sourceName: source.name,
      offset: 0,
      destination: { key: 'k1' },
      destinationKey: 'stub://k1',
    });

    const dispatcher = new RelayDispatcher({
      sources: [source],
      state,
      providers: new Map([['stub', provider]]),
      watcher,
    });
    dispatcher.start();

    watcher.emit(
      'line',
      lineEvent({
        filePath,
        lineEndOffset: 40,
        parsed: { type: 'call.outcome', timestamp: 'ts-1' },
      }),
    );
    await delay(20);
    assert.equal(provider.calls[0].tier, 'notify');
    await dispatcher.stop();
  });

  it('loopback: skips delivery when parsed.type is in inboundTypes, advances offset', async () => {
    const statePath = await mkTmpStatePath('loop');
    const state = await RelayState.load(statePath);
    const source = makeSource();
    const provider = new StubProvider();
    const watcher = fakeWatcher();

    const filePath = '/tmp/loop.jsonl';
    state.setSource(filePath, {
      sourceName: source.name,
      offset: 0,
      destination: { key: 'k1' },
      destinationKey: 'stub://k1',
    });

    const d = new RelayDispatcher({
      sources: [source],
      state,
      providers: new Map([['stub', provider]]),
      watcher,
    });
    d.start();

    watcher.emit(
      'line',
      lineEvent({
        filePath,
        lineEndOffset: 33,
        parsed: { type: 'human_input', timestamp: 'ts-1', text: 'hi' },
      }),
    );
    await delay(20);

    assert.equal(provider.calls.length, 0);
    assert.equal(state.getSource(filePath)?.offset, 33);

    await d.stop();
  });

  it("tier === 'ignore': skips delivery but advances offset", async () => {
    const statePath = await mkTmpStatePath('ignore');
    const state = await RelayState.load(statePath);
    const source = makeSource();
    const provider = new StubProvider();
    const watcher = fakeWatcher();

    const filePath = '/tmp/ignore.jsonl';
    state.setSource(filePath, {
      sourceName: source.name,
      offset: 0,
      destination: { key: 'k1' },
      destinationKey: 'stub://k1',
    });

    const d = new RelayDispatcher({
      sources: [source],
      state,
      providers: new Map([['stub', provider]]),
      watcher,
    });
    d.start();

    watcher.emit(
      'line',
      lineEvent({
        filePath,
        lineEndOffset: 21,
        parsed: { type: 'noisy', timestamp: 'ts-1' },
      }),
    );
    await delay(20);

    assert.equal(provider.calls.length, 0);
    assert.equal(state.getSource(filePath)?.offset, 21);

    await d.stop();
  });

  it('disableMapping=true: calls state.disableSource, offset NOT advanced', async () => {
    const statePath = await mkTmpStatePath('disable');
    const state = await RelayState.load(statePath);
    const source = makeSource();
    const provider = new StubProvider();
    provider.deliverImpl = async () => ({
      ok: false,
      reason: 'message thread not found',
      disableMapping: true,
    });
    const watcher = fakeWatcher();

    const filePath = '/tmp/disable.jsonl';
    state.setSource(filePath, {
      sourceName: source.name,
      offset: 0,
      destination: { key: 'k1' },
      destinationKey: 'stub://k1',
    });

    const d = new RelayDispatcher({
      sources: [source],
      state,
      providers: new Map([['stub', provider]]),
      watcher,
    });
    d.start();

    watcher.emit(
      'line',
      lineEvent({ filePath, lineEndOffset: 60 }),
    );
    await delay(20);

    const after = state.getSource(filePath);
    assert.equal(after?.disabled, true);
    assert.equal(after?.disabledReason, 'message thread not found');
    assert.equal(after?.offset, 0, 'offset must not advance on disableMapping');

    await d.stop();
  });

  it('transient failure: no disableSource, offset NOT advanced', async () => {
    const statePath = await mkTmpStatePath('transient');
    const state = await RelayState.load(statePath);
    const source = makeSource();
    const provider = new StubProvider();
    provider.deliverImpl = async () => ({
      ok: false,
      reason: '503 upstream',
    });
    const watcher = fakeWatcher();

    const filePath = '/tmp/transient.jsonl';
    state.setSource(filePath, {
      sourceName: source.name,
      offset: 0,
      destination: { key: 'k1' },
      destinationKey: 'stub://k1',
    });

    const d = new RelayDispatcher({
      sources: [source],
      state,
      providers: new Map([['stub', provider]]),
      watcher,
    });
    d.start();

    watcher.emit(
      'line',
      lineEvent({ filePath, lineEndOffset: 60 }),
    );
    await delay(20);

    const after = state.getSource(filePath);
    assert.equal(after?.disabled, undefined);
    assert.equal(after?.offset, 0, 'transient failure must not advance offset');

    await d.stop();
  });

  it('malformed line (parsed: null): advances offset, deliver NOT called', async () => {
    const statePath = await mkTmpStatePath('malformed');
    const state = await RelayState.load(statePath);
    const source = makeSource();
    const provider = new StubProvider();
    const watcher = fakeWatcher();

    const filePath = '/tmp/malformed.jsonl';
    state.setSource(filePath, {
      sourceName: source.name,
      offset: 0,
      destination: { key: 'k1' },
      destinationKey: 'stub://k1',
    });

    const d = new RelayDispatcher({
      sources: [source],
      state,
      providers: new Map([['stub', provider]]),
      watcher,
    });
    d.start();

    watcher.emit(
      'line',
      lineEvent({
        filePath,
        lineEndOffset: 18,
        parsed: null,
        raw: '{not json',
      }),
    );
    await delay(20);

    assert.equal(provider.calls.length, 0);
    assert.equal(state.getSource(filePath)?.offset, 18);

    await d.stop();
  });

  it('unknown source name: drops line without touching state or provider', async () => {
    const statePath = await mkTmpStatePath('unknown-src');
    const state = await RelayState.load(statePath);
    const source = makeSource();
    const provider = new StubProvider();
    const watcher = fakeWatcher();

    const d = new RelayDispatcher({
      sources: [source],
      state,
      providers: new Map([['stub', provider]]),
      watcher,
    });
    d.start();

    watcher.emit(
      'line',
      lineEvent({
        filePath: '/tmp/nope.jsonl',
        sourceName: 'not-configured',
      }),
    );
    await delay(20);
    assert.equal(provider.calls.length, 0);
    assert.equal(state.getSource('/tmp/nope.jsonl'), undefined);
    await d.stop();
  });

  it('unprovisioned file: drops line without calling provider', async () => {
    const statePath = await mkTmpStatePath('unprovisioned');
    const state = await RelayState.load(statePath);
    const source = makeSource();
    const provider = new StubProvider();
    const watcher = fakeWatcher();

    // Note: state.setSource is NOT called; the file is unprovisioned.
    const d = new RelayDispatcher({
      sources: [source],
      state,
      providers: new Map([['stub', provider]]),
      watcher,
    });
    d.start();

    watcher.emit(
      'line',
      lineEvent({ filePath: '/tmp/not-provisioned.jsonl' }),
    );
    await delay(20);
    assert.equal(provider.calls.length, 0);
    await d.stop();
  });

  it('custom tier_key: loopback guard and tier lookup read the configured field', async () => {
    const statePath = await mkTmpStatePath('tier-key-outbound');
    const state = await RelayState.load(statePath);
    // event_type replaces the default "type" as the discriminator.
    const source = makeSource({
      tierKey: 'event_type',
      inboundTypes: ['human_reply'],
      tiers: { 'trade.filled': 'notify', noisy: 'ignore' },
    });
    const provider = new StubProvider();
    const watcher = fakeWatcher();

    const filePath = '/tmp/custom-key.jsonl';
    state.setSource(filePath, {
      sourceName: source.name,
      offset: 0,
      destination: { key: 'k1' },
      destinationKey: 'stub://k1',
    });

    const d = new RelayDispatcher({
      sources: [source],
      state,
      providers: new Map([['stub', provider]]),
      watcher,
    });
    d.start();

    // Delivered — tier_key picks event_type, which matches 'notify'.
    watcher.emit(
      'line',
      lineEvent({
        filePath,
        lineStartOffset: 0,
        lineEndOffset: 40,
        parsed: { type: 'ignored-by-default', event_type: 'trade.filled' },
      }),
    );
    await delay(20);
    assert.equal(provider.calls.length, 1);
    assert.equal(provider.calls[0].tier, 'notify');
    assert.match(provider.calls[0].text, /^\[trade\.filled\]\n/);
    assert.equal(state.getSource(filePath)?.offset, 40);

    // Loopback guard fires on event_type == 'human_reply'.
    watcher.emit(
      'line',
      lineEvent({
        filePath,
        lineStartOffset: 40,
        lineEndOffset: 80,
        parsed: { type: 'ignored', event_type: 'human_reply', text: 'hi' },
      }),
    );
    await delay(20);
    assert.equal(provider.calls.length, 1, 'loopback must skip delivery');
    assert.equal(state.getSource(filePath)?.offset, 80);

    // Tier 'ignore' on the custom field.
    watcher.emit(
      'line',
      lineEvent({
        filePath,
        lineStartOffset: 80,
        lineEndOffset: 110,
        parsed: { type: 'whatever', event_type: 'noisy' },
      }),
    );
    await delay(20);
    assert.equal(provider.calls.length, 1, "tier 'ignore' must skip delivery");
    assert.equal(state.getSource(filePath)?.offset, 110);

    await d.stop();
  });

  it('disabled source: skips delivery and does not advance', async () => {
    const statePath = await mkTmpStatePath('disabled-skip');
    const state = await RelayState.load(statePath);
    const source = makeSource();
    const provider = new StubProvider();
    const watcher = fakeWatcher();

    const filePath = '/tmp/skip.jsonl';
    state.setSource(filePath, {
      sourceName: source.name,
      offset: 0,
      destination: { key: 'k1' },
      destinationKey: 'stub://k1',
      disabled: true,
      disabledReason: 'previously disabled',
    });

    const d = new RelayDispatcher({
      sources: [source],
      state,
      providers: new Map([['stub', provider]]),
      watcher,
    });
    d.start();

    watcher.emit('line', lineEvent({ filePath, lineEndOffset: 60 }));
    await delay(20);

    assert.equal(provider.calls.length, 0);
    assert.equal(state.getSource(filePath)?.offset, 0);

    await d.stop();
  });
});

describe('RelayDispatcher inbound', () => {
  it('appends a typed line to the mapped file when receive yields an event', async () => {
    const statePath = await mkTmpStatePath('inbound');
    const state = await RelayState.load(statePath);
    const source = makeSource({ inboundTypes: ['human_input'] });
    const provider = new StubProvider();

    // One-shot inbound feed: yield a single event, then block on abort.
    provider.receiveFn = async function* (signal) {
      yield {
        destination: { key: 'k1' },
        text: 'hello from human',
        raw: { fake: true },
      };
      await new Promise<void>((resolve) => {
        if (signal.aborted) return resolve();
        signal.addEventListener('abort', () => resolve(), { once: true });
      });
    };

    const watcher = fakeWatcher();

    const filePath = await mkTmpFile('inbound');
    state.setSource(filePath, {
      sourceName: source.name,
      offset: 0,
      destination: { key: 'k1' },
      destinationKey: 'stub://k1',
    });

    const d = new RelayDispatcher({
      sources: [source],
      state,
      providers: new Map([['stub', provider]]),
      watcher,
    });
    d.start();

    await delay(80);

    const raw = await fsp.readFile(filePath, 'utf8');
    const lines = raw.split('\n').filter((l) => l.length);
    assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0]);
    assert.equal(parsed.type, 'human_input');
    assert.equal(parsed.text, 'hello from human');
    assert.equal(parsed.source, 'relay-inbound');
    assert.ok(typeof parsed.timestamp === 'string' && parsed.timestamp.length > 0);

    await d.stop();
  });

  it('falls back to "human_input" when source has no configured inboundTypes', async () => {
    const statePath = await mkTmpStatePath('inbound-fallback');
    const state = await RelayState.load(statePath);
    const source = makeSource({ inboundTypes: [] });
    const provider = new StubProvider();

    provider.receiveFn = async function* (signal) {
      yield { destination: { key: 'k2' }, text: 'hi', raw: {} };
      await new Promise<void>((resolve) => {
        if (signal.aborted) return resolve();
        signal.addEventListener('abort', () => resolve(), { once: true });
      });
    };

    const watcher = fakeWatcher();

    const filePath = await mkTmpFile('inbound-fallback');
    state.setSource(filePath, {
      sourceName: source.name,
      offset: 0,
      destination: { key: 'k2' },
      destinationKey: 'stub://k2',
    });

    const d = new RelayDispatcher({
      sources: [source],
      state,
      providers: new Map([['stub', provider]]),
      watcher,
    });
    d.start();
    await delay(80);

    const raw = await fsp.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw.trim());
    assert.equal(parsed.type, 'human_input');
    await d.stop();
  });

  it('custom tier_key: inbound append writes the configured field, not "type"', async () => {
    const statePath = await mkTmpStatePath('inbound-tier-key');
    const state = await RelayState.load(statePath);
    const source = makeSource({
      tierKey: 'event_type',
      inboundTypes: ['human_reply'],
    });
    const provider = new StubProvider();

    provider.receiveFn = async function* (signal) {
      yield {
        destination: { key: 'k1' },
        text: 'custom-field inbound',
        raw: { fake: true },
      };
      await new Promise<void>((resolve) => {
        if (signal.aborted) return resolve();
        signal.addEventListener('abort', () => resolve(), { once: true });
      });
    };

    const watcher = fakeWatcher();
    const filePath = await mkTmpFile('inbound-tier-key');
    state.setSource(filePath, {
      sourceName: source.name,
      offset: 0,
      destination: { key: 'k1' },
      destinationKey: 'stub://k1',
    });

    const d = new RelayDispatcher({
      sources: [source],
      state,
      providers: new Map([['stub', provider]]),
      watcher,
    });
    d.start();
    await delay(80);

    const raw = await fsp.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw.trim());
    // Appended line uses the configured key field, NOT "type".
    assert.equal(parsed.event_type, 'human_reply');
    assert.equal(parsed.type, undefined);
    assert.equal(parsed.text, 'custom-field inbound');
    assert.equal(parsed.source, 'relay-inbound');
    assert.ok(typeof parsed.timestamp === 'string' && parsed.timestamp.length > 0);

    await d.stop();
  });

  it('skips inbound events whose destination key is unknown', async () => {
    const statePath = await mkTmpStatePath('inbound-unknown');
    const state = await RelayState.load(statePath);
    const source = makeSource();
    const provider = new StubProvider();

    provider.receiveFn = async function* (signal) {
      yield { destination: { key: 'nope' }, text: 'nobody', raw: {} };
      await new Promise<void>((resolve) => {
        if (signal.aborted) return resolve();
        signal.addEventListener('abort', () => resolve(), { once: true });
      });
    };

    const watcher = fakeWatcher();

    // Map a DIFFERENT destination so 'nope' is unknown.
    const filePath = await mkTmpFile('inbound-unknown');
    state.setSource(filePath, {
      sourceName: source.name,
      offset: 0,
      destination: { key: 'known' },
      destinationKey: 'stub://known',
    });

    const d = new RelayDispatcher({
      sources: [source],
      state,
      providers: new Map([['stub', provider]]),
      watcher,
    });
    d.start();
    await delay(60);

    const raw = await fsp.readFile(filePath, 'utf8');
    assert.equal(raw, '', 'file should be untouched when destination is unknown');
    await d.stop();
  });
});
