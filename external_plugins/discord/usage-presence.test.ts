import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { parseUsageLimitState, usageAlarmText, MAX_USAGE_STATE_BYTES } from './usage-presence'
import { composePresence, isIdle, PRESENCE_IDLE, withContextPrefix } from './lib'

const NOW = Date.parse('2026-10-15T20:00:00Z')
const quota = {
  version: 1 as const, error: 'rate_limit' as const, blocked_at: NOW,
  reset_at: Date.parse('2026-10-16T00:00:00Z'), session_id: 'main-session',
}

describe('quota marker validation and rendering', () => {
  test('accepts only the strict versioned marker and drops unknown fields', () => {
    expect(parseUsageLimitState(JSON.stringify({ ...quota, raw_error: 'must not leak' }))).toEqual(quota)
  })
  for (const [name, bad] of Object.entries({
    empty: '', invalid: '{', array: '[]', nil: 'null', large: ' '.repeat(MAX_USAGE_STATE_BYTES + 1),
    version: JSON.stringify({ ...quota, version: 2 }), error: JSON.stringify({ ...quota, error: 'invalid_request' }),
    noBlocked: JSON.stringify({ ...quota, blocked_at: undefined }), blockedString: JSON.stringify({ ...quota, blocked_at: '1' }),
    resetString: JSON.stringify({ ...quota, reset_at: 'tomorrow' }), resetInvalidDate: JSON.stringify({ ...quota, reset_at: 9000000000000000 }),
    unsafeSession: JSON.stringify({ ...quota, session_id: 'oops\n@everyone' }),
  })) test(`rejects ${name}`, () => expect(parseUsageLimitState(bad)).toBeNull())
  test('renders the UTC-midnight reset on the correct Eastern day', () => {
    const q = parseUsageLimitState(JSON.stringify(quota))!
    const text = usageAlarmText(q, NOW)
    expect(text).toContain('Oct 15')
    expect(text).toContain('8:00 PM EDT')
    expect(text).not.toContain('Oct 16')
  })
  test('unknown reset is honestly generic, not a guessed deadline', () => {
    expect(usageAlarmText({ ...quota, version: 1, error: 'rate_limit', reset_at: null }, NOW)).toContain('rate/usage limited')
  })
  test('elapsed reset remains an alarm until actual successful recovery', () => {
    expect(usageAlarmText({ ...quota, version: 1, error: 'rate_limit' }, quota.reset_at + 1)).toContain('awaiting successful retry')
  })
})

