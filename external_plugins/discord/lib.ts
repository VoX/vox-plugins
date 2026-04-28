// Pure helpers used by server.ts. Kept in their own file so they can be
// unit-tested without booting the full MCP server (which connects to
// Discord on import).

import { EmbedBuilder, resolveColor, type ColorResolvable } from 'discord.js'

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
    // resolveColor's named-color lookup is case-sensitive (`Blurple`,
    // not `blurple`). Auto-capitalize purely-alpha input so callers
    // don't have to think about it. Hex starts with `#` or a digit,
    // both no-op under capitalize.
    const normalized = /^[a-z]+$/i.test(color)
      ? color.charAt(0).toUpperCase() + color.slice(1).toLowerCase()
      : color
    try {
      embed.setColor(resolveColor(normalized as ColorResolvable))
    } catch {
      throw new Error(`invalid color: ${color} (use hex like #5865f2 or a discord.js Colors name like 'Blurple')`)
    }
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
