# Relay

## What relay is

A filesystem-watching daemon that mirrors agent JSONL logs to messaging platforms (V1: Telegram) so humans can observe autonomous agents without coupling agents to the messaging layer. Filesystem is canonical; messaging is a passive projection. See `relay.md` for the full design.

## Architecture at a glance

Relay v1.4.0 ships as two binaries: a long-running daemon (`relayd`, supervised by macOS launchd) that holds a dynamic source registry, and a short-lived CLI (`relay`) that talks to it over a unix-domain socket at `~/.relay/sock`. Project configs are credential-free and registered at runtime via RPC — no static config file on the daemon side. Per-data-repo wiring (stamping `.agents/workspace.yaml`, syncing skills) is handled by a separate `relay setup [--data-repo <path>]` command that parallels `outreach setup` / `sundial setup`.

File-by-file map (TypeScript, ESM, Node 20+):

- `src/types.ts` — domain types: `Tier`, `ProviderConfig` (discriminated union: `{type: 'telegram', groupId}` | `{type: 'stdout'}`), `SourceConfig`, `RelayConfig`, `JsonlEntry`, `SourceMetadata`.
- `src/providers/types.ts` — `Provider` interface (primitives: `deliver`, `receive`, `provision`, `destinationKey`, optional `close`). `Destination` is `Record<string, unknown>`.
- `src/state.ts` — `RelayState` persisted at `~/.relay/state.json` (schema v4: per-file offset + destination + disabled flag; per-provider key/value bag; `registry` of runtime-added source configs keyed by `rl_xxxxxx` ids; `orphaned` archive of per-file destinations that outlived their registry entry). Debounced (~500ms) atomic writes; proxy-backed provider bag auto-saves on mutation. v3 bump (#6) reshaped `SourceConfig.provider` into a discriminated union; v4 bump (#14) adds the orphan archive additively — v3 files upgrade seamlessly on load. v1/v2 state files are still rejected loudly — operators must clear `~/.relay/state.json` and re-register.
- `src/watch.ts` — chokidar-based directory watchers + per-file JSONL tail reader with byte offsets. Emits `fileDiscovered`, `line`, `truncated`, `error`. Own glob splitting (no micromatch). Dynamic `addSource` / `removeSource`.
- `src/dispatch.ts` — core policy: line → source lookup → loopback guard → tier lookup → render → `provider.deliver`; offset advances only on success. Runs one inbound loop per provider that supports `receive`; inbound text is appended to the mapped source file as a JSONL line with the `tier_key` field set to `source.inboundTypes[0] ?? 'human_input'`.
- `src/runtime.ts` — orchestrator with a dynamic source registry. Owns `fileDiscovered` (check orphan archive → either rehydrate or provision destination, decide offset, stamp `relayId`, track), `truncated` (warn only — V1 halts tail, no auto-recover), lifecycle (`start` replays the persisted registry; `stop` drains inbound and flushes state), `addSource`/`removeSource` (idempotent by `(configPath, sourceName)`; `addSource` throws `SourceNameConflictError` when a source name is already owned by a *different* configPath — GH #15), and `listSources`.
- `src/config.ts` — YAML loader, `${ENV}` expansion, snake_case→camelCase mapping, hand-rolled validator with JSON-path errors. No top-level `providers:` block; each source has a nested `provider:` block (`type` plus type-specific fields) dispatched to a per-provider sub-validator. Auto-injects `['human_input']` into empty `inbound_types` and emits a warning (echo-loop safeguard).
- `src/credentials.ts` — loads `.env` from the relay repo root (anchored on `import.meta.url`, NOT `process.cwd()`, so launchd's cwd-less invocation works). Reads `TELEGRAM_BOT_API_TOKEN`.
- `src/dataRepo.ts` — `resolveDataRepo({cwd, env})` + `DataRepoUnresolvedError`. Resolution order: `RELAY_DATA_REPO` env → `relay.config.dev.yaml` next to the binary (via `import.meta.url`) → walk up from `cwd` for `.agents/workspace.yaml` → throw. Parallels outreach/sundial's helpers.
- `src/skillsSync.ts` — `syncSkills(sourceDir, destDir)` — plain `cpSync` wrapper used by both `relay setup` and the build-time `scripts/sync-skills.mjs`. Destination is overwritten (skills are authoritative from the relay repo).
- `src/render.ts` — default message renderer: `[<tierKey-value>]\n<pretty JSON>`; soft cap 3500 chars → fall back to single-line JSON → hard-truncate with ellipsis. Optional per-source `deliverFields` projects top-level keys (ordered by the filter list, missing keys absent); optional `deliverFieldMaxChars` caps each projected field individually (strings truncated + `...`; non-strings probed via `JSON.stringify` and replaced with the truncated stringified form if over).
- `src/daemon.ts` — daemon entry (`relayd` bin). Composes state + credentials + providers + watcher + dispatcher + runtime + socket server, handles SIGINT/SIGTERM/uncaught.
- `src/socket.ts` — `SocketServer`. Unix-socket JSON-line RPC at `~/.relay/sock` (mode 0600). One request per connection. Commands: `list`, `add`, `remove`, `health`.
- `src/client.ts` — `RelayClient` + `DaemonNotRunningError`. Same-shape methods as the socket commands; translates `ENOENT`/`ECONNREFUSED` into `DaemonNotRunningError` and `{ok: false}` responses into `Error` with a `.code` field.
- `src/plist.ts` — pure string-in/string-out launchd plist builder (no I/O). Used by `install()`. Always prepends `/usr/bin/caffeinate -i` to `ProgramArguments` so idle sleep can't suspend the daemon; the assertion is released when caffeinate's child (the daemon) exits, so `launchctl bootout` tears everything down cleanly.
- `src/cli.ts` — commander-based entry (`relay` bin). Routing only; each subcommand lives under `src/commands/`. Subcommands: `setup [--data-repo <path>]`, `init`, `shutdown`, `health`, `list`, `add --config <path> [--dry-run]`, `remove --id <id> [--dry-run]`.
- `src/commands/init.ts`, `shutdown.ts`, `health.ts`, `list.ts`, `add.ts`, `remove.ts`, `setup.ts` — one module per CLI subcommand. `init`/`shutdown` call into `lifecycle.ts`; `setup` resolves the data repo, stamps `tools.relay` in `.agents/workspace.yaml` (preserving sibling entries), and runs `syncSkills`; the rest are thin socket clients.
- `src/commands/lifecycle.ts` — `install` / `uninstall` / `isInstalled`. Shells out to `/bin/launchctl` (`bootstrap` / `bootout` / `print`), writes the plist, polls `health` until the daemon answers. Resolves the node binary via `process.execPath` at install time.
- `src/commands/output.ts` — `printKv` / `printError` / section helpers (kv format, no colors).
- `src/commands/errors.ts` — `CliError` (exit code + stderr lines) and the canonical "daemon not running" advice lines.
- `src/commands/providers.ts` — `buildProviders(state, credentials)`. Stdout always registered; Telegram registered only when credentials are present. Wires the update_id cursor through the state's provider bag.
- `src/providers/stdout.ts` — dry-run provider (`stdout://<sourceName>`). `receive` is an AbortSignal-bound no-op iterable.
- `src/providers/telegram.ts` — Bot API provider using built-in `fetch` (no SDK). `createForumTopic` on provision, `sendMessage` on deliver, `getUpdates` long-poll (25s) on receive. Honors a single `retry_after` on 429; classifies "topic gone" 400s as permanent (`disableMapping: true`).
- `src/providers/telegramTypes.ts` — minimal Bot API response types (only the fields relay reads).

Tests: 196 tests under `tests/*.test.ts` (node --test, real tmp files for watcher) covering state, watch, dispatch, runtime, config, credentials, telegram, socket, client, daemon, plist, lifecycle, cli, dataRepo, setup. Integration: `scripts/integration-test.sh` (live Telegram). Consumer contract skill: `skills/relay-integration/SKILL.md`.

Build-time skills sync: `scripts/sync-skills.mjs` runs after `tsc` in `npm run build`. It calls `resolveDataRepo()` from the freshly-built `dist/dataRepo.js`; if the data repo is unresolvable it warns and exits 0 so fresh clones / CI still build cleanly. `RELAY_SKIP_SKILLS_SYNC=1` short-circuits the script unconditionally (intended for packaging).

## Build / run / test

```
npm install
npm run build                   # tsc + chmod + scripts/sync-skills.mjs
npm test                        # node --test 'tests/**/*.test.ts'
npx tsc --noEmit                # type-check only (uses tsconfig.json, includes tests)
./scripts/integration-test.sh   # live Telegram E2E
```

`npm run build` produces two executables: `dist/cli.js` (the `relay` bin) and `dist/daemon.js` (the `relayd` bin), both chmod +x. The launchd agent invokes `node dist/daemon.js`. The post-build `sync-skills.mjs` step copies `skills/relay-integration/` → `<data_repo>/.agents/skills/relay/` when a data repo is resolvable; it warns-and-exits-0 otherwise so fresh clones still build.

Why two tsconfigs: `tsconfig.json` is `noEmit: true` and includes both `src` and `tests` for type-checking. `tsconfig.build.json` extends it, flips `noEmit: false`, restricts `rootDir` to `src`, and uses `rewriteRelativeImportExtensions` so `.ts` imports emit as `.js`.

## Conventions

- ESM, Node 20+. No SDK deps for Telegram — use the built-in `fetch`.
- Snake_case in YAML, camelCase in TS; `src/config.ts` is the only place that bridges the two.
- Provider contract is four primitives (plus optional `close`). New providers implement `Provider` from `src/providers/types.ts`.
- `Destination` is an opaque plain JSON object; `destinationKey(d) -> string` is how dispatch reverse-looks-up on inbound.
- Never mock chokidar in tests — use real tmp files and small `await setTimeout(100)` delays for event settling.
- Unit tests in `tests/` using `node --test`; live / side-effect-ful integration tests go in `scripts/`.
- `JsonlEntry` structurally requires only the join-key field (default name `type`, configurable per-source via `tier_key`); everything else is passthrough. `timestamp` is not required — messaging platforms stamp messages themselves.
- Per-source `tier_key` (default `"type"`) names the field relay uses as the tier-policy join key and as the field name it writes on inbound lines, so consumers with existing schemas (`event_type`, `kind`) don't have to rename.
- Loopback prevention: relay appends inbound lines with the `tier_key` field set to `source.inboundTypes[0]` (default `'human_input'`); the dispatcher skips any outbound line whose `tier_key` value is in `inboundTypes`.
- Delivery-side field filtering (v1.1.0): optional per-source `deliver_fields: [k1, k2, ...]` projects each outbound line's payload to that top-level allowlist (ordered by the list, missing keys absent; tier-key header unaffected). Optional `deliver_field_max_chars: N` (integer in `[20, 4096]`, only valid alongside `deliver_fields`) caps each projected field individually — strings over the cap truncate with `...`, non-strings are probed via `JSON.stringify` and replaced with the truncated stringified form if over. Per-field, not per-message, so one oversize field cannot starve the rest. Filesystem JSONL is unaffected — filtering runs only in `src/render.ts` on the dispatch path.
- State writes are autosaved (debounced) and atomic (tmp + fsync + rename). Call `state.flush()` on shutdown.
- Unix socket at `~/.relay/sock` (mode 0600); launchd label `com.fyang0507.relay`; plist at `~/Library/LaunchAgents/com.fyang0507.relay.plist`; logs at `~/.relay/daemon.{out,err}.log`.
- Credentials load from the relay repo's `.env` via `src/credentials.ts` — never from project configs. Path resolution anchors on `import.meta.url` so launchd's cwd-less invocation still finds it.
- Per-command modules under `src/commands/`; `src/cli.ts` is routing-only. Commands throw `CliError` instead of calling `process.exit` so tests can import them directly.
- `RELAY_SOCKET_PATH` env var propagates through every socket-client command for test isolation.
- **Two registration flows, don't conflate:** `relay setup [--data-repo <path>]` is per-data-repo (stamps `.agents/workspace.yaml`, syncs skills, idempotent) — parallels `outreach setup` / `sundial setup`. `relay add --config <path>` is per-source (registers a watch source with the running daemon, persisted in `~/.relay/state.json`). The watch registry is multi-tenant and not colocated with any data repo's workspace.yaml.
- Data-repo resolution (`RELAY_DATA_REPO` → `relay.config.dev.yaml` next to the binary → walk-up for `.agents/workspace.yaml` → error) lives in `src/dataRepo.ts` and is shared by the `setup` command and the build-time skills sync. `relay.config.dev.yaml` is gitignored; ship changes to `relay.config.dev.yaml.example`.

## Adding things

- **New provider**: implement `Provider` in `src/providers/<name>.ts`, register it in `src/commands/providers.ts` (add an `if (credentials.<name>)` branch), extend `src/credentials.ts` if it has typed creds, add a new variant to `ProviderConfig` in `src/types.ts` (discriminated union keyed by `type`), add the corresponding case to `validateProvider` in `src/config.ts` (its own sub-validator) and add the type name to `KNOWN_PROVIDER_TYPES`, add tests. If source-scoped config fields live outside the provider block, extend `SourceConfig` directly; provider-specific settings belong inside the `provider:` variant.
- **New CLI command**: add a module at `src/commands/<name>.ts` exporting a `runXxx(opts)` function that throws `CliError` on failure; wire a `program.command(...)` block in `src/cli.ts` using the existing `wrap<>()` helper; add a unit test under `tests/cli.test.ts` (commander routing) plus a focused test for the command module itself.
- **New RPC method**: add a request/response type in `src/socket.ts`, extend the `switch` in `SocketServer.dispatch`, implement the handler; mirror the method on `RelayClient` in `src/client.ts`; add tests on both sides (`tests/socket.test.ts` and `tests/client.test.ts`).
- **New config field**: update `RelayConfig` / `SourceConfig` in `src/types.ts`, teach the validator in `src/config.ts` (remember snake_case key), and wire through `runtime.ts` / `dispatch.ts` / the relevant provider.
- **New CLI health probe**: extend `runHealth` in `src/commands/health.ts`; if the probe needs server-side data, add a field to the `health` RPC response in `src/socket.ts` first.

## Known constraints (V1 gaps / tech debt)

- Transient `deliver` failures do NOT retry automatically — they rely on the next file append to re-trigger dispatch. A source that stops appending is stranded. V2: retry queue with backoff. See TODO in `src/dispatch.ts`.
- When `state.disableSource()` fires, dispatch does NOT call `watcher.untrackFile()`, so chokidar keeps tailing silently. Low-harm but wasteful.
- File rotation / truncation is not handled: `truncated` event halts the tail and `runtime.ts` only logs. State is preserved but the file won't resume without manual intervention. V2: identity via inode + resume.
- Single-process design: no inter-process file lock on `~/.relay/state.json`.
- `render.ts` has one default template (with optional field allowlist + per-field truncation). Per-type rich templates (markdown, quick-reply keyboards) are still V2.
- `relay init` hardcodes `process.execPath` into the launchd plist at install time. If the node binary moves (nvm switch, Homebrew upgrade, Volta retarget), re-run `relay init` — the old plist will point at a stale path and the daemon will fail to start.
- macOS-only: lifecycle commands shell out to `launchctl`. Linux/systemd support is not implemented.
- No state-file migration: a v1 state file (pre-registry) is rejected loudly; operators must clear `~/.relay/state.json` and re-register sources.

## Where design decisions live

All design rationale and open questions are in `relay.md` at the repo root. If `relay.md` conflicts with the code, update `relay.md` — the code is ground truth. The consumer-side JSONL contract is documented in `skills/relay-integration/SKILL.md`.
