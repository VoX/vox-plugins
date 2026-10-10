import { test, expect, describe } from 'bun:test'
import {
  safeSlice, formatSendResult, assertEmbedUrl, chunk, buildEmbedFromArgs, composePresence, withContextPrefix,
  resolveColorInput, validatePermissionNames, kindToChannelType, channelTypeToKind,
  buildServerSpec, computeSpecDiff, renderSpecDiff, overwriteEditMap, grantGroup, removeGroup, makeTtlCache,
  normalizeLookupQuery, clampLookupLimit, lookupNameMatches, lookupRank,
  grantDm, removeDm, resolveById,
  parseAccess, defaultAccess, resolveChannelPolicy, channelAllowed, groupGateVerdict,
  planRolePositions,
  resolveOrderingConstraints,
  namedOrderingConstraints,
  type RawGuildState, type ServerSpec, type RolePositionInput } from './lib'

describe('safeSlice', () => {
  test('returns input unchanged when shorter than limit', () => {
    expect(safeSlice('hello', 10)).toBe('hello')
  })

  test('returns input unchanged when exactly at limit', () => {
    expect(safeSlice('hello', 5)).toBe('hello')
  })

  test('truncates plain ASCII at codepoint limit', () => {
    expect(safeSlice('abcdef', 3)).toBe('abc')
  })

  test('preserves multi-codepoint emoji (no lone surrogate)', () => {
    // 🦝 is U+1F99D — two UTF-16 code units. Slice at 4 in code units would
    // strand a lone surrogate; safeSlice slices at 4 codepoints instead.
    const out = safeSlice('abc🦝def', 4)
    expect(out).toBe('abc🦝')
    // No lone surrogate: every char in [0xd800,0xdfff] must be paired.
    for (let i = 0; i < out.length; i++) {
      const code = out.charCodeAt(i)
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = out.charCodeAt(i + 1)
        expect(next >= 0xdc00 && next <= 0xdfff).toBe(true)
        i++
      } else {
        expect(code >= 0xdc00 && code <= 0xdfff).toBe(false)
      }
    }
  })

  test('handles trailing-emoji-with-200-cap regression (the ulant case)', () => {
    // Build a 209-codepoint string with a non-BMP emoji that would land mid-pair
    // under raw `.slice(0, 200)` (UTF-16 code units). safeSlice picks the
    // codepoint after the emoji, keeping it intact.
    const str = 'm '.repeat(99) + '🦝 trailing'
    const out = safeSlice(str, 200)
    // 200 codepoints: 198 ('m ' × 99) + 🦝 + ' '
    expect(out).toBe('m '.repeat(99) + '🦝 ')
    expect(Array.from(out).length).toBe(200)
    // Round-trip JSON: a lone surrogate would corrupt the parse.
    expect(() => JSON.parse(JSON.stringify(out))).not.toThrow()
  })

  test('empty string is passthrough', () => {
    expect(safeSlice('', 10)).toBe('')
  })

  test('zero limit returns empty string', () => {
    expect(safeSlice('abc', 0)).toBe('')
  })

  test('JSON round-trip survives many adjacent emoji', () => {
    const out = safeSlice('🦝🫡🐧🦊🦝🫡🐧🦊', 5)
    expect(out).toBe('🦝🫡🐧🦊🦝')
    expect(() => JSON.parse(JSON.stringify(out))).not.toThrow()
  })
})

describe('formatSendResult', () => {
  test('single id uses singular phrasing', () => {
    expect(formatSendResult(['123'])).toBe('sent (id: 123)')
  })

  test('multiple ids include count and join', () => {
    expect(formatSendResult(['1', '2', '3'])).toBe('sent 3 parts (ids: 1, 2, 3)')
  })
})

describe('assertEmbedUrl', () => {
  test('accepts http URLs', () => {
    expect(() => assertEmbedUrl('url', 'http://example.com')).not.toThrow()
  })

  test('accepts https URLs', () => {
    expect(() => assertEmbedUrl('url', 'https://example.com/path?x=1')).not.toThrow()
  })

  test('accepts case-insensitive scheme', () => {
    expect(() => assertEmbedUrl('url', 'HTTPS://example.com')).not.toThrow()
  })

  test('rejects javascript: scheme', () => {
    expect(() => assertEmbedUrl('url', 'javascript:alert(1)')).toThrow(/must be an http\(s\) URL/)
  })

  test('rejects data: scheme', () => {
    expect(() => assertEmbedUrl('url', 'data:text/html,<script>alert(1)</script>')).toThrow(/must be an http\(s\) URL/)
  })

  test('rejects file: scheme', () => {
    expect(() => assertEmbedUrl('url', 'file:///etc/passwd')).toThrow(/must be an http\(s\) URL/)
  })

  test('rejects schemeless URL', () => {
    expect(() => assertEmbedUrl('url', 'example.com')).toThrow(/must be an http\(s\) URL/)
  })

  test('rejects empty string', () => {
    expect(() => assertEmbedUrl('url', '')).toThrow(/must be an http\(s\) URL/)
  })

  test('error message JSON-quotes the bad value', () => {
    try {
      assertEmbedUrl('url', 'javascript:alert(1)')
      throw new Error('expected throw')
    } catch (e: any) {
      expect(e.message).toContain('"javascript:alert(1)"')
    }
  })

  test('error message includes the field name', () => {
    expect(() => assertEmbedUrl('thumbnail_url', 'bad'))
      .toThrow(/^thumbnail_url /)
  })
})

describe('buildEmbedFromArgs', () => {
  test('empty args returns empty embed (no throw)', () => {
    expect(() => buildEmbedFromArgs({})).not.toThrow()
  })

  test('basic embed sets fields via discord.js EmbedBuilder', () => {
    const e = buildEmbedFromArgs({ title: 'hi', description: 'body' })
    const json = e.toJSON()
    expect(json.title).toBe('hi')
    expect(json.description).toBe('body')
  })

  test('rejects javascript: url', () => {
    expect(() => buildEmbedFromArgs({ url: 'javascript:alert(1)' }))
      .toThrow(/url must be an http\(s\) URL/)
  })

  test('rejects javascript: thumbnail_url', () => {
    expect(() => buildEmbedFromArgs({ thumbnail_url: 'javascript:alert(1)' }))
      .toThrow(/thumbnail_url must be an http\(s\) URL/)
  })

  test('rejects more than 25 fields', () => {
    const fields = Array.from({ length: 26 }, (_, i) => ({ name: `f${i}`, value: `v${i}` }))
    expect(() => buildEmbedFromArgs({ fields }))
      .toThrow(/max 25 embed fields \(got 26\)/)
  })

  test('rejects field missing name or value', () => {
    expect(() => buildEmbedFromArgs({ fields: [{ name: 'ok', value: 'ok' }, { name: 'bad' }] }))
      .toThrow(/field\[1\] missing name or value/)
  })

  test('rejects invalid color', () => {
    expect(() => buildEmbedFromArgs({ color: 'not-a-color' }))
      .toThrow(/invalid color/)
  })

  test('accepts named color (case-insensitive)', () => {
    expect(() => buildEmbedFromArgs({ color: 'blurple' })).not.toThrow()
    expect(() => buildEmbedFromArgs({ color: 'BLURPLE' })).not.toThrow()
    expect(() => buildEmbedFromArgs({ color: 'Blurple' })).not.toThrow()
  })

  test('accepts hex color with and without hash', () => {
    expect(() => buildEmbedFromArgs({ color: '#5865f2' })).not.toThrow()
    expect(() => buildEmbedFromArgs({ color: '5865f2' })).not.toThrow()
  })

  test('rejects invalid timestamp', () => {
    expect(() => buildEmbedFromArgs({ timestamp: 'not-a-date' }))
      .toThrow(/invalid timestamp/)
  })

  test('accepts timestamp:true (now)', () => {
    expect(() => buildEmbedFromArgs({ timestamp: true })).not.toThrow()
  })

  test('accepts ISO-8601 timestamp', () => {
    expect(() => buildEmbedFromArgs({ timestamp: '2026-04-28T00:00:00Z' })).not.toThrow()
  })

  test('truncates oversized title via safeSlice', () => {
    const longTitle = 'x'.repeat(1000)
    const e = buildEmbedFromArgs({ title: longTitle })
    expect(e.toJSON().title!.length).toBe(256)
  })
})

describe('chunk', () => {
  test('short text returns single chunk', () => {
    expect(chunk('hello world', 100)).toEqual(['hello world'])
  })

  test('cuts at paragraph boundary when available', () => {
    const text = 'line 1\nline 2\n\nline 3 is in para two'
    const out = chunk(text, 16)
    expect(out[0]).toBe('line 1\nline 2')
    expect(out[1]).toBe('line 3 is in')
    // Only assert essentials — third chunk content depends on cut algo
    expect(out.length).toBeGreaterThan(1)
  })

  test('cuts at line boundary when no paragraph break', () => {
    const out = chunk('hello\nworld how are you', 11)
    expect(out[0]).toBe('hello')
    expect(out[1]).toBe('world how')
    expect(out[2]).toBe('are you')
  })

  test('cuts at space boundary when no line break', () => {
    const out = chunk('the quick brown fox', 10)
    expect(out[0]).toBe('the quick')
    expect(out[1]).toBe('brown fox')
  })

  test('hard-cuts at limit when no whitespace exists', () => {
    const out = chunk('aaaaaaaaaa', 4)
    expect(out).toEqual(['aaaa', 'aaaa', 'aa'])
  })

  test('strips leading whitespace from continuation chunks', () => {
    const out = chunk('hello world', 5)
    expect(out[1]).toBe('world')
    expect(out[1].startsWith(' ')).toBe(false)
  })
})

describe('withContextPrefix', () => {
  test('prefixes the context size onto a status', () => {
    expect(withContextPrefix('565k', '💤 idle…')).toBe('565k - 💤 idle…')
    expect(withContextPrefix('242k', '🐾 working…')).toBe('242k - 🐾 working…')
  })
  test('empty context leaves the status unchanged (unknown / turn 1)', () => {
    expect(withContextPrefix('', '💤 idle…')).toBe('💤 idle…')
  })
  test('empty status stays empty (a clear stays a clear, no stray prefix)', () => {
    expect(withContextPrefix('565k', '')).toBe('')
    expect(withContextPrefix('', '')).toBe('')
  })
})

