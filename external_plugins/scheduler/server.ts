#!/usr/bin/env bun
/**
 * Scheduler channel for Claude Code.
 *
 * Schedules messages to be delivered back into this Claude session, either
 * once (`at`) or on a recurring systemd calendar expression (`calendar`).
 * State persists to ~/.claude/channels/scheduler/jobs.json across restarts.
 *
 * Fires arrive via notifications/claude/channel (same mechanism the discord
 * plugin uses), appearing as:
 *   <channel source="scheduler" scheduled_id="..." fired_at="..." ...>
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { readFileSync, writeFileSync, mkdirSync, renameSync, appendFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { randomBytes } from 'crypto'
import { spawnSync } from 'child_process'

const STATE_DIR = process.env.SCHEDULER_STATE_DIR ?? join(homedir(), '.claude', 'channels', 'scheduler')
const JOBS_FILE = join(STATE_DIR, 'jobs.json')
const POLL_MS = 5000
// Delay from scheduler boot until on_startup jobs become due. The MCP
// `notifications/initialized` handshake completes early (~11s), but
// claude-code's turn queue isn't ready to enqueue new turns until the
// --resume transcript has finished loading. Firing before that point
// gets the notification silently dropped. 20s is comfortable even for
// large transcripts; if startup fires still miss, bump this up.
const STARTUP_FIRE_DELAY_MS = 20_000
// Dedicated debug log — stderr goes into a socket to claude-code and is
// hard to capture. Dumping to a known file lets us trace notification
// delivery end-to-end without needing to intercept the MCP stream.
const DEBUG_LOG = join(STATE_DIR, 'debug.log')
function dbg(msg: string): void {
  try {
    mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
    appendFileSync(DEBUG_LOG, `${new Date().toISOString()} ${msg}\n`, { mode: 0o600 })
  } catch {}
}

type Job = {
  id: string
  fire_at: number
  text: string
  created_at: number
  execution_count: number
  title?: string
  calendar?: string
  max_executions?: number
  retry_count?: number
  on_startup?: boolean
}

const MAX_REARM_RETRIES = 3

type JobStore = { jobs: Job[] }

const isRecurring = (j: Job): boolean => j.calendar !== undefined
const remainingAfterFire = (j: Job): number | undefined =>
  j.max_executions !== undefined ? j.max_executions - (j.execution_count + 1) : undefined

function loadJobs(): JobStore {
  try {
    return JSON.parse(readFileSync(JOBS_FILE, 'utf8')) as JobStore
  } catch {
    return { jobs: [] }
  }
}

function saveJobs(store: JobStore): void {
  // jobs.json contains notification text that is re-delivered to Claude —
  // a prompt-injection vector if the file is world-readable. Lock it down
  // to the current user only and swallow failures so a tool call never
  // crashes the server over an I/O error.
  try {
    mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
    const tmp = JOBS_FILE + '.tmp'
    writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 })
    renameSync(tmp, JOBS_FILE)
  } catch (err) {
    process.stderr.write(`scheduler: failed to persist jobs: ${err}\n`)
  }
}

function newId(): string {
  return 'sched_' + randomBytes(6).toString('hex')
}

// Cached probe: is `systemd-analyze` on PATH? Runs lazily on first use so
// macOS / minimal Alpine users get a clean error instead of a confusing
// spawn dump. `null` means "not yet probed".
let systemdAnalyzeAvailable: boolean | null = null
function ensureSystemdAnalyze(): void {
  if (systemdAnalyzeAvailable === true) return
  if (systemdAnalyzeAvailable === false) {
    throw new Error(
      'calendar expressions require systemd-analyze, which is not on PATH. ' +
      'Install systemd (Linux with systemd) or use a one-shot `at` ISO-8601 timestamp instead.',
    )
  }
  const res = spawnSync('systemd-analyze', ['--version'], { encoding: 'utf8' })
  systemdAnalyzeAvailable = res.status === 0
  if (!systemdAnalyzeAvailable) {
    throw new Error(
      'calendar expressions require systemd-analyze, which is not on PATH. ' +
      'Install systemd (Linux with systemd) or use a one-shot `at` ISO-8601 timestamp instead.',
    )
  }
}

// Strip systemd-analyze noise down to the first non-empty line so we don't
// spew multi-line stack-ish output at the caller.
function summarizeAnalyzerStderr(raw: string): string {
  const line = raw.split('\n').map(s => s.trim()).find(s => s.length > 0)
  return line ?? 'systemd-analyze rejected the expression'
}

// Runs `systemd-analyze calendar <expr> --iterations=1` under TZ=UTC and
// returns the next fire time as epoch ms. Throws with a summarized error
// if the expression is invalid. Pass `after` to compute the next fire
// strictly after a given moment (used when re-arming a recurring job).
function nextCalendarFire(expr: string, after?: Date): number {
  ensureSystemdAnalyze()
  const args = ['calendar', expr, '--iterations=1']
  if (after) {
    // systemd-analyze expects "YYYY-MM-DD HH:MM:SS UTC" for --base-time.
    const base = after.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC')
    args.push(`--base-time=${base}`)
  }
  const res = spawnSync('systemd-analyze', args, {
    env: { ...process.env, TZ: 'UTC' },
    encoding: 'utf8',
  })
  if (res.status !== 0) {
    throw new Error(`invalid calendar expression: ${summarizeAnalyzerStderr(res.stderr || res.stdout || '')}`)
  }
  const m = res.stdout.match(/Next elapse:\s+\w+\s+(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})\s+UTC/)
  if (!m) throw new Error(`could not parse systemd-analyze output:\n${res.stdout}`)
  const t = Date.parse(`${m[1]}T${m[2]}Z`)
  if (isNaN(t)) throw new Error(`could not parse next-fire timestamp: ${m[1]}T${m[2]}Z`)
  return t
}

function describeWhen(fireAt: number): string {
  const ms = fireAt - Date.now()
  if (ms < 0) return 'overdue'
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.round(m / 60)
  if (h < 48) return `${h}h`
  return `${Math.round(h / 24)}d`
}

const mcp = new Server(
  { name: 'scheduler', version: '0.2.6' },
  {
    capabilities: {
      tools: {},
      experimental: {
        'claude/channel': {},
      },
    },
    instructions: [
      "The scheduler channel lets you send yourself messages at a future time. Scheduled fires arrive as <channel source='scheduler' scheduled_id='...' fired_at='...'> and appear in your normal context — treat them as nudges from past-you.",
      '',
      'Use `schedule` to queue a message. Provide exactly one of:',
      '  - `at` — ISO-8601 timestamp for a one-shot fire (e.g. "2026-04-17T09:00:00Z")',
      '  - `calendar` — systemd calendar expression for recurring fires',
      '  - `on_startup` — fires once on the next scheduler server startup, then deletes itself. Useful for auto-triggering a turn after you restart yourself.',
      '',
      'Calendar examples (all UTC):',
      '  "*-*-* 09:00:00"      daily at 09:00 UTC',
      '  "Mon..Fri 09:00"      weekdays at 09:00',
      '  "Mon *-*-* 10:00"     Mondays at 10:00',
      '  "*-*-* 0/2:00:00"     every 2 hours on the hour',
      '  "*:0/15"              every 15 minutes',
      '  "hourly"              top of every hour',
      '',
      'Optional for recurring jobs: `max_executions` caps total fires, after which the job auto-deletes.',
      '',
      'Use `list_scheduled` to see pending jobs and `cancel` to drop one by id. Jobs persist to ~/.claude/channels/scheduler/jobs.json so they survive restarts.',
    ].join('\n'),
  },
)

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'schedule',
      description: 'Schedule a message to be delivered back into this Claude session. Provide exactly one of `at` (ISO-8601 for one-shot), `calendar` (systemd calendar expression for recurring), or `on_startup` (fires once on next scheduler server startup, then deletes itself). Returns the job id.',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'The message body to deliver when the job fires.' },
          at: {
            type: 'string',
            description: "One-shot fire time as ISO-8601 (e.g. '2026-04-17T09:00:00Z'). Mutually exclusive with calendar and on_startup.",
          },
          calendar: {
            type: 'string',
            description: "systemd calendar expression for recurring fires, e.g. 'Mon..Fri 09:00', '*-*-* 0/2:00:00', 'hourly'. Mutually exclusive with at and on_startup.",
          },
          on_startup: {
            type: 'boolean',
            description: 'If true, fires once on the next scheduler server startup and then deletes itself. Useful to auto-trigger a turn after restarting yourself. Mutually exclusive with at and calendar.',
          },
          max_executions: {
            type: 'number',
            description: 'Optional cap on total fires for a recurring job. Job auto-deletes when reached. Ignored for one-shot `at` and `on_startup` jobs.',
          },
          title: { type: 'string', description: 'Optional short label shown in list_scheduled output.' },
        },
        required: ['text'],
      },
    },
    {
      name: 'list_scheduled',
      description: 'List all pending scheduled jobs, sorted by next fire time.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'cancel',
      description: 'Cancel a pending scheduled job by id.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
    },
  ],
}))

mcp.setRequestHandler(CallToolRequestSchema, async req => {
  const name = req.params.name
  const args = (req.params.arguments ?? {}) as Record<string, unknown>

  if (name === 'schedule') {
    const text = String(args.text ?? '').trim()
    if (!text) throw new Error('text is required')
    const at = typeof args.at === 'string' && args.at.trim() ? args.at.trim() : undefined
    const calendar = typeof args.calendar === 'string' && args.calendar.trim() ? args.calendar.trim() : undefined
    const on_startup = args.on_startup === true
    const picked = [at ? 'at' : null, calendar ? 'calendar' : null, on_startup ? 'on_startup' : null].filter(Boolean)
    if (picked.length === 0) throw new Error('provide at (one-shot ISO-8601), calendar (systemd calendar expression), or on_startup (fire on next server startup)')
    if (picked.length > 1) throw new Error(`provide only one of at, calendar, or on_startup (got ${picked.join(', ')})`)
    const title = typeof args.title === 'string' && args.title.trim() ? args.title.trim() : undefined
    const max = typeof args.max_executions === 'number' && args.max_executions > 0
      ? Math.floor(args.max_executions)
      : undefined

    let fire_at: number
    if (at) {
      fire_at = Date.parse(at)
      if (isNaN(fire_at)) throw new Error(`invalid 'at' — expected ISO-8601 timestamp, got: ${at}`)
      // Silently back-scheduling is almost never what the caller wanted —
      // reject anything more than 60s in the past so clock drift and
      // near-now "schedule immediately" still work.
      const earliest = Date.now() - 60_000
      if (fire_at < earliest) {
        throw new Error(
          `'at' is in the past (${at}); refusing to back-schedule. Provide a future ISO-8601 timestamp.`,
        )
      }
    } else if (calendar) {
      fire_at = nextCalendarFire(calendar)
    } else {
      // on_startup job — fire_at is a sentinel (0). The regular tick ignores
      // these; fireStartupJobs() at server init handles delivery + cleanup.
      fire_at = 0
    }

    const job: Job = {
      id: newId(),
      fire_at,
      text,
      execution_count: 0,
      created_at: Date.now(),
      ...(title ? { title } : {}),
      ...(calendar ? { calendar } : {}),
      ...(calendar && max ? { max_executions: max } : {}),
      ...(on_startup ? { on_startup: true } : {}),
    }
    const store = loadJobs()
    store.jobs.push(job)
    saveJobs(store)
    const lines = on_startup
      ? [`${job.id} — fires on next scheduler startup`]
      : [`${job.id} — fires in ${describeWhen(job.fire_at)} at ${new Date(job.fire_at).toISOString()}`]
    if (calendar) {
      lines.push(`recurring: ${calendar}`)
      if (max) lines.push(`max_executions: ${max}`)
    }
    if (title) lines.push(`title: ${title}`)
    return { content: [{ type: 'text', text: lines.join('\n') }] }
  }

  if (name === 'list_scheduled') {
    const store = loadJobs()
    if (store.jobs.length === 0) return { content: [{ type: 'text', text: 'no scheduled jobs' }] }
    // on_startup jobs have fire_at=0 as a sentinel — sort them to the top
    // so they're visible above scheduled work.
    const sorted = [...store.jobs].sort((a, b) => {
      if (a.on_startup && !b.on_startup) return -1
      if (!a.on_startup && b.on_startup) return 1
      return a.fire_at - b.fire_at
    })
    const lines = sorted.map(j => {
      const when = j.on_startup
        ? 'on next startup'
        : `${describeWhen(j.fire_at)} (${new Date(j.fire_at).toISOString()})`
      const rec = j.calendar ? ` [${j.calendar}]` : ''
      const rem = j.max_executions !== undefined
        ? ` remaining=${j.max_executions - j.execution_count}`
        : ''
      const count = ` fired=${j.execution_count}`
      const ttl = j.title ? ` ${j.title}` : ''
      const preview = j.text.length > 80 ? j.text.slice(0, 77) + '…' : j.text
      return `${j.id}  ${when}${rec}${rem}${count}${ttl}\n  ${preview}`
    })
    return { content: [{ type: 'text', text: lines.join('\n') }] }
  }

  if (name === 'cancel') {
    const id = String(args.id ?? '')
    if (!id) throw new Error('id is required')
    const store = loadJobs()
    const before = store.jobs.length
    store.jobs = store.jobs.filter(j => j.id !== id)
    if (store.jobs.length === before) {
      return { content: [{ type: 'text', text: `no job with id ${id}` }] }
    }
    saveJobs(store)
    return { content: [{ type: 'text', text: `cancelled ${id}` }] }
  }

  throw new Error(`unknown tool: ${name}`)
})

let ticking = false
async function tick(): Promise<void> {
  if (ticking) return
  ticking = true
  try {
    // TODO: loadJobs() reads from disk every tick, which races with
    // concurrent writes from tool calls and external editors — a mutation
    // made between this read and the saveJobs() below can be clobbered.
    // Proper fix needs file locking (flock or a .lock sentinel); deferred
    // for now since tool calls and tick both run in-process and the
    // mutex on `ticking` already serializes our own writes.
    const store = loadJobs()
    if (store.jobs.length === 0) return
    const now = Date.now()
    // on_startup jobs have already been rewritten at boot to a real
    // fire_at = boot_time + STARTUP_FIRE_DELAY_MS with the flag cleared,
    // so a simple due check is all we need here.
    const due = store.jobs.filter(j => j.fire_at <= now)
    if (due.length === 0) return

    dbg(`tick: ${due.length} due`)
    // Fire notifications in parallel — a stuck notification should not
    // block other due jobs for this tick.
    const results = await Promise.allSettled(
      due.map(job => {
        const remainingAfter = remainingAfterFire(job)
        const meta: Record<string, string> = {
          scheduled_id: job.id,
          fired_at: new Date(now).toISOString(),
          originally_scheduled_for: new Date(job.fire_at).toISOString(),
          execution_count: String(job.execution_count + 1),
        }
        if (job.title) meta.title = job.title
        if (job.calendar) meta.calendar = job.calendar
        if (remainingAfter !== undefined) meta.remaining_after = String(remainingAfter)
        dbg(`tick fire ${job.id}: content=${JSON.stringify(job.text).slice(0, 100)} meta=${JSON.stringify(meta)}`)
        return mcp.notification({
          method: 'notifications/claude/channel',
          params: { content: job.text, meta },
        }).then(
          () => { dbg(`tick fire ${job.id}: resolved`) },
          err => { dbg(`tick fire ${job.id}: REJECTED ${err}`); throw err },
        )
      }),
    )

    let changed = false
    for (let i = 0; i < due.length; i++) {
      const job = due[i]
      const result = results[i]
      if (result.status === 'rejected') {
        // Leave the job in place so it retries next tick. Delivery failures
        // do not count against the re-arm retry budget.
        process.stderr.write(`scheduler: failed to deliver job ${job.id}: ${result.reason}\n`)
        continue
      }
      const remainingAfter = remainingAfterFire(job)
      job.execution_count += 1
      const exhausted = remainingAfter !== undefined && remainingAfter <= 0
      if (isRecurring(job) && !exhausted) {
        try {
          job.fire_at = nextCalendarFire(job.calendar!, new Date(now))
          job.retry_count = 0
        } catch (err) {
          // Transient analyzer failure? Keep the job at its current fire_at,
          // bump retry_count, and try again next tick. Only drop after
          // MAX_REARM_RETRIES consecutive failures to avoid silent data loss
          // on a temporary systemd-analyze hiccup.
          const retries = (job.retry_count ?? 0) + 1
          job.retry_count = retries
          if (retries >= MAX_REARM_RETRIES) {
            process.stderr.write(
              `scheduler: dropping ${job.id} (${job.calendar}) after ${retries} re-arm failures: ${err}\n`,
            )
            store.jobs = store.jobs.filter(j => j.id !== job.id)
          } else {
            process.stderr.write(
              `scheduler: re-arm failure ${retries}/${MAX_REARM_RETRIES} for ${job.id} (${job.calendar}): ${err} — leaving in place\n`,
            )
          }
        }
      } else {
        store.jobs = store.jobs.filter(j => j.id !== job.id)
      }
      changed = true
    }
    if (changed) saveJobs(store)
  } finally {
    ticking = false
  }
}

// Rewrites any on_startup jobs to a regular fire_at = boot_time + DELAY
// with the flag cleared, so the normal tick() pipeline delivers them.
// We can't fire directly at boot because claude-code's turn queue isn't
// accepting enqueues yet during --resume transcript load — the MCP
// handshake finishes first but the queue is only ready ~tens of seconds
// later. Deferring through tick() gives the queue time to come up AND
// reuses the battle-tested regular delivery path.
function rewriteStartupJobs(): void {
  const store = loadJobs()
  const startup = store.jobs.filter(j => j.on_startup === true)
  if (startup.length === 0) return
  const fireAt = Date.now() + STARTUP_FIRE_DELAY_MS
  for (const job of startup) {
    job.fire_at = fireAt
    delete job.on_startup
  }
  saveJobs(store)
  dbg(`rewriteStartupJobs: ${startup.length} startup jobs rewritten to fire at ${new Date(fireAt).toISOString()} (${STARTUP_FIRE_DELAY_MS}ms from now)`)
}

dbg(`scheduler booting v0.2.6 (pid ${process.pid})`)
rewriteStartupJobs()
await mcp.connect(new StdioServerTransport())
dbg(`mcp.connect() returned; polling every ${POLL_MS}ms`)
process.stderr.write(`scheduler: started, polling every ${POLL_MS}ms\n`)

setInterval(() => {
  tick().catch(err => process.stderr.write(`scheduler tick error: ${err}\n`))
}, POLL_MS)

// Sweep overdue one-shot / recurring jobs right away so they don't wait a
// full poll interval. Startup-rewritten jobs will NOT fire here because
// their fire_at is in the future; they land on a later tick.
tick().catch(err => process.stderr.write(`scheduler startup tick error: ${err}\n`))
