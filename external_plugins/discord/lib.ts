// Pure helpers used by server.ts. Kept in their own file so they can be
// unit-tested without booting the full MCP server (which connects to
// Discord on import).

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
