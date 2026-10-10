// Pure helpers used by server.ts. Kept in their own file so they can be
// unit-tested without booting the full MCP server (which connects to
// Discord on import).

import { ChannelType, EmbedBuilder, PermissionFlagsBits, PermissionsBitField, resolveColor, type ColorResolvable, type PermissionResolvable } from 'discord.js'

// JS string `.slice(0, N)` operates on UTF-16 code units. Multi-codepoint
// emoji (any character outside the BMP — e.g. 🦝, 🫡, 🐧) take TWO code
// units; cutting between them strands a lone high surrogate that JSON
// encodes as `\ud83e` and Anthropic's parser rejects with HTTP 400 — which
// poisons every subsequent reply on session resume. `Array.from(str)`
// iterates by codepoint, so slicing the resulting array preserves emoji
// integrity. (Doesn't handle ZWJ-glued sequences like 👨‍👩‍👧‍👦 as a
// single grapheme — those split into component emoji — but no encoding
// error, just a visual artifact in a 200-char snippet preview.)
export function safeSlice(str: string, n: number): string {
  // Fast path: most strings (titles, footers, single-line snippets) are
  // already under the cap, so skip the codepoint walk entirely.
  if (str.length <= n) return str
  return Array.from(str).slice(0, n).join('')
}

export function formatSendResult(ids: string[]): string {
  return ids.length === 1
    ? `sent (id: ${ids[0]})`
    : `sent ${ids.length} parts (ids: ${ids.join(', ')})`
}

// Allowlist URL schemes for embed url/thumbnail_url/image_url to keep
// `javascript:` / `data:` / unknown protocols out of attacker-controlled
// embed fields. Discord clients refuse to render most non-http(s), but
// the API accepts them and `setURL` (title link) is not proxied.
export function assertEmbedUrl(field: string, value: string): void {
  if (!/^https?:\/\//i.test(value)) {
    throw new Error(`${field} must be an http(s) URL (got: ${JSON.stringify(safeSlice(value, 80))})`)
  }
}

// Build an EmbedBuilder from a tool-call args object. Shared by `send_embed`
// (post a new embed) and `edit_embed` (replace an existing embed in-place).
// Validation throws (invalid url scheme, oversized fields list, malformed
// color, bad timestamp) so callers don't have to repeat the checks.
export function buildEmbedFromArgs(args: Record<string, unknown>): EmbedBuilder {
  const title = args.title as string | undefined
  const description = args.description as string | undefined
  const url = args.url as string | undefined
  const thumbnail_url = args.thumbnail_url as string | undefined
  const image_url = args.image_url as string | undefined
  const footer = args.footer as string | undefined
  const color = args.color as string | undefined
  const author = args.author as { name?: unknown; url?: unknown; icon_url?: unknown } | undefined
  const timestamp = args.timestamp as string | boolean | undefined

  if (url) assertEmbedUrl('url', url)
  if (thumbnail_url) assertEmbedUrl('thumbnail_url', thumbnail_url)
  if (image_url) assertEmbedUrl('image_url', image_url)

  const embed = new EmbedBuilder()
  if (title) embed.setTitle(safeSlice(title, 256))
  if (description) embed.setDescription(safeSlice(description, 4096))
  if (url) embed.setURL(url)
  if (thumbnail_url) embed.setThumbnail(thumbnail_url)
  if (image_url) embed.setImage(image_url)
  if (footer) embed.setFooter({ text: safeSlice(footer, 2048) })
  if (author && typeof author.name === 'string') {
    if (typeof author.url === 'string') assertEmbedUrl('author.url', author.url)
    if (typeof author.icon_url === 'string') assertEmbedUrl('author.icon_url', author.icon_url)
    embed.setAuthor({
      name: safeSlice(author.name, 256),
      ...(typeof author.url === 'string' ? { url: author.url } : {}),
      ...(typeof author.icon_url === 'string' ? { iconURL: author.icon_url } : {}),
    })
  }
  if (timestamp === true) {
    embed.setTimestamp(new Date())
  } else if (typeof timestamp === 'string') {
    const t = Date.parse(timestamp)
    if (isNaN(t)) throw new Error(`invalid timestamp: ${timestamp} (use ISO-8601 or boolean true for now)`)
    embed.setTimestamp(new Date(t))
  }
  if (color) {
    embed.setColor(resolveColorInput(color))
  }
  if (Array.isArray(args.fields)) {
    const raw = args.fields as Array<{ name?: unknown; value?: unknown; inline?: unknown }>
    if (raw.length > 25) throw new Error(`Discord allows max 25 embed fields (got ${raw.length})`)
    const fields = raw.map((f, i) => {
      if (typeof f.name !== 'string' || typeof f.value !== 'string') {
        throw new Error(`field[${i}] missing name or value`)
      }
      return {
        name: safeSlice(f.name, 256),
        value: safeSlice(f.value, 1024),
        inline: f.inline === true,
      }
    })
    embed.addFields(fields)
  }
  return embed
}

// Resolve a color string to a discord.js color number. resolveColor's
// named-color lookup is case-sensitive (`Blurple`, not `blurple`).
// Auto-capitalize purely-alpha input so callers don't have to think about
// it. Hex starts with `#` or a digit, both no-op under capitalize. Shared
// by embed building and role-spec color handling.
export function resolveColorInput(color: string): number {
  const normalized = /^[a-z]+$/i.test(color)
    ? color.charAt(0).toUpperCase() + color.slice(1).toLowerCase()
    : color
  try {
    return resolveColor(normalized as ColorResolvable)
  } catch {
    throw new Error(`invalid color: ${color} (use hex like #5865f2 or a discord.js Colors name like 'Blurple')`)
  }
}

// Shared JSON-Schema property block for embed fields. Used by both the
// `send_embed` and `edit_embed` tool definitions so the field surface stays
// in lockstep — adding a new embed field only edits one place.
export const EMBED_SCHEMA_PROPS = {
  title: { type: 'string', description: 'Embed title (truncated to 256 codepoints).' },
  description: { type: 'string', description: 'Embed body (truncated to 4096 codepoints; markdown supported).' },
  color: { type: 'string', description: 'Color: hex like "#5865f2" / "5865f2", or a discord.js Colors name (Blurple, Green, Red, Yellow, Fuchsia, Orange, LuminousVividPink, Greyple, White, etc., or "Random"). Lowercase names are auto-capitalized.' },
  fields: {
    type: 'array',
    items: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        value: { type: 'string' },
        inline: { type: 'boolean' },
      },
      required: ['name', 'value'],
    },
    description: 'Up to 25 fields. name truncated to 256, value to 1024. inline=true displays side-by-side (3 per row max).',
  },
  thumbnail_url: { type: 'string', description: 'Image URL — small, top-right of the embed. Must be http(s).' },
  image_url: { type: 'string', description: 'Image URL — full-width, below the description. Must be http(s).' },
  footer: { type: 'string', description: 'Footer text (truncated to 2048 codepoints).' },
  url: { type: 'string', description: 'URL the title links to. Must be http(s).' },
  author: {
    type: 'object',
    description: 'Optional author block at the top of the embed (above the title).',
    properties: {
      name: { type: 'string', description: 'Author display name (truncated to 256 codepoints). Required if author is set.' },
      url: { type: 'string', description: 'Optional URL for the author name to link to. Must be http(s).' },
      icon_url: { type: 'string', description: 'Optional small avatar URL shown next to the author name. Must be http(s).' },
    },
  },
  timestamp: {
    description: 'Optional timestamp shown at the bottom of the embed. Pass `true` for "now", or an ISO-8601 string for a specific moment.',
  },
} as const

// Splits long text at the closest whitespace boundary under `limit` so a
// single reply can ship across multiple Discord messages without breaking
// mid-mention or mid-word. Prefers paragraph breaks > line breaks > word
// breaks > hard cut at limit.
export function chunk(text: string, limit: number): string[] {
  if (text.length <= limit) return [text]
  const out: string[] = []
  let rest = text
  while (rest.length > limit) {
    const para = rest.lastIndexOf('\n\n', limit)
    const line = rest.lastIndexOf('\n', limit)
    const space = rest.lastIndexOf(' ', limit)
    const cut = para > 0 ? para : line > 0 ? line : space > 0 ? space : limit
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\s+/, '')
  }
  if (rest) out.push(rest)
  return out
}

// ── Presence aggregation (pure; composes the per-turn action sequence) ──────────
export const PRESENCE_IDLE = '💤 idle…'
// Match the sentinel by its EMOJI marker, not the word — so a Bash classifier label like
// "⚙️ run idle…" (a command named "idle") isn't mistaken for the rest/working sentinel.
export const isIdle = (t: string) => t.includes('💤')
export const isWorking = (t: string) => t.includes('🐾')

// Prefix the live context-window size (the number Claude Code's /status shows, e.g. "565k") in front of
// a presence status → "565k - 💤 idle…". Empty ctx (unknown / not computed yet) or empty text (clearing
// presence) leaves the text unchanged, so a clear stays a clear and turn-1 shows no stray prefix.
export const withContextPrefix = (ctx: string, text: string): string =>
  ctx && text ? `${ctx} - ${text}` : text

// Compose the aggregate from the per-turn sequence file: the DISTINCT actions that fired
// this turn, in first-occurrence order, space-joined with one trailing ellipsis. "working"
// is dropped unless it's the only thing that fired; '' for empty/absent. Parse/compose happens
// BEFORE sanitize (which strips the newlines the sequence relies on).
//
// idle is terminal but ORDER-AUTHORITATIVE: it only rests if it's the LAST line. A tool append
// landing after the Stop hook's idle write (a parallel-hook race) means work actually continued,
// so we show the work and ignore the stray non-trailing idle — making the reader self-correcting
// regardless of write ordering.
export function composePresence(raw: string): string {
  const lines = raw.split('\n').map(l => l.trim()).filter(Boolean)
  if (lines.length === 0) return ''
  if (isIdle(lines[lines.length - 1]!)) return PRESENCE_IDLE
  const actions = lines.filter(l => !isIdle(l))  // drop stray (non-trailing) idle lines from races
  if (actions.length === 0) return ''
  const seen = new Set<string>()
  const distinct = actions.filter(l => (seen.has(l) ? false : (seen.add(l), true)))
  let kept = distinct.filter(l => !isWorking(l))
  if (kept.length === 0) kept = distinct.filter(isWorking).slice(0, 1)  // only working fired
  if (kept.length === 0) return ''
  const strip = (l: string) => l.replace(/[…．.\s]+$/u, '')
  let body = kept.map(strip).join(' ')
  while (body.length > 120 && kept.length > 1) {       // 128-char cap: drop oldest, prefix ellipsis
    kept = kept.slice(1)
    body = '… ' + kept.map(strip).join(' ')
  }
  return body + '…'
}

// ── Server spec (pure core of get_server_spec / apply_server_spec) ──────────
// A ServerSpec is a declarative snapshot of a guild's structure: @everyone
// permissions, roles, categories with their channels, and permission
// overwrites. get_server_spec serializes a guild INTO this shape;
// apply_server_spec diffs a desired spec against the live guild and upserts.
// Everything here is pure — server.ts owns the discord.js reads/writes.

export type SpecOverwrite = {
  /** Target: '@everyone', 'role:<Name>', or a raw user/role snowflake. */
  id: string
  /** Required for raw-snowflake targets so apply doesn't depend on cache lookups. */
  type?: 'role' | 'member'
  allow?: string[]
  deny?: string[]
}

export type SpecRole = {
  name: string
  /** The role's Discord snowflake, emitted by get_server_spec. Keep it when
   *  editing a spec so a name change renames the live role instead of
   *  creating a new one. A stale/foreign id falls back to name matching. */
  id?: string
  /** Hex like '#5865f2' or a discord.js Colors name. Omitted = default (no color). */
  color?: string
  hoist?: boolean
  mentionable?: boolean
  /** PermissionFlagsBits names, e.g. ['ViewChannel', 'KickMembers']. */
  permissions?: string[]
  /** Put this role ABOVE the named role(s) in the hierarchy. Names, resolved against
   *  the guild as it will look AFTER this spec's creates and renames — so a spec that
   *  renames "Moderator" to "op" must say `above: "op"`. An unresolvable or ambiguous
   *  name is an error, never a silent skip. This is how you reorder; `position` is not. */
  above?: string | string[]
  /** Put this role BELOW the named role(s). See `above`. */
  below?: string | string[]
  /** READ-ONLY. The role's RAW position — the number Discord stores, NOT a 1..N
   *  ranking. Roles routinely TIE here (a fresh guild can have every role at 1), and
   *  a tie is real information: tied roles are ordered by id, and a bot cannot
   *  reorder roles it is tied with.
   *
   *  It is exported so you can SEE the hierarchy. It is not an instruction, and it
   *  is not the unit you would reorder in even if it were: Discord treats a position
   *  in a partial write as ADVISORY (asked for 3, placed at 2 — measured), and
   *  normalises the whole guild to contiguous numbers on any complete write. Supply
   *  it unchanged (a round-tripped export is a no-op) or omit it; a DIFFERENT value
   *  is a hard error rather than something silently dropped.
   *
   *  This used to export discord.js's `Role.position`, a computed sorted INDEX. That
   *  reads as authoritative, can never show a tie, and cannot be fed back to the API
   *  — so a spec containing it was not, as the tool claims, "exactly the shape
   *  apply_server_spec consumes". */
  position?: number
}

