# Discord — Access & Delivery

Discord only allows DMs between accounts that share a server. Who can DM your bot depends on where it's installed: one private server means only that server's members can reach it; a public community means every member there can open a DM.

The **Public Bot** toggle in the Developer Portal (Bot tab, on by default) controls who can add the bot to new servers. Turn it off and only your own account can install it. This is your first gate, and it's enforced by Discord rather than by this process.

For DMs that do get through, the default policy is **pairing**. An unknown sender gets a 6-character code in reply and their message is dropped. You run `/discord:access pair <code>` from your assistant session to approve them. Once approved, their messages pass through.

All state lives in `~/.claude/channels/discord/access.json`. The `/discord:access` skill commands edit this file; the server re-reads it on every inbound message, so changes take effect without a restart. Set `DISCORD_ACCESS_MODE=static` to pin config to what was on disk at boot (pairing is unavailable in static mode since it requires runtime writes).

## At a glance

| | |
| --- | --- |
| Default policy | `pairing` |
| Sender ID | User snowflake (numeric, e.g. `184695080709324800`) |
| Group key | Channel snowflake — not guild ID |
| Guild key | Server snowflake — a whole-server grant (0.8.5+) |
| Config file | `~/.claude/channels/discord/access.json` |

## DM policies

`dmPolicy` controls how DMs from senders not on the allowlist are handled.

| Policy | Behavior |
| --- | --- |
| `pairing` (default) | Reply with a pairing code, drop the message. Approve with `/discord:access pair <code>`. |
| `allowlist` | Drop silently. No reply. Use this once everyone who needs access is already on the list, or if pairing replies would attract spam. |
| `disabled` | Drop everything, including allowlisted users and guild channels. |

```
/discord:access policy allowlist
```

## User IDs

Discord identifies users by **snowflakes**: permanent numeric IDs like `184695080709324800`. Usernames are mutable; snowflakes aren't. The allowlist stores snowflakes.

Pairing captures the ID automatically. To add someone manually, enable **User Settings → Advanced → Developer Mode** in Discord, then right-click any user and choose **Copy User ID**. Your own ID is available by right-clicking your avatar in the lower-left.

```
/discord:access allow 184695080709324800
/discord:access remove 184695080709324800
```

## Guild channels

Guild channels are off by default. Opt each one in individually, keyed on the **channel** snowflake (not the guild). Threads inherit their parent channel's opt-in; no separate entry needed. Find channel IDs the same way as user IDs: Developer Mode, right-click the channel, Copy Channel ID.

```
/discord:access group add 846209781206941736
```

With the default `requireMention: true`, the bot responds only when @mentioned or replied to. Pass `--no-mention` to process every message in the channel, or `--allow id1,id2` to restrict which members can trigger it.

```
/discord:access group add 846209781206941736 --no-mention
/discord:access group add 846209781206941736 --allow 184695080709324800,221773638772129792
/discord:access group rm 846209781206941736
```

## Whole servers

To cover every channel in a server — including channels and threads created later — grant the **guild** instead, keyed on the server snowflake (Developer Mode, right-click the server icon, Copy Server ID). It takes the same flags as a channel grant.

```
/discord:access guild add 1155098001112342528
/discord:access guild add 1155098001112342528 --no-mention --allow 184695080709324800
/discord:access guild rm 1155098001112342528
```

Lookup order for a message in a guild channel: the channel's own `groups` entry (a thread uses its parent channel's), then its server's `guilds` entry, then drop. **A channel entry wins outright** — fields are not merged — so you can make one channel stricter or looser than the server default by giving it its own entry. Removing a channel's entry does *not* exclude it from a granted server; to quiet one channel inside a granted server, give it a stricter entry (e.g. `--allow` a single ID) or `/dunk` it.

The outbound tools (`reply`, `react`, `edit_message`, `fetch_messages`, …) follow the same lookup, so any channel the bot can hear in a granted server is one it can answer in. A server entry's `allowFrom` and `requireMention` are inbound rules only.

## The /access slash command

`/access` manages guild-channel access from inside Discord — no terminal
needed. It is **owner-only**: the handler compares the invoking user against
`DISCORD_OWNER_ID` (set it in `~/.claude/channels/discord/.env`) and refuses
everyone else, including allowlisted users. With `DISCORD_OWNER_ID` unset the
command refuses everyone (fail-closed). As of 0.8.2 the command registers with
**no** `default_member_permissions` and no `dm_permission`, so Discord shows it
to everyone everywhere — the handler is the only gate, and it is the only gate
that ever mattered. It was previously registered with `default_member_permissions: "0"`,
which hid it from non-admins and therefore hid it from the owner himself on any
guild he does not administer.

