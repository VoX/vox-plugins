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

## ⚠️ One blocker: marketplace cache needs a push

The plugin loader looks up `plugin:slack@vox-plugins` in the cached
marketplace at `~/.claude/plugins/marketplaces/vox-plugins/.claude-plugin/marketplace.json`,
which is a clone of `https://github.com/VoX/vox-plugins.git`. My
commits add slack to `marketplace.json` and to `external_plugins/slack/`,
but they are **local only** — the cached marketplace doesn't see them.

Restarted with `plugin:slack@vox-plugins` in `BOT_PLUGINS`; claude
silently skipped the plugin (no `bun server.ts` for slack, no error in
journal — discord + scheduler still loaded fine). Smoke test confirms
the plugin code itself works.

To actually load slack, the workflow is:

1. `git push origin main` from `~/projects/vox-plugins/`
2. `claude plugin marketplace update vox-plugins`
3. `claude plugin install slack@vox-plugins`
4. Restart `claude-discord@tinyclaw`

Step 1 is unauthorized for me (push to public repo without explicit
ask). Holding for VoX to either push themselves or authorize.

Workaround if you want to test before pushing: temporarily change the
marketplace source to `file:///home/ec2-user/projects/vox-plugins`
in `~/.claude/plugins/known_marketplaces.json`, run
`marketplace update`, install, restart. Revert when done.

## Deferred from the 0.1.7 4-agent review

Substantive findings that fix would have meaningfully changed scope or
required bigger refactors. Documented here so they're not lost:

- **Extract a shared `channel-core` module across discord + slack** —
  `withAccessLock`, `pruneExpired`, `recentSentTs`/`noteSent`,
  `BOOT_ACCESS`, `readAccessFile`, atomic JSON write, dunk subsystem,
  username cache LRU — all are line-for-line clones between the two
  plugins. Significant refactor, deferred until a third channel-bridge
  plugin (telegram?) makes the duplication a real cost.
- **Move from FIFO eviction to a real LRU** in usernameCache — current
  drop-the-first-key-on-overflow lies about being LRU (it's FIFO). Names
  read frequently still get evicted on insertion order.
- **Cache `loadAccess` in-memory + watch mtime** — `access.json` is
  parsed from disk on every gate(), assertChannelAllowed(), and
  chunkOutbound(). For high-volume channels this is a measurable cost.
  Holding for now since it changes the locking model.
- **Cache DM-channel→user-id mapping** so `assertChannelAllowed` for
  DMs doesn't hit `conversations.info` on every send. Discord plugin
  has `dmChannelUsers` for this; slack should mirror.
- **Add `gate()` / `applyDunk` / `assertChannelAllowed` unit tests**.
  Requires mocking @slack/bolt's WebClient or extracting these as pure
  functions taking an injected client. Significant test infra build-out.
- **Surface slack rate-limit responses + retry-after** explicitly.
  Currently the catch-all returns a generic "tool failed" without the
  retry hint. Bolt's WebAPIRequestError carries this info.
- **Bot identity refresh** — BOT_USER_ID/HANDLE/TEAM_ID loaded once at
  boot. On bot rename, app reinstall, or workspace migration, in-memory
  identity goes stale until restart. Add a 1h refresh timer + a
  `tokens_revoked`/`app_uninstalled` event handler that triggers reboot.
- **Drop discord-plugin's `replyToMode` from slack access.json schema** —
  slack threading is conceptually different and the option doesn't
  apply. Right now the schema accepts it silently.
- **Distinguish "channel not opted in" vs "bot not invited to channel"**
  in the assertChannelAllowed error. Currently both yield the same
  "not opted in — add via /slack:access" message; if the channel IS in
  groups but the bot isn't a member, the operator gets misdirected.
- **Permalink in inbound channel tag** — slack's `chat.getPermalink`
  is cheap and the model could use it to cite messages back.

## Open follow-ups (not blockers)

- Port discord plugin's permission relay to slack (Block Kit actions buttons can drive the same flow).
- Port `/status` slash command (would also need slash command scope + manifest entry).
- Bolt's reconnect/watchdog story — Bolt handles reconnects internally but a watchdog timer matching the discord plugin's pattern (kill on prolonged disconnect, let systemd restart) might still be valuable. Not added in v0.1.