describe('composePresence', () => {
  test('aggregates distinct actions in first-occurrence order, drops working', () => {
    expect(composePresence('🐾 working…\n📖 reading…\n✏️ editing…\n')).toBe('📖 reading ✏️ editing…')
  })
  test('working shown only when it is the sole entry', () => {
    expect(composePresence('🐾 working…\n')).toBe('🐾 working…')
  })
  test('dedupes repeated actions', () => {
    expect(composePresence('🐾 working…\n📖 reading…\n📖 reading…\n✏️ editing…\n')).toBe('📖 reading ✏️ editing…')
  })
  test('keeps first-occurrence order when an action repeats later', () => {
    expect(composePresence('🐾 working…\n📖 reading…\n✏️ editing…\n📖 reading…\n')).toBe('📖 reading ✏️ editing…')
  })
  test('full chain of distinct actions', () => {
    expect(composePresence('🐾 working…\n📖 reading…\n✏️ editing…\n💾 committing…\n⬆️ pushing…\n'))
      .toBe('📖 reading ✏️ editing 💾 committing ⬆️ pushing…')
  })
  test('idle is unique', () => {
    expect(composePresence('💤 idle…\n')).toBe('💤 idle…')
  })
  test('idle overrides any accumulated actions (terminal)', () => {
    expect(composePresence('🐾 working…\n📖 reading…\n💤 idle…\n')).toBe('💤 idle…')
  })
  test('empty / absent -> empty (resting, no text)', () => {
    expect(composePresence('')).toBe('')
    expect(composePresence('\n\n')).toBe('')
  })
  test('idle rests only when it is the LAST line (terminal)', () => {
    expect(composePresence('🐾 working…\n📖 reading…\n💤 idle…\n')).toBe('💤 idle…')
  })
  test('a tool append AFTER idle (race) shows the work, not idle', () => {
    // Stop hook wrote idle, then an in-flight tool appended — work continued.
    expect(composePresence('🐾 working…\n📖 reading…\n💤 idle…\n✏️ editing…\n')).toBe('📖 reading ✏️ editing…')
  })
  test('drops a stray mid-sequence idle, keeps all actions', () => {
    expect(composePresence('📖 reading…\n💤 idle…\n⚙️ running…\n')).toBe('📖 reading ⚙️ running…')
  })
  test('the live-poison shape (idle first, work after) recovers to active', () => {
    expect(composePresence('💤 idle…\n🤝 delegating…\n📖 reading…\n📖 reading…\n')).toBe('🤝 delegating 📖 reading…')
  })
  test('a "run <name>" label whose name is idle/working is NOT a sentinel (emoji-matched)', () => {
    expect(composePresence('🐾 working…\n⚙️ run idle…\n')).toBe('⚙️ run idle…')
    expect(composePresence('🐾 working…\n⚙️ run working…\n')).toBe('⚙️ run working…')
  })
})

describe('resolveColorInput', () => {
  test('resolves hex with and without hash', () => {
    expect(resolveColorInput('#5865f2')).toBe(0x5865f2)
    expect(resolveColorInput('5865f2')).toBe(0x5865f2)
  })

  test('resolves named colors case-insensitively', () => {
    expect(resolveColorInput('blurple')).toBe(resolveColorInput('Blurple'))
    expect(resolveColorInput('BLURPLE')).toBe(resolveColorInput('Blurple'))
  })

  test('throws on garbage', () => {
    expect(() => resolveColorInput('not-a-color')).toThrow(/invalid color/)
  })
})

describe('validatePermissionNames', () => {
  test('valid names pass through', () => {
    expect(validatePermissionNames(['ViewChannel', 'SendMessages', 'BanMembers'], 'test'))
      .toEqual(['ViewChannel', 'SendMessages', 'BanMembers'])
  })

  test('unknown name throws with the name and context in the message', () => {
    expect(() => validatePermissionNames(['ViewChannel', 'NotAPerm'], 'role "Mod"'))
      .toThrow(/role "Mod".*NotAPerm/)
  })

  test('prototype-chain keys are rejected (Object.hasOwn, not `in`)', () => {
    expect(() => validatePermissionNames(['constructor'], 'test')).toThrow(/unknown permission/)
  })
})

describe('channel kind mapping', () => {
  test('round-trips every supported kind', () => {
    for (const kind of ['text', 'voice', 'announcement', 'forum', 'stage']) {
      expect(channelTypeToKind(kindToChannelType(kind))).toBe(kind)
    }
  })

  test('unknown kind throws', () => {
    expect(() => kindToChannelType('carrier-pigeon')).toThrow(/unknown channel kind/)
  })

  test('unsupported channel types map to null', () => {
    expect(channelTypeToKind(4)).toBe(null)   // GuildCategory — not a leaf kind
    expect(channelTypeToKind(14)).toBe(null)  // GuildDirectory
  })
})

// Shared fixture: a small guild with one category, two channels, a couple of
// roles (one managed), and overwrites on the category + text channel.
function fixtureState(): RawGuildState {
  return {
    guildId: 'g1',
    everyonePermissions: ['ViewChannel', 'SendMessages'],
    roles: [
      // Deliberately adversarial: array order says Member first, RANK says Member first,
      // RAW says Mod first. The export must say Mod first, so neither dropping the sort
      // nor sorting on the rank can pass.
      { id: 'r2', name: 'Member', hexColor: '#000000', hoist: false, mentionable: true, permissions: ['ViewChannel'], position: 2, rawPosition: 5, managed: false },
      { id: 'r1', name: 'Mod', hexColor: '#5865f2', hoist: true, mentionable: false, permissions: ['KickMembers', 'ViewChannel'], position: 1, rawPosition: 8, managed: false },
      { id: 'r3', name: 'SomeBot', hexColor: '#000000', hoist: false, mentionable: false, permissions: ['Administrator'], position: 3, rawPosition: 9, managed: true },
    ],
    channels: [
      { id: 'c1', name: 'Staff', type: 4, parentId: null, position: 0, topic: null, rateLimitPerUser: null, nsfw: false,
        overwrites: [{ id: 'g1', type: 'role', allow: [], deny: ['ViewChannel'] }] },
      { id: 'c2', name: 'mod-log', type: 0, parentId: 'c1', position: 0, topic: 'mod actions', rateLimitPerUser: 30, nsfw: false,
        overwrites: [{ id: 'r1', type: 'role', allow: ['ViewChannel'], deny: [] }, { id: 'u9', type: 'member', allow: [], deny: [] }] },
      { id: 'c3', name: 'lobby', type: 0, parentId: null, position: 1, topic: null, rateLimitPerUser: 0, nsfw: false, overwrites: [] },
    ],
  }
}

describe('buildServerSpec', () => {
  const spec = buildServerSpec(fixtureState())

  test('serializes @everyone permissions sorted', () => {
    expect(spec.everyone_permissions).toEqual(['SendMessages', 'ViewChannel'])
  })

  // THE BUG THIS FILE DID NOT CATCH. buildServerSpec exported discord.js's Role.position
  // -- a computed sorted RANK -- through a field the tool documents as "exactly the shape
  // apply_server_spec consumes". A rank cannot be PATCHed back and can never show a tie, so
  // a guild with every role at raw 1 reported a tidy 3/2/1 and the ties were invisible. The
  // fixtures deliberately give rank and raw DIFFERENT values now, so confusing the two fails.
  test('role position exports the RAW value, not the sorted rank', () => {
    const spec = buildServerSpec(fixtureState())
    const mod = spec.roles!.find(r => r.name === 'Mod')!
    expect(mod.position).toBe(8)     // rawPosition
    expect(mod.position).not.toBe(1) // Role.position, the rank
  })

  test('roles TIED at the same raw position both report the tie', () => {
    // A tie is real information: tied roles order by id, and a bot cannot reorder roles it
    // is tied with. An export that renumbers them 2/1 hides the reason a reorder will fail.
    // Own fixture, because the shared one is built to disagree on every axis.
    const tied = fixtureState()
    tied.roles = [
      { id: '200', name: 'Newer', hexColor: '#000000', hoist: false, mentionable: false, permissions: [], position: 1, rawPosition: 1, managed: false },
      { id: '100', name: 'Older', hexColor: '#000000', hoist: false, mentionable: false, permissions: [], position: 2, rawPosition: 1, managed: false },
    ]
    const spec = buildServerSpec(tied)
    expect(spec.roles!.map(r => r.position)).toEqual([1, 1])
    // and the tie resolves the way Discord resolves it: older snowflake ranks HIGHER
    expect(spec.roles!.map(r => r.name)).toEqual(['Older', 'Newer'])
  })

  test('the tie-break is BigInt, not a string compare', () => {
    // Snowflakes crossed 18 -> 19 digits on 2022-07-22. localeCompare puts EVERY 19-digit id
    // before every 18-digit one, so a guild with roles from both sides of that date exports
    // its hierarchy inverted -- and every id in the other fixtures is the same length, so
    // nothing else here can see it.
    const mixed = fixtureState()
    mixed.roles = [
      { id: '1000000000000000000', name: 'Newer19', hexColor: '#000000', hoist: false, mentionable: false, permissions: [], position: 1, rawPosition: 4, managed: false },
      { id: '999999999999999999', name: 'Older18', hexColor: '#000000', hoist: false, mentionable: false, permissions: [], position: 2, rawPosition: 4, managed: false },
    ]
    expect(buildServerSpec(mixed).roles!.map(r => r.name)).toEqual(['Older18', 'Newer19'])
  })

  test('a position MATCHING the live raw position is accepted as a no-op', () => {
    // The documented round-trip: get_server_spec's output fed straight back must not fail,
    // and must not report a change. position is in that output, so rejecting it outright
    // would break the contract four places in the tool descriptions promise.
    const diff = computeSpecDiff(buildServerSpec(fixtureState()), { roles: [{ name: 'Mod', position: 8 }] })
    expect(diff.entries.find(e => e.kind === 'role' && e.name === 'Mod')).toBeUndefined()
  })

  test('a position DIFFERING from the live raw position is a hard error', () => {
    // Silently ignoring it was the original bug -- apply answered "already matches, 0 changes"
    // to a reorder it never compared. Diffing it was the wrong fix: Discord treats a position
    // in a partial write as advisory and normalises the guild on a complete one, so "set this
    // role to 3" is not an operation the API offers.
    expect(() => computeSpecDiff(buildServerSpec(fixtureState()), { roles: [{ name: 'Mod', position: 3 }] }))
      .toThrow(/position 3 does not match its live raw position 8/)
  })

  test('position on a role being CREATED is a hard error, not a silent drop', () => {
    // POST /guilds/{id}/roles has no position field at all (measured: asked for 3, landed at 1), so
    // a create can never honour it. The docs said a differing position is an error; the check lived
    // only in the modify branch, so on a create it was silently dropped -- the exact silent-drop this
    // whole change exists to remove, reintroduced one branch over.
    expect(() => computeSpecDiff(buildServerSpec(fixtureState()), { roles: [{ name: 'Brand New', position: 3 }] }))
      .toThrow(/remove `position`/)
  })

  test('a create with NO position still works, and prints no position change', () => {
    const diff = computeSpecDiff(buildServerSpec(fixtureState()), { roles: [{ name: 'Brand New' }] })
    const created = diff.entries.find(e => e.kind === 'role' && e.name === 'Brand New')!
    expect(created.op).toBe('create')
    expect(created.changes.find(c => c.field === 'position')).toBeUndefined()
  })

  test('excludes managed roles, sorts by position (highest first)', () => {
    expect(spec.roles!.map(r => r.name)).toEqual(['Mod', 'Member'])
  })

  test('serializes role fields, omitting defaults', () => {
    const mod = spec.roles![0]!
    expect(mod).toEqual({ name: 'Mod', id: 'r1', color: '#5865f2', hoist: true, permissions: ['KickMembers', 'ViewChannel'], position: 8 })
    const member = spec.roles![1]!
    expect(member.color).toBeUndefined()   // #000000 = no color
    expect(member.hoist).toBeUndefined()
    expect(member.mentionable).toBe(true)
  })

  test('emits the Discord snowflake as id on roles, categories, and channels', () => {
    expect(spec.roles!.map(r => r.id)).toEqual(['r1', 'r2'])
    expect(spec.categories![0]!.id).toBe('c1')
    expect(spec.categories![0]!.channels![0]!.id).toBe('c2')
    expect(spec.channels![0]!.id).toBe('c3')
  })

  test('nests channels under their category, keeps top-level channels separate', () => {
    expect(spec.categories!.map(c => c.name)).toEqual(['Staff'])
    expect(spec.categories![0]!.channels!.map(c => c.name)).toEqual(['mod-log'])
    expect(spec.channels!.map(c => c.name)).toEqual(['lobby'])
  })

  test('maps overwrite targets to @everyone / role:<Name>, keeps member snowflakes', () => {
    expect(spec.categories![0]!.overwrites).toEqual([{ id: '@everyone', type: 'role', deny: ['ViewChannel'] }])
    const modLog = spec.categories![0]!.channels![0]!
    expect(modLog.overwrites).toEqual([{ id: 'role:Mod', type: 'role', allow: ['ViewChannel'] }])
  })

  test('drops empty overwrites and empty overwrite lists', () => {
    // u9's all-empty overwrite vanished above; lobby has none at all
    expect(spec.channels![0]!.overwrites).toBeUndefined()
  })

  test('keeps raw snowflake for ambiguous duplicate role names', () => {
    const state = fixtureState()
    state.roles.push({ id: 'r4', name: 'Mod', hexColor: '#000000', hoist: false, mentionable: false, permissions: [], position: 0, rawPosition: 0, managed: false })
    const s = buildServerSpec(state)
    const modLog = s.categories![0]!.channels![0]!
    expect(modLog.overwrites![0]!.id).toBe('r1')
  })

  test('serializes channel topic/slowmode, omits zero-values', () => {
    const modLog = spec.categories![0]!.channels![0]!
    expect(modLog.topic).toBe('mod actions')
    expect(modLog.slowmode).toBe(30)
    expect(spec.channels![0]!.slowmode).toBeUndefined()
  })
})

