"""Owned temporary state only; no Hermes install, browser, model or network."""

from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import stat
import tempfile
import unittest
from unittest.mock import patch

from workflow_learning.capture import CaptureController
from workflow_learning.store import CaptureStore


class CaptureTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="bph-workflow-test-")
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name)
        self.now = [1000.0]
        self.store = CaptureStore(self.home, lambda: self.now[0])
        self.controller = CaptureController(self.store)

    def call(self, op, **args):
        return json.loads(self.controller.handle({"op": op, **args}, session_id="session-secret", task_id="task-secret"))

    def event(self, call_id="call-secret", **extra):
        self.controller.on_tool(session_id="session-secret", task_id="task-secret", tool_call_id=call_id,
            tool_name="mcp__browserpane__pane_act", args={"steps": [{"op": "fill", "text": "VALUE-SECRET", "ref": "REF-SECRET"}]},
            result=json.dumps({"result": json.dumps({"v": 1, "completed": 1, "url": "URL-SECRET"})}), status="ok", **extra)

    def test_disabled_recording_has_no_files_or_events(self):
        self.event()
        self.controller.on_usage(session_id="session-secret", task_id="task-secret", api_request_id="api-secret", usage={})
        self.assertEqual(list(self.home.iterdir()), [])
        self.assertEqual(self.call("status"), {"error": "NOT_FOUND"})

    def test_explicit_start_finish_scaffold_and_private_evidence(self):
        start = self.call("start")
        self.event()
        finished = self.call("finish", run_id=start["run_id"])
        self.assertEqual(finished["state"], "finished")
        self.assertEqual(finished["browser_calls"], 1)
        self.assertEqual(finished["business_success"], "unverified")
        self.assertIn("parameter_1", finished["draft"])
        self.assertIn("TODO", finished["draft"])
        self.event("late-event")
        self.assertEqual(self.call("status")["event_count"], 1)
        root = self.home / "plugin-data" / "browserpane-workflows"
        self.assertEqual(stat.S_IMODE(root.stat().st_mode), 0o700)
        database = root / "captures.sqlite3"
        self.assertEqual(stat.S_IMODE(database.stat().st_mode), 0o600)
        for secret in (b"VALUE-SECRET", b"REF-SECRET", b"URL-SECRET", b"session-secret", b"task-secret", b"call-secret"):
            self.assertNotIn(secret, database.read_bytes())

    def test_session_and_task_isolation_even_with_known_run_id(self):
        run = self.call("start")["run_id"]
        for session, task in (("another", "task-secret"), ("session-secret", "another")):
            result = json.loads(self.controller.handle({"op": "finish", "run_id": run}, session_id=session, task_id=task))
            self.assertEqual(result, {"error": "NOT_FOUND"})
        self.assertEqual(self.call("status")["state"], "recording")

    def test_repeated_hooks_and_finish_are_idempotent(self):
        self.call("start")
        with ThreadPoolExecutor(max_workers=4) as pool:
            list(pool.map(lambda _: self.event(), range(12)))
        self.assertEqual(self.call("status")["event_count"], 1)
        first = self.call("finish")
        self.assertEqual(self.call("finish"), first)
        self.assertFalse(first["observer_error_seen_in_process"])

    def test_restart_retains_evidence_without_promoting_business_success(self):
        self.call("start")
        self.event()
        self.controller = CaptureController(CaptureStore(self.home, lambda: self.now[0]))
        self.assertEqual(self.call("finish")["browser_calls"], 1)
        self.assertEqual(self.call("status")["business_success"], "unverified")

    def test_capture_expires_and_can_be_replaced_explicitly(self):
        first = self.call("start", ttl_minutes=1)["run_id"]
        self.now[0] += 60
        self.event()
        status = self.call("status", run_id=first)
        self.assertEqual((status["state"], status["event_count"]), ("expired", 0))
        self.assertNotEqual(self.call("start")["run_id"], first)

    def test_concurrent_start_cannot_create_two_active_runs(self):
        with ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(lambda _: self.call("start"), range(4)))
        self.assertEqual(sum("run_id" in row for row in results), 1)
        self.assertEqual(sum(row.get("error") == "ALREADY_RECORDING" for row in results), 3)

    def test_event_capacity_is_explicit_and_evidence_is_paginated(self):
        self.call("start")
        for index in range(129):
            self.event(str(index))
        self.assertEqual(self.call("status")["state"], "capacity")
        page = self.call("read")
        self.assertEqual((len(page["events"]), page["next_offset"]), (16, 16))
        self.assertNotIn("next_offset", self.call("read", offset=112))
        self.assertEqual(self.call("finish")["state"], "capacity")

    def test_run_capacity_does_not_silently_delete_evidence(self):
        for _ in range(32):
            self.call("start")
            self.call("finish")
        self.assertEqual(self.call("start"), {"error": "CAPACITY_REACHED"})

    def test_tokens_have_explicit_limited_scope_and_unknown_cost(self):
        self.call("start")
        self.controller.on_usage(session_id="session-secret", task_id="task-secret", api_request_id="1",
            usage={"input_tokens": 7, "output_tokens": 2}, response="SECRET")
        result = self.call("finish")
        self.assertEqual(result["observed_tokens"]["input_tokens"], 7)
        self.assertEqual(result["missing_usage_calls"], 1)
        self.assertIsNone(result["cost_usd"])

    def test_missing_identity_and_storage_failure_do_not_leak(self):
        self.assertEqual(json.loads(self.controller.handle({"op": "start"})), {"error": "MISSING_IDENTITY"})
        with self.assertLogs(level="WARNING") as logs:
            self.controller.on_tool(tool_name="mcp__browserpane__pane_view", result="SECRET")
        self.assertNotIn("SECRET", "".join(logs.output))

    def test_storage_fault_does_not_change_browser_result_or_expose_exception(self):
        self.call("start")
        payload = {"session_id": "session-secret", "task_id": "task-secret", "tool_call_id": "call-secret",
                   "tool_name": "mcp__browserpane__pane_view", "result": {"v": 1}, "status": "ok"}
        original = json.dumps(payload, sort_keys=True)
        with patch.object(self.store, "append", side_effect=OSError("PRIVATE-PATH-SECRET")):
            with self.assertLogs(level="WARNING") as logs:
                self.assertIsNone(self.controller.on_tool(**payload))
        self.assertEqual(json.dumps(payload, sort_keys=True), original)
        self.assertNotIn("SECRET", "".join(logs.output))
        status = self.call("status")
        self.assertTrue(status["observer_error_seen_in_process"])
        self.assertEqual(status["event_count"], 0)
        with patch.object(self.store, "read", side_effect=OSError("PRIVATE-PATH-SECRET")):
            self.assertEqual(self.call("status"), {"error": "CAPTURE_STORAGE_ERROR"})

    def test_storage_symlink_is_not_followed(self):
        external = self.home / "external"
        external.mkdir()
        (self.home / "plugin-data").symlink_to(external, target_is_directory=True)
        self.assertEqual(self.call("start"), {"error": "UNSAFE_STORAGE"})
        self.assertEqual(list(external.iterdir()), [])

    def test_forget_requires_exact_owned_finished_run_and_preserves_other_captures(self):
        first = self.call("start")["run_id"]
        self.assertEqual(self.call("forget", run_id=first), {"error": "FINISH_FIRST"})
        self.call("finish")
        second = self.call("start")["run_id"]
        self.assertEqual(self.call("forget", run_id=first)["forgotten"], first)
        self.assertEqual(self.call("status", run_id=first), {"error": "NOT_FOUND"})
        self.assertEqual(self.call("status")["run_id"], second)
        self.assertEqual(self.call("forget"), {"error": "INVALID_ARGUMENT"})


if __name__ == "__main__":
    unittest.main()
