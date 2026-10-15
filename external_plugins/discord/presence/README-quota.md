# Usage-limit presence

`StopFailure` with `error=rate_limit` runs `usage_state.py --failure` outside
the model. It writes an atomic, mode-0600 `.presence-usage-limit.json` in the
Discord state directory. The bridge holds a DND alarm above ordinary activity
and manual status pins; the authentication alarm still has highest priority.
The marker survives bridge/service restarts, and it is the first presence sent
on startup rather than a brief false-idle update.

A successful main-session `Stop` runs `usage_state.py --success` and clears the
quota marker. Session shutdown, subagent stops, ordinary tool activity and the
passing of a reset time do not clear it. A deadline is display information,
not proof that every usage bucket has recovered. If the reset hint is not
explicitly zoned, the status stays generic instead of guessing a time.

The hook uses Python 3.9+ and Linux `/proc` metadata. It verifies that the bridge
parent is the nearest Claude ancestor, including old/new native versions, and
matches the native main session's `sessions/PID.json` session ID. Nonempty
`agent_id`, nested sessions, missing metadata and ambiguous process trees fail
closed. It does not inspect credentials, environment contents, command lines
or transcripts, and never stores raw provider errors.

Tests are offline: `bun test` exercises the real bridge presence functions with
synthetic IO and checks declaration wiring; `python3 -m unittest discover -s
presence -p 'test_usage_state.py'` checks hook behavior against temporary process
trees. No live account or Discord login is needed.

On an instance already blocked before this hook was installed, a new rejected
turn will seed the marker automatically. A maintenance deployment may instead
seed the same schema from a previously verified native rate-limit event; it
must not invent a reset time or run an extra model call just to create a status.