| Usage | Effect |
| --- | --- |
| `/access action:list` | Show `dmPolicy`, every granted server and every granted channel, each with its `requireMention` / `allowFrom`. |
| `/access action:grant` | Grant the current channel (or `channel:` option). `mentions_only` sets `requireMention` (default `true`). Re-granting updates `requireMention` but **preserves** any existing `allowFrom` restriction. |
| `/access action:remove` | Remove the channel's grant. If the server is also granted, the reply warns that the channel is still covered. |
| `/access action:grant scope:server` | Grant the **whole server the command is run in** — every channel and thread, present and future. Same `mentions_only` option and the same merge behaviour. Refused in DMs and when combined with `channel:` or `user:`. |
| `/access action:remove scope:server` | Remove the server-wide grant. Channels with their own entries keep working, and the reply says how many. |

`scope` defaults to `channel`, so every invocation from before 0.8.5 means what it did. The server is always the one the command is typed in — it is not an option — so a grant can only ever target the server you are looking at. There is no slash-command option for a server entry's `allowFrom`, exactly as there is none for a channel's; set it with `/discord:access guild add … --allow`.

Replies are ephemeral. Writes go through the same lock + atomic-save path as
the `/discord:access` skill. In static mode (`DISCORD_ACCESS_MODE=static`)
`grant`/`remove` reply that access is read-only instead of silently no-oping;
`list` still works (showing the boot snapshot).

## Mention detection

In channels with `requireMention: true`, any of the following triggers the bot:

- A structured `@botname` mention (typed via Discord's autocomplete)
- A reply to one of the bot's recent messages
- A match against any regex in `mentionPatterns`

Example regex setup for a nickname trigger:

```
/discord:access set mentionPatterns '["^hey claude\\b", "\\bassistant\\b"]'
```

## Delivery

Configure outbound behavior with `/discord:access set <key> <value>`.

**`ackReaction`** reacts to inbound messages on receipt as a "seen" acknowledgment. Unicode emoji work directly; custom server emoji require the full `<:name:id>` form. The emoji ID is at the end of the URL when you right-click the emoji and copy its link. Empty string disables.

```
/discord:access set ackReaction 🔨
/discord:access set ackReaction ""
```

**`replyToMode`** controls threading on chunked replies. When a long response is split, `first` (default) threads only the first chunk under the inbound message; `all` threads every chunk; `off` sends all chunks standalone.

**`textChunkLimit`** sets the split threshold. Discord rejects messages over 2000 characters, which is the hard ceiling. Long replies always split at the latest whitespace boundary under the limit (paragraph → line → space → hard cut) so `<@userid>` mentions, URLs, and code fences stay intact across chunks.

## Skill reference

| Command | Effect |
| --- | --- |
| `/discord:access` | Print current state: policy, allowlist, pending pairings, enabled channels. |
| `/discord:access pair a4f91c` | Approve pairing code `a4f91c`. Adds the sender to `allowFrom` and sends a confirmation on Discord. |
| `/discord:access deny a4f91c` | Discard a pending code. The sender is not notified. |
| `/discord:access allow 184695080709324800` | Add a user snowflake directly. |
| `/discord:access remove 184695080709324800` | Remove from the allowlist. |
| `/discord:access policy allowlist` | Set `dmPolicy`. Values: `pairing`, `allowlist`, `disabled`. |
| `/discord:access group add 846209781206941736` | Enable a guild channel. Flags: `--no-mention`, `--allow id1,id2`. |
| `/discord:access group rm 846209781206941736` | Disable a guild channel. |
| `/discord:access guild add 1155098001112342528` | Enable every channel in a server. Flags: `--no-mention`, `--allow id1,id2`. |
| `/discord:access guild rm 1155098001112342528` | Remove a server-wide grant. |
| `/discord:access set ackReaction 🔨` | Set a config key: `ackReaction`, `replyToMode`, `textChunkLimit`, `mentionPatterns`. |

## Config file

`~/.claude/channels/discord/access.json`. Absent file is equivalent to `pairing` policy with empty lists, so the first DM triggers pairing.

```jsonc
{
  // Handling for DMs from senders not in allowFrom.
  "dmPolicy": "pairing",

  // User snowflakes allowed to DM.
  "allowFrom": ["184695080709324800"],

  // Guild channels the bot is active in. Empty object = DM-only.
  "groups": {
    "846209781206941736": {
      // true: respond only to @mentions and replies.
      "requireMention": true,
      // Restrict triggers to these senders. Empty = any member (subject to requireMention).
      "allowFrom": []
    }
  },

  // Whole servers, keyed on GUILD id (optional; absent = {}). Covers every
  // channel and thread in the server unless it has its own "groups" entry,
  // which wins. Same fields as a "groups" entry.
  "guilds": {
    "1155098001112342528": { "requireMention": true, "allowFrom": [] }
  },

  // Case-insensitive regexes that count as a mention.
  "mentionPatterns": ["^hey claude\\b"],

  // Reaction on receipt. Empty string disables.
  "ackReaction": "👀",

  // Threading on chunked replies: first | all | off
  "replyToMode": "first",

  // Split threshold. Discord rejects > 2000. Long replies always split
  // at the latest whitespace boundary under the limit to keep mentions,
  // URLs, and code fences intact across chunks.
  "textChunkLimit": 2000
}
```
