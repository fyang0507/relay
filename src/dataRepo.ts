// Data-repo resolution for relay, paralleling outreach/sundial.
//
// Relay's *watch registry* (which JSONL dirs the daemon follows) lives in
// ~/.relay/state.json and is populated at runtime via `relay add --config`.
// That is a separate concern from "which data repo is this relay install
// scoped to for skills/workspace.yaml" — that's what this module resolves.
//
// Resolution order (first hit wins):
//   1. RELAY_DATA_REPO env var
//   2. relay.config.dev.yaml next to the CLI binary (sticky dev mode)
//   3. Walk up from cwd for .agents/workspace.yaml
//   4. Throw with a remediation message naming `relay setup` and RELAY_DATA_REPO
//
// Why dev beats walk-up: a developer who `cd`s into a real data repo to
// poke at something should still get their dev build. The env var is the
// explicit escape hatch when you actually want the override.
//
// Layout note: this module is emitted to dist/dataRepo.js at build time
// (one level under the repo root). `cliRepoRoot()` resolves via
// import.meta.url so it works for both the TS source (src/dataRepo.ts)
// and the compiled js (dist/dataRepo.js) — both sit one level below the
// relay repo root, where relay.config.dev.yaml lives.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { parse as parseYaml } from 'yaml';

export type ResolutionSource = 'env' | 'dev' | 'walkup';

export interface ResolvedDataRepo {
  path: string;
  source: ResolutionSource;
}

export interface DevConfigLocation {
  path: string;
  dataRepoPath: string | null;
}

export const WORKSPACE_MARKER_REL = join('.agents', 'workspace.yaml');
export const DEV_CONFIG_FILENAME = 'relay.config.dev.yaml';

function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

// One level above this module — same for src/ and dist/ since both sit
// directly under the repo root.
function cliRepoRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..');
}

export function locateDevConfig(): DevConfigLocation | null {
  const path = join(cliRepoRoot(), DEV_CONFIG_FILENAME);
  if (!existsSync(path)) return null;

  let parsed: unknown;
  try {
    parsed = parseYaml(readFileSync(path, 'utf-8'));
  } catch {
    return { path, dataRepoPath: null };
  }

  if (!parsed || typeof parsed !== 'object') {
    return { path, dataRepoPath: null };
  }

  const raw = (parsed as Record<string, unknown>).data_repo_path;
  if (typeof raw !== 'string' || raw.trim() === '') {
    return { path, dataRepoPath: null };
  }

  return { path, dataRepoPath: expandHome(raw.trim()) };
}

function findWorkspaceMarker(startDir: string): string | null {
  let current = resolve(startDir);
  // Cap depth to avoid pathological cases; real filesystems bottom out long
  // before this.
  for (let i = 0; i < 64; i++) {
    if (existsSync(join(current, WORKSPACE_MARKER_REL))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return null;
}

export interface ResolveDataRepoOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export function resolveDataRepo(opts: ResolveDataRepoOptions = {}): ResolvedDataRepo {
  const cwd = opts.cwd ?? process.cwd();
  const env = opts.env ?? process.env;

  const envVal = env.RELAY_DATA_REPO;
  if (envVal && envVal.trim() !== '') {
    return { path: expandHome(envVal.trim()), source: 'env' };
  }

  const dev = locateDevConfig();
  if (dev && dev.dataRepoPath) {
    return { path: dev.dataRepoPath, source: 'dev' };
  }

  const walk = findWorkspaceMarker(cwd);
  if (walk) {
    return { path: walk, source: 'walkup' };
  }

  throw new DataRepoUnresolvedError();
}

// Dedicated error so callers can differentiate "resolve failed" from any
// other Error and print their own remediation block.
export class DataRepoUnresolvedError extends Error {
  constructor() {
    super(
      [
        'Could not resolve relay data repo.',
        'Tried (in order):',
        '  1. RELAY_DATA_REPO env var — unset',
        `  2. ${DEV_CONFIG_FILENAME} next to the CLI — not found or missing data_repo_path`,
        `  3. Walk-up from cwd for ${WORKSPACE_MARKER_REL} — no marker found`,
        '',
        'Fix one of:',
        '  • Run `relay setup --data-repo <path>` to scaffold a data repo.',
        '  • Set RELAY_DATA_REPO=/path/to/data/repo for ad-hoc invocations.',
      ].join('\n'),
    );
    this.name = 'DataRepoUnresolvedError';
  }
}
