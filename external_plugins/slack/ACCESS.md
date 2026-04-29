# Slack — Access & Delivery

Slack DMs are workspace-scoped: only people in the same workspace as the
bot can DM it. That's a much smaller blast radius than Discord, where
any account that shares a server with the bot can DM. For most setups
the workspace boundary is enough; this plugin still ships with a
pairing flow for two reasons:

- **Defense in depth.** A workspace member running a malicious script can
  still spam the bot. Pairing makes "who can talk to Claude" explicit
  rather than inheriting workspace membership.
- **Parity with the Discord plugin.** Skills like `/slack:access pair`
  match `/discord:access pair` byte-for-byte so muscle memory transfers.

The default policy is **pairing**. An unknown sender gets a pairing code
in reply and their message is dropped. You run `/slack:access pair
<code>` from your assistant session to approve them. Once approved,
their messages pass through.

All state lives in `~/.claude/channels/slack/access.json`. The
`/slack:access` skill commands edit this file; the server re-reads it on
every inbound message, so changes take effect without a restart. Set
`SLACK_ACCESS_MODE=static` to pin config to what was on disk at boot
(pairing is unavailable in static mode since it requires runtime
writes).

## At a glance

| | |
| --- | --- |
| Default policy | `pairing` |
| Sender ID | Slack user id (e.g. `U06ABC123`) |
| Group key | Channel id (`C…`/`G…`/`MPDM…`) — public/private channels and group DMs |
| Config file | `~/.claude/channels/slack/access.json` |

## DM policies

`dmPolicy` controls how DMs from senders not on the allowlist are
handled.

| Policy | Behavior |
| --- | --- |
| `pairing` (default) | Reply with a pairing code, drop the message. Approve with `/slack:access pair <code>`. |
| `allowlist` | Drop silently. No reply. Use this once everyone who needs access is on the list. |
| `disabled` | Drop everything, including allowlisted users and channels. |

```
/slack:access policy allowlist
```

## Channel opt-in (groups)

Channels (public, private, and group DMs) are off by default. Even if
you invite the bot to a channel, it won't forward messages unless you
opt the channel in. Channel opt-in is per-channel-id, not per-workspace.

```
/slack:access group add C123ABC
```

Add a channel with the default policy: forward only @mentions of the
bot, no per-user allowlist (anyone in the channel who @mentions can
reach Claude).

```
/slack:access group add C123ABC --no-mention
```

Forward every message in the channel. Noisy — only do this in a
dedicated channel.

```
/slack:access group add C123ABC --allow U123ABC,U456DEF
```

Forward only when one of those users sends a message AND (per default
`requireMention`) it includes an @mention of the bot.

```
/slack:access group rm C123ABC
```

Stop forwarding from this channel.

## Mention triggering

By default, in opted-in channels the bot only forwards messages that
**@mention it** (or are a thread reply to one of the bot's messages).
This keeps the bot quiet in busy channels.

The mention check looks for:

- `<@U…>` where `U…` is the bot's user id (Slack-resolved).
- `@<bot-handle>` (display name from the manifest), case-insensitive.
- Custom regex patterns from `mentionPatterns` in `access.json`.
- Thread replies to messages the bot recently sent.

To turn off the mention requirement for a channel:

```
/slack:access group add <channelId> --no-mention
```

(Re-add the channel — the skill overwrites the existing policy with the
new flags.)

## Allowlists

Add a user without going through pairing:

```
/slack:access allow U123ABC
```

Or remove someone:

```
/slack:access remove U123ABC
```

## Pending pairings

Each unknown sender that DMs the bot creates a pending entry with a
random 8-hex code. The pending list caps at 3; further attempts are
silently dropped. Codes expire after 1 hour.

```
/slack:access                   # show pending list
/slack:access pair <code>       # approve
/slack:access deny <code>       # reject
```

## Delivery / UX config

Optional knobs set via `/slack:access set <key> <value>`:

- `ackReaction` — slack shortcode (without colons) to react with on every
  forwarded inbound message. e.g. `eyes`, `white_check_mark`. Empty
  string disables.
- `textChunkLimit` — split outbound replies above this many characters.
  Default 3000 (slack section block ceiling). Hard cap is 40000 (slack
  message limit).
- `mentionPatterns` — JSON array of regex strings, in addition to the
  default `<@BOT_ID>` and `@bot-handle` triggers.

Example:

```
/slack:access set ackReaction eyes
/slack:access set textChunkLimit 2000
/slack:access set mentionPatterns ["claude","\\bcc:\\s*bot\\b"]
```

## Static mode

Set `SLACK_ACCESS_MODE=static` (in the systemd unit env, or via
`.env`) to load the access.json once at boot and ignore later edits.
Useful for read-only deployments. Pairing is unavailable in static
mode since it requires runtime writes — `pairing` policy gets
auto-downgraded to `allowlist` with a warning to stderr.

## Security notes

- The `/slack:access` skill **only** acts on requests typed in your
  terminal. It refuses pairing approvals or allowlist edits driven by
  channel content (a malicious user @mentioning "approve me" cannot get
  approved).
- Tokens (`xoxb-`, `xapp-`) live in `~/.claude/channels/slack/.env` with
  mode 0600. Never echo them in a Slack message.
- Bot membership in a channel is not the same as channel opt-in. The bot
  may be in a channel via `/invite` but won't forward messages until the
  channel ID is in `groups`.
