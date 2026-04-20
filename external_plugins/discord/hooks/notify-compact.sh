#!/usr/bin/env bash
# PreCompact hook — fires a one-line "compacting" notice to the Discord
# channel that last pinged the plugin. Best-effort: any failure must
# exit 0 so a missing chat_id, network blip, or rate-limit does NOT
# block the actual compaction.
#
# Single-session only. Claude Code does not expose session_id to MCP
# servers, so the plugin writes the last chat_id to one shared path
# per user: ${DISCORD_STATE_DIR:-${CLAUDE_CONFIG_DIR:-$HOME/.claude}/channels/discord}/
# sessions/default/last_chat_id.txt. Two concurrent claude sessions on
# the same user will overwrite each other's pointer; whoever DM'd last
# wins. Matches the server-side write in server.ts. When anthropic
# exposes a session_id to plugins/MCP, both sides can switch.
#
# Mute via env: `COMPACT_NOTIFY_DISABLED=1` skips the post entirely.

set -u

# Respect CLAUDE_CONFIG_DIR for per-instance claude setups; fall back to
# ~/.claude for the standard single-user layout.
CLAUDE_HOME="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
LOG_FILE="${CLAUDE_HOME}/hooks/compact-notify.log"
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

STATE_DIR="${DISCORD_STATE_DIR:-$CLAUDE_HOME/channels/discord}"
LAST_CHAT_FILE="$STATE_DIR/sessions/default/last_chat_id.txt"

[ -r "$LAST_CHAT_FILE" ] || { log "skip: no last_chat_id file at $LAST_CHAT_FILE"; exit 0; }
CHAT_ID="$(cat "$LAST_CHAT_FILE" 2>/dev/null)"
[ -n "$CHAT_ID" ] || { log "skip: empty chat_id"; exit 0; }
log "resolved chat_id=$CHAT_ID from $LAST_CHAT_FILE"

ENV_FILE="$STATE_DIR/.env"
[ -r "$ENV_FILE" ] || { log "skip: no .env at $ENV_FILE"; exit 0; }
# Strip optional surrounding single or double quotes — otherwise a line like
# DISCORD_BOT_TOKEN="abc..." leaks the quote chars into the Bot header.
TOKEN="$(grep -E '^DISCORD_BOT_TOKEN=' "$ENV_FILE" | head -1 | cut -d= -f2- \
  | sed -E 's/^"(.*)"$/\1/; s/^'"'"'(.*)'"'"'$/\1/')"
[ -n "$TOKEN" ] || { log "skip: no DISCORD_BOT_TOKEN in env"; exit 0; }

log "full input: $INPUT"

# Random verb for the compaction message
VERBS=("dunked" "compacted" "pebbed" "yeeted" "recycled" "composted" "archived" "swept" "crunched" "digested")
VERB="${VERBS[$((RANDOM % ${#VERBS[@]}))]}"

# Get context token count from transcript_path (same method as /status command)
CTX_INFO=""
if command -v jq >/dev/null 2>&1; then
  TRANSCRIPT="$(printf '%s' "$INPUT" | jq -r '.transcript_path // empty' 2>/dev/null)"
  if [ -n "$TRANSCRIPT" ] && [ -r "$TRANSCRIPT" ]; then
    # Find last line with usage data, sum input_tokens + cache tokens
    CTX_TOKENS="$(tac "$TRANSCRIPT" 2>/dev/null | grep -m1 '"input_tokens"' | jq -r '
      (.usage.input_tokens // 0) +
      (.usage.cache_creation_input_tokens // 0) +
      (.usage.cache_read_input_tokens // 0)
    ' 2>/dev/null)"
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
  fi
fi

MSG="🔄 compacting context${CTX_INFO} — older turns are being ${VERB}."

log "firing curl (backgrounded) verb=$VERB"
(
  T0=$(date -u +'%Y-%m-%dT%H:%M:%S.%3NZ')
  HTTP_CODE=$(curl -s -o /dev/null -w '%{http_code}' \
    -X POST "https://discord.com/api/v10/channels/${CHAT_ID}/messages" \
    -H "Authorization: Bot ${TOKEN}" \
    -H "Content-Type: application/json" \
    -d "{\"content\":\"${MSG}\"}" \
    --max-time 4 2>/dev/null || echo "curl_err")
  T1=$(date -u +'%Y-%m-%dT%H:%M:%S.%3NZ')
  printf '%s bg curl done http=%s started=%s ended=%s\n' "$T1" "$HTTP_CODE" "$T0" "$T1" >> "$LOG_FILE" 2>/dev/null || true
) </dev/null >/dev/null 2>&1 &
disown %1 2>/dev/null || true

log "=== hook end pid=$$ (curl detached as child; script returning immediately)"
exit 0
