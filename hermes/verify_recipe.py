"""Pinned SDK + runner contract against a loopback fake browser, never a model."""

import asyncio
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import tempfile
import threading
import time
import uuid

from workflow_runner.artifacts import ReportArtifacts
from workflow_runner.contracts import ReportContract
from workflow_runner.journal import RunJournal
from workflow_runner.mcp import CompactClient
from workflow_runner.private_files import PrivateFiles
from workflow_runner.runner import ReportRunner


async def verify(directory, exercise=None):
    root = Path(directory).resolve()
    downloads = root / "downloads"
    downloads.mkdir()
    state = {"url": "about:blank", "downloads": [], "inputs": 0, "connections": 0, "requests": []}
    recipe = {"schema": 1, "id": "image-fixture", "version": 1, "url": "https://fixture.invalid/report",
              "marker": {"role": "heading", "name": "Image fixture"}, "periodTarget": {"role": "textbox", "name": "Period"},
              "exportTarget": {"role": "link", "name": "Export"}, "readyText": "Done", "verifier": "report-csv-v1"}
    bindings = {"period": "2026-06", "rows": [{"code": "ITEM-0001", "quantity": 6}]}

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_GET(self):
            self.send_response(405)
            self.end_headers()

        def do_DELETE(self):
            self.send_response(204)
            self.end_headers()

        def do_POST(self):
            length = int(self.headers.get("Content-Length", "0"))
            assert 0 < length <= 65536
            message = json.loads(self.rfile.read(length))
            if "id" not in message:
                self.send_response(202)
                self.end_headers()
                return
            if message["method"] == "initialize":
                state["connections"] += 1
                result = {"protocolVersion": "2025-03-26", "capabilities": {"tools": {}},
                          "serverInfo": {"name": "owned-recipe-fixture", "version": "1"}}
            elif message["method"] == "tools/list":
                result = {"tools": [{"name": "pane_flow", "inputSchema": {"type": "object", "properties": {"view": {"type": "string"}}}}]}
            else:
                assert message["method"] == "tools/call"
                tool, args = message["params"]["name"], message["params"]["arguments"]
                if tool in ("pane_act", "pane_flow"):
                    assert not state["requests"] or args["request"] > state["requests"][-1]
                    state["requests"].append(args["request"])
                if tool == "pane_act":
                    state["url"] = recipe["url"]
                    value = {"v": 1, "completed": 1, "stopped": "navigation"}
                elif tool == "pane_flow":
                    assert args["view"] == "view"
                    state["inputs"] += 1
                    suffix = f" ({state['inputs']})" if state["inputs"] > 1 else ""
                    artifact = downloads / f"report-2026-06{suffix}.csv"
                    artifact.write_text("period,code,quantity\n2026-06,ITEM-0001,6\n")
                    state["downloads"].append({"file": str(artifact), "status": "complete"})
                    value = {"v": 1, "completed": 2, "stages": 1}
                else:
                    assert tool == "pane_view"
                    value = {"v": 1, "lease": "lease", "view": "view", "tab": "tab", "url": state["url"],
                             "matches": 1, "downloads": state["downloads"]}
                result = {"content": [{"type": "text", "text": json.dumps(value)}]}
            body = json.dumps({"jsonrpc": "2.0", "id": message["id"], "result": result}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        contract = ReportContract(recipe, bindings, f"http://127.0.0.1:{server.server_port}/mcp", str(downloads), pacing=None)
        journal = RunJournal(PrivateFiles(root / "workflow-runs"), time.time, lambda: uuid.uuid4().hex)
        if exercise:
            return exercise(root, contract, journal, state)
        run = journal.approve(contract.fingerprint(), contract.review()["digest"])
        runner = ReportRunner(contract, journal, ReportArtifacts(downloads), CompactClient.connect, time.monotonic, asyncio.sleep)
        first = await runner.execute(run)
        assert first["verified"] and first["modelCalls"] == 0, first
        assert (await runner.execute(run))["verified"] and state["inputs"] == 1
        assert first["mcpCalls"] == 5
        assert first["policyWaitMs"] == 0 and not (root / "workflow-pacing").exists()
        return {"pinnedSdkTransport": "passed", "journalAndVerifier": "passed", "duplicateInputs": 0, "modelCalls": 0,
                "scope": "Loopback fake browser. Real Chromium qualification is a separate test."}
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=3)
        assert not thread.is_alive()


if __name__ == "__main__":
    with tempfile.TemporaryDirectory(prefix="bph-recipe-image-") as directory:
        print(json.dumps(asyncio.run(verify(directory))))
