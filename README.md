# Relay

Relay is a filesystem-watching daemon that mirrors agent JSONL logs to messaging platforms (V1: Telegram) so a human can observe long-running autonomous agents and reply back through the same channel. Agents stay filesystem-first and never import relay; relay is a passive projection with a return channel.

## Quick start

Install on your machine once:

```
git clone <this repo>
cd relay
npm install
npm run build
```

Add a `.env` at the relay repo root with your Telegram bot token:

```
TELEGRAM_BOT_API_TOKEN=123456:ABC-...
```

(See `skills/relay-integration/telegram-setup.md` for bot + forum-group setup.)

Start the daemon (installs a macOS launchd agent under label `com.fyang0507.relay`):

```
relay init
```

In your project, write a `relay.config.yaml` declaring one or more sources (see `skills/relay-integration/SKILL.md` for the schema). Then register it:

```
relay add --config /abs/path/to/your/relay.config.yaml
relay list           # verify it landed
relay health         # daemon liveness
```

Stop and uninstall:

```
relay shutdown       # unloads launchd agent; preserves ~/.relay/ state
```

## Trimming delivered payloads

JSONL lines often carry scratch fields that are useful to the agent on resume but noisy on Telegram. Per-source `deliver_fields: [key1, key2, ...]` projects each outbound line to that top-level allowlist (ordered by the list, missing keys silently absent); the `[<tier-key>]` header is unaffected. Add `deliver_field_max_chars: N` (integer in `[20, 4096]`, only valid alongside `deliver_fields`) to cap each projected field individually — strings over the cap truncate with `...`; non-strings over the cap are replaced with their truncated JSON-stringified form. Filtering is delivery-only; the filesystem JSONL is unaffected. See `skills/relay-integration/SKILL.md` for the full schema.

## Pointers

- `relay.md` — architecture, design principles, provider contract, deferred scope.
- `CLAUDE.md` — contributor map: file-by-file layout, build/test commands, conventions.
- `skills/relay-integration/SKILL.md` — consumer-side integration guide (type vocabulary, tier policy, config schema, the `human_input` return channel).
- `skills/relay-integration/telegram-setup.md` — one-time bot + forum supergroup setup.

## Requirements

Node 20+. macOS (launchd) for the supervised daemon; Linux/systemd is not yet supported.
