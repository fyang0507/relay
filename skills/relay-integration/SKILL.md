---
name: relay-integration
description: How to wire relay into an agentic-autonomy system so a human can observe and steer long-running task agents without coupling those agents to Telegram/Slack/etc. For developers integrating relay; the task agents themselves stay filesystem-first and unaware of relay.
---

## What this skill is for

If you are building a long-running agent system (e.g. `outreach-cli`) and want a human to observe progress and occasionally steer without coupling your agents to a messaging platform, wire relay in at the edge. Your agents stay filesystem-first — they write JSONL event logs to disk as they already do. Relay runs as a separate daemon, mirrors those logs to Telegram, and flows human replies back into the same files as typed events your agents consume on resume.

## Relay is optional *per consumer command*, not per consumer

Optionality is a per-command property. Split your consumer's commands into two buckets:

- **Pure outbound** — event emission with no inbound round-trip (call / sms / email / calendar hooks, telemetry, audit trails). These work without relay: your agents write JSONL, external provider APIs handle delivery, humans can tail the file directly. Relay's absence costs only the real-time Telegram view.
- **Human-in-the-loop** — commands that block on a human reply via relay's inbound path (e.g. outreach's `ask-human`). These **require** relay. Without it, the agent emits a `human_question` and nothing ever comes back; the command just times out.

The rule: if your tool ships any command that depends on the inbound round-trip (`human_input` lines appended to JSONL by relay), treat relay as **required** at the stack level — your tool's `setup` should fail (non-zero exit) when relay is absent. If your tool is pure outbound, treat relay as **optional** — warn and continue. Document the split in your tool's own docs so consumer authors don't accidentally over- or under-couple.

Relay itself is a shared multiplexer — any project producing JSONL events can register its own directories. The watch registry is runtime-populated by whoever uses relay (typically an orchestrator agent operating in a data repo). It is not package-bundled, not owned by any one consumer, and not static config on the daemon.

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

5. **Install relay once on your machine, scaffold your data repo, then register your project.** In the relay checkout: `npm install && npm run build`, add `TELEGRAM_BOT_API_TOKEN=...` to the relay repo's `.env`, run `relay init` (installs the launchd agent under `com.fyang0507.relay` and starts the daemon). Once per data repo, run `relay setup --data-repo <path>` — this stamps `tools.relay` in `.agents/workspace.yaml` and syncs skill docs into `<data_repo>/.agents/skills/relay/`. Finally, from anywhere, register each of your project's configs with `relay add --config /abs/path/to/your/relay.config.yaml` and verify with `relay list`. Re-run `relay add` after edits to register new sources; existing ones are idempotent by `(configPath, sourceName)`. Relay persists its watch registry at `~/.relay/state.json` (also per-file offsets, provisioned destinations, provider bookkeeping); `~/.relay/` is the place to inspect if you need to audit what the daemon is actively watching.

6. **Consume `human_input` on agent resume.** When the human replies in Telegram, relay appends a line in this exact shape:

    ```json
    {"type":"human_input","timestamp":"2026-04-17T19:30:00.000Z","text":"please wait","source":"relay-inbound"}
    ```

    The field named by `tier_key` (default `type`) carries the inbound type — the first entry of `inbound_types` (default `"human_input"`). `timestamp` is ISO 8601 UTC when relay appended the line — agents use it on resume to detect lines written since their last action. `text` is the reply from Telegram. `source: "relay-inbound"` marks relay-authored lines so agent book-keeping readers can distinguish them.

7. **(Optional) trim noisy payloads with `deliver_fields`.** If your JSONL lines carry scratch fields that are useful to the agent on resume but add noise on Telegram (trace ids, internal state, long transcripts), set a per-source `deliver_fields: [key1, key2, ...]` allowlist. Relay projects each outbound line to those top-level keys — ordered by the list, missing keys silently absent — before rendering. The `[<tier-key-value>]` header is unaffected, so you don't have to re-list the tier-key field. No nested paths: top-level keys only. Because the filter is source-wide, sources emitting multiple line shapes need a union that covers all of them. Add `deliver_field_max_chars: N` (integer in `[20, 4096]`, only valid alongside `deliver_fields`) to cap each projected field individually — strings over the cap truncate to `N-3` chars + `...`; non-string values over the cap are replaced with their truncated JSON-stringified form. Per-field (not per-message) so one oversize field cannot starve the rest. Filesystem JSONL is unaffected either way — filtering is a delivery-side concern.

