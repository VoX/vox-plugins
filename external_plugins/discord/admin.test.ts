import { test, expect, describe } from 'bun:test'
import { ChannelType, DiscordAPIError, PermissionFlagsBits, type Guild, type Channel, type TextBasedChannel } from 'discord.js'
import { runAdminTool, ADMIN_TOOL_DEFS, type AdminDeps } from './admin'
import { ADMIN_TOOL_SCOPE, BULK_DELETE_MAX_AGE_MS, type AdminToolName } from './lib'

// These drive admin.ts — the code server.ts actually dispatches to — against stub guilds. Every
// Discord WRITE a stub can receive is recorded in `calls`, so "refused" is asserted as "nothing was
// written", not inferred from an error string.

const GUILD = '111111111111111111'
const OTHER_GUILD = '222222222222222222'
const CHAN = '333333333333333333'
const CATEGORY = '344444444444444444'
const BOT = '900000000000000000'
const OWNER = '800000000000000000'
const ALICE = '700000000000000000'
const MOD = '710000000000000000'
const GHOST = '720000000000000000'   // not a member
const NOW = Date.parse('2026-10-10T12:00:00Z')
const EPOCH = 1420070400000
const msgIdAt = (ms: number, n = 1) => ((BigInt(ms - EPOCH) << 22n) | BigInt(n)).toString()

const GRANTED = { groups: {}, guilds: { [GUILD]: { requireMention: true, allowFrom: [] } } }
const CHANNEL_ONLY = { groups: { [CHAN]: { requireMention: true, allowFrom: [] } }, guilds: {} }

const apiErr = (code: number, message: string, status = 404) =>
  new DiscordAPIError({ code, message }, code, status, 'GET', 'https://discord.com/api/v10/stub', {})

// discord.js passes both names ('ManageMessages') and bits (PermissionFlagsBits.Administrator) to has().
const permName = (p: unknown) =>
  typeof p === 'bigint' ? Object.entries(PermissionFlagsBits).find(([, v]) => v === p)?.[0] : String(p)
function perms(names: string[]) {
  const s = new Set(names)
  return { has: (p: unknown) => s.has(permName(p) ?? ''), toArray: () => [...s] }
}

type StubRole = { id: string; name: string; rawPosition: number; managed: boolean; permissions: ReturnType<typeof perms> }
const role = (id: string, name: string, rawPosition: number, extra: Partial<StubRole> = {}): StubRole =>
  ({ id, name, rawPosition, managed: false, permissions: perms([]), ...extra })
const R_EVERYONE = role(GUILD, '@everyone', 0)
const R_MEMBER = role('100000000000000000', 'Member', 1)
const R_HELPER = role('150000000000000000', 'Helper', 2, { permissions: perms(['Administrator', 'BanMembers']) })
const R_BOT = role('500000000000000000', 'tinyclaw', 5, { managed: true })
const R_MOD = role('600000000000000000', 'Mod', 6)

function stubMember(calls: string[], id: string, username: string, roles: StubRole[], extraPerms: string[] = []) {
  const cache = new Map(roles.map(r => [r.id, r]))
  const highest = [...roles].sort((a, b) => b.rawPosition - a.rawPosition)[0] ?? R_EVERYONE
  return {
    id,
    user: { id, username, bot: false },
    displayName: username,
    nickname: null as string | null,
    joinedAt: new Date('2025-01-01T00:00:00Z'),
    communicationDisabledUntil: null,
    roles: {
      cache, highest,
      add: async (r: StubRole) => { calls.push(`roles.add ${id} ${r.id}`) },
      remove: async (r: StubRole) => { calls.push(`roles.remove ${id} ${r.id}`) },
    },
    permissions: perms([...extraPerms, ...roles.flatMap(r => r.permissions.toArray())]),
    kick: async () => { calls.push(`kick ${id}`) },
    timeout: async (ms: number | null) => { calls.push(`timeout ${id} ${ms}`) },
    setNickname: async (n: string | null) => { calls.push(`nick ${id} ${n}`) },
  }
}

