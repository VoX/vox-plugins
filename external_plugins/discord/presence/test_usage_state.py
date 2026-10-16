"""Offline tests: all process metadata and writable state are synthetic."""

import io
import json
import os
from pathlib import Path
import stat
import tempfile
import unittest
from unittest.mock import patch
from datetime import datetime

try:
    from . import usage_state as hook
except ImportError:
    import usage_state as hook


def epoch(value):
    return int(datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp() * 1000)


class UsageStateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.state = self.root / "state"
        self.state.mkdir()
        self.proc = self.root / "proc"
        self.proc.mkdir()
        self.sessions = self.root / "sessions"
        self.sessions.mkdir()
        (self.sessions / "100.json").write_text(json.dumps({"pid": 100, "sessionId": "main-session_123"}))
        self.process(1, 0, "/sbin/init")
        self.process(100, 1, "/opt/claude")
        self.process(200, 100, "/opt/bun")  # bridge
        self.process(300, 100, "/bin/bash")  # main hook's parent
        self.lock = self.state / "bridge.lock"
        self.lock.write_text("200 2026-01-01T00:00:00Z\n")
        self.marker = self.state / hook.MARKER
        self.now = epoch("2026-01-15T19:00:00Z")
        self.failure = {
            "hook_event_name": "StopFailure", "error": "rate_limit",
            "session_id": "main-session_123", "error_details": "resets 12am (UTC)",
        }
        self.success = {"hook_event_name": "Stop", "session_id": "main-session_123"}

    def process(self, pid, parent, executable):
        directory = self.proc / str(pid)
        directory.mkdir(exist_ok=True)
        (directory / "status").write_text("Name:\tfixture\nPid:\t%d\nPPid:\t%d\n" % (pid, parent))
        exe = directory / "exe"
        if exe.is_symlink():
            exe.unlink()
        exe.symlink_to(executable)

    def handle(self, mode="--failure", event=None, start=300):
        return hook.handle_event(mode, self.failure if event is None else event,
                                 self.state, proc_root=self.proc, start_pid=start,
                                 now_ms=self.now, sessions_dir=self.sessions)

    def seed(self):
        self.marker.write_bytes(b"existing marker\n")

    def assert_preserved(self, mode, event, start=300):
        self.seed()
        self.assertFalse(self.handle(mode, event, start))
        self.assertEqual(self.marker.read_bytes(), b"existing marker\n")

    def test_failure_exact_schema_and_success(self):
        lock_before = self.lock.read_bytes()
        self.assertTrue(self.handle())
        self.assertEqual(json.loads(self.marker.read_text()), {
            "version": 1, "error": "rate_limit", "blocked_at": self.now,
            "reset_at": epoch("2026-01-16T00:00:00Z"), "session_id": "main-session_123",
        })
        self.assertEqual(set(p.name for p in self.state.iterdir()), {"bridge.lock", hook.MARKER})
        self.assertTrue(self.handle("--success", self.success))
        self.assertFalse(self.marker.exists())
        self.assertTrue(self.handle("--success", self.success))  # idempotent
        self.assertEqual(self.lock.read_bytes(), lock_before)

    def test_zai_usage_business_codes_and_no_sensitive_payload(self):
        for code in (1113, 1308, 1309, 1310, 1314, *range(1316, 1322)):
            for value in (code, str(code)):
                body = {"error": {"code": value,
                                  "message": "PRIVATE quota exhausted; resets at 2026-10-16T08:00:00"}}
                for details in (body, json.dumps(body), "APIError: 429 " + json.dumps(body),
                                "API Error: 429 " + json.dumps(body),
                                "API Error: Request limited (429) · [%s][PRIVATE quota exhausted][provider]" % code):
                    with self.subTest(code=value, details_type=type(details)):
                        self.assertTrue(self.handle(event=dict(self.failure, error_details=details)))
                        marker = json.loads(self.marker.read_text())
                        self.assertIsNone(marker["reset_at"])
                        self.assertNotIn("PRIVATE", self.marker.read_text())
                        self.assertEqual(set(marker), {"version", "error", "blocked_at",
                                                      "reset_at", "session_id"})

    def test_zai_nonusage_and_unknown_codes_neither_create_nor_clear(self):
        # Known transient/model/key/fair-use errors, known auth/parameter
        # errors, and undocumented codes must not imply persistent exhaustion.
        for code in (1302, 1305, 1311, 1313, 1315, 1000, 1001, 1002, 1003,
                     1004, 1100, 1380):
            for value in (code, str(code)):
                event = dict(self.failure, error_details='APIError: 429 ' + json.dumps(
                    {"error": {"code": value, "message": "PRIVATE"}}))
                self.marker.unlink(missing_ok=True)
                self.assertFalse(self.handle(event=event))
                self.assertFalse(self.marker.exists())
                self.assert_preserved("--failure", event)

    def test_business_codes_not_inferred_from_arbitrary_text_or_model(self):
        for details in ("request 1302; model 1310", "APIError: 429 quota 1302",
                        {"message": "1302"}, {"code": "1302"}):
            event = dict(self.failure, error_details=details,
                         last_assistant_message='{"error":{"code":"1302"}}')
            self.assertIsNone(hook.parse_zai_code(event))
            self.assertTrue(self.handle(event=event))  # generic native rate_limit

    def test_strict_structured_error_parser(self):
        for code in (True, False, 1310.0, None, [], {}, " 1310", "+1310", "01310", "1310x"):
            self.assertIsNone(hook.parse_zai_code({"error_details": {"error": {"code": code}}}))
        for details in ('prefix {"error":{"code":"1310"}}',
                        'APIError: 429 {"error":{"code":"1310"}} trailing',
                        '{"error":{"code":"1310","code":"1302"}}',
                        '{"error":{"code":"1310"},"x":NaN}',
                        '[' * 2000 + ']' * 2000):
            self.assertIsNone(hook.parse_zai_code({"error_details": details}))

    def test_actual_native_flattened_zai_wrapper_and_negative_framing(self):
        for code in (1302, 1305, 1311, 1313, 1315, 1380):
            details = "API Error: Request limited (429) · [%s][PRIVATE message][provider]" % code
            self.assertEqual(hook.parse_zai_code({"error_details": details}), code)
            self.marker.unlink(missing_ok=True)
            self.assertFalse(self.handle(event=dict(self.failure, error_details=details)))
            self.assertFalse(self.marker.exists())
            self.assert_preserved("--failure", dict(self.failure, error_details=details))
        for details in ("arbitrary [1310][message]", "API Error: Request limited · [1310][message]",
                        "API Error: Request limited (503) · [1310][message]",
                        "API Error: Request limited (429) · [1310]",
                        "prefix API Error: Request limited (429) · [1310][message]",
                        "API Error: Request limited (429) · [1310][message]\nforged"):
            self.assertIsNone(hook.parse_zai_code({"error_details": details}))
        self.assertIsNone(hook.parse_zai_code({"last_assistant_message":
            "API Error: Request limited (429) · [1310][message][provider]"}))

    def test_permissions_even_when_replacing_permissive_marker(self):
        self.seed()
        self.marker.chmod(0o666)
        old_umask = os.umask(0)
        try:
            self.assertTrue(self.handle())
        finally:
            os.umask(old_umask)
        self.assertEqual(stat.S_IMODE(self.marker.stat().st_mode), 0o600)

    def test_no_raw_text_or_unapproved_fields_stored(self):
        event = dict(self.failure, error_details="PRIVATE TEXT resets 8pm (America/New_York)",
                     last_assistant_message="PRIVATE MESSAGE", transcript_path="PRIVATE PATH",
                     reset_at="PRIVATE RESET", arbitrary="PRIVATE VALUE")
        self.assertTrue(self.handle(event=event))
        self.assertNotIn("PRIVATE", self.marker.read_text())
        self.assertEqual(json.loads(self.marker.read_text())["reset_at"], epoch("2026-01-16T01:00:00Z"))

    def test_wrong_error_event_and_mode_preserve(self):
        for event in (dict(self.failure, error="authentication_failed"),
                      dict(self.failure, error=None),
                      dict(self.failure, error="rate_limit extra"),
                      dict(self.failure, hook_event_name="Stop"),
                      dict(self.failure, hook_event_name="SessionEnd"),
                      dict(self.failure, hook_event_name="SessionStart")):
            with self.subTest(event=event):
                self.assert_preserved("--failure", event)
        for event in (self.failure, dict(self.success, error="rate_limit"),
                      dict(self.success, hook_event_name="SessionEnd")):
            self.assert_preserved("--success", event)
        self.assert_preserved("--other", self.failure)

    def test_subagent_agent_id_cannot_pin_or_clear(self):
        for agent in ("subagent-1", " ", 123, [], {}):
            with self.subTest(agent=agent):
                for mode, event in (("--failure", self.failure), ("--success", self.success)):
                    self.assert_preserved(mode, dict(event, agent_id=agent))
        self.assertTrue(self.handle(event=dict(self.failure, agent_id="")))

    def test_nested_same_executable_rejected_first(self):
        self.process(400, 100, "/opt/claude")
        self.process(500, 400, "/bin/bash")
        self.assert_preserved("--failure", self.failure, start=500)
        self.assert_preserved("--success", self.success, start=500)
        self.assert_preserved("--failure", self.failure, start=400)
        self.assertTrue(self.handle(start=100))

    def test_wrong_main_tree(self):
        self.process(600, 1, "/opt/claude")
        self.process(700, 600, "/bin/bash")
        self.assert_preserved("--failure", self.failure, start=700)
        self.assert_preserved("--success", self.success, start=700)

    def test_nested_new_native_version_cannot_pin_or_clear(self):
        self.process(100, 1, "/home/bot/.local/share/claude/versions/2.1.296")
        self.process(400, 100, "/home/bot/.local/share/claude/versions/2.1.301")
        self.process(500, 400, "/bin/bash")
        self.assert_preserved("--failure", self.failure, start=500)
        self.assert_preserved("--success", self.success, start=500)
        self.assertTrue(self.handle(start=300))

    def test_nested_native_version_in_another_home_is_rejected(self):
        self.process(100, 1, "/home/bot/.local/share/claude/versions/2.1.296 (deleted)")
        self.process(400, 100, "/opt/other/.local/share/claude/versions/2.1.301")
        self.process(500, 400, "/bin/bash")
        self.assert_preserved("--failure", self.failure, start=500)
        self.assert_preserved("--success", self.success, start=500)
        self.assertTrue(self.handle(start=300))

    def test_different_nested_session_is_rejected_even_with_an_unknown_runtime(self):
        self.process(400, 100, "/opt/new-runtime/node")
        self.process(500, 400, "/bin/bash")
        self.assert_preserved("--failure", dict(self.failure, session_id="nested-session"), start=500)
        self.assert_preserved("--success", dict(self.success, session_id="nested-session"), start=500)

    def test_missing_or_mismatched_main_session_metadata_fails_closed(self):
        path = self.sessions / "100.json"
        for data in ("{", "null", json.dumps({"pid": 999, "sessionId": "main-session_123"}),
                     json.dumps({"pid": 100, "sessionId": "other-session"})):
            path.write_text(data)
            self.assert_preserved("--failure", self.failure)
            self.assert_preserved("--success", self.success)
        path.unlink()
        self.assert_preserved("--failure", self.failure)

    def test_missing_stale_and_malformed_bridge_lock(self):
        self.lock.unlink()
        self.assert_preserved("--failure", self.failure)
        self.assert_preserved("--success", self.success)
        for content in ("", "0", "1", "-200", "200junk", "200.0", "999 200", "x 200",
                        "2147483648", "9" * 100):
            with self.subTest(content=content):
                self.lock.write_text(content)
                self.assert_preserved("--failure", self.failure)
                self.assert_preserved("--success", self.success)

    def test_only_first_lock_pid_is_used(self):
        self.lock.write_bytes(b" \t200 999999\xff arbitrary trailing bytes\n")
        self.assertTrue(self.handle())

    def test_bad_proc_status_fails_closed(self):
        for pid in (200, 300, 100):
            status = self.proc / str(pid) / "status"
            original = status.read_bytes()
            for content in (b"", b"PPid: garbage\n", b"PPid: -1\n", b"PPid: 100\nPPid: 100\n",
                            ("PPid: %d\n" % pid).encode(), b"X" * 65537):
                with self.subTest(pid=pid, content=content[:40]):
                    status.write_bytes(content)
                    self.assert_preserved("--failure", self.failure)
                    self.assert_preserved("--success", self.success)
            status.unlink()
            self.assert_preserved("--failure", self.failure)
            status.write_bytes(original)

    def test_missing_executable_fails_closed(self):
        for pid in (100, 300):
            exe = self.proc / str(pid) / "exe"
            target = os.readlink(exe)
            exe.unlink()
            self.assert_preserved("--failure", self.failure)
            self.assert_preserved("--success", self.success)
            exe.symlink_to(target)

    def test_cycle_or_no_main_ancestor_fails_closed(self):
        self.process(300, 301, "/bin/bash")
        self.process(301, 300, "/bin/sh")
        self.assert_preserved("--failure", self.failure)
        self.process(300, 1, "/bin/bash")
        self.assert_preserved("--success", self.success)

    def test_safe_session_id_required(self):
        for session in (None, "", "../secret", "line\nbreak", "x" * 129, 12, "name with spaces"):
            for mode, event in (("--failure", self.failure), ("--success", self.success)):
                self.assert_preserved(mode, dict(event, session_id=session))

    def test_invalid_events_do_not_touch_proc(self):
        with patch.object(hook, "is_main_session", side_effect=AssertionError("guard should not run")):
            for event in (None, [], 1, {}, {"hook_event_name": "SessionEnd"}):
                self.assertFalse(hook.handle_event("--failure", event, self.state))

    def test_no_timer_clear_and_restart_events_preserve(self):
        self.handle(event=dict(self.failure, error_details="resets at 2020-01-01T00:00:00Z"))
        before = self.marker.read_bytes()
        for name in ("SessionEnd", "SessionStart", "UserPromptSubmit"):
            self.assertFalse(self.handle("--success", dict(self.success, hook_event_name=name)))
        self.assertEqual(self.marker.read_bytes(), before)
        self.assertEqual(json.loads(before)["reset_at"], epoch("2020-01-01T00:00:00Z"))

    def test_marker_symlink_does_not_modify_target(self):
        target = self.root / "untouched"
        target.write_text("keep")
        self.marker.symlink_to(target)
        self.assertTrue(self.handle())
        self.assertFalse(self.marker.is_symlink())
        self.assertEqual(target.read_text(), "keep")
        self.marker.unlink()
        self.marker.symlink_to(target)
        self.assertTrue(self.handle("--success", self.success))
        self.assertEqual(target.read_text(), "keep")

    def test_failed_replace_cleans_temporary_file(self):
        self.seed()
        with patch.object(hook.os, "replace", side_effect=OSError("sensitive error")):
            with self.assertRaises(OSError):
                self.handle()
        self.assertEqual(self.marker.read_bytes(), b"existing marker\n")
        self.assertEqual(set(p.name for p in self.state.iterdir()), {"bridge.lock", hook.MARKER})

    def test_atomic_writer_can_create_directory(self):
        directory = self.root / "new" / "nested"
        hook._write_marker(directory, {"version": 1})
        self.assertEqual(json.loads((directory / hook.MARKER).read_text()), {"version": 1})
        # Public handling still fails closed if no bridge exists; it must not
        # manufacture missing lock/proc information just to create a marker.
        absent = self.root / "absent"
        self.assertFalse(hook.handle_event("--failure", self.failure, absent,
                                          proc_root=self.proc, start_pid=300))
        self.assertFalse(absent.exists())


