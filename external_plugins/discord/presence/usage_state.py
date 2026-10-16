#!/usr/bin/env python3
"""Synchronous quota marker hook; no timers, model calls, or network access.

Invoke with --failure (StopFailure) or --success (Stop), passing hook JSON on
stdin. Only the three documented directory environment variables are read.
The injectable process tree and clock are Python-only test seams, not CLI flags.
"""

import json
import os
from pathlib import Path
import re
import sys
import tempfile
import time
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

MARKER = ".presence-usage-limit.json"
MAX_INPUT = 65536
_SAFE_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}\Z")
_ISO = re.compile(
    r"\bresets?(?:_at)?\b[\"']?\s*(?:[:=]\s*|at\s+)?[\"']?"
    r"(\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}"
    r"(?::\d{2}(?:\.\d{1,6})?)?(?:[Zz]|[+-]\d{2}:?\d{2}))(?![\w:+-])"
    , re.IGNORECASE
)
_CLOCK = re.compile(
    r"\bresets?\s+(?:at\s+)?"
    r"(?:(\d{1,2})(?::(\d{2}))?\s*(am|pm)|(noon|midday|midnight))"
    r"\s*\(([^()\s]{1,128})\)", re.IGNORECASE
)


def config_directory():
    config = os.environ.get("CLAUDE_CONFIG_DIR")
    if not config:
        home = os.environ.get("HOME")
        if not home:
            return None
        config = str(Path(home) / ".claude")
    return Path(config)


def state_directory():
    """Resolve only the explicitly supported configuration paths."""
    override = os.environ.get("DISCORD_STATE_DIR")
    if override:
        return Path(override)
    config = config_directory()
    return config / "channels" / "discord" if config is not None else None


def _first_pid(lock):
    # Stop at the first token. In particular, never interpret the timestamp or
    # any later PID as the bridge owner, even if the first PID is stale.
    token = bytearray()
    with lock.open("rb") as stream:
        for _ in range(64):
            char = stream.read(1)
            if not char or char in b" \t\r\n":
                if token or not char:
                    break
                continue
            if not b"0" <= char <= b"9" or len(token) >= 10:
                raise ValueError("invalid lock")
            token.extend(char)
        else:
            raise ValueError("invalid lock")
    pid = int(token)
    if not 1 < pid <= 2147483647:
        raise ValueError("invalid PID")
    return pid


def _parent_pid(proc_root, pid):
    with (proc_root / str(pid) / "status").open("rb") as stream:
        status = stream.read(65537)
    if len(status) > 65536:
        raise ValueError("invalid status")
    parents = [line for line in status.splitlines() if line.startswith(b"PPid:")]
    if len(parents) != 1 or not re.fullmatch(rb"PPid:\s*[0-9]+\s*", parents[0]):
        raise ValueError("invalid status")
    parent = int(parents[0].split(b":", 1)[1])
    if not 0 <= parent <= 2147483647 or parent == pid:
        raise ValueError("invalid parent")
    return parent


def _executable(proc_root, pid):
    executable = os.readlink(proc_root / str(pid) / "exe")
    if not executable.startswith("/"):
        raise ValueError("invalid executable")
    return executable


def _is_claude_executable(executable, expected_executable):
    """Recognize native old/new versions without reading argv or environment.

    An updater can replace the launcher while main Claude still runs the old
    version. A nested new-version CLI must not be skipped on the way to main.
    Unknown same-runtime binaries also fail closed via exact equality.
    """
    if executable == expected_executable:
        return True
    path = Path(executable.removesuffix(" (deleted)"))
    if path.name in ("claude", "claude-code"):
        return True
    return (path.parent.name == "versions" and path.parent.parent.name == "claude"
            and re.fullmatch(r"\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?", path.name) is not None)


