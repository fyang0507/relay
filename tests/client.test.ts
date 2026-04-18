// Tests for src/client.ts. We stand up a fake server on a tmp unix socket
// that speaks the real protocol — simpler than mocking `net` and catches
// wire-format bugs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { RelayClient, DaemonNotRunningError } from '../src/client.ts';

async function mkTmpDir(label: string): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), `relay-client-${label}-`));
}

type Responder = (req: unknown) => unknown | Promise<unknown>;

interface FakeServer {
  server: net.Server;
  socketPath: string;
  tmpDir: string;
  close: () => Promise<void>;
}

// Stand up a trivial newline-JSON server. `respond` receives the parsed
// request and returns the JS object to serialize back. If it returns
// `undefined`, the server closes without writing — exercises the client's
// "connection closed before response" path.
async function startFakeServer(
  label: string,
  respond: Responder,
): Promise<FakeServer> {
  const tmpDir = await mkTmpDir(label);
  const socketPath = path.join(tmpDir, 's');
  const server = net.createServer((socket) => {
    let buf = '';
    socket.setEncoding('utf8');
    socket.on('data', async (chunk: string) => {
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      const line = buf.slice(0, nl);
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        socket.end();
        return;
      }
      const resp = await respond(parsed);
      if (resp === undefined) {
        socket.end();
        return;
      }
      socket.write(JSON.stringify(resp) + '\n', () => socket.end());
    });
    socket.on('error', () => socket.destroy());
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => resolve());
  });
  return {
    server,
    socketPath,
    tmpDir,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await fsp.rm(tmpDir, { recursive: true, force: true });
    },
  };
}

test('list round-trips', async (t) => {
  const fs = await startFakeServer('list', (req) => {
    assert.deepEqual(req, { cmd: 'list' });
    return {
      ok: true,
      sources: [
        {
          id: 'rl_aaaaaa',
          configPath: '/abs/relay.yaml',
          sourceName: 'x',
          provider: 'stdout',
          filesTracked: 0,
          disabled: false,
        },
      ],
    };
  });
  t.after(() => fs.close());
  const client = new RelayClient(fs.socketPath);
  const sources = await client.list();
  assert.equal(sources.length, 1);
  assert.equal(sources[0].id, 'rl_aaaaaa');
});

test('add passes configPath + dryRun through', async (t) => {
  const fs = await startFakeServer('add', (req) => {
    const r = req as Record<string, unknown>;
    assert.equal(r.cmd, 'add');
    assert.equal(r.configPath, '/abs/relay.yaml');
    assert.equal(r.dryRun, true);
    return {
      ok: true,
      dryRun: true,
      wouldAdd: [{ name: 'demo', provider: 'stdout', pathGlob: '/x' }],
      warnings: [],
    };
  });
  t.after(() => fs.close());
  const client = new RelayClient(fs.socketPath);
  const resp = await client.add({ configPath: '/abs/relay.yaml', dryRun: true });
  assert.equal(resp.ok, true);
  if ('dryRun' in resp) {
    assert.equal(resp.wouldAdd[0].name, 'demo');
  } else {
    assert.fail('expected dryRun response');
  }
});

test('remove round-trips', async (t) => {
  const fs = await startFakeServer('remove', (req) => {
    const r = req as Record<string, unknown>;
    assert.equal(r.cmd, 'remove');
    assert.equal(r.id, 'rl_abc123');
    return {
      ok: true,
      removed: {
        id: 'rl_abc123',
        configPath: '/abs/relay.yaml',
        sourceName: 'demo',
      },
    };
  });
  t.after(() => fs.close());
  const client = new RelayClient(fs.socketPath);
  const resp = await client.remove({ id: 'rl_abc123' });
  if ('removed' in resp) {
    assert.equal(resp.removed.id, 'rl_abc123');
  } else {
    assert.fail('expected removed response');
  }
});

test('health round-trips', async (t) => {
  const fs = await startFakeServer('health', () => ({
    ok: true,
    version: '1.2.3',
    sourcesTracked: 5,
    uptimeSeconds: 42,
  }));
  t.after(() => fs.close());
  const client = new RelayClient(fs.socketPath);
  const resp = await client.health();
  assert.equal(resp.version, '1.2.3');
  assert.equal(resp.sourcesTracked, 5);
  assert.equal(resp.uptimeSeconds, 42);
});

test('error responses throw with .code attached', async (t) => {
  const fs = await startFakeServer('err', () => ({
    ok: false,
    error: 'no relay with id rl_zzz',
    code: 'not_found',
  }));
  t.after(() => fs.close());
  const client = new RelayClient(fs.socketPath);
  await assert.rejects(
    () => client.remove({ id: 'rl_zzz' }),
    (err: Error & { code?: string }) => {
      assert.equal(err.code, 'not_found');
      assert.match(err.message, /no relay with id/);
      return true;
    },
  );
});

test('connection refused / ENOENT throws DaemonNotRunningError', async (t) => {
  const tmpDir = await mkTmpDir('missing');
  t.after(() => fsp.rm(tmpDir, { recursive: true, force: true }));
  const client = new RelayClient(path.join(tmpDir, 'does-not-exist'));
  await assert.rejects(
    () => client.health(),
    (err: unknown) => {
      assert.ok(err instanceof DaemonNotRunningError, 'expected DaemonNotRunningError');
      assert.equal((err as DaemonNotRunningError).code, 'not_running');
      return true;
    },
  );
});

test('timeout throws with code "timeout"', async (t) => {
  // A server that never replies — accept the connection, read nothing useful,
  // and keep the socket open. The client timeout must fire. We track accepted
  // sockets so the test's `t.after` can destroy them; `server.close()` alone
  // doesn't drop already-connected peers, which would hang Node's event loop
  // past the test body.
  const tmpDir = await mkTmpDir('timeout');
  const socketPath = path.join(tmpDir, 's');
  const peers: net.Socket[] = [];
  const server = net.createServer((s) => {
    peers.push(s);
    s.on('error', () => s.destroy());
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => resolve());
  });
  t.after(async () => {
    for (const p of peers) {
      try {
        p.destroy();
      } catch {
        /* ignore */
      }
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });
  const client = new RelayClient(socketPath, { timeoutMs: 150 });
  await assert.rejects(
    () => client.health(),
    (err: Error & { code?: string }) => {
      assert.equal(err.code, 'timeout');
      return true;
    },
  );
});
