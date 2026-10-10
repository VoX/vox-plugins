/**
 * Apply a server-spec diff to a live guild.
 *
 * Split out of server.ts so it can be TESTED: server.ts has zero exports and a
 * top-level `await mcp.connect(...)` plus client.login(), so importing it to
 * reach applySpecDiff starts a bot. Nothing in this module touches the client
 * singleton or module-level state — everything arrives as an argument.
 */

import {
  ChannelType,
  DiscordAPIError,
  OverwriteType,
  type Guild,
  type CategoryChannel,
  type NonThreadGuildBasedChannel,
  type GuildChannelTypes,
  type GuildChannelEditOptions,
  type OverwriteData,
  type PermissionOverwriteOptions,
  type PermissionResolvable,
} from 'discord.js'
import {
  deletionConfirmRefusal,
  specEntryLabel,
  namedOrderingConstraints,
  resolveOrderingConstraints,
  planRolePositions,
  explainOrderingRefusal,
  isSyntheticRoleId,
  kindToChannelType,
  resolveColorInput,
  type ServerSpec,
  type RawGuildState,
  type SpecDiff,
  type SpecOverwrite,
  type OverwriteEdit,
  type RolePositionInput,
} from './lib'

/** Injected so the applier can be tested without a live guild. The default hits the
 *  REST route directly — see writeRolePositionsLive for why no discord.js helper. */
export type ApplyDeps = {
  writeRolePositions(guild: Guild, body: Array<{ id: string; position: number }>): Promise<Array<{ id: string; position: number }>>
}

/**
 * PATCH /guilds/{id}/roles, straight at the route.
 *
 * NOT RoleManager.setPositions, and NOT Role.setPosition. Both are the audited bug:
 *  - setPositions awaits the PATCH, DISCARDS the response, and updates the cache from
 *    the array it SENT (RoleManager.js:364-377 -> GuildRolesPositionUpdate.js:10-13).
 *    Measured consequence: we asked for position 3 and Discord returned 2, so a
 *    request-side cache reports 3 forever and get_server_spec exports a lie.
 *  - setPosition is worse — it takes an array INDEX, not a raw position, and PATCHes
 *    the whole guild once per call from a cache the previous call already poisoned.
 *
 * The response is the authority. It comes back as APIRole[] with no rank field, which
 * is fine: the only thing adopted here is (id, position), and the rank is recomputed
 * wherever it is next needed.
 */
export async function writeRolePositionsLive(
  guild: Guild,
  body: Array<{ id: string; position: number }>,
): Promise<Array<{ id: string; position: number }>> {
  const res = await guild.client.rest.patch(`/guilds/${guild.id}/roles`, { body }) as Array<{ id: string; position: number }>
  return res.map(r => ({ id: r.id, position: r.position }))
}

const LIVE_DEPS: ApplyDeps = { writeRolePositions: writeRolePositionsLive }

// Extract the plain-data state buildServerSpec consumes. Everything reads from
// cache: with the Guilds intent, role/channel/overwrite caches and members.me
// are fully hydrated at READY — no explicit fetch needed.
export function snapshotGuild(guild: Guild): RawGuildState {
  const roles = [...guild.roles.cache.values()]
    .filter(r => r.id !== guild.id)
    .map(r => ({
      id: r.id, name: r.name, hexColor: r.hexColor, hoist: r.hoist,
      mentionable: r.mentionable, permissions: r.permissions.toArray(),
      // BOTH, because they are different numbers and only one of them is real.
      // Role.position is a computed sorted RANK; rawPosition is what Discord stores
      // and the only one you can send back. The channel branch below already got
      // this right (c.rawPosition) -- roles did not, so the two looked alike and lied.
      position: r.position, rawPosition: r.rawPosition, managed: r.managed,
    }))
  const channels = [...guild.channels.cache.values()]
    .filter((c): c is NonThreadGuildBasedChannel => !c.isThread())
    .map(c => ({
      id: c.id, name: c.name, type: c.type as number, parentId: c.parentId,
      position: c.rawPosition,
      topic: 'topic' in c ? c.topic : null,
      rateLimitPerUser: 'rateLimitPerUser' in c ? c.rateLimitPerUser ?? null : null,
      nsfw: 'nsfw' in c ? c.nsfw : false,
      overwrites: [...c.permissionOverwrites.cache.values()].map(o => ({
        id: o.id,
        type: o.type === OverwriteType.Role ? 'role' as const : 'member' as const,
        allow: o.allow.toArray(),
        deny: o.deny.toArray(),
      })),
    }))
  return {
    guildId: guild.id,
    everyonePermissions: guild.roles.everyone.permissions.toArray(),
    roles,
    channels,
  }
}