describe('computeSpecDiff', () => {
  const currentSpec = () => buildServerSpec(fixtureState())

  test('re-applying the serialized spec yields an empty diff (idempotent)', () => {
    const diff = computeSpecDiff(currentSpec(), currentSpec())
    expect(diff.entries).toEqual([])
  })

  test('empty spec changes nothing, lists everything untouched', () => {
    const diff = computeSpecDiff(currentSpec(), {})
    expect(diff.entries).toEqual([])
    expect(diff.untouched).toContain('role "Mod"')
    expect(diff.untouched).toContain('category "Staff"')
    expect(diff.untouched).toContain('channel "Staff / #mod-log"')
    expect(diff.untouched).toContain('channel "#lobby"')
    expect(diff.untouched).toContain('@everyone permissions')
  })

  test('detects role create with dangerous-perm flag', () => {
    const diff = computeSpecDiff(currentSpec(), {
      roles: [{ name: 'Admin', permissions: ['Administrator'], color: '#ff0000' }],
    })
    expect(diff.entries).toHaveLength(1)
    const e = diff.entries[0]!
    expect(e).toMatchObject({ kind: 'role', op: 'create', name: 'Admin' })
    expect(e.dangerous).toEqual(['grants Administrator to new role "Admin"'])
  })

  test('detects role modify with before→after, only for drifted fields', () => {
    const diff = computeSpecDiff(currentSpec(), {
      roles: [{ name: 'Mod', hoist: false, permissions: ['KickMembers', 'ViewChannel', 'BanMembers'] }],
    })
    expect(diff.entries).toHaveLength(1)
    const e = diff.entries[0]!
    expect(e.op).toBe('modify')
    expect(e.changes).toEqual([
      { field: 'hoist', before: true, after: false },
      { field: 'permissions', before: ['KickMembers', 'ViewChannel'], after: ['BanMembers', 'KickMembers', 'ViewChannel'] },
    ])
    expect(e.dangerous).toEqual(['grants BanMembers to role "Mod"'])
  })

  test('matching role fields produce no entry (additive, field-level)', () => {
    // Only name + one already-matching field: nothing to do.
    const diff = computeSpecDiff(currentSpec(), { roles: [{ name: 'Mod', hoist: true }] })
    expect(diff.entries).toEqual([])
  })

  test('revoking a dangerous perm is a change but NOT flagged dangerous', () => {
    const diff = computeSpecDiff(currentSpec(), { roles: [{ name: 'Mod', permissions: ['ViewChannel'] }] })
    expect(diff.entries).toHaveLength(1)
    expect(diff.entries[0]!.dangerous).toEqual([])
  })

  test('detects @everyone permission change with dangerous flag', () => {
    const diff = computeSpecDiff(currentSpec(), { everyone_permissions: ['ViewChannel', 'SendMessages', 'MentionEveryone'] })
    expect(diff.entries).toHaveLength(1)
    expect(diff.entries[0]!.kind).toBe('everyone')
    expect(diff.entries[0]!.dangerous).toEqual(['grants MentionEveryone to @everyone'])
  })

  test('detects category + channel creates, in dependency order', () => {
    const diff = computeSpecDiff(currentSpec(), {
      categories: [{ name: 'Voice Zone', channels: [{ name: 'hangout', kind: 'voice' }] }],
    })
    expect(diff.entries.map(e => `${e.kind}:${e.op}`)).toEqual(['category:create', 'channel:create'])
    expect(diff.entries[1]!).toMatchObject({ name: 'hangout', category: 'Voice Zone' })
  })

  test('detects channel field drift (topic/slowmode/nsfw)', () => {
    const diff = computeSpecDiff(currentSpec(), {
      categories: [{ name: 'Staff', channels: [{ name: 'mod-log', topic: 'new topic', slowmode: 0, nsfw: true }] }],
    })
    expect(diff.entries).toHaveLength(1)
    expect(diff.entries[0]!.changes).toEqual([
      { field: 'topic', before: 'mod actions', after: 'new topic' },
      { field: 'slowmode', before: 30, after: 0 },
      { field: 'nsfw', before: false, after: true },
    ])
  })

  test('detects overwrite drift and emits a converging edit map', () => {
    const diff = computeSpecDiff(currentSpec(), {
      categories: [{ name: 'Staff', channels: [{ name: 'mod-log', overwrites: [{ id: 'role:Mod', allow: ['ViewChannel', 'ManageMessages'] }] }] }],
    })
    expect(diff.entries).toHaveLength(1)
    const e = diff.entries[0]!
    expect(e.overwriteEdits).toEqual([
      { id: 'role:Mod', type: undefined, set: { ViewChannel: true, ManageMessages: true } },
    ])
  })

  test('overwrite edit map nulls out perms the spec no longer sets', () => {
    expect(overwriteEditMap({ allow: ['ViewChannel', 'ManageMessages'], deny: ['SendMessages'] }, { allow: ['ViewChannel'] }))
      .toEqual({ ViewChannel: true, ManageMessages: null, SendMessages: null })
  })

  test('new dangerous overwrite grant is flagged', () => {
    const diff = computeSpecDiff(currentSpec(), {
      channels: [{ name: 'lobby', overwrites: [{ id: 'role:Mod', allow: ['MentionEveryone'] }] }],
    })
    expect(diff.entries[0]!.dangerous).toEqual(['grants MentionEveryone via overwrite role:Mod on channel "#lobby"'])
  })

  test('never deletes: extra current entities land in untouched, not entries', () => {
    const diff = computeSpecDiff(currentSpec(), { roles: [{ name: 'Mod', hoist: true }] })
    expect(diff.entries).toEqual([])
    expect(diff.untouched).toContain('role "Member"')
  })

  test('throws on unknown permission name', () => {
    expect(() => computeSpecDiff(currentSpec(), { roles: [{ name: 'X', permissions: ['Yeet'] }] }))
      .toThrow(/unknown permission name/)
  })

  test('throws on unknown channel kind', () => {
    expect(() => computeSpecDiff(currentSpec(), { channels: [{ name: 'x', kind: 'podcast' }] }))
      .toThrow(/unknown channel kind/)
  })

  test('throws on channel kind mismatch with the existing channel', () => {
    expect(() => computeSpecDiff(currentSpec(), { channels: [{ name: 'lobby', kind: 'voice' }] }))
      .toThrow(/exists as text but the spec says voice/)
  })

  test('throws on @everyone in roles[]', () => {
    expect(() => computeSpecDiff(currentSpec(), { roles: [{ name: '@everyone' }] }))
      .toThrow(/everyone_permissions/)
  })

  test('throws on duplicate role names in the spec', () => {
    expect(() => computeSpecDiff(currentSpec(), { roles: [{ name: 'X' }, { name: 'X' }] }))
      .toThrow(/duplicate name "X"/)
  })

  test('throws when targeting an ambiguous duplicate role name in the guild', () => {
    const state = fixtureState()
    state.roles.push({ id: 'r4', name: 'Mod', hexColor: '#000000', hoist: false, mentionable: false, permissions: [], position: 0, rawPosition: 0, managed: false })
    expect(() => computeSpecDiff(buildServerSpec(state), { roles: [{ name: 'Mod', hoist: false }] }))
      .toThrow(/ambiguous/)
  })

  test('throws on raw-snowflake overwrite without a type', () => {
    expect(() => computeSpecDiff(currentSpec(), { channels: [{ name: 'lobby', overwrites: [{ id: '12345', allow: ['ViewChannel'] }] }] }))
      .toThrow(/set type/)
  })

  test('color compared by resolved value, not string form', () => {
    // #5865f2 both ways — one uppercase, no hash: still equal, no entry.
    const diff = computeSpecDiff(currentSpec(), { roles: [{ name: 'Mod', color: '5865F2' }] })
    expect(diff.entries).toEqual([])
  })
})

