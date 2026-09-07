"""Test-only actual Hermes tool dispatch. No LLM or operator credential access."""

import json
import logging
from logging.handlers import RotatingFileHandler
import os
from pathlib import Path
import sys
import subprocess
import time
import uuid

sys.path.insert(0, "/opt/hermes-bundle")
from workflow_runner.catalog import ExecutionCatalog
from workflow_runner.contracts import ReportContract
from workflow_runner.journal import RunJournal
from workflow_runner.private_files import PrivateFiles


def main():
    os.umask(0o077)
    token = os.environ["BPANE_WORKFLOW_PILOT"]
    assert str(uuid.UUID(token)) == token
    home = Path(os.environ["HERMES_HOME"])
    assert home.parent == Path("/opt/data") and home.name in ("warm", "safety")
    home.mkdir(mode=0o700, exist_ok=True)
    endpoint = "http://127.0.0.1:8931/mcp" if home.name == "warm" else f"http://127.0.0.1:9130/{token}/mcp"
    config = {"plugins": {"enabled": ["browserpane-replay"]},
              "mcp_servers": {"browserpane": {"url": endpoint}}, "platform_toolsets": {"cli": ["workflow_execution"]}}
    config_path = home / "config.yaml"
    if not config_path.exists():
        with config_path.open("x") as file:
            json.dump(config, file)
        config_path.chmod(0o600)
    assert json.loads(config_path.read_text()) == config
    # Keep only bounded content-free workflow failures for private diagnosis.
    log_path = home / "workflow-diagnostics.log"
    log_path.touch(mode=0o600, exist_ok=True)
    handler = RotatingFileHandler(log_path, maxBytes=32768, backupCount=1)
    logger = logging.getLogger("workflow_runner")
    logger.setLevel(logging.WARNING)
    logger.propagate = False
    logger.addHandler(handler)
    from hermes_cli.plugins import discover_plugins, unload_plugins
    from model_tools import handle_function_call
    discover_plugins()
    prepared = {}
    print(json.dumps({"ready": True}), flush=True)
    try:
        while line := sys.stdin.readline(65537):
            assert len(line) <= 65536 and line.endswith("\n")
            args = json.loads(line)
            if args.get("fixture") == "prepare":
                assert set(args) == {"fixture", "mode", "period", "rows"} and args["mode"] in ("cold", "warm")
                store = home / ("workflow-runs" if args["mode"] == "warm" else "cold-runs")
                recipe = {"schema": 1, "id": "pilot-report", "version": 1, "url": f"http://127.0.0.1:9130/{token}/report",
                          "marker": {"role": "heading", "name": "Workflow pilot report"},
                          "periodTarget": {"role": "textbox", "name": "Reporting period"},
                          "exportTarget": {"role": "link", "name": "Export report"},
                          "readyText": "Report exported", "verifier": "report-csv-v1"}
                bindings = {"period": args["period"], "rows": args["rows"]}
                contract = ReportContract(recipe, bindings, endpoint, "/shared/downloads", pacing=None)
                journal = RunJournal(PrivateFiles(store), time.time, lambda: uuid.uuid4().hex)
                # Only this owned fixture can be approved by this test helper; no page/config/URL input.
                run = journal.approve(contract.fingerprint(), contract.review()["digest"])
                if args["mode"] == "warm":
                    ExecutionCatalog(home / "workflow-catalog", journal, endpoint, "/shared/downloads", time.time).register(run, contract)
                inputs = home / ("input-" + run)
                inputs.mkdir(mode=0o700)
                for name, value in (("recipe.json", recipe), ("bindings.json", bindings)):
                    with (inputs / name).open("x") as file:
                        json.dump(value, file)
                    (inputs / name).chmod(0o600)
                result = {"runId": run, "cli": ["--recipe", str(inputs / "recipe.json"), "--bindings", str(inputs / "bindings.json"),
                          "--endpoint", endpoint, "--downloads", "/shared/downloads", "--store", str(store), "--pacing", "off"]}
                assert len(prepared) < 64
                prepared[run] = result["cli"]
            elif args.get("fixture") == "cold":
                assert set(args) == {"fixture", "runId"} and args["runId"] in prepared
                started = time.monotonic()
                reply = subprocess.run(["bpane-workflow", "run", *prepared[args["runId"]], "--run-id", args["runId"]],
                                       capture_output=True, text=True, timeout=60)
                # Our content-free failure lines only; discard SDK/page/raw exception messages.
                for line in reply.stderr.splitlines()[-100:]:
                    if line.startswith("workflow_failure phase="):
                        logger.warning("%s", line[:1024])
                result = json.loads(reply.stdout)
                result["cliWallMs"] = (time.monotonic() - started) * 1000
                result["exitCode"] = reply.returncode
            elif args == {"fixture": "close"}:
                break
            else:
                started = time.monotonic()
                result = json.loads(handle_function_call("workflow", args, task_id="owned-pilot",
                    session_id=token, tool_call_id="pilot-" + uuid.uuid4().hex))
                result["dispatchMs"] = (time.monotonic() - started) * 1000
            print(json.dumps(result, separators=(",", ":")), flush=True)
    finally:
        unload_plugins("browserpane-replay")
        logger.removeHandler(handler)
        handler.close()


if __name__ == "__main__":
    main()
