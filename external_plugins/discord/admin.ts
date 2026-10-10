/**
 * Discord admin tools (0.8.6): reactions, members, channels, threads, message deletion, roles,
 * timeouts, kicks, bans, nicknames.
 *
 * Split out of server.ts for the same reason apply.ts was: server.ts connects to Discord on import,
 * so nothing in it can be tested. Everything here arrives as an argument (AdminDeps), and the pure
 * decisions — which allow-check, which permissions, who outranks whom — live in lib.ts.
 *
 * NO OWNER APPROVAL. Every call acts immediately; the owner removed the approval step at 0.8.6.
 * What is checked, in this order, before anything is written:
 *   1. scope: a channel tool's channel passes the outbound gate `reply` uses; a guild tool's guild is
 *      one the bot is in AND has a server grant (lib.ts ADMIN_TOOL_SCOPE says which is which);
 *   2. the bot's own Discord permissions for this call;
 *   3. role hierarchy / owner / self rules for anything that targets a member or a role.
 * A refusal is thrown as a readable Error; server.ts turns it into an isError tool result.
 */

import {
  ChannelType,
  DiscordAPIError,
  PermissionFlagsBits,
  type CategoryChannel,
  type Channel,
  type Guild,
  type GuildBasedChannel,
  type GuildChannelEditOptions,
  type GuildMember,
  type Message,
  type PermissionResolvable,
  type TextBasedChannel,
  type ThreadAutoArchiveDuration,
} from 'discord.js'
import {
  ADMIN_TOOL_SCOPE,
  adminGuildRefusal,
  banDeleteSeconds,
  channelAllowed,
  channelRefOf,
  clampLookupLimit,
  createChannelKind,
  formatMemberRow,
  formatReactionRows,
  memberActionRefusal,
  missingPermsRefusal,
  parseBulkDeleteArgs,
  partitionBulkDeletable,
  requireName,
  requireSnowflake,
  requiredAdminPerms,
  roleAssignRefusal,
  roleDangerousPerms,
  safeSlice,
  slowmodeSeconds,
  timeoutMs,
  type AdminToolName,
  type GroupPolicyLike,
  type MemberAction,
  type MemberRowInput,
  type RankedRole,
  type ReactionRowInput,
} from './lib'

export type AdminDeps = {
  /** This bot's user id. */
  botUserId: string
  /** access.json as the gate reads it. Only groups/guilds are consulted here. */
  loadAccess(): { groups?: Record<string, GroupPolicyLike> | null; guilds?: Record<string, GroupPolicyLike> | null }
  /** client.guilds.cache.get — undefined means the bot is not in that guild. */
  getGuild(id: string): Guild | undefined
  /** client.channels.fetch with NO allow-check. Every caller below applies one before acting. */
  fetchChannel(id: string): Promise<Channel | null>
  /** server.ts fetchAllowedChannel: the exact outbound gate reply/react/fetch_messages use. */
  fetchAllowedChannel(id: string): Promise<TextBasedChannel>
  now?(): number
}

// ── tool schemas (ListTools) ──────────────────────────────────────────────────────────────────────

const REASON = { type: 'string', description: 'Optional audit-log reason.' } as const

