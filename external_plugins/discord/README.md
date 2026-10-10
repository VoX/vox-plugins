# Discord

Connect a Discord bot to your Claude Code with an MCP server.

When the bot receives a message, the MCP server forwards it to Claude and provides tools to reply, react, and edit messages.

## Prerequisites

- [Bun](https://bun.sh) — the MCP server runs on Bun. Install with `curl -fsSL https://bun.sh/install | bash`.

## Quick Setup
> Default pairing flow for a single-user DM bot. See [ACCESS.md](./ACCESS.md) for groups and multi-user setups.

**1. Create a Discord application and bot.**

Go to the [Discord Developer Portal](https://discord.com/developers/applications) and click **New Application**. Give it a name.

Navigate to **Bot** in the sidebar. Give your bot a username.

Scroll down to **Privileged Gateway Intents** and enable **Message Content Intent** — without this the bot receives messages with empty content.

**2. Generate a bot token.**

Still on the **Bot** page, scroll up to **Token** and press **Reset Token**. Copy the token — it's only shown once. Hold onto it for step 5.

**3. Invite the bot to a server.**

Discord won't let you DM a bot unless you share a server with it.

Navigate to **OAuth2** → **URL Generator**. Select the `bot` scope. Under **Bot Permissions**, enable:

- View Channels
- Send Messages
- Send Messages in Threads
- Read Message History
- Attach Files
- Add Reactions

Integration type: **Guild Install**. Copy the **Generated URL**, open it, and add the bot to any server you're in.

> For DM-only use you technically need zero permissions — but enabling them now saves a trip back when you want guild channels later.

**4. Install the plugin.**

These are Claude Code commands — run `claude` to start a session first.

Install the plugin:
```
/plugin install discord@claude-plugins-official
/reload-plugins
```

**5. Give the server the token.**

```
/discord:configure MTIz...
```

Writes `DISCORD_BOT_TOKEN=...` to `~/.claude/channels/discord/.env`. You can also write that file by hand, or set the variable in your shell environment — shell takes precedence.

> To run multiple bots on one machine (different tokens, separate allowlists), point `DISCORD_STATE_DIR` at a different directory per instance.

**6. Relaunch with the channel flag.**

The server won't connect without this — exit your session and start a new one:

```sh
claude --channels plugin:discord@claude-plugins-official
```

**7. Pair.**

With Claude Code running from the previous step, DM your bot on Discord — it replies with a pairing code. If the bot doesn't respond, make sure your session is running with `--channels`. In your Claude Code session:

```
/discord:access pair <code>
```

Your next DM reaches the assistant.

**8. Lock it down.**

Pairing is for capturing IDs. Once you're in, switch to `allowlist` so strangers don't get pairing-code replies. Ask Claude to do it, or `/discord:access policy allowlist` directly.

## Access control

See **[ACCESS.md](./ACCESS.md)** for DM policies, guild channels, mention detection, delivery config, skill commands, and the `access.json` schema.

Quick reference: IDs are Discord **snowflakes** (numeric — enable Developer Mode, right-click → Copy ID). Default policy is `pairing`. Guild channels are opt-in per channel ID.

## Tools exposed to the assistant

| Tool | Purpose |
| --- | --- |
| `reply` | Send to a channel. Takes `chat_id` + `text`, optionally `reply_to` (message ID) for native threading and `files` (absolute paths) for attachments — max 10 files, 25MB each. Auto-chunks; files attach to the first chunk. Returns the sent message ID(s). |
| `react` | Add an emoji reaction to a message. Takes `chat_id`, `message_id`, `emoji`. Unicode emoji work directly; custom emoji need `<:name:id>` form. |
| `edit_message` | Edit a message the bot previously sent. Takes `chat_id`, `message_id`, `text`. Useful for interim progress updates; edits don't trigger push notifications, so send a new `reply` when a long task completes. |
| `pin_message` | Pin a message in a channel. Takes `chat_id`, `message_id`. Requires Manage Messages permission. |
| `send_voice_message` | Send a Discord voice message (with waveform UI) from an Ogg/Opus audio file. Takes `chat_id`, `file` (absolute path to `.ogg` Opus), optional `reply_to`. |
| `typing` | Show "bot is typing…" in a channel until a message is sent. Takes `chat_id`. The assistant calls this when it decides an inbound message needs a response, before doing the work. |
| `fetch_messages` | Pull recent history from a channel (oldest-first). Capped at 100 per call. Each line includes the message ID so the model can `reply_to` it; messages with attachments are marked `+Natt`. Discord's search API isn't exposed to bots, so this is the only lookback. |
| `download_attachment` | Download all attachments from a specific message by ID to `~/.claude/channels/discord/inbox/`. Optional `dest_dir` copies files to a target directory. Returns file paths + metadata. Use when `fetch_messages` shows a message has attachments. |
| `lookup` | Resolve a channel or user **name** to its snowflake ID. Takes `query` (leading `#`/`@` stripped, case-insensitive substring), optional `kind` (`channel`/`user`/`both`), `guild_id` to narrow, `limit` (default 10, max 50). Exact name matches sort first. Needs **no permissions beyond the bridge's own** — channels come from the `Guilds` intent cache (which only ever contained channels the bot can see), and users are matched against the message cache first, falling back to Discord's member-search endpoint only when that misses. Finding a channel is **not** permission to post in it; the access allowlist still decides that. |
| `get_server_spec` | Read a guild's structure as a spec object: `everyone_permissions`, roles (name/color/hoist/mentionable/permissions/position — read-only), categories with their channels (name/kind/topic/slowmode/nsfw/overwrites), plus a `bot` section (its highest role, that role's raw position, the roles out of its reach, and which admin permissions it holds). Every entry carries its snowflake `id` for `apply_server_spec`'s rename/move matching. Read-only; output is exactly what `apply_server_spec` consumes. |
| `apply_server_spec` | Apply a server spec to a guild — additive upsert (create/update only, **never deletes** by default). Entries that keep their `id` are renamed/moved in place instead of recreated. `prune: true` turns the apply into a full reconcile that deletes unclaimed entities (never `@everyone`, managed roles, or the bot's own role). Renders a diff and DMs it to `DISCORD_OWNER_ID` with Allow/Deny buttons; blocks until they decide (5-min timeout = deny). `dry_run: true` returns the diff without approval or changes. Role order is set relationally with `above`/`below`. See [Server admin tools](#server-admin-tools). |

The `typing` tool lets the assistant show a typing indicator manually —
the bot does not auto-type on every inbound message (that made it look
like it was always responding, even when it wasn't).

## Attachments

Attachments are **not** auto-downloaded. The `<channel>` notification lists
each attachment's name, type, and size — the assistant calls
`download_attachment(chat_id, message_id)` when it actually wants the file.
Downloads land in `~/.claude/channels/discord/inbox/`.

Same path for attachments on historical messages found via `fetch_messages`
(messages with attachments are marked `+Natt`).

## Opt-in gate (`VOX_PLUGINS_ENABLED`)

The plugin is inert unless `VOX_PLUGINS_ENABLED=1` is set in the environment. Without it the MCP server still answers `initialize` and `tools/list` (so Claude Code's plugin registry stays happy), but exposes **zero tools**: no `.env` load, no discord.js gateway connection, no state writes, nothing. The process sits idle until shut down.

**Why this exists.** Claude Code auto-starts every registered plugin MCP server in every session. Without the gate, running a fresh `claude` session on the same machine as the bot's long-lived systemd service would spin up a **second** discord.js gateway connection using the same `DISCORD_BOT_TOKEN` — producing duplicate bot responses, racing writes to `access.json` / `dm_users.json`, and generally corrupting state. `VOX_PLUGINS_ENABLED` ensures only the one session you actually want to run the bot (typically your systemd unit) touches Discord; every other session sees a silent no-op plugin.

**How to opt in.** Set the env var in whatever launches your "live" session — most commonly a systemd unit:

```ini
[Service]
Environment=VOX_PLUGINS_ENABLED=1
```

Any other `claude` session on the box stays inert automatically.

## Permission prompts

Tool calls that trigger `permission_request` notifications get a Discord
DM with Allow / Deny / See more buttons, sent to everyone in the
allowlist. If no one answers within 30 s the request is auto-denied.

Set `DISCORD_AUTO_ALLOW_PERMISSIONS=1` to skip the DM entirely and
auto-approve every request. Intended for deployments where the gating
lives in the model's own rules (CLAUDE.md, persona instructions) rather
than the OS prompt layer. Default off. Every auto-allow writes
`permission_request <id> auto-allowed (DISCORD_AUTO_ALLOW_PERMISSIONS=1)
tool=<name>` to stderr for audit.

## Server admin tools

`get_server_spec` and `apply_server_spec` let the assistant read and shape a
guild's structure declaratively. There is no env gate and no guild scoping —
the tools are always present and work on any guild the bot is in; **approval
is the gate**.

**The spec.** A JSON object: `everyone_permissions` (permission-name array for
the `@everyone` role), `roles[]`, `categories[]` (each with `overwrites[]` and
`channels[]`), and top-level `channels[]` for channels outside any category.
Channel `kind` is `text` / `voice` / `announcement` / `forum` / `stage`.
Overwrite targets are `"@everyone"`, `"role:<Name>"`, or a raw snowflake with
`type: "role" | "member"`. Permission names are discord.js `PermissionFlagsBits`
keys (`ViewChannel`, `ManageMessages`, …); colors are hex or discord.js color
names.

**Role hierarchy.** Set order with `above` / `below` on a role — a name or a list
of names: `{ "name": "Owner", "above": "Moderator" }`. They refer to names as they
will be *after* this spec's creates and renames, so a spec that renames `Moderator`
to `op` must say `above: "op"`; an unresolvable or ambiguous name is an error rather
than a silent skip.

Role `position` is **read-only**. It is exported so you can see the hierarchy — and
it is the raw value Discord stores, so roles can and do tie on it. Supply it
unchanged (a round-tripped export stays a no-op) or leave it out; a *different*
value is an error pointing you at `above`/`below`. It is not a unit you could
reorder in even if it were writable: Discord treats a position in a partial write
as advisory (ask for 3, get 2 if 2 is the free slot) and renumbers the whole guild
to contiguous values on a complete one.

A reorder is **one all-or-nothing write**, applied after every other change in the
spec, and the bot can only move roles strictly below its own highest role — on both
ends of the move. `get_server_spec`'s `bot.roles_out_of_reach` lists the ones it
cannot touch.

**Additive semantics.** `apply_server_spec` diffs the spec against the live
guild and upserts: missing things are created, drifted spec-set fields are
updated, and anything the spec doesn't mention is *left untouched* — by
default the tool never deletes existing roles/channels. Fields omitted from a
spec entry aren't compared. Re-applying a matching spec yields an empty diff.

**Ids, renames, and moves.** `get_server_spec` emits each role/category/
channel's snowflake as an `id` field. Entries that keep their `id` are
matched by snowflake instead of name: change the entry's `name` and the live
entity is **renamed in place** (`setName`), move a channel under a different
category (or to top-level) and it's **moved** (`setParent`, keeping its own
permission overwrites) — never delete+create, so history, pins, and
permissions survive. The workflow: export with `get_server_spec`, edit names
and placement, apply — keep the ids. A stale or foreign id is a hint, not a
requirement: the entry falls back to name matching, then to create; unknown
ids never error. Id-less entries behave exactly as before (name matching).

**Prune (full reconcile).** `prune: true` makes the apply also **delete**
live roles/categories/channels no spec entry claims (an entity is claimed
when a spec entry carries its id, or — for id-less entries — matches its
name+location). Deletions run after all creates/updates/renames/moves, in
safe order: child channels → their now-empty categories → roles. Three
things can **never** be deleted, spec or no spec: `@everyone`, managed roles
(bot/integration/booster roles), and the bot's own role. Deletions Discord
itself blocks (e.g. a Community server's rules/updates channel) are reported
`✗` per entry without aborting the rest.

The rendered diff makes prunes loud: the header counts deletions first
(`⚠ 2 DELETIONS · 1 create · …`), each one renders as `- DELETE <entity>`,
and when deletions exceed the guard threshold (more than 5, or more than 50%
of the guild's channels) the diff carries a `⚠⚠ LARGE PRUNE` banner. The
banner is display-only — same single approval — but impossible to miss.

> **Footgun:** a partial hand-authored spec + `prune` = mass-delete of
> everything the spec omits. Always start from a fresh `get_server_spec`
> export when pruning. The opt-in flag, the owner-approval diff, and the
> banner exist to catch this — read the diff before clicking Allow.

**Owner approval.** Every mutating apply DMs the rendered diff (as a text
attachment) to the user in `DISCORD_OWNER_ID` with Allow / Deny buttons and
blocks the tool call until they answer; no answer within 5 minutes counts as
deny. Dangerous grants — Administrator, ManageGuild, ManageRoles,
ManageChannels, ManageWebhooks, KickMembers, BanMembers, MentionEveryone —
are flagged with ⚠ in the DM. `dry_run: true` skips approval and returns the
diff without changing anything. If `DISCORD_OWNER_ID` is unset the tool
refuses to mutate (fail-closed).

Set the owner's user snowflake in `~/.claude/channels/discord/.env`:

```
DISCORD_OWNER_ID=184695080709324800
```

While the call waits on the buttons it emits MCP progress notifications
(every 25 s) so the client's per-tool-call timeout doesn't kill it — this
requires the MCP client to send a `progressToken` with the call (Claude Code
does). If your client doesn't, raise `MCP_TOOL_TIMEOUT` above 5 minutes.

**`/access` slash command.** An owner-only Discord command mirroring the
grant/remove parts of the `/discord:access` skill — see
[ACCESS.md](./ACCESS.md#the-access-slash-command).

## Changelog

### 0.8.5
- **Server-wide access.** New optional `guilds` map in `access.json`, keyed on guild ID with the same `{requireMention, allowFrom}` shape as a `groups` entry. A guild channel with no entry of its own (threads use their parent's) falls back to its server's entry, so new channels and threads in a granted server work with no further grants; a channel's own entry always wins. Outbound tools use the same lookup, so a guild-granted channel is answerable, not just audible. `/access` gains `scope:channel|server` (default `channel` — existing invocations are unchanged) and `list` shows server grants; the skill gains `guild add|rm`. Files without `guilds` read exactly as before, and an empty `guilds` map is not written back. `/access grant|remove` typed inside a thread now acts on the parent channel (a thread-keyed entry was never read). See [ACCESS.md](./ACCESS.md#whole-servers).
- **Typed permission replies ("yes abcde") are accepted only from the top-level `allowFrom`**, the same people the Allow/Deny buttons accept. They used to be accepted from anyone who passed the inbound gate — in a channel with an empty `allowFrom`, everyone who could post there — and server grants would have widened that to whole servers. Anyone else's reply is delivered as ordinary chat.

### 0.7.1
- `lookup` hardened after an adversarial review. `guild_id` now really narrows the USER half (it silently searched every guild via the global user cache); an invalid `kind` errors instead of returning a blank success; the REST member-search fallback is gated PER GUILD rather than on the global result set (one junk substring hit anywhere suppressed the authoritative search everywhere, and since `members.search` caches, a stray match could poison it permanently); a pasted `<#123>`/`<@123>` mention or bare snowflake now resolves directly (Discord puts that literal in message content when you type `#general`, so the likeliest real input used to miss); trim runs before the `#`/`@` strip; queries and names are NFKD-normalised so NFC and NFD agree; `limit` is floored (a fractional one reached Discord as `?limit=2.7` and came back as a bogus "unavailable"); users report every shared guild rather than the first; an empty `guild_id` errors instead of failing open into an all-guild search; and search errors print after the rows they qualify. The pure half moved to `lib.ts` with tests.
- **Reverted from 0.7.0's unreleased sort:** ranking "postable" channel types first. Voice channels *are* sendable in v14 (`BaseGuildVoiceChannel` carries the text mixin), the branch list was written against non-existent enum aliases (`ChannelType[5]` is `GuildNews`, not `GuildAnnouncement`), and the one type it did match — `GuildForum` — is the single type that cannot take a message. Ordering is by name only; every row reports its type.

### 0.7.0
- New `lookup` tool: name → ID for channels and users, so "post that in #general" can be resolved without knowing snowflakes or dumping a whole `get_server_spec`. Verified against live guilds to need **no extra permissions or privileged intents** (`members/search` and `guilds/{id}/channels` both return 200 on the bridge's existing token). Cache-first for users — whoever has spoken is matched for free — with the REST member search as a fallback that degrades to "cached results only" rather than failing the call if an app is configured without it.

### 0.4.0
- `get_server_spec` now emits each role/category/channel's snowflake as `id`; `apply_server_spec` matches id-carrying entries by snowflake, so a changed name **renames** the live entity in place and a re-parented channel **moves** (`setParent`, own overwrites kept) — no more delete+create. Stale/foreign ids fall back to name matching, never error.
- New `apply_server_spec` `prune` flag (default off): full reconcile that deletes live entities the spec doesn't claim, ordered channels → empty categories → roles. `@everyone`, managed roles, and the bot's own role are never deleted. Diff header counts deletions first, each renders as `- DELETE`, and > 5 deletions (or > 50% of the guild's channels) adds a `⚠⚠ LARGE PRUNE` banner.

### 0.3.0
- New `get_server_spec` / `apply_server_spec` tools: read a guild's structure as a declarative spec; apply one additively with an owner-approved diff (Allow/Deny DM buttons, dangerous-grant ⚠ flags, `dry_run` preview). New `DISCORD_OWNER_ID` env var (fail-closed for mutations).
- New owner-only `/access` slash command: `grant` / `remove` / `list` guild-channel access from inside Discord (merge-preserves `allowFrom`, read-only reply in static mode).

### 0.2.18
- Harden gateway lifecycle: exit on `shardDisconnect` / `invalidated` / terminal `error`, log-only for `shardError`, plus a 30s-interval watchdog that exits after 3 consecutive non-READY `client.ws.status` checks (resets on inbound messages) so systemd restarts a silently dead socket.
