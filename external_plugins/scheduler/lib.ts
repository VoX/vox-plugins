// Pure helpers used by server.ts. Kept in their own file so they can be
// unit-tested without booting the full MCP server.

export function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s
}

// Argument-extraction shape: trim a string-typed arg or return undefined.
// Treats whitespace-only strings as undefined (the caller didn't really
// pass anything). Non-string values (numbers, null, arrays) → undefined.
export function optString(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key]
  return typeof v === 'string' && v.trim() ? v.trim() : undefined
}
