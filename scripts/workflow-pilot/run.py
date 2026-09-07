"""Explicitly authorized hardware pilot. All workload resources are owned and disposable."""

import argparse
from datetime import datetime, timezone
import json
import math
import os
from pathlib import Path
import signal
import statistics

from driver import PilotAgent
from diagnostics import PilotDiagnostics
from metrics import PilotMetrics
from owned import OwnedPilot
from trials import PilotTrials


def summary(trials):
    result = {}
    for mode in ("cold", "warm"):
        rows = [row for row in trials if row["mode"] == mode]
        values = {}
        for key in ("wallMs", "executionMs", "mcpMs", "mcpCalls", "responseJsonBytes", "polls"):
            ordered = sorted(row[key] for row in rows)
            values[key] = {"median": statistics.median(ordered), "p95": ordered[math.ceil(0.95 * len(ordered)) - 1]}
        values["medianCpuMs"] = {role: statistics.median(row["cpuMs"][role] for row in rows) for role in ("browser", "hermes")}
        result[mode] = values
    return result


def recovery(owner, safety, pending, cancelled):
    safety.agent.close()
    owner.restart("hermes")
    safety.agent = PilotAgent(owner, "safety")
    assert safety.agent.execute(pending)["state"] == "uncertain"
    assert safety.agent.execute(cancelled)["state"] == "stopped"
    assert safety.control()["requests"] == 1
    safety.agent.close()
    owner.restart("browser")
    assert safety.probe("restored")["profileVerified"]
    owner.execute("browser", "node", "/app/server/check-gpu.mjs")
    safety.agent = PilotAgent(owner, "safety")
    assert safety.agent.execute(pending)["state"] == "uncertain"
    result = safety.agent.execute(pending, op="reconcile")
    assert result["state"] == "uncertain" and not result["verified"] and result["mcpCalls"] == 1, result
    assert safety.control()["requests"] == 1
    files = safety.probe()["files"]
    safety.agent.close()
    owner.remove("browser")
    owner.start_browser()
    owner.remove("hermes")
    owner.start_hermes()
    safety.agent = PilotAgent(owner, "safety")
    assert safety.agent.execute(pending)["state"] == "uncertain"
    assert safety.agent.execute(cancelled)["state"] == "stopped"
    evidence = safety.probe("restored")
    assert evidence["profileVerified"] and evidence["files"] == files
    owner.execute("browser", "node", "/app/server/check-gpu.mjs")
    return {"agentRestart": True, "browserRestart": True, "browserAndAgentRecreation": True,
            "profileCookieAndLocalStorage": True, "exactTabCount": 1, "v3dSandboxRetained": True,
            "cancelAndCatalogPersisted": True, "uncertainRunNeverReplayed": True,
            "lostDownloadMetadataDoesNotImplySuccess": True}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--browser", required=True)
    parser.add_argument("--hermes", required=True)
    parser.add_argument("--display", required=True)
    parser.add_argument("--samples", type=int, default=30)
    args = parser.parse_args()
    assert 1 <= args.samples <= 30 and os.geteuid() == 0
    code = Path(__file__).resolve().parent
    assert code.parent.name.startswith("bph-workflow-pilot.")
    # No host configuration mutation: discover existing stable GPU aliases.
    import subprocess
    lines = subprocess.check_output(["bash", str(code / "gpu-devices.sh")], text=True).splitlines()
    found = dict(line.split("=", 1) for line in lines)
    devices = {"render": found["BPANE_GPU_RENDER_DEVICE"], "display": found["BPANE_GPU_DISPLAY_DEVICE"],
               "renderGid": found["BPANE_GPU_RENDER_GID"], "displayGid": found["BPANE_GPU_DISPLAY_GID"]}
    owner = OwnedPilot(code, args.browser, args.hermes, args.display, devices)
    report = {"scope": "Owned Pi GPU/X11 Chromium and pinned Hermes; actual deterministic tool dispatch, no LLM decisions or model calls.",
              "images": owner.images, "modelCalls": 0, "trials": [], "samples": args.samples, "initialHost": PilotMetrics.host(),
              "limits": {"browserMiB": 1536, "hermesMiB": 768, "displayMiB": 256, "cpuShares": 128, "hardCpuQuota": False},
              "network": "Owned shared namespace on internal network, loopback HTTP, no published ports or credentials. Existing services continue during measurement; production bridge transport is not qualified."}
    (code.parent / ("ownership-" + owner.token + ".json")).write_text(json.dumps({"label": owner.LABEL, "token": owner.token}))
    agents, metrics, safety, trials = [], None, None, None
    def interrupt(_signal, _frame):
        raise KeyboardInterrupt()
    signal.signal(signal.SIGTERM, interrupt)
    try:
        owner.prepare()
        print(json.dumps({"phase": "ready", "isolated": True}), flush=True)
        owner.execute("browser", "node", "/app/server/check-gpu.mjs")
        report["browserVersion"] = owner.execute("browser", "/usr/bin/chromium", "--version")
        metrics = PilotMetrics(owner)
        metrics.start()
        agent = PilotAgent(owner)
        agents.append(agent)
        trials = PilotTrials(owner, agent, metrics)
        trials.probe("seed")
        report["initialWarm"] = trials.trial("2024-12", [{"code": "ITEM-0001", "quantity": 12}])
        for index in range(args.samples):
            month = index % 12 + 1
            period = f"{2025 + index // 12}-{month:02d}"
            rows = [{"code": f"ITEM-{i:04d}", "quantity": month * i} for i in (1, 2, 3)]
            for mode in (["warm", "cold"] if index % 2 else ["cold", "warm"]):
                report["trials"].append(trials.trial(period, rows, mode))
            print(json.dumps({"phase": "benchmark", "pairsCompleted": index + 1}), flush=True)
        host = PilotMetrics.host()
        health_rows = [{"code": "ITEM-0001", "quantity": round(host["availableMiB"])},
                       {"code": "ITEM-0002", "quantity": round(host["temperatureC"] * 1000)},
                       {"code": "ITEM-0003", "quantity": host["frequencyKHz"]}]
        period = datetime.now(timezone.utc).strftime("%Y-%m")
        report["healthReport"] = {"meaning": {"ITEM-0001": "Available host RAM MiB", "ITEM-0002": "Host temperature milli-C", "ITEM-0003": "CPU frequency kHz"},
            "snapshot": health_rows, "execution": trials.trial(period, health_rows)}
        agent.close()
        safety_agent = PilotAgent(owner, "safety")
        agents.append(safety_agent)
        safety = PilotTrials(owner, safety_agent, metrics)
        safety.previous = set(trials.previous)
        _, report["cancelAfterDispatch"] = safety.cancellation("2024-10", [{"code": "ITEM-0001", "quantity": 10}])
        cancelled = safety.agent.prepare("2024-09", [{"code": "ITEM-0001", "quantity": 9}])
        assert safety.agent.call({"op": "cancel", "run_id": cancelled})["state"] == "stopped"
        pending, _ = safety.cancellation("2024-08", [{"code": "ITEM-0001", "quantity": 8}], reconcile=False)
        report["sessionDiagnostics"] = PilotDiagnostics.collect(owner)
        assert report["sessionDiagnostics"]["gpuReadiness"].get("ready"), "SESSION_GPU_NOT_READY"
        report["resources"] = metrics.stop()
        metrics = None
        report["summary"] = summary(report["trials"])
        print(json.dumps({"phase": "recovery", "summary": report["summary"]}), flush=True)
        report["recovery"] = recovery(owner, safety, pending, cancelled)
        report["recoveryDiagnostics"] = PilotDiagnostics.collect(owner)
        assert report["recoveryDiagnostics"]["gpuReadiness"].get("ready"), "RECOVERY_GPU_NOT_READY"
        report["passed"] = True
    except BaseException as error:
        report["passed"] = False
        report["error"] = str(error)
        report["errorType"] = type(error).__name__
        if trials:
            try:
                # Observe only the owned fixture/artifacts; never retry the failed action.
                report["failureOracle"] = {"browser": trials.probe(), "fixture": trials.control()}
            except Exception as capture_error:
                report["failureOracle"] = {"captureError": type(capture_error).__name__}
        report["failureDiagnostics"] = PilotDiagnostics.collect(owner)
        raise
    finally:
        if metrics:
            try:
                report["resources"] = metrics.stop()
            except Exception as error:
                report["resourceError"] = str(error)
        if safety:
            agents.append(safety.agent)
        for agent in agents:
            try:
                agent.close()
            except Exception:
                report["helperCleanupWarning"] = True
        try:
            owner.cleanup()
            report["existingServicesUnchanged"] = True
            report["ownedResourcesRemoved"] = True
        except Exception as error:
            report["passed"] = False
            report["cleanupError"] = str(error)
            raise
        finally:
            output = code.parent / ("report-" + owner.token + ".json")
            with output.open("x") as file:
                json.dump(report, file, indent=2)
        print(json.dumps({"phase": "finished", "passed": report.get("passed"), "summary": report.get("summary"), "report": str(output)}), flush=True)


if __name__ == "__main__":
    main()