export type SpecChannel = {
  name: string
  /** The channel's Discord snowflake, emitted by get_server_spec. Keep it so
   *  a name change renames the live channel and a category change moves it,
   *  instead of creating a duplicate. Stale/foreign ids fall back to name. */
  id?: string
  /** text | voice | announcement | forum | stage. Defaults to text on create. */
  kind?: string
  topic?: string
  /** rateLimitPerUser, in seconds. */
  slowmode?: number
  nsfw?: boolean
  overwrites?: SpecOverwrite[]
}

export type SpecCategory = {
  name: string
  /** The category's Discord snowflake, emitted by get_server_spec. Keep it so
   *  a name change renames the live category (its channels follow along). */
  id?: string
  overwrites?: SpecOverwrite[]
  channels?: SpecChannel[]
}

export type ServerSpec = {
  everyone_permissions?: string[]
  roles?: SpecRole[]
  categories?: SpecCategory[]
  /** Channels with no parent category. */
  channels?: SpecChannel[]
}

// Raw per-guild state as extracted from the discord.js caches (server.ts's
// snapshotGuild). Kept as plain data so buildServerSpec is unit-testable.
export type RawOverwrite = { id: string; type: 'role' | 'member'; allow: string[]; deny: string[] }
export type RawRole = {
  id: string; name: string; hexColor: string; hoist: boolean; mentionable: boolean
  permissions: string[]; managed: boolean
  /** discord.js Role.position — the computed sorted RANK. Use it to ORDER the export. */
  position: number
  /** The API's stored value. Use it for anything that is compared or sent back. */
  rawPosition: number
}
export type RawChannel = {
  id: string; name: string; type: number; parentId: string | null; position: number
  topic: string | null; rateLimitPerUser: number | null; nsfw: boolean
  overwrites: RawOverwrite[]
}
export type RawGuildState = {
  guildId: string
  everyonePermissions: string[]
  roles: RawRole[]        // excluding @everyone
  channels: RawChannel[]  // categories included, threads excluded
}

// Grants of any of these get a ⚠ flag in the rendered diff (informational — nothing waits on it).
export const DANGEROUS_PERMS: readonly string[] = [
  'Administrator', 'ManageGuild', 'ManageRoles', 'ManageChannels',
  'ManageWebhooks', 'KickMembers', 'BanMembers', 'MentionEveryone',
]

const KIND_TO_TYPE: Record<string, ChannelType> = {
  text: ChannelType.GuildText,
  voice: ChannelType.GuildVoice,
  announcement: ChannelType.GuildAnnouncement,
  forum: ChannelType.GuildForum,
  stage: ChannelType.GuildStageVoice,
}

export function kindToChannelType(kind: string): ChannelType {
  const t = KIND_TO_TYPE[kind]
  if (t === undefined) {
    throw new Error(`unknown channel kind "${kind}" (use ${Object.keys(KIND_TO_TYPE).join('/')})`)
  }
  return t
}

// null = a type the spec doesn't model (directory, media, …) — serializer skips it.
export function channelTypeToKind(type: number): string | null {
  for (const [kind, t] of Object.entries(KIND_TO_TYPE)) if (t === type) return kind
  return null
}

// Throws on any name that isn't a PermissionFlagsBits key. Object.hasOwn, not
// `in` — `in` walks the prototype chain and would accept 'constructor'.
// PermissionsBitField's constructor resolves eagerly as a second net.
export function validatePermissionNames(names: string[], where: string): string[] {
  const unknown = names.filter(n => typeof n !== 'string' || !Object.hasOwn(PermissionFlagsBits, n))
  if (unknown.length > 0) {
    throw new Error(`${where}: unknown permission name(s): ${unknown.join(', ')} (use PermissionFlagsBits names like ViewChannel, SendMessages, ManageRoles)`)
  }
  new PermissionsBitField(names as PermissionResolvable)
  return names
}

function sameSet(a: string[] | undefined, b: string[] | undefined): boolean {
  const setA = new Set(a ?? [])
  const setB = new Set(b ?? [])
  if (setA.size !== setB.size) return false
  for (const x of setA) if (!setB.has(x)) return false
  return true
}

function findDup(items: string[]): string | null {
  const seen = new Set<string>()
  for (const x of items) {
    if (seen.has(x)) return x
    seen.add(x)
  }
  return null
}

// Newly-granted dangerous permissions: present in after, absent from before.
function dangerousGrants(before: string[] | undefined, after: string[] | undefined): string[] {
  const prev = new Set(before ?? [])
  return (after ?? []).filter(p => !prev.has(p) && DANGEROUS_PERMS.includes(p))
}

// Serialize raw guild state into the spec shape. Deterministic: roles sorted
// by position (highest first, like the Discord UI), channels by position,
// permission arrays sorted. Managed roles (bot/integration roles) are
// excluded — they can't be created or freely edited. Every role/category/
// channel carries its snowflake as `id` so an edited export can rename/move
// entities in place (see computeSpecDiff's id matching). Role-targeted
// overwrites are emitted as '@everyone' / 'role:<Name>' (portable across
// guilds) when the name is unambiguous, raw snowflakes otherwise.
export function buildServerSpec(state: RawGuildState): ServerSpec {
  const nameCounts = new Map<string, number>()
  for (const r of state.roles) nameCounts.set(r.name, (nameCounts.get(r.name) ?? 0) + 1)
  const roleTarget = new Map<string, string>([[state.guildId, '@everyone']])
  for (const r of state.roles) {
    if (nameCounts.get(r.name) === 1) roleTarget.set(r.id, `role:${r.name}`)
  }

  const specOverwrites = (raw: RawOverwrite[]): SpecOverwrite[] | undefined => {
    const out: SpecOverwrite[] = []
    for (const o of raw) {
      if (o.allow.length === 0 && o.deny.length === 0) continue // no-op overwrite
      const id = o.type === 'role' ? roleTarget.get(o.id) ?? o.id : o.id
      const entry: SpecOverwrite = { id, type: o.type }
      if (o.allow.length > 0) entry.allow = [...o.allow].sort()
      if (o.deny.length > 0) entry.deny = [...o.deny].sort()
      out.push(entry)
    }
    return out.length > 0 ? out.sort((a, b) => a.id.localeCompare(b.id)) : undefined
  }

  const specChannel = (c: RawChannel): SpecChannel => {
    const ch: SpecChannel = { name: c.name, id: c.id, kind: channelTypeToKind(c.type)! }
    if (c.topic) ch.topic = c.topic
    if (c.rateLimitPerUser) ch.slowmode = c.rateLimitPerUser
    if (c.nsfw) ch.nsfw = true
    const ows = specOverwrites(c.overwrites)
    if (ows) ch.overwrites = ows
    return ch
  }

  const byPosition = (a: RawChannel, b: RawChannel) => a.position - b.position || a.id.localeCompare(b.id)
  const childrenOf = (parentId: string | null): SpecChannel[] =>
    state.channels
      .filter(c => c.parentId === parentId && c.type !== ChannelType.GuildCategory && channelTypeToKind(c.type) !== null)
      .sort(byPosition)
      .map(specChannel)

  // Order by the RAW position, with Discord's own tie-break, so the export reads
  // in true hierarchy order INCLUDING ties. Sorting by Role.position (the rank)
  // hid this: ranks are unique even when every role is tied on raw, so the sort
  // looked settled and the tie-break below was dead code.
  //
  // The tie-break is BigInt, not localeCompare: SMALLER (older) snowflake ranks
  // HIGHER (Role.js:230-239), and snowflakes crossed 18 -> 19 digits on 2022-07-22,
  // so a guild holding roles from both sides of that date has mixed-length ids and
  // a string compare puts every 19-digit id before every 18-digit one.
  const olderFirst = (a: RawRole, b: RawRole) => (snowflake(a.id) < snowflake(b.id) ? -1 : 1)
  const roles: SpecRole[] = [...state.roles]
    .filter(r => !r.managed)
    .sort((a, b) => b.rawPosition - a.rawPosition || olderFirst(a, b))
    .map(r => {
      const role: SpecRole = { name: r.name, id: r.id }
      if (r.hexColor && r.hexColor !== '#000000') role.color = r.hexColor
      if (r.hoist) role.hoist = true
      if (r.mentionable) role.mentionable = true
      role.permissions = [...r.permissions].sort()
      role.position = r.rawPosition   // raw, not the rank: see SpecRole.position
      return role
    })

  const categories: SpecCategory[] = state.channels
    .filter(c => c.type === ChannelType.GuildCategory)
    .sort(byPosition)
    .map(cat => {
      const out: SpecCategory = { name: cat.name, id: cat.id }
      const ows = specOverwrites(cat.overwrites)
      if (ows) out.overwrites = ows
      out.channels = childrenOf(cat.id)
      return out
    })

  const spec: ServerSpec = {
    everyone_permissions: [...state.everyonePermissions].sort(),
    roles,
    categories,
  }
  const topLevel = childrenOf(null)
  if (topLevel.length > 0) spec.channels = topLevel
  return spec
}

export type FieldChange = { field: string; before?: unknown; after: unknown }
/** Converging boolean map for permissionOverwrites.edit — see overwriteEditMap. */
export type OverwriteEdit = { id: string; type?: 'role' | 'member'; set: Record<string, boolean | null> }
/** The whole-guild role hierarchy, before and after, plus the body that gets it there.
 *  One entry, not one per role: it is a single PATCH that succeeds or fails whole, and
 *  a per-role diff would imply per-role writes, which Discord does not offer. */
export type OrderingChange = {
  before: Array<{ id: string; name: string }>   // highest first
  after: Array<{ id: string; name: string }>    // highest first
  /** The complete PATCH body. Complete because a partial one is advisory. */
  writes: Array<{ id: string; position: number }>
  /** Roles at or above the bot's ceiling: emitted unmoved, never planned around. */
  frozen: string[]
}

export type SpecDiffEntry = {
  kind: 'everyone' | 'role' | 'category' | 'channel' | 'ordering'
  op: 'create' | 'modify' | 'rename' | 'move' | 'delete' | 'reorder'
  name: string
  /** The live entity's snowflake — set on id-matched modify and on every
   *  rename/move/delete so the applier resolves targets across renames. */
  id?: string
  /** channels only: parent category name (null = top-level). */
  category?: string | null
  changes: FieldChange[]
  /** modify only: per-target overwrite edit maps for the applier. */
  overwriteEdits?: OverwriteEdit[]
  /** ordering only. */
  ordering?: OrderingChange
  /** Human-readable ⚠ lines for dangerous grants. */
  dangerous: string[]
}
export type SpecDiff = {
  entries: SpecDiffEntry[]
  untouched: string[]
  /** Live channel + category count — feeds the large-prune banner. */
  channelCount?: number
}

// Prune needs guild context the spec shape doesn't carry: which live roles
// are managed, which the bot itself holds, and the guild id (identifies
// @everyone). The never-delete filter consuming these is hard-coded inside
// computeSpecDiff. NOTE: omitting managedRoleIds/botRoleIds REDUCES protection
// (they're id backstops) — in practice server.ts always passes full context,
// AND buildServerSpec pre-excludes managed/@everyone from `current`, so via the
// live get_server_spec→apply path those roles are double-protected regardless.
// id-less current entries are always unprunable (no id to target).
export type SpecDiffOptions = {
  /** Also emit delete entries for live entities the spec doesn't claim.
   *  Default false — purely additive, exactly the pre-prune behavior. */
  prune?: boolean
  /** The guild's id — @everyone is the role whose id equals it. */
  guildId?: string
  /** Ids of managed (bot/integration/booster) roles. */
  managedRoleIds?: string[]
  /** Ids of roles the bot itself holds (its highest role). */
  botRoleIds?: string[]
  /** EVERY live role including managed ones and @everyone, with raw positions.
   *  Required when the spec carries above/below. ServerSpec cannot stand in for it:
   *  buildServerSpec filters managed roles out and snapshotGuild drops @everyone,
   *  and the planner needs both — managed roles occupy real hierarchy slots, and
   *  @everyone is why raw 0 is not available. */
  allRoles?: ReadonlyArray<RolePositionInput>
  /** The bot's own highest role. Required when the spec carries above/below. */
  botHighestRoleId?: string
}

// Large-prune banner: a diff whose delete count exceeds EITHER bound gets a
// ⚠⚠ line right under the header. Display-only (there is no approval step
// since 0.8.6), but impossible to miss in a dry run or in the applied result.
export const PRUNE_GUARD_MAX_DELETIONS = 5
export const PRUNE_GUARD_CHANNEL_FRACTION = 0.5

// The boolean map permissionOverwrites.edit takes, built to CONVERGE on the
// desired overwrite: desired allow → true, desired deny → false, and any perm
// currently set on the overwrite but absent from the spec → null (unset).
// Without the nulls a re-apply would never reach an empty diff.
export function overwriteEditMap(
  current: { allow?: string[]; deny?: string[] } | undefined,
  desired: { allow?: string[]; deny?: string[] },
): Record<string, boolean | null> {
  const set: Record<string, boolean | null> = {}
  for (const p of current?.allow ?? []) set[p] = null
  for (const p of current?.deny ?? []) set[p] = null
  for (const p of desired.allow ?? []) set[p] = true
  for (const p of desired.deny ?? []) set[p] = false
  return set
}

