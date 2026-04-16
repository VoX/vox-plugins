#!/usr/bin/env bash
# PreCompact hook — fires a one-line "compacting" notice to the Discord
# channel that last pinged this session. Best-effort: any failure must
# exit 0 so a missing chat_id, network blip, or rate-limit does NOT
# block the actual compaction.
#
# Reads state written by the discord plugin itself at
# ${DISCORD_STATE_DIR:-$HOME/.claude/channels/discord}/sessions/${session_id}/last_chat_id.txt
# and the bot token from .env in that same dir. If the plugin hasn't
# seen a Discord message this session, the file won't exist and we
# silently no-op.
#
# Mute via env: `COMPACT_NOTIFY_DISABLED=1` skips the post entirely.

set -u

LOG_FILE="${HOME}/.claude/hooks/compact-notify.log"
mkdir -p "$(dirname "$LOG_FILE")" 2>/dev/null || true
log() { printf '%s %s\n' "$(date -u +'%Y-%m-%dT%H:%M:%S.%3NZ')" "$*" >> "$LOG_FILE" 2>/dev/null || true; }

log "=== hook start pid=$$ ppid=$PPID"

[ "${COMPACT_NOTIFY_DISABLED:-}" = "1" ] && { log "muted via COMPACT_NOTIFY_DISABLED"; exit 0; }

INPUT="$(cat)"
SESSION_ID=""
TRIGGER=""
if command -v jq >/dev/null 2>&1; then
  SESSION_ID="$(printf '%s' "$INPUT" | jq -r '.session_id // empty')"
  TRIGGER="$(printf '%s' "$INPUT" | jq -r '.trigger // empty')"
else
  SESSION_ID="$(printf '%s' "$INPUT" | grep -oE '"session_id"[[:space:]]*:[[:space:]]*"[^"]+"' | head -1 | sed -E 's/.*"([^"]+)"$/\1/')"
  TRIGGER="$(printf '%s' "$INPUT" | grep -oE '"trigger"[[:space:]]*:[[:space:]]*"[^"]+"' | head -1 | sed -E 's/.*"([^"]+)"$/\1/')"
fi
log "parsed session_id=${SESSION_ID:-<empty>} trigger=${TRIGGER:-<empty>}"

[ "$TRIGGER" = "manual" ] && { log "skip: trigger=manual"; exit 0; }

STATE_DIR="${DISCORD_STATE_DIR:-$HOME/.claude/channels/discord}"
SID="${SESSION_ID:-default}"
LAST_CHAT_FILE="$STATE_DIR/sessions/$SID/last_chat_id.txt"

if [ ! -r "$LAST_CHAT_FILE" ] && [ "$SID" != "default" ]; then
  log "no file at $LAST_CHAT_FILE — falling back to default"
  LAST_CHAT_FILE="$STATE_DIR/sessions/default/last_chat_id.txt"
fi

[ -r "$LAST_CHAT_FILE" ] || { log "skip: no last_chat_id file at $LAST_CHAT_FILE"; exit 0; }
CHAT_ID="$(cat "$LAST_CHAT_FILE" 2>/dev/null)"
[ -n "$CHAT_ID" ] || { log "skip: empty chat_id"; exit 0; }
log "resolved chat_id=$CHAT_ID from $LAST_CHAT_FILE"

ENV_FILE="$STATE_DIR/.env"
[ -r "$ENV_FILE" ] || { log "skip: no .env at $ENV_FILE"; exit 0; }
TOKEN="$(grep -E '^DISCORD_BOT_TOKEN=' "$ENV_FILE" | head -1 | cut -d= -f2-)"
[ -n "$TOKEN" ] || { log "skip: no DISCORD_BOT_TOKEN in env"; exit 0; }

log "firing curl (backgrounded)"
(
  T0=$(date -u +'%Y-%m-%dT%H:%M:%S.%3NZ')
  HTTP_CODE=$(curl -s -o /dev/null -w '%{http_code}' \
    -X POST "https://discord.com/api/v10/channels/${CHAT_ID}/messages" \
    -H "Authorization: Bot ${TOKEN}" \
    -H "Content-Type: application/json" \
    -d '{"content":"🔄 compacting context — older turns are being summarized."}' \
    --max-time 10 2>/dev/null || echo "curl_err")
  T1=$(date -u +'%Y-%m-%dT%H:%M:%S.%3NZ')
  printf '%s bg curl done http=%s started=%s ended=%s\n' "$T1" "$HTTP_CODE" "$T0" "$T1" >> "$LOG_FILE" 2>/dev/null || true
) </dev/null >/dev/null 2>&1 &
disown %1 2>/dev/null || true

log "=== hook end pid=$$ (curl detached as child; script returning immediately)"
exit 0
