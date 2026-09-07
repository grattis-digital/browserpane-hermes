"""Offline image check; optional MCP discovery only. Never submits a model request."""

import argparse
from contextlib import closing
import importlib.metadata
import json
from pathlib import Path
import sqlite3
import subprocess
import sys


HERMES_REVISION = "ee5b5ec21e576ccf9b941f9ff71330418415a5cb"


def verify_image() -> dict:
    assert Path("/opt/hermes/.hermes_build_sha").read_text().strip() == HERMES_REVISION
    assert sqlite3.sqlite_version_info >= (3, 51, 3), "SQLite lacks the upstream WAL safety floor"
    with closing(sqlite3.connect(":memory:")) as database:
        database.execute("CREATE VIRTUAL TABLE docs USING fts5(content, tokenize='trigram')")
        database.execute("INSERT INTO docs VALUES ('hermes')")
        assert database.execute("SELECT count(*) FROM docs WHERE docs MATCH 'erm'").fetchone()[0] == 1
    probe = "import sys; sys.path.insert(0,'/opt/hermes-bundle'); import healthcheck; s=healthcheck.load_status(); s.read_runtime_status(); s.get_running_pid(cleanup_stale=False); assert 'gateway' not in sys.modules"
    subprocess.run([sys.executable, "-c", probe], check=True, timeout=5, capture_output=True)
    for module in ("hermes_cli.main", "gateway.run", "tools.mcp_tool", "cli"):
        # Import in separate processes: gateway import intentionally configures process state.
        result = subprocess.run([sys.executable, "-c", f"import {module}"], timeout=60, capture_output=True, text=True)
        if result.returncode:
            raise RuntimeError(f"Import check failed for {module}: {result.stderr[-3000:]}")
    from agent.file_safety import is_write_denied
    assert not is_write_denied("/shared/verification-upload.txt"), "Hermes file tools cannot write shared uploads"
    for flags in ([], ["--enabled"]):
        for script in ("verify_workflow.py", "verify_execution.py"):
            check = subprocess.run([sys.executable, "/opt/hermes-bundle/" + script, *flags],
                                   timeout=60, capture_output=True, text=True)
            if check.returncode:
                raise RuntimeError(f"Workflow plugin fixture {script} failed: {check.stdout[-1000:]} {check.stderr[-2000:]}")
    check = subprocess.run([sys.executable, "/opt/hermes-bundle/verify_recipe.py"], timeout=60, capture_output=True, text=True)
    if check.returncode:
        raise RuntimeError(f"Recipe SDK fixture failed: {check.stdout[-1000:]} {check.stderr[-2000:]}")
    subprocess.run(["bpane-workflow", "--help"], check=True, timeout=10, capture_output=True)
    return {"hermesRevision": HERMES_REVISION, "sqlite": sqlite3.sqlite_version,
            "mcp": importlib.metadata.version("mcp"), "imports": "passed", "sharedFileWrites": "allowed",
            "healthProbe": "Unmodified upstream status/PID checks without importing the messaging package",
            "workflowPlugin": "disabled/enabled discovery, hooks, skill and redaction passed on fresh homes",
            "workflowExecution": "Separate opt-in plugin: actual Hermes dispatch/unload, warm pinned SDK, cancel and duplicate-run fixtures passed",
            "workflowRecipe": "Pinned SDK transport, verifier, duplicate-run and CLI checks passed on a loopback fake browser"}


def verify_mcp(mode: str = "compact") -> dict:
    from hermes_cli.config import load_config
    from hermes_cli.tools_config import _get_platform_tools
    from tools.mcp_tool_discovery import discover_mcp_tools, get_mcp_status
    from tools.mcp_tool_lifecycle import shutdown_mcp_servers

    config = load_config()
    enabled = _get_platform_tools(config, "cli")
    assert "browserpane" in enabled and "browser" not in enabled
    try:
        names = discover_mcp_tools(allowed_mcp_names=["browserpane"])
        browser_names = sorted(name for name in names if name.startswith("mcp__browserpane__"))
        assert browser_names, "BrowserPane MCP did not register tools"
        for forbidden in ("browser_close", "browser_install"):
            assert f"mcp__browserpane__{forbidden}" not in browser_names
        if mode == "compact":
            expected = [f"mcp__browserpane__{name}" for name in ("pane_view", "pane_act", "pane_flow", "pane_tabs", "pane_read", "pane_image")]
            assert browser_names == sorted(expected), "Expected exactly the six compact BrowserPane tools"
        else:
            for required in ("browser_navigate", "browser_evaluate", "browser_tabs"):
                assert f"mcp__browserpane__{required}" in browser_names, "Expected the explicitly selected legacy tools"
        assert any(row.get("name") == "browserpane" and row.get("connected") for row in get_mcp_status())
        return {"server": "browserpane", "mode": mode, "registeredTools": browser_names, "nativeBrowserEnabled": False}
    finally:
        shutdown_mcp_servers()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mcp", action="store_true", help="Also initialize/list the configured BrowserPane MCP; never navigate or call a tool")
    parser.add_argument("--mcp-mode", choices=("compact", "playwright"), default="compact", help="Expected tool surface; does not change the server or operator config")
    args = parser.parse_args()
    report = verify_image()
    if args.mcp:
        report["mcpDiscovery"] = verify_mcp(args.mcp_mode)
    print(json.dumps(report, indent=2))
