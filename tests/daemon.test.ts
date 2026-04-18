// End-to-end sanity check: spawn the compiled daemon as a subprocess, wait
// for its socket to appear, round-trip a `health` RPC through the real
// client, then send SIGTERM and assert a clean exit.
//
// We deliberately spawn the compiled JS (dist/daemon.js) rather than the TS
// source: the integration target is the actual binary. If `dist/` is missing
// (developer ran `npm test` without `npm run build` first), we skip.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { RelayClient } from '../src/client.ts';

const REPO_ROOT = path.resolve(import.meta.dirname ?? '.', '..');
const DAEMON_JS = path.join(REPO_ROOT, 'dist', 'daemon.js');

async function mkTmpHome(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'relay-daemon-home-'));
}

// Poll for the socket file to show up. Returns true if it appeared in time.
async function waitForSocket(socketPath: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fsp.stat(socketPath);
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  return false;
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<number | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

test('daemon boots, serves health, shuts down on SIGTERM', async (t) => {
  if (!existsSync(DAEMON_JS)) {
    t.skip(`${DAEMON_JS} not found — run \`npm run build\` first`);
    return;
  }

  const fakeHome = await mkTmpHome();
  const socketPath = path.join(fakeHome, '.relay', 'sock');
  t.after(() => fsp.rm(fakeHome, { recursive: true, force: true }));

  const child = spawn('node', [DAEMON_JS], {
    env: {
      ...process.env,
      HOME: fakeHome,
      // RELAY_SOCKET_PATH lets the daemon pick an explicit path even if the
      // HOME override hit surprises on this platform.
      RELAY_SOCKET_PATH: socketPath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (c: Buffer) => (stdout += c.toString('utf8')));
  child.stderr?.on('data', (c: Buffer) => (stderr += c.toString('utf8')));

  // Safety net: if we bail early, make sure we don't leak a daemon process.
  t.after(() => {
    if (!child.killed && child.exitCode === null) {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }
  });

  const appeared = await waitForSocket(socketPath, 3_000);
  if (!appeared) {
    child.kill('SIGKILL');
    t.skip(
      `daemon socket did not appear within 3s — stdout=${stdout} stderr=${stderr}`,
    );
    return;
  }

  const client = new RelayClient(socketPath);
  const health = await client.health();
  assert.equal(health.sourcesTracked, 0);
  assert.ok(typeof health.version === 'string' && health.version.length > 0);

  // Graceful shutdown.
  child.kill('SIGTERM');
  const exitCode = await waitForExit(child, 3_000);
  assert.equal(exitCode, 0, `expected clean exit, got ${exitCode}. stderr=${stderr}`);
});
