// Pure helpers used by server.ts. Kept in their own file so they can be
// unit-tested without booting the full MCP server (which connects to
// Slack on import).

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
  if (str.length <= n) return str
  return Array.from(str).slice(0, n).join('')
}

export function formatSendResult(ids: string[]): string {
  return ids.length === 1
    ? `sent (ts: ${ids[0]})`
    : `sent ${ids.length} parts (ts: ${ids.join(', ')})`
}

// "2h30m" / "45m" / "1d" / "10s" / "1h30m45s" → ms.
// Returns null on parse failure (caller shows a friendly hint).
export function parseDuration(input: string): number | null {
  const trimmed = input.trim().toLowerCase()
  if (!trimmed) return null
  const re = /(\d+)([smhd])/g
  const units: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }
  let total = 0
  let consumed = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(trimmed)) !== null) {
    total += parseInt(m[1]!, 10) * units[m[2]!]!
    consumed += m[0].length
  }
  if (total === 0 || consumed !== trimmed.length) return null
  return total
}

// Slack's mrkdwn is markdown-shaped but not markdown:
//   *bold*  not  **bold**
//   _italic_  not  *italic*
//   ~strike~  not  ~~strike~~
// Translate a markdown body to mrkdwn so callers can write idiomatic
// markdown without thinking about Slack's quirks. Code blocks, inline
// code, blockquotes, and links are already compatible.
export function mdToMrkdwn(text: string): string {
  // Replace **bold** → *bold*. Use a non-greedy match so adjacent runs
  // don't merge. Avoid touching escaped `\*\*` (uncommon, but cheap to
  // preserve).
  let out = text.replace(/(?<!\\)\*\*([^*\n]+?)\*\*/g, '*$1*')
  // Replace ~~strike~~ → ~strike~. Same non-greedy + escape guard.
  out = out.replace(/(?<!\\)~~([^~\n]+?)~~/g, '~$1~')
  // Single-asterisk italic (*italic*) → underscore italic (_italic_) is
  // ambiguous: bold also uses *…*. We only convert _italic_ in the
  // markdown direction, since slack's mrkdwn already handles _ for
  // italic. Leaving asterisk runs alone is the safer choice.
  // Markdown links [text](url) → slack <url|text>
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<$2|$1>')
  return out
}

// Parse Slack mention tokens out of a message body for replacement /
// annotation. Slack uses:
//   <@U123ABC>           user mention
//   <#C123ABC|name>      channel mention (name is denormalised)
//   <!subteam^S123|@team> user-group mention
//   <!here>              special: notify online members
//   <!channel>           special: notify whole channel
//   <!everyone>          special: notify whole workspace
// Returns the parsed tokens with their raw form + classification so
// callers can resolve user IDs to display names asynchronously.
export type SlackMention =
  | { type: 'user'; raw: string; id: string }
  | { type: 'channel'; raw: string; id: string; name?: string }
  | { type: 'usergroup'; raw: string; id: string; handle?: string }
  | { type: 'special'; raw: string; keyword: 'here' | 'channel' | 'everyone' }
export function parseSlackMentions(text: string): SlackMention[] {
  const out: SlackMention[] = []
  // Order matters: <!subteam^...> must match before plain <!keyword>.
  const re = /<(@U[A-Z0-9]+|#C[A-Z0-9]+(?:\|[^>]+)?|!subteam\^S[A-Z0-9]+(?:\|[^>]+)?|!(?:here|channel|everyone))>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const raw = m[0]
    const inner = m[1]!
    if (inner.startsWith('@')) {
      out.push({ type: 'user', raw, id: inner.slice(1) })
    } else if (inner.startsWith('#')) {
      const [id, name] = inner.slice(1).split('|')
      out.push({ type: 'channel', raw, id: id!, ...(name ? { name } : {}) })
    } else if (inner.startsWith('!subteam^')) {
      const rest = inner.slice('!subteam^'.length)
      const [id, handle] = rest.split('|')
      out.push({ type: 'usergroup', raw, id: id!, ...(handle ? { handle } : {}) })
    } else if (inner.startsWith('!')) {
      const keyword = inner.slice(1) as 'here' | 'channel' | 'everyone'
      out.push({ type: 'special', raw, keyword })
    }
  }
  return out
}

// Splits long text at the closest whitespace boundary under `limit` so a
// single reply can ship across multiple Slack messages without breaking
// mid-mention or mid-word. Prefers paragraph breaks > line breaks > word
// breaks > hard cut at limit. Slack's per-message text cap is ~40000
// chars but blocks have a 3000-char per-section limit; default to 3000.
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

// Slack 1:1 DM channel IDs always start with 'D'. Public (C), private
// (G), and multi-party DMs (MPDM…/G…) all behave the same way for our
// access gate — opted into per-channel via `groups` — so we only need
// to single out the DM case for the user-id allowlist lookup. Earlier
// drafts had a fuller classifier; the operator-precedence bug there
// (and the lack of any callsite using anything beyond 'im' vs not)
// pointed straight at this minimal shape.
export function isDmChannel(id: string): boolean {
  return id.startsWith('D')
}

// Reactions in slack are referenced by shortcode (e.g. "thumbsup"), not
// the unicode glyph. Strip surrounding colons if a caller passed them.
// Pass-through for shortcodes; throws if a unicode emoji is supplied
// since slack would 400 on it anyway and the error is opaque.
export function normalizeReactionName(input: string): string {
  const trimmed = input.trim().replace(/^:|:$/g, '')
  if (!trimmed) throw new Error('reaction name is empty')
  // Slack reactions are ASCII shortcodes — letters, digits, _ - +. Reject
  // anything else so the model gets a clear "use shortcode not unicode"
  // signal instead of a slack 400.
  if (!/^[a-z0-9_+\-]+$/i.test(trimmed)) {
    throw new Error(
      `reaction name must be a slack shortcode like "thumbsup" or "white_check_mark", not "${input}". ` +
      `Slack rejects unicode emoji here.`,
    )
  }
  return trimmed.toLowerCase()
}
