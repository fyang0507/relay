// Tests for src/commands/lifecycle.ts.
//
// We never invoke the real `launchctl`: every test injects a stub via
// `launchctlExec`. Filesystem I/O is real, but lives under a per-test
// tmpdir — `paths` overrides point every location (plist, daemon script,
// log dir, launch-agents dir) into that tmpdir so tests don't touch
// `~/Library/LaunchAgents/`.
//
// `healthClient` is stubbed to a fake whose `.health()` resolves
// immediately. That's enough to exercise the "poll until healthy" loop
// without opening a real unix socket.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  install,
  uninstall,
  isInstalled,
  resolvePaths,
  DEFAULT_LABEL,
  type LaunchctlResult,
  type LifecyclePaths,
} from '../src/commands/lifecycle.ts';
import type { RelayClient, HealthResult } from '../src/client.ts';
import { buildPlist } from '../src/plist.ts';

// ---- helpers -----------------------------------------------------------

async function mkTmpDir(label: string): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), `relay-lifecycle-${label}-`));
}

// Build a paths override rooted at a tmpdir. Also writes a fake
// `dist/daemon.js` by default so `install()` doesn't error on the "run npm
// run build" check. Set `writeDaemon: false` to exercise that error path.
async function buildTmpPaths(
  root: string,
  opts: { writeDaemon?: boolean } = {},
): Promise<LifecyclePaths> {
  const repoRoot = path.join(root, 'repo');
  const daemonScript = path.join(repoRoot, 'dist', 'daemon.js');
  const launchAgentsDir = path.join(root, 'LaunchAgents');
  const relayDir = path.join(root, 'relay-state');
  const plistPath = path.join(launchAgentsDir, `${DEFAULT_LABEL}.plist`);

  await fsp.mkdir(path.dirname(daemonScript), { recursive: true });
  if (opts.writeDaemon !== false) {
    await fsp.writeFile(daemonScript, '// fake daemon\n');
  }

  return {
    label: DEFAULT_LABEL,
    plistPath,
    nodeBinary: '/usr/local/bin/node',
    daemonScript,
    workingDirectory: repoRoot,
    stdoutLog: path.join(relayDir, 'daemon.out.log'),
    stderrLog: path.join(relayDir, 'daemon.err.log'),
    relayDir,
    launchAgentsDir,
    socketPath: path.join(relayDir, 'sock'),
    domainTarget: 'gui/1000',
    serviceTarget: `gui/1000/${DEFAULT_LABEL}`,
  };
}

// Recorded launchctl invocation + stub driver. `plan` maps the first arg
// (`print`, `bootstrap`, `bootout`) to the result the stub should return.
interface ExecCall {
  args: string[];
}

interface ExecStubOptions {
  // Return value per subcommand. Missing entries default to {code:0}.
  results?: Record<string, LaunchctlResult | LaunchctlResult[]>;
  // Default result when no entry matches.
  fallback?: LaunchctlResult;
}

function makeExecStub(opts: ExecStubOptions = {}) {
  const calls: ExecCall[] = [];
  const remaining: Record<string, LaunchctlResult[]> = {};
  for (const [k, v] of Object.entries(opts.results ?? {})) {
    remaining[k] = Array.isArray(v) ? [...v] : [v];
  }
  const fallback = opts.fallback ?? { stdout: '', stderr: '', code: 0 };
  const exec = async (args: string[]): Promise<LaunchctlResult> => {
    calls.push({ args: [...args] });
    const sub = args[0] ?? '';
    const queue = remaining[sub];
    if (queue && queue.length > 0) return queue.shift()!;
    return fallback;
  };
  return { exec, calls };
}

// Stub RelayClient whose `.health()` immediately resolves. We only type
// the `.health()` method — lifecycle never calls anything else.
function makeHealthyClient(): RelayClient {
  const client = {
    async health(): Promise<HealthResult> {
      return {
        ok: true,
        version: '0.0.0-test',
        sourcesTracked: 0,
        uptimeSeconds: 0,
      };
    },
  };
  return client as unknown as RelayClient;
}

