"""Credential-free MCP fixture for an isolated Docker network; no browser/model."""

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json


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
        message = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))))
        if "id" not in message:
            self.send_response(202)
            self.end_headers()
            return
        method = message.get("method")
        if method == "initialize":
            result = {"protocolVersion": "2025-03-26", "capabilities": {"tools": {}},
                      "serverInfo": {"name": "browserpane-test-fixture", "version": "1.0.0"}}
        elif method == "tools/list":
            result = {"tools": [{"name": name, "description": "Deterministic test fixture",
                                  "inputSchema": {"type": "object", "properties": {}}}
                                 for name in ("browser_snapshot", "browser_close", "browser_install")]}
        elif method == "ping":
            result = {}
        else:
            # The test MUST only initialize/list/ping; it may not call even a fake browser tool.
            self.send_response(400)
            self.end_headers()
            return
        body = json.dumps({"jsonrpc": "2.0", "id": message["id"], "result": result}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


ThreadingHTTPServer(("0.0.0.0", 8931), Handler).serve_forever()
