# Relay — Agent-to-Human Observability Layer

Issue: #67 (outreach-side integration)
Status: v0.1.0 shipped. This doc is the living design reference — where the code and the doc disagree, the code wins and the doc gets updated. See the "v0.1.0 delivered" note under *Implementation phases* for what's actually in the codebase today.

## Problem

Outreach CLI runs autonomously — an orchestrator agent delegates to sub-agents that place calls, send messages, write JSONL, wait on replies. For the agent, file-system-first is the right paradigm: campaigns, contacts, and transcripts are files, and agents pass state via files across sessions. For the human operator, this is opaque. There is no live visibility into agent progress, no easy way to inject guidance when the agent needs a human decision, and no continuity of observation across sessions.

We already know the direction: we want multiple agent surfaces (outreach, smart-home automation, others) to feed the same human observer through a consistent messaging layer. A one-off outreach-specific Telegram integration would not scale.

## Design principles

1. **Filesystem is canonical; messaging is a projection.** Agents read and write files. The messaging layer is a passive mirror — it observes files and publishes, observes replies and appends. Agents never address the messaging layer directly.
2. **Observability, not chat.** The human is primarily an observer. Unlike chat-with-agent products (OpenClaw, ChatGPT-on-Telegram), new tasks do not start from the messaging platform. Human input flows back as lightweight steering — replying to questions, optional commands — not as free-form conversation.
3. **Relay is domain-agnostic.** Relay knows about files, destinations, tiers, and providers. It does not know about campaigns, smart-home tasks, or any consumer's semantics. Each consumer defines its own type vocabulary and writes well-typed JSONL.
4. **Design for the universal intersection across messaging platforms.** Core behavioral contract stays on primitives every platform supports. Platform-idiomatic features (Telegram forum topics, Slack slash commands, iMessage tapbacks) belong to per-provider adapters, not relay-core.
5. **Graceful degradation over proactive reconciliation.** Viewer-side actions (delete topic, leave group) are signals to disable that source mapping, not cues to re-create or repair. The file stays authoritative.

## Architecture

Relay is a standalone project consumed by outreach and other agent surfaces as peers.

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│  outreach    │     │  smart-home  │     │   future     │
│  CLI writes  │     │  automation  │     │  consumer    │
│  JSONL files │     │  writes files│     │              │
└──────┬───────┘     └──────┬───────┘     └──────┬───────┘
       │                    │                    │
       │      (all write to filesystem)          │
       │                    │                    │
       └────────────────────┴────────────────────┘
                            │
                            ▼
              ┌────────────────────────────┐        ┌──────────────┐
              │   relayd (daemon,          │◀──RPC──│  relay CLI   │
              │   supervised by launchd)   │  unix  │  (init, add, │
              │  • directory watchers      │  sock  │   list,      │
              │  • file watchers           │        │   remove,    │
              │  • offset state store      │        │   health,    │
              │  • dynamic source registry │        │   shutdown)  │
              │  • source→destination map  │        └──────────────┘
              │  • type → tier policy      │
              └────────────┬───────────────┘
                           │
           ┌───────────────┼────────────────┐
           ▼               ▼                ▼
    ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
    │  providers/  │ │  providers/  │ │  providers/  │
    │  telegram    │ │  slack (V2)  │ │  imessage(V2)│
    └──────┬───────┘ └──────────────┘ └──────────────┘
           │
           ▼
    ┌──────────────┐
    │   Telegram   │
    │   (forum     │
    │    group)    │
    └──────────────┘