function fmtOverwrite(o: { allow?: string[]; deny?: string[] }): string {
  const parts: string[] = []
  if (o.allow?.length) parts.push(`allow [${[...o.allow].sort().join(', ')}]`)
  if (o.deny?.length) parts.push(`deny [${[...o.deny].sort().join(', ')}]`)
  return parts.join(' ') || '(empty)'
}

function validateSpecOverwrites(ows: SpecOverwrite[], where: string): void {
  for (const o of ows) {
    if (!o.id || typeof o.id !== 'string') {
      throw new Error(`${where}: every overwrite needs an id ('@everyone', 'role:<Name>', or a snowflake)`)
    }
    if (o.allow) validatePermissionNames(o.allow, `${where} overwrite ${o.id} allow`)
    if (o.deny) validatePermissionNames(o.deny, `${where} overwrite ${o.id} deny`)
    if (o.id !== '@everyone' && !o.id.startsWith('role:') && o.type !== 'role' && o.type !== 'member') {
      throw new Error(`${where}: overwrite ${o.id} is a raw snowflake — set type: 'role' or 'member'`)
    }
  }
  const dup = findDup(ows.map(o => o.id))
  if (dup) throw new Error(`${where}: duplicate overwrite target ${dup}`)
}

// Diff desired overwrites against current ones, appending display changes,
// applier edit-maps, and ⚠ flags. Current overwrites not named in the spec
// are left alone (additive semantics, same as everything else).
function diffOverwrites(
  current: SpecOverwrite[] | undefined,
  desired: SpecOverwrite[] | undefined,
  where: string,
  changes: FieldChange[],
  edits: OverwriteEdit[],
  dangerous: string[],
): void {
  if (!desired) return
  validateSpecOverwrites(desired, where)
  const curById = new Map((current ?? []).map(o => [o.id, o]))
  for (const want of desired) {
    const cur = curById.get(want.id)
    if (cur && sameSet(cur.allow, want.allow) && sameSet(cur.deny, want.deny)) continue
    changes.push({
      field: `overwrite ${want.id}`,
      ...(cur ? { before: fmtOverwrite(cur) } : {}),
      after: fmtOverwrite(want),
    })
    edits.push({ id: want.id, type: want.type, set: overwriteEditMap(cur, want) })
    for (const p of dangerousGrants(cur?.allow, want.allow)) {
      dangerous.push(`grants ${p} via overwrite ${want.id} on ${where}`)
    }
  }
}

export function specEntryLabel(e: SpecDiffEntry): string {
  if (e.kind === 'everyone') return '@everyone'
  if (e.kind === 'ordering') return 'role hierarchy'
  if (e.kind === 'channel') return `channel "${e.category ? `${e.category} / ` : ''}#${e.name}"`
  return `${e.kind} "${e.name}"`
}

