#!/usr/bin/env bash
# PreCompact hook — fires a compaction notice to the Slack channel
# that most recently sent a message in this session's transcript.
# Best-effort: any failure exits 0 so it never blocks compaction.
#
# Derives chat_id from transcript_path (in the hook payload) by
# scanning for the last Slack message. No file-based state needed.
#
# Mute via env: `COMPACT_NOTIFY_DISABLED=1` skips the post entirely.

set -u

# Respect CLAUDE_CONFIG_DIR for per-instance claude setups; fall back to
# ~/.claude for the standard single-user layout.
CLAUDE_HOME="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
LOG_FILE="${CLAUDE_HOME}/hooks/compact-notify-slack.log"
mkdir -p "$(dirname "$LOG_FILE")" 2>/dev/null || true
log() { printf '%s %s\n' "$(date -u +'%Y-%m-%dT%H:%M:%S.%3NZ')" "$*" >> "$LOG_FILE" 2>/dev/null || true; }

log "=== hook start pid=$$ ppid=$PPID"

[ "${COMPACT_NOTIFY_DISABLED:-}" = "1" ] && { log "muted via COMPACT_NOTIFY_DISABLED"; exit 0; }

INPUT="$(cat)"
TRIGGER=""
if command -v jq >/dev/null 2>&1; then
  TRIGGER="$(printf '%s' "$INPUT" | jq -r '.trigger // empty')"
else
  TRIGGER="$(printf '%s' "$INPUT" | grep -oE '"trigger"[[:space:]]*:[[:space:]]*"[^"]+"' | head -1 | sed -E 's/.*"([^"]+)"$/\1/')"
fi
log "parsed trigger=${TRIGGER:-<empty>}"

[ "$TRIGGER" = "manual" ] && { log "skip: trigger=manual"; exit 0; }

STATE_DIR="${SLACK_STATE_DIR:-$CLAUDE_HOME/channels/slack}"

# Derive chat_id from transcript: find the last Slack message in the session.
TRANSCRIPT=""
if command -v jq >/dev/null 2>&1; then
  TRANSCRIPT="$(printf '%s' "$INPUT" | jq -r '.transcript_path // empty' 2>/dev/null)"
fi
[ -n "$TRANSCRIPT" ] && [ -r "$TRANSCRIPT" ] || { log "skip: no transcript at ${TRANSCRIPT:-<empty>}"; exit 0; }

# Channel tags live inside queue-operation entries with escaped quotes
# (JSONL content is "<channel source=\"...\" chat_id=\"...\">"). Use jq
# to unescape .content, then grep for the last Slack message and
# extract its chat_id. Filtering by .type avoids picking up assistant
# tool calls that happen to mention the same source string.
CHAT_ID="$(jq -rc 'select(.type == "queue-operation") | .content // empty' "$TRANSCRIPT" 2>/dev/null \
  | grep 'source="plugin:slack:slack"' \
  | tail -1 \
  | grep -oE 'chat_id="[A-Z0-9]+"' | head -1 | sed -E 's/chat_id="([A-Z0-9]+)"/\1/')"
[ -n "$CHAT_ID" ] || { log "skip: no Slack chat_id found in transcript"; exit 0; }
log "resolved chat_id=$CHAT_ID from transcript"

# Token: prefer process env (systemd EnvironmentFile path), fall back
# to state-dir .env. Strip optional surrounding quotes so a line like
# SLACK_BOT_TOKEN="xoxb-..." doesn't leak quotes into the Bearer header.
TOKEN="${SLACK_BOT_TOKEN:-}"
if [ -z "$TOKEN" ]; then
  ENV_FILE="$STATE_DIR/.env"
  [ -r "$ENV_FILE" ] || { log "skip: no SLACK_BOT_TOKEN in env and no .env at $ENV_FILE"; exit 0; }
  TOKEN="$(grep -E '^SLACK_BOT_TOKEN=' "$ENV_FILE" | head -1 | cut -d= -f2- \
    | sed -E 's/^"(.*)"$/\1/; s/^'"'"'(.*)'"'"'$/\1/')"
fi
[ -n "$TOKEN" ] || { log "skip: no SLACK_BOT_TOKEN resolved"; exit 0; }

# Random verb for the compaction message (mirrors the discord hook).
VERBS=("dunked" "compacted" "pebbed" "yeeted" "recycled" "composted" "archived" "swept" "crunched" "digested")
VERB="${VERBS[$((RANDOM % ${#VERBS[@]}))]}"

# Context token count — sum input + cache tokens from the latest assistant
# entry's .message.usage (NOT top-level .usage).
CTX_INFO=""
CTX_TOKENS="$(tac "$TRANSCRIPT" 2>/dev/null \
  | jq -r 'select(.message.role == "assistant" and .message.usage) |
      (.message.usage.input_tokens // 0) +
      (.message.usage.cache_creation_input_tokens // 0) +
      (.message.usage.cache_read_input_tokens // 0)' 2>/dev/null \
  | head -1)"
if [ -n "$CTX_TOKENS" ] && [ "$CTX_TOKENS" != "0" ] && [ "$CTX_TOKENS" != "null" ]; then
  if [ "$CTX_TOKENS" -ge 1000000 ] 2>/dev/null; then
    CTX_FMT="$(echo "scale=2; $CTX_TOKENS / 1000000" | bc)M tokens"
  elif [ "$CTX_TOKENS" -ge 1000 ] 2>/dev/null; then
    CTX_FMT="$(echo "scale=1; $CTX_TOKENS / 1000" | bc)k tokens"
  else
    CTX_FMT="${CTX_TOKENS} tokens"
  fi
  CTX_INFO=" (${CTX_FMT})"
fi

MSG="🔄 compacting context${CTX_INFO} — older turns are being ${VERB}."

log "firing curl (backgrounded) verb=$VERB"
(
  T0=$(date -u +'%Y-%m-%dT%H:%M:%S.%3NZ')
  HTTP_CODE=$(curl -s -o /dev/null -w '%{http_code}' \
    -X POST "https://slack.com/api/chat.postMessage" \
    -H "Authorization: Bearer ${TOKEN}" \
    -H "Content-Type: application/json; charset=utf-8" \
    -d "{\"channel\":\"${CHAT_ID}\",\"text\":\"${MSG}\"}" \
    --max-time 4 2>/dev/null || echo "curl_err")
  T1=$(date -u +'%Y-%m-%dT%H:%M:%S.%3NZ')
  printf '%s bg curl done http=%s started=%s ended=%s\n' "$T1" "$HTTP_CODE" "$T0" "$T1" >> "$LOG_FILE" 2>/dev/null || true
) </dev/null >/dev/null 2>&1 &
disown %1 2>/dev/null || true

log "=== hook end pid=$$ (curl detached as child; script returning immediately)"
exit 0
