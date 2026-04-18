// `relay add --config <path> [--dry-run]` — register every source declared
// in a config file.
//
// Config-path handling: cwd-relative paths are natural for humans typing at
// a terminal, but the daemon never shares the caller's cwd (launchd wipes
// it). We resolve against `process.cwd()` here so the absolute path is
// what travels over the socket. The final absolute path is also echoed in
// the output so the user can see exactly what was registered.
//
// Output: mostly kv, but `would_add` / `added` / `existing` / `warnings`
// are small lists rendered as indented `- key: value` blocks. Empty
// `warnings` collapse to `warnings: (none)` to preserve a consistent
// bottom line in scripts that grep for it.

import path from 'node:path';
import os from 'node:os';

import { RelayClient, DaemonNotRunningError } from '../client.ts';
import type { AddResult } from '../client.ts';
import { printKv } from './output.ts';
import { CliError, daemonNotRunningLines } from './errors.ts';

export interface AddCommandOpts {
  configPath: string;
  dryRun?: boolean;
  client?: RelayClient;
  socketPath?: string;
  // Overridable for tests. Defaults to process.cwd() when resolving a
  // relative configPath.
  cwd?: string;
}

function defaultSocketPath(): string {
  return (
    process.env.RELAY_SOCKET_PATH ?? path.join(os.homedir(), '.relay', 'sock')
  );
}

// Pretty-print an indented list. We render manually instead of going
// through printList because each item is a single leading-dash line plus
// zero or more continuation lines ("  key: value") — printList is only a
// good fit for uniform kv blocks.
function renderYamlishList(
  label: string,
  items: Array<Array<[string, string]>>,
): string[] {
  if (items.length === 0) return [`${label}: (none)`];
  const lines: string[] = [`${label}:`];
  for (const item of items) {
    const [first, ...rest] = item;
    if (!first) continue;
    lines.push(`  - ${first[0]}: ${first[1]}`);
    for (const [k, v] of rest) {
      lines.push(`    ${k}: ${v}`);
    }
  }
  return lines;
}

function renderWarnings(warnings: string[]): string[] {
  if (warnings.length === 0) return ['warnings: (none)'];
  const lines = ['warnings:'];
  for (const w of warnings) lines.push(`  - ${w}`);
  return lines;
}

export async function runAdd(opts: AddCommandOpts): Promise<void> {
  const cwd = opts.cwd ?? process.cwd();
  const absoluteConfig = path.isAbsolute(opts.configPath)
    ? opts.configPath
    : path.resolve(cwd, opts.configPath);

  const socketPath = opts.socketPath ?? defaultSocketPath();
  const client = opts.client ?? new RelayClient(socketPath);

  let result: AddResult;
  try {
    result = await client.add({
      configPath: absoluteConfig,
      dryRun: opts.dryRun,
    });
  } catch (err) {
    if (err instanceof DaemonNotRunningError) {
      throw new CliError(daemonNotRunningLines(socketPath), 1);
    }
    const maybeCoded = err as Error & { code?: string };
    if (maybeCoded.code === 'config_invalid') {
      throw new CliError(
        [
          'Error: config validation failed.',
          `  File: ${absoluteConfig}`,
          `  Reason: ${maybeCoded.message}`,
        ],
        2,
      );
    }
    throw new CliError(
      [`Error: relay add failed — ${(err as Error).message}`],
      1,
    );
  }

  // Dry-run branch. We cast through `unknown` to pick the right variant —
  // the AddResult union discriminates on `dryRun`, but TypeScript's
  // `in`-narrowing doesn't tighten the fall-through branch when the
  // property is also absent from the other variant.
  if ('dryRun' in result && result.dryRun === true) {
    const dry = result;
    printKv([
      ['dry_run', 'true'],
      ['config', absoluteConfig],
    ]);
    const wouldAddBlocks = dry.wouldAdd.map((e) => {
      const kv: Array<[string, string]> = [
        ['name', e.name],
        ['provider', e.provider],
      ];
      if (e.groupId !== undefined) kv.push(['group_id', String(e.groupId)]);
      kv.push(['path_glob', e.pathGlob]);
      return kv;
    });
    process.stdout.write(
      renderYamlishList('would_add', wouldAddBlocks).join('\n') + '\n',
    );
    // Warnings block is omitted entirely when empty in dry-run, per spec.
    if (dry.warnings.length > 0) {
      process.stdout.write(renderWarnings(dry.warnings).join('\n') + '\n');
    }
    return;
  }

  // Real-run branch. Narrow by exclusion: anything not dry-run is the
  // real-run variant.
  const real = result as Extract<AddResult, { added: unknown }>;
  printKv([['config', absoluteConfig]]);
  const addedBlocks = real.added.map((e): Array<[string, string]> => [
    ['id', e.id],
    ['name', e.name],
  ]);
  process.stdout.write(renderYamlishList('added', addedBlocks).join('\n') + '\n');
  if (real.existing.length > 0) {
    const existingBlocks = real.existing.map((e): Array<[string, string]> => [
      ['id', e.id],
      ['name', e.name],
    ]);
    process.stdout.write(
      renderYamlishList('existing', existingBlocks).join('\n') + '\n',
    );
  }
  process.stdout.write(renderWarnings(real.warnings).join('\n') + '\n');
}
