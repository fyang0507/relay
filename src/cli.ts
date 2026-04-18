#!/usr/bin/env node
// relay CLI entrypoint. See relay.md §Implementation phases — Phase 3.
//
// Commands (all accept `--config <path>`):
//   relay init    — validate config + probe each provider + count source files
//   relay start   — run the daemon (foreground)
//   relay status  — dump mapped sources + offsets from state.json
//   relay health  — deeper check than init; verify state writable, probe
//                   providers, warn on zero-file sources
//
// The module only wires CLI → existing building blocks (config loader, state
// store, watcher, dispatcher, runtime, providers). Behavior belongs in those
// modules, not here.

import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Command } from 'commander';

import { loadConfig } from './config.ts';
import { RelayState } from './state.ts';
import { RelayWatcher } from './watch.ts';
import { RelayDispatcher } from './dispatch.ts';
import { Relay, installSignalHandlers } from './runtime.ts';
import { buildProviders } from './commands/providers.ts';
import type { TelegramProvider } from './providers/telegram.ts';
import type { Provider } from './providers/types.ts';
import type { TelegramProviderConfig } from './types.ts';

const DEFAULT_CONFIG_PATH = '~/.relay/config.yaml';

// ---- path helpers ----------------------------------------------------------

function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

// Split a glob into (baseDir, pattern). Mirrors the logic in watch.ts so
// `init`/`health` count the same files the watcher would discover. Kept
// local rather than exported from watch.ts because it's a tiny pure helper
// and coupling CLI glob counting to watcher internals would be needless.
function splitGlob(glob: string): { baseDir: string; pattern: string } {
  const expanded = expandHome(glob);
  const parts = expanded.split(path.sep);
  const baseParts: string[] = [];
  let i = 0;
  for (; i < parts.length; i++) {
    if (/[*?[\]{}]/.test(parts[i])) break;
    baseParts.push(parts[i]);
  }
  const baseDir = baseParts.join(path.sep) || path.sep;
  const pattern = parts.slice(i).join(path.sep);
  return { baseDir, pattern };
}

function globToRegex(pattern: string): RegExp {
  if (pattern === '') return /^.*$/;
  const sep = path.sep === '\\' ? '\\\\' : path.sep;
  const sepClass = `[^${sep}]`;
  let re = '^';
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === '*' && pattern[i + 1] === '*') {
      re += '.*';
      i += 2;
      if (pattern[i] === path.sep) i++;
    } else if (c === '*') {
      re += `${sepClass}*`;
      i++;
    } else if (c === '?') {
      re += sepClass;
      i++;
    } else if ('.+^$(){}|\\/'.includes(c)) {
      re += '\\' + c;
      i++;
    } else {
      re += c;
      i++;
    }
  }
  re += '$';
  return new RegExp(re);
}

// Walk baseDir recursively, returning files whose path-relative-to-baseDir
// matches pattern. Returns [] if baseDir doesn't exist.
async function resolveGlob(glob: string): Promise<string[]> {
  const { baseDir, pattern } = splitGlob(glob);
  const regex = globToRegex(pattern);
  const out: string[] = [];
  const recursive = pattern.includes('**');

  async function walk(dir: string, depth: number): Promise<void> {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // If pattern doesn't include **, limit depth to pattern segment count.
        const maxDepth = pattern.split(path.sep).length - 1;
        if (recursive || depth < maxDepth) {
          await walk(full, depth + 1);
        }
      } else if (entry.isFile()) {
        const rel = path.relative(baseDir, full);
        if (regex.test(rel)) out.push(full);
      }
    }
  }
  await walk(baseDir, 0);
  return out;
}

// ---- shared state dir ------------------------------------------------------

function stateDir(): string {
  return path.join(os.homedir(), '.relay');
}

function stateFilePath(): string {
  return path.join(stateDir(), 'state.json');
}

// ---- telegram helpers (only used for probes) -------------------------------

// The Telegram provider class doesn't expose health probes on the Provider
// interface — by design, the interface stays platform-neutral. For
// `relay init` / `relay health` we need to reach into the Bot API directly.
// We keep those calls here (CLI-only) rather than growing the Provider
// surface.
async function telegramGetMe(botToken: string): Promise<{ username?: string }> {
  const url = `https://api.telegram.org/bot${botToken}/getMe`;
  const res = await fetch(url, { method: 'POST' });
  const json = (await res.json()) as {
    ok: boolean;
    result?: { username?: string };
    description?: string;
    error_code?: number;
  };
  if (!json.ok) {
    throw new Error(
      `telegram getMe failed: ${json.error_code ?? '?'} ${json.description ?? 'no description'}`,
    );
  }
  return json.result ?? {};
}

async function telegramGetChat(
  botToken: string,
  chatId: number,
): Promise<void> {
  const url = `https://api.telegram.org/bot${botToken}/getChat`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId }),
  });
  const json = (await res.json()) as {
    ok: boolean;
    description?: string;
    error_code?: number;
  };
  if (!json.ok) {
    throw new Error(
      `telegram getChat(${chatId}) failed: ${json.error_code ?? '?'} ${json.description ?? 'no description'}`,
    );
  }
}

