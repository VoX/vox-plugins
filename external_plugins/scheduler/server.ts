#!/usr/bin/env bun
/**
 * Scheduler channel for Claude Code.
 *
 * Schedules messages to be delivered back into this Claude session at a later
 * time. One-shot or repeating. State lives in ~/.claude/channels/scheduler/jobs.json
 * and survives plugin restarts — pending jobs keep firing after reboot.
 *
 * Delivered via the same notifications/claude/channel mechanism the discord
 * plugin uses, so scheduled fires land in the normal inbound context.
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

const STATE_DIR = process.env.SCHEDULER_STATE_DIR ?? join(homedir(), '.claude', 'channels', 'scheduler')
const JOBS_FILE = join(STATE_DIR, 'jobs.json')
const POLL_MS = 5000

type Job = {
  id: string
  fire_at: number
  text: string
  title?: string
  repeat_seconds?: number
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

function parseAt(at: string): number {
  const t = Date.parse(at)
  if (isNaN(t)) throw new Error(`invalid 'at' — expected ISO-8601 timestamp, got: ${at}`)
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
  { name: 'scheduler', version: '0.1.0' },
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
      "Use `schedule` to queue a message. Pass `delay_seconds` for short waits or `at` (ISO-8601) for a specific time. Add `repeat_seconds` for a recurring reminder (the job re-arms itself after each fire). Add an optional `title` for easier listing.",
      '',
      "Use `list_scheduled` to see what's pending, and `cancel` to drop a job by id.",
      '',
      "Jobs persist to ~/.claude/channels/scheduler/jobs.json so they survive restarts. A job whose fire_at is in the past when the plugin starts fires immediately on the next poll.",
    ].join('\n'),
  },
)

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'schedule',
      description: 'Schedule a message to be delivered back into this Claude session at a future time. Provide either delay_seconds (relative) or at (absolute ISO-8601). Add repeat_seconds to make it recurring. Returns the job id.',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'The message body to deliver when the job fires.' },
          delay_seconds: { type: 'number', description: 'Fire N seconds from now. Mutually exclusive with `at`.' },
          at: { type: 'string', description: "ISO-8601 timestamp for when to fire (e.g. '2026-04-17T09:00:00Z'). Mutually exclusive with delay_seconds." },
          repeat_seconds: { type: 'number', description: 'If set, re-schedule the same job to fire again N seconds after each fire. Omit for one-shot.' },
          title: { type: 'string', description: 'Optional short label shown in list_scheduled output.' },
        },
        required: ['text'],
      },
    },
    {
      name: 'list_scheduled',
      description: 'List all pending scheduled jobs, sorted by fire time.',
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
    const delay = typeof args.delay_seconds === 'number' ? args.delay_seconds : undefined
    const at = typeof args.at === 'string' ? args.at : undefined
    if (delay === undefined && !at) throw new Error('provide delay_seconds or at')
    if (delay !== undefined && at) throw new Error("provide only one of delay_seconds or at, not both")
    const fire_at = at ? parseAt(at) : Date.now() + Math.max(0, delay!) * 1000
    const repeat = typeof args.repeat_seconds === 'number' && args.repeat_seconds > 0 ? args.repeat_seconds : undefined
    const title = typeof args.title === 'string' && args.title.trim() ? args.title.trim() : undefined
    const job: Job = {
      id: newId(),
      fire_at,
      text,
      ...(title ? { title } : {}),
      ...(repeat ? { repeat_seconds: repeat } : {}),
      created_at: Date.now(),
    }
    const store = loadJobs()
    store.jobs.push(job)
    saveJobs(store)
    const line = `${job.id} — fires in ${describeWhen(job.fire_at)} at ${new Date(job.fire_at).toISOString()}` +
      (repeat ? ` (repeats every ${repeat}s)` : '') +
      (title ? `\ntitle: ${title}` : '')
    return { content: [{ type: 'text', text: line }] }
  }

  if (name === 'list_scheduled') {
    const store = loadJobs()
    if (store.jobs.length === 0) return { content: [{ type: 'text', text: 'no scheduled jobs' }] }
    const sorted = [...store.jobs].sort((a, b) => a.fire_at - b.fire_at)
    const lines = sorted.map(j => {
      const when = `${describeWhen(j.fire_at)} (${new Date(j.fire_at).toISOString()})`
      const rep = j.repeat_seconds ? ` repeat=${j.repeat_seconds}s` : ''
      const ttl = j.title ? ` [${j.title}]` : ''
      const preview = j.text.length > 80 ? j.text.slice(0, 77) + '…' : j.text
      return `${j.id}  ${when}${rep}${ttl}\n  ${preview}`
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
    }
    if (job.title) meta.title = job.title
    if (job.repeat_seconds) meta.repeat_seconds = String(job.repeat_seconds)
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
    if (job.repeat_seconds) {
      // Re-arm for next fire. If we've drifted past multiple intervals
      // (process was asleep), catch up to the next future boundary so we
      // don't fire a burst.
      let next = job.fire_at + job.repeat_seconds * 1000
      while (next <= now) next += job.repeat_seconds * 1000
      job.fire_at = next
      changed = true
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
