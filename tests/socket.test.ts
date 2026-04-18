// Tests for src/socket.ts. Spins up a SocketServer on a tmp socket path
// (never touches ~/.relay/sock) against a hand-rolled fake Relay so we
// exercise the protocol layer in isolation from the runtime.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { SocketServer } from '../src/socket.ts';
import { RelayState, type RegistryEntry } from '../src/state.ts';
import type { Relay, ListedSource } from '../src/runtime.ts';
import type { SourceConfig } from '../src/types.ts';

// Minimal fake that satisfies SocketServer's Relay touchpoints.
// We only reach `addSource`, `removeSource`, and `listSources`.
class FakeRelay {
  private readonly state: RelayState;

  constructor(state: RelayState) {
    this.state = state;
  }

  async addSource(sourceConfig: SourceConfig, configPath: string): Promise<string> {
    const existing = this.state
      .listRegistry()
      .find(
        (e) =>
          e.configPath === configPath &&
          e.sourceConfig.name === sourceConfig.name,
      );
    if (existing) return existing.id;
    const id = this.state.generateRelayId();
    const entry: RegistryEntry = {
      id,
      configPath,
      sourceConfig,
      addedAt: new Date().toISOString(),
    };
    this.state.addRegistry(entry);
    return id;
  }

  async removeSource(id: string): Promise<boolean> {
    const entry = this.state.getRegistry(id);
    if (!entry) return false;
    this.state.removeRegistry(id);
    return true;
  }

  listSources(): ListedSource[] {
    return this.state.listRegistry().map((e) => {
      const files = this.state.listSourcesByRelayId(e.id);
      const filesTracked = files.length;
      const filesDisabled = files.filter((f) => f.state.disabled === true).length;
      const out: ListedSource = {
        id: e.id,
        configPath: e.configPath,
        sourceName: e.sourceConfig.name,
        provider: e.sourceConfig.provider,
        filesTracked,
        filesDisabled,
        disabled: filesTracked > 0 && filesDisabled === filesTracked,
      };
      if (e.sourceConfig.groupId !== undefined) {
        out.groupId = e.sourceConfig.groupId;
      }
      return out;
    });
  }
}

async function mkTmpDir(label: string): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), `relay-socket-${label}-`));
}

interface Harness {
  server: SocketServer;
  socketPath: string;
  state: RelayState;
  relay: FakeRelay;
  tmpDir: string;
  cleanup: () => Promise<void>;
}

async function startHarness(label: string): Promise<Harness> {
  const tmpDir = await mkTmpDir(label);
  // Shorter socket path to stay under the platform's sun_path limit when
  // tmpdir is already long (macOS caps at 104 bytes).
  const socketPath = path.join(tmpDir, 's');
  const statePath = path.join(tmpDir, 'state.json');
  const state = await RelayState.load(statePath);
  const relay = new FakeRelay(state);
  const server = new SocketServer({
    socketPath,
    relay: relay as unknown as Relay,
    state,
    startedAt: Date.now() - 1500, // pretend we started ~1.5s ago
    version: '9.9.9-test',
  });
  await server.start();
  return {
    server,
    socketPath,
    state,
    relay,
    tmpDir,
    cleanup: async () => {
      await server.stop();
      await fsp.rm(tmpDir, { recursive: true, force: true });
    },
  };
}

// Round-trip a raw string request (no newline framing applied by caller —
// tests deliberately include or omit the trailing newline).
async function roundTrip(socketPath: string, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buf = '';
    socket.setEncoding('utf8');
    socket.once('connect', () => {
      socket.write(payload);
    });
    socket.on('data', (chunk: string) => {
      buf += chunk;
    });
    socket.on('end', () => resolve(buf));
    socket.on('close', () => resolve(buf));
    socket.on('error', reject);
    setTimeout(() => {
      socket.destroy();
      reject(new Error('test timeout'));
    }, 3_000).unref?.();
  });
}

async function rpc<T = unknown>(
  socketPath: string,
  request: Record<string, unknown>,
): Promise<T> {
  const raw = await roundTrip(socketPath, JSON.stringify(request) + '\n');
  const line = raw.split('\n')[0];
  return JSON.parse(line) as T;
}

// Helper to write a YAML config file into a tmp dir.
async function writeConfig(dir: string, name: string, body: string): Promise<string> {
  const p = path.join(dir, name);
  await fsp.writeFile(p, body, 'utf8');
  return p;
}

test('socket file exists and is mode 0600 after start', async (t) => {
  const h = await startHarness('perms');
  t.after(() => h.cleanup());
  const stat = await fsp.stat(h.socketPath);
  // Only check the low 9 mode bits; the file-type bits are filled in by the kernel.
  assert.equal(stat.mode & 0o777, 0o600);
});

