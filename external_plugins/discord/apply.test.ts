import { test, expect, describe } from 'bun:test'
import { DiscordAPIError, type Guild } from 'discord.js'
import { applySpecDiff, applyServerSpecChecked, writeRolePositionsLive } from './apply'
import { computeSpecDiff, buildServerSpec, renderSpecDiff, type ServerSpec, type RawGuildState, type SpecDiff } from './lib'

// ── The seam finding J is about ────────────────────────────────────────────────
// server.ts had zero exports and a top-level `await mcp.connect(...)`, so importing
// it to reach applySpecDiff started a bot. applySpecDiff moved to apply.ts, which
// imports clean, and takes an injectable write. These are the first tests that have
// ever executed the applier.

type StubRole = { id: string; name: string; rawPosition: number; position: number; managed: boolean }

/** The smallest thing applySpecDiff will accept. Anything the ordering path must NOT
 *  touch is present and throws, so "never called" is enforced rather than assumed. */
function stubGuild(roles: StubRole[], opts: {
  botHighestId: string
  patch?: (route: string, body: unknown) => unknown
} ): { guild: Guild; calls: Array<{ route: string; body: unknown }> } {
  const calls: Array<{ route: string; body: unknown }> = []
  const cache = new Map(roles.map(r => [r.id, {
    ...r,
    // Any discord.js position helper reaching Discord is the audited bug: both update
    // the cache from the REQUEST and discard the response.
    setPosition: () => { throw new Error('setPosition must never be called') },
    delete: () => { throw new Error('unexpected delete') },
    edit: () => { throw new Error('unexpected edit') },
    setName: () => { throw new Error('unexpected setName') },
  }]))
  const guild = {
    id: '1',
    name: 'Stub',
    roles: {
      cache,
      everyone: { permissions: { toArray: () => [] }, edit: () => { throw new Error('unexpected everyone edit') } },
      setPositions: () => { throw new Error('roles.setPositions must never be called') },
      create: () => { throw new Error('unexpected role create') },
    },
    channels: { cache: new Map() },
    members: { me: { roles: { highest: cache.get(opts.botHighestId) } } },
    client: {
      rest: {
        patch: async (route: string, o: { body: unknown }) => {
          calls.push({ route, body: o.body })
          return opts.patch ? opts.patch(route, o.body) : o.body
        },
      },
    },
  } as unknown as Guild
  return { guild, calls }
}

const LSS: StubRole[] = [
  { id: '1',   name: '@everyone', rawPosition: 0, position: 0, managed: false },
  { id: '200', name: 'Lodestone', rawPosition: 1, position: 1, managed: false },
  { id: '100', name: 'Moderator', rawPosition: 2, position: 2, managed: false },
  { id: '300', name: 'Bot',       rawPosition: 3, position: 3, managed: false },
  { id: '400', name: 'Owner',     rawPosition: 4, position: 4, managed: false },
  { id: '500', name: 'tinyclaw',  rawPosition: 5, position: 5, managed: true  },
]

/** A diff carrying only the ordering entry, built the way the real caller builds it. */
function orderingDiff(roles: StubRole[], spec: ServerSpec, botHighestId: string) {
  const state: RawGuildState = {
    guildId: '1',
    everyonePermissions: [],
    roles: roles.filter(r => r.id !== '1').map(r => ({
      id: r.id, name: r.name, hexColor: '#000000', hoist: false, mentionable: false,
      permissions: [], position: r.position, rawPosition: r.rawPosition, managed: r.managed,
    })),
    channels: [],
  }
  return computeSpecDiff(buildServerSpec(state), spec, {
    guildId: '1',
    botHighestRoleId: botHighestId,
    allRoles: roles.map(r => ({ id: r.id, name: r.name, rawPosition: r.rawPosition, managed: r.managed })),
  })
}

