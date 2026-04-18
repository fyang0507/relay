# Relay — Agent-to-Human Observability Layer

Issue: #67 (outreach-side integration, blocked on relay being built)
Status: Design. Relay will be a separate project; this plan lives in outreach docs until relay is scaffolded, at which point it moves to the relay repo.

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
              ┌────────────────────────────┐
              │        relay-core          │
              │  • directory watchers      │
              │  • file watchers           │
              │  • offset state store      │
              │  • source→destination map  │
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

**relay-core** owns:
- File-system watchers (one directory watcher per configured source glob, one file watcher per active mapped file)
- Per-file offset state (last byte or line offset published, persisted to disk)
- Source → destination registry (which source file maps to which provider destination)
- Type → tier policy (config-driven, not agent-emitted)
- Inbound dispatch (reply arrived on destination X → append to file mapped from destination X)

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

```yaml
# relay.config.yaml
providers:
  telegram:
    bot_token: ${TELEGRAM_BOT_TOKEN}
    # group IDs are named so sources can reference them
    groups:
      outreach: -100xxxxxxxxxx
      smart_home: -100yyyyyyyyyy

sources:
  - name: outreach-campaigns
    path_glob: ~/outreach-data/outreach/campaigns/*.jsonl
    provider: telegram
    group: outreach
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
    group: smart_home
    inbound_types: []
    tiers:
      task.ran: silent
      task.failed: notify
```

Relay's config is the human's control surface — tier policy, destinations, and provider credentials all live here. Consumers (outreach, smart-home) stay tier-unaware; they just emit well-typed JSONL.

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

On relay start:

1. Load config, connect providers.
2. For each source, scan `path_glob` for existing files.
3. For each existing file, look up in state:
   - **Mapped already** → resume file watcher from stored offset. No backfill.
   - **Not mapped** → decision point: backfill from offset 0 (create new topic, publish all history) or mark-as-read (create topic, skip to end).

Default behavior on first discovery: **create topic, skip to EOF** (treat existing history as "already happened" — user can always read the file). Optional `--backfill` flag or per-source `backfill: true` to replay history.

Telegram inbound cursor (`update_id`) persists separately so relay never reprocesses old replies on restart.

4. Start inbound listener (Telegram `getUpdates` long-poll).
5. Start directory watcher on each source glob for new files (→ provision destination, start file watcher).

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

Not in V1; flagged so the core design stays compatible:

- **Slash commands as a steering primitive** (`/pause`, `/halt`, `/status`) → would map to `{type: "user_command", ...}` entries written to the source file, parallel to how `human_input` works today. Same mechanism, new inbound type. Platform-specific (Telegram and Slack have them; iMessage and email don't), so per-provider.
- **Additional providers** (Slack, iMessage, email). The four-primitive interface is designed for this; no relay-core changes needed.
- **File rotation / truncation handling.** Outreach JSONL is append-only, so not a concern today. If a future consumer rotates files, offset-based state needs a "file identity" concept (inode or content hash).
- **Multi-observer access control.** Today's design assumes one viewer (the configured group). Read-only observers would be a Telegram group-permissions concern, not relay logic.
- **Rich rendering templates.** V1 ships a default JSON-pretty-print renderer. Per-type message templates (markdown, inline keyboards for quick-reply) are a provider-side polish pass.

## Implementation phases

### Phase 1 — relay-core + provider interface

- Scaffold project (TypeScript, ESM, Node 20+; match outreach conventions).
- Define provider interface (`deliver`, `receive`, `provision`).
- File-system watcher layer (chokidar): directory-level glob watcher + per-file offset-tracking line reader.
- Offset state store (single JSON file, `~/.relay/state.json`).
- Source-to-destination registry in-memory, persisted in state.
- Core dispatch: new line → look up tier → provider.deliver; inbound event → look up source file → append line.
- Dry-run / stdout provider for local testing without Telegram.

### Phase 2 — config schema + startup behavior

- Load `relay.config.yaml` (path via `--config` or `~/.relay/config.yaml`).
- Startup flow: scan sources, reconcile against state, mark-as-read by default.
- Inbound update_id cursor persistence.
- Graceful shutdown (flush state, disconnect providers).
- `--backfill` override.

### Phase 3 — Telegram provider (V1 concrete)

- `@telegram/bot` or direct Bot API HTTP client.
- `createForumTopic` → destination token.
- `sendMessage` with `disable_notification` mapping to tier.
- `getUpdates` long-poll loop, filter for message replies in known topics, emit inbound events.
- Send-failure handler → disable source mapping.
- CLI: `relay init` (verify bot token, resolve group IDs), `relay start` (run daemon), `relay status` (show mapped sources + offsets).

### Phase 4 — outreach integration

Tracked under outreach issue #67. Key steps:

- Audit outreach's JSONL writes for `type` field completeness.
- Publish outreach type catalog as a sample `relay.config.yaml` fragment in the outreach repo.
- Route Telegram replies → relay → `human_input` event appended to campaign JSONL.
- Update `skills/outreach/SKILL.md`: on campaign resume, scan JSONL for new `human_input` entries since last agent action.
- Decide: do existing sundial/reply-check paths (SMS, email) also emit `human_question` to Telegram? Probably yes for a unified observer experience, but tracked as a sub-decision.

## Open questions

1. ~~**Topic naming on filename collision.**~~ **Resolved**: topic name is always the file's stem (filename without `.jsonl`). No `sourceName` prefix, no template. Developers dedicate one group chat per task type, so topic collisions are a config-time concern.
2. **How much of the JSONL payload to render in each Telegram message?** Full payload is verbose; summary-only loses information. Lean on per-type templates for key types (`call.outcome`, `human_question`) with a default "type heading + collapsed JSON" fallback. Decide during Phase 3.
3. **Relay daemon supervision.** Does relay run via launchd (macOS), systemd (linux), or a foreground `relay start` the user manages? Match outreach daemon's pattern. Probably: foreground with an `init/teardown` wrapper, same as outreach.
4. **Telemetry / health.** A `relay health` command analogous to `outreach health` — verify bot token, group reachability, writable state dir, configured sources resolve to at least one file. Include in Phase 3.

## References

- Outreach integration issue: #67
- Design discussion: multi-turn conversation, 2026-04-17
- Related outreach concepts: JSONL campaign logs (`src/logs/sessionLog.ts`), sundial reply-check (`src/commands/replyCheck.ts`) — precedent for async-event-into-JSONL pattern
