#!/usr/bin/env node
// Relay daemon entry point. See relay.md §Architecture (Phase 1b). Invoked
// as `node dist/daemon.js` during development; in P3 launchd will wrap this
// with a plist so the process survives login/logout.
//
// Startup order mirrors the runtime's composition: load state + credentials
// off disk, build the provider map, wire watcher + dispatcher, then start
// the socket server. Shutdown is the reverse: close the socket first (so no
// new RPC lands while we're tearing down), then relay.stop() which flushes
// state.
//
// Logging: plain stdout/stderr. launchd's plist (P3) captures both to a log
// file. We deliberately do NOT depend on a logger library here — the whole
// daemon boots and tears down in a handful of lines.

import os from 'node:os';
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { RelayState } from './state.ts';
import { RelayWatcher } from './watch.ts';
import { RelayDispatcher } from './dispatch.ts';
import { Relay, buildResolveSource } from './runtime.ts';
import { buildProviders } from './commands/providers.ts';
import { loadCredentials } from './credentials.ts';
import { SocketServer } from './socket.ts';

// Resolve the relay repo's package.json at runtime so the `version` field in
// `health` responses stays in sync with the package. Same trick as
// src/credentials.ts: anchor on `import.meta.url` rather than process.cwd()
// since launchd won't preserve cwd. Works identically for `dist/daemon.js`
// and `src/daemon.ts` — both live one level below the repo root.
async function readPackageVersion(): Promise<string> {
  const here = fileURLToPath(import.meta.url);
  const repoRoot = path.resolve(path.dirname(here), '..');
  const pkgPath = path.join(repoRoot, 'package.json');
  try {
    const raw = await fsp.readFile(pkgPath, 'utf8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    if (typeof parsed.version === 'string') return parsed.version;
  } catch {
    // Fall through — non-fatal.
  }
  return '0.0.0';
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  const version = await readPackageVersion();

  // Socket path. `~/.relay/sock` by default; overridable via env for tests
  // and the manual smoke run in the P1b report.
  const socketPath =
    process.env.RELAY_SOCKET_PATH ??
    path.join(os.homedir(), '.relay', 'sock');

  // Compose the runtime. Mirrors what the old static-config `start` did,
  // minus the `config.sources` loop — sources now arrive via addSource()
  // RPCs (or get replayed from the persisted registry inside relay.start()).
  const state = await RelayState.load();
  const credentials = loadCredentials();
  const providers = buildProviders(state, credentials);
  const watcher = new RelayWatcher();
  const dispatcher = new RelayDispatcher({
    state,
    providers,
    watcher,
    resolveSource: buildResolveSource(state),
  });
  const relay = new Relay({ state, providers, watcher, dispatcher });

  await relay.start();

  const socketServer = new SocketServer({
    socketPath,
    relay,
    state,
    startedAt,
    version,
  });
  await socketServer.start();

  console.log(`relay daemon up on ${socketPath} (v${version})`);

  // Graceful shutdown. Close the socket first so in-flight/new RPC traffic
  // stops before we tear down the rest. We keep a single-shot guard because
  // SIGTERM followed by SIGINT (e.g. from a supervisor) should not double-stop.
  let shuttingDown = false;
  const shutdown = async (sig: string, exitCode: number) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.warn(`[daemon] received ${sig}; shutting down`);
    try {
      await socketServer.stop();
      await relay.stop();
      process.exit(exitCode);
    } catch (err) {
      console.error(
        `[daemon] error during shutdown: ${(err as Error).message}`,
      );
      process.exit(1);
    }
  };
  process.once('SIGINT', () => {
    void shutdown('SIGINT', 0);
  });
  process.once('SIGTERM', () => {
    void shutdown('SIGTERM', 0);
  });
  process.on('uncaughtException', (err) => {
    console.error(`[daemon] uncaughtException: ${err.stack ?? err.message}`);
    void shutdown('uncaughtException', 1);
  });
  process.on('unhandledRejection', (reason) => {
    console.error(
      `[daemon] unhandledRejection: ${
        reason instanceof Error ? reason.stack ?? reason.message : String(reason)
      }`,
    );
    void shutdown('unhandledRejection', 1);
  });
}

main().catch((err: Error) => {
  console.error(`relay daemon failed to start: ${err.stack ?? err.message}`);
  process.exit(1);
});