// Additive-upsert diff: `create` for spec entries missing from the guild,
// `modify` (with before→after) where a spec-set field drifts. Matching is
// two-tier: an entry carrying the `id` get_server_spec emits matches the
// live entity with that snowflake — a differing name is then a `rename`, a
// differing parent category a `move` (non-destructive updates, never
// delete+create). Stale/foreign ids are hints, not requirements: they fall
// back to name matching, then create. Fields the spec leaves undefined are
// not compared; live entities no spec entry claims land in `untouched` —
// unless opts.prune, which turns them into `delete` entries (ordered
// channels → now-empty categories → roles). @everyone, managed roles, and
// the bot's own roles can NEVER produce a delete entry, spec or no spec.
// Re-applying a spec that already matches yields zero entries (idempotent).
// Throws (fail-fast, nothing applied) on unknown permission names/colors/
// kinds, ambiguous duplicate names, and channel-kind mismatches.
export function computeSpecDiff(current: ServerSpec, desired: ServerSpec, opts: SpecDiffOptions = {}): SpecDiff {
  const entries: SpecDiffEntry[] = []
  // Renames/moves apply after every create/update (so e.g. a move's target
  // category exists); deletes go last, children before parents. Collected
  // separately and concatenated in that order at the end.
  const renames: SpecDiffEntry[] = []
  const deletions: Record<'channel' | 'category' | 'role', SpecDiffEntry[]> = { channel: [], category: [], role: [] }
  const untouched: string[] = []
  // Ids are hints — anything non-string (or empty) is treated as absent.
  const specId = (id: unknown): string | undefined => (typeof id === 'string' && id.length > 0 ? id : undefined)
  const isString = (x: string | undefined): x is string => x !== undefined

  // @everyone permissions — compared as a set only when the spec sets them.
  if (desired.everyone_permissions) {
    validatePermissionNames(desired.everyone_permissions, '@everyone permissions')
    if (!sameSet(current.everyone_permissions, desired.everyone_permissions)) {
      entries.push({
        kind: 'everyone', op: 'modify', name: '@everyone',
        changes: [{
          field: 'permissions',
          before: [...(current.everyone_permissions ?? [])].sort(),
          after: [...desired.everyone_permissions].sort(),
        }],
        dangerous: dangerousGrants(current.everyone_permissions, desired.everyone_permissions)
          .map(p => `grants ${p} to @everyone`),
      })
    }
  } else if (current.everyone_permissions) {
    untouched.push('@everyone permissions')
  }

  // Roles — id-matched first (enables rename), then by name. Live roles some
  // spec id claims are off the name-match table, so an id-less entry can't
  // grab a role that's being renamed out from under its old name.
  const desiredRoles = desired.roles ?? []
  const dupRole = findDup(desiredRoles.map(r => r.name))
  if (dupRole !== null) throw new Error(`spec.roles has duplicate name "${dupRole}"`)
  const dupRoleId = findDup(desiredRoles.map(r => specId(r.id)).filter(isString))
  if (dupRoleId !== null) throw new Error(`spec.roles has duplicate id "${dupRoleId}"`)
  const currentRoles = current.roles ?? []
  const currentRolesById = new Map(currentRoles.filter(r => specId(r.id)).map(r => [r.id!, r]))
  const roleIdClaimed = new Set(desiredRoles.map(r => specId(r.id)).filter(isString).filter(id => currentRolesById.has(id)))
  const currentRolesByName = new Map<string, SpecRole[]>()
  for (const r of currentRoles) {
    if (specId(r.id) !== undefined && roleIdClaimed.has(r.id!)) continue
    currentRolesByName.set(r.name, [...(currentRolesByName.get(r.name) ?? []), r])
  }
  const roleKey = (r: SpecRole) => specId(r.id) ?? `name:${r.name}`
  const claimedRoles = new Set<string>()
  for (const want of desiredRoles) {
    if (!want.name || typeof want.name !== 'string') throw new Error('spec.roles: every role needs a name')
    if (want.name === '@everyone') throw new Error('set everyone_permissions for @everyone, not a roles[] entry')
    if (want.permissions) validatePermissionNames(want.permissions, `role "${want.name}" permissions`)
    if (want.color !== undefined) resolveColorInput(want.color) // validate before diffing
    let cur = specId(want.id) !== undefined ? currentRolesById.get(want.id!) : undefined
    if (cur) {
      if (cur.name !== want.name) {
        renames.push({
          kind: 'role', op: 'rename', name: want.name, id: cur.id,
          changes: [{ field: 'name', before: cur.name, after: want.name }], dangerous: [],
        })
      }
    } else {
      const have = currentRolesByName.get(want.name) ?? []
      if (have.length > 1) {
        throw new Error(`role name "${want.name}" is ambiguous — ${have.length} roles share it; rename one in Discord first`)
      }
      cur = have[0]
    }
    if (!cur) {
      if (want.position !== undefined) {
        throw new Error(
          `role "${want.name}": remove \`position\`. It is read-only, and on a role being CREATED it is `
          + `not merely ignored by us — Discord's create endpoint has no position field at all, so the `
          + `role always lands at the bottom. To place it, use above/below: `
          + `{ "name": "${want.name}", "above": "<role name>" }.`)
      }
      const changes: FieldChange[] = []
      if (want.color !== undefined) changes.push({ field: 'color', after: want.color })
      if (want.hoist !== undefined) changes.push({ field: 'hoist', after: want.hoist })
      if (want.mentionable !== undefined) changes.push({ field: 'mentionable', after: want.mentionable })
      if (want.permissions) changes.push({ field: 'permissions', after: [...want.permissions].sort() })
      entries.push({
        kind: 'role', op: 'create', name: want.name, changes,
        dangerous: dangerousGrants(undefined, want.permissions).map(p => `grants ${p} to new role "${want.name}"`),
      })
    } else {
      claimedRoles.add(roleKey(cur))
      const changes: FieldChange[] = []
      if (want.color !== undefined && resolveColorInput(want.color) !== resolveColorInput(cur.color ?? '#000000')) {
        changes.push({ field: 'color', before: cur.color ?? '#000000', after: want.color })
      }
      if (want.hoist !== undefined && want.hoist !== (cur.hoist ?? false)) {
        changes.push({ field: 'hoist', before: cur.hoist ?? false, after: want.hoist })
      }
      if (want.mentionable !== undefined && want.mentionable !== (cur.mentionable ?? false)) {
        changes.push({ field: 'mentionable', before: cur.mentionable ?? false, after: want.mentionable })
      }
      if (want.permissions && !sameSet(cur.permissions, want.permissions)) {
        changes.push({ field: 'permissions', before: [...(cur.permissions ?? [])].sort(), after: [...want.permissions].sort() })
      }
      // position is NOT diffed, and NOT silently ignored either — both were bugs.
      // Ignoring it made apply answer "already matches, 0 changes" to a reorder it
      // never compared. Diffing it implied a write path that cannot exist: a raw
      // position is advisory in a partial write and normalised in a complete one, so
      // "set this role to 4" is not a thing the API offers. A value that MATCHES is
      // accepted, so a round-tripped export stays the documented no-op; a value that
      // DIFFERS is where the user meant to reorder, and that must say so out loud.
      if (want.position !== undefined && want.position !== cur.position) {
        throw new Error(
          `role "${want.name}": position ${want.position} does not match its live raw position `
          + `${cur.position}. \`position\` is read-only — it is exported so you can see the `
          + `hierarchy, not to set it. To reorder, use above/below: `
          + `{ "name": "${want.name}", "above": "<role name>" }. Otherwise supply it unchanged, or omit it.`)
      }
      if (changes.length > 0) {
        entries.push({
          kind: 'role', op: 'modify', name: want.name, id: cur.id, changes,
          dangerous: dangerousGrants(cur.permissions, want.permissions).map(p => `grants ${p} to role "${want.name}"`),
        })
      }
    }
  }
  for (const r of currentRoles) {
    if (claimedRoles.has(roleKey(r))) continue
    // NEVER-DELETE: @everyone (the role whose id === guild id), managed
    // (bot/integration/booster) roles, and the bot's own roles survive prune
    // no matter what the spec says. buildServerSpec already keeps managed
    // roles out of specs, but a hand-built `current` could carry them — the
    // filter here is the backstop, not the caller's discipline.
    const rid = specId(r.id)
    const deletable = rid !== undefined && rid !== opts.guildId &&
      !(opts.managedRoleIds ?? []).includes(rid) && !(opts.botRoleIds ?? []).includes(rid)
    if (opts.prune && deletable) {
      deletions.role.push({ kind: 'role', op: 'delete', name: r.name, id: rid, changes: [], dangerous: [] })
    } else {
      untouched.push(`role "${r.name}"${opts.prune ? ' (protected)' : ''}`)
    }
  }

  // Categories — id-matched first, then by name; only their own overwrites
  // are diffed here (their channels go through the unified channel pass
  // below). Each desired category also resolves to an IDENTITY — the matched
  // live category's key, or a create marker no live channel can sit under —
  // which is what child channels key their location by. That keeps id-less
  // children matched to their category through a rename (the name-based key
  // would read a renamed parent as a brand-new location).
  const desiredCats = desired.categories ?? []
  const dupCat = findDup(desiredCats.map(c => c.name))
  if (dupCat !== null) throw new Error(`spec.categories has duplicate name "${dupCat}"`)
  const dupCatId = findDup(desiredCats.map(c => specId(c.id)).filter(isString))
  if (dupCatId !== null) throw new Error(`spec.categories has duplicate id "${dupCatId}"`)
  const currentCats = current.categories ?? []
  const currentCatsById = new Map(currentCats.filter(c => specId(c.id)).map(c => [c.id!, c]))
  const catIdClaimed = new Set(desiredCats.map(c => specId(c.id)).filter(isString).filter(id => currentCatsById.has(id)))
  const currentCatsByName = new Map<string, SpecCategory[]>()
  for (const c of currentCats) {
    if (specId(c.id) !== undefined && catIdClaimed.has(c.id!)) continue
    currentCatsByName.set(c.name, [...(currentCatsByName.get(c.name) ?? []), c])
  }
  const catKey = (c: SpecCategory) => specId(c.id) ?? `name:${c.name}`
  const claimedCats = new Set<string>()
  const desiredCatIdentity = new Map<string, string>()
  for (const want of desiredCats) {
    if (!want.name || typeof want.name !== 'string') throw new Error('spec.categories: every category needs a name')
    let cur = specId(want.id) !== undefined ? currentCatsById.get(want.id!) : undefined
    if (cur) {
      if (cur.name !== want.name) {
        renames.push({
          kind: 'category', op: 'rename', name: want.name, id: cur.id,
          changes: [{ field: 'name', before: cur.name, after: want.name }], dangerous: [],
        })
      }
    } else {
      const have = currentCatsByName.get(want.name) ?? []
      if (have.length > 1) {
        throw new Error(`category name "${want.name}" is ambiguous — ${have.length} categories share it; rename one in Discord first`)
      }
      cur = have[0]
    }
    desiredCatIdentity.set(want.name, cur ? catKey(cur) : `new:${want.name}`)
    if (!cur) {
      const changes: FieldChange[] = []
      const dangerous: string[] = []
      if (want.overwrites) {
        validateSpecOverwrites(want.overwrites, `category "${want.name}"`)
        for (const o of want.overwrites) {
          changes.push({ field: `overwrite ${o.id}`, after: fmtOverwrite(o) })
          for (const p of dangerousGrants(undefined, o.allow)) {
            dangerous.push(`grants ${p} via overwrite ${o.id} on category "${want.name}"`)
          }
        }
      }
      entries.push({ kind: 'category', op: 'create', name: want.name, changes, dangerous })
    } else {
      claimedCats.add(catKey(cur))
      const changes: FieldChange[] = []
      const edits: OverwriteEdit[] = []
      const dangerous: string[] = []
      diffOverwrites(cur.overwrites, want.overwrites, `category "${want.name}"`, changes, edits, dangerous)
      if (changes.length > 0) {
        entries.push({ kind: 'category', op: 'modify', name: want.name, id: cur.id, changes, overwriteEdits: edits, dangerous })
      }
    }
  }
  for (const c of currentCats) {
    if (claimedCats.has(catKey(c))) continue
    const cid = specId(c.id)
    if (opts.prune && cid !== undefined) {
      deletions.category.push({ kind: 'category', op: 'delete', name: c.name, id: cid, changes: [], dangerous: [] })
    } else {
      untouched.push(`category "${c.name}"`)
    }
  }

  // Channels — id-matched first (enables rename AND move: an id-matched
  // channel under a different parent identity is a `move`, not a create),
  // then by (category identity, channel name). Without ids a channel "moved"
  // to a different category in the spec still reads as a create there, with
  // the original left untouched (additive semantics — nothing moves or dies).
  type Placed = { cat: string | null; identity: string | null; ch: SpecChannel }
  const chanKey = (identity: string | null, name: string) => `${identity ?? ''}\u0000${name}`
  const chanLabel = (cat: string | null, name: string) => `channel "${cat ? `${cat} / ` : ''}#${name}"`
  const desiredChans: Placed[] = [
    ...desiredCats.flatMap(cat => (cat.channels ?? []).map(ch => ({ cat: cat.name as string | null, identity: desiredCatIdentity.get(cat.name) as string | null, ch }))),
    ...(desired.channels ?? []).map(ch => ({ cat: null, identity: null as string | null, ch })),
  ]
  const dupChan = findDup(desiredChans.map(p => `${p.cat ?? ''}\u0000${p.ch.name}`))
  if (dupChan !== null) {
    const [cat, name] = dupChan.split('\u0000')
    throw new Error(`spec has duplicate ${chanLabel(cat || null, name!)}`)
  }
  const dupChanId = findDup(desiredChans.map(p => specId(p.ch.id)).filter(isString))
  if (dupChanId !== null) throw new Error(`spec has duplicate channel id "${dupChanId}"`)
  const currentChans: Placed[] = [
    ...currentCats.flatMap(cat => (cat.channels ?? []).map(ch => ({ cat: cat.name as string | null, identity: catKey(cat) as string | null, ch }))),
    ...(current.channels ?? []).map(ch => ({ cat: null, identity: null as string | null, ch })),
  ]
  const currentChansById = new Map(currentChans.filter(p => specId(p.ch.id)).map(p => [p.ch.id!, p]))
  const chanIdClaimed = new Set(desiredChans.map(p => specId(p.ch.id)).filter(isString).filter(id => currentChansById.has(id)))
  const currentChansByKey = new Map<string, Placed[]>()
  for (const p of currentChans) {
    if (specId(p.ch.id) !== undefined && chanIdClaimed.has(p.ch.id!)) continue
    const key = chanKey(p.identity, p.ch.name)
    currentChansByKey.set(key, [...(currentChansByKey.get(key) ?? []), p])
  }
  const chanClaimKey = (p: Placed) => specId(p.ch.id) ?? `name:${chanKey(p.identity, p.ch.name)}`
  const claimedChans = new Set<string>()
  for (const { cat, identity, ch: want } of desiredChans) {
    if (!want.name || typeof want.name !== 'string') throw new Error('spec channels: every channel needs a name')
    const kind = want.kind ?? 'text'
    kindToChannelType(kind) // validates the kind string
    const label = chanLabel(cat, want.name)
    let curPlaced = specId(want.id) !== undefined ? currentChansById.get(want.id!) : undefined
    if (curPlaced) {
      if (curPlaced.ch.name !== want.name) {
        renames.push({
          kind: 'channel', op: 'rename', name: want.name, id: curPlaced.ch.id, category: curPlaced.cat,
          changes: [{ field: 'name', before: curPlaced.ch.name, after: want.name }], dangerous: [],
        })
      }
      if (curPlaced.identity !== identity) {
        renames.push({
          kind: 'channel', op: 'move', name: want.name, id: curPlaced.ch.id, category: cat,
          changes: [{ field: 'category', before: curPlaced.cat ?? '(top-level)', after: cat ?? '(top-level)' }], dangerous: [],
        })
      }
    } else {
      const have = currentChansByKey.get(chanKey(identity, want.name)) ?? []
      if (have.length > 1) {
        throw new Error(`${label} is ambiguous — ${have.length} channels share that name in the same place; rename one in Discord first`)
      }
      curPlaced = have[0]
    }
    if (!curPlaced) {
      const changes: FieldChange[] = [{ field: 'kind', after: kind }]
      const dangerous: string[] = []
      if (want.topic !== undefined) changes.push({ field: 'topic', after: want.topic })
      if (want.slowmode !== undefined) changes.push({ field: 'slowmode', after: want.slowmode })
      if (want.nsfw !== undefined) changes.push({ field: 'nsfw', after: want.nsfw })
      if (want.overwrites) {
        validateSpecOverwrites(want.overwrites, label)
        for (const o of want.overwrites) {
          changes.push({ field: `overwrite ${o.id}`, after: fmtOverwrite(o) })
          for (const p of dangerousGrants(undefined, o.allow)) {
            dangerous.push(`grants ${p} via overwrite ${o.id} on ${label}`)
          }
        }
      }
      entries.push({ kind: 'channel', op: 'create', name: want.name, category: cat, changes, dangerous })
    } else {
      claimedChans.add(chanClaimKey(curPlaced))
      const cur = curPlaced.ch
      // Only enforce the type-match guard when the spec EXPLICITLY sets a kind.
      // A modify that omits kind targets the existing channel as-is (any type),
      // so editing e.g. a voice channel's topic without restating kind is fine.
      if (want.kind !== undefined && (cur.kind ?? 'text') !== want.kind) {
        throw new Error(`${label} exists as ${cur.kind ?? 'text'} but the spec says ${want.kind} — channel types can't be changed; rename or remove it manually`)
      }
      const changes: FieldChange[] = []
      const edits: OverwriteEdit[] = []
      const dangerous: string[] = []
      if (want.topic !== undefined && (cur.topic ?? '') !== want.topic) {
        changes.push({ field: 'topic', before: cur.topic ?? '', after: want.topic })
      }
      if (want.slowmode !== undefined && (cur.slowmode ?? 0) !== want.slowmode) {
        changes.push({ field: 'slowmode', before: cur.slowmode ?? 0, after: want.slowmode })
      }
      if (want.nsfw !== undefined && (cur.nsfw ?? false) !== want.nsfw) {
        changes.push({ field: 'nsfw', before: cur.nsfw ?? false, after: want.nsfw })
      }
      diffOverwrites(cur.overwrites, want.overwrites, label, changes, edits, dangerous)
      if (changes.length > 0) {
        entries.push({ kind: 'channel', op: 'modify', name: want.name, id: cur.id, category: cat, changes, overwriteEdits: edits, dangerous })
      }
    }
  }
  for (const p of currentChans) {
    if (claimedChans.has(chanClaimKey(p))) continue
    const cid = specId(p.ch.id)
    if (opts.prune && cid !== undefined) {
      deletions.channel.push({ kind: 'channel', op: 'delete', name: p.ch.name, id: cid, category: p.cat, changes: [], dangerous: [] })
    } else {
      untouched.push(chanLabel(p.cat, p.ch.name))
    }
  }

  // ── Role hierarchy ──────────────────────────────────────────────────────────
  // Runs LAST, against a PROJECTION of the guild as it will look once everything
  // above has been applied — creates added, renames applied, deletes removed. A
  // reorder computed against the guild as it is today would renumber around roles
  // that are about to vanish and miss the ones about to appear.
  //
  // The result here is for the RENDERED DIFF. The applier re-resolves and re-plans
  // against the real guild immediately before writing, because created roles have no
  // snowflake yet and because the guild can change while the earlier phases run.
  const ordering: SpecDiffEntry[] = []
  const named = namedOrderingConstraints(desired)
  if (named.length > 0) {
    if (!opts.allRoles || !opts.botHighestRoleId || !opts.guildId) {
      throw new Error(
        'role ordering: above/below need the full role snapshot (allRoles, botHighestRoleId, guildId). '
        + 'This is a caller bug — the spec asked for a reorder and the diff was given no hierarchy to reorder.')
    }
    const deleted = new Set(deletions.role.map(e => e.id).filter(isString))
    const renamedTo = new Map<string, string>()
    for (const e of [...entries, ...renames]) {
      if (e.kind === 'role' && e.op === 'rename' && e.id) renamedTo.set(e.id, e.name)
    }
    // A role this spec CREATES has no snowflake yet. Discord lands new roles at the
    // tied bottom, and a tie breaks by id with the newest lowest — so a synthetic id
    // at the top of the snowflake range puts the projection's new roles exactly where
    // the real ones will land. These ids never reach Discord; the applier re-plans.
    // ASCENDING, because Discord assigns ascending snowflakes and the tie-break ranks the smaller id
    // HIGHER -- so the first role created really does land above the second. Decrementing here put
    // them in the projection backwards, and a spec whose two new roles constrain each other then
    // looked already-satisfied: no ordering entry emitted, apply reports success, spec unsatisfied.
    let synth = BigInt('9'.repeat(18) + '0')   // still far above any real snowflake (~1.5e18)
    const projected: RolePositionInput[] = [
      ...opts.allRoles
        .filter(r => !deleted.has(r.id))
        .map(r => ({ ...r, name: renamedTo.get(r.id) ?? r.name })),
      ...entries
        .filter(e => e.kind === 'role' && e.op === 'create')
        .map(e => ({ id: String(synth++), name: e.name, rawPosition: 1, managed: false })),
    ]
    const nameOf = (id: string) => projected.find(r => r.id === id)?.name ?? id
    const plan = planRolePositions(
      projected,
      resolveOrderingConstraints(projected, named),
      { botHighestRoleId: opts.botHighestRoleId, everyoneRoleId: opts.guildId },
    )
    if ('refusal' in plan) throw new Error(explainOrderingRefusal(plan.refusal, nameOf))
    if (plan.writes.length > 0) {
      const before = hierarchyOrder(projected).map(r => ({ id: r.id, name: r.name }))
      const after = [...plan.writes]
        .sort((a, b) => b.position - a.position)
        .map(w => ({ id: w.id, name: nameOf(w.id) }))
      ordering.push({
        kind: 'ordering', op: 'reorder', name: 'role hierarchy', changes: [],
        ordering: { before, after, writes: plan.writes, frozen: plan.frozen },
        dangerous: dangerousReorder(after, before, desired, current),
      })
    }
  }

  return {
    // Apply order: creates/updates, then renames/moves, then deletes —
    // child channels before their (now-empty) categories, roles last — and the
    // hierarchy reorder after ALL of them, or it renumbers around roles that are
    // about to be deleted and cannot see the ones about to be created.
    entries: [...entries, ...renames, ...deletions.channel, ...deletions.category, ...deletions.role, ...ordering],
    untouched,
    channelCount: currentCats.length + currentChans.length,
  }
}

/**
 * Who actually MOVED, and past whom.
 *
 * Counting roles whose index changed overstates it badly: inserting one role between two others shifts
 * every role below it by one, so "1 role moved" reads as "4 roles change rank". §2.2 of the plan is
 * about exactly this — an approval prompt that overstates its blast radius trains the reader to ignore
 * it, which is the same failure as understating it. What a human sees is who now outranks whom, so
 * that is what gets reported: the pairs that actually FLIPPED.
 */
export function orderingCrossings(
  before: ReadonlyArray<{ id: string; name: string }>,
  after: ReadonlyArray<{ id: string; name: string }>,
): Array<{ id: string; name: string; passed: string[] }> {
  const rankBefore = new Map(before.map((r, i) => [r.id, i]))
  const out: Array<{ id: string; name: string; passed: string[] }> = []
  after.forEach((r, i) => {
    const was = rankBefore.get(r.id)
    if (was === undefined) return
    // Roles this one now outranks that it did not before.
    const passed = after.slice(i + 1)
      .filter(o => { const ow = rankBefore.get(o.id); return ow !== undefined && ow < was })
      .map(o => o.name)
    if (passed.length > 0) out.push({ id: r.id, name: r.name, passed })
  })
  return out
}

