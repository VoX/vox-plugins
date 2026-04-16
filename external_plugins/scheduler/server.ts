#!/usr/bin/env bun
/**
 * Scheduler channel for Claude Code.
 *
 * Schedules messages to be delivered back into this Claude session at a future
 * time, either once (`at`) or on a recurring systemd-calendar expression
 * (`calendar`). State lives in ~/.claude/channels/scheduler/jobs.json and
 * survives plugin restarts.
 *
 * Fires arrive via notifications/claude/channel, the same mechanism the
 * discord plugin uses — they land in the inbound context as
 *   <channel source="scheduler" scheduled_id="..." fired_at="..." ...>
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { randomBytes } from 'crypto'
import { spawnSync } from 'child_process'

const STATE_DIR = process.env.SCHEDULER_STATE_DIR ?? join(homedir(), '.claude', 'channels', 'scheduler')
const JOBS_FILE = join(STATE_DIR, 'jobs.json')
const POLL_MS = 5000

type Job = {
  id: string
  fire_at: number
  text: string
  title?: string
  // systemd calendar expression for recurring jobs (e.g. "Mon..Fri 09:00").
  // Absent for one-shot jobs scheduled via `at`.
  calendar?: string
  // Optional cap on total fires for recurring jobs. Decrements after each
  // successful fire; when it reaches zero the job is removed.
  remaining_executions?: number
  execution_count: number
  created_at: number
}

type JobStore = { jobs: Job[] }

function loadJobs(): JobStore {
  try {
    return JSON.parse(readFileSync(JOBS_FILE, 'utf8')) as JobStore
  } catch {
    return { jobs: [] }
  }
}

function saveJobs(store: JobStore): void {
  mkdirSync(STATE_DIR, { recursive: true })
  const tmp = JOBS_FILE + '.tmp'
  writeFileSync(tmp, JSON.stringify(store, null, 2))
  renameSync(tmp, JOBS_FILE)
}

function newId(): string {
  return 'sched_' + randomBytes(6).toString('hex')
}

function parseIsoAt(at: string): number {
  const t = Date.parse(at)
  if (isNaN(t)) throw new Error(`invalid 'at' — expected ISO-8601 timestamp, got: ${at}`)
  return t
}

// Runs `systemd-analyze calendar <expr> --iterations=1` in UTC and returns
// the next fire time as epoch ms. Throws with the analyzer's stderr if the
// expression is invalid. Base time is "now" by default; pass `after` to
// compute the next fire strictly after a given moment (used when re-arming).
function nextCalendarFire(expr: string, after?: Date): number {
  const args = ['calendar', expr, '--iterations=1']
  if (after) {
    // systemd-analyze expects "YYYY-MM-DD HH:MM:SS UTC" for --base-time.
    const b = after
    const pad = (n: number) => String(n).padStart(2, '0')
    const base =
      `${b.getUTCFullYear()}-${pad(b.getUTCMonth() + 1)}-${pad(b.getUTCDate())} ` +
      `${pad(b.getUTCHours())}:${pad(b.getUTCMinutes())}:${pad(b.getUTCSeconds())} UTC`
    args.push(`--base-time=${base}`)
  }
  const res = spawnSync('systemd-analyze', args, {
    env: { ...process.env, TZ: 'UTC' },
    encoding: 'utf8',
  })
  if (res.status !== 0) {
    const err = (res.stderr || res.stdout || '').trim()
    throw new Error(`invalid calendar expression: ${err}`)
  }
  const m = res.stdout.match(/Next elapse:\s+\w+\s+(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})\s+UTC/)
  if (!m) throw new Error(`could not parse systemd-analyze output:\n${res.stdout}`)
  const iso = `${m[1]}T${m[2]}Z`
  const t = Date.parse(iso)
  if (isNaN(t)) throw new Error(`could not parse next-fire timestamp: ${iso}`)
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
  { name: 'scheduler', version: '0.2.0' },
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
      description: 'Schedule a message to be delivered back into this Claude session. Provide exactly one of `at` (ISO-8601 for one-shot) or `calendar` (systemd calendar expression for recurring). Returns the job id.',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'The message body to deliver when the job fires.' },
          at: {
            type: 'string',
            description: "One-shot fire time as ISO-8601 (e.g. '2026-04-17T09:00:00Z'). Mutually exclusive with calendar.",
          },
          calendar: {
            type: 'string',
            description: "systemd calendar expression for recurring fires, e.g. 'Mon..Fri 09:00', '*-*-* 0/2:00:00', 'hourly'. Mutually exclusive with at.",
          },
          max_executions: {
            type: 'number',
            description: 'Optional cap on total fires for a recurring job. Job auto-deletes when reached. Ignored for one-shot `at` jobs.',
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
    if (!at && !calendar) throw new Error('provide at (one-shot ISO-8601) or calendar (systemd calendar expression)')
    if (at && calendar) throw new Error('provide only one of at or calendar, not both')
    const title = typeof args.title === 'string' && args.title.trim() ? args.title.trim() : undefined
    const max = typeof args.max_executions === 'number' && args.max_executions > 0
      ? Math.floor(args.max_executions)
      : undefined

    let fire_at: number
    if (at) {
      fire_at = parseIsoAt(at)
    } else {
      fire_at = nextCalendarFire(calendar!)
    }

    const job: Job = {
      id: newId(),
      fire_at,
      text,
      ...(title ? { title } : {}),
      ...(calendar ? { calendar } : {}),
      ...(calendar && max ? { remaining_executions: max } : {}),
      execution_count: 0,
      created_at: Date.now(),
    }
    const store = loadJobs()
    store.jobs.push(job)
    saveJobs(store)
    const lines = [
      `${job.id} — fires in ${describeWhen(job.fire_at)} at ${new Date(job.fire_at).toISOString()}`,
    ]
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
    const sorted = [...store.jobs].sort((a, b) => a.fire_at - b.fire_at)
    const lines = sorted.map(j => {
      const when = `${describeWhen(j.fire_at)} (${new Date(j.fire_at).toISOString()})`
      const rec = j.calendar ? ` [${j.calendar}]` : ''
      const rem = j.remaining_executions !== undefined ? ` remaining=${j.remaining_executions}` : ''
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

async function tick(): Promise<void> {
  const store = loadJobs()
  if (store.jobs.length === 0) return
  const now = Date.now()
  const due = store.jobs.filter(j => j.fire_at <= now)
  if (due.length === 0) return
  let changed = false
  for (const job of due) {
    const meta: Record<string, string> = {
      scheduled_id: job.id,
      fired_at: new Date(now).toISOString(),
      originally_scheduled_for: new Date(job.fire_at).toISOString(),
      execution_count: String(job.execution_count + 1),
    }
    if (job.title) meta.title = job.title
    if (job.calendar) meta.calendar = job.calendar
    if (job.remaining_executions !== undefined) {
      meta.remaining_after = String(job.remaining_executions - 1)
    }
    try {
      await mcp.notification({
        method: 'notifications/claude/channel',
        params: { content: job.text, meta },
      })
    } catch (err) {
      process.stderr.write(`scheduler: failed to deliver job ${job.id}: ${err}\n`)
      // Leave the job alone so it retries on the next tick.
      continue
    }
    job.execution_count += 1
    if (job.remaining_executions !== undefined) {
      job.remaining_executions -= 1
    }
    const exhausted = job.remaining_executions !== undefined && job.remaining_executions <= 0
    if (job.calendar && !exhausted) {
      // Re-arm at the next scheduled instance strictly after now.
      try {
        job.fire_at = nextCalendarFire(job.calendar, new Date(now))
        changed = true
      } catch (err) {
        process.stderr.write(`scheduler: failed to re-arm ${job.id} (${job.calendar}): ${err}\n`)
        // Drop the job rather than loop-firing — bad state.
        store.jobs = store.jobs.filter(j => j.id !== job.id)
        changed = true
      }
    } else {
      store.jobs = store.jobs.filter(j => j.id !== job.id)
      changed = true
    }
  }
  if (changed) saveJobs(store)
}

await mcp.connect(new StdioServerTransport())
process.stderr.write(`scheduler: started, polling every ${POLL_MS}ms\n`)

setInterval(() => {
  tick().catch(err => process.stderr.write(`scheduler tick error: ${err}\n`))
}, POLL_MS)

// Fire once immediately after connect so any overdue jobs don't wait a full
// poll interval on startup.
tick().catch(err => process.stderr.write(`scheduler startup tick error: ${err}\n`))