def is_main_session(state_dir, *, session_id, sessions_dir,
                    proc_root=Path("/proc"), start_pid=None):
    """Fail closed; the *nearest* matching executable must be bridge's parent.

    A nested print/subagent Claude often has precisely the same executable as
    main Claude. Finding main somewhere farther up the tree is NOT sufficient.
    No environment, command lines, or transcript data are inspected here.
    """
    try:
        proc_root = Path(proc_root)
        bridge = _first_pid(Path(state_dir) / "bridge.lock")
        expected = _parent_pid(proc_root, bridge)
        if expected <= 1:
            return False
        # Native session discovery metadata contains no credentials. Matching
        # its session ID also rejects nested npm/differently packaged CLIs that
        # cannot be reliably recognized by executable filename alone.
        with (Path(sessions_dir) / (str(expected) + ".json")).open("rb") as stream:
            metadata = stream.read(8193)
        if len(metadata) > 8192:
            return False
        main_session = json.loads(metadata)
        if not isinstance(main_session, dict) or main_session.get("pid") != expected:
            return False
        if main_session.get("sessionId") != session_id:
            return False
        expected_exe = _executable(proc_root, expected)
        pid = os.getppid() if start_pid is None else start_pid
        seen = set()
        for _ in range(256):
            if type(pid) is not int or pid <= 0 or pid in seen:
                return False
            seen.add(pid)
            parent = _parent_pid(proc_root, pid)
            executable = _executable(proc_root, pid)
            if _is_claude_executable(executable, expected_exe):
                return pid == expected
            pid = parent
    except (OSError, ValueError, TypeError, OverflowError):
        return False
    return False


def parse_reset(event, now_ms):
    """Extract only an explicitly zoned hint from the two permitted strings.

    ISO timestamps are absolute (even when already past). Clock-only hints use
    the next real occurrence in that explicit zone. Round trips exclude DST
    gaps, and both folds are checked during a repeated hour. Reset is display
    information only; nothing here schedules or performs a clear.
    """
    texts = [event.get(key) for key in ("error_details", "last_assistant_message")]
    texts = [text for text in texts if isinstance(text, str)]
    for text in texts:
        for match in _ISO.finditer(text):
            try:
                value = match.group(1).replace("t", "T").replace("z", "+00:00").replace("Z", "+00:00")
                # Python 3.9 requires the colon in numeric UTC offsets.
                value = re.sub(r"([+-]\d{2})(\d{2})$", r"\1:\2", value)
                parsed = datetime.fromisoformat(value)
                if parsed.tzinfo is not None:
                    return int(parsed.timestamp() * 1000)
            except (ValueError, OverflowError, OSError):
                continue
    for text in texts:
        for match in _CLOCK.finditer(text):
            hour, minute, period, word, zone = match.groups()
            try:
                tz = ZoneInfo(zone)
                if word:
                    hour, minute = (0 if word.lower() == "midnight" else 12), 0
                else:
                    hour, minute = int(hour), int(minute or 0)
                    if not 1 <= hour <= 12 or not 0 <= minute <= 59:
                        continue
                    hour = hour % 12 + (12 if period.lower() == "pm" else 0)
                local = datetime.fromtimestamp(now_ms / 1000, tz)
                candidates = []
                for day in range(4):
                    date = local.date() + timedelta(days=day)
                    wall = datetime(date.year, date.month, date.day, hour, minute)
                    for fold in (0, 1):
                        candidate = wall.replace(tzinfo=tz, fold=fold)
                        stamp = candidate.timestamp()
                        if datetime.fromtimestamp(stamp, tz).replace(tzinfo=None) != wall:
                            continue
                        milliseconds = int(stamp * 1000)
                        if milliseconds > now_ms:
                            candidates.append(milliseconds)
                if candidates:
                    return min(candidates)
            except (ZoneInfoNotFoundError, ValueError, OverflowError, OSError):
                continue
    return None


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate key")
        result[key] = value
    return result


def _invalid_constant(_value):
    raise ValueError("invalid JSON constant")


def read_event(stream):
    """Read at most MAX_INPUT + 1 bytes; never log input or JSON exceptions."""
    try:
        raw = stream.read(MAX_INPUT + 1)
        if len(raw) > MAX_INPUT:
            return None
        event = json.loads(raw, object_pairs_hook=_unique_object,
                           parse_constant=_invalid_constant)
        return event if isinstance(event, dict) else None
    except (ValueError, TypeError, RecursionError, OSError):
        return None


# Official Z.ai business codes, not HTTP status codes. Unknown structured
# codes do not establish exhaustion; unstructured native rate_limit events
# retain the generic (e.g. Anthropic) behavior.
_ZAI_USAGE_CODES = frozenset({1113, 1308, 1309, 1310, 1314, *range(1316, 1322)})
_API_ERROR_PREFIX = re.compile(r"^API\s*Error:\s*[1-5][0-9]{2}\s+")
_ZAI_FLATTENED = re.compile(
    r"^API\s*Error:\s*[^\r\n()\[\]]{1,128}\(429\)\s*·\s*"
    r"\[([1-9][0-9]{3})\]\[[^\]\r\n]{0,32768}\](?:\[[^\]\r\n]{0,1024}\])?\s*$"
)