describe('computeSpecDiff — id matching & prune', () => {
  const currentSpec = () => buildServerSpec(fixtureState())
  // The never-delete context server.ts passes: guild id (=@everyone),
  // managed role ids, the bot's own role ids.
  const pruneOpts = { prune: true, guildId: 'g1', managedRoleIds: ['r3'], botRoleIds: [] }

  test('id kept + name changed → rename op, not delete+create', () => {
    const diff = computeSpecDiff(currentSpec(), { roles: [{ id: 'r1', name: 'Moderator' }] })
    expect(diff.entries).toHaveLength(1)
    expect(diff.entries[0]!).toMatchObject({ kind: 'role', op: 'rename', id: 'r1', name: 'Moderator' })
    expect(diff.entries[0]!.changes).toEqual([{ field: 'name', before: 'Mod', after: 'Moderator' }])
  })

  test('channel rename rides alongside field drift; renames sort after updates', () => {
    const diff = computeSpecDiff(currentSpec(), {
      categories: [{ id: 'c1', name: 'Staff', channels: [{ id: 'c2', name: 'mod-logs', topic: 'new topic' }] }],
    })
    expect(diff.entries.map(e => e.op)).toEqual(['modify', 'rename'])
    expect(diff.entries[0]!).toMatchObject({ kind: 'channel', op: 'modify', id: 'c2', name: 'mod-logs' })
    expect(diff.entries[0]!.changes).toEqual([{ field: 'topic', before: 'mod actions', after: 'new topic' }])
    expect(diff.entries[1]!.changes).toEqual([{ field: 'name', before: 'mod-log', after: 'mod-logs' }])
  })

  test('id kept + parent changed → move op', () => {
    const diff = computeSpecDiff(currentSpec(), {
      categories: [{ id: 'c1', name: 'Staff', channels: [{ id: 'c3', name: 'lobby' }] }],
    })
    expect(diff.entries).toHaveLength(1)
    expect(diff.entries[0]!).toMatchObject({ kind: 'channel', op: 'move', id: 'c3', name: 'lobby', category: 'Staff' })
    expect(diff.entries[0]!.changes).toEqual([{ field: 'category', before: '(top-level)', after: 'Staff' }])
  })

  test('move to top-level (parent → null)', () => {
    const diff = computeSpecDiff(currentSpec(), { channels: [{ id: 'c2', name: 'mod-log' }] })
    expect(diff.entries).toHaveLength(1)
    expect(diff.entries[0]!).toMatchObject({ kind: 'channel', op: 'move', id: 'c2', category: null })
    expect(diff.entries[0]!.changes).toEqual([{ field: 'category', before: 'Staff', after: '(top-level)' }])
  })

  test('stale/foreign id falls back to name match — no throw, no create', () => {
    const diff = computeSpecDiff(currentSpec(), { roles: [{ id: '999999', name: 'Mod', hoist: false }] })
    expect(diff.entries).toHaveLength(1)
    expect(diff.entries[0]!).toMatchObject({ kind: 'role', op: 'modify', id: 'r1', name: 'Mod' })
    expect(diff.entries[0]!.changes).toEqual([{ field: 'hoist', before: true, after: false }])
  })

  test('stale id with no name match → create', () => {
    const diff = computeSpecDiff(currentSpec(), { roles: [{ id: '999999', name: 'Brand New' }] })
    expect(diff.entries).toHaveLength(1)
    expect(diff.entries[0]!).toMatchObject({ kind: 'role', op: 'create', name: 'Brand New' })
  })

  test('mixed spec: id entries and name entries route independently', () => {
    const diff = computeSpecDiff(currentSpec(), {
      roles: [
        { id: 'r1', name: 'Moderator' },          // id-match → rename
        { name: 'Member', mentionable: false },   // name-match → modify
        { name: 'Newbie' },                       // no match → create
      ],
    })
    expect(diff.entries.map(e => `${e.op}:${e.name}`)).toEqual(['modify:Member', 'create:Newbie', 'rename:Moderator'])
  })

  test('category rename keeps id-less children matched (identity, not name)', () => {
    // Under pure name-keying, renaming "Staff" would strand its children:
    // the spec's child sits under a category name no live channel has, so
    // it would read as a create (and its live twin as a prune-delete).
    const diff = computeSpecDiff(currentSpec(), {
      everyone_permissions: ['SendMessages', 'ViewChannel'],
      roles: [{ id: 'r1', name: 'Mod' }, { id: 'r2', name: 'Member' }],
      categories: [{ id: 'c1', name: 'Team Rooms', channels: [{ name: 'mod-log' }] }],
      channels: [{ id: 'c3', name: 'lobby' }],
    }, pruneOpts)
    expect(diff.entries).toHaveLength(1)
    expect(diff.entries[0]!).toMatchObject({ kind: 'category', op: 'rename', id: 'c1', name: 'Team Rooms' })
  })

  test('prune: unclaimed live ids become deletes, claimed survive', () => {
    const diff = computeSpecDiff(currentSpec(), {
      everyone_permissions: ['SendMessages', 'ViewChannel'],
      roles: [{ id: 'r1', name: 'Mod' }],
      categories: [{ id: 'c1', name: 'Staff', channels: [{ id: 'c2', name: 'mod-log' }] }],
    }, pruneOpts)
    expect(diff.entries.map(e => `${e.op}:${e.kind}:${e.name}`)).toEqual(['delete:channel:lobby', 'delete:role:Member'])
  })

  test('prune + id name-swap of two channels → two renames, zero deletes', () => {
    // Pure name-keying would read a swap as both channels drifting (or as
    // delete+create pairs under prune) — ids disambiguate.
    const state = fixtureState()
    state.channels.push({ id: 'c4', name: 'general', type: 0, parentId: 'c1', position: 1, topic: null, rateLimitPerUser: null, nsfw: false, overwrites: [] })
    const diff = computeSpecDiff(buildServerSpec(state), {
      everyone_permissions: ['SendMessages', 'ViewChannel'],
      roles: [{ id: 'r1', name: 'Mod' }, { id: 'r2', name: 'Member' }],
      categories: [{ id: 'c1', name: 'Staff', channels: [
        { id: 'c2', name: 'general' },   // was mod-log
        { id: 'c4', name: 'mod-log' },   // was general
      ] }],
      channels: [{ id: 'c3', name: 'lobby' }],
    }, pruneOpts)
    expect(diff.entries.map(e => e.op)).toEqual(['rename', 'rename'])
    expect(diff.entries.map(e => `${e.id}:${e.name}`).sort()).toEqual(['c2:general', 'c4:mod-log'])
  })

  test('never-delete: @everyone / managed / bot-own roles survive prune even when unclaimed', () => {
    // Hand-built current so the protected roles are present at all —
    // buildServerSpec already keeps managed roles and @everyone out of specs.
    const cur: ServerSpec = {
      roles: [
        { id: 'g1', name: 'everyone-ish' },   // id === guild id
        { id: 'rM', name: 'SomeBot' },        // managed
        { id: 'rB', name: 'BotsOwnRole' },    // held by the bot
        { id: 'rX', name: 'Doomed' },
      ],
    }
    const diff = computeSpecDiff(cur, {}, { prune: true, guildId: 'g1', managedRoleIds: ['rM'], botRoleIds: ['rB'] })
    expect(diff.entries.map(e => `${e.op}:${e.id}`)).toEqual(['delete:rX'])
    expect(diff.untouched).toContain('role "everyone-ish" (protected)')
    expect(diff.untouched).toContain('role "SomeBot" (protected)')
    expect(diff.untouched).toContain('role "BotsOwnRole" (protected)')
  })

  test('prune of an empty spec deletes channels → categories → roles', () => {
    const diff = computeSpecDiff(currentSpec(), {}, pruneOpts)
    expect(diff.entries.map(e => `${e.op}:${e.kind}:${e.name}`)).toEqual([
      'delete:channel:mod-log',
      'delete:channel:lobby',
      'delete:category:Staff',
      'delete:role:Mod',
      'delete:role:Member',
    ])
  })

  test('prune re-apply of an unchanged export is an empty diff (idempotent)', () => {
    const diff = computeSpecDiff(currentSpec(), currentSpec(), pruneOpts)
    expect(diff.entries).toEqual([])
  })

  test('prune:false still never deletes — unclaimed land in untouched (regression)', () => {
    const diff = computeSpecDiff(currentSpec(), {}, { guildId: 'g1', managedRoleIds: ['r3'], botRoleIds: [] })
    expect(diff.entries).toEqual([])
    expect(diff.untouched).toContain('role "Member"')
    expect(diff.untouched).toContain('channel "#lobby"')
  })
})

describe('renderSpecDiff', () => {
  test('renders creates, modifies, flags, and the untouched list', () => {
    const current = buildServerSpec(fixtureState())
    const desired: ServerSpec = {
      roles: [
        { name: 'Admin', permissions: ['Administrator'] },
        { name: 'Mod', hoist: false },
      ],
    }
    const out = renderSpecDiff(computeSpecDiff(current, desired))
    expect(out).toContain('2 change(s)')
    expect(out).toContain('⚠ 1 with dangerous grants')
    expect(out).toContain('+ role "Admin" — permissions: [Administrator]')
    expect(out).toContain('~ role "Mod" — hoist: true → false')
    expect(out).toContain('⚠ grants Administrator to new role "Admin"')
    expect(out).toContain('· left untouched (not in spec):')
    expect(out).toContain('role "Member"')
  })

  test('empty diff renders the already-matching note', () => {
    const out = renderSpecDiff({ entries: [], untouched: [] })
    expect(out).toContain('0 change(s)')
    expect(out).toContain('already matches')
  })

  test('renders rename/move/DELETE lines with a per-class header breakdown', () => {
    const current = buildServerSpec(fixtureState())
    const diff = computeSpecDiff(current, {
      roles: [{ id: 'r1', name: 'Moderator' }],
      categories: [{ id: 'c1', name: 'Staff', channels: [{ id: 'c3', name: 'lobby' }] }],
    }, { prune: true, guildId: 'g1', managedRoleIds: ['r3'], botRoleIds: [] })
    const out = renderSpecDiff(diff)
    expect(out).toContain('4 change(s) — ⚠ 2 DELETIONS · 2 renames/moves')
    expect(out).toContain('~ rename role "Mod" → "Moderator"')
    expect(out).toContain('~ move channel "#lobby": "(top-level)" → "Staff"')
    expect(out).toContain('- DELETE channel "Staff / #mod-log"')
    expect(out).toContain('- DELETE role "Member"')
  })

  test('deletions over the guard threshold add the LARGE PRUNE banner', () => {
    const current = buildServerSpec(fixtureState())
    // Full wipe: 5 deletions against 3 live channels — over the 50% bound.
    const diff = computeSpecDiff(current, {}, { prune: true, guildId: 'g1', managedRoleIds: ['r3'], botRoleIds: [] })
    expect(renderSpecDiff(diff)).toContain('⚠⚠ LARGE PRUNE: 5 deletions — review carefully')
  })

  test('a small prune has no banner', () => {
    const current = buildServerSpec(fixtureState())
    // Only lobby is unclaimed: 1 deletion, 3 live channels — under both bounds.
    const diff = computeSpecDiff(current, {
      everyone_permissions: ['SendMessages', 'ViewChannel'],
      roles: [{ id: 'r1', name: 'Mod' }, { id: 'r2', name: 'Member' }],
      categories: [{ id: 'c1', name: 'Staff', channels: [{ id: 'c2', name: 'mod-log' }] }],
    }, { prune: true, guildId: 'g1', managedRoleIds: ['r3'], botRoleIds: [] })
    const out = renderSpecDiff(diff)
    expect(out).toContain('1 change(s) — ⚠ 1 DELETION')
    expect(out).not.toContain('LARGE PRUNE')
  })
})

describe('grantGroup / removeGroup', () => {
  test('grant creates a fresh entry with empty allowFrom', () => {
    const groups: Record<string, { requireMention: boolean; allowFrom: string[] }> = {}
    grantGroup(groups, '123', true)
    expect(groups['123']).toEqual({ requireMention: true, allowFrom: [] })
  })

  test('re-grant preserves existing allowFrom (merge, not clobber)', () => {
    const groups = { '123': { requireMention: true, allowFrom: ['42', '43'] } }
    grantGroup(groups, '123', false)
    expect(groups['123']).toEqual({ requireMention: false, allowFrom: ['42', '43'] })
  })

  test('grant is idempotent', () => {
    const groups = { '123': { requireMention: true, allowFrom: ['42'] } }
    grantGroup(groups, '123', true)
    grantGroup(groups, '123', true)
    expect(groups).toEqual({ '123': { requireMention: true, allowFrom: ['42'] } })
  })

  test('grant leaves other channels alone', () => {
    const groups = { '999': { requireMention: false, allowFrom: [] } }
    grantGroup(groups, '123', true)
    expect(groups['999']).toEqual({ requireMention: false, allowFrom: [] })
  })

  test('remove deletes the entry and reports true', () => {
    const groups = { '123': { requireMention: true, allowFrom: [] } }
    expect(removeGroup(groups, '123')).toBe(true)
    expect('123' in groups).toBe(false)
  })

  test('remove of an unknown channel reports false', () => {
    expect(removeGroup({}, '123')).toBe(false)
  })
})