## Two kinds of registration: per-data-repo vs per-source

Relay has two distinct registration flows. They are not interchangeable, so keep them straight:

### 1. Per-data-repo: `relay setup` (one-time, paralleling outreach/sundial)

```
relay setup --data-repo ~/my-data
```

Scaffolds a `.agents/workspace.yaml` marker at the data-repo root, stamps `tools.relay.version` under `tools:` (preserving any sibling entries from `outreach setup` / `sundial setup`), and syncs the canonical skill docs (`SKILL.md`, `telegram-setup.md`) into `<data_repo>/.agents/skills/relay/` so an agent operating inside the data repo has relay's integration guide locally. Idempotent — safe to rerun, and composes cleanly with `outreach setup` / `sundial setup` on the same data repo.

Resolution order when `--data-repo` is omitted:

1. `RELAY_DATA_REPO` env var — wins over everything; the explicit escape hatch
2. `relay.config.dev.yaml` next to the relay binary (sticky dev mode, gitignored; `.example` is committed)
3. Walk up from `cwd` for `.agents/workspace.yaml`
4. Error with a remediation message naming `relay setup --data-repo` and `RELAY_DATA_REPO`

This flow is what puts relay's docs in the agent's workspace. Run once per data repo, typically by a human during initial setup or by an `*-cli setup` command.

### 2. Per-source: `relay add --config <path>` (runtime, agent-driven, repeatable)

An orchestrator agent operating inside a data repo is typically the right layer to register individual *watch sources* with the running relay daemon. This is not a bootstrap — it's a per-managed-directory action.

1. **Enumerate** the directories under the agent's management that produce JSONL (e.g. `<data_repo>/outreach/campaigns/`, plus any other JSONL-producing path).
2. **Ensure a `relay.config.yaml` exists** for each one — create from a template if missing, or reuse if already checked in. One config can hold multiple `sources:` entries if several directories share a tier policy and provider; use separate configs when they don't.
3. **Run `relay add --config <abs-path>`** for each config. Idempotent by `(configPath, sourceName)`, so re-running after edits is safe — new sources register, existing ones are no-ops.
4. **Verify with `relay list`** to confirm every source landed with a `rl_xxxxxx` id, and `relay health` for daemon liveness.

Watch registrations are persisted in relay's own registry at `~/.relay/state.json` — not in the data repo's `workspace.yaml`. They're multi-tenant: a single relay daemon can watch JSONL directories across many data repos.

### Canonical per-source verbs

`relay add` / `relay list` / `relay remove` / `relay health` are the canonical per-source verbs. `relay setup` is per-data-repo and distinct. If the daemon is down, `relay health` and `relay add` surface a `daemon not running` error with remediation — your consumer's setup should use that as the stack-readiness signal (error = relay down).

For the outreach-campaigns flow specifically, relay ships a canonical source template at `examples/outreach-source.yaml` (in the relay repo). Copy it into your data repo as `relay.config.yaml`, substitute `<DATA_REPO_PATH>` and `<GROUP_ID>`, and register it. Outreach's repo does not carry its own copy — relay owns the template so it can evolve with the integration contract.

### What to expect after `relay add` (file-discovery semantics)

After a successful `relay add`, `files_tracked: 0` is **transient**. Relay's directory watcher does an initial scan of `path_glob`; each matching file flows through `fileDiscovered → provision → trackFile`, bumping `files_tracked`. For small directories this is sub-second; bulk provisioning against Telegram can take longer because topic creation is rate-limited (429s retry with backoff).

