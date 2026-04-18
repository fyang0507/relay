#!/usr/bin/env bash
# relay — live end-to-end integration test against the real Telegram Bot API.
#
# Requires:
#   - .env at project root containing TELEGRAM_BOT_API_TOKEN=...
#   - Bot already a member of group -1003975893613 with topic-create perms.
#   - Built dist (dist/cli.js) — run `npm run build` first if needed.
#
# Leaves its tmpdir in place for post-mortem (prints the path on exit).

set -u

# --- locate project root (script lives in $PROJECT/scripts/) -----------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT="$(cd "$SCRIPT_DIR/.." && pwd)"

# --- load .env ---------------------------------------------------------------
if [ ! -f "$PROJECT/.env" ]; then
  echo "FAIL: missing $PROJECT/.env" >&2
  exit 1
fi
# shellcheck disable=SC1091
set -a
. "$PROJECT/.env"
set +a

if [ -z "${TELEGRAM_BOT_API_TOKEN:-}" ]; then
  echo "FAIL: TELEGRAM_BOT_API_TOKEN not set after sourcing .env" >&2
  exit 1
fi

# --- tmpdir setup ------------------------------------------------------------
TMPDIR_TEST="$(mktemp -d -t relay-integ-XXXXXX)"
mkdir -p "$TMPDIR_TEST/campaigns"
mkdir -p "$TMPDIR_TEST/.relay"
LOG="$TMPDIR_TEST/relay.log"

# Unique source file; suffix-with-timestamp so the topic name is unique per run.
STEM="integ-$(date +%s)"
SRC="$TMPDIR_TEST/campaigns/${STEM}.jsonl"
touch "$SRC"

# Write config (TMPDIR substituted literally; bot_token uses relay's ${VAR} expansion).
cat > "$TMPDIR_TEST/relay.config.yaml" <<EOF
providers:
  telegram:
    bot_token: \${TELEGRAM_BOT_API_TOKEN}
    groups:
      test: -1003975893613
