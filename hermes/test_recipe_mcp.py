"""SDK wire mapping regression checks, with no dependency import/network required."""

import asyncio
import json
import tempfile
from types import SimpleNamespace
import unittest

from workflow_runner.contracts import WorkflowError
from workflow_runner.mcp import CompactClient
from workflow_runner.diagnostics import WorkflowDiagnostics
from workflow_runner.mcp_failure import CompactFailure
from workflow_fixture import WorkflowFixture


class Reply:
    def __init__(self, value, error=False, kind="text", result_type="complete"):
        self.is_error, self.result_type = error, result_type
        self.content = [SimpleNamespace(type=kind, text=json.dumps(value))]

    def model_dump(self, **_kwargs):
        return {"content": [{"type": item.type, "text": item.text} for item in self.content]}


class Session:
    def __init__(self, reply):
        self.reply = reply

    async def call_tool(self, name, args, **kwargs):
        assert name == "pane_view" and args == {} and kwargs["read_timeout_seconds"] == 20
        return self.reply


class RecipeMcpTests(unittest.TestCase):
    def test_sdk_v2_snake_case_error_and_result_types_cannot_hide_failure(self):
        for reply in (Reply({"v": 1}, error=True), Reply({"v": 1}, result_type="input_required"),
                      Reply({"v": 1}, kind="image"), Reply({"v": True}), Reply({"v": 1, "error": {"message": "SECRET"}})):
            client = CompactClient(Session(reply), lambda: 1.0)
            with self.assertRaises(WorkflowError):
                asyncio.run(client.call("pane_view", {}))
            self.assertEqual(client.metrics()["mcpCalls"], 1)
            self.assertFalse(client.healthy)

    def test_bounded_typed_result_and_actual_numeric_metrics(self):
        client = CompactClient(Session(Reply({"v": 1, "url": "https://fixture.invalid/"})), lambda: 1.0)
        result = asyncio.run(client.call("pane_view", {}))
        self.assertEqual(result["v"], 1)
        self.assertGreater(client.metrics()["responseJsonBytes"], 0)
        oversized = CompactClient(Session(Reply({"v": 1, "text": "x" * 65536})), lambda: 1.0)
        with self.assertRaisesRegex(WorkflowError, "MCP_REPLY_LIMIT"):
            asyncio.run(oversized.call("pane_view", {}))

    def test_non_browser_tools_cannot_be_invoked_through_recipe_adapter(self):
        client = CompactClient(Session(Reply({"v": 1})), lambda: 1.0)
        with self.assertRaisesRegex(WorkflowError, "TOOL_NOT_ALLOWED"):
            asyncio.run(client.call("terminal", {}))
        self.assertEqual(client.metrics()["mcpCalls"], 0)

    def test_request_sequence_is_connection_local_and_monotonic(self):
        first = CompactClient(Session(Reply({"v": 1})), lambda: 1.0)
        second = CompactClient(Session(Reply({"v": 1})), lambda: 1.0)
        self.assertEqual([first.next_request() for _ in range(64)], list(range(1, 65)))
        self.assertEqual(second.next_request(), 1)

    def test_error_envelope_keeps_known_code_and_bounded_progress_but_never_message(self):
        value = {"v": 1, "error": {"code": "STALE_VIEW", "message": "SECRET https://private.invalid"},
                 "completed": 0, "stages": 0, "failedStage": 0, "mayHaveActed": False,
                 "failedStep": "SECRET", "pendingStep": 999}
        for is_error in (True, False):
            client = CompactClient(Session(Reply(value, error=is_error)), lambda: 1.0)
            with self.assertRaisesRegex(WorkflowError, "^MCP_STALE_VIEW$") as caught:
                asyncio.run(client.call("pane_view", {}))
            detail = WorkflowDiagnostics.fields("execution", caught.exception)
            self.assertEqual(detail["progress"], {"completed": 0, "stages": 0, "failedStage": 0, "mayHaveActed": False})
            self.assertNotIn("SECRET", json.dumps(detail))
            self.assertFalse(client.healthy)
            self.assertEqual(client.metrics()["mcpCalls"], 1)
            self.assertGreater(client.metrics()["responseJsonBytes"], 0)

    def test_unknown_remote_codes_and_untrusted_counter_types_are_not_logged(self):
        for code in ("SECRET", "JOURNAL_BUSY", "STALE_VIEW\nSECRET", {}, None):
            reply = Reply({"v": 1, "error": {"code": code}, "completed": True, "mayHaveActed": "SECRET"}, error=True)
            client = CompactClient(Session(reply), lambda: 1.0)
            with self.assertRaisesRegex(WorkflowError, "^MCP_ACTION_FAILED$") as caught:
                asyncio.run(client.call("pane_view", {}))
            self.assertEqual(caught.exception.progress, {})

    def test_observation_error_does_not_hide_already_completed_inputs_or_become_success(self):
        reply = Reply({"v": 1, "completed": 2, "observationError": {"code": "DISCONNECTED", "message": "SECRET"}})
        client = CompactClient(Session(reply), lambda: 1.0)
        with self.assertRaisesRegex(WorkflowError, "^MCP_DISCONNECTED$") as caught:
            asyncio.run(client.call("pane_view", {}))
        self.assertEqual(caught.exception.progress, {"completed": 2})

    def test_specific_browser_error_preserves_uncertainty_and_never_replays(self):
        with tempfile.TemporaryDirectory(prefix="bph-mcp-failure-") as directory:
            fixture = WorkflowFixture(directory)
            run, original = fixture.approve(), fixture.call
            async def fail(name, args):
                if name == "pane_flow":
                    raise CompactFailure({"error": {"code": "BROWSER_ERROR", "message": "SECRET"},
                                          "completed": 1, "failedStep": 1, "mayHaveActed": True})
                return await original(name, args)
            fixture.call = fail
            result = asyncio.run(fixture.runner().execute(run))
            self.assertEqual((result["state"], result["code"]), ("uncertain", "MCP_BROWSER_ERROR"))
            self.assertFalse(result["verified"])
            calls = len(fixture.calls)
            self.assertEqual(asyncio.run(fixture.runner().execute(run))["state"], "uncertain")
            self.assertEqual(len(fixture.calls), calls)
