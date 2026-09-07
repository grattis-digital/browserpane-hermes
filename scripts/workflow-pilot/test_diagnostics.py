"""Diagnostics must remain bounded, owned and best effort before cleanup."""

import subprocess
import unittest
from unittest.mock import Mock, patch

from diagnostics import PilotDiagnostics


class DiagnosticsTests(unittest.TestCase):
    def owner(self):
        owner = Mock()
        owner.containers = {"browser": "owned-browser", "hermes": "owned-hermes"}
        owner.owned.return_value = {"State": {"Running": True, "OOMKilled": False,
                                            "ExitCode": 0}, "RestartCount": 0}
        owner.execute.side_effect = lambda role, *args, **kwargs: '{"warm": {"runs": []}}' if role == "hermes" else ""
        return owner

    @patch("subprocess.run")
    def test_bounded_owned_log_tail_and_classified_gpu_warnings(self, run):
        owner = self.owner()
        owner.owned.return_value["State"]["Health"] = {"Status": "starting", "Log": [
            {"Start": "start", "End": "end", "ExitCode": -1, "Output": "x" * 1000}] * 5}
        run.return_value = subprocess.CompletedProcess([], 0, "x" * 9000,
            "GPU readiness check failed code=GPU_QUERY_TIMEOUT\n" * 2)
        result = PilotDiagnostics.collect(owner)
        self.assertTrue(result["gpuReadiness"]["ready"])
        self.assertEqual(result["journalState"], {"warm": {"runs": []}})
        for row in result["containers"].values():
            self.assertEqual(len(row["tail"]), 8000)
            self.assertEqual(row["gpuWarnings"], {"GPU_QUERY_TIMEOUT": 2})
            self.assertEqual(len(row["healthChecks"]), 3)
            self.assertEqual(row["healthChecks"][0]["exitCode"], -1)
            self.assertEqual(len(row["healthChecks"][0]["output"]), 512)
        self.assertEqual(run.call_args_list[0].args[0],
                         ["docker", "logs", "--tail=1000", "owned-browser"])
        self.assertEqual(run.call_args_list[0].kwargs["timeout"], 5)

    @patch("subprocess.run")
    def test_ownership_failure_does_not_read_logs_or_abort_collection(self, run):
        owner = self.owner()
        owner.owned.side_effect = AssertionError("not owned")
        owner.execute.side_effect = RuntimeError("private message code=GPU_HTTP_TIMEOUT")
        result = PilotDiagnostics.collect(owner)
        run.assert_not_called()
        self.assertEqual(result["containers"]["browser"], {"captureError": "AssertionError"})
        self.assertEqual(result["gpuReadiness"], {"ready": False, "code": "GPU_HTTP_TIMEOUT"})
        self.assertNotIn("private message", str(result))

    @patch("subprocess.run", side_effect=subprocess.TimeoutExpired("docker", 5))
    def test_log_timeout_and_invalid_journal_json_are_nonfatal(self, run):
        owner = self.owner()
        owner.execute.return_value = "not json"
        owner.execute.side_effect = None
        result = PilotDiagnostics.collect(owner)
        self.assertEqual(result["containers"]["hermes"], {"captureError": "TimeoutExpired"})
        self.assertEqual(result["journalState"], {"ready": False, "code": "CAPTURE_UNAVAILABLE"})


if __name__ == "__main__":
    unittest.main()