/** ⚠ lines for a reorder: a role gaining rank over a role that holds a dangerous
 *  permission is a privilege change, and belongs in the same place dangerousGrants
 *  puts one. Rank alone does not grant anything, but it decides who can moderate whom
 *  and which roles this bot can still touch afterwards. */
function dangerousReorder(
  after: ReadonlyArray<{ id: string; name: string }>,
  before: ReadonlyArray<{ id: string; name: string }>,
  desired: ServerSpec,
  current: ServerSpec,
): string[] {
  // LIVE permissions first, spec on top. Reading only the spec made this silent in the common case:
  // apply_server_spec is additive, so a partial spec -- the shape the tool description itself
  // advertises, {name:"Owner", above:"Moderator"} -- restates nobody's permissions, every role reads
  // as harmless, and the approval DM shows no warning while a role is lifted over an Administrator
  // holder. The live permissions were in `current` the whole time and were never consulted.
  const permsOf = new Map((current.roles ?? []).map(r => [r.name, r.permissions ?? []]))
  for (const r of desired.roles ?? []) if (r.permissions) permsOf.set(r.name, r.permissions)
  const risky = (name: string) => (permsOf.get(name) ?? []).some(p => DANGEROUS_PERMS.includes(p))
  const out: string[] = []
  for (const c of orderingCrossings(before, after)) {
    for (const passedName of c.passed) {
      if (risky(passedName)) {
        out.push(`"${c.name}" now ranks above "${passedName}", which holds a dangerous permission`)
      }
    }
  }
  return out
}

function fmtVal(v: unknown): string {
  if (Array.isArray(v)) return `[${v.join(', ')}]`
  if (typeof v === 'string') return JSON.stringify(v)
  return String(v)
}