export const ADMIN_TOOL_DEFS: Array<{ name: AdminToolName; description: string; inputSchema: Record<string, unknown> }> = [
  {
    name: 'fetch_reactions',
    description: 'List the reactions on a message: each emoji, its count, whether this bot reacted, and optionally up to users_limit users who reacted with it. Read-only. The channel must be one reply could post in.',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: { type: 'string' },
        message_id: { type: 'string' },
        users_limit: { type: 'number', description: 'Also list up to this many reacting users per emoji (0-100, default 0 = counts only).' },
      },
      required: ['chat_id', 'message_id'],
    },
  },
  {
    name: 'get_member',
    description: 'Read one member of a server: username, display name, nickname, roles (name + id, highest first), join date, timeout state. Read-only. Guild-scoped: the server needs a server grant.',
    inputSchema: {
      type: 'object',
      properties: { guild_id: { type: 'string' }, user_id: { type: 'string' } },
      required: ['guild_id', 'user_id'],
    },
  },
  {
    name: 'list_members',
    description: 'List members of a server with roles, nickname, join date and timeout state. With query, a username/nickname PREFIX search. Without query, the first `limit` members by id — that needs the app\'s Server Members privileged intent; if Discord refuses, pass a query. Read-only. Guild-scoped: the server needs a server grant.',
    inputSchema: {
      type: 'object',
      properties: {
        guild_id: { type: 'string' },
        limit: { type: 'number', description: 'Max members (default 50, max 1000).' },
        query: { type: 'string', description: 'Optional username/nickname prefix.' },
      },
      required: ['guild_id'],
    },
  },
  {
    name: 'create_channel',
    description: 'Create a text, voice or category channel in a server, optionally under a category and with a topic (text only). Applies immediately. Guild-scoped: the server needs a server grant, which also makes the new channel reachable by reply.',
    inputSchema: {
      type: 'object',
      properties: {
        guild_id: { type: 'string' },
        name: { type: 'string' },
        kind: { type: 'string', enum: ['text', 'voice', 'category'] },
        parent_id: { type: 'string', description: 'Category to create it under (not for kind=category).' },
        topic: { type: 'string', description: 'Topic (text channels only, max 1024).' },
        reason: REASON,
      },
      required: ['guild_id', 'name', 'kind'],
    },
  },
  {
    name: 'edit_channel',
    description: 'Edit a channel or category: name, topic, parent category, slowmode (seconds), nsfw. Only the fields you pass change. parent_id "" moves it out of its category. Applies immediately. Not for threads. The channel must be allowlisted (a channel or server grant).',
    inputSchema: {
      type: 'object',
      properties: {
        channel_id: { type: 'string' },
        name: { type: 'string' },
        topic: { type: 'string', description: 'New topic; "" clears it.' },
        parent_id: { type: 'string', description: 'Category id to move it under; "" for no category.' },
        slowmode: { type: 'number', description: 'Seconds between messages per user, 0-21600.' },
        nsfw: { type: 'boolean' },
        reason: REASON,
      },
      required: ['channel_id'],
    },
  },
  {
    name: 'delete_channel',
    description: 'Delete a channel, category or thread. IRREVERSIBLE and applies immediately — no approval step. Deleting a category leaves its channels uncategorised. Guild-scoped: the server needs a server grant (a channel grant is not enough).',
    inputSchema: {
      type: 'object',
      properties: { channel_id: { type: 'string' }, reason: REASON },
      required: ['channel_id'],
    },
  },
  {
    name: 'create_thread',
    description: 'Start a public thread in a text or announcement channel, from a message (message_id) or standalone. The thread inherits the channel\'s grant, so reply works in it. Applies immediately.',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: { type: 'string', description: 'The parent channel.' },
        name: { type: 'string' },
        message_id: { type: 'string', description: 'Optional message to start the thread from.' },
        auto_archive_minutes: { type: 'number', enum: [60, 1440, 4320, 10080] },
      },
      required: ['chat_id', 'name'],
    },
  },
  {
    name: 'delete_message',
    description: 'Delete one message. The bot\'s own messages need no permission; anyone else\'s need Manage Messages (and are impossible in DMs). Applies immediately.',
    inputSchema: {
      type: 'object',
      properties: { chat_id: { type: 'string' }, message_id: { type: 'string' } },
      required: ['chat_id', 'message_id'],
    },
  },
  {
    name: 'bulk_delete',
    description: 'Delete many messages in one server channel: either the latest `count` (1-100) or the listed message_ids (up to 100). Messages older than 14 days cannot be bulk-deleted and are skipped and listed. Returns every deleted id. Applies immediately — no approval step.',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: { type: 'string' },
        count: { type: 'number', description: 'Delete the latest N messages (1-100).' },
        message_ids: { type: 'array', items: { type: 'string' }, description: 'Specific message ids (max 100).' },
      },
      required: ['chat_id'],
    },
  },
  {
    name: 'add_role',
    description: 'Give a member a role. The role must sit below the bot\'s highest role and not be managed. A role carrying dangerous permissions (Administrator, ManageGuild, ManageRoles, BanMembers, …) is flagged ⚠ in the result — informational, it still applies immediately. Guild-scoped: the server needs a server grant.',
    inputSchema: {
      type: 'object',
      properties: { guild_id: { type: 'string' }, user_id: { type: 'string' }, role_id: { type: 'string' }, reason: REASON },
      required: ['guild_id', 'user_id', 'role_id'],
    },
  },
  {
    name: 'remove_role',
    description: 'Take a role from a member. Same hierarchy rules and ⚠ flag as add_role. Applies immediately. Guild-scoped: the server needs a server grant.',
    inputSchema: {
      type: 'object',
      properties: { guild_id: { type: 'string' }, user_id: { type: 'string' }, role_id: { type: 'string' }, reason: REASON },
      required: ['guild_id', 'user_id', 'role_id'],
    },
  },
  {
    name: 'timeout_member',
    description: 'Time a member out for `minutes` (max 40320 = 28 days); 0 lifts an existing timeout. Administrators, the server owner and members at or above the bot\'s role cannot be timed out. Applies immediately. Guild-scoped: the server needs a server grant.',
    inputSchema: {
      type: 'object',
      properties: { guild_id: { type: 'string' }, user_id: { type: 'string' }, minutes: { type: 'number' }, reason: REASON },
      required: ['guild_id', 'user_id', 'minutes'],
    },
  },
  {
    name: 'kick_member',
    description: 'Kick a member from a server. Applies immediately — no approval step. The server owner and members at or above the bot\'s role cannot be kicked. Guild-scoped: the server needs a server grant.',
    inputSchema: {
      type: 'object',
      properties: { guild_id: { type: 'string' }, user_id: { type: 'string' }, reason: REASON },
      required: ['guild_id', 'user_id'],
    },
  },
  {
    name: 'ban_member',
    description: 'Ban a user from a server (works on non-members by id), optionally deleting their last delete_message_seconds (max 604800 = 7 days) of messages. Applies immediately — no approval step. Guild-scoped: the server needs a server grant.',
    inputSchema: {
      type: 'object',
      properties: {
        guild_id: { type: 'string' },
        user_id: { type: 'string' },
        reason: REASON,
        delete_message_seconds: { type: 'number', description: '0-604800 seconds of their recent messages to delete (default 0).' },
      },
      required: ['guild_id', 'user_id'],
    },
  },
  {
    name: 'unban_member',
    description: 'Lift a ban. Applies immediately. Guild-scoped: the server needs a server grant.',
    inputSchema: {
      type: 'object',
      properties: { guild_id: { type: 'string' }, user_id: { type: 'string' }, reason: REASON },
      required: ['guild_id', 'user_id'],
    },
  },
  {
    name: 'set_nickname',
    description: 'Set a member\'s server nickname ("" clears it). The bot\'s own needs Change Nickname; anyone else\'s needs Manage Nicknames and a target below the bot\'s role. Applies immediately. Guild-scoped: the server needs a server grant.',
    inputSchema: {
      type: 'object',
      properties: { guild_id: { type: 'string' }, user_id: { type: 'string' }, nick: { type: 'string' }, reason: REASON },
      required: ['guild_id', 'user_id', 'nick'],
    },
  },
]

