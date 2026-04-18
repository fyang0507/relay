# Telegram setup

One-time steps to prepare a Telegram bot + forum supergroup for relay.

## 1. Create the bot

1. In Telegram, open a chat with [@BotFather](https://t.me/BotFather).
2. Send `/newbot`. Pick a display name and a username ending in `bot`.
3. BotFather returns an HTTP API token (`123456:ABC-...`). Treat it like a password. Put it in your env: `export TELEGRAM_BOT_TOKEN=...` (or your secret store) and reference it in `relay.config.yaml` as `${TELEGRAM_BOT_TOKEN}`.

### Smoke-test the token

```
curl https://api.telegram.org/bot<TOKEN>/getMe
```

Returns the bot's own user record including `username`. Use this any time you want to confirm a token is live.

## 2. Create the group and enable topics

1. Create a new group (not a channel).
2. Upgrade it to a **supergroup** — this happens automatically once you change it in ways Telegram requires, or explicitly via group settings.
3. Open group settings → enable **Topics** (a.k.a. forum mode). Sub-threads become the units relay provisions into.

## 3. Add the bot to the group

1. Invite the bot as a member.
2. Promote it to admin with (at minimum) **Manage Topics** and **Send Messages** permissions. Without "Manage Topics" the bot cannot create forum threads and relay provisioning fails.

## 4. Resolve the group's `chat_id`

The Bot API has no "list my chats" endpoint, so the standard flow is:

1. Confirm the bot is already a member of the group (step 3).
2. Have any human member post a message in the group — any topic, any content. This is what makes the group show up in the bot's update feed.
3. Fetch updates:

   ```
   curl https://api.telegram.org/bot<TOKEN>/getUpdates
   ```

4. In the JSON, find the matching `message.chat` object. Copy `chat.id`. For supergroups it is a **negative** integer starting with `-100…` (e.g. `-1001234567890`).
5. Paste it into `relay.config.yaml` under `providers.telegram.groups`:

   ```yaml
   providers:
     telegram:
       bot_token: ${TELEGRAM_BOT_TOKEN}
       groups:
         outreach: -1001234567890
   ```

If `getUpdates` is empty, the bot either hasn't received a message since its last poll or has an active webhook consuming updates — post again, and check `getWebhookInfo` if still empty.

## 5. Verify

Run `relay init --config your-relay.yaml` — it validates the token, resolves each configured group, and reports reachability before you start the daemon.