describe('makeTtlCache (used by /usage now that it is open to everyone)', () => {
  test('a cold cache calls the fetcher', async () => {
    const c = makeTtlCache<number>(60_000)
    let calls = 0
    expect(await c.get(async () => { calls++; return 7 }, 1000)).toBe(7)
    expect(calls).toBe(1)
  })

  test('a second call inside the TTL does NOT re-fetch', async () => {
    const c = makeTtlCache<number>(60_000)
    let calls = 0
    const f = async () => { calls++; return calls }
    await c.get(f, 1000)
    await c.get(f, 30_000)          // 29s later, still inside 60s
    await c.get(f, 60_999)          // 59.999s later, still inside
    expect(calls).toBe(1)
  })

  test('past the TTL it re-fetches', async () => {
    const c = makeTtlCache<number>(60_000)
    let calls = 0
    const f = async () => { calls++; return calls }
    expect(await c.get(f, 1000)).toBe(1)
    expect(await c.get(f, 61_001)).toBe(2)   // 60.001s later
    expect(calls).toBe(2)
  })

  // The teeth for the stampede requirement: a value-only cache passes every test above and
  // still fires N upstream requests when N users hit /usage simultaneously on a cold cache.
  test('concurrent callers on a COLD cache share ONE in-flight request', async () => {
    const c = makeTtlCache<string>(60_000)
    let calls = 0
    let release!: (v: string) => void
    const gate = new Promise<string>((r) => { release = r })
    const f = () => { calls++; return gate }

    const all = Promise.all([c.get(f, 1000), c.get(f, 1000), c.get(f, 1000), c.get(f, 1000)])
    release('shared')
    expect(await all).toEqual(['shared', 'shared', 'shared', 'shared'])
    expect(calls).toBe(1)
  })

  test('a failed fetch is NOT cached — the next caller retries', async () => {
    const c = makeTtlCache<string>(60_000)
    let calls = 0
    const f = async () => { calls++; if (calls === 1) throw new Error('boom'); return 'ok' }
    await expect(c.get(f, 1000)).rejects.toThrow('boom')
    expect(await c.get(f, 1001)).toBe('ok')   // immediately after, inside the TTL
    expect(calls).toBe(2)
  })

  test('isFresh tracks the window, clear() drops it', async () => {
    const c = makeTtlCache<number>(60_000)
    expect(c.isFresh(1000)).toBe(false)
    await c.get(async () => 1, 1000)
    expect(c.isFresh(30_000)).toBe(true)
    expect(c.isFresh(61_001)).toBe(false)
    c.clear()
    expect(c.isFresh(30_000)).toBe(false)
  })
})

describe('lookup query normalisation (every case here is a defect review found in the inline version)', () => {
  test('a Discord mention short-circuits to its id -- the commonest real input', () => {
    // Typing "#general" in a client sends the literal "<#123>", which used to return "no matches".
    expect(normalizeLookupQuery('<#1492558787561914542>')).toEqual({ text: '', id: '1492558787561914542' })
    expect(normalizeLookupQuery('<@!409669317299535903>')).toEqual({ text: '', id: '409669317299535903' })
    expect(normalizeLookupQuery('<@&1486191604183334964>')).toEqual({ text: '', id: '1486191604183334964' })
  })

  test('a bare snowflake is already the answer', () => {
    expect(normalizeLookupQuery('1492558787561914542').id).toBe('1492558787561914542')
  })

  test('TRIM runs before the #/@ strip', () => {
    // The bug: /^[#@]/ anchored against an untrimmed string does nothing, so " #general" searched for
    // "#general" literally and missed.
    expect(normalizeLookupQuery(' #general').text).toBe('general')
    expect(normalizeLookupQuery('  @barron  ').text).toBe('barron')
    expect(normalizeLookupQuery('##general').text).toBe('general')
  })

  test('junk types degrade to a harmless empty query rather than throwing', () => {
    for (const junk of [null, undefined, 42, {}, [], '#', '@', '   ']) {
      const r = normalizeLookupQuery(junk as unknown)
      expect(typeof r.text).toBe('string')
    }
    expect(normalizeLookupQuery('#').text).toBe('')
  })

  test('unicode is normalised on BOTH sides, so NFD and NFC agree', () => {
    const nfd = 'caf\u0065\u0301'   // cafe + combining acute
    const nfc = 'caf\u00e9'          // precomposed
    expect(lookupNameMatches(nfd, normalizeLookupQuery(nfc).text)).toBe(true)
    expect(lookupNameMatches(nfc, normalizeLookupQuery(nfd).text)).toBe(true)
  })

  test('the query is a substring, never a regex', () => {
    expect(lookupNameMatches('general', normalizeLookupQuery('.*').text)).toBe(false)
    expect(lookupNameMatches('a.b', normalizeLookupQuery('a.b').text)).toBe(true)
  })

  test('limit is clamped to a WHOLE number in range', () => {
    // 2.7 survived the old clamp and reached Discord as ?limit=2.7, which it rejects -- surfaced to the
    // caller as a misleading "member search unavailable".
    expect(clampLookupLimit(2.7)).toBe(2)
    expect(clampLookupLimit(999)).toBe(50)
    expect(clampLookupLimit(0)).toBe(10)
    expect(clampLookupLimit(-5)).toBe(10)
    // Infinity is junk, not "give me the max" -- it falls back like 'abc' and -5 do. The old inline
    // clamp returned 50 here via Math.min; treating all junk the same way is the more defensible rule.
    expect(clampLookupLimit(Infinity)).toBe(10)
    expect(clampLookupLimit('abc')).toBe(10)
    expect(clampLookupLimit(undefined)).toBe(10)
  })

  test('exact names rank above substring matches', () => {
    const q = normalizeLookupQuery('rust').text
    expect(lookupRank('rust', q)).toBe(0)
    expect(lookupRank('rustbot', q)).toBe(1)
    const names = ['rustbot', 'rust', 'trusty']
    names.sort((a, b) => lookupRank(a, q) - lookupRank(b, q) || a.localeCompare(b))
    expect(names[0]).toBe('rust')
  })
})

// ── DM access (/access user:@someone) ──
// The owner asked for /access to authorise DM conversations as well as channels (2026-08-21). The
// handler is owner-gated in server.ts; what is testable is the state transition, so that is what these
// pin. Mirrors the grantGroup/removeGroup tests above.
// ── server-wide (guild) grants ──
// Snowflakes: guild G1 holds channels C_LISTED (own entry), C_NEW (no entry, e.g. created after the
// grant) and thread T (parent C_NEW). G2 is a guild nobody granted, holding C_OTHER.
const G1 = '1000000000000000001', G2 = '1000000000000000002'
const C_LISTED = '2000000000000000001', C_NEW = '2000000000000000002', C_OTHER = '2000000000000000003'
const T = '3000000000000000001', T_UNDER_LISTED = '3000000000000000002'
const ALICE = '4000000000000000001', BOB = '4000000000000000002'

const chan = (id: string, guildId: string | null) => ({ id, isThread: false, parentId: null, guildId })
const thread = (id: string, parentId: string, guildId: string) => ({ id, isThread: true, parentId, guildId })

describe('parseAccess — a pre-0.8.5 access.json has no `guilds` key', () => {
  const OLD = JSON.stringify({
    dmPolicy: 'allowlist',
    allowFrom: [ALICE],
    groups: { [C_LISTED]: { requireMention: false, allowFrom: [] } },
    pending: {},
    ackReaction: '👀',
  })

  test('parses, keeps every field it had, and gains an empty guilds map', () => {
    const a = parseAccess(OLD)
    expect(a.dmPolicy).toBe('allowlist')
    expect(a.allowFrom).toEqual([ALICE])
    expect(a.groups).toEqual({ [C_LISTED]: { requireMention: false, allowFrom: [] } })
    expect(a.ackReaction).toBe('👀')
    expect(a.guilds).toEqual({})
  })

  test('behaves exactly as before: its listed channel resolves, an unlisted one in the same guild does not', () => {
    const a = parseAccess(OLD)
    expect(resolveChannelPolicy(a, chan(C_LISTED, G1))?.source).toBe('channel')
    expect(resolveChannelPolicy(a, chan(C_NEW, G1))).toBeUndefined()
    expect(channelAllowed(a, chan(C_NEW, G1))).toBe(false)
  })

  test('a hand-edited `"guilds": null` does not crash resolution or the outbound check', () => {
    const a = parseAccess(JSON.stringify({ groups: {}, guilds: null }))
    expect(resolveChannelPolicy(a, chan(C_NEW, G1))).toBeUndefined()
    expect(channelAllowed(a, chan(C_NEW, G1))).toBe(false)
  })

  test('a file that omits groups too still parses (defaults fill it)', () => {
    const a = parseAccess('{}')
    expect(a).toEqual(defaultAccess())
    expect(defaultAccess().guilds).toEqual({})
  })

  test('the server-scope grant path works on a parsed old file (guilds ??= {} then grantGroup)', () => {
    const a = parseAccess(OLD)
    delete a.guilds   // worst case: the key really is absent at grant time
    a.guilds ??= {}
    grantGroup(a.guilds, G1, true)
    expect(channelAllowed(a, chan(C_NEW, G1))).toBe(true)
    expect(removeGroup(a.guilds, G1)).toBe(true)
    expect(channelAllowed(a, chan(C_NEW, G1))).toBe(false)
  })
})

describe('resolveChannelPolicy — channel entry, then guild fallback', () => {
  const access = {
    groups: { [C_LISTED]: { requireMention: false, allowFrom: [] } },
    guilds: { [G1]: { requireMention: true, allowFrom: [ALICE] } },
  }

  test('a channel with its own entry resolves to it — and it WINS over its guild entry', () => {
    const r = resolveChannelPolicy(access, chan(C_LISTED, G1))
    expect(r).toEqual({ policy: { requireMention: false, allowFrom: [] }, source: 'channel', key: C_LISTED })
  })

  test('a channel with no entry in a granted guild falls back to the guild entry', () => {
    const r = resolveChannelPolicy(access, chan(C_NEW, G1))
    expect(r).toEqual({ policy: { requireMention: true, allowFrom: [ALICE] }, source: 'guild', key: G1 })
  })

  test('a channel in a guild nobody granted resolves to nothing', () => {
    expect(resolveChannelPolicy(access, chan(C_OTHER, G2))).toBeUndefined()
  })

  test('no guildId (DM-shaped) never reaches the guild map', () => {
    expect(resolveChannelPolicy(access, chan(C_NEW, null))).toBeUndefined()
  })

  test('a thread in a granted guild, under an unlisted parent, gets the guild entry', () => {
    const r = resolveChannelPolicy(access, thread(T, C_NEW, G1))
    expect(r?.source).toBe('guild')
    expect(r?.key).toBe(G1)
  })

  test('a thread under a LISTED parent gets the parent entry, not the guild one', () => {
    const r = resolveChannelPolicy(access, thread(T_UNDER_LISTED, C_LISTED, G1))
    expect(r?.source).toBe('channel')
    expect(r?.key).toBe(C_LISTED)
  })

  test('a thread whose parentId is unknown falls back to its own id, then the guild', () => {
    const r = resolveChannelPolicy(access, { id: T, isThread: true, parentId: null, guildId: G1 })
    expect(r?.source).toBe('guild')
  })

  test('the guild map is own-property only — a prototype key is not a grant', () => {
    expect(resolveChannelPolicy({ groups: {}, guilds: {} }, chan(C_NEW, 'constructor'))).toBeUndefined()
  })
})

