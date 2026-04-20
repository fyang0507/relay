// Tests for src/dataRepo.ts — resolveDataRepo().
//
// Resolution order: RELAY_DATA_REPO env → relay.config.dev.yaml next to
// the binary → walk up from cwd for .agents/workspace.yaml → throw.
//
// We exercise env and walk-up and the error path against real tmp dirs.
// The "dev yaml next to binary" branch is intentionally not covered here
// because writing into the relay repo root during test runs would clobber
// a dev's own config; it's a few lines of straight-line code and is
// covered by the identical outreach/sundial pattern.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  resolveDataRepo,
  DataRepoUnresolvedError,
  WORKSPACE_MARKER_REL,
} from '../src/dataRepo.ts';

async function tmpRepo(prefix: string): Promise<string> {
  // `fs.realpath` normalises any symlinks (macOS /var → /private/var) so
  // resolved paths line up with path.resolve() expectations in assertions.
  const raw = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  return await fsp.realpath(raw);
}

test('resolveDataRepo: RELAY_DATA_REPO env wins', async (t) => {
  const tmp = await tmpRepo('relay-datarepo-env-');
  t.after(() => fsp.rm(tmp, { recursive: true, force: true }));

  const resolved = resolveDataRepo({ cwd: tmp, env: { RELAY_DATA_REPO: tmp } });
  assert.equal(resolved.path, tmp);
  assert.equal(resolved.source, 'env');
});

test('resolveDataRepo: RELAY_DATA_REPO expands ~ home prefix', async () => {
  const resolved = resolveDataRepo({
    cwd: '/tmp',
    env: { RELAY_DATA_REPO: '~/dummy-relay-data' },
  });
  assert.equal(resolved.path, path.join(os.homedir(), 'dummy-relay-data'));
  assert.equal(resolved.source, 'env');
});

test('resolveDataRepo: empty RELAY_DATA_REPO is treated as unset', async (t) => {
  const tmp = await tmpRepo('relay-datarepo-empty-');
  t.after(() => fsp.rm(tmp, { recursive: true, force: true }));

  // No marker and empty env → error path.
  assert.throws(
    () => resolveDataRepo({ cwd: tmp, env: { RELAY_DATA_REPO: '' } }),
    (err: unknown) => err instanceof DataRepoUnresolvedError,
  );
});

test('resolveDataRepo: walks up cwd for .agents/workspace.yaml', async (t) => {
  const root = await tmpRepo('relay-datarepo-walk-');
  t.after(() => fsp.rm(root, { recursive: true, force: true }));

  // Marker at <root>/.agents/workspace.yaml; cwd deep inside the repo.
  const agentsDir = path.join(root, '.agents');
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(path.join(root, WORKSPACE_MARKER_REL), 'version: 1\n', 'utf-8');

  const deep = path.join(root, 'a', 'b', 'c');
  mkdirSync(deep, { recursive: true });

  const resolved = resolveDataRepo({ cwd: deep, env: {} });
  assert.equal(resolved.path, root);
  assert.equal(resolved.source, 'walkup');
});

test('resolveDataRepo: no env, no marker → throws DataRepoUnresolvedError', async (t) => {
  const tmp = await tmpRepo('relay-datarepo-missing-');
  t.after(() => fsp.rm(tmp, { recursive: true, force: true }));

  let thrown: unknown;
  try {
    resolveDataRepo({ cwd: tmp, env: {} });
  } catch (err) {
    thrown = err;
  }
  assert.ok(
    thrown instanceof DataRepoUnresolvedError,
    'expected DataRepoUnresolvedError',
  );
  assert.match((thrown as Error).message, /RELAY_DATA_REPO/);
  assert.match((thrown as Error).message, /relay setup/);
  assert.match((thrown as Error).message, /workspace\.yaml/);
});
