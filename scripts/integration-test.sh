#!/usr/bin/env bash
# relay — live end-to-end integration test against the real Telegram Bot API.
#
# Exercises the daemon + CLI architecture. We deliberately do NOT call
# `relay init` / `relay shutdown` here: those install/remove the launchd
# agent and would collide with any real relay installation on this
# machine. Instead we spawn `node dist/daemon.js` directly as a subprocess
# with RELAY_SOCKET_PATH + HOME pointing at an isolated tmpdir, and drive
# every other CLI command through that isolated socket. The init/shutdown
# paths are covered by tests/lifecycle.test.ts (with stubbed launchctl)
# plus manual verification.
#
# Requires:
#   - .env at project root containing TELEGRAM_BOT_API_TOKEN=...
#   - Bot @fyang0507_bot already in group -1003975893613 with
#     topic-create perms.
#   - Built dist (dist/cli.js + dist/daemon.js) — run `npm run build`
#     first if missing.
#
# Leaves its tmpdir in place for post-mortem (prints the path on exit).

set -u

# --- locate project root (script lives in $PROJECT/scripts/) -----------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT="$(cd "$SCRIPT_DIR/.." && pwd)"

CLI="$PROJECT/dist/cli.js"
DAEMON="$PROJECT/dist/daemon.js"

# --- step 1: sanity — dist present ------------------------------------------
if [ ! -f "$CLI" ] || [ ! -f "$DAEMON" ]; then
  echo "FAIL: missing compiled artifacts." >&2
  echo "  expected: $CLI" >&2
  echo "  expected: $DAEMON" >&2
  echo "  fix:      run 'npm run build' from $PROJECT" >&2
  exit 1
fi

if [ ! -f "$PROJECT/.env" ]; then
  echo "FAIL: missing $PROJECT/.env (TELEGRAM_BOT_API_TOKEN required)" >&2
  exit 1
fi

# --- step 2: tmpdir setup ----------------------------------------------------
TMPDIR_TEST="$(mktemp -d -t relay-integ-XXXXXX)"
mkdir -p "$TMPDIR_TEST/campaigns"
mkdir -p "$TMPDIR_TEST/.relay"
LOG="$TMPDIR_TEST/daemon.log"
SOCK="$TMPDIR_TEST/sock"
STATE_FILE="$TMPDIR_TEST/.relay/state.json"

# Unique source file; the Telegram topic name == filename stem (P1a cleanup
# dropped the `sourceName:` prefix).
STEM="integ-$(date +%s)"
SRC="$TMPDIR_TEST/campaigns/${STEM}.jsonl"
touch "$SRC"