describe('groupGateVerdict — the guild entry is applied exactly as a channel entry', () => {
  test('no policy drops', () => {
    expect(groupGateVerdict(undefined, ALICE)).toBe('drop')
  })

  test("guild allowFrom is honoured: a sender outside it is dropped, one inside it proceeds", () => {
    const access = { groups: {}, guilds: { [G1]: { requireMention: false, allowFrom: [ALICE] } } }
    const p = resolveChannelPolicy(access, chan(C_NEW, G1))?.policy
    expect(groupGateVerdict(p, BOB)).toBe('drop')
    expect(groupGateVerdict(p, ALICE)).toBe('deliver')
  })

  test('guild requireMention is honoured: true -> needs-mention, false -> deliver, absent -> needs-mention', () => {
    const on = { groups: {}, guilds: { [G1]: { requireMention: true, allowFrom: [] } } }
    const off = { groups: {}, guilds: { [G1]: { requireMention: false, allowFrom: [] } } }
    const absent = { groups: {}, guilds: { [G1]: { allowFrom: [] } as unknown as { requireMention: boolean; allowFrom: string[] } } }
    expect(groupGateVerdict(resolveChannelPolicy(on, chan(C_NEW, G1))?.policy, BOB)).toBe('needs-mention')
    expect(groupGateVerdict(resolveChannelPolicy(off, chan(C_NEW, G1))?.policy, BOB)).toBe('deliver')
    expect(groupGateVerdict(resolveChannelPolicy(absent, chan(C_NEW, G1))?.policy, BOB)).toBe('needs-mention')
  })

  test('a channel entry wins: the guild restricts to ALICE, the channel is open, BOB gets through only there', () => {
    const access = {
      groups: { [C_LISTED]: { requireMention: false, allowFrom: [] } },
      guilds: { [G1]: { requireMention: false, allowFrom: [ALICE] } },
    }
    expect(groupGateVerdict(resolveChannelPolicy(access, chan(C_LISTED, G1))?.policy, BOB)).toBe('deliver')
    expect(groupGateVerdict(resolveChannelPolicy(access, chan(C_NEW, G1))?.policy, BOB)).toBe('drop')
  })

  test('a channel entry wins the other way too: a stricter channel inside an open guild', () => {
    const access = {
      groups: { [C_LISTED]: { requireMention: true, allowFrom: [ALICE] } },
      guilds: { [G1]: { requireMention: false, allowFrom: [] } },
    }
    expect(groupGateVerdict(resolveChannelPolicy(access, chan(C_LISTED, G1))?.policy, BOB)).toBe('drop')
    expect(groupGateVerdict(resolveChannelPolicy(access, chan(C_NEW, G1))?.policy, BOB)).toBe('deliver')
  })

  test('a thread in a granted guild is gated by the guild entry', () => {
    const access = { groups: {}, guilds: { [G1]: { requireMention: false, allowFrom: [ALICE] } } }
    const p = resolveChannelPolicy(access, thread(T, C_NEW, G1))?.policy
    expect(groupGateVerdict(p, ALICE)).toBe('deliver')
    expect(groupGateVerdict(p, BOB)).toBe('drop')
  })

  test('the channel-only path is unchanged (regression)', () => {
    const access = { groups: { [C_LISTED]: { requireMention: true, allowFrom: [] } } }
    expect(groupGateVerdict(resolveChannelPolicy(access, chan(C_LISTED, G1))?.policy, BOB)).toBe('needs-mention')
    expect(groupGateVerdict(resolveChannelPolicy(access, chan(C_NEW, G1))?.policy, BOB)).toBe('drop')
  })
})

describe('channelAllowed — the outbound check (reply/react/edit/fetch go through it)', () => {
  const access = {
    groups: { [C_LISTED]: { requireMention: true, allowFrom: [] } },
    guilds: { [G1]: { requireMention: true, allowFrom: [ALICE] } },
  }

  test('allows a channel covered only by a guild grant', () => {
    expect(channelAllowed(access, chan(C_NEW, G1))).toBe(true)
  })

  test('allows a thread in a guild-granted server', () => {
    expect(channelAllowed(access, thread(T, C_NEW, G1))).toBe(true)
  })

  test('a guild entry with a sender filter is still a valid TARGET — allowFrom is an inbound rule', () => {
    expect(channelAllowed({ groups: {}, guilds: { [G1]: { requireMention: true, allowFrom: [ALICE] } } }, chan(C_NEW, G1))).toBe(true)
  })

  test('still allows a listed channel and refuses one in an ungranted guild', () => {
    expect(channelAllowed(access, chan(C_LISTED, G1))).toBe(true)
    expect(channelAllowed(access, chan(C_OTHER, G2))).toBe(false)
    expect(channelAllowed(access, thread(T, C_OTHER, G2))).toBe(false)
  })

  test('inbound and outbound agree on every case above (one rule, not two)', () => {
    for (const ch of [chan(C_LISTED, G1), chan(C_NEW, G1), chan(C_OTHER, G2), thread(T, C_NEW, G1), thread(T, C_OTHER, G2), chan(C_NEW, null)]) {
      expect(channelAllowed(access, ch)).toBe(resolveChannelPolicy(access, ch) !== undefined)
    }
  })
})

describe('grantDm / removeDm', () => {
  test('grant adds the user to allowFrom', () => {
    const allow: string[] = []
    expect(grantDm(allow, {}, '42')).toBe(true)
    expect(allow).toEqual(['42'])
  })

  test('re-granting is a no-op and reports it, rather than duplicating', () => {
    const allow = ['42']
    expect(grantDm(allow, {}, '42')).toBe(false)
    expect(allow).toEqual(['42'])   // not ['42','42'] -- a dupe would survive one remove
  })

  test('granting CLEARS that user pending pairing code, but leaves other people alone', () => {
    const allow: string[] = []
    const pending: Record<string, { senderId: string }> = { aaa: { senderId: '42' }, bbb: { senderId: '99' } }
    grantDm(allow, pending, '42')
    expect(pending).toEqual({ bbb: { senderId: '99' } })
  })

  test('remove takes them back out', () => {
    const allow = ['42', '43']
    expect(removeDm(allow, '42')).toBe(true)
    expect(allow).toEqual(['43'])
  })

  test('removing someone who never had access reports false and changes nothing', () => {
    const allow = ['43']
    expect(removeDm(allow, '42')).toBe(false)
    expect(allow).toEqual(['43'])
  })

  test('grant then remove is a round trip -- no residue in allowFrom or pending', () => {
    const allow: string[] = []
    const pending: Record<string, { senderId: string }> = { aaa: { senderId: '42' } }
    grantDm(allow, pending, '42')
    removeDm(allow, '42')
    expect(allow).toEqual([])
    expect(pending).toEqual({})   // the code stays cleared; revoking access does not resurrect it
  })
})

// ── resolveById ──
// The bug: lookup read users.cache and stopped. A member who had never spoken was not in it, so a real
// user in a guild the bot is in reported as "not a user this bot can see" — a claim about Discord derived
// from local memory. I believed that line and told the owner twice that he and his brother shared no
// server with me. He posted once and the same lookup resolved instantly.
//
// The FIRST fix then reintroduced the same bug one layer down by catching every throw and calling it
// "does not exist" — so the error/absence split below is the point, not a detail.
describe('resolveById', () => {
  const hit = { id: '1', username: 'cached' }
  const fetched = { id: '2', username: 'fetched' }
  const apiErr = (code: number, status: number, message: string) => Object.assign(new Error(message), { code, status })

  test('a cache hit is used and the API is NOT called', async () => {
    let fetches = 0
    const r = await resolveById(() => hit, async () => { fetches++; return fetched }, '1')
    expect(r).toEqual({ user: hit, source: 'cache' })
    expect(fetches).toBe(0)   // the cache stays the fast path; this must not add a round-trip per lookup
  })

  test('a cache MISS falls back to the API — the original bug', async () => {
    const r = await resolveById(() => undefined, async () => fetched, '2')
    expect(r).toEqual({ user: fetched, source: 'fetch' })
  })

  test('the id is threaded through to BOTH stubs, not dropped', async () => {
    // The signature puts `id` last, which is easy to mis-wire; every stub ignoring its argument would
    // let an implementation calling fetchOne(undefined) pass every other test in this block.
    let sawCache: string | undefined, sawFetch: string | undefined
    await resolveById((id) => { sawCache = id; return undefined }, async (id) => { sawFetch = id; return fetched }, '424242')
    expect(sawCache).toBe('424242')
    expect(sawFetch).toBe('424242')
  })

  test('10013 Unknown User is an honest negative', async () => {
    const r = await resolveById(() => undefined, async () => { throw apiErr(10013, 404, 'Unknown User') }, '9')
    expect(r).toEqual({ user: undefined, source: 'none' })
  })

  test('a 404 with no code is also a negative', async () => {
    const r = await resolveById(() => undefined, async () => { throw Object.assign(new Error('Not Found'), { status: 404 }) }, '9')
    expect(r.source).toBe('none')
  })

  test('a 500 is NOT a negative — it is an error, and must not claim nonexistence', async () => {
    // The regression test for the first fix's defect: this returned source:'none' and the caller
    // printed "no user with that id exists" off a server error.
    const r = await resolveById(() => undefined, async () => { throw apiErr(0, 500, 'Internal Server Error') }, '9')
    expect(r.source).toBe('error')
    expect(r.error).toContain('Internal Server Error')
  })

  test('a network stall / abort is an error, not a negative', async () => {
    const r = await resolveById(() => undefined, async () => { throw new Error('The operation was aborted') }, '9')
    expect(r.source).toBe('error')
  })

  test('a 401 (dead token) is an error — every lookup must not start asserting nonexistence', async () => {
    const r = await resolveById(() => undefined, async () => { throw apiErr(0, 401, 'Unauthorized') }, '9')
    expect(r.source).toBe('error')
  })

  test('never rejects — lookup has to answer', async () => {
    await expect(resolveById(() => undefined, async () => { throw new Error('boom') }, '9')).resolves.toBeDefined()
  })
})

