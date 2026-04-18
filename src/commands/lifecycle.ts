// Lifecycle commands: install, uninstall, isInstalled. Thin wrappers around
// `launchctl` and the filesystem that `relay init` / `relay shutdown` (P4)
// will call. macOS-only — launchd is the only supervisor we support right
// now.
//
// Design notes:
//   - All `launchctl` invocations go through `launchctlExec`. The default
//     implementation spawns `/bin/launchctl` via `execFile`, captures
//     stdout/stderr/exit code, and returns them without throwing. Tests
//     inject their own stub to keep the daemon off the dev machine.
//   - Similarly, the health probe uses a `RelayClient` that tests can swap.
//   - Paths are resolved at call time from `os.homedir()` and from this
//     module's own `import.meta.url` (the same trick used by
//     credentials.ts) so `dist/commands/lifecycle.js` and
//     `src/commands/lifecycle.ts` both land on the same repo root — two
//     levels up.
//   - We use `launchctl bootstrap` / `bootout` (available on macOS 10.10+).
//     The older `load -w` / `unload -w` pair still exists but has been
//     soft-deprecated since 10.11 and the modern pair has cleaner error
//     reporting. Every macOS we support ships with bootstrap/bootout.

import { execFile } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { RelayClient, DaemonNotRunningError } from '../client.ts';
import { buildPlist } from '../plist.ts';

// ---- types --------------------------------------------------------------

export interface LaunchctlResult {
  stdout: string;
  stderr: string;
  code: number;
}

export type LaunchctlExec = (args: string[]) => Promise<LaunchctlResult>;

export interface LifecyclePaths {
  // Launchd label, e.g. 'com.fyang0507.relay'.
  label: string;
  // Absolute path where the plist is written (under ~/Library/LaunchAgents).
  plistPath: string;
  // Absolute path to the node binary that will invoke the daemon.
  nodeBinary: string;
  // Absolute path to the compiled daemon script.
  daemonScript: string;
  // Relay repo root — used as the WorkingDirectory so dotenv finds `.env`.
  workingDirectory: string;
  // Stdout / stderr log files under ~/.relay/.
  stdoutLog: string;
  stderrLog: string;
  // Parent dir for the log files (~/.relay/).
  relayDir: string;
  // Parent dir for the plist file (~/Library/LaunchAgents/).
  launchAgentsDir: string;
  // Unix-domain socket the daemon listens on (~/.relay/sock). Used for the
  // post-bootstrap health probe.
  socketPath: string;
  // GUI domain target — `gui/<uid>` — so we can address the per-user agent
  // for bootstrap / bootout / print.
  domainTarget: string;
  // Full service target — `gui/<uid>/<label>`.
  serviceTarget: string;
}

export interface LifecycleOptions {
  launchctlExec?: LaunchctlExec;
  healthClient?: RelayClient;
  paths?: Partial<LifecyclePaths>;
}

export interface LifecycleResult {
  status: 'installed' | 'already-installed' | 'uninstalled' | 'not-installed';
  plistPath: string;
  label: string;
  detail?: string;
}

// ---- defaults -----------------------------------------------------------

export const DEFAULT_LABEL = 'com.fyang0507.relay';

// Resolve the relay repo root from this module's own file URL. Works the
// same way in `src/` and in `dist/commands/`: both live two directories
// below the repo root (src/commands/lifecycle.ts and
// dist/commands/lifecycle.js).
function resolveRepoRoot(): string {
  const here = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(here), '..', '..');
}

// Build a concrete LifecyclePaths. Everything is resolved at call time so
// test overrides can replace individual fields.
export function resolvePaths(overrides?: Partial<LifecyclePaths>): LifecyclePaths {
  const label = overrides?.label ?? DEFAULT_LABEL;
  const home = os.homedir();
  const uid = os.userInfo().uid;
  const repoRoot = overrides?.workingDirectory ?? resolveRepoRoot();
  const relayDir = overrides?.relayDir ?? path.join(home, '.relay');
  const launchAgentsDir =
    overrides?.launchAgentsDir ?? path.join(home, 'Library', 'LaunchAgents');

  const defaults: LifecyclePaths = {
    label,
    plistPath:
      overrides?.plistPath ?? path.join(launchAgentsDir, `${label}.plist`),
    nodeBinary: overrides?.nodeBinary ?? process.execPath,
    daemonScript:
      overrides?.daemonScript ?? path.join(repoRoot, 'dist', 'daemon.js'),
    workingDirectory: repoRoot,
    stdoutLog: overrides?.stdoutLog ?? path.join(relayDir, 'daemon.out.log'),
    stderrLog: overrides?.stderrLog ?? path.join(relayDir, 'daemon.err.log'),
    relayDir,
    launchAgentsDir,
    socketPath: overrides?.socketPath ?? path.join(relayDir, 'sock'),
    domainTarget: overrides?.domainTarget ?? `gui/${uid}`,
    serviceTarget: overrides?.serviceTarget ?? `gui/${uid}/${label}`,
  };
  return defaults;
}

