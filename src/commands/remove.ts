// `relay remove --id <id> [--dry-run]` — unregister one relay.
//
// Dry-run reports what would happen without mutating state; real run
// reports what just happened. `not_found` is the one error code we
// recognize specifically — users often typo ids, so the fix-suggestion is
// worth the extra branch.

import os from 'node:os';
import path from 'node:path';

import { RelayClient, DaemonNotRunningError } from '../client.ts';
import type { RemoveResult } from '../client.ts';
import { printKv } from './output.ts';
import { CliError, daemonNotRunningLines } from './errors.ts';

export interface RemoveCommandOpts {
  id: string;
  dryRun?: boolean;
  client?: RelayClient;
  socketPath?: string;
}

function defaultSocketPath(): string {
  return (
    process.env.RELAY_SOCKET_PATH ?? path.join(os.homedir(), '.relay', 'sock')
  );
}

export async function runRemove(opts: RemoveCommandOpts): Promise<void> {
  const socketPath = opts.socketPath ?? defaultSocketPath();
  const client = opts.client ?? new RelayClient(socketPath);

  let result: RemoveResult;
  try {
    result = await client.remove({ id: opts.id, dryRun: opts.dryRun });
  } catch (err) {
    if (err instanceof DaemonNotRunningError) {
      throw new CliError(daemonNotRunningLines(socketPath), 1);
    }
    const maybeCoded = err as Error & { code?: string };
    if (maybeCoded.code === 'not_found') {
      throw new CliError(
        [
          `Error: no relay with id ${opts.id}. Run 'relay list' to see current ids.`,
        ],
        1,
      );
    }
    throw new CliError(
      [`Error: relay remove failed — ${(err as Error).message}`],
      1,
    );
  }

  if ('dryRun' in result && result.dryRun === true) {
    const w = result.wouldRemove;
    printKv([['dry_run', 'true']]);
    process.stdout.write('would_remove:\n');
    printKv([
      ['  id', w.id],
      ['  name', w.sourceName],
      ['  config', w.configPath],
      ['  files_tracked', String(w.filesTracked)],
    ]);
    return;
  }

  const real = result as Extract<RemoveResult, { removed: unknown }>;
  const r = real.removed;
  process.stdout.write('removed:\n');
  printKv([
    ['  id', r.id],
    ['  name', r.sourceName],
    ['  config', r.configPath],
  ]);
}
