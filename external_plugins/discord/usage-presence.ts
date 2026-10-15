// Quota alarms are native-hook state, not model-written status text. Keep the
// wire format small and strict; never relay raw provider errors into Discord.
export type UsageLimitState = {
  version: 1
  error: 'rate_limit'
  blocked_at: number
  reset_at: number | null
  session_id: string
}

export const USAGE_LIMIT_FILE = '.presence-usage-limit.json'
export const MAX_USAGE_STATE_BYTES = 4096

export function parseUsageLimitState(raw: string): UsageLimitState | null {
  if (!raw || raw.length > MAX_USAGE_STATE_BYTES) return null
  let value: any
  try { value = JSON.parse(raw) } catch { return null }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  if (value.version !== 1 || value.error !== 'rate_limit') return null
  if (!Number.isSafeInteger(value.blocked_at) || value.blocked_at <= 0) return null
  if (value.reset_at !== null && (!Number.isSafeInteger(value.reset_at) || value.reset_at <= 0)) return null
  if (value.reset_at !== null && !Number.isFinite(new Date(value.reset_at).getTime())) return null
  if (typeof value.session_id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value.session_id)) return null
  return {
    version: 1, error: 'rate_limit', blocked_at: value.blocked_at,
    reset_at: value.reset_at, session_id: value.session_id,
  }
}

const RESET_ET = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', month: 'short', day: 'numeric',
  hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
})

export function usageAlarmText(state: UsageLimitState, now = Date.now()): string {
  if (state.reset_at === null) return '⏳ rate/usage limited · awaiting successful retry'
  // A clock is not proof that the account can work: another bucket may remain
  // exhausted. Only a successful main-session Stop removes the persistent pin.
  if (state.reset_at <= now) return '⏳ usage reset due · awaiting successful retry'
  return `⏳ usage limit · resets ${RESET_ET.format(new Date(state.reset_at))}`
}