// ── planRolePositions ──
// The pure core of role reordering. Every case below names the defect it pins; the
// facts they encode were measured against a live guild, not inferred from docs.
describe('planRolePositions', () => {
  // LSS as it actually stands. tinyclaw (the bot) is the top role, so everything
  // under it is movable and @everyone is pinned at raw 0.
  const EVERYONE = '1', TINYCLAW = '500', OWNER = '400', BOT = '300', MOD = '100', LODE = '200'
  const lss = (): RolePositionInput[] => [
    { id: EVERYONE, name: '@everyone', rawPosition: 0, managed: false },
    { id: LODE, name: 'Lodestone', rawPosition: 1, managed: false },
    { id: MOD, name: 'Moderator', rawPosition: 2, managed: false },
    { id: BOT, name: 'Bot', rawPosition: 3, managed: false },
    { id: OWNER, name: 'Owner', rawPosition: 4, managed: false },
    { id: TINYCLAW, name: 'tinyclaw', rawPosition: 5, managed: true },
  ]
  const ctx = { botHighestRoleId: TINYCLAW, everyoneRoleId: EVERYONE }
  const ok = (p: ReturnType<typeof planRolePositions>) => {
    if ('refusal' in p) throw new Error(`expected a plan, got refusal ${JSON.stringify(p.refusal)}`)
    return p
  }
  const refusal = (p: ReturnType<typeof planRolePositions>) => {
    if (!('refusal' in p)) throw new Error(`expected a refusal, got ${JSON.stringify(p.writes)}`)
    return p.refusal
  }
  /** highest-first names, read back out of a writes[] body */
  const orderOf = (roles: RolePositionInput[], writes: Array<{ id: string; position: number }>) =>
    [...writes].sort((a, b) => b.position - a.position).map(w => roles.find(r => r.id === w.id)!.name)

  test('an ALREADY-SATISFIED constraint set emits zero writes — and an unsatisfied one does not', () => {
    // Paired deliberately: a planner that returned [] unconditionally would pass the
    // first half on its own, and "no writes" is exactly the shape of the original bug
    // (apply reporting "0 changes" for a reorder it never compared).
    const satisfied = ok(planRolePositions(lss(), [{ id: OWNER, above: [MOD] }], ctx))
    expect(satisfied.writes).toEqual([])

    const unsatisfied = ok(planRolePositions(lss(), [{ id: LODE, above: [OWNER] }], ctx))
    expect(unsatisfied.writes.length).toBeGreaterThan(0)
  })

  test('no constraints at all is a fixpoint — the toposort does not reshuffle free roles', () => {
    // Kahn with an unordered ready-set gives ANY valid topological order, so a guild
    // with no constraints would get shuffled and written back for no reason. The
    // priority queue keyed by current rank is what makes this hold.
    expect(ok(planRolePositions(lss(), [], ctx)).writes).toEqual([])
  })

  test('the write body is COMPLETE and contiguous, because a partial one is advisory', () => {
    // Measured: a one-entry body asking for position 3 landed at 2. Only a complete
    // body is honoured verbatim, and Discord densifies it regardless of what we send.
    const plan = ok(planRolePositions(lss(), [{ id: LODE, above: [OWNER] }], ctx))
    expect(plan.writes.length).toBe(6)                       // every role, not just the moved one
    expect(plan.writes.map(w => w.position).sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5])
    expect(orderOf(lss(), plan.writes)).toEqual(['tinyclaw', 'Lodestone', 'Owner', 'Bot', 'Moderator', '@everyone'])
  })

  test('@everyone stays at position 0 and the frozen ceiling stays on top', () => {
    const plan = ok(planRolePositions(lss(), [{ id: LODE, above: [OWNER] }], ctx))
    expect(plan.writes.find(w => w.id === EVERYONE)!.position).toBe(0)
    expect(plan.writes.find(w => w.id === TINYCLAW)!.position).toBe(5)
    expect(plan.frozen).toEqual([TINYCLAW, EVERYONE])
  })

  test('frozen roles are EMITTED but never moved', () => {
    // They have to be in the body — Discord only honours a complete one — but the
    // bot cannot move a role at or above its own, so their order is carried through
    // untouched rather than being planned around.
    const plan = ok(planRolePositions(lss(), [{ id: LODE, above: [OWNER] }], ctx))
    const live = lss()
    for (const id of plan.frozen) {
      const before = live.find(r => r.id === id)!.rawPosition
      expect(plan.writes.find(w => w.id === id)!.position).toBe(before)
    }
  })

  test('a constraint naming a role above the ceiling REFUSES and names it', () => {
    // The two-sided gate: source AND destination must rank below the bot's highest.
    // Discord answers this with a bare 50013 that says nothing about which role blocked.
    const r = refusal(planRolePositions(lss(), [{ id: OWNER, above: [TINYCLAW] }], ctx))
    expect(r.kind).toBe('frozen')
    expect((r as { blockingRoleIds: string[] }).blockingRoleIds).toContain(TINYCLAW)
  })

  test('a constraint naming @everyone refuses rather than silently doing nothing', () => {
    const r = refusal(planRolePositions(lss(), [{ id: MOD, below: [EVERYONE] }], ctx))
    expect(r.kind).toBe('frozen')
    expect((r as { blockingRoleIds: string[] }).blockingRoleIds).toContain(EVERYONE)
  })

  test('a cycle refuses, and carries NO ceiling field to fabricate', () => {
    // The refusal is a discriminated union precisely so this case cannot be forced to
    // invent a number: a ceiling is meaningful for a frozen refusal and meaningless here.
    const r = refusal(planRolePositions(lss(), [{ id: MOD, above: [BOT] }, { id: BOT, above: [MOD] }], ctx))
    expect(r.kind).toBe('cycle')
    expect(r).not.toHaveProperty('ceiling')
    expect((r as { roleIds: string[] }).roleIds.sort()).toEqual([MOD, BOT].sort())
  })

  test('one statement naming the same role above AND below itself is a contradiction, not a cycle', () => {
    // Reported separately because a cycle refusal names a path; this names the sentence.
    const r = refusal(planRolePositions(lss(), [{ id: MOD, above: [BOT], below: [BOT] }], ctx))
    expect(r.kind).toBe('contradiction')
    expect((r as { roleIds: string[] }).roleIds).toContain(BOT)
  })

  test('an unknown role id refuses before anything else looks at it', () => {
    const r = refusal(planRolePositions(lss(), [{ id: MOD, above: ['999999'] }], ctx))
    expect(r.kind).toBe('unknown-role')
    expect((r as { ids: string[] }).ids).toContain('999999')
  })

  test('a fully TIED guild is ordered by snowflake, older role higher', () => {
    // The motivating case: a fresh guild has every role at raw 1, which discord.js's
    // Role.position renders as a tidy 3/2/1 and the export used to report as fact.
    const tied: RolePositionInput[] = [
      { id: '1', name: '@everyone', rawPosition: 0, managed: false },
      { id: '900', name: 'Newest', rawPosition: 1, managed: false },
      { id: '700', name: 'Middle', rawPosition: 1, managed: false },
      { id: '500', name: 'BotRole', rawPosition: 1, managed: true },
    ]
    const plan = ok(planRolePositions(tied, [{ id: '900', above: ['700'] }], { botHighestRoleId: '500', everyoneRoleId: '1' }))
    expect(orderOf(tied, plan.writes)).toEqual(['BotRole', 'Newest', 'Middle', '@everyone'])
  })

  test('the tie-break is BigInt: a 19-digit id does not outrank an older 18-digit one', () => {
    const mixed: RolePositionInput[] = [
      { id: '1', name: '@everyone', rawPosition: 0, managed: false },
      { id: '1000000000000000000', name: 'Newer19', rawPosition: 1, managed: false },
      { id: '999999999999999999', name: 'Older18', rawPosition: 1, managed: false },
      { id: '111111111111111111', name: 'BotRole', rawPosition: 2, managed: true },
    ]
    // A constraint that forces a WRITE without saying anything about the tied pair, so the emitted
    // order has to reveal how the tie was broken. The first version of this test passed zero
    // constraints, which made it a fixpoint under any tie-break at all: it compared the sort against
    // itself and stayed green with localeCompare substituted in.
    // Mover's id is the LARGEST of the three tied at raw 1, so it starts BELOW both and the
    // constraint genuinely forces a write. It names only Older18, so nothing dictates where Newer19
    // lands relative to Older18 -- the emitted order has to reveal how the tie was broken.
    mixed.push({ id: '1100000000000000000', name: 'Mover', rawPosition: 1, managed: false })
    const plan = ok(planRolePositions(mixed, [{ id: '1100000000000000000', above: ['999999999999999999'] }],
      { botHighestRoleId: '111111111111111111', everyoneRoleId: '1' }))
    expect(plan.writes.length).toBeGreaterThan(0)
    expect(orderOf(mixed, plan.writes)).toEqual(['BotRole', 'Mover', 'Older18', 'Newer19', '@everyone'])
  })

  test("VoX's actual request: put Owner above Moderator, and Bot between them", () => {
    const plan = ok(planRolePositions(lss(), [{ id: OWNER, above: [BOT] }, { id: BOT, above: [MOD] }], ctx))
    expect(plan.writes).toEqual([])   // already true on LSS today, and saying so beats writing
  })

  test('a NEW role placed between two existing ones moves only itself', () => {
    // The pending live request: add "VSS Maintainer" directly below the top role and
    // above Bot. A new role lands at the bottom (raw 1, tied), so it has to travel --
    // but nothing else should. This is the case that exposed the rebuild-from-graph
    // implementation: it satisfied both clauses while hoisting Moderator and Lodestone
    // over the new role AND sinking Bot to the floor.
    const VSS = '600'
    const withNew = [...lss(), { id: VSS, name: 'VSS Maintainer', rawPosition: 1, managed: false }]
    const plan = ok(planRolePositions(withNew, [{ id: VSS, below: [OWNER], above: [BOT] }], ctx))
    expect(orderOf(withNew, plan.writes))
      .toEqual(['tinyclaw', 'Owner', 'VSS Maintainer', 'Bot', 'Moderator', 'Lodestone', '@everyone'])
  })

  test('everything not named keeps its neighbours, not merely its relative order', () => {
    // "Relative order preserved" is satisfiable by an answer that still drags every
    // uninvolved role across the guild. Pin the stronger property: one constraint,
    // one role changes rank.
    const before = ['tinyclaw', 'Owner', 'Bot', 'Moderator', 'Lodestone', '@everyone']
    const plan = ok(planRolePositions(lss(), [{ id: LODE, above: [MOD] }], ctx))
    const after = orderOf(lss(), plan.writes)
    expect(after).toEqual(['tinyclaw', 'Owner', 'Bot', 'Lodestone', 'Moderator', '@everyone'])
    const moved = after.filter((n, i) => n !== before[i])
    expect(moved.sort()).toEqual(['Lodestone', 'Moderator'])   // the pair that swapped, and nothing else
  })
})


