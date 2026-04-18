// CLI surface tests for Phase 4.
//
// Split into two layers:
//   1. Subprocess smoke tests: shell out to `node dist/cli.js <args>` so we
//      exercise the real commander wiring + shebang. These confirm --help
//      renders, commander rejects missing required options, and the
//      "daemon not running" stderr block is what we promise.
//   2. In-process tests for the command modules (runHealth, runList,
//      runAdd, runRemove) using a stub RelayClient. These let us assert on
//      captured stdout without spawning a daemon and without waiting for
//      socket connect timeouts.
//
// Subprocess tests require `npm run build` to have run first; they skip
// with a clear message otherwise. In-process tests don't need a build.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import { existsSync } from 'node:fs';

import type {
  RelayClient,
  HealthResult,
  AddResult,
  RemoveResult,
  ListedSource,
} from '../src/client.ts';
import { DaemonNotRunningError } from '../src/client.ts';
import { printKv, printList, printError } from '../src/commands/output.ts';
import { runHealth } from '../src/commands/health.ts';
import { runList } from '../src/commands/list.ts';
import { runAdd } from '../src/commands/add.ts';
import { runRemove } from '../src/commands/remove.ts';
import { CliError } from '../src/commands/errors.ts';

// ---- subprocess helpers ------------------------------------------------

const REPO_ROOT = path.resolve(import.meta.dirname ?? '.', '..');
const CLI_JS = path.join(REPO_ROOT, 'dist', 'cli.js');

interface ProcResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

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

// Capture stdout / stderr writes during a test callback. Restores the
// original methods on teardown regardless of outcome.
async function captureStdio<T>(
  fn: () => Promise<T>,
): Promise<{ stdout: string; stderr: string; result: T }> {
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  let outBuf = '';
  let errBuf = '';
  (process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string) => {
    outBuf += s;
    return true;
  };
  (process.stderr as unknown as { write: (s: string) => boolean }).write = (s: string) => {
    errBuf += s;
    return true;
  };
  try {
    const result = await fn();
    return { stdout: outBuf, stderr: errBuf, result };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

// A handful of ListedSource fixtures that cover the optional-groupId
// branch.
const FIXTURE_SOURCES: ListedSource[] = [
  {
    id: 'rl_a3f1b2',
    configPath: '/Users/x/outreach/relay.config.yaml',
    sourceName: 'outreach-campaigns',
    provider: 'telegram',
    groupId: -1003975893613,
    filesTracked: 3,
    filesDisabled: 0,
    disabled: false,
  },
  {
    id: 'rl_c4d5e6',
    configPath: '/Users/x/other/relay.config.yaml',
    sourceName: 'other-source',
    provider: 'stdout',
    filesTracked: 0,
    filesDisabled: 0,
    disabled: false,
  },
];

// Minimal stub RelayClient. Each method returns a preset value or throws a
// preset error. Typed against the subset of RelayClient we actually call.
function stubClient(overrides: Partial<{
  health: () => Promise<HealthResult>;
  list: () => Promise<ListedSource[]>;
  add: (opts: { configPath: string; dryRun?: boolean }) => Promise<AddResult>;
  remove: (opts: { id: string; dryRun?: boolean }) => Promise<RemoveResult>;
}>): RelayClient {
  const defaultThrow = (name: string) => async () => {
    throw new Error(`stubClient: ${name} not implemented`);
  };
  return {
    health: overrides.health ?? defaultThrow('health'),
    list: overrides.list ?? defaultThrow('list'),
    add: overrides.add ?? defaultThrow('add'),
    remove: overrides.remove ?? defaultThrow('remove'),
  } as unknown as RelayClient;
}

// ---- subprocess smoke tests -------------------------------------------

test('--help prints usage with at least one example', async (t) => {
  if (!existsSync(CLI_JS)) {
    t.skip('dist/cli.js not found — run `npm run build` first');
    return;
  }
  const result = await runCli(['--help']);
  assert.equal(result.code, 0, `stderr=${result.stderr}`);
  assert.match(result.stdout, /Usage: relay/);
  // The top-level help embeds a "relay init" example line.
  assert.match(result.stdout, /relay init/);
  // Every top-level subcommand shows up in the commands list.
  for (const cmd of ['init', 'shutdown', 'health', 'list', 'add', 'remove']) {
    assert.match(result.stdout, new RegExp(`\\b${cmd}\\b`));
  }
});

test('subcommand --help shows Examples block', async (t) => {
  if (!existsSync(CLI_JS)) {
    t.skip('dist/cli.js not found');
    return;
  }
  const result = await runCli(['add', '--help']);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /Examples:/);
  assert.match(result.stdout, /relay add --config/);
});

test('relay health with no daemon running → exit 1 with actionable error', async (t) => {
  if (!existsSync(CLI_JS)) {
    t.skip('dist/cli.js not found');
    return;
  }
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'relay-cli-health-'));
  try {
    const result = await runCli(['health'], {
      RELAY_SOCKET_PATH: path.join(tmp, 'nonexistent-sock'),
    });
    assert.equal(result.code, 1, `stdout=${result.stdout} stderr=${result.stderr}`);
    assert.match(result.stderr, /not running/);
    assert.match(result.stderr, /relay init/);
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true });
  }
});

