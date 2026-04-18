// Per-provider credentials loader. Phase 2 split: bot tokens and other
// secrets live in the relay repo's own `.env`, separate from project
// `relay.config.yaml` files (which now declare only sources).
//
// The repo root is resolved from this module's own file URL, NOT from
// `process.cwd()`. The daemon may run under launchd (or a CI worker) where
// `cwd` is unrelated to the relay repo location, so we anchor the `.env`
// lookup to the module itself.
//
// Compiled layout: at build time `tsc` emits this file to `dist/credentials.js`
// (one level down from the repo root). At runtime (sources) it lives at
// `src/credentials.ts`, also one level down. We go up one directory and look
// for `.env` there. If the env var is missing, `credentials.telegram` is
// `undefined`; the error (if any) surfaces at source-add time when a source
// asks for a provider whose credentials aren't present.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

// Shape returned by loadCredentials(). Each provider key is optional —
// missing credentials are not a load-time error.
export interface Credentials {
  telegram?: { botToken: string };
  // future providers go here (slack, imessage, email, ...)
}

// Find the relay repo root relative to this module. Works identically for
// the compiled `dist/credentials.js` file (one level under repo root) and
// the `src/credentials.ts` source (also one level under repo root), so
// `import.meta.url` + `..` always lands on the repo root.
function resolveRepoRoot(): string {
  const here = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(here), '..');
}

export function loadCredentials(): Credentials {
  const repoRoot = resolveRepoRoot();
  // `dotenv.config` populates `process.env` in place but does NOT overwrite
  // existing values. That's what we want: if an operator sets
  // TELEGRAM_BOT_API_TOKEN at the shell before invoking relay, the shell wins.
  // We intentionally swallow the "file not found" case — a fresh checkout
  // without a .env should still boot, just with no providers available.
  dotenv.config({ path: path.join(repoRoot, '.env'), quiet: true });

  const out: Credentials = {};
  const tgToken = process.env.TELEGRAM_BOT_API_TOKEN;
  if (typeof tgToken === 'string' && tgToken.length > 0) {
    out.telegram = { botToken: tgToken };
  }
  return out;
}
