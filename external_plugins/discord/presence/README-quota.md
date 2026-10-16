# Usage-limit presence

`StopFailure` with `error=rate_limit` runs `usage_state.py --failure` outside
the model (the native client must actually emit this hook; clients lacking
`StopFailure` cannot seed it). Eligible usage failures write an atomic, mode-0600 `.presence-usage-limit.json` in the
Discord state directory. The bridge holds a DND alarm above ordinary activity
and manual status pins; the authentication alarm still has highest priority.
The marker survives bridge/service restarts, and it is the first presence sent
on startup rather than a brief false-idle update.

### Z.ai classification

Only `error_details` is parsed for a structured `{"error":{"code":"1310",...}}`
body: a dict, strict JSON string, native `API Error: 429 ` + JSON string,
or the anchored compatibility form `API Error: ... (429) · [1310][message][tag]`.
Business codes may be four-digit integers or digit strings, not booleans or
floats. Neither arbitrary numbers in prose nor `last_assistant_message` classify
a business error. Duplicate JSON keys and non-JSON constants are rejected.

The usage allowlist follows [Z.ai's official API codes](https://docs.z.ai/api-reference/api-code.md):
1113 (balance), 1308 (usage window), 1309/1314 (expired plan), 1310
(weekly/monthly exhaustion), and 1316–1321 (five-hour/seven-day/credit/monthly
spend caps). These keep the persistent DND marker. Structured nonusage errors,
including 1302 (request throttle), 1305 (temporary overload), 1311 (model
eligibility), 1313 (fair-use frequency) and 1315 (wrong key product), do **not**
create or clear a marker. Other structured codes (including known auth/parameter
errors and undocumented codes such as 1380) likewise do not establish exhaustion
and preserve any existing hold. The hook matcher remains exactly `rate_limit`;
it does not broaden to authentication, bad-request or unknown native error kinds.
Unstructured native `rate_limit` events retain generic Anthropic-compatible
behavior. No business code, provider payload, message or credential is persisted.

Unknown reset times remain JSON `null`. Z.ai messages with naive timestamps do
not imply a timezone; existing explicitly zoned reset parsing remains unchanged.

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