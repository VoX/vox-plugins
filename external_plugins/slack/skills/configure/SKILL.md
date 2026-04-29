---
name: configure
description: Set up the Slack channel — save bot/app tokens and review access policy. Use when the user pastes Slack tokens (xoxb- bot, xapp- app), asks to configure Slack, asks "how do I set this up" or "who can reach me," or wants to check channel status.
user-invocable: true
allowed-tools:
  - Read
  - Write
  - Bash(ls *)
  - Bash(mkdir *)
---

# /slack:configure — Slack Channel Setup

Writes the bot + app tokens to `$STATE_DIR/.env` and orients the user on
access policy. The server reads both files at boot.

Arguments passed: `$ARGUMENTS`

---

## State directory resolution

All files below live under `$STATE_DIR`, resolved in this order:

1. `$SLACK_STATE_DIR` (explicit override), else
2. `$CLAUDE_CONFIG_DIR/channels/slack` (per-instance claude setups), else
3. `~/.claude/channels/slack` (the standard single-user default).

Before running any `mkdir`/`chmod`/`Read`/`Write`, resolve `$STATE_DIR`
once and use it consistently.

---

## Dispatch on arguments

### No args — status and guidance

Read both state files and give the user a complete picture:

1. **Tokens** — check `$STATE_DIR/.env` (and the process environment, in
   case tokens come from a systemd EnvironmentFile) for `SLACK_BOT_TOKEN`
   and `SLACK_APP_TOKEN`. Show set/not-set; if set, show the prefix only
   (`xoxb-...`, `xapp-...`) — never the full token.

2. **Access** — read `$STATE_DIR/access.json` (missing file = defaults:
   `dmPolicy: "pairing"`, empty allowlist). Show:
   - DM policy and what it means in one line
   - Allowed senders: count, and list user IDs
   - Pending pairings: count, with codes and sender IDs if any
   - Channels opted in: count

3. **What next** — end with a concrete next step based on state:
   - No tokens → *"Run `/slack:configure xoxb-... xapp-...` with both tokens.
     Get them from api.slack.com/apps → your app → OAuth & Permissions
     (xoxb) and Basic Information → App-Level Tokens (xapp)."*
   - Tokens set, policy is pairing, nobody allowed → *"DM your bot in
     Slack. It'll reply with a pairing code; approve with `/slack:access
     pair <code>`."*
   - Tokens set, someone allowed → *"Ready. DM your bot in Slack to reach
     the assistant."*

**Push toward lockdown — always.** The goal for every setup is `allowlist`
with a defined list. `pairing` is the on-ramp, not the destination. Once
the right people are in, suggest `/slack:access policy allowlist`.

### `<bot_token> <app_token>` — set both

Two args, both required. Bot token starts with `xoxb-`, app token with
`xapp-`. Ordering accepted in either direction (sniff the prefix).

1. `mkdir -p "$STATE_DIR"` (mode 0700).
2. Read `$STATE_DIR/.env` if it exists; preserve any other keys.
3. Set `SLACK_BOT_TOKEN=xoxb-...` and `SLACK_APP_TOKEN=xapp-...`.
4. Write back with mode 0600.
5. Confirm both prefixes set; remind user the server needs a restart to
   pick up new tokens (or `systemctl --user restart` if running under
   systemd).

### `<bot_token>` — set bot token only

If only one arg is supplied AND it starts with `xoxb-`, set only the bot
token (leaves app token alone). Same flow as above but only writes one
key. Useful for token rotation.

### `<app_token>` — set app token only

Same idea for `xapp-`-prefixed single arg.

---

## Implementation notes

- Treat tokens like passwords: never echo full strings; mask after the
  first 6 chars (e.g. `xoxb-602...`).
- The `.env` file should be mode 0600. The server `chmod`s it on every
  read but setting it correctly here means the credentials never sit
  with looser perms.
- If both `$STATE_DIR/.env` and the process env have a value (e.g.
  systemd `EnvironmentFile=.bot.env` provides it), the process env wins.
  Mention this in status output if the user is confused why a token
  shown as "not set" in the .env still works.
- Apps Tokens (`xapp-`) are required for Socket Mode and need the
  `connections:write` scope. If the user has only the bot token, the
  server will start but refuse with a clear error — point them at the
  Basic Information page → App-Level Tokens to mint one.