CONFIG="$TMPDIR_TEST/relay.config.yaml"
cat > "$CONFIG" <<EOF
sources:
  - name: integ-test
    path_glob: $TMPDIR_TEST/campaigns/*.jsonl
    inbound_types: [human_input]
    tiers:
      call.placed: silent
      call.outcome: notify
    provider:
      type: telegram
      group_id: -1003975893613
EOF

# --- result accumulators (set at each step) ---------------------------------
r_health="SKIP"
r_add_dryrun="SKIP"
r_list_empty="SKIP"
r_add_real="SKIP"
r_list_present="SKIP"
r_provision="SKIP"
r_delivery="SKIP"
r_inbound="SKIP"
r_remove_dryrun="SKIP"
r_list_preserved="SKIP"
r_remove_real="SKIP"
r_list_cleared="SKIP"
r_shutdown="SKIP"

d_add_real=""
d_provision=""
d_delivery=""
d_inbound=""

ID=""
THREAD_ID=""
TOPIC_NAME="$STEM"

# --- helpers ----------------------------------------------------------------
# Run the CLI against our isolated socket. Pipes stdout/stderr through so
# the human operator can see what happened. Returns the CLI's exit code.
run_cli() {
  HOME="$TMPDIR_TEST" RELAY_SOCKET_PATH="$SOCK" \
    node "$CLI" "$@"
}

# Run the CLI and capture both stdout and exit code into OUT / RC.
# Stderr is forwarded to the terminal so problems are visible.
capture_cli() {
  OUT="$(HOME="$TMPDIR_TEST" RELAY_SOCKET_PATH="$SOCK" \
    node "$CLI" "$@" 2>&1)"
  RC=$?
}

# --- cleanup trap ------------------------------------------------------------
DAEMON_PID=""
cleanup() {
  local exit_code=$?
  if [ -n "$DAEMON_PID" ] && kill -0 "$DAEMON_PID" 2>/dev/null; then
    kill -TERM "$DAEMON_PID" 2>/dev/null || true
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      kill -0 "$DAEMON_PID" 2>/dev/null || break
      sleep 0.5
    done
    if kill -0 "$DAEMON_PID" 2>/dev/null; then
      kill -KILL "$DAEMON_PID" 2>/dev/null || true
    fi
  fi
  exit $exit_code
}
trap cleanup EXIT INT TERM

# --- step 3: start daemon subprocess ----------------------------------------
echo "=== starting relay daemon subprocess ==="
echo "    tmpdir: $TMPDIR_TEST"
echo "    src:    $SRC"
echo "    sock:   $SOCK"
echo "    log:    $LOG"

# HOME override isolates state.json (~/.relay/state.json). credentials.ts
# resolves the real .env via import.meta.url, not HOME, so the bot token
# comes through unchanged.
HOME="$TMPDIR_TEST" RELAY_SOCKET_PATH="$SOCK" \
  node "$DAEMON" \
    >"$LOG" 2>&1 &
DAEMON_PID=$!

# --- step 4: wait for socket readiness --------------------------------------
ready="no"
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25; do
  if [ -S "$SOCK" ]; then
    ready="yes"
    break
  fi
  # Also bail early if the daemon died.
  if ! kill -0 "$DAEMON_PID" 2>/dev/null; then
    break
  fi
  sleep 0.2
done

if [ "$ready" != "yes" ]; then
  echo "FAIL: daemon socket $SOCK did not appear within 5s" >&2
  echo "--- daemon.log (last 40 lines) ---" >&2
  tail -n 40 "$LOG" 2>&1 || true
  exit 1
fi

# --- step A: health ----------------------------------------------------------
echo
echo "[A] relay health"
capture_cli health
echo "$OUT"
if [ "$RC" -eq 0 ] && echo "$OUT" | grep -q "^status:  *ok$"; then
  r_health="PASS"
else
  r_health="FAIL"
fi

# --- step B: add --dry-run ---------------------------------------------------
echo
echo "[B] relay add --dry-run"
capture_cli add --config "$CONFIG" --dry-run
echo "$OUT"
if [ "$RC" -eq 0 ] \
  && echo "$OUT" | grep -q "^dry_run:  *true$" \
  && echo "$OUT" | grep -q "^would_add:$" \
  && echo "$OUT" | grep -q "name: integ-test"; then
  r_add_dryrun="PASS"
else
  r_add_dryrun="FAIL"
fi

# --- step C: list (should still be empty) -----------------------------------
echo
echo "[C] relay list (expect empty)"
capture_cli list
echo "$OUT"
if [ "$RC" -eq 0 ] && echo "$OUT" | grep -q "(no sources mapped"; then
  r_list_empty="PASS"
else
  r_list_empty="FAIL"
fi

# --- step D: add (real) ------------------------------------------------------
echo
echo "[D] relay add"
capture_cli add --config "$CONFIG"
echo "$OUT"
# Extract the first rl_<hex> id from the output. `added:` block uses the
# aligned kv format; the only rl_ token in that output is the registry id.
ID="$(echo "$OUT" | grep -oE 'rl_[a-f0-9]+' | head -n 1 || true)"
if [ "$RC" -eq 0 ] && [ -n "$ID" ] && echo "$OUT" | grep -q "^added:$"; then
  r_add_real="PASS"
  d_add_real="id=$ID"
else
  r_add_real="FAIL"
  d_add_real="exit=$RC id=\"$ID\""
fi

# --- step E: list (should include the new source) ---------------------------
echo
echo "[E] relay list (expect entry)"
capture_cli list
echo "$OUT"
if [ "$RC" -eq 0 ] \
  && [ -n "$ID" ] \
  && echo "$OUT" | grep -q "$ID" \
  && echo "$OUT" | grep -q "name: *integ-test"; then
  r_list_present="PASS"
else
  r_list_present="FAIL"
fi

# --- step F: wait for topic provision ---------------------------------------
echo
echo "[F] waiting for Telegram topic provision..."
THREAD_ID=""
for _ in $(seq 1 20); do
  if [ -f "$STATE_FILE" ]; then
    THREAD_ID=$(HOME="$TMPDIR_TEST" node -e "
      const fs = require('fs');
      try {
        const s = JSON.parse(fs.readFileSync(process.argv[1],'utf8'));
        const entry = s.sources && s.sources[process.argv[2]];
        if (!entry) process.exit(2);
        const tid = entry.destination && entry.destination.threadId;
        if (!tid) process.exit(3);
        process.stdout.write(String(tid));
      } catch (e) { process.exit(4); }
    " "$STATE_FILE" "$SRC" 2>/dev/null || true)
    if [ -n "$THREAD_ID" ]; then
      break
    fi
  fi
  sleep 0.5
done

if [ -n "$THREAD_ID" ]; then
  r_provision="PASS"
  d_provision="thread_id=$THREAD_ID"
  echo "    provisioned thread_id=$THREAD_ID topic=\"$TOPIC_NAME\""
else
  r_provision="FAIL"
  d_provision="no threadId after 10s"
  echo "--- state.json ---"
  [ -f "$STATE_FILE" ] && cat "$STATE_FILE" || echo "(missing)"
  echo "--- daemon.log tail ---"
  tail -n 40 "$LOG" || true
fi

# --- step G + H: publish events and verify delivery -------------------------
if [ "$r_provision" = "PASS" ]; then
  echo
  echo "[G] publishing 3 test events to $SRC"
  NOW1=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  echo "{\"type\":\"call.placed\",\"timestamp\":\"$NOW1\",\"to\":\"+15551234\",\"campaign\":\"integ-test\"}" >> "$SRC"
  sleep 0.3
  NOW2=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  echo "{\"type\":\"call.outcome\",\"timestamp\":\"$NOW2\",\"outcome\":\"answered\",\"notes\":\"spoke with gatekeeper\"}" >> "$SRC"
  sleep 0.3
  NOW3=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  echo "{\"type\":\"unmapped.type\",\"timestamp\":\"$NOW3\",\"note\":\"defaults to silent\"}" >> "$SRC"
  echo "    waiting 5s for watcher + dispatcher to flush..."
  sleep 5

  FILESIZE=$(wc -c < "$SRC" | tr -d ' ')
  OFFSET=$(HOME="$TMPDIR_TEST" node -e "
    const fs = require('fs');
    try {
      const s = JSON.parse(fs.readFileSync(process.argv[1],'utf8'));
      const entry = s.sources && s.sources[process.argv[2]];
      process.stdout.write(String(entry && entry.offset !== undefined ? entry.offset : ''));
    } catch (e) {}
  " "$STATE_FILE" "$SRC" 2>/dev/null || echo "")

  if [ -z "$OFFSET" ]; then
    r_delivery="FAIL"
    d_delivery="could not read offset"
  elif [ "$OFFSET" = "$FILESIZE" ]; then
    r_delivery="PASS"
    d_delivery="3/3, offset=$OFFSET == filesize=$FILESIZE"
  else
    r_delivery="FAIL"
    d_delivery="offset=$OFFSET < filesize=$FILESIZE"
    echo "--- $SRC contents ---"
    cat "$SRC"
    echo "--- daemon.log tail ---"
    tail -n 40 "$LOG" || true
  fi
  echo "[H] delivery: $r_delivery — $d_delivery"
else
  echo "[G/H] SKIP — provision failed"
fi

# --- step I: manual inbound reply -------------------------------------------
if [ "$r_delivery" = "PASS" ]; then
  echo
  echo "=============================================================="
  echo "MANUAL STEP: Open Telegram group 'fred-agent-outreach'."
  echo "Find the topic named:   $TOPIC_NAME"
  echo "(thread_id=$THREAD_ID)"
  echo "Reply any text in that topic. You have 60 seconds."
  echo "=============================================================="
  echo

  captured=""
  elapsed=0
  while [ "$elapsed" -lt 60 ]; do
    captured=$(HOME="$TMPDIR_TEST" node -e "
      const fs = require('fs');
      try {
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
      } catch (_) {}
    " "$SRC" 2>/dev/null || true)
    if [ -n "$captured" ]; then
      r_inbound="PASS"
      d_inbound="captured: $captured"
      break
    fi
    sleep 2
    elapsed=$((elapsed + 2))
  done

  if [ "$r_inbound" != "PASS" ]; then
    r_inbound="WARN"
    d_inbound="INBOUND TIMEOUT (no reply within 60s)"
  fi
  echo "[I] inbound: $r_inbound — $d_inbound"
else
  echo "[I] SKIP — delivery failed"
fi

# --- step J: remove --dry-run -----------------------------------------------
if [ -n "$ID" ]; then
  echo
  echo "[J] relay remove --dry-run"
  capture_cli remove --id "$ID" --dry-run
  echo "$OUT"
  if [ "$RC" -eq 0 ] \
    && echo "$OUT" | grep -q "^dry_run:  *true$" \
    && echo "$OUT" | grep -q "^would_remove:$" \
    && echo "$OUT" | grep -q "$ID"; then
    r_remove_dryrun="PASS"
  else
    r_remove_dryrun="FAIL"
  fi

  # --- step K: list (source should still be there) -------------------------
  echo
  echo "[K] relay list (expect source still present)"
  capture_cli list
  echo "$OUT"
  if [ "$RC" -eq 0 ] && echo "$OUT" | grep -q "$ID"; then
    r_list_preserved="PASS"
  else
    r_list_preserved="FAIL"
  fi

  # --- step L: remove (real) -----------------------------------------------
  echo
  echo "[L] relay remove"
  capture_cli remove --id "$ID"
  echo "$OUT"
  if [ "$RC" -eq 0 ] && echo "$OUT" | grep -q "^removed:$"; then
    r_remove_real="PASS"
  else
    r_remove_real="FAIL"
  fi

  echo
  echo "    relay list (expect empty)"
  capture_cli list
  echo "$OUT"
  if [ "$RC" -eq 0 ] && echo "$OUT" | grep -q "(no sources mapped"; then
    r_list_cleared="PASS"
  else
    r_list_cleared="FAIL"
  fi
else
  echo "[J/K/L] SKIP — no id captured from add"
fi

# --- step M: shutdown daemon ------------------------------------------------
echo
echo "[M] shutting down daemon (SIGTERM)"
if kill -0 "$DAEMON_PID" 2>/dev/null; then
  kill -TERM "$DAEMON_PID" 2>/dev/null || true
  exit_status=""
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    if ! kill -0 "$DAEMON_PID" 2>/dev/null; then
      # Reap and capture exit status.
      wait "$DAEMON_PID" 2>/dev/null
      exit_status=$?
      break
    fi
    sleep 0.5
  done
  if [ -z "$exit_status" ]; then
    r_shutdown="FAIL"
    kill -KILL "$DAEMON_PID" 2>/dev/null || true
  elif [ "$exit_status" -eq 0 ]; then
    r_shutdown="PASS"
  else
    r_shutdown="FAIL"
  fi
  DAEMON_PID=""
else
  # Already gone? That's a fail — we expected it to be alive.
  r_shutdown="FAIL"
fi

# --- overall ----------------------------------------------------------------
overall="PASS"
for v in \
  "$r_health" "$r_add_dryrun" "$r_list_empty" "$r_add_real" \
  "$r_list_present" "$r_provision" "$r_delivery" \
  "$r_remove_dryrun" "$r_list_preserved" "$r_remove_real" \
  "$r_list_cleared" "$r_shutdown"; do
  if [ "$v" != "PASS" ]; then
    overall="FAIL"
    break
  fi
done
# inbound PASS or WARN both acceptable; FAIL would propagate.
if [ "$r_inbound" = "FAIL" ]; then
  overall="FAIL"
fi

echo
echo "===== integration-test result ====="
printf "health:         %s\n" "$r_health"
printf "add_dryrun:     %s\n" "$r_add_dryrun"
printf "list_empty:     %s\n" "$r_list_empty"
printf "add_real:       %s%s\n" "$r_add_real" "${d_add_real:+ ($d_add_real)}"
printf "list_present:   %s\n" "$r_list_present"
printf "provision:      %s%s\n" "$r_provision" "${d_provision:+ ($d_provision)}"
printf "delivery:       %s%s\n" "$r_delivery" "${d_delivery:+ ($d_delivery)}"
printf "inbound:        %s%s\n" "$r_inbound" "${d_inbound:+ ($d_inbound)}"
printf "remove_dryrun:  %s\n" "$r_remove_dryrun"
printf "list_preserved: %s\n" "$r_list_preserved"
printf "remove_real:    %s\n" "$r_remove_real"
printf "list_cleared:   %s\n" "$r_list_cleared"
printf "shutdown:       %s\n" "$r_shutdown"
printf "overall:        %s\n" "$overall"
printf "tmpdir:         %s\n" "$TMPDIR_TEST"
printf "log:            %s\n" "$LOG"

if [ "$overall" = "PASS" ]; then
  exit 0
else
  exit 1
fi