// ---- default launchctl runner ------------------------------------------

// Invoke `launchctl` via execFile. We deliberately don't throw on non-zero
// exit — several call sites (print, bootout) tolerate certain errors as
// "nothing to do" and need the raw status.
const defaultLaunchctlExec: LaunchctlExec = (args) =>
  new Promise((resolve) => {
    execFile('launchctl', args, (err, stdout, stderr) => {
      if (err) {
        const e = err as NodeJS.ErrnoException & { code?: number | string };
        // execFile surfaces the process exit code in `err.code` when the
        // child exited non-zero. Normalize to a number; fall back to 1 when
        // the process failed for some other reason (e.g. ENOENT on the
        // launchctl binary itself).
        const code = typeof e.code === 'number' ? e.code : 1;
        resolve({ stdout: stdout ?? '', stderr: stderr ?? '', code });
        return;
      }
      resolve({ stdout: stdout ?? '', stderr: stderr ?? '', code: 0 });
    });
  });

// ---- helpers -----------------------------------------------------------

async function fileExists(p: string): Promise<boolean> {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

async function readIfExists(p: string): Promise<string | null> {
  try {
    return await fsp.readFile(p, 'utf8');
  } catch {
    return null;
  }
}

function renderPlist(paths: LifecyclePaths): string {
  return buildPlist({
    label: paths.label,
    daemonPath: paths.nodeBinary,
    args: [paths.daemonScript],
    workingDirectory: paths.workingDirectory,
    stdoutLog: paths.stdoutLog,
    stderrLog: paths.stderrLog,
  });
}

// `launchctl print <service-target>` exits 0 when the service is loaded and
// non-zero otherwise. We only care about the exit code.
async function isLoaded(
  exec: LaunchctlExec,
  paths: LifecyclePaths,
): Promise<boolean> {
  const res = await exec(['print', paths.serviceTarget]);
  return res.code === 0;
}

// Poll the daemon's health endpoint until it succeeds or we run out of
// tries. Used after `launchctl bootstrap` to surface "daemon failed to
// come up" instead of the vague "bootstrap returned 0 but nothing's
// listening".
async function waitForHealth(
  client: RelayClient,
  deadlineMs: number,
  intervalMs: number,
): Promise<boolean> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    try {
      await client.health();
      return true;
    } catch (err) {
      // DaemonNotRunningError is the expected transient — keep polling.
      // Anything else we also retry on, since the socket may not yet be
      // chmod'd or the daemon may still be loading state.
      if (!(err instanceof DaemonNotRunningError)) {
        // Non-ENOENT error — still worth another try until the deadline.
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
  return false;
}

// ---- public API ---------------------------------------------------------

export async function isInstalled(opts: LifecycleOptions = {}): Promise<boolean> {
  const paths = resolvePaths(opts.paths);
  const exec = opts.launchctlExec ?? defaultLaunchctlExec;
  const [loaded, hasPlist] = await Promise.all([
    isLoaded(exec, paths),
    fileExists(paths.plistPath),
  ]);
  return loaded && hasPlist;
}

export async function install(opts: LifecycleOptions = {}): Promise<LifecycleResult> {
  const paths = resolvePaths(opts.paths);
  const exec = opts.launchctlExec ?? defaultLaunchctlExec;

  // 1. Verify the compiled daemon is on disk. Without it, launchd would
  //    happily bootstrap a service that immediately exits, and the user
  //    would have no idea why. Fail fast with a clear message instead.
  if (!(await fileExists(paths.daemonScript))) {
    throw new Error(
      `relay install: daemon script not found at ${paths.daemonScript} — ` +
        'run `npm run build` first',
    );
  }

  // 2. Make sure the log dir and LaunchAgents dir exist before launchd
  //    tries to redirect stdout/stderr or read the plist.
  await fsp.mkdir(paths.relayDir, { recursive: true });
  await fsp.mkdir(paths.launchAgentsDir, { recursive: true });

  const desiredPlist = renderPlist(paths);
  const loaded = await isLoaded(exec, paths);
  const existingPlist = await readIfExists(paths.plistPath);

  // 3. Fast path: already loaded AND the on-disk plist matches what we
  //    would have written. Nothing to do.
  if (loaded && existingPlist === desiredPlist) {
    return {
      status: 'already-installed',
      plistPath: paths.plistPath,
      label: paths.label,
      detail: `daemon already running (${paths.socketPath})`,
    };
  }

  // 4. Upgrade path: loaded but plist content differs (or missing). Bootout
  //    first so the next `bootstrap` picks up the new definition.
  if (loaded) {
    const boRes = await exec(['bootout', paths.serviceTarget]);
    // Tolerate "no such process" — the service may have died between our
    // check and the bootout.
    if (boRes.code !== 0 && !/No such process/i.test(boRes.stderr)) {
      throw new Error(
        `relay install: launchctl bootout failed (exit ${boRes.code}): ${boRes.stderr.trim()}`,
      );
    }
  }

  // 5. Write (or overwrite) the plist. mode 0o644 so launchd can read it
  //    and `cat` shows it to the user when debugging.
  await fsp.writeFile(paths.plistPath, desiredPlist, { mode: 0o644 });

  // 6. Hand off to launchd. `bootstrap <domain> <plist-path>` is the
  //    modern replacement for `load -w <plist-path>`.
  const bsRes = await exec(['bootstrap', paths.domainTarget, paths.plistPath]);
  if (bsRes.code !== 0) {
    throw new Error(
      `relay install: launchctl bootstrap failed (exit ${bsRes.code}): ${bsRes.stderr.trim()}`,
    );
  }

  // 7. Confirm the daemon actually came up. `bootstrap` returning 0 only
  //    means launchd accepted the job, not that the process is healthy.
  const client =
    opts.healthClient ?? new RelayClient(paths.socketPath, { timeoutMs: 1_000 });
  const healthy = await waitForHealth(client, 5_000, 200);
  if (!healthy) {
    // Try to surface whatever launchd knows about the failure before we
    // tear the job down.
    let diagnostic = '';
    try {
      const pr = await exec(['print', paths.serviceTarget]);
      diagnostic = pr.stdout.trim() || pr.stderr.trim();
    } catch {
      /* ignore */
    }
    try {
      await exec(['bootout', paths.serviceTarget]);
    } catch {
      /* ignore */
    }
    const tail = diagnostic ? `\nlaunchctl print output:\n${diagnostic}` : '';
    throw new Error(
      `relay install: daemon did not respond on ${paths.socketPath} within 5s` +
        tail,
    );
  }

  return {
    status: 'installed',
    plistPath: paths.plistPath,
    label: paths.label,
    detail: `daemon up at ${paths.socketPath}`,
  };
}

export async function uninstall(opts: LifecycleOptions = {}): Promise<LifecycleResult> {
  const paths = resolvePaths(opts.paths);
  const exec = opts.launchctlExec ?? defaultLaunchctlExec;

  const loaded = await isLoaded(exec, paths);
  const plistExists = await fileExists(paths.plistPath);

  if (!loaded && !plistExists) {
    return {
      status: 'not-installed',
      plistPath: paths.plistPath,
      label: paths.label,
      detail: 'nothing to remove',
    };
  }

  if (loaded) {
    const boRes = await exec(['bootout', paths.serviceTarget]);
    if (boRes.code !== 0 && !/No such process/i.test(boRes.stderr)) {
      throw new Error(
        `relay uninstall: launchctl bootout failed (exit ${boRes.code}): ${boRes.stderr.trim()}`,
      );
    }
  }

  if (plistExists) {
    try {
      await fsp.unlink(paths.plistPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }

  // Intentional: we leave ~/.relay/ (state.json, logs) alone. Users who
  // want a truly clean slate can `rm -rf ~/.relay` themselves.

  return {
    status: 'uninstalled',
    plistPath: paths.plistPath,
    label: paths.label,
    detail: 'plist removed; ~/.relay/ preserved',
  };
}