// Stub RelayClient whose `.health()` always rejects — exercises the
// "daemon failed to come up" branch.
function makeUnreachableClient(): RelayClient {
  const client = {
    async health(): Promise<HealthResult> {
      throw new Error('ECONNREFUSED');
    },
  };
  return client as unknown as RelayClient;
}

// Render the plist content the same way install() would, for use in tests
// that want to pre-seed the plist file.
function renderExpectedPlist(paths: LifecyclePaths): string {
  return buildPlist({
    label: paths.label,
    daemonPath: paths.nodeBinary,
    args: [paths.daemonScript],
    workingDirectory: paths.workingDirectory,
    stdoutLog: paths.stdoutLog,
    stderrLog: paths.stderrLog,
  });
}

// ---- tests --------------------------------------------------------------

test('resolvePaths: defaults rooted at home + repo', () => {
  const paths = resolvePaths();
  assert.equal(paths.label, DEFAULT_LABEL);
  assert.ok(paths.plistPath.endsWith(`${DEFAULT_LABEL}.plist`));
  assert.ok(paths.daemonScript.endsWith(path.join('dist', 'daemon.js')));
  assert.match(paths.serviceTarget, /^gui\/\d+\/com\.fyang0507\.relay$/);
  assert.equal(paths.domainTarget, paths.serviceTarget.split('/').slice(0, 2).join('/'));
});

test('install: fresh machine writes plist, calls bootstrap, polls health', async (t) => {
  const tmp = await mkTmpDir('install-fresh');
  t.after(() => fsp.rm(tmp, { recursive: true, force: true }));
  const paths = await buildTmpPaths(tmp);

  // `print` returns non-zero (service not loaded); `bootstrap` succeeds.
  const { exec, calls } = makeExecStub({
    results: {
      print: { stdout: '', stderr: 'Could not find service', code: 1 },
      bootstrap: { stdout: '', stderr: '', code: 0 },
    },
  });

  const res = await install({
    launchctlExec: exec,
    healthClient: makeHealthyClient(),
    paths,
  });

  assert.equal(res.status, 'installed');
  assert.equal(res.plistPath, paths.plistPath);
  assert.equal(res.label, paths.label);
  assert.match(res.detail ?? '', /daemon up/);

  // Plist was written with the expected content.
  const onDisk = await fsp.readFile(paths.plistPath, 'utf8');
  assert.equal(onDisk, renderExpectedPlist(paths));

  // launchctl was called: print (probe), then bootstrap. No bootout
  // because the service wasn't loaded.
  const subs = calls.map((c) => c.args[0]);
  assert.ok(subs.includes('print'));
  assert.ok(subs.includes('bootstrap'));
  assert.ok(!subs.includes('bootout'));

  // Log dir and launch-agents dir both exist.
  await fsp.access(paths.relayDir);
  await fsp.access(paths.launchAgentsDir);
});

test('install: idempotent — same plist content + already loaded → already-installed', async (t) => {
  const tmp = await mkTmpDir('install-idem');
  t.after(() => fsp.rm(tmp, { recursive: true, force: true }));
  const paths = await buildTmpPaths(tmp);

  // Pre-seed the plist file with the exact content install() would write.
  await fsp.mkdir(paths.launchAgentsDir, { recursive: true });
  await fsp.writeFile(paths.plistPath, renderExpectedPlist(paths));

  // `print` returns 0 → service already loaded.
  const { exec, calls } = makeExecStub({
    results: {
      print: { stdout: 'loaded', stderr: '', code: 0 },
    },
  });

  const res = await install({
    launchctlExec: exec,
    healthClient: makeHealthyClient(),
    paths,
  });

  assert.equal(res.status, 'already-installed');
  // No bootstrap, no bootout — we should have bailed after the print check.
  const subs = calls.map((c) => c.args[0]);
  assert.deepEqual(subs, ['print']);
});