describe('applySpecDiff — role ordering', () => {
  const spec: ServerSpec = { roles: [{ name: 'Lodestone', above: 'Owner' }] }

  test('goes STRAIGHT to PATCH /guilds/{id}/roles, and no discord.js helper is touched', () => {
    // Asserting "setPositions was not called" alone is not enough — that passes if
    // nothing happened at all. Pin the positive: one raw REST call, on the route.
    const { guild, calls } = stubGuild(LSS, { botHighestId: '500' })
    return applySpecDiff(guild, spec, orderingDiff(LSS, spec, '500')).then(out => {
      expect(calls.length).toBe(1)
      expect(calls[0]!.route).toBe('/guilds/1/roles')
      expect(out).toContain('✓')
      expect(out).not.toContain('✗')
    })
  })

  test('the body is COMPLETE — every role, not just the one that moves', () => {
    // A partial body is advisory: measured, one entry asking for position 3 landed at 2.
    const { guild, calls } = stubGuild(LSS, { botHighestId: '500' })
    return applySpecDiff(guild, spec, orderingDiff(LSS, spec, '500')).then(() => {
      const body = calls[0]!.body as Array<{ id: string; position: number }>
      expect(body.length).toBe(LSS.length)
      expect(body.map(w => w.position).sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5])
    })
  })

  test('exactly ONE write, however many roles move', async () => {
    const { guild, calls } = stubGuild(LSS, { botHighestId: '500' })
    await applySpecDiff(guild, spec, orderingDiff(LSS, spec, '500'))
    expect(calls.length).toBe(1)
  })

  test('the RESPONSE is the authority — a server that stores something else is reported, not ticked', async () => {
    // discord.js's setPositions updates its cache from the array it SENT. This is that
    // bug's consequence made visible: Discord really does return numbers we did not ask
    // for, and "the call did not throw" is not evidence the order changed.
    const { guild } = stubGuild(LSS, {
      botHighestId: '500',
      patch: (_r, body) => (body as Array<{ id: string; position: number }>)
        .map(w => ({ ...w, position: w.id === '200' ? w.position - 1 : w.position })),
    })
    const out = await applySpecDiff(guild, spec, orderingDiff(LSS, spec, '500'))
    expect(out).toContain('✗')
    expect(out).toContain('Discord stored a different order than requested')
    expect(out).toContain('"Lodestone"')
  })

  test('a 50013 on the batch surfaces as the LEGIBLE failure, not just the two words Discord gives', async () => {
    // This must throw a REAL DiscordAPIError. The first version threw
    // Object.assign(new Error('Missing Permissions'), {code: 50013}), which is not an instanceof
    // DiscordAPIError -- so explainApplyError fell through to the generic `err.message` branch and
    // the assertion passed on the stub's own message. Deleting the entire 50013 branch left it green:
    // a check whose pass looks exactly like its failure, guarding the one thing the design exists for
    // (Discord's answer here names neither the blocking role nor the ceiling).
    const err = new DiscordAPIError(
      { code: 50013, message: 'Missing Permissions' }, 50013, 403, 'PATCH', 'https://discord.com/api/v10/guilds/1/roles', {})
    const { guild } = stubGuild(LSS, { botHighestId: '500', patch: () => { throw err } })
    const out = await applySpecDiff(guild, spec, orderingDiff(LSS, spec, '500'))
    expect(out).toContain('✗ reorder role hierarchy')
    expect(out).toContain('drag the bot role up')   // the legible half — the part that was untested
  })

  test('the drift check aborts when the guild changed after the diff was planned, and writes NOTHING', async () => {
    // §6. Zero coverage before this: deleting the whole block left the suite green.
    const diff = orderingDiff(LSS, spec, '500')
    // A third party inserts a role into the affected band between planning and the write.
    const intruded: StubRole[] = [...LSS, { id: '250', name: 'Intruder', rawPosition: 2, position: 2, managed: false }]
    const { guild, calls } = stubGuild(intruded, { botHighestId: '500' })
    const out = await applySpecDiff(guild, spec, diff)
    expect(out).toContain('✗ reorder role hierarchy')
    expect(out).toContain('the guild changed since this diff was planned')
    expect(calls.length).toBe(0)   // nothing written, which is the whole point
  })

  test('a role already in the planned order being DRAGGED elsewhere also aborts', async () => {
    // The first version compared the SET OF NAMES that move, which is blind to a role that was
    // already in that set moving to a different rank -- and since the body is COMPLETE, our own
    // PATCH would then have written the third party's change in as though the owner approved it.
    const diff = orderingDiff(LSS, spec, '500')
    const dragged = LSS.map(r => r.name === 'Moderator' ? { ...r, rawPosition: 4, position: 4 }
                              : r.name === 'Owner' ? { ...r, rawPosition: 2, position: 2 } : r)
    const { guild, calls } = stubGuild(dragged, { botHighestId: '500' })
    const out = await applySpecDiff(guild, spec, diff)
    expect(out).toContain('the guild changed since this diff was planned')
    expect(calls.length).toBe(0)
  })

  test('the reorder entry is LAST, after every create, rename and delete', () => {
    // §7 and §10a.6 both warn about this and nothing pinned it: moving the ordering segment ahead of
    // the deletions left the suite green. A reorder computed before a delete renumbers around roles
    // that are about to vanish.
    const state: RawGuildState = {
      guildId: '1', everyonePermissions: [], channels: [],
      roles: LSS.filter(r => r.id !== '1').map(r => ({
        id: r.id, name: r.name, hexColor: '#000000', hoist: false, mentionable: false,
        permissions: [], position: r.position, rawPosition: r.rawPosition, managed: r.managed,
      })),
    }
    const diff = computeSpecDiff(buildServerSpec(state), {
      // Owner is CLAIMED so prune does not delete it — an unclaimed constraint target is correctly
      // refused, since the projection drops roles this apply is about to remove. Bot is left
      // unclaimed on purpose, so there IS a delete for the reorder to have to come after.
      roles: [{ name: 'Fresh' }, { id: '100', name: 'Mod' }, { id: '400', name: 'Owner' },
              { name: 'Lodestone', id: '200', above: 'Owner' }],
    }, {
      prune: true, guildId: '1', botHighestRoleId: '500',
      allRoles: LSS.map(r => ({ id: r.id, name: r.name, rawPosition: r.rawPosition, managed: r.managed })),
    })
    const kinds = diff.entries.map(e => `${e.op}:${e.kind}`)
    expect(kinds[kinds.length - 1]).toBe('reorder:ordering')
    expect(kinds.filter(k => k === 'reorder:ordering').length).toBe(1)
    expect(kinds.some(k => k.startsWith('delete:'))).toBe(true)   // there ARE deletes to come after
  })

  test('an already-satisfied ordering produces no entry at all, so nothing is written', async () => {
    const satisfied: ServerSpec = { roles: [{ name: 'Owner', above: 'Moderator' }] }
    const diff = orderingDiff(LSS, satisfied, '500')
    expect(diff.entries.find(e => e.kind === 'ordering')).toBeUndefined()
    const { guild, calls } = stubGuild(LSS, { botHighestId: '500' })
    await applySpecDiff(guild, satisfied, diff)
    expect(calls.length).toBe(0)
  })

  test('re-plans against REAL ids rather than replaying the projection', async () => {
    // The diff is computed before anything is applied, so a role this run creates has
    // only a synthetic id in the approved plan. Replaying that body would PATCH ids
    // that do not exist. Simulate it: the guild gained a role after the diff was built.
    const withNew: StubRole[] = [...LSS, { id: '600', name: 'VSS Maintainer', rawPosition: 1, position: 1, managed: false }]
    const s: ServerSpec = { roles: [{ name: 'VSS Maintainer', below: 'Owner', above: 'Bot' }] }
    const diff = orderingDiff(LSS.filter(r => r.name !== 'x'), { roles: [{ name: 'VSS Maintainer', below: 'Owner', above: 'Bot' }] }, '500')
    const { guild, calls } = stubGuild(withNew, { botHighestId: '500' })
    const out = await applySpecDiff(guild, s, diff)
    const body = calls[0]?.body as Array<{ id: string; position: number }> | undefined
    // (the create entry fails against this stub — irrelevant here, and the point is
    // that the reorder still ran against the guild as it ACTUALLY is)
    expect(out).toContain('✓ reorder role hierarchy')
    expect(body!.map(w => w.id).sort()).toEqual(['1', '100', '200', '300', '400', '500', '600'])
    // and the new role really did land between Owner and Bot
    const order = [...body!].sort((a, b) => b.position - a.position)
      .map(w => withNew.find(r => r.id === w.id)!.name)
    expect(order).toEqual(['tinyclaw', 'Owner', 'VSS Maintainer', 'Bot', 'Moderator', 'Lodestone', '@everyone'])
  })
})

