"""One Docker-exec stdio channel; tool timing excludes process/SSH startup in both arms."""

import json
import os
import select
import subprocess
import time


class PilotAgent:
    def __init__(self, owner, home="warm"):
        identifier = owner.containers["browser" if home == "stress" else "hermes"]
        owner.owned("container", identifier)
        assert home in ("warm", "safety", "stress")
        self._buffer = b""
        command = ["-e", "HERMES_HOME=/opt/data/" + home, identifier, "python", "-u", "/pilot/agent.py"]
        if home == "stress":
            source = "\n".join((owner.code / name).read_text() for name in ("cdp.mjs", "stress.mjs"))
            command = [identifier, "node", "--input-type=module", "-e", source + "\nawait new PilotStress().serve();"]
        self.child = subprocess.Popen(["docker", "exec", "-i", *command],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        assert self.read().get("ready") is True

    def read(self, timeout=60):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if b"\n" in self._buffer:
                line, self._buffer = self._buffer.split(b"\n", 1)
                if line.startswith(b"{"):
                    return json.loads(line)
                continue  # Upstream startup notices are not tool responses or report evidence.
            assert self.child.poll() is None, "Owned Hermes helper exited"
            if not select.select([self.child.stdout], [], [], min(1, deadline - time.monotonic()))[0]:
                continue
            data = os.read(self.child.stdout.fileno(), 65536)
            assert data and len(self._buffer) + len(data) <= 65536, "Pilot response limit"
            self._buffer += data
        raise TimeoutError("Hermes pilot response timeout")

    def call(self, args):
        assert self.child.poll() is None
        self.child.stdin.write(json.dumps(args).encode() + b"\n")
        self.child.stdin.flush()
        return self.read()

    def prepare(self, period, rows, mode="warm"):
        return self.call({"fixture": "prepare", "mode": mode, "period": period, "rows": rows})["runId"]

    def execute(self, run, mode="warm", op="run"):
        started, polls = time.monotonic(), 0
        result = self.call({"fixture": "cold", "runId": run} if mode == "cold" else {"op": op, "run_id": run})
        while result.get("active"):
            assert time.monotonic() - started < 60
            time.sleep(result["pollAfterMs"] / 1000)
            result = self.call({"op": "status", "run_id": run})
            polls += 1
        return {**result, "wallMs": (time.monotonic() - started) * 1000, "polls": polls}

    def close(self):
        if self.child.poll() is None:
            self.child.stdin.write(b'{"fixture":"close"}\n')
            self.child.stdin.flush()
            self.child.stdin.close()
            self.child.wait(timeout=30)
        assert self.child.returncode == 0, "Owned Hermes helper failed"