test('install: upgrade — loaded but plist content differs → bootout then bootstrap', async (t) => {
  const tmp = await mkTmpDir('install-upgrade');
  t.after(() => fsp.rm(tmp, { recursive: true, force: true }));
  const paths = await buildTmpPaths(tmp);

  // Pre-seed the plist file with OLD content.
  await fsp.mkdir(paths.launchAgentsDir, { recursive: true });
  await fsp.writeFile(paths.plistPath, '<old plist content>\n');

  const { exec, calls } = makeExecStub({
    results: {
      print: { stdout: 'loaded', stderr: '', code: 0 },
      bootout: { stdout: '', stderr: '', code: 0 },
      bootstrap: { stdout: '', stderr: '', code: 0 },
    },
  });

  const res = await install({
    launchctlExec: exec,
    healthClient: makeHealthyClient(),
    paths,
  });

  assert.equal(res.status, 'installed');
  const subs = calls.map((c) => c.args[0]);
  // Order: print (probe) → bootout (upgrade) → bootstrap (new plist).
  assert.deepEqual(subs, ['print', 'bootout', 'bootstrap']);

  // The new plist should have been written.
  const onDisk = await fsp.readFile(paths.plistPath, 'utf8');
  assert.equal(onDisk, renderExpectedPlist(paths));
});

test('install: throws with actionable message when dist/daemon.js is missing', async (t) => {
  const tmp = await mkTmpDir('install-nobuild');
  t.after(() => fsp.rm(tmp, { recursive: true, force: true }));
  const paths = await buildTmpPaths(tmp, { writeDaemon: false });

  const { exec } = makeExecStub();
  await assert.rejects(
    () =>
      install({
        launchctlExec: exec,
        healthClient: makeHealthyClient(),
        paths,
      }),
    (err: Error) => {
      assert.match(err.message, /daemon script not found/);
      assert.match(err.message, /npm run build/);
      return true;
    },
  );
});

test('install: when daemon fails to respond on socket, bootstraps then boots out and throws', async (t) => {
  const tmp = await mkTmpDir('install-nohealth');
  t.after(() => fsp.rm(tmp, { recursive: true, force: true }));
  const paths = await buildTmpPaths(tmp);

  const { exec, calls } = makeExecStub({
    results: {
      print: [
        { stdout: '', stderr: 'not loaded', code: 1 }, // initial probe
        { stdout: 'diagnostic info', stderr: '', code: 0 }, // post-fail diag
      ],
      bootstrap: { stdout: '', stderr: '', code: 0 },
      bootout: { stdout: '', stderr: '', code: 0 },
    },
  });

  await assert.rejects(
    () =>
      install({
        launchctlExec: exec,
        healthClient: makeUnreachableClient(),
        // Shorten the health deadline via the tmp paths — we still have
        // to wait real-time, so bump this down using the stub paths.
        paths,
      }),
    (err: Error) => {
      assert.match(err.message, /did not respond/);
      return true;
    },
  );
  const subs = calls.map((c) => c.args[0]);
  assert.ok(subs.includes('bootstrap'));
  assert.ok(subs.includes('bootout'), 'should try to clean up on failure');
});

test('uninstall: when nothing is loaded and plist is missing → not-installed', async (t) => {
  const tmp = await mkTmpDir('uninstall-noop');
  t.after(() => fsp.rm(tmp, { recursive: true, force: true }));
  const paths = await buildTmpPaths(tmp);

  const { exec, calls } = makeExecStub({
    results: {
      print: { stdout: '', stderr: 'Could not find service', code: 1 },
    },
  });

  const res = await uninstall({ launchctlExec: exec, paths });
  assert.equal(res.status, 'not-installed');
  // Only the probe should have been invoked.
  const subs = calls.map((c) => c.args[0]);
  assert.deepEqual(subs, ['print']);
});

