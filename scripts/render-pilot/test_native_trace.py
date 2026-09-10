"""Native diagnostic RPC is opt-in and exports only a new private artifact."""
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock
from run import RenderServer


class NativeTraceTests(unittest.TestCase):
    def test_disabled_trace_cannot_execute_browser_command(self):
        owner = Mock(features={"nativeDamageTrace": False})
        with self.assertRaisesRegex(AssertionError, "explicit opt-in"):
            RenderServer.dispatch(owner, None, {"id": 1, "op": "native-damage-trace"})
        owner.execute.assert_not_called()

    def test_export_uses_owned_container_namespace_and_exclusive_target(self):
        with tempfile.TemporaryDirectory() as directory:
            owner = Mock(features={"nativeDamageTrace": True}, token="fixture", record={},
                         code=Path(directory) / "code")
            result = {"path": "/tmp/bpane/native-damage-fixture.json", "events": 1}
            owner.execute.side_effect = [json.dumps(result), '{"traceEvents":[]}']
            exported = RenderServer.dispatch(owner, None, {"id": 1, "op": "native-damage-trace"})
            self.assertEqual(Path(exported["privateArtifact"]).read_text(), '{"traceEvents":[]}')
            owner.owned.assert_called_once_with("browser")
            self.assertEqual(owner.record["nativeDamageTrace"]["events"], 1)
            self.assertEqual(owner.execute.call_args.args[-1], result["path"])
            owner.execute.side_effect = [json.dumps(result)]
            with self.assertRaises(AssertionError):
                RenderServer.dispatch(owner, None, {"id": 2, "op": "native-damage-trace"})
            self.assertEqual(Path(exported["privateArtifact"]).read_text(), '{"traceEvents":[]}')

    def test_foreign_path_or_container_is_not_exported(self):
        for foreign in ("path", "owner"):
            with tempfile.TemporaryDirectory() as directory:
                owner = Mock(features={"nativeDamageTrace": True}, token="fixture", record={},
                             code=Path(directory) / "code")
                source = "/private/profile" if foreign == "path" else "/tmp/bpane/native-damage-fixture.json"
                owner.execute.return_value = json.dumps({"path": source})
                if foreign == "owner":
                    owner.owned.side_effect = AssertionError("foreign owner")
                with self.assertRaises(AssertionError):
                    RenderServer.dispatch(owner, None, {"id": 1, "op": "native-damage-trace"})
                self.assertEqual(owner.execute.call_count, 1)
                self.assertEqual(list(Path(directory).iterdir()), [])


if __name__ == "__main__":
    unittest.main()