class ResetTests(unittest.TestCase):
    def test_clock_cases(self):
        now = epoch("2026-01-15T19:00:00Z")
        cases = {
            "resets 12am (UTC)": "2026-01-16T00:00:00Z",
            "resets 12pm (UTC)": "2026-01-16T12:00:00Z",
            "resets midnight (UTC)": "2026-01-16T00:00:00Z",
            "resets noon (UTC)": "2026-01-16T12:00:00Z",
            "reset at midday (UTC)": "2026-01-16T12:00:00Z",
            "resets 8pm (America/New_York)": "2026-01-16T01:00:00Z",
            "resets 7:30 PM (UTC)": "2026-01-15T19:30:00Z",
            "resets 7pm (UTC)": "2026-01-16T19:00:00Z",  # strictly next
        }
        for text, expected in cases.items():
            for field in ("error_details", "last_assistant_message"):
                with self.subTest(text=text, field=field):
                    self.assertEqual(hook.parse_reset({field: text}, now), epoch(expected))
        self.assertEqual(hook.parse_reset({"error_details": "resets 12pm (UTC)"},
                                         epoch("2026-01-15T11:00:00Z")),
                         epoch("2026-01-15T12:00:00Z"))

    def test_aware_iso(self):
        for text in ("resets at 2026-01-16T01:30:00Z",
                     "reset_at: 2026-01-15T20:30:00-05:00",
                     "resets 2026-01-16T07:00:00+0530"):
            self.assertEqual(hook.parse_reset({"error_details": text}, 0),
                             epoch("2026-01-16T01:30:00Z"))

    def test_unknown_missing_or_invalid_zone_and_time(self):
        for text in ("resets 8pm", "resets 8pm (Not/A_Zone)", "resets 8pm (local)",
                     "resets 0am (UTC)", "resets 13pm (UTC)", "resets 1:99pm (UTC)",
                     "resets at 2026-01-16T01:30:00", "resets at 2026-99-16T01:30:00Z",
                     "resets 8pm (../../UTC)", "no hint",
                     "request timestamp 2026-01-16T01:30:00Z; quota exhausted"):
            with self.subTest(text=text):
                self.assertIsNone(hook.parse_reset({"error_details": text}, 0))

    def test_only_permitted_string_fields(self):
        hint = "resets 12am (UTC)"
        self.assertIsNone(hook.parse_reset({"message": hint, "reset_at": hint,
                                           "error_details": {"text": hint},
                                           "last_assistant_message": [hint]}, 0))
        self.assertIsNone(hook.parse_reset({}, 0))
        self.assertIsNotNone(hook.parse_reset({"error_details": None,
                                              "last_assistant_message": hint}, 0))

    def test_dst_gap_skips_nonexistent_time_and_fold_uses_next_occurrence(self):
        self.assertEqual(hook.parse_reset({"error_details": "resets 2:30am (America/New_York)"},
                                         epoch("2026-03-08T06:00:00Z")),
                         epoch("2026-03-09T06:30:00Z"))
        self.assertEqual(hook.parse_reset({"error_details": "resets 1:30am (America/New_York)"},
                                         epoch("2026-11-01T05:45:00Z")),
                         epoch("2026-11-01T06:30:00Z"))