// Exercise the REAL server functions with synthetic files/client/clock. Importing
// server.ts would acquire a live bridge lock and connect transports, so extract
// only these named functions and transpile them, with all IO replaced below.
const server = readFileSync(new URL('./server.ts', import.meta.url), 'utf8')
function extracted(name: string): string {
  const match = server.match(new RegExp(`function ${name}\\([^]*?\\n\\}`, 'm'))
  if (!match) throw new Error(`server function missing: ${name}`)
  return new Bun.Transpiler({ loader: 'ts' }).transformSync(match[0])
}
function harness(initial: Record<string, string> = {}, initialAuth = false) {
  const files = new Map(Object.entries(initial))
  const wire: any[] = []
  let stops = 0, now = NOW
  const build = new Function(
    'files', 'client', 'readFileSync', 'statSync', 'stopAllTyping', 'Date',
    'parseUsageLimitState', 'usageAlarmText', 'composePresence', 'isIdle', 'withContextPrefix',
    `
      const MAX_USAGE_STATE_BYTES = 4096;
      const PRESENCE_USAGE_LIMIT_FILE = 'quota', PRESENCE_STATUS_FILE = 'pin', PRESENCE_FILE = 'activity';
      const PRESENCE_ACTIVITY = true, PRESENCE_TYPING = true, PRESENCE_IDLE = '💤 idle…';
      const ActivityType = { Custom: 4 };
      const PRESENCE_WINDOW_MS = 20000, PRESENCE_WINDOW_MAX = 5, PRESENCE_DEBOUNCE_MS = 1000;
      const PRESENCE_POLL_MS = 250, setInterval = () => {};
      const AUTH_DEAD_STATUS = '⚠ unauthenticated · run /login';
      const sanitizeStatus = s => s;
      const readContextPrefix = () => '42k';
      const isResting = t => t === '' || isIdle(t);
      let authDead = ${initialAuth}, lastPresenceText = null, presenceShownLines = 0;
      let lastRawSeen = '', presenceWrites = [], firstPendingAt = 0;
      ${extracted('readUsageLimitState')}
      ${extracted('setPresenceNow')}
      ${extracted('tickPresence')}
      ${extracted('startPresenceWatcher')}
      return { tick: tickPresence, start: startPresenceWatcher, auth: x => authDead = x };
    `,
  )
  const api = build(files,
    { user: { username: 'test-bot', setPresence: (p: any) => wire.push(p) } },
    (path: string) => { if (!files.has(path)) throw new Error('ENOENT'); return files.get(path) },
    (path: string) => { if (!files.has(path)) throw new Error('ENOENT'); return { size: files.get(path)!.length } },
    () => stops++, { now: () => now }, parseUsageLimitState,
    (q: any) => usageAlarmText(q, now), composePresence, isIdle, withContextPrefix,
  )
  return { files, wire, api, stops: () => stops, advance: (ms: number) => { now += ms } }
}
const marked = { quota: JSON.stringify(quota), activity: '🐾 working…\n' }
describe('real quota presence wiring, without a network or real state', () => {
  test('quota immediately beats working and manual pins, publishes DND without stale context', () => {
    const h = harness({ ...marked, pin: 'manual status' }); h.api.tick()
    expect(h.wire).toHaveLength(1)
    expect(h.wire[0].status).toBe('dnd')
    expect(h.wire[0].activities[0].state).toStartWith('⏳ usage limit')
    expect(h.wire[0].activities[0].state).not.toContain('42k')
  })
  test('auth alarm still outranks quota, which returns after auth recovery', () => {
    const h = harness(marked, true); h.api.tick()
    expect(h.wire[0].activities[0].state).toContain('unauthenticated')
    h.api.auth(false); h.api.tick()
    expect(h.wire[1].activities[0].state).toContain('usage limit')
  })
  test('an unchanged alarm stops newly armed typing even when gateway writes are deduped', () => {
    const h = harness(marked); h.api.tick(); h.api.tick()
    expect(h.wire).toHaveLength(1)
    expect(h.stops()).toBe(2)
  })
  test('fresh start/tool/idle markers cannot erase a quota alarm', () => {
    const h = harness(marked); h.api.tick()
    for (const activity of ['🐾 working…\n', '✏️ editing…\n', '💤 idle…\n']) {
      h.files.set('activity', activity); h.api.tick()
    }
    expect(h.wire).toHaveLength(1)
    expect(h.wire[0].status).toBe('dnd')
  })
  test('a fresh bridge instance resumes the durable quota alarm without a model turn', () => {
    const before = harness(marked); before.api.tick()
    const after = harness(Object.fromEntries(before.files)); after.api.start()
    expect(before.wire).toHaveLength(1)
    expect(after.wire).toHaveLength(1)
    expect(after.wire[0]).toEqual(before.wire[0])
    expect(after.wire.every(p => p.status === 'dnd')).toBe(true)
    after.api.tick()
    expect(after.wire).toHaveLength(1)
  })
  test('reset time alone changes wording but never returns a false green status', () => {
    const h = harness(marked); h.api.tick(); h.advance(5 * 3600000); h.api.tick()
    expect(h.wire.at(-1).status).toBe('dnd')
    expect(h.wire.at(-1).activities[0].state).toContain('awaiting successful retry')
    expect(h.files.has('quota')).toBe(true)
  })
  test('a successful main Stop removes the pin and ordinary idle presence resumes', () => {
    const h = harness(marked); h.api.tick()
    h.files.delete('quota'); h.files.set('activity', '💤 idle…\n')
    h.api.tick(); h.advance(1001); h.api.tick()
    expect(h.wire.at(-1).status).toBe('idle')
    expect(h.wire.at(-1).activities[0].state).toContain(PRESENCE_IDLE)
  })
  test('missing/corrupt markers do not invent a quota state', () => {
    const h = harness({ quota: '{', activity: '🐾 working…\n' }); h.api.tick(); h.advance(1001); h.api.tick()
    expect(h.wire.at(-1).status).toBe('online')
    expect(h.wire.at(-1).activities[0].state).toContain('working')
  })
})

test('hook declarations wire only rate-limit failure and successful main Stop, not session shutdown', () => {
  const hooks = JSON.parse(readFileSync(new URL('./hooks/hooks.json', import.meta.url), 'utf8')).hooks
  expect(hooks.StopFailure).toHaveLength(1)
  expect(hooks.StopFailure[0].matcher).toBe('rate_limit')
  expect(hooks.StopFailure[0].hooks[0].command).toContain('usage_state.py --failure')
  expect(hooks.Stop[0].hooks.some((h: any) => h.command.includes('usage_state.py --success'))).toBe(true)
  expect(hooks.Stop[0].hooks.some((h: any) => h.command.includes('presence-status.sh --idle'))).toBe(true)
  expect(JSON.stringify(hooks.SessionEnd)).not.toContain('usage_state.py --success')
})