function stubGuild(botPerms: string[]) {
  const calls: string[] = []
  const reads: string[] = []
  const me = stubMember(calls, BOT, 'tinyclaw', [R_BOT], botPerms)
  const members = new Map([
    me,
    stubMember(calls, ALICE, 'alice', [R_MEMBER]),
    stubMember(calls, MOD, 'mod', [R_MOD]),
    stubMember(calls, OWNER, 'owner', [R_MEMBER]),
  ].map(m => [m.id, m]))
  const category = {
    id: CATEGORY, name: 'Projects', type: ChannelType.GuildCategory, parentId: null,
    permissionsFor: () => perms(botPerms),
  }
  const guild = {
    id: GUILD, name: 'Wheat', ownerId: OWNER,
    roles: {
      cache: new Map([R_EVERYONE, R_MEMBER, R_HELPER, R_BOT, R_MOD].map(r => [r.id, r])),
      fetch: async () => null,
    },
    members: {
      me,
      fetchMe: async () => me,
      fetch: async (id: string) => {
        reads.push(`members.fetch ${id}`)
        const m = members.get(id)
        if (!m) throw apiErr(10007, 'Unknown Member')
        return m
      },
      ban: async (id: string, o: { deleteMessageSeconds?: number }) => { calls.push(`ban ${id} ${o.deleteMessageSeconds ?? 0}`) },
      search: async () => { reads.push('members.search'); return new Map() },
      list: async () => { reads.push('members.list'); return new Map() },
    },
    bans: {
      fetch: async (id: string) => { if (id !== GHOST) throw apiErr(10026, 'Unknown Ban'); return { user: { id, username: 'ghost' } } },
      remove: async (id: string) => { calls.push(`unban ${id}`) },
    },
    channels: {
      cache: new Map<string, unknown>([[CATEGORY, category]]),
      create: async (o: { name: string; type: number }) => { calls.push(`create ${o.name} ${o.type}`); return { id: '355555555555555555', name: o.name } },
      edit: async (id: string, o: Record<string, unknown>) => { calls.push(`edit ${id} ${JSON.stringify(o)}`) },
    },
    client: { users: { fetch: async (id: string) => ({ id, username: 'ghost' }) } },
  }
  return { guild: guild as unknown as Guild, calls, reads }
}

type StubMsg = { id: string; authorId: string; username?: string; content?: string }

/** A text channel in GUILD. Its writes land in the guild's `calls`. */
function stubChannel(g: ReturnType<typeof stubGuild>, botChannelPerms: string[], msgs: StubMsg[] = []) {
  const byId = new Map(msgs.map(m => [m.id, {
    id: m.id,
    author: { id: m.authorId, username: m.username ?? 'someone' },
    content: m.content ?? '',
    hasThread: false,
    reactions: { cache: new Map() },
    delete: async () => { g.calls.push(`delete ${m.id}`) },
    startThread: async (o: { name: string }) => { g.calls.push(`startThread ${m.id} ${o.name}`); return { id: '366666666666666666', name: o.name } },
  }]))
  const ch = {
    id: CHAN, name: 'claws', type: ChannelType.GuildText, guild: g.guild, guildId: GUILD, parentId: null,
    isDMBased: () => false,
    isThread: () => false,
    permissionsFor: () => perms(botChannelPerms),
    messages: {
      cache: byId,
      fetch: async (arg: string | { limit: number }) => {
        if (typeof arg === 'string') {
          const m = byId.get(arg)
          if (!m) throw apiErr(10008, 'Unknown Message')
          return m
        }
        return new Map([...byId].slice(0, arg.limit))
      },
    },
    bulkDelete: async (ids: string[]) => { g.calls.push(`bulkDelete ${ids.join(',')}`); return new Map(ids.map(id => [id, {}])) },
    threads: { create: async (o: { name: string }) => { g.calls.push(`threads.create ${o.name}`); return { id: '366666666666666666', name: o.name } } },
    delete: async () => { g.calls.push(`delete channel ${CHAN}`) },
  }
  return ch
}

function deps(guild: Guild | undefined, access: object, extra: Partial<AdminDeps> = {}): AdminDeps {
  return {
    botUserId: BOT,
    loadAccess: () => access as ReturnType<AdminDeps['loadAccess']>,
    getGuild: id => (guild && id === guild.id ? guild : undefined),
    fetchChannel: async id => { throw new Error(`fetchChannel(${id}) not stubbed`) },
    fetchAllowedChannel: async id => { throw new Error(`channel ${id} is not allowlisted — add via /discord:access`) },
    now: () => NOW,
    ...extra,
  }
}
const allowed = (ch: unknown) => ({ fetchAllowedChannel: async () => ch as TextBasedChannel })
const fetchable = (ch: unknown) => ({ fetchChannel: async () => ch as Channel })