// ── the chain case, which is the one the first repair implementation got backwards ──
describe('planRolePositions — chains and multi-subject sets', () => {
  const mk = (names: Array<[string, string, number]>, managedId: string): RolePositionInput[] =>
    names.map(([id, name, raw]) => ({ id, name, rawPosition: raw, managed: id === managedId }))
  const plan = (roles: RolePositionInput[], cs: Array<{ id: string; above?: string[]; below?: string[] }>) =>
    planRolePositions(roles, cs, { botHighestRoleId: '500', everyoneRoleId: '1' })
  const order = (roles: RolePositionInput[], p: ReturnType<typeof planRolePositions>) => {
    if ('refusal' in p) return `REFUSED:${p.refusal.kind}`
    if (p.writes.length === 0) return 'NO-WRITE'
    return [...p.writes].sort((a, b) => b.position - a.position).map(w => roles.find(r => r.id === w.id)!.name).join(' > ')
  }

  test("a clause naming ANOTHER SUBJECT is honoured — VoX's own request, which came out inverted", () => {
    // "Owner above Bot" + "Bot above Moderator". The first implementation lifted every subject out of
    // the list and re-inserted them in topological order, so when Owner was placed, Bot was not on the
    // board, indexOf returned -1, and the clause was SILENTLY DROPPED. Result: Owner below Moderator,
    // the exact inverse of the request, reported as success.
    const roles = mk([['1', '@everyone', 0], ['200', 'Lodestone', 1], ['400', 'Owner', 2],
                      ['300', 'Bot', 3], ['100', 'Moderator', 4], ['500', 'tinyclaw', 5]], '500')
    expect(order(roles, plan(roles, [{ id: '400', above: ['300'] }, { id: '300', above: ['100'] }])))
      .toBe('tinyclaw > Owner > Bot > Moderator > Lodestone > @everyone')
  })

  test('the same request phrased with `below` gives the same answer', () => {
    // The direction the user phrases it in must not decide whether the constraint is honoured. Under
    // the first implementation it did: `below` happened to work because its target was placed earlier.
    const roles = mk([['1', '@everyone', 0], ['200', 'Lodestone', 1], ['400', 'Owner', 2],
                      ['300', 'Bot', 3], ['100', 'Moderator', 4], ['500', 'tinyclaw', 5]], '500')
    expect(order(roles, plan(roles, [{ id: '300', below: ['400'] }, { id: '100', below: ['300'] }])))
      .toBe('tinyclaw > Owner > Bot > Moderator > Lodestone > @everyone')
  })

  test('a three-link chain against a fully reversed guild', () => {
    const roles = mk([['1', '@everyone', 0], ['100', 'A', 1], ['200', 'B', 2],
                      ['300', 'C', 3], ['400', 'D', 4], ['500', 'bot', 9]], '500')
    expect(order(roles, plan(roles, [{ id: '100', above: ['200'] }, { id: '200', above: ['300'] }, { id: '300', above: ['400'] }])))
      .toBe('bot > A > B > C > D > @everyone')
  })

  test('a satisfiable set is NOT refused as a contradiction', () => {
    // The window used to be computed against non-subjects only, and non-subjects never move -- so a
    // set that needed one of them to shift was reported as clauses that "cannot all hold at once".
    // 14% of random satisfiable sets hit it; it needs one constraint and three roles.
    const roles = mk([['1', '@everyone', 0], ['400', 'Admin', 1], ['300', 'Owner', 2],
                      ['100', 'Moderator', 3], ['500', 'tinyclaw', 5]], '500')
    expect(order(roles, plan(roles, [{ id: '300', above: ['100'], below: ['400'] }])))
      .toBe('tinyclaw > Admin > Owner > Moderator > @everyone')
  })

  test('a cycle refusal names only the roles IN the cycle', () => {
    // Kahn leaves behind the cycle AND everything downstream, and reporting the lot tells the owner
    // that roles with no cyclic clause "form a cycle".
    const roles = mk([['1', '@everyone', 0], ['100', 'A', 1], ['200', 'B', 2],
                      ['300', 'C', 3], ['400', 'D', 4], ['500', 'bot', 9]], '500')
    const p = plan(roles, [{ id: '100', above: ['200'] }, { id: '200', above: ['100'] }, { id: '300', above: ['400'] }, { id: '400', above: ['100'] }])
    if (!('refusal' in p)) throw new Error('expected a refusal')
    expect(p.refusal.kind).toBe('cycle')
    expect(((p.refusal as { roleIds: string[] }).roleIds).sort()).toEqual(['100', '200'])
  })

  test('an unknown role is reported once, not once per mention', () => {
    const roles = mk([['1', '@everyone', 0], ['100', 'A', 1], ['500', 'bot', 9]], '500')
    const p = plan(roles, [{ id: '100', above: ['999'], below: ['999'] }])
    if (!('refusal' in p)) throw new Error('expected a refusal')
    expect((p.refusal as { ids: string[] }).ids).toEqual(['999'])
  })

  test('frozen roles keep their EXACT raw position, on a guild with gaps', () => {
    // Gaps are the normal state after any delete. Numbering everything contiguously renumbered the
    // roles above the ceiling -- and the only measured fact about those is that MOVING one is 50013.
    const roles = mk([['1', '@everyone', 0], ['100', 'Low', 1], ['200', 'Mid', 4],
                      ['300', 'High', 7], ['500', 'bot', 9], ['600', 'Above', 12]], '500')
    const p = plan(roles, [{ id: '100', above: ['200'] }])
    if ('refusal' in p) throw new Error('expected a plan')
    expect(p.writes.find(w => w.id === '600')!.position).toBe(12)   // foreign role above the ceiling
    expect(p.writes.find(w => w.id === '500')!.position).toBe(9)    // the bot's own
    expect(p.writes.find(w => w.id === '1')!.position).toBe(0)      // @everyone stays pinned
    expect([...p.writes].sort((a, b) => b.position - a.position).map(w => roles.find(r => r.id === w.id)!.name))
      .toEqual(['Above', 'bot', 'High', 'Low', 'Mid', '@everyone'])
  })

  test('roles the spec CREATES are projected in creation order, not reversed', () => {
    // Discord assigns ascending snowflakes and the smaller id ranks HIGHER, so the first role created
    // lands above the second. The projection used descending placeholders and had them backwards --
    // which made a spec whose two new roles constrain each other look already-satisfied, emit no
    // ordering entry, and report success on a spec it had not satisfied.
    const state = fixtureState()
    const diff = computeSpecDiff(buildServerSpec(state), {
      roles: [{ name: 'Alpha' }, { name: 'Beta', above: 'Alpha' }],
    }, {
      guildId: 'g1', botHighestRoleId: 'r3',
      allRoles: [{ id: 'g1', name: '@everyone', rawPosition: 0, managed: false },
                 ...state.roles.map(r => ({ id: r.id, name: r.name, rawPosition: r.rawPosition, managed: r.managed }))],
    })
    const ord = diff.entries.find(e => e.kind === 'ordering')
    expect(ord).toBeDefined()   // Beta must be lifted above Alpha; "already satisfied" is the bug
    const after = ord!.ordering!.after.map(r => r.name)
    expect(after.indexOf('Beta')).toBeLessThan(after.indexOf('Alpha'))
  })
})

// ── dangerousReorder ──
describe('dangerousReorder via computeSpecDiff', () => {
  const guild = (): RawGuildState => ({
    guildId: 'g1', everyonePermissions: [], channels: [],
    roles: [
      { id: '100', name: 'Peon', hexColor: '#000000', hoist: false, mentionable: false, permissions: [], position: 1, rawPosition: 1, managed: false },
      { id: '200', name: 'Admin', hexColor: '#000000', hoist: false, mentionable: false, permissions: ['Administrator'], position: 2, rawPosition: 2, managed: false },
      { id: '300', name: 'bot', hexColor: '#000000', hoist: false, mentionable: false, permissions: [], position: 3, rawPosition: 3, managed: true },
    ],
  })
  const opts = () => ({
    guildId: 'g1', botHighestRoleId: '300',
    allRoles: [{ id: 'g1', name: '@everyone', rawPosition: 0, managed: false },
               ...guild().roles.map(r => ({ id: r.id, name: r.name, rawPosition: r.rawPosition, managed: r.managed }))],
  })

  test('a PARTIAL spec still warns when a role is lifted over an Administrator holder', () => {
    // The check read permissions from the SPEC only. apply_server_spec is additive, so the ordinary
    // partial spec -- exactly the shape the tool description advertises -- restates nobody's
    // permissions, every role reads as harmless, and the owner's approval DM showed NO warning while
    // a role was lifted over an Administrator holder. The live permissions were in `current` all along.
    const diff = computeSpecDiff(buildServerSpec(guild()), { roles: [{ name: 'Peon', above: 'Admin' }] }, opts())
    const ord = diff.entries.find(e => e.kind === 'ordering')!
    expect(ord.dangerous.join(' ')).toContain('"Peon" now ranks above "Admin"')
  })

  test('a role that keeps its INDEX but crosses an Administrator holder is still flagged', () => {
    // The first version used the absolute index delta as a proxy for "gained rank"; a role can keep
    // its index and still cross another role, and it was the role the user actually named.
    const state = guild()
    state.roles.push({ id: '050', name: 'Third', hexColor: '#000000', hoist: false, mentionable: false, permissions: [], position: 0, rawPosition: 0, managed: false })
    const o = { ...opts(), allRoles: [{ id: 'g1', name: '@everyone', rawPosition: 0, managed: false },
                                      ...state.roles.map(r => ({ id: r.id, name: r.name, rawPosition: r.rawPosition, managed: r.managed }))] }
    const diff = computeSpecDiff(buildServerSpec(state), { roles: [{ name: 'Third', above: 'Admin' }] }, o)
    const ord = diff.entries.find(e => e.kind === 'ordering')!
    expect(ord.dangerous.join(' ')).toContain('"Third" now ranks above "Admin"')
  })
})


// ── resolveOrderingConstraints (§5a) ──
// Zero tests before this, on the exact bug class §5a exists to prevent: both the ambiguous-name and
// the zero-match paths could be turned into a silent pick-first / silent skip and the suite stayed green.
describe('resolveOrderingConstraints', () => {
  const roles: RolePositionInput[] = [
    { id: '1', name: '@everyone', rawPosition: 0, managed: false },
    { id: '100', name: 'Moderator', rawPosition: 1, managed: false },
    { id: '200', name: 'Owner', rawPosition: 2, managed: false },
  ]

  test('resolves names to ids', () => {
    expect(resolveOrderingConstraints(roles, [{ subject: 'Owner', above: ['Moderator'], below: [] }]))
      .toEqual([{ id: '200', above: ['100'], below: [] }])
  })

  test('a name that will NOT exist after the spec is applied throws, never silently skips', () => {
    expect(() => resolveOrderingConstraints(roles, [{ subject: 'Owner', above: ['Ghost'], below: [] }]))
      .toThrow(/no role named "Ghost" will exist/)
  })

  test('an AMBIGUOUS name throws rather than picking one', () => {
    const dupes = [...roles, { id: '300', name: 'Owner', rawPosition: 3, managed: false }]
    expect(() => resolveOrderingConstraints(dupes, [{ subject: 'Moderator', above: ['Owner'], below: [] }]))
      .toThrow(/is ambiguous/)
  })

  test('the SUBJECT is resolved the same way', () => {
    expect(() => resolveOrderingConstraints(roles, [{ subject: 'Ghost', above: ['Owner'], below: [] }]))
      .toThrow(/no role named "Ghost" will exist/)
  })

  test('names are the FINAL names — a spec that renames must use the new one', () => {
    // The §5a headline rule, and nothing pinned it: deleting the rename projection left the suite green.
    const state = fixtureState()
    const all = [{ id: 'g1', name: '@everyone', rawPosition: 0, managed: false },
                 ...state.roles.map(r => ({ id: r.id, name: r.name, rawPosition: r.rawPosition, managed: r.managed }))]
    const opts = { guildId: 'g1', botHighestRoleId: 'r3', allRoles: all }
    // Mod -> Overlord, and Member must sit above it. Naming the NEW name works...
    expect(() => computeSpecDiff(buildServerSpec(state),
      { roles: [{ id: 'r1', name: 'Overlord' }, { name: 'Member', id: 'r2', above: 'Overlord' }] }, opts)).not.toThrow()
    // ...and naming the OLD one is refused, rather than quietly matching a role that is about to
    // stop having that identity.
    expect(() => computeSpecDiff(buildServerSpec(state),
      { roles: [{ id: 'r1', name: 'Overlord' }, { name: 'Member', id: 'r2', above: 'Mod' }] }, opts))
      .toThrow(/no role named "Mod" will exist/)
  })

  test('namedOrderingConstraints accepts a single name or a list', () => {
    expect(namedOrderingConstraints({ roles: [{ name: 'A', above: 'B' }] }))
      .toEqual([{ subject: 'A', above: ['B'], below: [] }])
    expect(namedOrderingConstraints({ roles: [{ name: 'A', above: ['B', 'C'], below: 'D' }] }))
      .toEqual([{ subject: 'A', above: ['B', 'C'], below: ['D'] }])
    expect(namedOrderingConstraints({ roles: [{ name: 'A' }] })).toEqual([])
  })
})