test('health returns version/sourcesTracked/uptime', async (t) => {
  const h = await startHarness('health');
  t.after(() => h.cleanup());
  const resp = await rpc<{
    ok: boolean;
    version: string;
    sourcesTracked: number;
    uptimeSeconds: number;
  }>(h.socketPath, { cmd: 'health' });
  assert.equal(resp.ok, true);
  assert.equal(resp.version, '9.9.9-test');
  assert.equal(resp.sourcesTracked, 0);
  assert.ok(resp.uptimeSeconds >= 1, `uptime ${resp.uptimeSeconds} should be >= 1`);
});

test('list returns empty sources by default, then reflects registry', async (t) => {
  const h = await startHarness('list');
  t.after(() => h.cleanup());
  let resp = await rpc<{ ok: boolean; sources: ListedSource[] }>(h.socketPath, {
    cmd: 'list',
  });
  assert.deepEqual(resp.sources, []);

  // Plant a registry entry directly via the fake and verify list surfaces it.
  await h.relay.addSource(
    {
      name: 'planted',
      pathGlob: '/tmp/x/*.jsonl',
      provider: 'stdout',
      inboundTypes: ['human_input'],
      tiers: {},
    },
    '/abs/relay.yaml',
  );
  resp = await rpc(h.socketPath, { cmd: 'list' });
  assert.equal(resp.sources.length, 1);
  assert.equal(resp.sources[0].sourceName, 'planted');
  assert.equal(resp.sources[0].provider, 'stdout');
  // No tracked files yet — both counts are zero.
  assert.equal(resp.sources[0].filesTracked, 0);
  assert.equal(resp.sources[0].filesDisabled, 0);
});

test('list surfaces filesDisabled count from per-file state', async (t) => {
  const h = await startHarness('list-disabled');
  t.after(() => h.cleanup());

  const id = await h.relay.addSource(
    {
      name: 'mixed',
      pathGlob: '/tmp/mixed/*.jsonl',
      provider: 'stdout',
      inboundTypes: ['human_input'],
      tiers: {},
    },
    '/abs/relay.yaml',
  );

  // Plant three tracked files: two disabled, one healthy.
  const baseState = {
    sourceName: 'mixed',
    relayId: id,
    offset: 0,
    destination: { kind: 'stdout', sourceName: 'mixed' } as Record<string, unknown>,
    destinationKey: '',
  };
  h.state.setSource('/tmp/mixed/a.jsonl', {
    ...baseState,
    destinationKey: 'stdout://mixed/a',
  });
  h.state.setSource('/tmp/mixed/b.jsonl', {
    ...baseState,
    destinationKey: 'stdout://mixed/b',
    disabled: true,
    disabledReason: 'topic gone',
  });
  h.state.setSource('/tmp/mixed/c.jsonl', {
    ...baseState,
    destinationKey: 'stdout://mixed/c',
    disabled: true,
    disabledReason: 'topic gone',
  });

  const resp = await rpc<{ ok: boolean; sources: ListedSource[] }>(h.socketPath, {
    cmd: 'list',
  });
  assert.equal(resp.sources.length, 1);
  assert.equal(resp.sources[0].filesTracked, 3);
  assert.equal(resp.sources[0].filesDisabled, 2);
  // Not every file is disabled — aggregate `disabled` stays false.
  assert.equal(resp.sources[0].disabled, false);
});

test('add happy path registers sources and returns warnings', async (t) => {
  const h = await startHarness('add-happy');
  t.after(() => h.cleanup());
  const cfgPath = await writeConfig(
    h.tmpDir,
    'relay.yaml',
    // inbound_types empty triggers the loader's auto-inject warning.
    `sources:
  - name: demo
    path_glob: ${h.tmpDir}/*.jsonl
    provider: stdout
`,
  );
  const resp = await rpc<{
    ok: boolean;
    added: Array<{ id: string; name: string }>;
    existing: Array<{ id: string; name: string }>;
    warnings: string[];
  }>(h.socketPath, { cmd: 'add', configPath: cfgPath });
  assert.equal(resp.ok, true);
  assert.equal(resp.added.length, 1);
  assert.equal(resp.added[0].name, 'demo');
  assert.match(resp.added[0].id, /^rl_[0-9a-f]{6}$/);
  assert.deepEqual(resp.existing, []);
  assert.ok(
    resp.warnings.some((w) => w.includes('inbound_types')),
    `expected inbound_types warning, got ${JSON.stringify(resp.warnings)}`,
  );

  // A second add with the same configPath + name should hit the idempotent branch.
  const resp2 = await rpc<typeof resp>(h.socketPath, {
    cmd: 'add',
    configPath: cfgPath,
  });
  assert.deepEqual(resp2.added, []);
  assert.equal(resp2.existing.length, 1);
  assert.equal(resp2.existing[0].id, resp.added[0].id);
});

