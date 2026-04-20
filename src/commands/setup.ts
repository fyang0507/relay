// `relay setup [--data-repo <path>]` — scaffold per-data-repo relay state.
//
// This is the *per-data-repo* registration flow. It is distinct from
// `relay add --config <path>`, which registers a single watch source with
// the running daemon. Setup is one-time per data repo; it:
//
//   1. Resolves the data repo (flag → RELAY_DATA_REPO → dev yaml → walk-up)
//   2. Ensures .agents/workspace.yaml exists; stamps tools.relay.version
//      while preserving any sibling tool entries (outreach, sundial, …)
//   3. Syncs skills/relay-integration/ → <data_repo>/.agents/skills/relay/
//
// Relay does NOT scaffold a <data_repo>/relay/config.yaml — relay's watch
// registry lives in ~/.relay/state.json and is populated at runtime via
// `relay add --config`. Per-source config files are per-project, not
// per-data-repo.
//
// Idempotency: safe to re-run. Workspace entries for other tools are
// preserved; the relay entry is updated in place. Skills are overwritten.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import { CliError } from './errors.ts';
import { printKv } from './output.ts';
import {
  DEV_CONFIG_FILENAME,
  DataRepoUnresolvedError,
  WORKSPACE_MARKER_REL,
  resolveDataRepo,
  type ResolutionSource,
} from '../dataRepo.ts';
import { syncSkills } from '../skillsSync.ts';

export type SetupResolutionSource = ResolutionSource | 'flag';

export interface SetupResult {
  dataRepo: string;
  resolution: SetupResolutionSource;
  workspaceStatus: 'created' | 'existing' | 'updated';
  workspacePath: string;
  skillsPath: string;
  version: string;
}

export interface SetupCommandOpts {
  dataRepo?: string;
  // Test hooks — overrideable for unit tests.
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

// Repo root sits one directory above this module, whether it loads from
// src/ (dev) or dist/ (built). Matches credentials.ts anchor logic.
function relayRepoRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // From src/commands/*.ts → ../../; from dist/commands/*.js → ../../ also.
  return resolve(here, '..', '..');
}

function readRelayVersion(): string {
  const pkgPath = join(relayRepoRoot(), 'package.json');
  const raw = readFileSync(pkgPath, 'utf-8');
  const parsed = JSON.parse(raw) as { version?: unknown };
  if (typeof parsed.version !== 'string' || parsed.version === '') {
    throw new Error(`relay package.json is missing a "version" field at ${pkgPath}`);
  }
  return parsed.version;
}

function resolveForSetup(
  flagPath: string | undefined,
  opts: { cwd?: string; env?: NodeJS.ProcessEnv },
): { path: string; resolution: SetupResolutionSource } {
  if (flagPath && flagPath.trim() !== '') {
    return { path: expandHome(flagPath.trim()), resolution: 'flag' };
  }
  const resolved = resolveDataRepo({ cwd: opts.cwd, env: opts.env });
  return { path: resolved.path, resolution: resolved.source };
}

interface WorkspaceUpsertResult {
  status: 'created' | 'existing' | 'updated';
}

// Read workspace.yaml, stamp tools.relay.version, write back. Other
// entries (version, tools.outreach, tools.sundial, …) are preserved
// byte-for-byte where possible — we only touch the relay key.
function upsertWorkspaceYaml(dataRepo: string, version: string): WorkspaceUpsertResult {
  const agentsDir = join(dataRepo, '.agents');
  const workspacePath = join(dataRepo, WORKSPACE_MARKER_REL);
  mkdirSync(agentsDir, { recursive: true });

  let existed = false;
  let doc: Record<string, unknown> = {};

  if (existsSync(workspacePath)) {
    existed = true;
    const raw = readFileSync(workspacePath, 'utf-8');
    const parsed = parseYaml(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      doc = parsed as Record<string, unknown>;
    }
  }

  if (doc.version == null) {
    doc.version = 1;
  }

  let tools: Record<string, unknown>;
  if (doc.tools && typeof doc.tools === 'object' && !Array.isArray(doc.tools)) {
    tools = doc.tools as Record<string, unknown>;
  } else {
    tools = {};
    doc.tools = tools;
  }

  const prior = tools.relay;
  let relayEntry: Record<string, unknown>;
  if (prior && typeof prior === 'object' && !Array.isArray(prior)) {
    relayEntry = prior as Record<string, unknown>;
  } else {
    relayEntry = {};
  }
  const priorVersion = relayEntry.version;
  relayEntry.version = version;
  tools.relay = relayEntry;

  writeFileSync(workspacePath, stringifyYaml(doc), 'utf-8');

  let status: 'created' | 'existing' | 'updated';
  if (!existed) status = 'created';
  else if (priorVersion === version) status = 'existing';
  else status = 'updated';
  return { status };
}

export async function runSetup(opts: SetupCommandOpts = {}): Promise<void> {
  const result = await performSetup(opts);

  printKv([
    ['data_repo', result.dataRepo],
    ['resolution', result.resolution],
    ['workspace', result.workspaceStatus],
    ['workspace_path', result.workspacePath],
    ['skills', result.skillsPath],
    ['relay_version', result.version],
  ]);
}

// Exposed for tests / programmatic callers that want the structured result
// without touching stdout.
export async function performSetup(opts: SetupCommandOpts = {}): Promise<SetupResult> {
  let resolved: { path: string; resolution: SetupResolutionSource };
  try {
    resolved = resolveForSetup(opts.dataRepo, { cwd: opts.cwd, env: opts.env });
  } catch (err) {
    if (err instanceof DataRepoUnresolvedError) {
      throw new CliError(err.message.split('\n'), 1);
    }
    throw err;
  }

  // Flag-based resolution is an explicit bootstrap intent — create the dir.
  // Other resolution sources point at a supposedly existing repo; failing
  // fast there surfaces typos instead of silently scaffolding a new tree.
  if (resolved.resolution === 'flag') {
    mkdirSync(resolved.path, { recursive: true });
  } else if (!existsSync(resolved.path)) {
    throw new CliError(
      [
        `Error: resolved data repo does not exist: ${resolved.path}`,
        `  Resolution source: ${resolved.resolution}`,
        '  Create the directory, or pass --data-repo <path> to scaffold one.',
      ],
      1,
    );
  }

  const version = readRelayVersion();
  const workspace = upsertWorkspaceYaml(resolved.path, version);

  const skillsSrc = join(relayRepoRoot(), 'skills', 'relay-integration');
  const skillsDest = join(resolved.path, '.agents', 'skills', 'relay');
  syncSkills(skillsSrc, skillsDest);

  return {
    dataRepo: resolved.path,
    resolution: resolved.resolution,
    workspaceStatus: workspace.status,
    workspacePath: join(resolved.path, WORKSPACE_MARKER_REL),
    skillsPath: skillsDest,
    version,
  };
}

// Re-export so docs and error messages can surface the same names.
export { DEV_CONFIG_FILENAME, WORKSPACE_MARKER_REL };
