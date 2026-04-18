#!/usr/bin/env node
// relay CLI entrypoint.
//
// Routing layer only: each subcommand lives in ./commands/<cmd>.ts and
// does the real work. This file wires commander → per-command function,
// translates thrown CliError into (stderr lines, exit code), and falls
// back to exit 1 for any other uncaught error.
//
// Conventions (see relay.md + the P4 spec):
//   - Every subcommand has `--help` with real example invocations.
//   - Output goes through ./commands/output.ts (kv format, no colors).
//   - Errors throw `CliError` instead of calling process.exit — this
//     module is the single place that touches exit codes, so tests can
//     import command functions directly.
//   - The `RELAY_SOCKET_PATH` env var propagates through each command's
//     `socketPath` default so manual smoke runs can isolate.

import { Command } from 'commander';

import { CliError } from './commands/errors.ts';
import { printError } from './commands/output.ts';
import { runInit } from './commands/init.ts';
import { runShutdown } from './commands/shutdown.ts';
import { runHealth } from './commands/health.ts';
import { runList } from './commands/list.ts';
import { runAdd } from './commands/add.ts';
import { runRemove } from './commands/remove.ts';

// Translate any error into (exit code, stderr lines). CliError carries
// both; everything else becomes a generic exit-1 with a single line.
function handleError(err: unknown): never {
  if (err instanceof CliError) {
    printError(err.lines);
    process.exit(err.exitCode);
  }
  const message = err instanceof Error ? err.message : String(err);
  printError([`Error: ${message}`]);
  process.exit(1);
}

// Wrap an async command so thrown errors always route through handleError.
// `program.action(fn)` doesn't handle rejected promises the way we want —
// it surfaces them through `program.parseAsync` with a vague stack trace.
// Commander passes the command's parsed options as the first argument.
function wrap<T>(fn: (opts: T) => Promise<void>): (opts: T) => Promise<void> {
  return async (opts: T) => {
    try {
      await fn(opts);
    } catch (err) {
      handleError(err);
    }
  };
}

function buildProgram(): Command {
  const program = new Command();
  program
    .name('relay')
    .description(
      [
        'Agent-to-human observability relay.',
        '',
        'Common usage:',
        '  relay init                            # install + start the daemon',
        '  relay add --config ./relay.config.yaml',
        '  relay list                            # see what is registered',
        '  relay health                          # is the daemon alive?',
        '',
        'See `relay <cmd> --help` for per-command flags and examples.',
      ].join('\n'),
    )
    .version('1.1.0');

  // ---- init -------------------------------------------------------------
  program
    .command('init')
    .description('Install the launchd plist and start the relay daemon.')
    .addHelpText(
      'after',
      [
        '',
        'Examples:',
        '  # install once per machine',
        '  relay init',
      ].join('\n'),
    )
    .action(wrap<Record<string, never>>(async () => {
      await runInit();
    }));

  // ---- shutdown ---------------------------------------------------------
  program
    .command('shutdown')
    .description('Stop the relay daemon and remove the launchd plist.')
    .addHelpText(
      'after',
      [
        '',
        'Examples:',
        '  # uninstall; ~/.relay/ state is preserved',
        '  relay shutdown',
      ].join('\n'),
    )
    .action(wrap<Record<string, never>>(async () => {
      await runShutdown();
    }));

  // ---- health -----------------------------------------------------------
  program
    .command('health')
    .description('Probe the running daemon for liveness + version.')
    .addHelpText(
      'after',
      [
        '',
        'Examples:',
        '  relay health',
        '  RELAY_SOCKET_PATH=/tmp/relay.sock relay health',
      ].join('\n'),
    )
    .action(wrap<Record<string, never>>(async () => {
      await runHealth({ socketPath: process.env.RELAY_SOCKET_PATH });
    }));

  // ---- list -------------------------------------------------------------
  program
    .command('list')
    .description('Show every source registered with the running daemon.')
    .addHelpText(
      'after',
      [
        '',
        'Examples:',
        '  relay list',
      ].join('\n'),
    )
    .action(wrap<Record<string, never>>(async () => {
      await runList({ socketPath: process.env.RELAY_SOCKET_PATH });
    }));

  // ---- add --------------------------------------------------------------
  program
    .command('add')
    .description('Register all sources declared in a relay config file.')
    .requiredOption('--config <path>', 'Path to the relay config file (required).')
    .option('--dry-run', 'Validate and report what would be added without committing.', false)
    .addHelpText(
      'after',
      [
        '',
        'Examples:',
        '  relay add --config ./outreach/relay.config.yaml',
        '  relay add --config /abs/path/to/relay.config.yaml --dry-run',
      ].join('\n'),
    )
    .action(wrap<{ config: string; dryRun: boolean }>(async (opts) => {
      await runAdd({
        configPath: opts.config,
        dryRun: opts.dryRun,
        socketPath: process.env.RELAY_SOCKET_PATH,
      });
    }));

  // ---- remove -----------------------------------------------------------
  program
    .command('remove')
    .description('Unregister one relay by id.')
    .requiredOption('--id <id>', 'Relay id to remove (required). See `relay list`.')
    .option('--dry-run', 'Report what would be removed without committing.', false)
    .addHelpText(
      'after',
      [
        '',
        'Examples:',
        '  relay remove --id rl_a3f1b2',
        '  relay remove --id rl_a3f1b2 --dry-run',
      ].join('\n'),
    )
    .action(wrap<{ id: string; dryRun: boolean }>(async (opts) => {
      await runRemove({
        id: opts.id,
        dryRun: opts.dryRun,
        socketPath: process.env.RELAY_SOCKET_PATH,
      });
    }));

  return program;
}

async function main(): Promise<void> {
  const program = buildProgram();
  try {
    await program.parseAsync(process.argv);
  } catch (err) {
    handleError(err);
  }
}

void main();