// ---- commands --------------------------------------------------------------

interface GlobalOpts {
  config: string;
}

async function cmdInit(opts: GlobalOpts): Promise<number> {
  let failed = false;

  // Load config.
  let loaded;
  try {
    loaded = await loadConfig(opts.config);
  } catch (err) {
    process.stderr.write(`[init] failed to load config: ${(err as Error).message}\n`);
    return 1;
  }
  for (const w of loaded.warnings) {
    process.stderr.write(`[init] warning: ${w}\n`);
  }

  // Probe each provider.
  if (loaded.config.providers.telegram) {
    const tg: TelegramProviderConfig = loaded.config.providers.telegram;
    try {
      const me = await telegramGetMe(tg.botToken);
      process.stdout.write(`telegram: ready (bot username: ${me.username ?? '<unknown>'})\n`);
    } catch (err) {
      process.stderr.write(`telegram: FAIL — ${(err as Error).message}\n`);
      failed = true;
    }
  }
  // Stdout provider is always available.
  process.stdout.write(`stdout: ready\n`);

  // Source globs.
  for (const src of loaded.config.sources) {
    try {
      const files = await resolveGlob(src.pathGlob);
      process.stdout.write(`source ${src.name}: ${files.length} file(s) match ${src.pathGlob}\n`);
      if (files.length === 0) {
        process.stderr.write(`[init] warning: source "${src.name}" glob matched zero files\n`);
      }
    } catch (err) {
      process.stderr.write(`source ${src.name}: FAIL — ${(err as Error).message}\n`);
      failed = true;
    }
  }

  return failed ? 1 : 0;
}

interface StartOpts extends GlobalOpts {
  backfill?: boolean;
}

async function cmdStart(opts: StartOpts): Promise<number> {
  let loaded;
  try {
    loaded = await loadConfig(opts.config);
  } catch (err) {
    process.stderr.write(`[start] failed to load config: ${(err as Error).message}\n`);
    return 1;
  }
  for (const w of loaded.warnings) {
    process.stderr.write(`[start] warning: ${w}\n`);
  }

  const state = await RelayState.load();
  const providers = buildProviders(loaded.config, state);
  const watcher = new RelayWatcher(loaded.config.sources);
  const dispatcher = new RelayDispatcher({
    sources: loaded.config.sources,
    state,
    providers,
    watcher,
  });
  const relay = new Relay({
    config: loaded.config,
    state,
    providers,
    watcher,
    dispatcher,
    options: { backfill: opts.backfill === true },
  });

  await relay.start();
  // Per runtime.ts: installSignalHandlers AFTER start resolves so stray early
  // SIGINT can't race with a half-initialized daemon.
  installSignalHandlers(relay);
  process.stdout.write(
    `relay started: ${loaded.config.sources.length} source(s) tracked\n`,
  );

  // Block forever — watcher + inbound loops keep the event loop alive.
  return await new Promise<number>(() => {
    // Never resolves; process exits via signal handlers.
  });
}

async function cmdStatus(_opts: GlobalOpts): Promise<number> {
  const state = await RelayState.load();
  const snap = state._snapshot();
  const entries = Object.entries(snap.sources);
  if (entries.length === 0) {
    process.stdout.write('no sources tracked\n');
    return 0;
  }

  // Column-align: find max widths.
  const rows = entries.map(([filePath, s]) => ({
    filePath,
    sourceName: s.sourceName,
    destinationKey: s.destinationKey,
    offset: s.offset,
    disabled: s.disabled ? 'Y' : 'N',
    reason: s.disabledReason ?? '',
  }));
  const widths = {
    filePath: Math.max(...rows.map((r) => r.filePath.length), 4),
    sourceName: Math.max(...rows.map((r) => r.sourceName.length), 6),
    destinationKey: Math.max(...rows.map((r) => r.destinationKey.length), 11),
  };
  for (const r of rows) {
    const disablePart = r.disabled === 'Y' ? `disabled=Y (${r.reason})` : 'disabled=N';
    process.stdout.write(
      `${r.filePath.padEnd(widths.filePath)} | ` +
        `${r.sourceName.padEnd(widths.sourceName)} | ` +
        `${r.destinationKey.padEnd(widths.destinationKey)} | ` +
        `offset=${r.offset} | ` +
        `${disablePart}\n`,
    );
  }
  return 0;
}

