# Relay

## What relay is

A filesystem-watching daemon that mirrors agent JSONL logs to messaging platforms (V1: Telegram) so humans can observe autonomous agents without coupling agents to the messaging layer. Filesystem is canonical; messaging is a passive projection. See `relay.md` for the full design.

## Architecture at a glance

File-by-file map (TypeScript, ESM, Node 20+):

- `src/types.ts` — domain types: `Tier`, `SourceConfig`, `RelayConfig`, `TelegramProviderConfig`, `JsonlEntry`, `SourceMetadata`.
- `src/providers/types.ts` — `Provider` interface (primitives: `deliver`, `receive`, `provision`, `destinationKey`, optional `close`). `Destination` is `Record<string, unknown>`.
- `src/state.ts` — `RelayState` persisted at `~/.relay/state.json` (per-file offset + destination + disabled flag; per-provider key/value bag). Debounced (~500ms) atomic writes; proxy-backed provider bag auto-saves on mutation.
- `src/watch.ts` — chokidar-based directory watchers + per-file JSONL tail reader with byte offsets. Emits `fileDiscovered`, `line`, `truncated`, `error`. Own glob splitting (no micromatch).
- `src/dispatch.ts` — core policy: line → source lookup → loopback guard → tier lookup → render → `provider.deliver`; offset advances only on success. Runs one inbound loop per provider that supports `receive`; inbound text is appended to the mapped source file as a JSONL line with `type = source.inboundTypes[0] ?? 'human_input'`.
- `src/runtime.ts` — orchestrator. Owns `fileDiscovered` (provision destination, decide offset, track), `truncated` (warn only — V1 halts tail, no auto-recover), and lifecycle (start/stop + `installSignalHandlers` for SIGINT/SIGTERM).
- `src/config.ts` — YAML loader, `${ENV}` expansion, snake_case→camelCase mapping, hand-rolled validator with JSON-path errors. Auto-injects `['human_input']` into empty `inbound_types` and emits a warning (echo-loop safeguard).
- `src/render.ts` — default message renderer: `[<tierKey-value>]\n<pretty JSON>` (no timestamp in header); soft cap 3500 chars → fall back to single-line JSON → hard-truncate with ellipsis.
- `src/cli.ts` — commander-based entry: `init`, `start`, `status`, `health`. Telegram probe helpers (`getMe`, `getChat`) live here, not on the Provider interface, to keep the contract platform-neutral.
- `src/commands/providers.ts` — `buildProviders(config, state)` helper. Stdout always registered; Telegram registered only when configured. Wires the update_id cursor through state's provider bag.
- `src/providers/stdout.ts` — dry-run provider (`stdout://<sourceName>`). `receive` is an AbortSignal-bound no-op iterable.
- `src/providers/telegram.ts` — Bot API provider using built-in `fetch` (no SDK). `createForumTopic` on provision, `sendMessage` on deliver, `getUpdates` long-poll (25s) on receive. Honors a single `retry_after` on 429; classifies "topic gone" 400s as permanent (`disableMapping: true`).
- `src/providers/telegramTypes.ts` — minimal Bot API response types (only the fields relay reads).

Tests: `tests/*.test.ts` (node --test, real tmp files for watcher). Integration: `scripts/integration-test.sh` (live Telegram). Consumer contract skill: `skills/relay-integration/SKILL.md`.

## Build / run / test

```
npm install
npm run build                   # tsc -p tsconfig.build.json && chmod +x dist/cli.js
npm test                        # node --test 'tests/**/*.test.ts'
npx tsc --noEmit                # type-check only (uses tsconfig.json, includes tests)
./scripts/integration-test.sh   # live Telegram E2E
```

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
- State writes are autosaved (debounced) and atomic (tmp + fsync + rename). Call `state.flush()` on shutdown.

## Adding things

- **New provider**: implement `Provider` in `src/providers/<name>.ts`, register it in `src/commands/providers.ts` (add an `if (config.providers.<name>)` branch), extend the config validator in `src/config.ts` if it has typed credentials, add tests.
- **New CLI command**: add a `program.command(...)` block in `src/cli.ts`; push nontrivial logic into a helper under `src/commands/`.
- **New config field**: update `RelayConfig` / `SourceConfig` in `src/types.ts`, teach the validator in `src/config.ts` (remember snake_case key), and wire through `runtime.ts` / `dispatch.ts` / the relevant provider.
- **New CLI health probe**: add it in `cmdHealth` in `src/cli.ts` using the `[OK]` / `[WARN]` / `[FAIL]` line prefixes already in use.

## Known constraints (V1 gaps / tech debt)

- Transient `deliver` failures do NOT retry automatically — they rely on the next file append to re-trigger dispatch. A source that stops appending is stranded. V2: retry queue with backoff. See TODO in `src/dispatch.ts`.
- When `state.disableSource()` fires, dispatch does NOT call `watcher.untrackFile()`, so chokidar keeps tailing silently. Low-harm but wasteful.
- File rotation / truncation is not handled: `truncated` event halts the tail and `runtime.ts` only logs. State is preserved but the file won't resume without manual intervention. V2: identity via inode + resume.
- Single-process design: no inter-process file lock on `~/.relay/state.json`.
- `render.ts` has one default template. Per-type rich templates (markdown, quick-reply keyboards) are V2.

## Where design decisions live

All design rationale and open questions are in `relay.md` at the repo root. If `relay.md` conflicts with the code, update `relay.md` — the code is ground truth. The consumer-side JSONL contract is documented in `skills/relay-integration/SKILL.md`.