sources:
  - name: integ-test
    path_glob: $TMPDIR_TEST/campaigns/*.jsonl
    provider: telegram
    group: test
    inbound_types: [human_input]
    tiers:
      call.placed: silent
      call.outcome: notify
EOF

# --- cleanup trap ------------------------------------------------------------
RELAY_PID=""
cleanup() {
  local exit_code=$?
  if [ -n "$RELAY_PID" ] && kill -0 "$RELAY_PID" 2>/dev/null; then
    kill -TERM "$RELAY_PID" 2>/dev/null || true
    # Wait up to 5s for graceful exit.
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      kill -0 "$RELAY_PID" 2>/dev/null || break
      sleep 0.5
    done
    if kill -0 "$RELAY_PID" 2>/dev/null; then
      kill -KILL "$RELAY_PID" 2>/dev/null || true
    fi
  fi
  exit $exit_code
}
trap cleanup EXIT INT TERM

# --- start relay daemon ------------------------------------------------------
# HOME=$TMPDIR_TEST so state.json ends up in $TMPDIR_TEST/.relay/state.json,
# isolated from any real state. The .env already provides the token via env.
echo "=== starting relay daemon ==="
echo "    tmpdir: $TMPDIR_TEST"
echo "    src:    $SRC"
echo "    config: $TMPDIR_TEST/relay.config.yaml"

HOME="$TMPDIR_TEST" TELEGRAM_BOT_API_TOKEN="$TELEGRAM_BOT_API_TOKEN" \
  node "$PROJECT/dist/cli.js" start \
    --config "$TMPDIR_TEST/relay.config.yaml" \
    --backfill \
    >"$LOG" 2>&1 &
RELAY_PID=$!

# Wait 4s for startup (provision + initial poll).
sleep 4

# Verify the daemon is still alive; if not, bail with its log.
if ! kill -0 "$RELAY_PID" 2>/dev/null; then
  echo
  echo "===== integration-test result ====="
  echo "provision: FAIL (relay daemon exited during startup)"
  echo "delivery:  FAIL (daemon not running)"
  echo "inbound:   FAIL (daemon not running)"
  echo "overall:   FAIL"
  echo "tmpdir:    $TMPDIR_TEST"
  echo "--- relay.log (last 40 lines) ---"
  tail -n 40 "$LOG" 2>/dev/null || true
  RELAY_PID=""  # prevent trap from re-killing
  exit 1
fi

# --- step 3: verify topic provisioned ---------------------------------------
STATE_FILE="$TMPDIR_TEST/.relay/state.json"
provision_result="FAIL"
provision_detail=""
THREAD_ID=""
TOPIC_NAME="integ-test:${STEM}"  # matches telegram.ts: `${sourceName}:${filenameStem}`

if [ -f "$STATE_FILE" ]; then
  # Extract threadId for $SRC using Node (avoids jq dependency).
  THREAD_ID=$(HOME="$TMPDIR_TEST" node -e "
    const fs = require('fs');
    const s = JSON.parse(fs.readFileSync(process.argv[1],'utf8'));
    const entry = s.sources && s.sources[process.argv[2]];
    if (!entry) { process.exit(2); }
    const tid = entry.destination && entry.destination.threadId;
    if (!tid) { process.exit(3); }
    process.stdout.write(String(tid));
  " "$STATE_FILE" "$SRC" 2>/dev/null || true)

  if [ -n "$THREAD_ID" ]; then
    provision_result="PASS"
    provision_detail="threadId=$THREAD_ID topic=\"$TOPIC_NAME\""
  else
    provision_detail="state.json missing entry for $SRC or empty threadId"
  fi
else
  provision_detail="state.json not present at $STATE_FILE"
fi

echo "[step 3] provision: $provision_result — $provision_detail"
if [ "$provision_result" != "PASS" ]; then
  echo "--- state.json ---"
  [ -f "$STATE_FILE" ] && cat "$STATE_FILE" || echo "(missing)"
  echo "--- relay.log (last 40 lines) ---"
  tail -n 40 "$LOG" 2>/dev/null || true
fi

# --- step 4: publish test events --------------------------------------------
delivery_result="FAIL"
delivery_detail=""

if [ "$provision_result" = "PASS" ]; then
  echo "=== publishing 3 test events ==="
  NOW1=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  echo "{\"type\":\"call.placed\",\"timestamp\":\"$NOW1\",\"to\":\"+15551234\",\"campaign\":\"integ-test\"}" >> "$SRC"
  sleep 0.3
  NOW2=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  echo "{\"type\":\"call.outcome\",\"timestamp\":\"$NOW2\",\"outcome\":\"answered\",\"notes\":\"spoke with gatekeeper\"}" >> "$SRC"
  sleep 0.3
  NOW3=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  echo "{\"type\":\"unmapped.type\",\"timestamp\":\"$NOW3\",\"note\":\"defaults to silent\"}" >> "$SRC"
  # Wait 5s for watcher + dispatcher to flush to Telegram and update state.
  sleep 5

  # Check that offset == filesize.
  FILESIZE=$(wc -c < "$SRC" | tr -d ' ')
  OFFSET=$(HOME="$TMPDIR_TEST" node -e "
    const fs = require('fs');
    const s = JSON.parse(fs.readFileSync(process.argv[1],'utf8'));
    const entry = s.sources && s.sources[process.argv[2]];
    process.stdout.write(String(entry && entry.offset !== undefined ? entry.offset : ''));
  " "$STATE_FILE" "$SRC" 2>/dev/null || echo "")

  if [ -z "$OFFSET" ]; then
    delivery_detail="could not read offset from state.json"
  elif [ "$OFFSET" = "$FILESIZE" ]; then
    delivery_result="PASS"
    delivery_detail="3/3 delivered (offset=$OFFSET == filesize=$FILESIZE)"
  else
    delivery_result="FAIL"
    delivery_detail="offset=$OFFSET < filesize=$FILESIZE (not all lines delivered)"
    echo "--- $SRC contents ---"
    cat "$SRC"
    echo "--- relay.log tail ---"
    tail -n 40 "$LOG" 2>/dev/null || true
  fi
  echo "[step 5] delivery: $delivery_result — $delivery_detail"
else
  delivery_detail="skipped (provision failed)"
  echo "[step 5] delivery: SKIP — provision failed"
fi

# --- step 6: inbound reply loop ---------------------------------------------
inbound_result="WARN"
inbound_detail="not attempted"

if [ "$delivery_result" = "PASS" ]; then
  echo
  echo "=============================================================="
  echo "MANUAL STEP: Open Telegram group 'fred-agent-outreach'."
  echo "Find the topic named: $TOPIC_NAME"
  echo "(thread_id=$THREAD_ID)"
  echo "Send any reply text in that topic. You have 60 seconds."
  echo "=============================================================="
  echo

  # Remember current file line count so we can detect a new human_input append.
  INITIAL_LINES=$(wc -l < "$SRC" | tr -d ' ')
  captured=""
  elapsed=0
  while [ "$elapsed" -lt 60 ]; do
    # Look for a human_input line.
    captured=$(HOME="$TMPDIR_TEST" node -e "
      const fs = require('fs');
      const lines = fs.readFileSync(process.argv[1],'utf8').split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const o = JSON.parse(line);
          if (o && o.type === 'human_input') {
            process.stdout.write(o.text || JSON.stringify(o));
            process.exit(0);
          }
        } catch (_) {}
      }
    " "$SRC" 2>/dev/null || true)
    if [ -n "$captured" ]; then
      inbound_result="PASS"
      inbound_detail="captured: $captured"
      break
    fi
    sleep 2
    elapsed=$((elapsed + 2))
  done

  if [ "$inbound_result" != "PASS" ]; then
    inbound_result="WARN"
    inbound_detail="INBOUND TIMEOUT — manual reply not received within 60s"
  fi
  echo "[step 6] inbound: $inbound_result — $inbound_detail"
else
  echo "[step 6] inbound: SKIP — delivery failed"
fi

# --- step 7: shutdown -------------------------------------------------------
echo "=== shutting down relay ==="
if kill -0 "$RELAY_PID" 2>/dev/null; then
  kill -TERM "$RELAY_PID" 2>/dev/null || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    kill -0 "$RELAY_PID" 2>/dev/null || break
    sleep 0.5
  done
  if kill -0 "$RELAY_PID" 2>/dev/null; then
    echo "WARN: daemon did not exit on SIGTERM; sending SIGKILL"
    kill -KILL "$RELAY_PID" 2>/dev/null || true
    sleep 0.5
  fi
fi
# Clear so trap doesn't try again.
RELAY_PID=""

# --- overall result ---------------------------------------------------------
overall="FAIL"
if [ "$provision_result" = "PASS" ] && [ "$delivery_result" = "PASS" ]; then
  if [ "$inbound_result" = "PASS" ] || [ "$inbound_result" = "WARN" ]; then
    overall="PASS"
  fi
fi

echo
echo "===== integration-test result ====="
echo "provision: $provision_result${provision_detail:+ ($provision_detail)}"
echo "delivery:  $delivery_result${delivery_detail:+ ($delivery_detail)}"
echo "inbound:   $inbound_result${inbound_detail:+ ($inbound_detail)}"
echo "overall:   $overall"
echo "tmpdir:    $TMPDIR_TEST"
echo "log:       $LOG"

if [ "$overall" = "PASS" ]; then
  exit 0
else
  exit 1
fi