def parse_zai_code(event):
    """Read only error_details' exact error.code envelope, never message text.

    Accept a JSON object or its JSON serialization, optionally preceded by the
    native 'APIError: 429 ' wrapper. No scanning for numbers or JSON fragments.
    A code alone does not authenticate a provider; only the documented usage
    allowlist is used to interpret structured business errors.
    """
    details = event.get("error_details")
    if isinstance(details, str):
        if len(details) > MAX_INPUT:
            return None
        # Claude's Z.ai compatibility transport flattens the provider envelope:
        # API Error: ... (429) · [1310][provider message][provider tag]
        # This is an anchored native wrapper, never a number search in prose.
        flattened = _ZAI_FLATTENED.fullmatch(details.strip())
        if flattened:
            return int(flattened.group(1))
        details = _API_ERROR_PREFIX.sub("", details.strip(), count=1)
        try:
            details = json.loads(details, object_pairs_hook=_unique_object,
                                 parse_constant=_invalid_constant)
        except (ValueError, TypeError, RecursionError):
            return None
    if not isinstance(details, dict) or not isinstance(details.get("error"), dict):
        return None
    code = details["error"].get("code")
    if type(code) is int and 1000 <= code <= 9999:
        return code
    if isinstance(code, str) and re.fullmatch(r"[1-9][0-9]{3}", code):
        return int(code)
    return None


def _write_marker(state_dir, state):
    state_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    # mkstemp is exclusive and mode 0600. Replace never follows a marker symlink.
    descriptor, name = tempfile.mkstemp(prefix=MARKER + ".tmp-", dir=state_dir)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            os.fchmod(stream.fileno(), 0o600)
            json.dump(state, stream, separators=(",", ":"), allow_nan=False)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(name, state_dir / MARKER)
    finally:
        try:
            os.unlink(name)
        except FileNotFoundError:
            pass


def handle_event(mode, event, state_dir, *, proc_root=Path("/proc"),
                 start_pid=None, now_ms=None, sessions_dir=None):
    """Return whether a valid, main-session event was handled."""
    if not isinstance(event, dict) or state_dir is None:
        return False
    if event.get("agent_id") not in (None, ""):
        return False
    session_id = event.get("session_id")
    if not isinstance(session_id, str) or not _SAFE_ID.fullmatch(session_id):
        return False
    if mode == "--failure":
        if event.get("hook_event_name") != "StopFailure" or event.get("error") != "rate_limit":
            return False
        code = parse_zai_code(event)
        if code is not None and code not in _ZAI_USAGE_CODES:
            return False
    elif mode == "--success":
        if event.get("hook_event_name") != "Stop" or event.get("error") not in (None, ""):
            return False
    else:
        return False
    state_dir = Path(state_dir)
    if sessions_dir is None:
        config = config_directory()
        if config is None:
            return False
        sessions_dir = config / "sessions"
    if not is_main_session(state_dir, session_id=session_id, sessions_dir=sessions_dir,
                           proc_root=proc_root, start_pid=start_pid):
        return False
    if mode == "--success":
        try:
            (state_dir / MARKER).unlink()
        except FileNotFoundError:
            pass
    else:
        blocked_at = time.time_ns() // 1000000 if now_ms is None else now_ms
        _write_marker(state_dir, {
            "version": 1,
            "error": "rate_limit",
            "blocked_at": blocked_at,
            "reset_at": parse_reset(event, blocked_at),
            "session_id": session_id,
        })
    return True


def main():
    # Deliberately no process-root/PID/clock overrides in the production CLI.
    if len(sys.argv) != 2 or sys.argv[1] not in ("--failure", "--success"):
        return 0
    event = read_event(sys.stdin.buffer)
    if event is None:
        return 0
    try:
        handle_event(sys.argv[1], event, state_directory())
    except (OSError, ValueError, TypeError, OverflowError):
        # Hook failures must not initiate another turn or expose any payload.
        sys.stderr.write("presence usage state: operation failed\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