// ── helpers ───────────────────────────────────────────────────────────────────────────────────────

const AUTO_ARCHIVE = [60, 1440, 4320, 10080]

// Which channel types carry each editable field, per Discord's channel object. Decided by TYPE, not by
// `'topic' in ch`: discord.js only assigns those properties when the payload carried them, so a
// presence test reads the last packet rather than what the channel supports.
const HAS_TOPIC = new Set<ChannelType>([ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum, ChannelType.GuildMedia])
const HAS_SLOWMODE = new Set<ChannelType>([ChannelType.GuildText, ChannelType.GuildVoice, ChannelType.GuildStageVoice, ChannelType.GuildForum, ChannelType.GuildMedia])
const HAS_NSFW = new Set<ChannelType>([ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildVoice, ChannelType.GuildStageVoice, ChannelType.GuildForum, ChannelType.GuildMedia])

function optReason(v: unknown): string | undefined {
  if (v === undefined || v === null || v === '') return undefined
  if (typeof v !== 'string') throw new Error('reason must be a string')
  return safeSlice(v, 512)
}

/** Discord's codes, translated. The pre-checks catch the common cases; this covers what slips past
 *  them (a channel overwrite denying a permission the role grants, a race, a stale id). */
export function explainAdminError(err: unknown): string {
  if (err instanceof DiscordAPIError) {
    const known: Record<number, string> = {
      50013: 'Missing Permissions — Discord refused it; a channel permission overwrite or the role hierarchy is blocking the bot',
      50001: 'Missing Access — the bot cannot see that channel or resource',
      10003: 'Unknown Channel — no channel with that id is visible to the bot',
      10007: 'Unknown Member — that user is not in the server',
      10008: 'Unknown Message — no message with that id in that channel',
      10011: 'Unknown Role — no role with that id in the server',
      10013: 'Unknown User — no user with that id',
      10026: 'Unknown Ban — that user is not banned',
      50034: 'a message is older than 14 days and cannot be bulk-deleted',
      50035: 'Discord rejected a field value',
    }
    return `${known[Number(err.code)] ?? err.message} (Discord error ${err.code}${known[Number(err.code)] ? `: ${err.message}` : ''})`
  }
  return err instanceof Error ? err.message : String(err)
}

function channelLabel(ch: { id: string; isDMBased(): boolean; name?: string | null }): string {
  return ch.isDMBased() ? `DM (${ch.id})` : `#${ch.name ?? '?'} (${ch.id})`
}

function guildLabel(g: Guild): string {
  return `${JSON.stringify(g.name)} (${g.id})`
}

function rank(r: { id: string; name: string; rawPosition: number }): RankedRole {
  return { id: r.id, name: r.name, rawPosition: r.rawPosition }
}

async function botMember(guild: Guild): Promise<GuildMember> {
  return guild.members.me ?? await guild.members.fetchMe()
}

