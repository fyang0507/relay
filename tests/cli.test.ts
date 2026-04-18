// Light smoke tests for the relay CLI. Runs the compiled `dist/cli.js` as a
// subprocess so we exercise the real commander wiring + shebang executable
// layer. Deeper integration (daemon lifecycle, init, health) is covered by
// the Phase 3 integration test; here we just verify:
//  - `--help` renders without throwing
//  - `status` on a missing state dir fails cleanly (no stack trace)
//  - `status` on an empty state file reports "no sources tracked" and exits 0
//
// Run order note: these tests shell out to `node dist/cli.js`, so `npm run
// build` must have been executed beforehand. Our test runner config doesn't
// auto-build; the test will skip with a clear message if dist is missing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { existsSync } from 'node:fs';

const REPO_ROOT = path.resolve(import.meta.dirname ?? '.', '..');
const CLI_JS = path.join(REPO_ROOT, 'dist', 'cli.js');

interface ProcResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

// Invoke `node dist/cli.js <args>` with optional HOME override. Returns the
// exit code and captured streams. Times out at 10s to keep CI responsive.
function runCli(args: string[], env: NodeJS.ProcessEnv = {}): Promise<ProcResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [CLI_JS, ...args], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString('utf8')));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`cli timed out: ${args.join(' ')}`));
    }, 10_000);
    child.on('exit', (code) => {
      clearTimeout(timeout);
      resolve({ code, stdout, stderr });
    });
    child.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

test('--help prints usage and exits 0', async (t) => {
  if (!existsSync(CLI_JS)) {
    t.skip(`dist/cli.js not found — run \`npm run build\` first`);
    return;
  }
  const result = await runCli(['--help']);
  assert.equal(result.code, 0, `expected 0, got ${result.code}; stderr=${result.stderr}`);
  assert.match(result.stdout, /Usage: relay/);
  assert.match(result.stdout, /init/);
  assert.match(result.stdout, /start/);
  assert.match(result.stdout, /status/);
  assert.match(result.stdout, /health/);
});

test('status --config /nonexistent fails cleanly without a stack trace', async (t) => {
  if (!existsSync(CLI_JS)) {
    t.skip('dist/cli.js not found');
    return;
  }
  // status doesn't actually read config (by design — avoid coupling state
  // inspection to config availability), but it DOES read state from
  // ~/.relay/state.json. Point HOME at a fresh tmp dir so we test the
  // "no state file, no sources" path cleanly, then also confirm passing
  // a bogus --config doesn't crash since the flag is inert here.
  const tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'relay-cli-status-'));
  try {
    const result = await runCli(['status', '--config', '/nonexistent'], {
      HOME: tmpHome,
    });
    assert.equal(result.code, 0);
    // Must not contain a Node stack trace — those start with "at " frames.
    assert.doesNotMatch(result.stderr, /\n\s+at\s+/);
  } finally {
    await fsp.rm(tmpHome, { recursive: true, force: true });
  }
});

test('status with an empty state file prints "no sources tracked" and exits 0', async (t) => {
  if (!existsSync(CLI_JS)) {
    t.skip('dist/cli.js not found');
    return;
  }
  const tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'relay-cli-status-'));
  try {
    const relayDir = path.join(tmpHome, '.relay');
    await fsp.mkdir(relayDir, { recursive: true });
    await fsp.writeFile(
      path.join(relayDir, 'state.json'),
      JSON.stringify({ version: 1, sources: {}, providers: {} }),
    );
    const result = await runCli(['status'], { HOME: tmpHome });
    assert.equal(result.code, 0, `stderr=${result.stderr}`);
    assert.match(result.stdout, /no sources tracked/);
  } finally {
    await fsp.rm(tmpHome, { recursive: true, force: true });
  }
});