async function cmdHealth(opts: GlobalOpts): Promise<number> {
  let anyFail = false;

  // Config load.
  let loaded;
  try {
    loaded = await loadConfig(opts.config);
    process.stdout.write(`[OK] config: loaded ${opts.config}\n`);
  } catch (err) {
    process.stdout.write(`[FAIL] config: ${(err as Error).message}\n`);
    return 1;
  }
  for (const w of loaded.warnings) {
    process.stdout.write(`[WARN] config: ${w}\n`);
  }

  // State load + dir writable probe.
  let state: RelayState;
  try {
    state = await RelayState.load();
  } catch (err) {
    process.stdout.write(`[FAIL] state: load — ${(err as Error).message}\n`);
    return 1;
  }
  const dir = stateDir();
  try {
    await fsp.mkdir(dir, { recursive: true });
    const probe = path.join(dir, `.health-${process.pid}-${Date.now()}.tmp`);
    await fsp.writeFile(probe, 'ok');
    await fsp.unlink(probe);
    process.stdout.write(`[OK] state: dir ${dir} writable\n`);
  } catch (err) {
    process.stdout.write(`[FAIL] state: dir ${dir} not writable — ${(err as Error).message}\n`);
    anyFail = true;
  }

  // Build providers and probe each.
  const providers = buildProviders(loaded.config, state);
  for (const [name, provider] of providers) {
    if (name === 'telegram' && loaded.config.providers.telegram) {
      const tg = loaded.config.providers.telegram;
      try {
        const me = await telegramGetMe(tg.botToken);
        process.stdout.write(`[OK] provider telegram: getMe (bot @${me.username ?? 'unknown'})\n`);
      } catch (err) {
        process.stdout.write(`[FAIL] provider telegram: getMe — ${(err as Error).message}\n`);
        anyFail = true;
        // Skip getChat probes if the token is bad.
        continue;
      }
      for (const [groupName, chatId] of Object.entries(tg.groups)) {
        try {
          await telegramGetChat(tg.botToken, chatId);
          process.stdout.write(`[OK] provider telegram: group "${groupName}" (${chatId}) reachable\n`);
        } catch (err) {
          process.stdout.write(`[FAIL] provider telegram: group "${groupName}" — ${(err as Error).message}\n`);
          anyFail = true;
        }
      }
    } else {
      // stdout / other: no-op.
      process.stdout.write(`[OK] provider ${name}: no-op\n`);
      void (provider as Provider); // retained for future per-provider health hooks
    }
  }

  // Per-source glob probe.
  for (const src of loaded.config.sources) {
    try {
      const files = await resolveGlob(src.pathGlob);
      if (files.length === 0) {
        process.stdout.write(`[WARN] source ${src.name}: glob matched zero files (${src.pathGlob})\n`);
      } else {
        process.stdout.write(`[OK] source ${src.name}: ${files.length} file(s) match\n`);
      }
    } catch (err) {
      process.stdout.write(`[FAIL] source ${src.name}: ${(err as Error).message}\n`);
      anyFail = true;
    }
  }

  // Close any providers we opened for probing.
  for (const p of providers.values()) {
    if (typeof p.close === 'function') {
      try {
        await (p as { close: () => Promise<void> }).close();
      } catch {
        // ignore
      }
    }
  }
  // Suppress unused import warning for TelegramProvider type.
  void ({} as TelegramProvider | undefined);

  return anyFail ? 1 : 0;
}

// ---- entry -----------------------------------------------------------------

function main(): void {
  const program = new Command();
  program
    .name('relay')
    .description('Agent-to-human observability relay — see relay.md')
    .version('0.1.0');

  program
    .command('init')
    .description('Validate config and probe providers + source globs')
    .option('--config <path>', 'path to relay.config.yaml', DEFAULT_CONFIG_PATH)
    .action(async (opts: GlobalOpts) => {
      process.exit(await cmdInit(opts));
    });

  program
    .command('start')
    .description('Run the relay daemon in the foreground')
    .option('--config <path>', 'path to relay.config.yaml', DEFAULT_CONFIG_PATH)
    .option('--backfill', 'replay existing file history on new sources', false)
    .action(async (opts: StartOpts) => {
      const code = await cmdStart(opts);
      // cmdStart normally never resolves; this is a defensive exit path.
      process.exit(code);
    });

  program
    .command('status')
    .description('Print mapped sources + offsets from state.json')
    .option('--config <path>', 'path to relay.config.yaml', DEFAULT_CONFIG_PATH)
    .action(async (opts: GlobalOpts) => {
      process.exit(await cmdStatus(opts));
    });

  program
    .command('health')
    .description('Deeper probe than init: state writable, provider reachable')
    .option('--config <path>', 'path to relay.config.yaml', DEFAULT_CONFIG_PATH)
    .action(async (opts: GlobalOpts) => {
      process.exit(await cmdHealth(opts));
    });

  program.parseAsync(process.argv).catch((err: Error) => {
    process.stderr.write(`relay: ${err.message}\n`);
    process.exit(1);
  });
}

// Silence the unused import error — we reference the type only in a type cast
// above, which tsc with `verbatimModuleSyntax` otherwise elides.
void (undefined as unknown as TelegramProvider | undefined);
void stateFilePath; // reserved for future status --json path

main();