test('relay add with no --config → commander exits non-zero', async (t) => {
  if (!existsSync(CLI_JS)) {
    t.skip('dist/cli.js not found');
    return;
  }
  const result = await runCli(['add']);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /--config/);
});

test('relay add --config <bogus> without daemon → exit 1 with useful stderr', async (t) => {
  if (!existsSync(CLI_JS)) {
    t.skip('dist/cli.js not found');
    return;
  }
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'relay-cli-add-'));
  try {
    const result = await runCli(
      ['add', '--config', '/nonexistent/relay.config.yaml'],
      { RELAY_SOCKET_PATH: path.join(tmp, 'nonexistent-sock') },
    );
    assert.notEqual(result.code, 0);
    assert.ok(
      result.stderr.length > 0,
      `expected useful stderr, got empty; stdout=${result.stdout}`,
    );
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true });
  }
});

// ---- output-helper unit tests -----------------------------------------

test('printKv aligns colons by longest key', async () => {
  const { stdout } = await captureStdio(async () => {
    printKv([
      ['status', 'ok'],
      ['version', '1.0.0'],
      ['sources_tracked', '2'],
    ]);
  });
  const lines = stdout.trimEnd().split('\n');
  assert.equal(lines.length, 3);
  // Every line should have the value starting at the same column.
  const valueColumns = lines.map((l) => {
    const m = /:\s+\S/.exec(l);
    if (!m) throw new Error(`line missing value: ${l}`);
    return l.indexOf(l.match(/\S+$/)![0]);
  });
  const unique = new Set(valueColumns);
  assert.equal(unique.size, 1, `value columns differ: ${[...unique].join(',')}`);
});

test('printKv handles single-pair input', async () => {
  const { stdout } = await captureStdio(async () => {
    printKv([['k', 'v']]);
  });
  assert.equal(stdout, 'k:  v\n');
});

test('printKv on empty input writes nothing', async () => {
  const { stdout } = await captureStdio(async () => {
    printKv([]);
  });
  assert.equal(stdout, '');
});

test('printList emits title and indented blocks separated by blank lines', async () => {
  const { stdout } = await captureStdio(async () => {
    printList('sources (2):', [
      [
        ['id', 'rl_a'],
        ['name', 'a'],
      ],
      [
        ['id', 'rl_b'],
        ['name', 'b'],
      ],
    ]);
  });
  const lines = stdout.trimEnd().split('\n');
  // title, id/name (2), blank, id/name (2) → 6 lines total.
  assert.equal(lines[0], 'sources (2):');
  assert.ok(lines.some((l) => l === ''), 'expected blank separator line');
  assert.ok(lines.some((l) => /^\s{2}id:/.test(l)), 'expected indented id');
});

test('printError writes lines to stderr', async () => {
  const { stderr, stdout } = await captureStdio(async () => {
    printError(['Error: x', '  fix: y']);
  });
  assert.equal(stdout, '');
  assert.equal(stderr, 'Error: x\n  fix: y\n');
});

// ---- in-process command-module tests ---------------------------------

