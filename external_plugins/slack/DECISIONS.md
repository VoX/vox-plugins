# Slack plugin — open decisions

Judgement calls made while VoX is away. Review and override at will.

## Manifest scope choices

- Chose `chat:write.public` so the bot can post to channels it isn't a member of (matches discord's "any allowlisted channel" feel). Drop if you'd rather force `/invite` everywhere.
- Included `users:read.email` for `get_user_info` parity. Sensitive — drop if you don't want claude to see workspace emails.
- Skipped `commands` (slash command) scope — would require defining `/slack:status` etc as slash commands in the manifest, plus extra plumbing. Can add later.

## Token storage

- Wrote tokens to `~/claude-discord/tinyclaw/.bot.env` per VoX's instruction. Plugin's `server.ts` ALSO loads from `~/.claude/channels/slack/.env` as a fallback (matching the discord plugin pattern), so other deployments without systemd-bot.env can still configure via the per-state-dir env file.

## API/SDK choices

- `@slack/bolt` v4 with Socket Mode. Bolt's `client.files.uploadV2` wraps the 3-step `getUploadURLExternal` → POST → `completeUploadExternal` flow. Removes ~50 LOC of plumbing.
- `@slack/web-api` is a transitive dep of bolt — listed explicitly in package.json for IDE clarity but not directly imported.

## Pairing flow

- Same shape as discord: `pairing` default; first DM from unknown sender → 8-hex code; VoX runs `/slack:access pair <code>` to approve. Slack workspaces are smaller blast-radius than discord (no random internet DMs), so pairing is mostly cargo-culted from discord. Can default to `allowlist` if the bot is only used in one workspace and you'd rather skip the pairing dance.

## Scope omissions vs discord plugin

- **No `send_embed`/`edit_embed`** — VoX directive: skip embed parity for now. Slack has no native color-bar; legacy `attachments` field still works but is "not actively developed".
- **No `typing` tool** — VoX directive: omit. Slack bots can't send typing indicators (Slack-side limitation, not API design choice). Existing skills that rely on typing-then-reply will need a slack-aware fork or graceful fallback.
- **No `claude/channel/permission` relay** — discord plugin sends button-driven permission prompts to allowlisted DMs. Skipped for v0.1; can port from discord if needed.
- **No slash commands** (`/status`, `/dunk`, `/dedunk` Discord slash). Slack supports them but requires separate `commands` scope + manifest entries + URL endpoint. Skipped for v0.1.
- **No `/status` command** — port the Haiku-summary `/status` later.
- ~~**No PreCompact hook**~~ — landed in 0.1.1. `hooks/notify-compact.sh` mirrors the discord hook, posting via `chat.postMessage` (Bearer auth) instead of discord's curl. Token sourced from process env first, falls back to `$STATE_DIR/.env`.

## Channel notification format

Inbound `<channel>` tag includes `source="slack"`, `team_id`, `chat_id`, `message_id` (slack `ts`), `user`, `user_id`, `ts` (ISO8601), `channel_type` (channel|group|im|mpim), and `thread_ts` when in a thread. `message_id` is the slack `ts` — same string used in `chat.update`, `reactions.add`, etc.

## Reaction shortcode enforcement

- `react` tool rejects unicode emoji with a clear error message (slack's API would 400 anyway, but the error is opaque). Forces shortcode form.

## Image downscaling

- Same Anthropic-vision-friendly downscale (1600px long edge, 5MB cap, animated images skip) as discord plugin. `sharp` dep carried over.

## File upload limits

- Capped at 50MB per file (slack's tier-1 limit is much higher, but this matches discord's spirit of "don't fill the inbox"). Adjust upward if you need bigger uploads.

## Open follow-ups (not blockers)

- Port discord plugin's permission relay to slack (Block Kit actions buttons can drive the same flow).
- Port `/status` slash command (would also need slash command scope + manifest entry).
- Bolt's reconnect/watchdog story — Bolt handles reconnects internally but a watchdog timer matching the discord plugin's pattern (kill on prolonged disconnect, let systemd restart) might still be valuable. Not added in v0.1.