// Discord's 50013 is famously terse — translate the common failure modes into
// something actionable (mirrors get_user_info's isolated-failure style).
export function explainApplyError(err: unknown): string {
  if (err instanceof DiscordAPIError) {
    if (err.code === 50013) {
      return 'Missing Permissions — the bot needs Manage Roles / Manage Channels for this, and for role edits its own highest role must sit ABOVE the target role (Server Settings → Roles, drag the bot role up)'
    }
    return `${err.message} (Discord error ${err.code})`
  }
  return err instanceof Error ? err.message : String(err)
}

// Spec overwrite target → concrete snowflake + OverwriteType. '@everyone' is
// the role whose id === guild id; 'role:<Name>' resolves through roleByName
// (which applySpecDiff keeps updated as it creates roles); raw snowflakes
// pass through with the spec's declared role/member type.
function resolveOverwriteTarget(guild: Guild, o: Pick<SpecOverwrite, 'id' | 'type'>, roleByName: Map<string, string>): { id: string; type: OverwriteType } {
  if (o.id === '@everyone') return { id: guild.id, type: OverwriteType.Role }
  if (o.id.startsWith('role:')) {
    const name = o.id.slice('role:'.length)
    const id = roleByName.get(name)
    if (!id) throw new Error(`overwrite target ${o.id}: no role named "${name}" in ${guild.name}`)
    return { id, type: OverwriteType.Role }
  }
  return { id: o.id, type: o.type === 'member' ? OverwriteType.Member : OverwriteType.Role }
}

// Create-time overwrites are the OverwriteResolvable[] form ({ id, allow:
// [names], deny: [names] }) — NOT the boolean map permissionOverwrites.edit
// takes post-create. The explicit type spares discord.js a cache lookup that
// throws for users it hasn't seen.
function toCreateOverwrites(guild: Guild, ows: SpecOverwrite[], roleByName: Map<string, string>): OverwriteData[] {
  return ows.map(o => {
    const target = resolveOverwriteTarget(guild, o, roleByName)
    return {
      id: target.id,
      type: target.type,
      ...(o.allow ? { allow: o.allow as PermissionResolvable } : {}),
      ...(o.deny ? { deny: o.deny as PermissionResolvable } : {}),
    }
  })
}

async function applyOverwriteEdits(channel: NonThreadGuildBasedChannel, edits: OverwriteEdit[], guild: Guild, roleByName: Map<string, string>): Promise<void> {
  for (const edit of edits) {
    const target = resolveOverwriteTarget(guild, edit, roleByName)
    await channel.permissionOverwrites.edit(target.id, edit.set as PermissionOverwriteOptions, { type: target.type })
  }
}

// Apply a computed diff, isolating failures per entry (one hierarchy error
// doesn't abort the rest). Entry order from computeSpecDiff is already
// dependency-ordered: @everyone → roles → categories → channels for
// creates/updates (so role:<Name> overwrites and parent categories created
// earlier in the run resolve), then renames/moves, then deletes (child
// channels → their now-empty categories → roles).
/**
 * apply_server_spec's real (non-dry-run) path, as server.ts runs it: the deletion self-check, then the
 * apply. Here rather than inline so the check is exercised by the same code that dispatches the write.
 * `rendered` is renderSpecDiff(diff); a refusal returns it so the caller sees what it must confirm.
 */
export async function applyServerSpecChecked(
  guild: Guild, desired: ServerSpec, diff: SpecDiff, rendered: string, confirmDeletions: unknown, deps: ApplyDeps = LIVE_DEPS,
): Promise<{ text: string; isError: boolean }> {
  const refusal = deletionConfirmRefusal(diff, confirmDeletions)
  if (refusal) return { text: `${refusal}\n\n${rendered}`, isError: true }
  const result = await applySpecDiff(guild, desired, diff, deps)
  return { text: `${result}\n\n── diff applied ──\n${rendered}`, isError: false }
}

