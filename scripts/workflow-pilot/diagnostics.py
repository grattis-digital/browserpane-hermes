"""Capture owned run state and readiness evidence before bounded disposable cleanup."""

import json
import re


class PilotDiagnostics:
    @staticmethod
    def collect(owner):
        result = {"containers": {}, "logTailLines": 1000}
        for role in ("browser", "display", "hermes", "fixture"):
            if role not in owner.containers:
                continue
            try:
                info = owner.owned("container", owner.containers[role])
                state = info["State"]
                # docker logs sends stderr separately; never read a host LogPath.
                import subprocess
                output = subprocess.run(["docker", "logs", "--tail=1000", owner.containers[role]],
                                        capture_output=True, text=True, timeout=5)
                logs = output.stdout + output.stderr
                warnings = re.findall(r"GPU readiness check failed(?: code=(GPU_[A-Z_]+))?", logs)
                result["containers"][role] = {"running": state["Running"], "oomKilled": state["OOMKilled"],
                    "exitCode": state["ExitCode"], "restartCount": info["RestartCount"],
                    "health": state.get("Health", {}).get("Status"), "tail": logs[-8000:],
                    "healthChecks": [{"start": row.get("Start"), "end": row.get("End"),
                        "exitCode": row.get("ExitCode"), "output": row.get("Output", "")[-512:]}
                        for row in state.get("Health", {}).get("Log", [])[-3:]],
                    "gpuWarnings": {code or "unclassified": warnings.count(code) for code in set(warnings)}}
            except Exception as error:
                result["containers"][role] = {"captureError": type(error).__name__}
        for role, name, command in (("hermes", "journalState", ("python", "-B", "/pilot/inspect-agent.py")),
                                    ("browser", "gpuReadiness", ("node", "/app/server/check-gpu.mjs"))):
            if role not in owner.containers:
                continue
            try:
                output = owner.execute(role, *command, timeout=10)
                result[name] = json.loads(output) if name == "journalState" else {"ready": True}
            except Exception as error:
                match = re.search(r"code=(GPU_[A-Z_]+)", str(error))
                result[name] = {"ready": False, "code": match.group(1) if match else "CAPTURE_UNAVAILABLE"}
        return result