test('add dryRun does not register and returns wouldAdd', async (t) => {
  const h = await startHarness('add-dry');
  t.after(() => h.cleanup());
  const cfgPath = await writeConfig(
    h.tmpDir,
    'relay.yaml',
    `sources:
  - name: dry
    path_glob: ${h.tmpDir}/*.jsonl
    provider: stdout
    inbound_types: [human_input]
`,
  );
  const resp = await rpc<{
    ok: boolean;
    dryRun: boolean;
    wouldAdd: Array<{ name: string; provider: string; pathGlob: string }>;
  }>(h.socketPath, { cmd: 'add', configPath: cfgPath, dryRun: true });
  assert.equal(resp.ok, true);
  assert.equal(resp.dryRun, true);
  assert.equal(resp.wouldAdd.length, 1);
  assert.equal(resp.wouldAdd[0].name, 'dry');
  // Verify nothing landed in the registry.
  assert.equal(h.state.listRegistry().length, 0);
});

test('add rejects relative configPath', async (t) => {
  const h = await startHarness('add-rel');
  t.after(() => h.cleanup());
  const resp = await rpc<{ ok: boolean; error: string; code: string }>(
    h.socketPath,
    { cmd: 'add', configPath: 'relay.yaml' },
  );
  assert.equal(resp.ok, false);
  assert.equal(resp.code, 'bad_request');
  assert.match(resp.error, /absolute/);
});

test('add on missing file returns config_invalid', async (t) => {
  const h = await startHarness('add-missing');
  t.after(() => h.cleanup());
  const resp = await rpc<{ ok: boolean; error: string; code: string }>(
    h.socketPath,
    { cmd: 'add', configPath: path.join(h.tmpDir, 'does-not-exist.yaml') },
  );
  assert.equal(resp.ok, false);
  assert.equal(resp.code, 'config_invalid');
});

test('add on invalid config surfaces loader error with code config_invalid', async (t) => {
  const h = await startHarness('add-bad');
  t.after(() => h.cleanup());
  const cfgPath = await writeConfig(
    h.tmpDir,
    'bad.yaml',
    // missing provider → validation error with a JSON path in the message
    `sources:
  - name: busted
    path_glob: ${h.tmpDir}/*.jsonl
`,
  );
  const resp = await rpc<{ ok: boolean; error: string; code: string }>(
    h.socketPath,
    { cmd: 'add', configPath: cfgPath },
  );
  assert.equal(resp.ok, false);
  assert.equal(resp.code, 'config_invalid');
  assert.match(resp.error, /sources\[0\]/);
});

test('remove happy path + dryRun + not_found', async (t) => {
  const h = await startHarness('remove');
  t.after(() => h.cleanup());

  // Seed a registry entry via the fake.
  const id = await h.relay.addSource(
    {
      name: 'to-remove',
      pathGlob: '/tmp/x/*.jsonl',
      provider: 'stdout',
      inboundTypes: ['human_input'],
      tiers: {},
    },
    '/abs/relay.yaml',
  );

  // dryRun: still present afterwards.
  const dry = await rpc<{
    ok: boolean;
    dryRun: boolean;
    wouldRemove: {
      id: string;
      configPath: string;
      sourceName: string;
      filesTracked: number;
    };
  }>(h.socketPath, { cmd: 'remove', id, dryRun: true });
  assert.equal(dry.ok, true);
  assert.equal(dry.dryRun, true);
  assert.equal(dry.wouldRemove.id, id);
  assert.equal(dry.wouldRemove.sourceName, 'to-remove');
  assert.equal(dry.wouldRemove.filesTracked, 0);
  assert.ok(h.state.getRegistry(id), 'dryRun must not remove');

  // Real remove.
  const real = await rpc<{
    ok: boolean;
    removed: { id: string; configPath: string; sourceName: string };
  }>(h.socketPath, { cmd: 'remove', id });
  assert.equal(real.ok, true);
  assert.equal(real.removed.id, id);
  assert.equal(h.state.getRegistry(id), undefined);

  // not_found after removal.
  const notFound = await rpc<{ ok: boolean; error: string; code: string }>(
    h.socketPath,
    { cmd: 'remove', id },
  );
  assert.equal(notFound.ok, false);
  assert.equal(notFound.code, 'not_found');
  assert.match(notFound.error, new RegExp(id));
});

test('unknown command returns unknown_cmd', async (t) => {
  const h = await startHarness('unknown');
  t.after(() => h.cleanup());
  const resp = await rpc<{ ok: boolean; error: string; code: string }>(
    h.socketPath,
    { cmd: 'nope' },
  );
  assert.equal(resp.ok, false);
  assert.equal(resp.code, 'unknown_cmd');
  assert.match(resp.error, /nope/);
});

test('malformed JSON returns bad_request', async (t) => {
  const h = await startHarness('malformed');
  t.after(() => h.cleanup());
  const raw = await roundTrip(h.socketPath, 'this is not JSON\n');
  const line = raw.split('\n')[0];
  const resp = JSON.parse(line) as { ok: boolean; code: string };
  assert.equal(resp.ok, false);
  assert.equal(resp.code, 'bad_request');
});