```

The daemon (`relayd`) listens on `~/.relay/sock`. The CLI (`relay`) is a thin socket client for everything except `init` and `shutdown`, which install and remove the launchd plist. Source configs are registered at runtime via `add`; the daemon persists them in a `registry` section of `~/.relay/state.json` and replays them on restart.

**relay-core** (`relayd` daemon) owns:
- File-system watchers (one directory watcher per registered source glob, one file watcher per active mapped file)
- Per-file offset state (last byte offset published, persisted to `~/.relay/state.json`)
- Dynamic source registry (runtime-added source configs keyed by `rl_xxxxxx` ids; survives restart)
- Source → destination mapping (which source file maps to which provider destination)
- Type → tier policy (config-driven, not agent-emitted)
- Inbound dispatch (reply arrived on destination X → append to file mapped from destination X)
- Unix-socket RPC surface (`list`, `add`, `remove`, `health`) for the CLI to mutate the registry without restarting

**Providers** implement a four-primitive interface (see next section). Telegram is the V1 provider. Additional providers slot in as peers without changing relay-core.

## Provider contract: the four primitives

Universal across all messaging platforms:

| Primitive | Signature | Telegram implementation | Notes |
|---|---|---|---|
| **Deliver** | `(destination, text, tier) → Result` | `sendMessage` with `disable_notification = (tier == silent)` | Every platform has text delivery |
| **Receive** | long-running → yields `(destination, text)` events | `getUpdates` long-poll, filter for message replies | Polling or webhook |
| **Provision** | `(source_metadata) → destination` | `createForumTopic` in configured group | May be no-op on platforms where destinations are implicit (iMessage, email) |
| **Tier** (config, not verb) | `silent` \| `notify` \| `ignore` | silent → `disable_notification`; notify → default; ignore → skipped | Best-effort mapping per provider |

Deliberately excluded (platform-idiomatic, deferred to per-provider extensions post-V1):

- Topic lifecycle control (close, reopen, delete) — Telegram forum semantics
- Slash commands — Telegram/Slack only, semantics diverge
- Emoji reactions, pins, read receipts — platform-flavored

## Configuration schema

Project configs are credential-free and project-portable: each consumer keeps its own `relay.config.yaml` declaring only its sources, and registers it via `relay add --config <path>`. Bot tokens live in the relay repo's own `.env` (read by `src/credentials.ts` as `TELEGRAM_BOT_API_TOKEN`), not in the project config.

```yaml
# relay.config.yaml (lives in the consumer's repo)
sources:
  - name: outreach-campaigns
    path_glob: ~/outreach-data/outreach/campaigns/*.jsonl
    provider: telegram
    group_id: -1001234567890               # Telegram supergroup chat id (negative, starts with -100)
    inbound_types: [human_input]           # loop prevention: relay writes these, don't re-publish
    tiers:
      call.placed: silent
      call.completed: silent
      call.outcome: notify
      sms.sent: silent
      email.sent: silent
      calendar.added: silent
      human_question: notify
      # anything not listed defaults to silent

  - name: smart-home-runs
    path_glob: ~/smart-home/runs/*.jsonl
    provider: telegram
    group_id: -1009876543210
    inbound_types: [human_input]
    tiers:
      task.ran: silent
      task.failed: notify
```

Tier policy and destination are the human's control surface; consumers (outreach, smart-home) stay tier-unaware and just emit well-typed JSONL. Credentials stay on the operator's machine.

## Data contract

Every JSONL entry published through relay must carry at minimum:

```json
{"type": "<string>", ...payload}
```

The `type` field is the join key to relay's tier config. All other fields are passthrough — relay renders the entry as a Telegram message using a configurable template (reasonable default: pretty-print JSON with `type` as the heading). Messaging platforms stamp messages themselves, so relay does not require or render a `timestamp` field; agents may still include one as passthrough payload.

**`tier_key`** (per-source, default `"type"`): consumers with existing event schemas can override the join-key field name. If your agents already emit `{"event_type": "...", ...}` or `{"kind": "...", ...}`, set `tier_key: event_type` on that source and relay uses it as (a) the lookup key into `tiers`, (b) the loopback check against `inbound_types`, and (c) the field name relay writes when it appends inbound replies back to the file. Keep your schema; no renames required.

Relay ships a `SKILL.md` documenting this contract so consumers know what to emit.

**`inbound_types`**: per-source list of type names that relay itself writes (inbound replies appended to the file). Relay's outbound watcher skips lines whose `type` is in this list, preventing loopback. This replaces a blanket `ignore` tier — the concept is structural (what-I-wrote vs what-I-watch), not policy (important vs unimportant).

## Startup and backfill behavior

On daemon start (launchd brings `relayd` up automatically; the flow below is identical whether via `relay init` or a fresh login):

1. Load state (`~/.relay/state.json`, schema v2) and credentials (relay repo `.env`).
2. Build the provider map. Stdout is always available; Telegram registers iff credentials are present.
3. Start the dispatcher (inbound loops go live) and the base watcher.
4. **Replay the registry**: for each persisted `registry` entry, re-attach its source to the watcher. Pre-existing files are rediscovered and, if already tracked in state, resumed from the stored offset.
5. Start the socket server on `~/.relay/sock` so the CLI can issue `list` / `add` / `remove` / `health`.

For each discovered file, the runtime decides:

- **Mapped already** → resume file watcher from stored offset. No backfill.
- **Not mapped** → provision a fresh destination (e.g. create a Telegram forum topic), decide starting offset.

Default offset on first discovery: **create topic, skip to EOF** (treat existing history as "already happened" — the user can always read the file). Per-source `backfill: true` in the YAML, or the daemon-wide `options.backfill` flag, replays from offset 0.

Telegram inbound cursor (`update_id`) persists separately in the provider bag so relay never reprocesses old replies on restart.

When an operator runs `relay add --config ...`, each source in that config goes through the same discovery path without a daemon restart. `relay remove --id rl_xxx` detaches the directory watcher, untracks tailing, drops the registry entry, and cascades to every `sources[filePath]` whose `relayId` matches.

## Viewer-side reconciliation

Core contract: all viewer-side structural actions (delete topic, close topic, leave group) are handled by **send-failure → disable source mapping, log, require human reconfig**. Relay does not attempt proactive detection or auto-recreate.

| User action on Telegram | Detection | Relay response | File state |
|---|---|---|---|
| Delete topic | `400 Bad Request: message thread not found` on next send | Disable source mapping, log, halt syncing | Unchanged |
| Close topic | Send-failure or `forum_topic_closed` event (provider may early-detect) | Pause source; resume on `forum_topic_reopened` if detected | Unchanged |
| Rename topic | Provider event, ignored | No-op | Unchanged |
| Delete a message | Provider event, ignored | No-op | Unchanged |
| Remove bot / leave group | Send-failure across many sources | Disable affected source mappings, log loudly | Unchanged |

Telegram-specific early-detection (`forum_topic_closed` etc.) is an *optimization* inside the Telegram provider, not part of the core contract. Other providers may or may not implement it.

## Deferred / V2 scope

Not in v0.1.0; flagged so the core design stays compatible:

- **Transient-failure retry queue.** Today, if `provider.deliver` throws a transient error (network blip, Telegram 5xx), the offset does not advance and the line only redelivers on the next file append. A source that stops appending is stranded. V2: in-memory retry queue with exponential backoff, persisted across restarts. See the TODO in `src/dispatch.ts`.
- **Slash commands as a steering primitive** (`/pause`, `/halt`, `/status`) → would map to `{type: "user_command", ...}` entries written to the source file, parallel to how `human_input` works today. Same mechanism, new inbound type. Platform-specific (Telegram and Slack have them; iMessage and email don't), so per-provider.
- **Additional providers** (Slack, iMessage, email). The four-primitive interface is designed for this; no relay-core changes needed.
- **Linux/systemd supervision.** Current lifecycle commands shell out to `launchctl` and are macOS-only.
- **File rotation / truncation handling.** Outreach JSONL is append-only, so not a concern today. If a future consumer rotates files, offset-based state needs a "file identity" concept (inode or content hash).
- **Multi-observer access control.** Today's design assumes one viewer (the configured group). Read-only observers would be a Telegram group-permissions concern, not relay logic.
- **Rich rendering templates.** v0.1.0 ships a default JSON-pretty-print renderer. Per-type message templates (markdown, inline keyboards for quick-reply) are a provider-side polish pass.
- **Deep `relay health` probe.** Today's `health` is a liveness RPC only. A deep probe (bot token, group reachability, writable state dir, globs resolving) belongs server-side; see open question #4.

## Implementation phases

### v0.1.0 delivered

Phases 1–3 of the original plan shipped; the CLI/daemon split was reworked to drop static config in favor of a dynamic runtime registry. What's in the codebase today:

- **Daemon split** (`relayd` bin, `src/daemon.ts`). Persistent macOS launchd agent under label `com.fyang0507.relay`. Listens on `~/.relay/sock` (unix socket, mode 0600). Logs to `~/.relay/daemon.{out,err}.log`.
- **Thin CLI** (`relay` bin, `src/cli.ts`, modules under `src/commands/`). Subcommands: `init` (install plist + start), `shutdown` (unload + remove plist), `health`, `list`, `add --config <path> [--dry-run]`, `remove --id <id> [--dry-run]`. All except `init`/`shutdown` are socket clients via `RelayClient` (`src/client.ts`).
- **Socket RPC** (`src/socket.ts`). One request per connection, newline-delimited JSON. Commands: `list`, `add`, `remove`, `health`.
- **Dynamic source registry**. Sources arrive via `relay add --config <path>` at runtime; the daemon persists them under `registry` in `~/.relay/state.json` (schema v2) keyed by auto-generated `rl_xxxxxx` ids. On restart the registry is replayed so the live source set survives. Idempotent by `(configPath, sourceName)`.
- **Credentials split**. Project configs have no `providers:` block; each source declares `group_id` inline. The bot token lives in the relay repo's `.env` as `TELEGRAM_BOT_API_TOKEN`, loaded by `src/credentials.ts` (anchored on `import.meta.url` so launchd's cwd-less invocation still finds it).
- **Launchd integration** (`src/plist.ts`, `src/commands/lifecycle.ts`). `relay init` writes `~/Library/LaunchAgents/com.fyang0507.relay.plist`, `launchctl bootstrap`s it, and polls `health` until the daemon answers. `relay shutdown` is the reverse.
- **State schema v2**. New `registry` top-level section; each `sources[filePath]` entry gained a `relayId` linking it back to its registry owner. No auto-migration from v1 — operators clear the file and re-register.
- **Providers**: stdout (always on) and Telegram (registers when credentials are present). Telegram: `createForumTopic` → `sendMessage` → `getUpdates` long-poll, with 429 `retry_after` handling and permanent-disable classification for "topic gone" 400s.
- **147 tests** across state, watch, dispatch, runtime, config, credentials, telegram, socket, client, daemon, plist, lifecycle, cli.

### Phase 4 — outreach integration

Tracked under outreach issue #67. Key steps:

- Audit outreach's JSONL writes for `type` field completeness.
- Publish outreach type catalog as a sample `relay.config.yaml` fragment in the outreach repo.
- Route Telegram replies → relay → `human_input` event appended to campaign JSONL.
- Update `skills/outreach/SKILL.md`: on campaign resume, scan JSONL for new `human_input` entries since last agent action.
- Decide: do existing sundial/reply-check paths (SMS, email) also emit `human_question` to Telegram? Probably yes for a unified observer experience, but tracked as a sub-decision.

## Open questions

1. ~~**Topic naming on filename collision.**~~ **Resolved**: topic name is always the file's stem (filename without `.jsonl`). No `sourceName` prefix, no template. Developers dedicate one group chat per task type, so topic collisions are a config-time concern.
2. **How much of the JSONL payload to render in each Telegram message?** Full payload is verbose; summary-only loses information. The default renderer prints `[<tier-key-value>]` + pretty JSON, soft-capped at 3500 chars. Per-type templates for key types (`call.outcome`, `human_question`) are still open — revisit once outreach integration generates usage data.
3. ~~**Relay daemon supervision.**~~ **Resolved**: macOS launchd agent under label `com.fyang0507.relay`. `relay init` writes the plist and `launchctl bootstrap`s it; `relay shutdown` is the reverse. Linux/systemd parity is deferred.
4. **Telemetry / health.** **Partially resolved**: `relay health` exists as a thin socket round-trip that reports version, registered-source count, uptime, and socket path. The deeper probe (bot token validity, group reachability, state-dir writability, globs resolving to at least one file) is still open — it would need a new RPC that asks the daemon to exercise each provider, rather than the client doing it out-of-process.

## References

- Outreach integration issue: #67
- Design discussion: multi-turn conversation, 2026-04-17
- Related outreach concepts: JSONL campaign logs (`src/logs/sessionLog.ts`), sundial reply-check (`src/commands/replyCheck.ts`) — precedent for async-event-into-JSONL pattern