test('runHealth prints kv block from HealthResult', async () => {
  const client = stubClient({
    health: async () => ({
      ok: true,
      version: '1.0.0',
      sourcesTracked: 2,
      uptimeSeconds: 143,
    }),
  });
  const { stdout } = await captureStdio(async () => {
    await runHealth({ client, socketPath: '/tmp/s' });
  });
  assert.match(stdout, /status:\s+ok/);
  assert.match(stdout, /version:\s+1\.0\.0/);
  assert.match(stdout, /sources_tracked:\s+2/);
  assert.match(stdout, /uptime_seconds:\s+143/);
  assert.match(stdout, /socket:\s+\/tmp\/s/);
});

test('runHealth throws CliError with exit 1 on DaemonNotRunningError', async () => {
  const client = stubClient({
    health: async () => {
      throw new DaemonNotRunningError('/tmp/sock');
    },
  });
  await assert.rejects(
    async () => runHealth({ client, socketPath: '/tmp/sock' }),
    (err: unknown) => {
      assert.ok(err instanceof CliError);
      assert.equal((err as CliError).exitCode, 1);
      assert.ok((err as CliError).lines.some((l) => /not running/.test(l)));
      assert.ok((err as CliError).lines.some((l) => /relay init/.test(l)));
      return true;
    },
  );
});

test('runList prints one block per source', async () => {
  const client = stubClient({
    list: async () => FIXTURE_SOURCES,
  });
  const { stdout } = await captureStdio(async () => {
    await runList({ client, socketPath: '/tmp/s' });
  });
  assert.match(stdout, /sources \(2\):/);
  assert.match(stdout, /id:\s+rl_a3f1b2/);
  assert.match(stdout, /id:\s+rl_c4d5e6/);
  assert.match(stdout, /group_id:\s+-1003975893613/);
  // source without groupId should omit the line
  const secondBlock = stdout.split('\n\n')[1] ?? '';
  assert.ok(!/group_id/.test(secondBlock), 'second block should omit group_id');
  // filesDisabled === 0 → render plain count with no suffix.
  assert.match(stdout, /files_tracked:\s+3\n/);
  assert.ok(
    !/\(\d+ disabled\)/.test(stdout),
    'no "(N disabled)" suffix when filesDisabled === 0',
  );
});

test('runList appends "(N disabled)" suffix when filesDisabled > 0', async () => {
  const client = stubClient({
    list: async () => [
      {
        id: 'rl_disabled',
        configPath: '/abs/c.yaml',
        sourceName: 'mixed',
        provider: 'telegram',
        groupId: -200,
        filesTracked: 2,
        filesDisabled: 1,
        disabled: false,
      },
    ],
  });
  const { stdout } = await captureStdio(async () => {
    await runList({ client, socketPath: '/tmp/s' });
  });
  assert.match(stdout, /files_tracked:\s+2\s+\(1 disabled\)/);
});

test('runList on empty registry prints helpful hint', async () => {
  const client = stubClient({ list: async () => [] });
  const { stdout } = await captureStdio(async () => {
    await runList({ client, socketPath: '/tmp/s' });
  });
  assert.match(stdout, /no sources mapped/);
  assert.match(stdout, /relay add --config/);
});