/** Guild scope: the bot is in the guild AND it has a server grant. Then the bot's member, for checks. */
async function grantedGuild(deps: AdminDeps, guildIdRaw: unknown, tool: AdminToolName): Promise<{ guild: Guild; me: GuildMember }> {
  const guildId = requireSnowflake(guildIdRaw, 'guild_id')
  const guild = deps.getGuild(guildId)
  const refusal = adminGuildRefusal(deps.loadAccess(), guildId, guild ? guild.name : null, tool)
  if (refusal || !guild) throw new Error(refusal ?? `bot is not in guild ${guildId}`)
  return { guild, me: await botMember(guild) }
}

function requireGuildPerms(me: GuildMember, tool: AdminToolName, guild: Guild, ctx: Parameters<typeof requiredAdminPerms>[1] = {}): void {
  const r = missingPermsRefusal(requiredAdminPerms(tool, ctx), p => me.permissions.has(p as PermissionResolvable), `in ${guildLabel(guild)}`)
  if (r) throw new Error(r)
}

async function requireChannelPerms(ch: GuildBasedChannel, tool: AdminToolName, ctx: Parameters<typeof requiredAdminPerms>[1] = {}): Promise<GuildMember> {
  const me = await botMember(ch.guild)
  const perms = ch.permissionsFor(me)
  const r = missingPermsRefusal(requiredAdminPerms(tool, ctx), p => perms?.has(p as PermissionResolvable) ?? false, `in #${ch.name} (${ch.id})`)
  if (r) throw new Error(r)
  return me
}

async function fetchMemberOrNull(guild: Guild, userId: string): Promise<GuildMember | null> {
  try {
    return await guild.members.fetch(userId)
  } catch (err) {
    if (err instanceof DiscordAPIError && (err.code === 10007 || err.code === 10013)) return null
    throw err
  }
}

async function requireMember(guild: Guild, userId: string): Promise<GuildMember> {
  const m = await fetchMemberOrNull(guild, userId)
  if (!m) throw new Error(`user ${userId} is not a member of ${guildLabel(guild)}`)
  return m
}

function memberLabel(m: { id: string; user: { username: string } }): string {
  return `${JSON.stringify(m.user.username)} (${m.id})`
}

function memberTarget(m: GuildMember) {
  return {
    id: m.id,
    name: m.user.username,
    highest: rank(m.roles.highest),
    isAdministrator: m.permissions.has(PermissionFlagsBits.Administrator),
  }
}

function moderationRefusal(action: MemberAction, guild: Guild, me: GuildMember, target: Parameters<typeof memberActionRefusal>[2]): void {
  const r = memberActionRefusal(action, { botId: me.id, guildOwnerId: guild.ownerId, botHighest: rank(me.roles.highest) }, target)
  if (r) throw new Error(r)
}

function memberRow(m: GuildMember, guild: Guild): MemberRowInput {
  return {
    id: m.id,
    username: m.user.username,
    displayName: m.displayName,
    nickname: m.nickname ?? null,
    bot: m.user.bot,
    joinedAt: m.joinedAt ?? null,
    roles: [...m.roles.cache.values()]
      .filter(r => r.id !== guild.id)
      .sort((a, b) => b.rawPosition - a.rawPosition)
      .map(r => ({ name: r.name, id: r.id })),
    timedOutUntil: m.communicationDisabledUntil ?? null,
    isOwner: m.id === guild.ownerId,
  }
}

function oneLine(s: string, n: number): string {
  return JSON.stringify(safeSlice(s.replace(/[\r\n]+/g, ' ⏎ '), n))
}

// ── dispatch ─────────────────────────────────────────────────────────────────────────────────────

export async function runAdminTool(tool: AdminToolName, args: Record<string, unknown>, deps: AdminDeps): Promise<string> {
  // Belt and braces: a tool name that reached here without a scope entry must not run unchecked.
  if (!Object.hasOwn(ADMIN_TOOL_SCOPE, tool)) throw new Error(`internal: ${tool} has no admin scope`)
  try {
    return await dispatch(tool, args, deps)
  } catch (err) {
    throw new Error(explainAdminError(err))
  }
}

