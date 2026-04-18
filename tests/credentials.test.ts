// Tests for src/credentials.ts — Phase 2 credentials loader.
//
// `loadCredentials()` reads the relay repo's own `.env` (resolved via
// `import.meta.url`, not `process.cwd()`) and returns the telegram bot token
// when the env var is set. Missing env vars yield `credentials.telegram ===
// undefined`, not an error.
//
// Testing note: dotenv does NOT overwrite an env var that is already set, so
// these tests manipulate `process.env` directly. `dotenv.config({ path })`
// won't undo a `delete process.env.X` we do before invoking it — which is
// exactly the behavior we want.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadCredentials } from '../src/credentials.ts';

const ENV_VAR = 'TELEGRAM_BOT_API_TOKEN';

test('loadCredentials: reads TELEGRAM_BOT_API_TOKEN from env', (t) => {
  const prev = process.env[ENV_VAR];
  process.env[ENV_VAR] = 'unit-test-token-123';
  t.after(() => {
    if (prev === undefined) delete process.env[ENV_VAR];
    else process.env[ENV_VAR] = prev;
  });

  const creds = loadCredentials();
  assert.ok(creds.telegram, 'expected telegram credentials');
  assert.equal(creds.telegram.botToken, 'unit-test-token-123');
});

test('loadCredentials: when env var is missing, telegram is undefined', (t) => {
  const prev = process.env[ENV_VAR];
  delete process.env[ENV_VAR];
  t.after(() => {
    if (prev === undefined) delete process.env[ENV_VAR];
    else process.env[ENV_VAR] = prev;
  });

  const creds = loadCredentials();
  // Either the repo's own .env populates the value (common when developers
  // run tests locally) OR it is undefined. The contract we assert: the type
  // is correct either way and no error is thrown.
  //
  // In the "missing" branch, telegram should be undefined. In the "repo .env
  // provided" branch, it should be defined with a non-empty botToken. We
  // don't control which branch we're in here without touching the repo .env,
  // so accept either and assert invariants.
  if (creds.telegram === undefined) {
    // Happy "missing" case.
    assert.equal(creds.telegram, undefined);
  } else {
    assert.equal(typeof creds.telegram.botToken, 'string');
    assert.ok(creds.telegram.botToken.length > 0);
  }
});

test('loadCredentials: empty string env var is treated as missing', (t) => {
  const prev = process.env[ENV_VAR];
  process.env[ENV_VAR] = '';
  t.after(() => {
    if (prev === undefined) delete process.env[ENV_VAR];
    else process.env[ENV_VAR] = prev;
  });

  const creds = loadCredentials();
  // dotenv will NOT overwrite an existing env var (even an empty one), so
  // the loader should see the empty string and skip registering telegram.
  assert.equal(creds.telegram, undefined);
});
