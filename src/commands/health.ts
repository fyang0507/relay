// `relay health` — probe the daemon's liveness via the socket RPC.
//
// Reports version, number of registered sources, uptime, and the socket
// path. The socket path is surfaced so users who've overridden it (via
// RELAY_SOCKET_PATH, or a non-default install) can confirm which daemon
// just answered.

import os from 'node:os';
import path from 'node:path';

import { RelayClient, DaemonNotRunningError, type HealthResult } from '../client.ts';
import { printKv } from './output.ts';
import { CliError, daemonNotRunningLines } from './errors.ts';

export interface HealthCommandOpts {
  client?: RelayClient;
  // Explicit override so the rendered `socket:` line matches the client we
  // actually spoke to. When `client` is supplied, callers should pass the
  // socketPath it was constructed with; otherwise we fall back to the same
  // default as RelayClient (~/.relay/sock, possibly overridden by
  // RELAY_SOCKET_PATH).
  socketPath?: string;
}

function defaultSocketPath(): string {
  return (
    process.env.RELAY_SOCKET_PATH ?? path.join(os.homedir(), '.relay', 'sock')
  );
}

export async function runHealth(opts: HealthCommandOpts = {}): Promise<void> {
  const socketPath = opts.socketPath ?? defaultSocketPath();
  const client = opts.client ?? new RelayClient(socketPath);

  let result: HealthResult;
  try {
    result = await client.health();
  } catch (err) {
    if (err instanceof DaemonNotRunningError) {
      throw new CliError(daemonNotRunningLines(socketPath), 1);
    }
    throw new CliError(
      [`Error: relay health failed — ${(err as Error).message}`],
      1,
    );
  }

  printKv([
    ['status', 'ok'],
    ['version', result.version],
    ['sources_tracked', String(result.sourcesTracked)],
    ['uptime_seconds', String(result.uptimeSeconds)],
    ['socket', socketPath],
  ]);
}