describe('writeRolePositionsLive', () => {
  test('adopts (id, position) from the response body', async () => {
    const guild = {
      id: '9',
      client: { rest: { patch: async () => [{ id: 'a', position: 2, name: 'ignored', color: 0 }] } },
    } as unknown as Guild
    expect(await writeRolePositionsLive(guild, [{ id: 'a', position: 3 }])).toEqual([{ id: 'a', position: 2 }])
  })
})

// ── 0.8.6: apply_server_spec's real path, which server.ts calls as-is ──────────────────────────────
describe('applyServerSpecChecked — a deleting apply needs confirm_deletions, and nothing is written without it', () => {
  function deletableGuild() {
    const calls: string[] = []
    const roles = new Map([['200', {
      id: '200', name: 'Old', rawPosition: 1, position: 1, managed: false,
      delete: async () => { calls.push('delete role 200') },
    }]])
    const guild = { id: '1', name: 'Stub', roles: { cache: roles }, channels: { cache: new Map() }, members: { me: null } } as unknown as Guild
    return { guild, calls }
  }
  const diff: SpecDiff = { entries: [{ kind: 'role', op: 'delete', name: 'Old', id: '200', changes: [], dangerous: [] }], untouched: [] }
  const rendered = renderSpecDiff(diff)
  const noWrites = { writeRolePositions: async () => { throw new Error('no reorder expected') } }

  test('no confirm_deletions: refused, the rendered diff is returned, nothing deleted', async () => {
    const { guild, calls } = deletableGuild()
    const out = await applyServerSpecChecked(guild, {}, diff, rendered, undefined, noWrites)
    expect(out.isError).toBe(true)
    expect(out.text).toContain('confirm_deletions: 1')
    expect(out.text).toContain('- DELETE')
    expect(calls).toEqual([])
  })

  test('a mismatched count: refused, nothing deleted', async () => {
    const { guild, calls } = deletableGuild()
    const out = await applyServerSpecChecked(guild, {}, diff, rendered, 2, noWrites)
    expect(out.isError).toBe(true)
    expect(out.text).toContain('confirm_deletions is 2 but this diff deletes 1')
    expect(calls).toEqual([])
  })

  test('the exact count: applied, with the per-entry result and the diff it applied', async () => {
    const { guild, calls } = deletableGuild()
    const out = await applyServerSpecChecked(guild, {}, diff, rendered, 1, noWrites)
    expect(out.isError).toBe(false)
    expect(calls).toEqual(['delete role 200'])
    expect(out.text).toContain('applied to Stub: 1/1 change(s) succeeded')
    expect(out.text).toContain('── diff applied ──')
  })
})