async function dispatch(tool: AdminToolName, args: Record<string, unknown>, deps: AdminDeps): Promise<string> {
  const now = deps.now?.() ?? Date.now()
  switch (tool) {
    // ── channel-scoped: the channel passes the reply gate ──
    case 'fetch_reactions': {
      const chatId = requireSnowflake(args.chat_id, 'chat_id')
      const messageId = requireSnowflake(args.message_id, 'message_id')
      const usersLimit = args.users_limit === undefined || args.users_limit === null ? 0 : clampLookupLimit(args.users_limit, 0, 100)
      const ch = await deps.fetchAllowedChannel(chatId)
      if (!ch.isDMBased()) await requireChannelPerms(ch, tool)
      const msg = await ch.messages.fetch(messageId)
      const rows: ReactionRowInput[] = []
      for (const r of msg.reactions.cache.values()) {
        const row: ReactionRowInput = { emoji: String(r.emoji), count: r.count ?? 0, me: r.me }
        if (usersLimit > 0) {
          const users = await r.users.fetch({ limit: usersLimit })
          row.users = [...users.values()].map(u => ({ id: u.id, username: u.username }))
        }
        rows.push(row)
      }
      return `reactions on ${messageId} in ${channelLabel(ch)}:\n${formatReactionRows(rows)}`
    }

    case 'create_thread': {
      const chatId = requireSnowflake(args.chat_id, 'chat_id')
      const name = requireName(args.name, 'name', 100)
      const messageId = args.message_id === undefined || args.message_id === null || args.message_id === ''
        ? null : requireSnowflake(args.message_id, 'message_id')
      let autoArchive: ThreadAutoArchiveDuration | undefined
      if (args.auto_archive_minutes !== undefined && args.auto_archive_minutes !== null) {
        if (!AUTO_ARCHIVE.includes(args.auto_archive_minutes as number)) {
          throw new Error(`auto_archive_minutes must be one of ${AUTO_ARCHIVE.join(', ')}, got ${JSON.stringify(args.auto_archive_minutes)}`)
        }
        autoArchive = args.auto_archive_minutes as ThreadAutoArchiveDuration
      }
      const ch = await deps.fetchAllowedChannel(chatId)
      if (ch.isDMBased()) throw new Error('threads exist only in server channels, not DMs')
      if (ch.isThread()) throw new Error(`${channelLabel(ch)} is already a thread — pass its parent channel`)
      if (ch.type !== ChannelType.GuildText && ch.type !== ChannelType.GuildAnnouncement) {
        throw new Error(`${channelLabel(ch)} is a ${ChannelType[ch.type]} channel; threads can be started only in text or announcement channels`)
      }
      await requireChannelPerms(ch, tool)
      let thread: { id: string; name: string }
      if (messageId) {
        const msg = await ch.messages.fetch(messageId)
        if (msg.hasThread) throw new Error(`message ${messageId} already has a thread (${msg.thread?.id ?? 'unknown id'})`)
        thread = await msg.startThread({ name, ...(autoArchive ? { autoArchiveDuration: autoArchive } : {}) })
      } else {
        thread = await ch.threads.create({ name, ...(autoArchive ? { autoArchiveDuration: autoArchive } : {}) })
      }
      return `created thread ${JSON.stringify(thread.name)} (id: ${thread.id}) in ${channelLabel(ch)}${messageId ? ` from message ${messageId}` : ''} — it inherits the parent's grant, so reply works there`
    }

    case 'delete_message': {
      const chatId = requireSnowflake(args.chat_id, 'chat_id')
      const messageId = requireSnowflake(args.message_id, 'message_id')
      const ch = await deps.fetchAllowedChannel(chatId)
      const msg: Message = await ch.messages.fetch(messageId)
      const own = msg.author.id === deps.botUserId
      if (!own) {
        if (ch.isDMBased()) throw new Error('in a DM the bot can delete only its own messages')
        await requireChannelPerms(ch, tool, { ownMessage: false })
      }
      const preview = oneLine(msg.content ?? '', 80)
      await msg.delete()
      return `deleted message ${msg.id} by ${JSON.stringify(msg.author.username)} (${msg.author.id})${own ? ' [own message]' : ''} in ${channelLabel(ch)}: ${preview}`
    }

    case 'bulk_delete': {
      const chatId = requireSnowflake(args.chat_id, 'chat_id')
      const target = parseBulkDeleteArgs(args as { count?: unknown; message_ids?: unknown })
      const ch = await deps.fetchAllowedChannel(chatId)
      if (ch.isDMBased()) throw new Error('bulk_delete works only in server channels — Discord has no bulk delete for DMs')
      await requireChannelPerms(ch, tool)
      const known = new Map<string, Message>()
      let ids: string[]
      if (target.kind === 'count') {
        const msgs = await ch.messages.fetch({ limit: target.count })
        for (const [id, m] of msgs) known.set(id, m)
        ids = [...msgs.keys()]
      } else {
        ids = target.ids
        for (const id of ids) { const m = ch.messages.cache.get(id); if (m) known.set(id, m) }
      }
      if (ids.length === 0) return `bulk_delete in ${channelLabel(ch)}: no messages to delete`
      const { deletable, tooOld } = partitionBulkDeletable(ids, now)
      if (deletable.length === 0) {
        throw new Error(`all ${tooOld.length} message(s) are older than 14 days; Discord refuses to bulk-delete those — use delete_message one at a time`)
      }
      // filterOld=true re-applies the 14-day bound inside discord.js, in case the clock moved between.
      const deleted = await ch.bulkDelete(deletable, true)
      const deletedIds = [...deleted.keys()]
      const lines = [`bulk_delete in ${channelLabel(ch)}: deleted ${deletedIds.length} of ${ids.length} message(s)`]
      for (const id of deletedIds) {
        const m = known.get(id)
        lines.push(m ? `  ${id} by ${JSON.stringify(m.author.username)} (${m.author.id}): ${oneLine(m.content ?? '', 60)}` : `  ${id}`)
      }
      if (tooOld.length > 0) lines.push(`skipped ${tooOld.length} older than 14 days: ${tooOld.join(', ')}`)
      const missed = deletable.filter(id => !deleted.has(id))
      if (missed.length > 0) lines.push(`not deleted (filtered as too old at send time): ${missed.join(', ')}`)
      return lines.join('\n')
    }

    case 'edit_channel': {
      const channelId = requireSnowflake(args.channel_id, 'channel_id')
      const ch = await deps.fetchChannel(channelId)
      if (!ch) throw new Error(`channel ${channelId} not found`)
      if (ch.isDMBased()) throw new Error('edit_channel works on server channels, not DMs')
      // The predicate fetchAllowedChannel applies to guild channels — called directly because that
      // helper only fetches TEXT-based channels and a category is not one. Before anything that would
      // describe the channel, so a refusal says nothing about a channel the bot may not touch.
      if (!channelAllowed(deps.loadAccess(), channelRefOf(ch))) {
        throw new Error(`channel ${channelId} is not allowlisted — add via /discord:access`)
      }
      if (ch.isThread()) throw new Error(`${channelLabel(ch)} is a thread; edit_channel edits channels and categories`)
      const me = await requireChannelPerms(ch, tool)
      const opts: GuildChannelEditOptions = {}
      const changes: string[] = []
      if (args.name !== undefined) {
        opts.name = requireName(args.name, 'name', 100)
        changes.push(`name: ${JSON.stringify(ch.name)} → ${JSON.stringify(opts.name)}`)
      }
      if (args.topic !== undefined) {
        if (!HAS_TOPIC.has(ch.type)) throw new Error(`${channelLabel(ch)} is a ${ChannelType[ch.type]} channel and has no topic`)
        if (typeof args.topic !== 'string') throw new Error('topic must be a string ("" clears it)')
        if (Array.from(args.topic).length > 1024) throw new Error('topic is longer than Discord\'s 1024 characters')
        opts.topic = args.topic === '' ? null : args.topic
        changes.push(`topic → ${args.topic === '' ? '(cleared)' : oneLine(args.topic, 80)}`)
      }
      if (args.parent_id !== undefined) {
        if (ch.type === ChannelType.GuildCategory) throw new Error('a category cannot be placed inside another category')
        if (args.parent_id === '' || args.parent_id === null) {
          opts.parent = null
          changes.push('category → (none)')
        } else {
          const pid = requireSnowflake(args.parent_id, 'parent_id')
          const parent = ch.guild.channels.cache.get(pid)
          if (!parent || parent.type !== ChannelType.GuildCategory) throw new Error(`parent_id ${pid} is not a category in ${guildLabel(ch.guild)}`)
          const pr = missingPermsRefusal(['ManageChannels'], p => parent.permissionsFor(me)?.has(p as PermissionResolvable) ?? false, `in category ${JSON.stringify(parent.name)} (${parent.id})`)
          if (pr) throw new Error(pr)
          opts.parent = pid
          changes.push(`category → ${JSON.stringify(parent.name)} (${pid})`)
        }
      }
      if (args.slowmode !== undefined) {
        if (!HAS_SLOWMODE.has(ch.type)) throw new Error(`${channelLabel(ch)} is a ${ChannelType[ch.type]} channel and has no slowmode`)
        opts.rateLimitPerUser = slowmodeSeconds(args.slowmode)
        changes.push(`slowmode → ${opts.rateLimitPerUser}s`)
      }
      if (args.nsfw !== undefined) {
        if (typeof args.nsfw !== 'boolean') throw new Error('nsfw must be true or false')
        if (!HAS_NSFW.has(ch.type)) throw new Error(`${channelLabel(ch)} is a ${ChannelType[ch.type]} channel and has no nsfw flag`)
        opts.nsfw = args.nsfw
        changes.push(`nsfw → ${args.nsfw}`)
      }
      if (changes.length === 0) throw new Error('nothing to change — pass at least one of name, topic, parent_id, slowmode, nsfw')
      opts.reason = optReason(args.reason)
      await ch.guild.channels.edit(ch.id, opts)
      return `edited ${channelLabel(ch)} in ${guildLabel(ch.guild)}: ${changes.join('; ')}`
    }

    // ── guild-scoped: the bot is in the guild and it has a server grant ──
    case 'get_member': {
      const { guild } = await grantedGuild(deps, args.guild_id, tool)
      const userId = requireSnowflake(args.user_id, 'user_id')
      const m = await requireMember(guild, userId)
      return `${guildLabel(guild)}\n${formatMemberRow(memberRow(m, guild), now)}`
    }

    case 'list_members': {
      const { guild } = await grantedGuild(deps, args.guild_id, tool)
      const limit = clampLookupLimit(args.limit, 50, 1000)
      const query = typeof args.query === 'string' ? args.query.trim() : ''
      let found
      if (query) {
        found = await guild.members.search({ query, limit })
      } else {
        try {
          found = await guild.members.list({ limit })
        } catch (err) {
          if (err instanceof DiscordAPIError && (err.code === 50001 || err.status === 403)) {
            throw new Error(`Discord refused to list ${guildLabel(guild)}'s members (${err.message}) — listing without a query needs the app's Server Members privileged intent. Pass query (a name prefix) instead.`)
          }
          throw err
        }
      }
      const rows = [...found.values()].sort((a, b) => a.displayName.localeCompare(b.displayName))
      const header = `${rows.length} member(s) of ${guildLabel(guild)}${query ? ` matching prefix ${JSON.stringify(query)}` : ''}`
        + (rows.length >= limit ? ` — limit ${limit} reached, there may be more` : '')
      return [header, ...rows.map(m => formatMemberRow(memberRow(m, guild), now))].join('\n')
    }

    case 'create_channel': {
      const { guild, me } = await grantedGuild(deps, args.guild_id, tool)
      const type = createChannelKind(args.kind)
      const name = requireName(args.name, 'name', 100)
      requireGuildPerms(me, tool, guild)
      let parent: CategoryChannel | undefined
      if (args.parent_id !== undefined && args.parent_id !== null && args.parent_id !== '') {
        if (type === ChannelType.GuildCategory) throw new Error('a category cannot be created inside another category')
        const pid = requireSnowflake(args.parent_id, 'parent_id')
        const p = guild.channels.cache.get(pid)
        if (!p || p.type !== ChannelType.GuildCategory) throw new Error(`parent_id ${pid} is not a category in ${guildLabel(guild)}`)
        const pr = missingPermsRefusal(['ManageChannels'], perm => p.permissionsFor(me)?.has(perm as PermissionResolvable) ?? false, `in category ${JSON.stringify(p.name)} (${p.id})`)
        if (pr) throw new Error(pr)
        parent = p
      }
      let topic: string | undefined
      if (args.topic !== undefined && args.topic !== null && args.topic !== '') {
        if (type !== ChannelType.GuildText) throw new Error('topic applies only to text channels')
        if (typeof args.topic !== 'string' || Array.from(args.topic).length > 1024) throw new Error('topic must be a string of at most 1024 characters')
        topic = args.topic
      }
      const created = await guild.channels.create({
        name,
        type,
        ...(parent ? { parent: parent.id } : {}),
        ...(topic ? { topic } : {}),
        reason: optReason(args.reason),
      })
      const kind = type === ChannelType.GuildCategory ? 'category' : type === ChannelType.GuildVoice ? 'voice channel' : 'text channel'
      return `created ${kind} ${JSON.stringify(created.name)} (id: ${created.id}) in ${guildLabel(guild)}${parent ? ` under ${JSON.stringify(parent.name)}` : ''} — covered by the server grant, so reply can reach it`
    }

    case 'delete_channel': {
      const channelId = requireSnowflake(args.channel_id, 'channel_id')
      const ch = await deps.fetchChannel(channelId)
      if (!ch) throw new Error(`channel ${channelId} not found`)
      if (ch.isDMBased()) throw new Error('delete_channel deletes server channels, not DMs')
      // Guild scope for a channel tool: resolved through the channel's own guild, and the SAME gate
      // the other guild tools use — a channel grant alone does not license deleting the channel.
      const { guild } = await grantedGuild(deps, ch.guildId, tool)
      await requireChannelPerms(ch, tool, { isThread: ch.isThread() })
      const children = ch.type === ChannelType.GuildCategory
        ? [...guild.channels.cache.values()].filter(c => c.parentId === ch.id).length : 0
      const what = `${ChannelType[ch.type]} ${channelLabel(ch)}`
      await ch.delete(optReason(args.reason))
      return `deleted ${what} in ${guildLabel(guild)}${children > 0 ? `; its ${children} channel(s) are now uncategorised` : ''}`
    }

    case 'add_role':
    case 'remove_role': {
      const { guild, me } = await grantedGuild(deps, args.guild_id, tool)
      const userId = requireSnowflake(args.user_id, 'user_id')
      const roleId = requireSnowflake(args.role_id, 'role_id')
      requireGuildPerms(me, tool, guild)
      const role = guild.roles.cache.get(roleId) ?? await guild.roles.fetch(roleId)
      if (!role) throw new Error(`role ${roleId} is not in ${guildLabel(guild)}`)
      const refusal = roleAssignRefusal(
        { ...rank(role), managed: role.managed },
        { guildId: guild.id, botHighest: rank(me.roles.highest), botIsGuildOwner: guild.ownerId === me.id },
      )
      if (refusal) throw new Error(refusal)
      const member = await requireMember(guild, userId)
      const roleLabel = `${JSON.stringify(role.name)} (${role.id})`
      const has = member.roles.cache.has(role.id)
      const danger = roleDangerousPerms(role.permissions.toArray())
      const flag = danger.length > 0 ? `\n⚠ ${roleLabel} carries ${danger.join(', ')}` : ''
      if (tool === 'add_role') {
        if (has) return `${memberLabel(member)} already has ${roleLabel} in ${guildLabel(guild)} — nothing changed`
        await member.roles.add(role, optReason(args.reason))
        return `added ${roleLabel} to ${memberLabel(member)} in ${guildLabel(guild)}${flag}`
      }
      if (!has) return `${memberLabel(member)} does not have ${roleLabel} in ${guildLabel(guild)} — nothing changed`
      await member.roles.remove(role, optReason(args.reason))
      return `removed ${roleLabel} from ${memberLabel(member)} in ${guildLabel(guild)}${flag}`
    }

    case 'timeout_member': {
      const ms = timeoutMs(args.minutes)
      const { guild, me } = await grantedGuild(deps, args.guild_id, tool)
      const userId = requireSnowflake(args.user_id, 'user_id')
      requireGuildPerms(me, tool, guild)
      const member = await requireMember(guild, userId)
      moderationRefusal('timeout', guild, me, memberTarget(member))
      await member.timeout(ms, optReason(args.reason))
      if (ms === null) return `lifted the timeout on ${memberLabel(member)} in ${guildLabel(guild)}`
      return `timed out ${memberLabel(member)} in ${guildLabel(guild)} for ${args.minutes} min, until ${new Date(now + ms).toISOString()}`
    }

    case 'kick_member': {
      const { guild, me } = await grantedGuild(deps, args.guild_id, tool)
      const userId = requireSnowflake(args.user_id, 'user_id')
      requireGuildPerms(me, tool, guild)
      const member = await requireMember(guild, userId)
      moderationRefusal('kick', guild, me, memberTarget(member))
      await member.kick(optReason(args.reason))
      return `kicked ${memberLabel(member)} from ${guildLabel(guild)}`
    }

    case 'ban_member': {
      const deleteSeconds = banDeleteSeconds(args.delete_message_seconds)
      const { guild, me } = await grantedGuild(deps, args.guild_id, tool)
      const userId = requireSnowflake(args.user_id, 'user_id')
      requireGuildPerms(me, tool, guild)
      const member = await fetchMemberOrNull(guild, userId)
      let name = userId
      if (member) name = member.user.username
      else { try { name = (await guild.client.users.fetch(userId)).username } catch { /* ban by id still works */ } }
      moderationRefusal('ban', guild, me, member ? memberTarget(member) : { id: userId, name, highest: null, isAdministrator: false })
      await guild.members.ban(userId, { reason: optReason(args.reason), deleteMessageSeconds: deleteSeconds })
      return `banned ${JSON.stringify(name)} (${userId}) from ${guildLabel(guild)}${member ? '' : ' (was not a member)'}${deleteSeconds > 0 ? `, deleting their last ${deleteSeconds}s of messages` : ''}`
    }

    case 'unban_member': {
      const { guild, me } = await grantedGuild(deps, args.guild_id, tool)
      const userId = requireSnowflake(args.user_id, 'user_id')
      requireGuildPerms(me, tool, guild)
      let ban
      try {
        ban = await guild.bans.fetch(userId)
      } catch (err) {
        if (err instanceof DiscordAPIError && err.code === 10026) throw new Error(`user ${userId} is not banned in ${guildLabel(guild)}`)
        throw err
      }
      await guild.bans.remove(userId, optReason(args.reason))
      return `unbanned ${JSON.stringify(ban.user.username)} (${userId}) in ${guildLabel(guild)}`
    }

    case 'set_nickname': {
      const { guild, me } = await grantedGuild(deps, args.guild_id, tool)
      const userId = requireSnowflake(args.user_id, 'user_id')
      if (typeof args.nick !== 'string') throw new Error('nick must be a string ("" clears it)')
      const nick = args.nick.trim()
      if (Array.from(nick).length > 32) throw new Error(`nick is ${Array.from(nick).length} characters; Discord allows at most 32`)
      const self = userId === me.id
      requireGuildPerms(me, tool, guild, { self })
      const member = self ? me : await requireMember(guild, userId)
      moderationRefusal('nickname', guild, me, memberTarget(member))
      const before = member.nickname
      await member.setNickname(nick === '' ? null : nick, optReason(args.reason))
      return `nickname of ${memberLabel(member)} in ${guildLabel(guild)}: ${before ? JSON.stringify(before) : '(none)'} → ${nick ? JSON.stringify(nick) : '(none)'}`
    }
  }
}
