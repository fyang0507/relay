---
name: relay-integration
description: How to wire relay into an agentic-autonomy system so a human can observe and steer long-running task agents without coupling those agents to Telegram/Slack/etc. For developers integrating relay; the task agents themselves stay filesystem-first and unaware of relay.
---

## What this skill is for

If you are building a long-running agent system (e.g. `outreach-cli`) and want a human to observe progress and occasionally steer without coupling your agents to a messaging platform, wire relay in at the edge. Your agents stay filesystem-first — they write JSONL event logs to disk as they already do. Relay runs as a separate daemon, mirrors those logs to Telegram, and flows human replies back into the same files as typed events your agents consume on resume.

## Mental model

Your agents never call relay. They only know their own filesystem.

```
  your task agents  ──write──▶  campaigns/*.jsonl  ◀──append──  relay daemon
                                       │                            │
                                       └──── relay watches ─────────┘
                                                    │
                                                    ▼
                                                Telegram
                                                    │
                                      human reply ──┘
```

Relay is a passive mirror with a return channel. Outbound: new lines in watched files get projected to a Telegram topic, with a `type`→tier policy deciding whether the phone buzzes. Inbound: human replies in that topic are appended back to the same JSONL as `{"type":"human_input", ...}`. The file stays canonical; relay just observes and appends.

## Integration steps

1. **Design your type vocabulary.** Catalog every event your agents emit. Use any stable string; relay treats these as opaque join keys. Pick whatever format suits you (`call.placed`, `email_sent`, `taskFailed`) — just don't mint new values opportunistically, since they are the join key to relay's tier policy.

2. **Decide tiers.** For each type, pick one: `silent` (routine status update), `notify` (human should see this soon), or `ignore` (don't publish at all). Unmapped types default to `silent`. This is a product/UX decision, not an agent concern — err toward `silent` to avoid notification fatigue.

3. **Emit compliant JSONL.** Every line must be a JSON object with a join-key field (default name: `type`, value: string). All other fields are passthrough — relay pretty-prints them into the Telegram message body. Append-only, one object per line. Lines missing the join-key field or with malformed JSON are silently skipped. If your existing schema uses a different field name (e.g. `event_type`, `kind`), set `tier_key: your_field` on the source and keep your schema unchanged — relay uses `tier_key` as both the tier-policy lookup and the field name it writes on inbound replies.

4. **Write a `relay.config.yaml`** in your project. One entry in `sources` per logical stream of JSONL files. Point `path_glob` at the directory your agents write to. Under `provider:`, set `type: telegram` and `group_id` (the Telegram supergroup chat id, a negative integer starting with `-100`). Set `inbound_types: [human_input]` so relay skips republishing its own inbound writes. The config is credential-free and project-portable — no bot tokens, no top-level `providers:` block. See example below.

5. **Install relay once on your machine, then register your project.** In the relay checkout: `npm install && npm run build`, add `TELEGRAM_BOT_API_TOKEN=...` to the relay repo's `.env`, run `relay init` (installs the launchd agent under `com.fyang0507.relay` and starts the daemon). Then, from anywhere, register your project's config with `relay add --config /abs/path/to/your/relay.config.yaml` and verify with `relay list`. Re-run `relay add` after edits to register new sources; existing ones are idempotent by `(configPath, sourceName)`.

6. **Consume `human_input` on agent resume.** When the human replies in Telegram, relay appends a line in this exact shape:

    ```json
    {"type":"human_input","timestamp":"2026-04-17T19:30:00.000Z","text":"please wait","source":"relay-inbound"}
    ```

    The field named by `tier_key` (default `type`) carries the inbound type — the first entry of `inbound_types` (default `"human_input"`). `timestamp` is ISO 8601 UTC when relay appended the line — agents use it on resume to detect lines written since their last action. `text` is the reply from Telegram. `source: "relay-inbound"` marks relay-authored lines so agent book-keeping readers can distinguish them.

## Example: a minimal config

```yaml
# relay.config.yaml (in your project)
sources:
  - name: outreach-campaigns
    path_glob: ~/outreach-data/outreach/campaigns/*.jsonl
    # tier_key: type   # override if your agents already use a different field name
    inbound_types: [human_input]
    tiers:
      call.placed: silent
      call.outcome: notify
      email.sent: silent
      human_question: notify
      # unlisted types default to silent
    provider:
      type: telegram
      group_id: -1001234567890
```

Each new JSONL file matching `path_glob` provisions a Telegram forum topic named after the file stem; subsequent lines append as messages in that topic.

## Provider setup

- **Telegram**: see `telegram-setup.md` — creating the bot, enabling forum topics, resolving `chat_id`.

## Anti-patterns

- **Don't have agents import or call anything from relay.** The filesystem is the only contract. If your agent has a `relay` dependency, you've coupled the wrong layer.
- **Don't use relay as a chat transport.** It's an observability projection. Free-form conversation, agent narration, or "thinking out loud" does not belong.
- **Don't skip the join-key field to save bytes.** The field named by `tier_key` (default `type`) must be present on every line — it's the join key to tier policy, and a line without it is dropped.
- **Don't stuff binary blobs or large payloads in JSONL.** Telegram caps messages at ~4096 chars. Reference files by path (`"transcript_path": "..."`) instead.
- **Don't hardcode tier in the agent.** Tier is a human-configurable policy in `relay.config.yaml`, not something the agent decides per event. No `"urgency": "high"` fields — mint a distinct type the operator can map.
- **Don't put PII/secrets in JSONL unless you're fine with them in Telegram history.** Relay mirrors the file verbatim.

## Running relay alongside your project

- **One-time per machine**: `relay init` in the relay checkout. This installs `~/Library/LaunchAgents/com.fyang0507.relay.plist` and starts the daemon via `launchctl bootstrap`. The daemon stays up across logouts and reboots.
- **Per project**: `relay add --config /abs/path/to/relay.config.yaml` (idempotent). `relay list` to see what's registered. `relay remove --id rl_xxxxxx` to unregister a source; `--dry-run` is available on both `add` and `remove`.
- **`remove` does not touch provider artifacts.** Unregistering a source stops watching its files and drops its state locally, but relay intentionally does not delete the Telegram topics it created — the messaging platform is treated as a durable archive the operator owns. Delete topics manually in the Telegram UI if you want a clean slate.
- **Quick checks**: `relay health` (daemon liveness + uptime + registered count).
- **Uninstall**: `relay shutdown` unloads the launchd agent and removes the plist. `~/.relay/` (state + logs) is preserved; `rm -rf ~/.relay` for a full wipe.
- **Node binary moved** (nvm switch, Homebrew upgrade): the plist hardcodes `process.execPath` at install time, so re-run `relay init` after any change to your node install.

## Further reading

- `relay.md` at the relay repo root — architecture, design principles, provider contract, deferred scope.
- `telegram-setup.md` — Telegram bot + forum-group setup walkthrough.
- `scripts/integration-test.sh` at the relay repo root — a working end-to-end example: spins up relay against Telegram, publishes events, waits for a human reply, verifies the JSONL loop.
