# Slack

Connect a Slack bot to Claude Code with an MCP server. Uses [Socket
Mode](https://api.slack.com/apis/socket-mode) — no public URL or webhook
endpoint required.

When the bot receives a Slack message, the MCP server forwards it to
Claude and provides tools to reply, react, edit messages, fetch history,
download file attachments, and more.

## Prerequisites

- [Bun](https://bun.sh) — the MCP server runs on Bun. Install with
  `curl -fsSL https://bun.sh/install | bash`.

## Quick Setup

> Default pairing flow for a single-user DM bot. See
> [ACCESS.md](./ACCESS.md) for groups and multi-user setups.

**1. Create a Slack app from the manifest.**

Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New
App** → **From a manifest**. Pick your workspace, then paste the contents
of [`slack-app-manifest.yaml`](./slack-app-manifest.yaml). Click
**Create**.

The manifest enables Socket Mode and requests the bot scopes the plugin
needs (`chat:write`, `channels:history`, `users:read`, …). Review the
scope summary; click **Create**.

**2. Install the app to your workspace.**

On the app's page, click **OAuth & Permissions** → **Install to
Workspace** → authorize. Copy the **Bot User OAuth Token** (`xoxb-…`).

**3. Generate an app-level token for Socket Mode.**

On the app's page, **Basic Information** → scroll to **App-Level
Tokens** → **Generate Token and Scopes** → name it `socket` → add the
`connections:write` scope → **Generate**. Copy the token (`xapp-…`).

**4. Install the plugin.**

These are Claude Code commands — run `claude` to start a session first.

```
/plugin install slack@claude-plugins-official
/reload-plugins
```

**5. Configure the tokens.**

Run `/slack:configure xoxb-... xapp-...` (order doesn't matter — the
skill sniffs the prefixes). The tokens land in
`~/.claude/channels/slack/.env` with mode 0600.

**6. Start the bot.**

Restart your `claude` session (or `systemctl --user restart …` if
running under systemd) so the MCP server picks up the new tokens. You
should see `slack channel: socket mode connected` in the server log.

**7. Pair yourself.**

Open a DM with the bot in Slack. It'll reply with a pairing code. Run:

```
/slack:access pair <code>
```

That's it. DM the bot to reach Claude.

## Channel Use

Invite the bot to any channel with `/invite @<bot-name>` (the display
name set in the manifest). Then opt the channel in:

```
/slack:access group add <channel-id>
```

By default the bot only forwards messages that **@mention it** in
channels. Pass `--no-mention` to forward all channel traffic instead
(noisy — only do this in a dedicated channel).

## What Lives Where

| | |
| --- | --- |
| MCP server | this directory's `server.ts` |
| Tokens | `~/.claude/channels/slack/.env` |
| Access policy | `~/.claude/channels/slack/access.json` |
| Inbox (downloaded files) | `~/.claude/channels/slack/inbox/` |
| Username cache | `~/.claude/channels/slack/username-cache.json` |
| Pairing approvals | `~/.claude/channels/slack/approved/` |

Override the directory root with `SLACK_STATE_DIR` (or the standard
`CLAUDE_CONFIG_DIR`).

## Tools

| Tool | Purpose |
| --- | --- |
| `reply` | Post a message; optional thread_ts + file attachments. |
| `bulk_reply` | Same plain-text to multiple channels (max 20). |
| `edit_message` | Edit a message the bot sent. |
| `react` | Add an emoji reaction (slack shortcode, not unicode). |
| `fetch_messages` | Channel history; pass thread_ts for thread replies. |
| `get_user_info` | Look up a slack user by U-id. |
| `download_attachment` | Download files from a message into the local inbox. |
| `pin_message` | Pin a message in a channel. |
| `send_voice_message` | Upload .ogg as a file (slack doesn't render bot audio as native voice msg). |
| `dunk` / `undunk` | Silence a channel (optionally still forward @mentions). |

## License

Apache-2.0 — see [LICENSE](./LICENSE).
