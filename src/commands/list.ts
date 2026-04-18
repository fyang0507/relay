// `relay list` — render all registered sources as kv blocks.
//
// One block per source, blank line separating. Empty registry prints a
// single hint line and exits 0 — empty is a valid state, not an error.
// Fields are a flat projection of `ListedSource` from runtime.ts.

import os from 'node:os';
import path from 'node:path';

import { RelayClient, DaemonNotRunningError, type ListedSource } from '../client.ts';
import { printList } from './output.ts';
import { CliError, daemonNotRunningLines } from './errors.ts';

export interface ListCommandOpts {
  client?: RelayClient;
  socketPath?: string;
}

function defaultSocketPath(): string {
  return (
    process.env.RELAY_SOCKET_PATH ?? path.join(os.homedir(), '.relay', 'sock')
  );
}

function sourceToKv(s: ListedSource): Array<[string, string]> {
  const kv: Array<[string, string]> = [
    ['id', s.id],
    ['name', s.sourceName],
    ['config', s.configPath],
    ['provider', s.provider],
  ];
  if (s.groupId !== undefined) kv.push(['group_id', String(s.groupId)]);
  const filesTracked =
    s.filesDisabled > 0
      ? `${s.filesTracked}  (${s.filesDisabled} disabled)`
      : String(s.filesTracked);
  kv.push(['files_tracked', filesTracked]);
  kv.push(['disabled', s.disabled ? 'yes' : 'no']);
  return kv;
}

export async function runList(opts: ListCommandOpts = {}): Promise<void> {
  const socketPath = opts.socketPath ?? defaultSocketPath();
  const client = opts.client ?? new RelayClient(socketPath);

  let sources: ListedSource[];
  try {
    sources = await client.list();
  } catch (err) {
    if (err instanceof DaemonNotRunningError) {
      throw new CliError(daemonNotRunningLines(socketPath), 1);
    }
    throw new CliError(
      [`Error: relay list failed — ${(err as Error).message}`],
      1,
    );
  }

  if (sources.length === 0) {
    process.stdout.write(
      '(no sources mapped — register one with `relay add --config <path>`)\n',
    );
    return;
  }

  const blocks = sources.map(sourceToKv);
  printList(`sources (${sources.length}):`, blocks);
}
