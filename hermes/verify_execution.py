"""Real pinned Hermes dispatch/unload + real pinned SDK on a loopback fake browser."""

import argparse
import asyncio
import json
import os
from pathlib import Path
import tempfile
import threading
import time

from verify_recipe import verify
from workflow_runner.catalog import ExecutionCatalog


def check(enabled, root, contract, journal, state):
    config = {"plugins": {"enabled": ["browserpane-replay"] if enabled else [],
                         "entries": {"browserpane-replay": {"settings": {"downloads": contract.data()["downloads"]}}}},
              "mcp_servers": {"browserpane": {"url": contract.data()["endpoint"]}},
              "platform_toolsets": {"cli": ["workflow_execution"]}}
    (root / "config.yaml").write_text(json.dumps(config))
    from hermes_cli.plugins import discover_plugins, get_plugin_manager, unload_plugins
    from tools.registry import registry
    discover_plugins()
    plugins = [row for row in get_plugin_manager().list_plugins() if row["name"] == "browserpane-replay"]
    assert len(plugins) == 1 and plugins[0]["enabled"] is enabled, plugins
    entry = registry.get_entry("workflow")
    assert not (root / "workflow-catalog").exists() and not (root / "workflow-runs").exists()
    assert not any(t.name == "browserpane-workflow" for t in threading.enumerate())
    if not enabled:
        assert entry is None
        return {"disabledByDefault": True, "browserCalls": 0}
    assert entry is not None and plugins[0]["error"] is None, plugins
    from model_tools import handle_function_call

    def call(op, **args):
        return json.loads(handle_function_call("workflow", {"op": op, **args}, task_id="synthetic-task",
                          session_id="synthetic-session", tool_call_id=f"workflow-{op}"))

    def settled(run):
        value = call("run", run_id=run)
        deadline = time.monotonic() + 10
        while value.get("active"):
            assert time.monotonic() < deadline
            time.sleep(0.01)
            value = call("status", run_id=run)
        assert "error" not in value, value
        return value

    try:
        assert call("discover")["executions"] == []
        assert state["connections"] == 0
        assert "error" in call("approve")
        catalog = ExecutionCatalog(root / "workflow-catalog", journal, contract.data()["endpoint"],
                                   contract.data()["downloads"], time.time)
        for _ in range(2):
            run = journal.approve(contract.fingerprint(), contract.review()["digest"])
            assert "error" in call("run", run_id=run)
            catalog.register(run, contract)
            value = settled(run)
            assert value["verified"] and value["mcpCalls"] == 5 and value["modelCalls"] == 0, value
            assert value["policyWaitMs"] == 0 and "pacing" not in value
            assert settled(run)["verified"]
        assert state["inputs"] == 2 and state["connections"] == 1 and state["requests"] == [1, 2, 3, 4], state
        run = journal.approve(contract.fingerprint(), contract.review()["digest"])
        catalog.register(run, contract)
        assert call("cancel", run_id=run)["state"] == "stopped"
        assert settled(run)["state"] == "stopped" and state["inputs"] == 2
        return {"realHermesDispatch": True, "warmSdkConnection": True, "exports": 2,
                "duplicateInputs": 0, "cancelBeforeStart": True, "modelCalls": 0}
    finally:
        unload_plugins("browserpane-replay")
        assert registry.get_entry("workflow") is None
        assert not any(t.name == "browserpane-workflow" for t in threading.enumerate())


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--enabled", action="store_true")
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="bph-execution-image-") as directory:
        os.environ["HERMES_HOME"] = directory
        os.environ["HERMES_DISABLE_LAZY_INSTALLS"] = "1"
        print(json.dumps(asyncio.run(verify(directory, lambda *values: check(args.enabled, *values)))))
