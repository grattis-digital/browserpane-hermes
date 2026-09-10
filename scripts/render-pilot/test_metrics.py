import unittest
from pathlib import Path
from unittest.mock import patch
from metrics import RenderMetrics


class MetricsTests(unittest.TestCase):
    def test_chromium_argv_and_rewritten_title(self):
        for value in (b"chromium\0--type=gpu-process\0--other\0", b"chromium --type=gpu-process --other"):
            self.assertEqual(RenderMetrics.process_role(value, "chromium"), "chromium-gpu-process")
        self.assertEqual(RenderMetrics.process_role(b"chromium --type=renderer", "chromium"), "chromium-renderer")
        self.assertEqual(RenderMetrics.process_role(b"chromium --type=renderer-fake", "chromium"), "chromium")
        self.assertEqual(RenderMetrics.process_role(b"chromium", "chromium"), "chromium")

    def test_process_exit_during_proc_read_is_expected_churn(self):
        for failure in (FileNotFoundError(), ProcessLookupError()):
            with patch("metrics.Path.read_text", side_effect=["123\n", failure]):
                self.assertEqual(RenderMetrics.processes(Path("/synthetic-cgroup")), {})

    def test_process_exit_during_cmdline_read_is_expected_churn(self):
        for failure in (FileNotFoundError(), ProcessLookupError()):
            with patch("metrics.Path.read_text", side_effect=["123\n", "123 (chromium) S"]), \
                 patch("metrics.Path.read_bytes", side_effect=failure):
                self.assertEqual(RenderMetrics.processes(Path("/synthetic-cgroup")), {})

    def test_other_proc_errors_are_not_hidden(self):
        with patch("metrics.Path.read_text", side_effect=["123\n", PermissionError("denied")]):
            with self.assertRaises(PermissionError):
                RenderMetrics.processes(Path("/synthetic-cgroup"))


if __name__ == "__main__":
    unittest.main()