// Human-readable diff returned by apply_server_spec (and its dry run): `+ create`, `~ modify`
// (before → after), `~ rename`/`~ move`, `- DELETE`, inline ⚠ flags, then
// the `·` untouched list. A per-op-class breakdown joins the header when the
// diff renames/moves/deletes (deletions first and loudest), and a diff whose
// delete count exceeds the PRUNE_GUARD bounds gets a ⚠⚠ banner line.
export function renderSpecDiff(diff: SpecDiff): string {
  const dangerCount = diff.entries.filter(e => e.dangerous.length > 0).length
  const count = (op: SpecDiffEntry['op']) => diff.entries.filter(e => e.op === op).length
  const dels = count('delete')
  const renamesMoves = count('rename') + count('move')
  let header = `${diff.entries.length} change(s)`
  if (dels > 0 || renamesMoves > 0 || count('reorder') > 0) {
    const parts: string[] = []
    if (dels > 0) parts.push(`⚠ ${dels} DELETION${dels === 1 ? '' : 'S'}`)
    if (count('create') > 0) parts.push(`${count('create')} create${count('create') === 1 ? '' : 's'}`)
    if (renamesMoves > 0) parts.push(`${renamesMoves} rename${renamesMoves === 1 ? '' : 's'}/move${renamesMoves === 1 ? '' : 's'}`)
    if (count('modify') > 0) parts.push(`${count('modify')} update${count('modify') === 1 ? '' : 's'}`)
    if (count('reorder') > 0) parts.push('1 hierarchy reorder')
    header += ` — ${parts.join(' · ')}`
  }
  if (dangerCount > 0) header += ` — ⚠ ${dangerCount} with dangerous grants`
  const lines: string[] = [header]
  if (dels > PRUNE_GUARD_MAX_DELETIONS ||
      (diff.channelCount !== undefined && dels > diff.channelCount * PRUNE_GUARD_CHANNEL_FRACTION)) {
    lines.push(`⚠⚠ LARGE PRUNE: ${dels} deletion${dels === 1 ? '' : 's'} — review carefully`)
  }
  for (const e of diff.entries) {
    if (e.op === 'delete') {
      lines.push(`- DELETE ${specEntryLabel(e)}`)
      continue
    }
    if (e.op === 'rename') {
      const from = String(e.changes.find(c => c.field === 'name')?.before ?? '?')
      lines.push(`~ rename ${specEntryLabel({ ...e, name: from })} → ${e.kind === 'channel' ? `#${e.name}` : `"${e.name}"`}`)
      continue
    }
    if (e.op === 'move') {
      const c = e.changes.find(x => x.field === 'category')
      lines.push(`~ move channel "#${e.name}": ${fmtVal(c?.before)} → ${fmtVal(c?.after)}`)
      continue
    }
    if (e.kind === 'ordering') {
      const o = e.ordering
      if (!o) { lines.push('~ role hierarchy (no detail recorded)'); continue }
      const crossings = orderingCrossings(o.before, o.after)
      const movedIds = new Set(crossings.map(c => c.id))
      lines.push(crossings.length === 0
        ? '~ reorder role hierarchy — renumbering only, nobody changes rank:'
        : `~ reorder role hierarchy — ${crossings.map(c => `"${c.name}" moves above ${c.passed.map(n => `"${n}"`).join(', ')}`).join('; ')}:`)
      // Full table, highest first, both columns. This block goes in the ATTACHMENT;
      // the DM body gets a bounded summary, because it is hard-capped at 1900 chars
      // and a full ordering would be silently truncated exactly where it matters.
      const width = Math.max(...o.before.map(r => r.name.length), 6)
      for (let i = 0; i < Math.max(o.before.length, o.after.length); i++) {
        const b = o.before[i], a = o.after[i]
        const mark = a && movedIds.has(a.id) ? '←' : ' '
        lines.push(`    ${(b?.name ?? '').padEnd(width)}  →  ${a?.name ?? ''} ${mark}`)
      }
      if (o.frozen.length > 0) {
        lines.push(`    (${o.frozen.length} role(s) at or above this bot's own role cannot be moved and were left alone)`)
      }
      for (const d of e.dangerous) lines.push(`  ⚠ ${d}`)
      continue
    }
    const parts = e.changes.map(c =>
      c.before !== undefined ? `${c.field}: ${fmtVal(c.before)} → ${fmtVal(c.after)}` : `${c.field}: ${fmtVal(c.after)}`,
    )
    lines.push(`${e.op === 'create' ? '+' : '~'} ${specEntryLabel(e)}${parts.length > 0 ? ` — ${parts.join(', ')}` : ''}`)
    for (const d of e.dangerous) lines.push(`  ⚠ ${d}`)
  }
  if (diff.entries.length === 0) lines.push('(everything in the spec already matches)')
  if (diff.untouched.length > 0) lines.push(`· left untouched (not in spec): ${diff.untouched.join(', ')}`)
  return lines.join('\n')
}

// ── typed permission replies ("yes abcde") ──
// Permission-reply spec from anthropics/claude-cli-internal
// src/services/mcp/channelPermissions.ts — inlined (no CC repo dep).
// 5 lowercase letters a-z minus 'l'. Case-insensitive for phone autocorrect.
// Strict: no bare yes/no (conversational), no prefix/suffix chatter.
export const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i

// A typed reply counts ONLY from a sender in the top-level allowFrom — the same people the Allow/Deny
// buttons accept. Passing the inbound gate is not enough: a channel entry with an empty allowFrom, and
// since 0.8.5 a whole-server grant, admits everyone who can post there, and any of them could otherwise
// approve a tool call. Anything that does not qualify returns undefined and is delivered as ordinary chat.
//
// The request must also actually be pending ("no tests" is `no` + five letters), and is reported with
// the STORED id: request ids are echoed back verbatim, so lowercasing would break a mixed-case one.
export function resolvePermissionReply(
  content: string,
  pendingIds: Iterable<string>,
  senderId: string,
  allowFrom: readonly string[],
): { requestId: string; behavior: 'allow' | 'deny' } | undefined {
  if (!allowFrom.includes(senderId)) return undefined
  const m = PERMISSION_REPLY_RE.exec(content)
  if (!m) return undefined
  const typed = m[2]!.toLowerCase()
  for (const id of pendingIds) {
    if (id.toLowerCase() === typed) return { requestId: id, behavior: m[1]!.toLowerCase().startsWith('y') ? 'allow' : 'deny' }
  }
  return undefined
}

// ── /access slash-command mutations (pure; operate on access.json groups OR guilds — same policy
// shape, so a server-wide grant reuses these with the guild id as the key) ──
export type GroupPolicyLike = { requireMention: boolean; allowFrom: string[] }

// Merge-grant: enable (or update) a guild channel, preserving any existing
// allowFrom restriction. Idempotent — re-granting just updates requireMention.
export function grantGroup(groups: Record<string, GroupPolicyLike>, channelId: string, requireMention: boolean): GroupPolicyLike {
  const merged = { ...groups[channelId], requireMention, allowFrom: groups[channelId]?.allowFrom ?? [] }
  groups[channelId] = merged
  return merged
}

// Returns false when the channel wasn't granted (nothing to remove).
export function removeGroup(groups: Record<string, GroupPolicyLike>, channelId: string): boolean {
  if (!(channelId in groups)) return false
  delete groups[channelId]
  return true
}

// ── access.json schema ──
// Lives here rather than in server.ts so the parse and the channel-resolution rules below are
// testable without importing server.ts, which connects to Discord on import.

export type PendingEntry = {
  senderId: string
  chatId: string // DM channel ID — where to send the approval confirm
  createdAt: number
  expiresAt: number
  replies: number
}

export type GroupPolicy = GroupPolicyLike

export type Access = {
  dmPolicy: 'pairing' | 'allowlist' | 'disabled'
  allowFrom: string[]
  /** Keyed on channel ID (snowflake), not guild ID. One entry per guild channel. */
  groups: Record<string, GroupPolicy>
  /**
   * Keyed on GUILD ID. A server-wide grant: every channel and thread in that guild, including ones
   * created after the grant, is covered with this policy unless it has its own `groups` entry, which
   * always wins. Optional because every access.json written before 0.8.5 lacks it.
   */
  guilds?: Record<string, GroupPolicy>
  pending: Record<string, PendingEntry>
  mentionPatterns?: string[]
  // delivery/UX config — optional, defaults live in the reply handler
  /** Emoji to react with on receipt. Empty string disables. Unicode char or custom emoji ID. */
  ackReaction?: string
  /** Which chunks get Discord's reply reference when reply_to is passed. Default: 'first'. 'off' = never thread. */
  replyToMode?: 'off' | 'first' | 'all'
  /** Max chars per outbound message before splitting. Default: 2000 (Discord's hard cap). */
  textChunkLimit?: number
}

export function defaultAccess(): Access {
  return {
    dmPolicy: 'pairing',
    allowFrom: [],
    groups: {},
    guilds: {},
    pending: {},
  }
}

// Throws on invalid JSON — the caller decides what a corrupt file means (server.ts moves it aside).
// Keys absent from the file take their defaults, so a pre-0.8.5 file with no `guilds` reads as `{}`.
export function parseAccess(raw: string): Access {
  const parsed = JSON.parse(raw) as Partial<Access>
  return { ...defaultAccess(), ...parsed }
}

// The on-disk form. An EMPTY `guilds` map is left out, so loading and saving a pre-0.8.5 file does not
// add a key nobody asked for (the /discord:access skill says the same: add it with the first entry).
// An absent key and `{}` read identically, so dropping it loses nothing.
export function serializeAccess(a: Access): string {
  const { guilds, ...rest } = a
  const keepGuilds = guilds != null && typeof guilds === 'object' && Object.keys(guilds).length > 0
  return JSON.stringify(keepGuilds ? a : rest, null, 2) + '\n'
}

// ── which policy governs a guild channel ──
// ONE function for inbound (gate) and outbound (fetchAllowedChannel). They used to compute this
// separately, and a server-wide grant added to only one side is the exact failure mode: inbound
// delivers, and every reply throws "not allowlisted".

export type ChannelRef = {
  id: string
  isThread: boolean
  /** For a thread, the channel it hangs off. Threads inherit their parent's grant. */
  parentId?: string | null
  guildId?: string | null
}

export type ResolvedChannelPolicy = {
  policy: GroupPolicyLike
  /** 'channel' = a `groups` entry (keyed on the channel, or a thread's parent); 'guild' = a `guilds` entry. */
  source: 'channel' | 'guild'
  /** The access.json key that matched: a channel id or a guild id, per `source`. */
  key: string
}

// Build a ChannelRef from a discord.js channel. Shared by the inbound gate, the outbound check and the
// /access handler, so all three derive the thread→parent mapping and the guild id the same way.
// Structural, so it is testable with plain objects; DM channels have no guildId and get null.
export function channelRefOf(ch: { id: string; isThread(): boolean; parentId?: string | null; guildId?: string | null }): ChannelRef {
  const isThread = ch.isThread()
  return { id: ch.id, isThread, parentId: isThread ? ch.parentId ?? null : null, guildId: ch.guildId ?? null }
}

// The `groups` key a channel is granted under: a thread uses its parent (threads inherit), anything
// else its own id. A thread whose parent is unknown falls back to its own id.
export function channelGrantKey(ch: ChannelRef): string {
  return ch.isThread ? ch.parentId ?? ch.id : ch.id
}

// Own-property lookup that tolerates a missing or null map (a hand-edited `"guilds": null`).
function ownEntry<T>(rec: Record<string, T> | null | undefined, key: string): T | undefined {
  if (!rec || typeof rec !== 'object' || !Object.hasOwn(rec, key)) return undefined
  return rec[key] ?? undefined
}

// A channel's own `groups` entry wins outright over its guild's — no merging of fields — so a
// channel can be made stricter (or looser) than the server-wide default.
export function resolveChannelPolicy(
  access: { groups?: Record<string, GroupPolicyLike> | null; guilds?: Record<string, GroupPolicyLike> | null },
  ch: ChannelRef,
): ResolvedChannelPolicy | undefined {
  const key = channelGrantKey(ch)
  const own = ownEntry(access.groups, key)
  if (own) return { policy: own, source: 'channel', key }
  if (ch.guildId) {
    const guild = ownEntry(access.guilds, ch.guildId)
    if (guild) return { policy: guild, source: 'guild', key: ch.guildId }
  }
  return undefined
}

// Outbound: may tools send to / react in / edit in / fetch from this guild channel?
// A sender filter or mention rule is an INBOUND concern; any granted channel is a valid target.
export function channelAllowed(
  access: Parameters<typeof resolveChannelPolicy>[0],
  ch: ChannelRef,
): boolean {
  return resolveChannelPolicy(access, ch) !== undefined
}

// Inbound, after the policy is resolved. The mention check itself is async (it may fetch the
// replied-to message), so this returns 'needs-mention' and leaves it to the caller.
export function groupGateVerdict(policy: GroupPolicyLike | undefined, senderId: string): 'drop' | 'deliver' | 'needs-mention' {
  if (!policy) return 'drop'
  const allowFrom = policy.allowFrom ?? []
  if (allowFrom.length > 0 && !allowFrom.includes(senderId)) return 'drop'
  return (policy.requireMention ?? true) ? 'needs-mention' : 'deliver'
}

// ── DM access (the TOP-LEVEL allowFrom: who may DM the bot) ──
// Distinct from each channel's own allowFrom above, which filters senders WITHIN a granted channel.
// Same field name, different scope. Pure helpers so the owner-gated /access handler stays a thin
// wrapper and this logic is testable, exactly like grantGroup/removeGroup.

// Returns false when they already had access (nothing changed). Also clears any pending pairing
// code for them: they are authorised now, so the code is dead weight and would otherwise occupy
// one of the three pending slots until it expired an hour later.
export function grantDm(
  allowFrom: string[],
  pending: Record<string, { senderId: string }>,
  userId: string,
): boolean {
  if (allowFrom.includes(userId)) return false
  allowFrom.push(userId)
  for (const [code, p] of Object.entries(pending)) {
    if (p.senderId === userId) delete pending[code]
  }
  return true
}

// ── lookup by id: cache first, then the API ──
// users.cache / channels.cache hold only what discord.js has already observed, so a cache miss says
// nothing about whether the thing exists. Ask the API on a miss.
//
// AN ERROR IS NOT A NEGATIVE. The first version of this caught every throw and reported "does not
// exist", which is the SAME bug it was written to fix, one layer down: a 500, a timeout, an expired
// token or an exhausted 429 would all have produced a confident claim about Discord derived from a
// local failure. @discordjs/rest throws DiscordAPIError (carrying .code) for 4xx and HTTPError for 5xx,
// with retries:3 / timeout:15000 -- so a network stall asserts nonexistence only after ~60s of trying.
// Only 10013 Unknown User / 404 means it truly is not there; everything else is "I could not find out",
// and the caller must be able to tell those apart.
export type ResolveResult<T> =
  | { user: T; source: 'cache' | 'fetch'; error?: undefined }
  | { user: undefined; source: 'none'; error?: undefined }
  | { user: undefined; source: 'error'; error: string }

export async function resolveById<T>(
  cacheGet: (id: string) => T | undefined,
  fetchOne: (id: string) => Promise<T>,
  id: string,
): Promise<ResolveResult<T>> {
  const cached = cacheGet(id)
  if (cached !== undefined) return { user: cached, source: 'cache' }
  try {
    return { user: await fetchOne(id), source: 'fetch' }
  } catch (e) {
    const err = e as { code?: unknown; status?: unknown; message?: unknown }
    const missing = err?.code === 10013 || err?.status === 404
    if (missing) return { user: undefined, source: 'none' }
    return { user: undefined, source: 'error', error: String(err?.message ?? e) }
  }
}

// Returns false when they didn't have access (nothing to remove).
export function removeDm(allowFrom: string[], userId: string): boolean {
  const i = allowFrom.indexOf(userId)
  if (i < 0) return false
  allowFrom.splice(i, 1)
  return true
}


// ── TTL cache with in-flight de-duplication ──
// Used by /usage: the command is now open to every user, so a busy channel could hammer the
// upstream usage API. Two distinct problems, both handled here:
//   1. repeat calls inside the TTL reuse the last value (the obvious cache)
//   2. CONCURRENT calls on a cold cache share ONE in-flight request (the stampede)
// (2) is why this caches the PROMISE rather than the resolved value — with a value-only cache,
// N callers arriving before the first response all miss and all fetch.
//
// Rejections are never cached: a failed fetch clears the slot so the next caller retries rather
// than being served a cached error for the rest of the TTL.
export type TtlCache<T> = {
  /** Returns the cached value, or calls `fetcher` — de-duplicating concurrent misses. */
  get(fetcher: () => Promise<T>, now?: number): Promise<T>
  /** Drop whatever is cached (used by tests and any future manual refresh). */
  clear(): void
  /** Is there a live (non-expired) entry right now? Exposed for tests/introspection. */
  isFresh(now?: number): boolean
}

export function makeTtlCache<T>(ttlMs: number): TtlCache<T> {
  let entry: { promise: Promise<T>; at: number } | null = null
  return {
    get(fetcher, now = Date.now()) {
      if (entry && now - entry.at < ttlMs) return entry.promise
      const rec = { promise: fetcher(), at: now }
      entry = rec
      // Don't let a failure poison the cache for the rest of the TTL.
      rec.promise.catch(() => { if (entry === rec) entry = null })
      return rec.promise
    },
    clear() { entry = null },
    isFresh(now = Date.now()) { return !!entry && now - entry.at < ttlMs },
  }
}

// ---- lookup: name -> snowflake ---------------------------------------------------------------------------
//
// Pure half of the `lookup` tool, extracted here because the inline version shipped four defects a five-line
// test would have caught (a reviewer found them within the hour): dead branches from a mis-remembered enum
// name, a strip-before-trim ordering bug, a fractional `limit` leaking into output, and Discord's own
// `<#123>` mention syntax -- the most likely real input -- silently missing.

/// <summary>What a raw query normalises to, plus a snowflake if the user pasted a real mention.</summary>
export type LookupQuery = { text: string; id: string | null }

/**
 * Normalise a lookup query.
 *
 * TRIM FIRST, then strip: `" #general"` has to work, and an anchored `^[#@]` against the untrimmed string
 * silently does nothing. Then unicode-normalise, because typing `#café` in a client can produce NFC while a
 * channel name carries NFD and `includes` compares code points, not graphemes.
 *
 * `<#123456>` / `<@!123456>` short-circuit to an id: that is what Discord actually puts in message content
 * when someone types `#general`, so the commonest real input is an exact hit rather than a miss.
 */
export function normalizeLookupQuery(raw: unknown): LookupQuery {
  const s = String(raw ?? '').trim()
  const mention = s.match(/^<[#@]!?&?(\d{5,25})>$/)
  if (mention) return { text: '', id: mention[1] }
  if (/^\d{5,25}$/.test(s)) return { text: '', id: s }   // a bare snowflake is already the answer
  const stripped = s.replace(/^[#@]+/, '').trim()
  return { text: stripped.normalize('NFKD').toLowerCase(), id: null }
}

/** Clamp a caller-supplied limit to a whole number in [1, max]. Fractions reached Discord's REST API as
 *  `?limit=2.7` and came back as an error the catch then reported as "member search unavailable". */
export function clampLookupLimit(raw: unknown, fallback = 10, max = 50): number {
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.max(1, Math.min(max, Math.floor(n)))
}

/** Does a candidate name match the normalised query? Both sides get the same normalisation, or an NFD channel
 *  name never matches an NFC query. */
export function lookupNameMatches(name: string | null | undefined, q: string): boolean {
  if (!name || !q) return false
  return name.normalize('NFKD').toLowerCase().includes(q)
}

/** Sort key for a name match: exact (0) before substring (1), then alphabetical.
 *  Deliberately NOT ranked by channel type -- see the comment on lookupRank in server.ts. */
export function lookupRank(name: string, q: string): number {
  return name.normalize('NFKD').toLowerCase() === q ? 0 : 1
}

// ── Role ordering ─────────────────────────────────────────────────────────────
// Everything here is pure. The applier hands in a snapshot and gets back either a
// complete PATCH body or a refusal that names what blocked it.
//
// The measurements this is built on (LSS, 2026-08-27, REST v10):
//  - A COMPLETE ordering with distinct positions is honoured verbatim, and sending
//    the same body twice is a genuine no-op.
//  - A PARTIAL write is ADVISORY: one entry asking for position 3 landed at 2,
//    because 2 was the free slot. There is no model of that here because we never
//    send one.
//  - A complete ordering containing a GAP is densified (asked 0,2,3,4,5,6 -> got
//    0..5), so gaps cannot be preserved and must not be reported as our doing.
//  - The hierarchy gate is on BOTH ends: a role below the bot cannot be lifted
//    above it, and a role above the bot cannot be moved at all.

export type RolePositionInput = { id: string; name: string; rawPosition: number; managed: boolean }

/** Roles a spec CREATES have no snowflake at diff time, so the projection gives them placeholders far
 *  above any real id (Discord's reach 9e18 around 2090). The applier needs to tell them apart when it
 *  compares what the diff planned against what it is about to write. */
const SYNTHETIC_ID_FLOOR = BigInt('9' + '0'.repeat(18))
export function isSyntheticRoleId(id: string): boolean {
  return snowflake(id) >= SYNTHETIC_ID_FLOOR
}

/** A role id as a BigInt for ordering. Real Discord ids are always numeric, but a bare `BigInt(id)`
 *  THROWS on anything else and would take the whole diff down over one malformed entry — so a
 *  non-numeric id sorts last rather than crashing. */
function snowflake(id: string): bigint {
  try { return BigInt(id) } catch { return SYNTHETIC_ID_FLOOR * 10n }
}

/** A relational ordering statement. `above` / `below` hold role IDS, not names —
 *  name resolution happens upstream, against the post-create/post-rename snapshot. */
export type RoleConstraint = { id: string; above?: string[]; below?: string[] }

export type RolePositionRefusal =
  | { kind: 'unknown-role'; ids: string[] }
  | { kind: 'frozen'; blockingRoleIds: string[]; ceiling: number }
  | { kind: 'contradiction'; roleIds: string[] }
  | { kind: 'cycle'; roleIds: string[] }

export type RolePositionPlan =
  | { writes: Array<{ id: string; position: number }>; frozen: string[] }
  | { refusal: RolePositionRefusal }

/** Discord's own hierarchy order, highest first: raw position descending, ties broken
 *  by snowflake with the OLDER (smaller) id ranking higher (Role.js:230-239). */
function hierarchyOrder(roles: ReadonlyArray<RolePositionInput>): RolePositionInput[] {
  return [...roles].sort((a, b) => b.rawPosition - a.rawPosition || (snowflake(a.id) < snowflake(b.id) ? -1 : 1))
}

/**
 * Resolve relational ordering constraints into a complete PATCH body.
 *
 * Returns `writes: []` when the live order already satisfies everything — that is a
 * real outcome, not an empty failure, and it is why the toposort below is stable
 * against the current order rather than picking any valid topological order.
 */
export function planRolePositions(
  roles: ReadonlyArray<RolePositionInput>,
  constraints: ReadonlyArray<RoleConstraint>,
  ctx: { botHighestRoleId: string; everyoneRoleId: string },
): RolePositionPlan {
  const byId = new Map(roles.map(r => [r.id, r]))
  const order = hierarchyOrder(roles)
  const rankOf = new Map(order.map((r, i) => [r.id, i]))   // 0 = highest

  // Unknown ids first: everything below reads these maps, and a missing id there
  // would surface as a confusing downstream refusal instead of the real cause.
  const referenced = new Set<string>()
  for (const c of constraints) {
    referenced.add(c.id)
    for (const id of c.above ?? []) referenced.add(id)
    for (const id of c.below ?? []) referenced.add(id)
  }
  const unknown = new Set([...referenced].filter(id => !byId.has(id)))
  if (!byId.has(ctx.botHighestRoleId)) unknown.add(ctx.botHighestRoleId)
  if (!byId.has(ctx.everyoneRoleId)) unknown.add(ctx.everyoneRoleId)
  if (unknown.size > 0) return { refusal: { kind: 'unknown-role', ids: [...unknown] } }

  // FROZEN: at or above the bot's own highest role, plus @everyone, which is pinned
  // to raw 0 by Discord and is not a role anything can be placed below.
  const ceilingRank = rankOf.get(ctx.botHighestRoleId)!
  const isFrozen = (id: string) => rankOf.get(id)! <= ceilingRank || id === ctx.everyoneRoleId
  const frozen = order.filter(r => isFrozen(r.id)).map(r => r.id)

  const blocked = [...referenced].filter(isFrozen)
  if (blocked.length > 0) {
    return {
      refusal: {
        kind: 'frozen',
        blockingRoleIds: blocked,
        ceiling: byId.get(ctx.botHighestRoleId)!.rawPosition,
      },
    }
  }

  // A single statement naming the same role on both sides is a contradiction we can
  // report precisely; leaving it to the cycle detector would report it as a cycle
  // and name a path instead of the sentence that is wrong.
  const contradictions: string[] = []
  for (const c of constraints) {
    const above = new Set(c.above ?? [])
    for (const id of c.below ?? []) if (above.has(id) || id === c.id) contradictions.push(id)
    if (above.has(c.id)) contradictions.push(c.id)
  }
  if (contradictions.length > 0) {
    return { refusal: { kind: 'contradiction', roleIds: [...new Set(contradictions)] } }
  }

  // Edge hi -> lo means "hi ranks above lo".
  const movable = order.filter(r => !isFrozen(r.id))
  const movableSet = new Set(movable.map(r => r.id))
  const out = new Map<string, Set<string>>(movable.map(r => [r.id, new Set<string>()]))
  const indegree = new Map<string, number>(movable.map(r => [r.id, 0]))
  const addEdge = (hi: string, lo: string) => {
    if (!movableSet.has(hi) || !movableSet.has(lo)) return
    if (out.get(hi)!.has(lo)) return
    out.get(hi)!.add(lo)
    indegree.set(lo, indegree.get(lo)! + 1)
  }
  for (const c of constraints) {
    for (const lo of c.above ?? []) addEdge(c.id, lo)
    for (const hi of c.below ?? []) addEdge(hi, c.id)
  }

  // Cycle detection, by topological sort over the movable set.
  const ready = movable.filter(r => indegree.get(r.id) === 0).map(r => r.id)
  const pending = new Map(indegree)
  const topo: string[] = []
  while (ready.length > 0) {
    ready.sort((a, b) => rankOf.get(a)! - rankOf.get(b)!)
    const next = ready.shift()!
    topo.push(next)
    for (const lo of out.get(next)!) {
      const d = pending.get(lo)! - 1
      pending.set(lo, d)
      if (d === 0) ready.push(lo)
    }
  }
  if (topo.length !== movable.length) {
    // Kahn leaves behind the cycle AND everything downstream of it. Naming the lot tells the owner
    // that roles with no cyclic clause at all "form a cycle", which is a confident wrong sentence in
    // the one place the whole design exists to be legible (Discord's own answer here is a bare 50013).
    // A role is in a cycle iff it can reach itself.
    const placed = new Set(topo)
    const stuck = movable.filter(r => !placed.has(r.id)).map(r => r.id)
    const reaches = (from: string, target: string) => {
      const seen = new Set<string>(); const queue = [...(out.get(from) ?? [])]
      while (queue.length > 0) {
        const n = queue.shift()!
        if (n === target) return true
        if (seen.has(n)) continue
        seen.add(n)
        queue.push(...(out.get(n) ?? []))
      }
      return false
    }
    const inCycle = stuck.filter(id => reaches(id, id))
    return { refusal: { kind: 'cycle', roleIds: inCycle.length > 0 ? inCycle : stuck } }
  }

  // REPAIR the live order rather than rebuilding it from the constraint graph.
  //
  // Rebuilding is where the obvious implementation goes wrong: a topological sort emits a role only
  // once every role that must sit above it has been emitted, so "put Lodestone above Owner" sinks
  // Owner from the top of the guild to the bottom -- a valid ordering, and a wild answer to the
  // question asked. So the live order is repaired in place instead: find a violated clause, move that
  // clause's SUBJECT the minimum distance that satisfies all of its own clauses, repeat.
  //
  // Then VERIFY, and fall back to the topological order if the repair did not converge. That is not
  // belt-and-braces, it is load-bearing: the first version of this lifted the subjects OUT of the list
  // and re-inserted them, so a clause naming another subject read `indexOf(...) === -1` and was
  // silently DISCARDED. On VoX's own request -- "Owner above Bot, Bot above Moderator" -- it produced
  // Owner BELOW Moderator, the exact inverse, and reported success. A property test over 5000 random
  // guilds put that at 212 silently-violated orderings, 44 of which returned "nothing to do".
  // Verification is what makes a wrong answer impossible rather than merely unlikely.
  const idx = (list: string[], id: string) => list.indexOf(id)
  const clausesOf = (id: string) => constraints.filter(c => c.id === id)
  /** The first clause not satisfied by `list`, scanning constraints in order for determinism. */
  const firstViolation = (list: string[]): string | null => {
    for (const c of constraints) {
      if (!movableSet.has(c.id)) continue
      const me = idx(list, c.id)
      for (const other of c.above ?? []) if (movableSet.has(other) && me >= idx(list, other)) return c.id
      for (const other of c.below ?? []) if (movableSet.has(other) && me <= idx(list, other)) return c.id
    }
    return null
  }

  let working = movable.map(r => r.id)
  // Bounded: each pass fixes one subject and may disturb another, so cap the churn and let the
  // verification below decide whether the result is usable rather than trusting the loop to settle.
  const maxPasses = movable.length * Math.max(1, constraints.length) * 2 + 16
  for (let pass = 0; pass < maxPasses; pass++) {
    const subject = firstViolation(working)
    if (subject === null) break
    const without = working.filter(id => id !== subject)
    // Window against the FULL remaining order -- every other role is on the board, which is precisely
    // what the lift-them-all-out version could not say.
    let lo = 0, hi = without.length
    for (const c of clausesOf(subject)) {
      for (const other of c.above ?? []) { const i = idx(without, other); if (i >= 0) hi = Math.min(hi, i) }
      for (const other of c.below ?? []) { const i = idx(without, other); if (i >= 0) lo = Math.max(lo, i + 1) }
    }
    if (lo > hi) break   // not placeable against the others as they stand; the verification below decides
    const natural = Math.min(idx(working, subject), without.length)
    without.splice(Math.max(lo, Math.min(hi, natural)), 0, subject)
    working = without
  }

  // The repair is an OPTIMISATION -- it minimises how far things move. Correctness comes from here.
  // `topo` satisfies every constraint by construction (the cycle check above proved the graph acyclic),
  // so a repair that failed to converge costs a tidier answer, never a wrong one.
  if (firstViolation(working) !== null) working = topo
  const placedOrder = working

  // Frozen roles keep their live order at the top and are still EMITTED: the body has
  // to be complete for Discord to honour it verbatim, but nothing is asked to move,
  // so no role above the ceiling is ever the subject of a write.
  const finalOrder = [
    ...order.filter(r => isFrozen(r.id) && r.id !== ctx.everyoneRoleId).map(r => r.id),
    ...placedOrder,
    ctx.everyoneRoleId,
  ]

  const liveOrder = order.map(r => r.id)
  if (finalOrder.length === liveOrder.length && finalOrder.every((id, i) => id === liveOrder[i])) {
    return { writes: [], frozen }
  }

  // Frozen roles keep the EXACT raw they hold now; the movable ones are packed contiguously in the
  // space below the lowest of them, with @everyone pinned at 0 where Discord pins it anyway. Simply
  // numbering everything contiguously is tempting -- Discord densifies a complete body regardless
  // (M11), so the numbers do not survive -- but it makes the body ASK a role above the ceiling to
  // take a different position, and the only thing measured about that is that MOVING one is 50013.
  // Ask for nothing we have not been told we may have.
  const frozenSet = new Set(frozen)
  const lowestFrozenRaw = Math.min(
    ...frozen.filter(id => id !== ctx.everyoneRoleId).map(id => byId.get(id)!.rawPosition),
    Number.POSITIVE_INFINITY,
  )
  const movableIds = finalOrder.filter(id => !frozenSet.has(id))
  const fits = movableIds.length < lowestFrozenRaw
  const writes = finalOrder.map((id, i) => {
    if (id === ctx.everyoneRoleId) return { id, position: 0 }
    if (frozenSet.has(id) && fits) return { id, position: byId.get(id)!.rawPosition }
    if (fits) return { id, position: movableIds.length - movableIds.indexOf(id) }
    return { id, position: finalOrder.length - 1 - i }   // no room to preserve: contiguous, ranks intact
  })
  return { writes, frozen }
}

/** One `above`/`below` clause, before names have been resolved to snowflakes. */
export type NamedConstraint = { subject: string; above: string[]; below: string[] }

/** Pull the relational ordering clauses out of a spec. Empty when the spec carries none,
 *  which is the common case and means no reorder entry is produced at all. */
export function namedOrderingConstraints(desired: ServerSpec): NamedConstraint[] {
  const arr = (v: string | string[] | undefined) => (v === undefined ? [] : Array.isArray(v) ? v : [v])
  return (desired.roles ?? [])
    .map(r => ({ subject: r.name, above: arr(r.above), below: arr(r.below) }))
    .filter(c => c.above.length > 0 || c.below.length > 0)
}

/**
 * Resolve ordering clauses against a role set, by name.
 *
 * `roles` must carry the names as they will exist when the reorder runs — after this
 * spec's creates and renames. That is the whole reason this is a separate step rather
 * than something computeSpecDiff does inline: a spec that renames Moderator to "op"
 * AND says `above: "Moderator"` must fail, because post-rename there is no Moderator,
 * and quietly matching the pre-rename name would reorder around a role that no longer
 * has that identity.
 *
 * Throws on a name matching zero or more than one role — the failure mode being fixed
 * here is silent misresolution, so this must never guess.
 */
export function resolveOrderingConstraints(
  roles: ReadonlyArray<RolePositionInput>,
  named: ReadonlyArray<NamedConstraint>,
): RoleConstraint[] {
  const byName = new Map<string, string[]>()
  for (const r of roles) byName.set(r.name, [...(byName.get(r.name) ?? []), r.id])
  const resolve = (name: string, ctx: string): string => {
    const hits = byName.get(name) ?? []
    if (hits.length === 1) return hits[0]!
    if (hits.length === 0) {
      throw new Error(
        `role ordering (${ctx}): no role named "${name}" will exist after this spec is applied. `
        + `above/below name roles by their FINAL name — if the spec renames it, use the new name.`)
    }
    throw new Error(
      `role ordering (${ctx}): "${name}" is ambiguous — ${hits.length} roles share that name. `
      + `Rename one, or reorder these by hand.`)
  }
  return named.map(c => ({
    id: resolve(c.subject, `subject "${c.subject}"`),
    above: c.above.map(n => resolve(n, `"${c.subject}" above "${n}"`)),
    below: c.below.map(n => resolve(n, `"${c.subject}" below "${n}"`)),
  }))
}

/** Turn a planner refusal into the sentence the owner sees. Discord's own answer to all
 *  of these is a bare 50013 that names nothing. */
export function explainOrderingRefusal(r: RolePositionRefusal, nameOf: (id: string) => string): string {
  switch (r.kind) {
    case 'unknown-role':
      return `role ordering: ${r.ids.length} role id(s) in the plan are not in this guild (${r.ids.join(', ')})`
    case 'frozen':
      return `role ordering: ${r.blockingRoleIds.map(id => `"${nameOf(id)}"`).join(', ')} `
        + `${r.blockingRoleIds.length === 1 ? 'sits' : 'sit'} at or above this bot's own highest role `
        + `(raw position ${r.ceiling}). Discord only lets a bot move roles strictly below its own, on `
        + `BOTH ends of the move — raise the bot's role above the ones it must order, or reorder by hand.`
    case 'contradiction':
      return `role ordering: the clauses for ${r.roleIds.map(id => `"${nameOf(id)}"`).join(', ')} cannot all hold at once`
    case 'cycle':
      return `role ordering: ${r.roleIds.map(id => `"${nameOf(id)}"`).join(' → ')} form a cycle — `
        + `each is required to sit above the next`
  }
}

// ── Admin tools (0.8.6): scoping, permission and hierarchy decisions ─────────────────────────────
// The pure half of admin.ts. NONE of these tools asks the owner first: at 0.8.6 the owner removed
// the approval step from every admin tool, apply_server_spec included. What still stands between a
// call and the guild is (1) the access allowlist, (2) the bot's own Discord permissions and role
// position, checked here BEFORE the request so the model gets a sentence instead of a bare 50013.

export type AdminScope = 'channel' | 'guild'

/**
 * Which allow-check governs each admin tool.
 *
 * 'channel' — the target channel must pass the SAME outbound check `reply` uses (a `groups` entry for
 *   it or its thread parent, or a server grant for its guild; a DM needs its peer in allowFrom).
 * 'guild'   — the guild must have a SERVER grant (`access.guilds[guildId]`). A granted channel inside
 *   it is not enough: roles, members, bans and channel creation/deletion reach past any one channel,
 *   so they need the grant whose scope matches theirs. This is the stricter of the two options that
 *   still works without an approval step; it is opted into per server with
 *   `/access action:grant scope:server`.
 *
 * delete_channel is guild-scoped although it names a channel: it is the one irreversible structural
 * act, and a channel grant is a grant to TALK somewhere, not to remove it. edit_channel stays
 * channel-scoped (rename/topic/slowmode on a channel you were granted is in proportion).
 */
export const ADMIN_TOOL_SCOPE = {
  fetch_reactions: 'channel',
  create_thread: 'channel',
  delete_message: 'channel',
  bulk_delete: 'channel',
  edit_channel: 'channel',
  get_member: 'guild',
  list_members: 'guild',
  create_channel: 'guild',
  delete_channel: 'guild',
  add_role: 'guild',
  remove_role: 'guild',
  timeout_member: 'guild',
  kick_member: 'guild',
  ban_member: 'guild',
  unban_member: 'guild',
  set_nickname: 'guild',
} as const satisfies Record<string, AdminScope>
export type AdminToolName = keyof typeof ADMIN_TOOL_SCOPE

export function isAdminTool(name: string): name is AdminToolName {
  return Object.hasOwn(ADMIN_TOOL_SCOPE, name)
}

/** True only for an own `guilds` entry. A `groups` entry for some channel in the guild does NOT count. */
export function guildGranted(access: { guilds?: Record<string, GroupPolicyLike> | null }, guildId: string): boolean {
  return ownEntry(access.guilds, guildId) !== undefined
}

/**
 * The guild-scope gate. `guildName` is null when the bot is not in the guild — checked FIRST, so a
 * grant left behind for a guild the bot has since left can never be acted on.
 */
export function adminGuildRefusal(
  access: { guilds?: Record<string, GroupPolicyLike> | null },
  guildId: string,
  guildName: string | null,
  tool: string,
): string | null {
  if (guildName === null) return `bot is not in guild ${guildId}`
  if (!guildGranted(access, guildId)) {
    return `${tool} is guild-scoped and ${JSON.stringify(guildName)} (${guildId}) has no server grant. `
      + `A granted channel is not enough for roles/members/bans/channel create+delete — `
      + `the owner can opt the server in with /access action:grant scope:server (or /discord:access guild add ${guildId}).`
  }
  return null
}

export type AdminPermContext = { ownMessage?: boolean; self?: boolean; isThread?: boolean }

/** The Discord permissions the BOT must hold for a call. Names are PermissionFlagsBits keys. */
export function requiredAdminPerms(tool: AdminToolName, ctx: AdminPermContext = {}): string[] {
  switch (tool) {
    case 'fetch_reactions': return ['ViewChannel', 'ReadMessageHistory']
    case 'create_thread': return ['ViewChannel', 'CreatePublicThreads']
    // Deleting your own message needs nothing; anyone else's needs Manage Messages.
    case 'delete_message': return ctx.ownMessage ? [] : ['ManageMessages']
    case 'bulk_delete': return ['ViewChannel', 'ReadMessageHistory', 'ManageMessages']
    case 'edit_channel': return ctx.isThread ? ['ManageThreads'] : ['ManageChannels']
    case 'get_member': return []
    case 'list_members': return []
    case 'create_channel': return ['ManageChannels']
    case 'delete_channel': return ctx.isThread ? ['ManageThreads'] : ['ManageChannels']
    case 'add_role': return ['ManageRoles']
    case 'remove_role': return ['ManageRoles']
    case 'timeout_member': return ['ModerateMembers']
    case 'kick_member': return ['KickMembers']
    case 'ban_member': return ['BanMembers']
    case 'unban_member': return ['BanMembers']
    case 'set_nickname': return ctx.self ? ['ChangeNickname'] : ['ManageNicknames']
  }
}

/** null when every needed permission is held. `has` is the bot's effective permission test. */
export function missingPermsRefusal(needed: readonly string[], has: (perm: string) => boolean, where: string): string | null {
  const missing = needed.filter(p => !has(p))
  if (missing.length === 0) return null
  return `the bot lacks ${missing.join(', ')} ${where} — grant it to the bot's role (Server Settings → Roles), or a channel overwrite that denies it`
}

/** Grants of these on a role are flagged ⚠ — informational only, nothing waits on them. */
export function roleDangerousPerms(perms: readonly string[]): string[] {
  return perms.filter(p => DANGEROUS_PERMS.includes(p))
}

export type RankedRole = { id: string; name: string; rawPosition: number }

/** Discord's role order: higher raw position wins; on a tie the OLDER (smaller) snowflake ranks higher.
 *  Same rule as hierarchyOrder above, which the reorder planner uses. */
export function roleOutranks(a: { id: string; rawPosition: number }, b: { id: string; rawPosition: number }): boolean {
  if (a.rawPosition !== b.rawPosition) return a.rawPosition > b.rawPosition
  return snowflake(a.id) < snowflake(b.id)
}

/** Can the bot add/remove this role at all? Mirrors what Discord enforces. */
export function roleAssignRefusal(
  role: RankedRole & { managed: boolean },
  ctx: { guildId: string; botHighest: RankedRole; botIsGuildOwner: boolean },
): string | null {
  if (role.id === ctx.guildId) return '@everyone is held by every member and cannot be added or removed'
  if (role.managed) return `role ${JSON.stringify(role.name)} (${role.id}) is managed by an integration or bot and cannot be assigned by hand`
  if (ctx.botIsGuildOwner) return null
  if (!roleOutranks(ctx.botHighest, role)) {
    return `role ${JSON.stringify(role.name)} (${role.id}) is at or above the bot's highest role ${JSON.stringify(ctx.botHighest.name)} — `
      + `Discord only lets a bot assign roles strictly below its own (drag the bot's role above it)`
  }
  return null
}

export type MemberAction = 'timeout' | 'kick' | 'ban' | 'nickname'

const ACTION_VERB: Record<MemberAction, string> = { timeout: 'time out', kick: 'kick', ban: 'ban', nickname: 'change the nickname of' }

/**
 * Can the bot do `action` to this user? Mirrors discord.js's GuildMember.manageable / moderatable,
 * which mirror Discord: nobody can act on the guild owner, the bot cannot moderate itself, and the
 * bot's highest role must strictly outrank the target's — unless the bot owns the guild.
 * `target.highest` is null when the user is not a member (only a ban works on a non-member, by id).
 */
export function memberActionRefusal(
  action: MemberAction,
  ctx: { botId: string; guildOwnerId: string; botHighest: RankedRole },
  target: { id: string; name: string; highest: RankedRole | null; isAdministrator: boolean },
): string | null {
  const verb = ACTION_VERB[action]
  const who = `${JSON.stringify(target.name)} (${target.id})`
  if (action === 'nickname' && target.id === ctx.botId) return null   // own nickname: ChangeNickname only
  if (target.id === ctx.guildOwnerId) return `${who} owns the server — nobody can ${verb} the server owner`
  if (target.id === ctx.botId) return `the bot cannot ${verb} itself`
  if (target.highest === null) {
    return action === 'ban' ? null : `${who} is not a member of this server`
  }
  if (action === 'timeout' && target.isAdministrator) {
    return `${who} has Administrator — Discord does not allow timing out administrators`
  }
  if (ctx.botId === ctx.guildOwnerId) return null
  if (!roleOutranks(ctx.botHighest, target.highest)) {
    return `${who}'s highest role ${JSON.stringify(target.highest.name)} is at or above the bot's ${JSON.stringify(ctx.botHighest.name)} — `
      + `Discord only lets a bot ${verb} members whose highest role is strictly below its own`
  }
  return null
}

// ── argument validation ──

const SNOWFLAKE_RE = /^\d{15,21}$/
export function requireSnowflake(v: unknown, field: string): string {
  const s = typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : ''
  if (!SNOWFLAKE_RE.test(s)) throw new Error(`${field} must be a Discord id (snowflake), got ${JSON.stringify(v)}`)
  return s
}

export function requireName(v: unknown, field: string, max: number): string {
  if (typeof v !== 'string' || v.trim().length === 0) throw new Error(`${field} is required and must be a non-empty string`)
  const s = v.trim()
  if (Array.from(s).length > max) throw new Error(`${field} is ${Array.from(s).length} characters; Discord allows at most ${max}`)
  return s
}

/** Discord caps a timeout at 28 days. 0 lifts an existing timeout. Returns milliseconds (null = lift). */
export const MAX_TIMEOUT_MINUTES = 28 * 24 * 60
export function timeoutMs(minutes: unknown): number | null {
  if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes < 0 || minutes > MAX_TIMEOUT_MINUTES) {
    throw new Error(`minutes must be a number from 0 (lift the timeout) to ${MAX_TIMEOUT_MINUTES} (28 days), got ${JSON.stringify(minutes)}`)
  }
  return minutes === 0 ? null : Math.round(minutes * 60_000)
}

export const MAX_BAN_DELETE_SECONDS = 7 * 24 * 60 * 60
export function banDeleteSeconds(v: unknown): number {
  if (v === undefined || v === null) return 0
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > MAX_BAN_DELETE_SECONDS) {
    throw new Error(`delete_message_seconds must be an integer from 0 to ${MAX_BAN_DELETE_SECONDS} (7 days), got ${JSON.stringify(v)}`)
  }
  return v
}

export const MAX_SLOWMODE_SECONDS = 21600
export function slowmodeSeconds(v: unknown): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > MAX_SLOWMODE_SECONDS) {
    throw new Error(`slowmode must be an integer number of seconds from 0 to ${MAX_SLOWMODE_SECONDS} (6h), got ${JSON.stringify(v)}`)
  }
  return v
}

/** create_channel's three kinds. apply_server_spec's KIND_TO_TYPE has more, but no 'category'. */
export function createChannelKind(kind: unknown): ChannelType.GuildText | ChannelType.GuildVoice | ChannelType.GuildCategory {
  switch (kind) {
    case 'text': return ChannelType.GuildText
    case 'voice': return ChannelType.GuildVoice
    case 'category': return ChannelType.GuildCategory
  }
  throw new Error(`kind must be text, voice or category, got ${JSON.stringify(kind)}`)
}

export const BULK_DELETE_MAX = 100
export type BulkDeleteTarget = { kind: 'count'; count: number } | { kind: 'ids'; ids: string[] }
/** Exactly one of count / message_ids. Discord's bulk endpoint takes at most 100 per call. */
export function parseBulkDeleteArgs(args: { count?: unknown; message_ids?: unknown }): BulkDeleteTarget {
  const hasCount = args.count !== undefined && args.count !== null
  const hasIds = args.message_ids !== undefined && args.message_ids !== null
  if (hasCount === hasIds) throw new Error('pass exactly one of count or message_ids')
  if (hasCount) {
    const c = args.count
    if (typeof c !== 'number' || !Number.isInteger(c) || c < 1 || c > BULK_DELETE_MAX) {
      throw new Error(`count must be an integer from 1 to ${BULK_DELETE_MAX}, got ${JSON.stringify(c)}`)
    }
    return { kind: 'count', count: c }
  }
  if (!Array.isArray(args.message_ids) || args.message_ids.length === 0) throw new Error('message_ids must be a non-empty array')
  if (args.message_ids.length > BULK_DELETE_MAX) throw new Error(`message_ids holds ${args.message_ids.length}; at most ${BULK_DELETE_MAX} per call`)
  const ids = [...new Set(args.message_ids.map((v, i) => requireSnowflake(v, `message_ids[${i}]`)))]
  return { kind: 'ids', ids }
}

const DISCORD_EPOCH = 1420070400000n
export function snowflakeTimestamp(id: string): number {
  return Number((BigInt(id) >> 22n) + DISCORD_EPOCH)
}

/** Discord's bulk-delete endpoint refuses messages older than 14 days (the same bound discord.js uses). */
export const BULK_DELETE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000
export function partitionBulkDeletable(ids: readonly string[], now: number): { deletable: string[]; tooOld: string[] } {
  const deletable: string[] = [], tooOld: string[] = []
  for (const id of ids) (now - snowflakeTimestamp(id) < BULK_DELETE_MAX_AGE_MS ? deletable : tooOld).push(id)
  return { deletable, tooOld }
}

// ── result formatting (one row per thing, newline-joined like fetch_messages / lookup) ──

export type MemberRowInput = {
  id: string
  username: string
  displayName: string
  nickname: string | null
  bot: boolean
  joinedAt: Date | null
  roles: Array<{ name: string; id: string }>
  timedOutUntil: Date | null
  isOwner: boolean
}

export function formatMemberRow(m: MemberRowInput, now: number): string {
  const timeout = m.timedOutUntil && m.timedOutUntil.getTime() > now ? m.timedOutUntil.toISOString() : 'none'
  return `member id=${m.id} username=${JSON.stringify(m.username)} display=${JSON.stringify(m.displayName)}`
    + (m.nickname ? ` nick=${JSON.stringify(m.nickname)}` : '')
    + ` bot=${m.bot}${m.isOwner ? ' owner=true' : ''}`
    + ` joined=${m.joinedAt ? m.joinedAt.toISOString() : 'unknown'}`
    + ` timed_out_until=${timeout}`
    + ` roles=${JSON.stringify(m.roles.map(r => `${r.name} (${r.id})`).join(', '))}`
}

export type ReactionRowInput = {
  emoji: string
  count: number
  me: boolean
  users?: Array<{ id: string; username: string }>
}

export function formatReactionRows(rows: readonly ReactionRowInput[]): string {
  if (rows.length === 0) return '(no reactions)'
  return rows.map((r, i) => {
    const users = r.users
      ? ` users=${JSON.stringify(r.users.map(u => `${u.username} (${u.id})`).join(', '))}${r.users.length < r.count ? ` (+${r.count - r.users.length} more)` : ''}`
      : ''
    return `reaction[${i}] emoji=${r.emoji} count=${r.count}${r.me ? ' me=true' : ''}${users}`
  }).join('\n')
}
