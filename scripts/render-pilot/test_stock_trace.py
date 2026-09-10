"""No Docker needed: opt-in, ownership and export boundaries."""
import io
from pathlib import Path
import tempfile
import subprocess
import unittest
from unittest.mock import Mock, patch
from stock_trace import StockTrace
from run import RenderServer


class StockTraceTests(unittest.TestCase):
    def test_disabled_rpc_never_calls_collector(self):
        owner = Mock(features={"stockGpuTrace": False})
        for op in ("stock-trace-start", "stock-trace-stop"):
            with self.assertRaisesRegex(AssertionError, "explicit opt-in"):
                RenderServer.dispatch(owner, None, {"id": 1, "op": op})
        owner.stock_trace.start.assert_not_called()
        owner.stock_trace.stop.assert_not_called()

    def test_foreign_container_rejected_before_spawn(self):
        owner = Mock(features={"stockGpuTrace": True})
        owner.owned.side_effect = AssertionError("foreign")
        with patch("stock_trace.subprocess.Popen") as spawn:
            with self.assertRaisesRegex(AssertionError, "foreign"):
                StockTrace(owner).start()
            spawn.assert_not_called()

    def test_overlap_and_count_bound(self):
        for active, number in ((True, 0), (False, 8)):
            owner = Mock(features={"stockGpuTrace": True})
            trace = StockTrace(owner)
            trace.process, trace.number = Mock() if active else None, number
            with self.assertRaisesRegex(AssertionError, "bound"):
                trace.start()
            owner.owned.assert_not_called()

    def test_cleanup_reaps_collector_after_broken_stdin(self):
        trace = StockTrace(Mock())
        process, errors = Mock(), Mock()
        trace.process, trace.errors = process, errors
        process.stdin.close.side_effect = BrokenPipeError()
        trace.close()
        process.wait.assert_called_once_with(timeout=12)
        process.stdout.close.assert_called_once_with()
        errors.close.assert_called_once_with()
        self.assertIsNone(trace.process)
        self.assertIsNone(trace.errors)

    def test_cleanup_escalates_only_the_owned_exec_client(self):
        trace = StockTrace(Mock())
        process = Mock()
        trace.process = process
        process.wait.side_effect = [subprocess.TimeoutExpired("exec", 12),
                                   subprocess.TimeoutExpired("exec", 3), 0]
        trace.close()
        process.terminate.assert_called_once_with()
        process.kill.assert_called_once_with()
        self.assertEqual(process.wait.call_count, 3)
        process.stdout.close.assert_called_once_with()
        trace.owner.owned.assert_not_called()
        self.assertIsNone(trace.process)

    def test_export_is_exclusive_and_checks_fixed_container_path(self):
        for foreign in (False, True):
            with tempfile.TemporaryDirectory() as directory:
                owner = Mock(token="fixture", code=Path(directory) / "code", record={})
                trace = StockTrace(owner)
                trace.number = 1
                trace.process = Mock(stdin=io.BytesIO(), stdout=io.BytesIO())
                trace.process.wait.return_value = 0
                source = "/tmp/bpane/stock-gpu-fixture-1.json"
                trace._line = Mock(return_value={"path": "/profile/private" if foreign else source})
                owner.execute.return_value = '{"traceEvents":[]}'
                if foreign:
                    with self.assertRaisesRegex(AssertionError, "Foreign trace"):
                        trace.stop()
                    owner.execute.assert_not_called()
                else:
                    result = trace.stop()
                    self.assertEqual(Path(result["privateArtifact"]).read_text(), owner.execute.return_value)
                    self.assertEqual(owner.execute.call_args.args[-1], source)
                    self.assertEqual(len(owner.record["stockGpuTraces"]), 1)

    def test_existing_evidence_is_not_overwritten(self):
        with tempfile.TemporaryDirectory() as directory:
            owner = Mock(token="fixture", code=Path(directory) / "code", record={})
            trace = StockTrace(owner)
            trace.number = 1
            trace.process = Mock(stdin=io.BytesIO(), stdout=io.BytesIO())
            trace.process.wait.return_value = 0
            source = "/tmp/bpane/stock-gpu-fixture-1.json"
            target = Path(directory) / Path(source).name
            target.write_text("original evidence")
            trace._line = Mock(return_value={"path": source})
            owner.execute.return_value = "replacement"
            with self.assertRaises(FileExistsError):
                trace.stop()
            self.assertEqual(target.read_text(), "original evidence")
            owner.save.assert_not_called()


if __name__ == "__main__":
    unittest.main()