const ALL_PERMS = ['ViewChannel', 'ReadMessageHistory', 'ManageMessages', 'ManageChannels', 'ManageRoles', 'ManageThreads',
  'ModerateMembers', 'KickMembers', 'BanMembers', 'ManageNicknames', 'ChangeNickname', 'CreatePublicThreads']

describe('admin tool registry', () => {
  test('every admin tool has exactly one schema and one scope', () => {
    expect(ADMIN_TOOL_DEFS.map(d => d.name as string).sort()).toEqual(Object.keys(ADMIN_TOOL_SCOPE).sort())
    expect(new Set(ADMIN_TOOL_DEFS.map(d => d.name)).size).toBe(ADMIN_TOOL_DEFS.length)
  })

  test('every required field is a declared property', () => {
    for (const d of ADMIN_TOOL_DEFS) {
      const props = Object.keys((d.inputSchema.properties ?? {}) as object)
      for (const r of (d.inputSchema.required ?? []) as string[]) expect(props).toContain(r)
    }
  })

  test('no description promises an approval step that no longer exists', () => {
    for (const d of ADMIN_TOOL_DEFS) expect(d.description).not.toMatch(/owner approv|Allow\/Deny|blocks on/i)
  })
})

describe('guild scope — the server grant gate', () => {
  // One plausible call per guild-scoped tool. Each must be refused on a guild that only has a
  // CHANNEL grant, before a single read or write reaches Discord.
  const guildCalls: Array<[AdminToolName, Record<string, unknown>]> = [
    ['get_member', { guild_id: GUILD, user_id: ALICE }],
    ['list_members', { guild_id: GUILD }],
    ['create_channel', { guild_id: GUILD, name: 'new', kind: 'text' }],
    ['add_role', { guild_id: GUILD, user_id: ALICE, role_id: R_MEMBER.id }],
    ['remove_role', { guild_id: GUILD, user_id: ALICE, role_id: R_MEMBER.id }],
    ['timeout_member', { guild_id: GUILD, user_id: ALICE, minutes: 5 }],
    ['kick_member', { guild_id: GUILD, user_id: ALICE }],
    ['ban_member', { guild_id: GUILD, user_id: ALICE }],
    ['unban_member', { guild_id: GUILD, user_id: GHOST }],
    ['set_nickname', { guild_id: GUILD, user_id: ALICE, nick: 'x' }],
  ]

  test('the table above covers every guild-scoped tool except delete_channel (tested below, it takes a channel id)', () => {
    const covered = new Set(guildCalls.map(([t]) => t))
    const guildTools = (Object.keys(ADMIN_TOOL_SCOPE) as AdminToolName[]).filter(t => ADMIN_TOOL_SCOPE[t] === 'guild')
    expect(guildTools.filter(t => !covered.has(t))).toEqual(['delete_channel'])
  })

  for (const [tool, args] of guildCalls) {
    test(`${tool}: refused without a server grant, nothing read or written`, async () => {
      const g = stubGuild(ALL_PERMS)
      await expect(runAdminTool(tool, args, deps(g.guild, CHANNEL_ONLY))).rejects.toThrow(/no server grant/)
      expect(g.calls).toEqual([])
      expect(g.reads).toEqual([])
    })
  }

  test('with the grant, the same kick goes through — directly, with no approval step', async () => {
    const g = stubGuild(ALL_PERMS)
    const out = await runAdminTool('kick_member', { guild_id: GUILD, user_id: ALICE }, deps(g.guild, GRANTED))
    expect(g.calls).toEqual([`kick ${ALICE}`])
    expect(out).toContain(`"alice" (${ALICE})`)
    expect(out).toContain(`"Wheat" (${GUILD})`)
  })

  test('a guild the bot is not in is refused even with a grant for it', async () => {
    const access = { guilds: { [OTHER_GUILD]: { requireMention: true, allowFrom: [] } } }
    await expect(runAdminTool('kick_member', { guild_id: OTHER_GUILD, user_id: ALICE }, deps(undefined, access)))
      .rejects.toThrow(`bot is not in guild ${OTHER_GUILD}`)
  })

  test('delete_channel needs the SERVER grant — a grant on the channel itself is not enough', async () => {
    const g = stubGuild(ALL_PERMS)
    const ch = stubChannel(g, ALL_PERMS)
    await expect(runAdminTool('delete_channel', { channel_id: CHAN }, deps(g.guild, CHANNEL_ONLY, fetchable(ch))))
      .rejects.toThrow(/no server grant/)
    expect(g.calls).toEqual([])
    const out = await runAdminTool('delete_channel', { channel_id: CHAN }, deps(g.guild, GRANTED, fetchable(ch)))
    expect(g.calls).toEqual([`delete channel ${CHAN}`])
    expect(out).toContain(`#claws (${CHAN})`)
  })
})