test('runAdd real-run prints config + added + warnings block', async () => {
  const calls: Array<{ configPath: string; dryRun?: boolean }> = [];
  const client = stubClient({
    add: async (opts) => {
      calls.push(opts);
      return {
        ok: true,
        added: [{ id: 'rl_a3f1b2', name: 'outreach-campaigns' }],
        existing: [],
        warnings: [],
      } as AddResult;
    },
  });
  const { stdout } = await captureStdio(async () => {
    await runAdd({
      configPath: '/abs/relay.config.yaml',
      client,
      socketPath: '/tmp/s',
    });
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.configPath, '/abs/relay.config.yaml');
  assert.match(stdout, /config:\s+\/abs\/relay\.config\.yaml/);
  assert.match(stdout, /added:/);
  assert.match(stdout, /- id: rl_a3f1b2/);
  assert.match(stdout, /warnings: \(none\)/);
  assert.ok(!/existing/.test(stdout), 'existing block should be hidden when empty');
});

test('runAdd resolves relative --config against cwd before sending over socket', async () => {
  const calls: Array<{ configPath: string }> = [];
  const client = stubClient({
    add: async (opts) => {
      calls.push({ configPath: opts.configPath });
      return {
        ok: true,
        added: [],
        existing: [],
        warnings: [],
      } as AddResult;
    },
  });
  await captureStdio(async () => {
    await runAdd({
      configPath: 'relay.config.yaml',
      client,
      socketPath: '/tmp/s',
      cwd: '/Users/x/outreach',
    });
  });
  assert.equal(calls[0]!.configPath, '/Users/x/outreach/relay.config.yaml');
});

test('runAdd dry-run renders would_add entries', async () => {
  const client = stubClient({
    add: async () => ({
      ok: true,
      dryRun: true,
      wouldAdd: [
        {
          name: 'outreach-campaigns',
          provider: 'telegram',
          groupId: -100,
          pathGlob: '/Users/x/*.jsonl',
        },
      ],
      warnings: ['inbound_types was empty; auto-injected [\'human_input\']'],
    } as AddResult),
  });
  const { stdout } = await captureStdio(async () => {
    await runAdd({
      configPath: '/abs/c.yaml',
      dryRun: true,
      client,
      socketPath: '/tmp/s',
    });
  });
  assert.match(stdout, /dry_run:\s+true/);
  assert.match(stdout, /would_add:/);
  assert.match(stdout, /- name: outreach-campaigns/);
  assert.match(stdout, /group_id: -100/);
  assert.match(stdout, /warnings:/);
});

test('runAdd config_invalid → CliError exit 2', async () => {
  const client = stubClient({
    add: async () => {
      const e = new Error('bad yaml') as Error & { code?: string };
      e.code = 'config_invalid';
      throw e;
    },
  });
  await assert.rejects(
    async () =>
      runAdd({
        configPath: '/abs/c.yaml',
        client,
        socketPath: '/tmp/s',
      }),
    (err: unknown) => {
      assert.ok(err instanceof CliError);
      assert.equal((err as CliError).exitCode, 2);
      assert.ok(
        (err as CliError).lines.some((l) => /config validation failed/.test(l)),
      );
      return true;
    },
  );
});

test('runRemove prints removed block on success', async () => {
  const client = stubClient({
    remove: async () => ({
      ok: true,
      removed: {
        id: 'rl_a3f1b2',
        configPath: '/abs/c.yaml',
        sourceName: 'outreach-campaigns',
      },
    } as RemoveResult),
  });
  const { stdout } = await captureStdio(async () => {
    await runRemove({ id: 'rl_a3f1b2', client, socketPath: '/tmp/s' });
  });
  assert.match(stdout, /removed:/);
  assert.match(stdout, /id:\s+rl_a3f1b2/);
  assert.match(stdout, /name:\s+outreach-campaigns/);
});

test('runRemove dry-run prints would_remove block', async () => {
  const client = stubClient({
    remove: async () => ({
      ok: true,
      dryRun: true,
      wouldRemove: {
        id: 'rl_a3f1b2',
        configPath: '/abs/c.yaml',
        sourceName: 'outreach-campaigns',
        filesTracked: 3,
      },
    } as RemoveResult),
  });
  const { stdout } = await captureStdio(async () => {
    await runRemove({
      id: 'rl_a3f1b2',
      dryRun: true,
      client,
      socketPath: '/tmp/s',
    });
  });
  assert.match(stdout, /dry_run:\s+true/);
  assert.match(stdout, /would_remove:/);
  assert.match(stdout, /files_tracked:\s+3/);
});

test('runRemove not_found → CliError with list hint', async () => {
  const client = stubClient({
    remove: async () => {
      const e = new Error('no relay with id rl_bad') as Error & { code?: string };
      e.code = 'not_found';
      throw e;
    },
  });
  await assert.rejects(
    async () => runRemove({ id: 'rl_bad', client, socketPath: '/tmp/s' }),
    (err: unknown) => {
      assert.ok(err instanceof CliError);
      assert.equal((err as CliError).exitCode, 1);
      assert.ok(
        (err as CliError).lines.some((l) => /relay list/.test(l)),
        `expected list hint, got: ${(err as CliError).lines.join(' | ')}`,
      );
      return true;
    },
  );
});
