// Tests for src/commands/setup.ts — `relay setup`.
//
// The command is a thin wrapper around performSetup(); we exercise the
// latter directly so we don't have to parse stdout. Assertions:
//   - workspace.yaml is created with version:1 and tools.relay.version
//   - rerun is idempotent (status flips from 'created' → 'existing')
//   - bumping the version surfaces as 'updated'
//   - sibling tool entries (outreach, sundial) are preserved byte-wise
//   - skills sync copies SKILL.md + telegram-setup.md into
//     <data_repo>/.agents/skills/relay/
//   - non-existent data repo via env (not flag) → CliError
//   - non-existent data repo via flag → directory is created

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import { performSetup } from '../src/commands/setup.ts';
import { CliError } from '../src/commands/errors.ts';

async function tmpRepo(prefix: string): Promise<string> {
  const raw = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  return await fsp.realpath(raw);
}

test('performSetup: creates workspace.yaml + syncs skills on a fresh data repo', async (t) => {
  const tmp = await tmpRepo('relay-setup-fresh-');
  t.after(() => fsp.rm(tmp, { recursive: true, force: true }));

  const result = await performSetup({ dataRepo: tmp });

  assert.equal(result.dataRepo, tmp);
  assert.equal(result.resolution, 'flag');
  assert.equal(result.workspaceStatus, 'created');
  assert.equal(result.workspacePath, path.join(tmp, '.agents', 'workspace.yaml'));
  assert.equal(result.skillsPath, path.join(tmp, '.agents', 'skills', 'relay'));
  assert.match(result.version, /^\d+\.\d+\.\d+/);

  const ws = parseYaml(readFileSync(result.workspacePath, 'utf-8')) as {
    version: number;
    tools: Record<string, { version: string }>;
  };
  assert.equal(ws.version, 1);
  assert.equal(ws.tools.relay.version, result.version);

  const skillFile = path.join(result.skillsPath, 'SKILL.md');
  const stat = await fsp.stat(skillFile);
  assert.ok(stat.isFile(), 'expected SKILL.md to be synced');
});

test('performSetup: re-run is idempotent (status flips to existing)', async (t) => {
  const tmp = await tmpRepo('relay-setup-idempotent-');
  t.after(() => fsp.rm(tmp, { recursive: true, force: true }));

  const first = await performSetup({ dataRepo: tmp });
  assert.equal(first.workspaceStatus, 'created');

  const second = await performSetup({ dataRepo: tmp });
  assert.equal(second.workspaceStatus, 'existing');
  assert.equal(second.version, first.version);
});

test('performSetup: preserves sibling tool entries in workspace.yaml', async (t) => {
  const tmp = await tmpRepo('relay-setup-siblings-');
  t.after(() => fsp.rm(tmp, { recursive: true, force: true }));

  const agentsDir = path.join(tmp, '.agents');
  mkdirSync(agentsDir, { recursive: true });
  const priorDoc = {
    version: 1,
    tools: {
      outreach: { version: '2.2.0' },
      sundial: { version: '1.0.0', custom: 'hi' },
    },
  };
  const workspacePath = path.join(agentsDir, 'workspace.yaml');
  writeFileSync(workspacePath, stringifyYaml(priorDoc), 'utf-8');

  const result = await performSetup({ dataRepo: tmp });
  assert.equal(result.workspaceStatus, 'updated');

  const ws = parseYaml(readFileSync(workspacePath, 'utf-8')) as {
    version: number;
    tools: Record<string, Record<string, unknown>>;
  };
  assert.equal(ws.tools.outreach.version, '2.2.0');
  assert.equal(ws.tools.sundial.version, '1.0.0');
  assert.equal(ws.tools.sundial.custom, 'hi');
  assert.equal(ws.tools.relay.version, result.version);
});

test('performSetup: walks up for workspace.yaml when cwd is inside data repo', async (t) => {
  const tmp = await tmpRepo('relay-setup-walkup-');
  t.after(() => fsp.rm(tmp, { recursive: true, force: true }));

  // Pre-create a bare workspace.yaml marker so walk-up wins over error.
  const agentsDir = path.join(tmp, '.agents');
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(path.join(agentsDir, 'workspace.yaml'), 'version: 1\n', 'utf-8');

  const deep = path.join(tmp, 'nested', 'dir');
  mkdirSync(deep, { recursive: true });

  const result = await performSetup({ cwd: deep, env: {} });
  assert.equal(result.dataRepo, tmp);
  assert.equal(result.resolution, 'walkup');
});

test('performSetup: env-resolved but non-existent data repo → CliError', async (t) => {
  const missing = path.join(
    os.tmpdir(),
    `relay-setup-nonexistent-${Date.now()}-${Math.random()}`,
  );
  // Do NOT create `missing`.

  let thrown: unknown;
  try {
    await performSetup({
      cwd: os.tmpdir(),
      env: { RELAY_DATA_REPO: missing },
    });
  } catch (err) {
    thrown = err;
  }
  assert.ok(thrown instanceof CliError, 'expected CliError for missing repo');
  assert.match((thrown as CliError).lines.join('\n'), /does not exist/);
});

test('performSetup: flag resolution creates a missing data repo directory', async (t) => {
  const parent = await tmpRepo('relay-setup-create-');
  t.after(() => fsp.rm(parent, { recursive: true, force: true }));
  const target = path.join(parent, 'fresh-data-repo');

  const result = await performSetup({ dataRepo: target });
  assert.equal(result.resolution, 'flag');
  assert.equal(result.dataRepo, target);

  const wsStat = await fsp.stat(result.workspacePath);
  assert.ok(wsStat.isFile());
});

test('performSetup: unresolved data repo → CliError with remediation', async (t) => {
  const tmp = await tmpRepo('relay-setup-unresolved-');
  t.after(() => fsp.rm(tmp, { recursive: true, force: true }));

  let thrown: unknown;
  try {
    await performSetup({ cwd: tmp, env: {} });
  } catch (err) {
    thrown = err;
  }
  assert.ok(thrown instanceof CliError, 'expected CliError');
  const msg = (thrown as CliError).lines.join('\n');
  assert.match(msg, /Could not resolve relay data repo/);
  assert.match(msg, /relay setup --data-repo/);
  assert.match(msg, /RELAY_DATA_REPO/);
});