export async function applySpecDiff(guild: Guild, desired: ServerSpec, diff: SpecDiff, deps: ApplyDeps = LIVE_DEPS): Promise<string> {
  const roleByName = new Map<string, string>()
  for (const r of guild.roles.cache.values()) {
    // Exclude managed (integration/bot) roles so name-resolution here matches
    // the diff, which is computed against a role set that filters out managed
    // roles. Otherwise a `role:<Name>` overwrite or a role modify could resolve
    // to a managed namesake the diff was never computed against.
    if (r.managed) continue
    const prev = roleByName.get(r.name)
    // ambiguous names resolve to the higher role, matching Discord's display order
    if (!prev || (guild.roles.cache.get(prev)?.position ?? -1) < r.position) roleByName.set(r.name, r.id)
  }
  const catByName = new Map<string, CategoryChannel>()
  for (const c of guild.channels.cache.values()) {
    if (c.type === ChannelType.GuildCategory) catByName.set(c.name, c as CategoryChannel)
  }
  // Renames apply AFTER the create/update phase, but earlier entries may
  // already reference entities by their NEW names ('role:<Name>' overwrite
  // targets, parent-category lookups). Seed the name maps with each
  // id-matched desired name so those references resolve to the renamed
  // target instead of missing (or hitting a doomed namesake).
  for (const r of desired.roles ?? []) {
    const live = r.id ? guild.roles.cache.get(r.id) : undefined
    // Managed check mirrors the diff, which never id-matches managed roles.
    if (live && !live.managed) roleByName.set(r.name, live.id)
  }
  for (const c of desired.categories ?? []) {
    const live = c.id ? guild.channels.cache.get(c.id) : undefined
    if (live?.type === ChannelType.GuildCategory) catByName.set(c.name, live as CategoryChannel)
  }
  const desiredRoleByName = new Map((desired.roles ?? []).map(r => [r.name, r]))
  const desiredCatByName = new Map((desired.categories ?? []).map(c => [c.name, c]))
  const chanKey = (cat: string | null, name: string) => `${cat ?? ''}\u0000${name}`
  const desiredChanByKey = new Map(
    [
      ...(desired.categories ?? []).flatMap(cat => (cat.channels ?? []).map(ch => [chanKey(cat.name, ch.name), ch] as const)),
      ...(desired.channels ?? []).map(ch => [chanKey(null, ch.name), ch] as const),
    ],
  )
  const findChannel = (cat: string | null, name: string): NonThreadGuildBasedChannel | undefined =>
    [...guild.channels.cache.values()].find((c): c is NonThreadGuildBasedChannel =>
      !c.isThread() && c.type !== ChannelType.GuildCategory && c.name === name && (c.parent?.name ?? null) === cat,
    )

  const lines: string[] = []
  const OP_VERB = { create: 'create', modify: 'update', rename: 'rename', move: 'move', delete: 'delete', reorder: 'reorder' } as const
  for (const e of diff.entries) {
    const label = `${OP_VERB[e.op]} ${specEntryLabel(e)}`
    const changed = new Set(e.changes.map(c => c.field))
    try {
      if (e.op === 'delete') {
        // Diff order already sequences channels → categories → roles. A
        // target that's already gone counts as done, not an error.
        if (e.kind === 'role') {
          const role = guild.roles.cache.get(e.id!)
          if (role) await role.delete()
        } else {
          const ch = guild.channels.cache.get(e.id!)
          if (ch && !ch.isThread()) await ch.delete()
        }
      } else if (e.op === 'rename') {
        if (e.kind === 'role') {
          const role = guild.roles.cache.get(e.id!)
          if (!role) throw new Error(`role "${e.name}" vanished between diff and apply`)
          await role.setName(e.name)
        } else {
          const ch = guild.channels.cache.get(e.id!)
          if (!ch || ch.isThread()) throw new Error(`${specEntryLabel(e)} vanished between diff and apply`)
          await ch.setName(e.name)
        }
      } else if (e.op === 'move') {
        const ch = guild.channels.cache.get(e.id!)
        if (!ch || ch.isThread()) throw new Error(`${specEntryLabel(e)} vanished between diff and apply`)
        const parent = e.category ? catByName.get(e.category) : null
        if (e.category && !parent) throw new Error(`target category "${e.category}" missing (its create may have failed above)`)
        // lockPermissions: false — keep the channel's own overwrites rather
        // than syncing them to the new parent's.
        await ch.setParent(parent ?? null, { lockPermissions: false })
      } else if (e.kind === 'everyone') {
        await guild.roles.everyone.edit({ permissions: desired.everyone_permissions as PermissionResolvable })
      } else if (e.kind === 'role') {
        const want = desiredRoleByName.get(e.name)!
        if (e.op === 'create') {
          const created = await guild.roles.create({
            name: want.name,
            ...(want.color !== undefined ? { colors: { primaryColor: resolveColorInput(want.color) } } : {}),
            ...(want.hoist !== undefined ? { hoist: want.hoist } : {}),
            ...(want.mentionable !== undefined ? { mentionable: want.mentionable } : {}),
            ...(want.permissions ? { permissions: want.permissions as PermissionResolvable } : {}),
            // No `position`: POST /guilds/{id}/roles has no such field (measured — asked
            // for 3, the role landed at 1). discord.js EMULATES it with a follow-up
            // setPosition, i.e. a second, whole-guild write hidden behind a create.
          })
          roleByName.set(created.name, created.id)
        } else {
          const roleId = e.id ?? roleByName.get(e.name)
          const role = roleId ? guild.roles.cache.get(roleId) : undefined
          if (!role) throw new Error(`role "${e.name}" vanished between diff and apply`)
          await role.edit({
            ...(changed.has('color') ? { colors: { primaryColor: resolveColorInput(want.color!) } } : {}),
            ...(changed.has('hoist') ? { hoist: want.hoist } : {}),
            ...(changed.has('mentionable') ? { mentionable: want.mentionable } : {}),
            ...(changed.has('permissions') ? { permissions: want.permissions as PermissionResolvable } : {}),
          })
        }
      } else if (e.kind === 'category') {
        const want = desiredCatByName.get(e.name)!
        if (e.op === 'create') {
          const created = await guild.channels.create({
            name: want.name,
            type: ChannelType.GuildCategory,
            ...(want.overwrites ? { permissionOverwrites: toCreateOverwrites(guild, want.overwrites, roleByName) } : {}),
          })
          catByName.set(created.name, created)
        } else {
          const live = e.id ? guild.channels.cache.get(e.id) : catByName.get(e.name)
          const target = live?.type === ChannelType.GuildCategory ? (live as CategoryChannel) : undefined
          if (!target) throw new Error(`category "${e.name}" vanished between diff and apply`)
          await applyOverwriteEdits(target, e.overwriteEdits ?? [], guild, roleByName)
        }
      } else if (e.kind === 'ordering') {
        await applyRoleOrdering(guild, desired, e, deps, lines)
      } else if (e.kind === 'channel') {
        const want = desiredChanByKey.get(chanKey(e.category ?? null, e.name))!
        if (e.op === 'create') {
          const parent = e.category ? catByName.get(e.category) : undefined
          if (e.category && !parent) throw new Error(`parent category "${e.category}" missing (its create may have failed above)`)
          await guild.channels.create({
            name: want.name,
            type: kindToChannelType(want.kind ?? 'text') as GuildChannelTypes,
            ...(parent ? { parent } : {}),
            ...(want.topic !== undefined ? { topic: want.topic } : {}),
            ...(want.slowmode !== undefined ? { rateLimitPerUser: want.slowmode } : {}),
            ...(want.nsfw !== undefined ? { nsfw: want.nsfw } : {}),
            ...(want.overwrites ? { permissionOverwrites: toCreateOverwrites(guild, want.overwrites, roleByName) } : {}),
          })
        } else {
          let target: NonThreadGuildBasedChannel | undefined
          if (e.id) {
            const live = guild.channels.cache.get(e.id)
            if (live && !live.isThread()) target = live
          } else {
            target = findChannel(e.category ?? null, e.name)
          }
          if (!target) throw new Error(`${specEntryLabel(e)} vanished between diff and apply`)
          const edit: GuildChannelEditOptions = {
            ...(changed.has('topic') ? { topic: want.topic } : {}),
            ...(changed.has('slowmode') ? { rateLimitPerUser: want.slowmode } : {}),
            ...(changed.has('nsfw') ? { nsfw: want.nsfw } : {}),
          }
          if (Object.keys(edit).length > 0) await target.edit(edit)
          await applyOverwriteEdits(target, e.overwriteEdits ?? [], guild, roleByName)
        }
      } else {
        // Reached only when computeSpecDiff emits a kind this dispatch has not been
        // taught. It used to be the CHANNEL branch: an unknown kind fell through the
        // bare `else` and was reported as a channel that "vanished between diff and
        // apply" -- an entry that was never applied, reported as a race that never
        // happened. Five of the six kind-dispatch sites failed silently the same way.
        throw new Error(`internal: no applier for diff entry kind "${(e as { kind: string }).kind}" (op "${e.op}") — the diff produced something this build cannot apply`)
      }
      lines.push(`✓ ${label}`)
    } catch (err) {
      lines.push(`✗ ${label} — ${explainApplyError(err)}`)
    }
  }
  const failed = lines.filter(l => l.startsWith('✗')).length
  const header = `applied to ${guild.name}: ${lines.length - failed}/${lines.length} change(s) succeeded${failed > 0 ? `, ${failed} failed` : ''}`
  return [header, ...lines].join('\n')
}