- **Pre-existing files** (present when the watcher starts) go through the same provision path as newly-written ones. The default starting offset is `stat.size` (mark-as-read — don't replay history); set `backfill: true` on the source to start at offset 0 instead. There is no "skip the first line" mode.
- **Files created after `relay add`** start at offset 0 unconditionally so the creating write is not lost to a stat-size race.
- **`files_tracked` stays 0 indefinitely** → something went wrong. Check `~/.relay/daemon.err.log` for provision failures. **Watch log freshness**: the `.err.log` is not rotated on daemon restart, so `tail -f` or `stat` the file's mtime before blaming current events on old entries.
- **Source-name uniqueness is enforced across configPaths.** Registering the same `sources[].name` under a different `relay.config.yaml` returns `name_conflict` with a remediation hint (remove the existing id or pick a different name). Source names are the daemon's per-source identifier — they must be unique.

### Re-registering a previously-watched directory

`relay remove` drops the registry entry and the runtime watchers, but **archives** the per-file destination mappings (provider, topic id, offset) into `~/.relay/state.json` → `orphaned`. A later `relay add` against a config whose source produces the same `(filePath, sourceName, providerType)` **rehydrates** the archived destination — no duplicate Telegram topics, no offset reset. This makes `remove + add` the idempotent path for migrating a config between directories, renaming a config file, or changing source-definition fields that aren't hot-reloadable.

Consequences:

- Changing `sourceName` between remove and re-add is treated as a different source — rehydration is skipped, the old orphan stays archived, and a fresh destination is provisioned. If that's unintended, match the old name.
- Changing `provider.type` similarly skips rehydration (recycling a Telegram topic id as, say, a stdout destination would be meaningless).
- A destination deleted in the platform's UI between remove and re-add will surface through the normal "destination gone → disable mapping" path on the first outbound deliver.
- `disabled` mappings (provider already reported the destination gone) are **not** archived on remove — there is nothing useful to rehydrate.

For a genuinely clean slate, delete the Telegram topics in the UI and clear the `orphaned` section of `state.json` manually.

## Example: a minimal config

```yaml
# relay.config.yaml (in your project)
sources:
  - name: outreach-campaigns
    path_glob: ~/outreach-data/outreach/campaigns/*.jsonl
    # tier_key: type   # override if your agents already use a different field name
    inbound_types: [human_input]
    # Optional: allowlist top-level keys to deliver (omit to deliver the full payload).
    # deliver_fields: [tool, args, notes]
    # deliver_field_max_chars: 500   # only valid alongside deliver_fields
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
- **One-time per data repo**: `relay setup --data-repo <path>`. Stamps `tools.relay` in `.agents/workspace.yaml` and syncs skill docs to `<data_repo>/.agents/skills/relay/`. Idempotent and order-independent with `outreach setup` / `sundial setup`.
- **Per project**: `relay add --config /abs/path/to/relay.config.yaml` (idempotent). `relay list` to see what's registered. `relay remove --id rl_xxxxxx` to unregister a source; `--dry-run` is available on both `add` and `remove`.
- **`remove` does not touch provider artifacts.** Unregistering a source stops watching its files; the Telegram topics it created stay in the group (messaging is a durable archive the operator owns). Per-file destination mappings are archived in `~/.relay/state.json` → `orphaned` so a later `relay add` against the same files rehydrates the existing topics instead of duplicating them. For a genuinely clean slate, delete the Telegram topics manually and clear `orphaned` from `state.json`.
- **Quick checks**: `relay health` (daemon liveness + uptime + registered count).
- **Uninstall**: `relay shutdown` unloads the launchd agent and removes the plist. `~/.relay/` (state + logs) is preserved; `rm -rf ~/.relay` for a full wipe.
- **Node binary moved** (nvm switch, Homebrew upgrade): the plist hardcodes `process.execPath` at install time, so re-run `relay init` after any change to your node install.

## Further reading

- `relay.md` at the relay repo root — architecture, design principles, provider contract, deferred scope.
- `telegram-setup.md` — Telegram bot + forum-group setup walkthrough.
- `examples/outreach-source.yaml` at the relay repo root — canonical template for wiring an outreach campaigns directory; copy, substitute paths and ids, register.
- `scripts/integration-test.sh` at the relay repo root — a working end-to-end example: spins up relay against Telegram, publishes events, waits for a human reply, verifies the JSONL loop.
