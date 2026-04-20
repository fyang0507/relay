#!/usr/bin/env node
// Build-time skills sync.
//
// Copies skills/relay-integration/ → <data_repo>/.agents/skills/relay/ so
// whatever version of relay just built matches the docs the agent sees.
// Invoked from `npm run build` after `tsc`, using the compiled
// dist/dataRepo.js so the resolution order (env → dev yaml → walk-up)
// matches what the CLI uses at runtime.
//
// Tolerant of a missing data repo: fresh clones, CI, or anyone running
// `npm run build` without having set up a data repo yet get a warning and
// a zero exit — the build itself stays usable. Re-run this script (or
// `relay setup`) once the data repo is configured.
//
// Environment:
//   RELAY_SKIP_SKILLS_SYNC=1  → skip silently; intended for CI / packaging.

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

if (process.env.RELAY_SKIP_SKILLS_SYNC === '1') {
  process.exit(0);
}

let resolveDataRepo;
let DataRepoUnresolvedError;
try {
  ({ resolveDataRepo, DataRepoUnresolvedError } = await import(
    join(repoRoot, 'dist', 'dataRepo.js')
  ));
} catch (err) {
  console.warn(
    `[relay sync-skills] skipped: could not load dist/dataRepo.js (${err.message}).`,
  );
  process.exit(0);
}

let syncSkills;
try {
  ({ syncSkills } = await import(join(repoRoot, 'dist', 'skillsSync.js')));
} catch (err) {
  console.warn(
    `[relay sync-skills] skipped: could not load dist/skillsSync.js (${err.message}).`,
  );
  process.exit(0);
}

let resolved;
try {
  resolved = resolveDataRepo();
} catch (err) {
  if (err instanceof DataRepoUnresolvedError) {
    console.warn(
      '[relay sync-skills] skipped: no data repo resolved (set RELAY_DATA_REPO, ' +
        'create relay.config.dev.yaml, or run `relay setup --data-repo <path>`).',
    );
    process.exit(0);
  }
  throw err;
}

const skillsSrc = join(repoRoot, 'skills', 'relay-integration');
const skillsDest = join(resolved.path, '.agents', 'skills', 'relay');
const { destination } = syncSkills(skillsSrc, skillsDest);
console.log(`[relay sync-skills] synced → ${destination}`);
