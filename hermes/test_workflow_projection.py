"""Closed projection tests: untrusted text must never become retained evidence."""

import json
import unittest

from workflow_learning.contracts import CaptureError, command
from workflow_learning.projection import EventProjection


class ProjectionTests(unittest.TestCase):
    def payload(self, result=None):
        return {"tool_name": "mcp__browserpane__pane_flow", "status": "ok", "duration_ms": 2,
                "args": {"lease": "SECRET", "stages": [{"steps": [{"op": "fill", "text": "SECRET",
                         "target": {"role": "textbox", "name": "SECRET"}, "ref": "SECRET"}]}]},
                "result": json.dumps({"result": json.dumps(result or {"v": 1, "completed": 1, "stages": 1,
                          "observation": {"text": "SECRET", "url": "https://SECRET.invalid/"}})})}

    def test_double_wrapped_real_hermes_result_is_projected_without_secrets(self):
        event = EventProjection.tool(self.payload())
        self.assertNotIn("SECRET", json.dumps(event))
        self.assertEqual(event["outcome"], "tool_completed")
        self.assertEqual(event["business_success"], "unverified")
        self.assertEqual(event["steps"], [{"stage": 0, "op": "fill", "role": "textbox", "binding_required": True}])

    def test_success_banner_cannot_hide_failed_wait_or_partial_input(self):
        for result in ({"v": 1, "completed": 1, "stages": 0},
                       {"v": 1, "completed": 1, "stages": 1, "stopped": "new_tab"},
                       {"v": 1, "completed": 1, "stages": 1, "observationError": {"message": "SECRET"}},
                       {"v": 1, "completed": 1, "stages": 1, "error": {"code": "SECRET"}}):
            with self.subTest(result=result):
                result["text"] = "Success! SECRET"
                event = EventProjection.tool(self.payload(result))
                self.assertIn(event["outcome"], ("error", "uncertain"))
                self.assertNotIn("SECRET", json.dumps(event))

    def test_errors_images_malformed_and_large_responses_stay_content_free(self):
        for raw in ("SECRET", "SECRET" * 25000, {"isError": True, "error": "SECRET"},
                    {"content": [{"type": "image", "data": "SECRET"}]}, [], None):
            payload = self.payload()
            payload["result"] = raw
            event = EventProjection.tool(payload)
            self.assertIn(event["outcome"], ("unknown", "error"))
            self.assertNotIn("SECRET", json.dumps(event))

    def test_only_exact_browserpane_tools_are_observed(self):
        for name in ("terminal", "skill_manage", "mcp__other__pane_act", "mcp__browserpane__pane_exec", None):
            self.assertIsNone(EventProjection.tool({"tool_name": name, "result": "SECRET"}))

    def test_host_error_overrides_embedded_success(self):
        payload = self.payload()
        payload["status"] = "timeout"
        self.assertEqual(EventProjection.tool(payload)["outcome"], "error")

    def test_bool_counts_are_not_success(self):
        self.assertEqual(EventProjection.tool(self.payload({"v": 1, "completed": True, "stages": True}))["outcome"], "uncertain")

    def test_usage_copies_only_canonical_numeric_buckets(self):
        event = EventProjection.usage({"usage": {"input_tokens": 10, "output_tokens": 4,
            "raw_usage": {"api_key": "SECRET"}, "cache_read_tokens": -1,
            "cache_write_tokens": True, "reasoning_tokens": "SECRET"}, "response": "SECRET", "api_duration": float("nan")})
        self.assertEqual(event, {"kind": "usage", "tokens": {"input_tokens": 10, "output_tokens": 4}, "usage_complete": False})

    def test_commands_reject_extra_fields_success_claims_and_path_injection(self):
        for args in (None, {}, {"op": "approve"}, {"op": "finish", "success": True},
                     {"op": "start", "ttl_minutes": True}, {"op": "start", "ttl_minutes": 31},
                     {"op": "read", "run_id": "../secret"}, {"op": "start", "run_id": "a" * 32},
                     {"op": "status", "offset": 1}, {"op": "read", "offset": -1}):
            with self.subTest(args=args), self.assertRaises(CaptureError):
                command(args)


if __name__ == "__main__":
    unittest.main()