test('uninstall: when loaded → bootout, removes plist, returns uninstalled', async (t) => {
  const tmp = await mkTmpDir('uninstall-loaded');
  t.after(() => fsp.rm(tmp, { recursive: true, force: true }));
  const paths = await buildTmpPaths(tmp);

  // Seed a plist file.
  await fsp.mkdir(paths.launchAgentsDir, { recursive: true });
  await fsp.writeFile(paths.plistPath, renderExpectedPlist(paths));

  const { exec, calls } = makeExecStub({
    results: {
      print: { stdout: 'loaded', stderr: '', code: 0 },
      bootout: { stdout: '', stderr: '', code: 0 },
    },
  });

  const res = await uninstall({ launchctlExec: exec, paths });
  assert.equal(res.status, 'uninstalled');
  assert.equal(res.plistPath, paths.plistPath);

  // Plist file should be gone.
  await assert.rejects(() => fsp.access(paths.plistPath));

  const subs = calls.map((c) => c.args[0]);
  assert.deepEqual(subs, ['print', 'bootout']);
});

test('uninstall: tolerates "No such process" on bootout', async (t) => {
  const tmp = await mkTmpDir('uninstall-race');
  t.after(() => fsp.rm(tmp, { recursive: true, force: true }));
  const paths = await buildTmpPaths(tmp);

  await fsp.mkdir(paths.launchAgentsDir, { recursive: true });
  await fsp.writeFile(paths.plistPath, renderExpectedPlist(paths));

  const { exec } = makeExecStub({
    results: {
      print: { stdout: 'loaded', stderr: '', code: 0 },
      // Race: service died between print and bootout.
      bootout: { stdout: '', stderr: 'No such process', code: 3 },
    },
  });

  const res = await uninstall({ launchctlExec: exec, paths });
  assert.equal(res.status, 'uninstalled');
  await assert.rejects(() => fsp.access(paths.plistPath));
});

test('uninstall: surfaces real bootout errors', async (t) => {
  const tmp = await mkTmpDir('uninstall-err');
  t.after(() => fsp.rm(tmp, { recursive: true, force: true }));
  const paths = await buildTmpPaths(tmp);

  await fsp.mkdir(paths.launchAgentsDir, { recursive: true });
  await fsp.writeFile(paths.plistPath, 'x');

  const { exec } = makeExecStub({
    results: {
      print: { stdout: 'loaded', stderr: '', code: 0 },
      bootout: { stdout: '', stderr: 'Permission denied', code: 1 },
    },
  });

  await assert.rejects(
    () => uninstall({ launchctlExec: exec, paths }),
    (err: Error) => /bootout failed/.test(err.message),
  );
});

test('isInstalled: true only when loaded AND plist file exists', async (t) => {
  const tmp = await mkTmpDir('isinstalled');
  t.after(() => fsp.rm(tmp, { recursive: true, force: true }));
  const paths = await buildTmpPaths(tmp);
  await fsp.mkdir(paths.launchAgentsDir, { recursive: true });

  // Neither loaded nor plist.
  {
    const { exec } = makeExecStub({
      results: { print: { stdout: '', stderr: 'no', code: 1 } },
    });
    assert.equal(await isInstalled({ launchctlExec: exec, paths }), false);
  }

  // Loaded but no plist file.
  {
    const { exec } = makeExecStub({
      results: { print: { stdout: 'yes', stderr: '', code: 0 } },
    });
    assert.equal(await isInstalled({ launchctlExec: exec, paths }), false);
  }

  // Plist file present but not loaded.
  await fsp.writeFile(paths.plistPath, 'x');
  {
    const { exec } = makeExecStub({
      results: { print: { stdout: '', stderr: 'no', code: 1 } },
    });
    assert.equal(await isInstalled({ launchctlExec: exec, paths }), false);
  }

  // Both conditions true.
  {
    const { exec } = makeExecStub({
      results: { print: { stdout: 'yes', stderr: '', code: 0 } },
    });
    assert.equal(await isInstalled({ launchctlExec: exec, paths }), true);
  }
});
