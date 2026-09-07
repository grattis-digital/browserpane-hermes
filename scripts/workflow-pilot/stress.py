"""Browser-only diagnostic repetition; never a Hermes or performance qualification."""

import argparse
import json
import os
from pathlib import Path
import signal
import subprocess

from diagnostics import PilotDiagnostics
from driver import PilotAgent
from metrics import PilotMetrics
from owned import OwnedPilot
from trials import PilotTrials


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for role in ("browser", "hermes", "display"):
        parser.add_argument("--" + role, required=True)
    parser.add_argument("--exports", type=int, default=100)
    parser.add_argument("--protocol-trace", action="store_true", help="Private fixture-only CDP logs; changes timing")
    args = parser.parse_args()
    assert os.geteuid() == 0 and 1 <= args.exports <= 100
    os.umask(0o077)
    code = Path(__file__).resolve().parent
    assert code.parent.name.startswith("bph-workflow-pilot.")
    found = dict(line.split("=", 1) for line in subprocess.check_output(
        ["bash", str(code / "gpu-devices.sh")], text=True).splitlines())
    devices = {"render": found["BPANE_GPU_RENDER_DEVICE"], "display": found["BPANE_GPU_DISPLAY_DEVICE"],
               "renderGid": found["BPANE_GPU_RENDER_GID"], "displayGid": found["BPANE_GPU_DISPLAY_GID"]}
    owner = OwnedPilot(code, args.browser, args.hermes, args.display, devices, args.protocol_trace)
    report = {"scope": "Owned browser-only MCP diagnostic, not a Hermes benchmark or recovery qualification.",
              "images": owner.images, "exports": args.exports, "completed": 0, "modelCalls": 0,
              "protocolTrace": args.protocol_trace}
    (code.parent / ("ownership-" + owner.token + ".json")).write_text(json.dumps({"label": owner.LABEL, "token": owner.token}))
    agent = metrics = None

    def interrupt(_signal, _frame):
        raise KeyboardInterrupt()
    signal.signal(signal.SIGTERM, interrupt)
    try:
        owner.prepare()
        metrics = PilotMetrics(owner)
        metrics.start()
        agent = PilotAgent(owner, "stress")
        print(json.dumps({"phase": "stress-ready"}), flush=True)
        for index in range(1, args.exports + 1):
            metrics.check()
            result = agent.call({"fixture": "export", "index": index})
            if result.get("failed"):
                report["failure"] = result
                raise AssertionError("Owned MCP export failed")
            assert result["verified"] and result["completed"] == index
            report["completed"] = index
            if index % 10 == 0:
                print(json.dumps({"phase": "stress", "completed": index}), flush=True)
        report["passed"] = True
    except BaseException as error:
        report["passed"] = False
        report["errorType"] = type(error).__name__
        report["error"] = str(error)[:1000]
    finally:
        if metrics:
            try:
                report["resources"] = metrics.stop()
                oracle = PilotTrials(owner, agent, None)
                report["oracle"] = {"browser": oracle.probe(), "fixture": oracle.control()}
            except Exception as error:
                report["captureError"] = type(error).__name__
                report["passed"] = False
        report["diagnostics"] = PilotDiagnostics.collect(owner)
        try:
            if agent:
                agent.close()
        except Exception as error:
            report["passed"] = False
            report["helperCleanupError"] = type(error).__name__
            raise
        finally:
            try:
                owner.cleanup()
                report["existingServicesUnchanged"] = True
                report["ownedResourcesRemoved"] = True
            except Exception as error:
                report["passed"] = False
                report["cleanupError"] = type(error).__name__
                raise
            finally:
                output = code.parent / ("stress-" + owner.token + ".json")
                with output.open("x") as file:
                    json.dump(report, file, indent=2)
                print(json.dumps({"phase": "finished", "passed": report.get("passed"), "report": str(output)}), flush=True)
    if not report.get("passed"):
        raise SystemExit(1)


if __name__ == "__main__":
    main()