class InputAndCliTests(unittest.TestCase):
    def test_bad_json(self):
        for raw in (b"", b"{", b"[]", b"null", b"123", b"\xff", b'{"x":NaN}',
                    b'{"x":1,"x":2}', b'{} trailing', b'[' * 2000 + b']' * 2000):
            with self.subTest(raw=raw[:40]):
                self.assertIsNone(hook.read_event(io.BytesIO(raw)))
        self.assertEqual(hook.read_event(io.BytesIO(b'{"x":1}')), {"x": 1})

    def test_bounded_input(self):
        stream = io.BytesIO(b" " * (hook.MAX_INPUT + 100))
        self.assertIsNone(hook.read_event(stream))
        self.assertEqual(stream.tell(), hook.MAX_INPUT + 1)
        self.assertEqual(hook.read_event(io.BytesIO(b'{}' + b' ' * (hook.MAX_INPUT - 2))), {})

    def test_directory_precedence(self):
        # Synthetic environment only, no host paths or credentials read.
        with patch.dict(os.environ, {"HOME": "/fixture/home"}, clear=True):
            self.assertEqual(hook.state_directory(), Path("/fixture/home/.claude/channels/discord"))
            os.environ["CLAUDE_CONFIG_DIR"] = "/fixture/config"
            self.assertEqual(hook.state_directory(), Path("/fixture/config/channels/discord"))
            os.environ["DISCORD_STATE_DIR"] = "/fixture/discord"
            self.assertEqual(hook.state_directory(), Path("/fixture/discord"))
        with patch.dict(os.environ, {}, clear=True):
            self.assertIsNone(hook.state_directory())

    def test_cli_invalid_input_and_arguments_are_quiet(self):
        for args, raw in ((["--failure"], b"SECRET invalid json"),
                          (["--failure", "--proc-root", "/fixture"], b"{}"),
                          (["--success", "--start-pid", "100"], b"{}"),
                          (["--unknown"], b"{}"), ([], b"{}")):
            with patch.object(hook.sys, "argv", ["usage_state.py"] + args), \
                    patch.object(hook.sys, "stdin", io.TextIOWrapper(io.BytesIO(raw))), \
                    patch.object(hook.sys, "stdout", io.StringIO()) as out, \
                    patch.object(hook.sys, "stderr", io.StringIO()) as err, \
                    patch.object(hook, "handle_event", side_effect=AssertionError("must not run")):
                self.assertEqual(hook.main(), 0)
                self.assertEqual(out.getvalue(), "")
                self.assertEqual(err.getvalue(), "")

    def test_cli_operational_error_is_generic(self):
        with patch.object(hook.sys, "argv", ["usage_state.py", "--failure"]), \
                patch.object(hook.sys, "stdin", io.TextIOWrapper(io.BytesIO(b"{}"))), \
                patch.object(hook.sys, "stderr", io.StringIO()) as err, \
                patch.object(hook, "state_directory", return_value=Path("/fixture")), \
                patch.object(hook, "handle_event", side_effect=OSError("SECRET")):
            self.assertEqual(hook.main(), 0)
            self.assertEqual(err.getvalue(), "presence usage state: operation failed\n")


if __name__ == "__main__":
    unittest.main()
