# Scheduler

Schedule messages to your own Claude Code session — one-shot, recurring via systemd calendar expressions, or fire-on-next-startup. Useful for reminders, recurring audits ("check the deploy every hour"), and auto-triggering a turn after you restart yourself.

Fires arrive via the same `notifications/claude/channel` mechanism the discord plugin uses, so the scheduled message lands in your context as a fresh turn from "past-you":

```
<channel source="scheduler" scheduled_id="sched_..." fired_at="..." originally_scheduled_for="..." execution_count="1" title="...">
your message body here
</channel>
```

## Prerequisites

- [Bun](https://bun.sh) — the MCP server runs on Bun. Install with `curl -fsSL https://bun.sh/install | bash`.
- `systemd-analyze` on `PATH` — only required if you use `calendar` expressions. One-shot `at` and `on_startup` jobs work without it.

## Install

```
/plugin install scheduler@vox-plugins
/reload-plugins
```

Jobs persist to `~/.claude/channels/scheduler/jobs.json` and survive restarts. Override the state directory with `SCHEDULER_STATE_DIR`.

## Tools exposed to the assistant

| Tool | Purpose |
| --- | --- |
| `schedule` | Queue a message. Required: `text`. Provide exactly one of `at` (ISO-8601 one-shot), `calendar` (systemd calendar expression, recurring), or `on_startup` (fires once on the next scheduler boot, then deletes itself). Optional: `title` (short label shown in `list_scheduled`), `max_executions` (cap for recurring jobs — auto-deletes when reached). Returns the job id. |
| `list_scheduled` | List all pending jobs, sorted by next fire time. Shows id, when, recurrence, remaining executions, fire count, title, and a text preview. |
| `cancel` | Cancel a pending job by id. |

## Calendar expressions

Any systemd calendar expression works — it's parsed by `systemd-analyze calendar`. Times are always UTC.

| Expression | Fires |
| --- | --- |
| `*-*-* 09:00:00` | daily at 09:00 UTC |
| `Mon..Fri 09:00` | weekdays at 09:00 |
| `Mon *-*-* 10:00` | Mondays at 10:00 |
| `*-*-* 0/2:00:00` | every 2 hours on the hour |
| `*:0/15` | every 15 minutes |
| `hourly` | top of every hour |

Full grammar: `man 7 systemd.time` → CALENDAR EVENTS.

## on_startup jobs

Set `on_startup: true` to queue a message that fires once when the scheduler server next boots — useful for auto-triggering a turn after you restart yourself (env var changes, plugin updates, config reloads). The job deletes itself after firing.

Delivery is deferred ~20s past scheduler boot because claude-code's turn queue isn't ready to enqueue new turns until the `--resume` transcript finishes loading. Earlier fires get silently dropped.

## Back-scheduling

One-shot `at` timestamps more than 60 seconds in the past are rejected — almost never what the caller wanted, and silent back-fires are confusing. Close-to-now is allowed to tolerate clock drift.

## State

All state lives in `~/.claude/channels/scheduler/`:

- `jobs.json` — pending jobs (0600)
- `debug.log` — notification delivery trace, appended to every fire

`jobs.json` contains notification text that re-enters your Claude context, so it's a prompt-injection vector if shared — the plugin writes it 0600 and the state dir 0700.
