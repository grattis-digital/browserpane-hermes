"""Explicit, finite SSH-stdio pilot. EOF, timeout and exceptions clean owned resources."""
import base64
import json
import os
from pathlib import Path
import select
import signal
import subprocess
import sys
import time
import traceback
from metrics import RenderMetrics
from owner import RenderOwner


class RenderServer:
    @staticmethod
    def emit(value):
        print(json.dumps(value, separators=(",", ":")), flush=True)

    @staticmethod
    def dispatch(owner, metrics, request):
        op = request["op"]
        assert set(request) <= {"id", "op"} and isinstance(request["id"], int)
        if op == "sample":
            return {**metrics.sample(), "network": owner.firewall.counters()}
        if op in ("stock-trace-start", "stock-trace-stop"):
            assert owner.features["stockGpuTrace"], "Stock tracing requires explicit opt-in"
            return owner.stock_trace.start() if op == "stock-trace-start" else owner.stock_trace.stop()
        if op == "timings":
            assert owner.features["captureTimings"], "Timing logs are diagnostic-only"
            owner.owned("browser")
            output = subprocess.run(["docker", "logs", "--tail=2000", owner.containers["browser"]],
                text=True, capture_output=True, timeout=10, check=True)
            logs = output.stdout + output.stderr
            assert len(logs) <= 2 * 1024 * 1024, "Timing log response bound"
            return logs
        if op in ("install", "inspect", "gpu"):
            return json.loads(owner.execute("node", "/pilot/cdp.mjs", json.dumps({"op": op, "token": owner.token})))
        if op == "native-damage-trace":
            assert owner.features["nativeDamageTrace"], "Native tracing requires explicit opt-in"
            result = json.loads(owner.execute("node", "/pilot/native-damage-trace.mjs", owner.token, timeout=25))
            source = "/tmp/bpane/native-damage-" + owner.token + ".json"
            assert result["path"] == source
            target = owner.code.parent / ("native-damage-" + owner.token + ".json")
            assert not target.exists()
            owner.owned("browser")
            owner.record["nativeDamageTrace"] = result
            owner.save()
            # Read in the container mount namespace: Docker cp can miss tmpfs.
            data = owner.execute("node", "--input-type=module", "-e",
                "import{readFileSync,statSync}from'node:fs';const p=process.argv[1];"
                "if(statSync(p).size>32*1024*1024)throw Error('trace bound');"
                "process.stdout.write(readFileSync(p));", source)
            with target.open("x") as stream:
                stream.write(data)
            result["privateArtifact"] = str(target)
            return result
        if op == "pixels":
            owner.owned("browser")
            output = subprocess.run(["docker", "exec", owner.containers["browser"], "ffmpeg",
                "-hide_banner", "-loglevel", "error", "-f", "x11grab", "-draw_mouse", "0",
                "-video_size", "1280x720", "-i", ":99+0,0", "-frames:v", "1", "-threads", "1",
                "-pix_fmt", "rgba", "-f", "rawvideo", "pipe:1"], capture_output=True, timeout=15, check=True)
            assert len(output.stdout) == 1280 * 720 * 4
            return base64.b64encode(output.stdout).decode()
        raise ValueError("Unsupported pilot operation")

    @classmethod
    def main(cls):
        assert sys.flags.optimize == 0, "Do not disable ownership assertions"
        os.umask(0o077)
        config = Path(sys.argv[1]).resolve(strict=True)
        assert config.parent.stat().st_mode & 0o077 == 0
        owner = RenderOwner(json.loads(config.read_text()))
        def stop(*_args):
            raise RuntimeError("Pilot interrupted/deadline")
        signal.signal(signal.SIGTERM, stop)
        signal.signal(signal.SIGINT, stop)
        signal.signal(signal.SIGALRM, stop)
        signal.alarm(900)
        request_id = 0
        try:
            cls.emit({"id": 0, "result": owner.start()})
            metrics = RenderMetrics(owner)
            last_request, buffer = time.monotonic(), b""
            while True:
                metrics.sample()  # Pressure/OOM watchdog even when client is idle.
                assert time.monotonic() - last_request < 90, "Client inactivity deadline"
                if not select.select([sys.stdin], [], [], 1)[0]:
                    continue
                chunk = os.read(sys.stdin.fileno(), 4096)
                if not chunk:
                    break
                buffer += chunk
                assert len(buffer) <= 8192, "RPC input bound"
                if b"\n" not in buffer:
                    continue
                line, buffer = buffer.split(b"\n", 1)
                assert not buffer, "Pipelined requests are not supported"
                request = json.loads(line)
                assert request["id"] == request_id + 1
                request_id, last_request = request["id"], time.monotonic()
                if request["op"] == "finish":
                    break
                cls.emit({"id": request_id, "result": cls.dispatch(owner, metrics, request)})
        except Exception as error:
            owner.record["failure"] = traceback.format_exc()
            cls.emit({"id": request_id, "error": traceback.format_exc()})
        finally:
            signal.alarm(0)
            signal.signal(signal.SIGTERM, signal.SIG_IGN)
            signal.signal(signal.SIGINT, signal.SIG_IGN)
            owner.close()
            cls.emit({"id": request_id, "result": {"cleaned": True}})


if __name__ == "__main__":
    RenderServer.main()