/**
 * Apply the hierarchy reorder — re-planned, not replayed.
 *
 * The plan in the diff entry is a PROJECTION built before anything was applied: roles
 * this run creates had no snowflake yet and carry synthetic ids. Replaying its body
 * would PATCH ids that do not exist. So the constraints are re-resolved against the
 * guild as it now stands and the plan is recomputed.
 *
 * That re-plan is also the drift check. What the diff planned is a set of relational
 * statements and their privilege consequences, not a vector of integers — so cosmetic
 * renumbering between planning and the write is not a reason to abort, but a role appearing
 * or disappearing from the affected band is. (Before 0.8.6 this was the window an owner
 * approval sat in; the approval is gone but the earlier phases of the apply still run first.)
 */
async function applyRoleOrdering(
  guild: Guild,
  desired: ServerSpec,
  entry: SpecDiff['entries'][number],
  deps: ApplyDeps,
  lines?: string[],
): Promise<void> {
  const me = guild.members.me
  if (!me) throw new Error('cannot reorder roles: this bot is not a member of the guild')

  const live: RolePositionInput[] = [...guild.roles.cache.values()].map(r => ({
    id: r.id, name: r.name, rawPosition: r.rawPosition, managed: r.managed,
  }))
  const nameOf = (id: string) => live.find(r => r.id === id)?.name ?? id

  const plan = planRolePositions(
    live,
    resolveOrderingConstraints(live, namedOrderingConstraints(desired)),
    { botHighestRoleId: me.roles.highest.id, everyoneRoleId: guild.id },
  )
  if ('refusal' in plan) throw new Error(explainOrderingRefusal(plan.refusal, nameOf))
  if (plan.writes.length === 0) {
    // Nothing to write: the earlier phases of this apply, or someone by hand, already produced the
    // order. Reporting a bare tick would claim a write that never happened.
    lines?.push('  (hierarchy already correct — no write needed)')
    return
  }

  // DRIFT. The diff planned a specific final ORDER, so that is what gets compared -- position by
  // position, by ID.
  //
  // The first version compared the SET OF NAMES that move. Two ways that let real drift through, both
  // demonstrated: a role already in the approved set could be dragged to a completely different rank
  // between approval and apply and the set was unchanged, so the complete body then WROTE that new
  // rank in as if approved; and swapping two roles' names re-pointed the constraint at a different
  // role while the name set stayed identical. Comparing ids in sequence catches both. Roles this run
  // CREATES are the one thing that legitimately cannot match -- they carried placeholder ids at diff
  // time -- so those slots, and only those, are wildcards.
  const approved = entry.ordering
  if (approved) {
    const want = approved.after.map(r => r.id)
    const now = [...plan.writes].sort((a, b) => b.position - a.position).map(w => w.id)
    const sameLength = want.length === now.length
    const drifted = !sameLength || want.some((id, i) => id !== now[i] && !isSyntheticRoleId(id))
    if (drifted) {
      const nameOfApproved = (id: string) =>
        approved.after.find(r => r.id === id)?.name ?? approved.before.find(r => r.id === id)?.name ?? id
      const detail = sameLength
        ? want.map((id, i) => (id !== now[i] && !isSyntheticRoleId(id)
            ? `rank ${want.length - 1 - i}: planned "${nameOfApproved(id)}", now "${nameOf(now[i]!)}"` : null))
            .filter(Boolean).slice(0, 4).join('; ')
        : `${want.length} role(s) planned, ${now.length} now`
      throw new Error(
        `role ordering: the guild changed since this diff was planned — ${detail}. Nothing was written. `
        + `Re-run apply_server_spec (dry_run first) against the current state.`)
    }
  }

  const got = await deps.writeRolePositions(guild, plan.writes)

  // Verify against the RESPONSE, not the request. Reporting a tick because the call
  // did not throw is how the original bug stayed invisible: apply said ✓ to a reorder
  // it never performed.
  const gotById = new Map(got.map(r => [r.id, r.position]))
  const wrong = plan.writes.filter(w => gotById.get(w.id) !== w.position)
  if (wrong.length > 0) {
    throw new Error(
      `role ordering: Discord stored a different order than requested for `
      + `${wrong.map(w => `"${nameOf(w.id)}" (asked ${w.position}, got ${gotById.get(w.id) ?? 'nothing'})`).join(', ')}. `
      + `The hierarchy may be partly changed — re-run get_server_spec to see the current state.`)
  }
}