describe('channel scope — the same gate reply uses', () => {
  const chanCalls: Array<[AdminToolName, Record<string, unknown>]> = [
    ['fetch_reactions', { chat_id: CHAN, message_id: msgIdAt(NOW - 1000) }],
    ['create_thread', { chat_id: CHAN, name: 't' }],
    ['delete_message', { chat_id: CHAN, message_id: msgIdAt(NOW - 1000) }],
    ['bulk_delete', { chat_id: CHAN, count: 5 }],
  ]
  for (const [tool, args] of chanCalls) {
    test(`${tool}: a channel fetchAllowedChannel refuses is refused, nothing written`, async () => {
      const g = stubGuild(ALL_PERMS)
      await expect(runAdminTool(tool, args, deps(g.guild, GRANTED))).rejects.toThrow(/not allowlisted/)
      expect(g.calls).toEqual([])
    })
  }

  test('edit_channel applies channelAllowed itself (categories are not text channels)', async () => {
    const g = stubGuild(ALL_PERMS)
    const ch = stubChannel(g, ALL_PERMS)
    await expect(runAdminTool('edit_channel', { channel_id: CHAN, name: 'x' }, deps(g.guild, { groups: {}, guilds: {} }, fetchable(ch))))
      .rejects.toThrow(/not allowlisted/)
    expect(g.calls).toEqual([])
    // a channel grant is enough for an edit
    const out = await runAdminTool('edit_channel', { channel_id: CHAN, name: 'renamed', slowmode: 30 }, deps(g.guild, CHANNEL_ONLY, fetchable(ch)))
    expect(g.calls).toEqual([`edit ${CHAN} {"name":"renamed","rateLimitPerUser":30}`])
    expect(out).toContain('name: "claws" → "renamed"')
  })
})

