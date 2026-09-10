"""Bounded stock Chromium tracing in the exact disposable browser only."""
import json
import os
from pathlib import Path
import select
import subprocess
import time


class StockTrace:
    def __init__(self, owner):
        self.owner, self.process, self.number = owner, None, 0
        self.errors = None

    def _line(self, seconds):
        deadline, data = time.monotonic() + seconds, b""
        while time.monotonic() < deadline:
            self.owner.pressure()
            if not select.select([self.process.stdout], [], [], 0.5)[0]:
                continue
            chunk = os.read(self.process.stdout.fileno(), 65536)
            if not chunk:
                raise RuntimeError("Stock trace exited; inspect private stderr artifact")
            data += chunk
            assert len(data) <= 2 * 1024 * 1024, "Stock trace response bound"
            if b"\n" in data:
                line, tail = data.split(b"\n", 1)
                assert not tail, "Unexpected trace output"
                return json.loads(line)
        raise RuntimeError("Stock trace response deadline")

    def start(self):
        assert self.owner.features["stockGpuTrace"], "Stock tracing requires explicit opt-in"
        assert self.process is None and self.number < 8, "Trace concurrency/count bound"
        self.owner.owned("browser")
        self.number += 1
        path = self.owner.code.parent / ("stock-gpu-" + self.owner.token + "-" + str(self.number) + ".stderr")
        self.errors = path.open("xb")
        self.process = subprocess.Popen(["docker", "exec", "-i", self.owner.containers["browser"],
            "node", "/pilot/stock-gpu-trace.mjs", self.owner.token, str(self.number)],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self.errors)
        result = self._line(20)
        assert result["ready"] is True and result["number"] == self.number
        return result

    def stop(self):
        assert self.process is not None, "No active stock trace"
        self.owner.owned("browser")
        self.process.stdin.write(b"stop\n")
        self.process.stdin.flush()
        result = self._line(23)
        assert self.process.wait(timeout=3) == 0, "Stock trace failed"
        self.close()
        source = "/tmp/bpane/stock-gpu-" + self.owner.token + "-" + str(self.number) + ".json"
        assert result["path"] == source, "Foreign trace path"
        target = self.owner.code.parent / Path(source).name
        data = self.owner.execute("node", "--input-type=module", "-e",
            "import{readFileSync,statSync}from'node:fs';const p=process.argv[1];"
            "if(statSync(p).size>32*1024*1024)throw Error('trace bound');"
            "process.stdout.write(readFileSync(p));", source)
        with target.open("x") as stream:
            stream.write(data)
        result["privateArtifact"] = str(target)
        self.owner.record.setdefault("stockGpuTraces", []).append(result)
        self.owner.save()
        return result

    def close(self):
        if self.process is not None:
            try:
                self.process.stdin.close()  # EOF stops the owned in-container collector.
            except BrokenPipeError:
                # The collector may already have exited on its own deadline.
                # Still reap the exact exec client and close its other handles.
                pass
            try:
                self.process.wait(timeout=12)
            except subprocess.TimeoutExpired:
                self.process.terminate()  # Exact owned exec client, never a browser PID.
                try:
                    self.process.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    self.process.kill()
                    self.process.wait(timeout=3)
            self.process.stdout.close()
            self.process = None
        if self.errors is not None:
            self.errors.close()
            self.errors = None