describe('bot permissions and hierarchy are checked before the write', () => {
  test('another user\'s message needs ManageMessages; the bot\'s own needs nothing', async () => {
    const g = stubGuild([])
    const theirs = msgIdAt(NOW - 1000, 1), mine = msgIdAt(NOW - 1000, 2)
    const ch = stubChannel(g, ['ViewChannel'], [{ id: theirs, authorId: ALICE, username: 'alice' }, { id: mine, authorId: BOT }])
    await expect(runAdminTool('delete_message', { chat_id: CHAN, message_id: theirs }, deps(g.guild, GRANTED, allowed(ch))))
      .rejects.toThrow(/lacks ManageMessages/)
    expect(g.calls).toEqual([])
    const out = await runAdminTool('delete_message', { chat_id: CHAN, message_id: mine }, deps(g.guild, GRANTED, allowed(ch)))
    expect(g.calls).toEqual([`delete ${mine}`])
    expect(out).toContain('[own message]')
  })

  test('a missing guild permission is named', async () => {
    const g = stubGuild(['ViewChannel'])
    await expect(runAdminTool('ban_member', { guild_id: GUILD, user_id: ALICE }, deps(g.guild, GRANTED)))
      .rejects.toThrow(/lacks BanMembers/)
    expect(g.calls).toEqual([])
  })

  test('a member who outranks the bot, and the owner, cannot be kicked', async () => {
    const g = stubGuild(ALL_PERMS)
    await expect(runAdminTool('kick_member', { guild_id: GUILD, user_id: MOD }, deps(g.guild, GRANTED))).rejects.toThrow(/"Mod" is at or above/)
    await expect(runAdminTool('kick_member', { guild_id: GUILD, user_id: OWNER }, deps(g.guild, GRANTED))).rejects.toThrow(/owns the server/)
    expect(g.calls).toEqual([])
  })

  test('a role above the bot is refused; a dangerous role below it is assigned and flagged ⚠', async () => {
    const g = stubGuild(ALL_PERMS)
    await expect(runAdminTool('add_role', { guild_id: GUILD, user_id: ALICE, role_id: R_MOD.id }, deps(g.guild, GRANTED)))
      .rejects.toThrow(/at or above the bot's highest role/)
    expect(g.calls).toEqual([])
    const out = await runAdminTool('add_role', { guild_id: GUILD, user_id: ALICE, role_id: R_HELPER.id }, deps(g.guild, GRANTED))
    expect(g.calls).toEqual([`roles.add ${ALICE} ${R_HELPER.id}`])
    expect(out).toContain(`⚠ "Helper" (${R_HELPER.id}) carries Administrator, BanMembers`)
  })

  test('adding a role the member already has writes nothing', async () => {
    const g = stubGuild(ALL_PERMS)
    const out = await runAdminTool('add_role', { guild_id: GUILD, user_id: ALICE, role_id: R_MEMBER.id }, deps(g.guild, GRANTED))
    expect(out).toContain('already has')
    expect(g.calls).toEqual([])
  })

  test('a long timeout applies directly — no threshold, no approval', async () => {
    const g = stubGuild(ALL_PERMS)
    const out = await runAdminTool('timeout_member', { guild_id: GUILD, user_id: ALICE, minutes: 90 }, deps(g.guild, GRANTED))
    expect(g.calls).toEqual([`timeout ${ALICE} 5400000`])
    expect(out).toContain(new Date(NOW + 5_400_000).toISOString())
  })

  test('a non-member can be banned by id', async () => {
    const g = stubGuild(ALL_PERMS)
    const out = await runAdminTool('ban_member', { guild_id: GUILD, user_id: GHOST, delete_message_seconds: 3600 }, deps(g.guild, GRANTED))
    expect(g.calls).toEqual([`ban ${GHOST} 3600`])
    expect(out).toContain('(was not a member)')
  })

  test('the bot\'s own nickname needs only ChangeNickname', async () => {
    const g = stubGuild(['ChangeNickname'])
    await runAdminTool('set_nickname', { guild_id: GUILD, user_id: BOT, nick: 'tiny' }, deps(g.guild, GRANTED))
    expect(g.calls).toEqual([`nick ${BOT} tiny`])
    await expect(runAdminTool('set_nickname', { guild_id: GUILD, user_id: ALICE, nick: 'x' }, deps(g.guild, GRANTED)))
      .rejects.toThrow(/lacks ManageNicknames/)
  })

  test('Discord errors come back readable', async () => {
    const g = stubGuild(ALL_PERMS)
    await expect(runAdminTool('get_member', { guild_id: GUILD, user_id: GHOST }, deps(g.guild, GRANTED)))
      .rejects.toThrow(`user ${GHOST} is not a member of "Wheat" (${GUILD})`)
    await expect(runAdminTool('unban_member', { guild_id: GUILD, user_id: ALICE }, deps(g.guild, GRANTED)))
      .rejects.toThrow(/is not banned/)
  })
})

describe('bulk_delete', () => {
  test('deletes only what Discord will accept, and reports the full deleted set and the skipped ones', async () => {
    const g = stubGuild(ALL_PERMS)
    const fresh1 = msgIdAt(NOW - 60_000, 1), fresh2 = msgIdAt(NOW - 120_000, 2)
    const old = msgIdAt(NOW - BULK_DELETE_MAX_AGE_MS - 60_000, 3)
    const ch = stubChannel(g, ALL_PERMS, [
      { id: fresh1, authorId: ALICE, username: 'alice', content: 'one' },
      { id: fresh2, authorId: MOD, username: 'mod', content: 'two' },
      { id: old, authorId: ALICE, username: 'alice', content: 'ancient' },
    ])
    const out = await runAdminTool('bulk_delete', { chat_id: CHAN, count: 3 }, deps(g.guild, GRANTED, allowed(ch)))
    expect(g.calls).toEqual([`bulkDelete ${fresh1},${fresh2}`])
    expect(out).toContain('deleted 2 of 3')
    expect(out).toContain(`${fresh1} by "alice" (${ALICE})`)
    expect(out).toContain(`${fresh2} by "mod" (${MOD})`)
    expect(out).toContain(`skipped 1 older than 14 days: ${old}`)
  })

  test('refused without ManageMessages in the channel', async () => {
    const g = stubGuild(ALL_PERMS)
    const ch = stubChannel(g, ['ViewChannel', 'ReadMessageHistory'])
    await expect(runAdminTool('bulk_delete', { chat_id: CHAN, count: 2 }, deps(g.guild, GRANTED, allowed(ch))))
      .rejects.toThrow(/lacks ManageMessages/)
    expect(g.calls).toEqual([])
  })
})
