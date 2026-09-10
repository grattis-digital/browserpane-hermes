"""Actual pinned-Hermes plugin contract, on a fresh home with no model/network calls."""

import argparse
import json
import os
from pathlib import Path
import tempfile


def check(enabled):
    from hermes_cli.plugins import discover_plugins, get_plugin_manager
    from tools.registry import registry

    discover_plugins()
    manager = get_plugin_manager()
    plugins = [row for row in manager.list_plugins() if row["name"] == "browserpane-workflows"]
    assert len(plugins) == 1
    assert plugins[0]["enabled"] is enabled, plugins
    entry = registry.get_entry("workflow_capture")
    root = Path(os.environ["HERMES_HOME"]) / "plugin-data" / "browserpane-workflows"
    if not enabled:
        assert entry is None and not root.exists()
        return {"disabledByDefault": True}
    assert plugins[0]["error"] is None, plugins
    assert entry is not None
    assert manager.list_plugin_skills("browserpane-workflows") == ["author"]
    from tools.skills_tool import skill_view
    skill = skill_view("browserpane-workflows:author")
    assert "Browser workflow authoring" in str(skill), skill
    from model_tools import handle_function_call, _emit_post_tool_call_hook
    ids = {"task_id": "synthetic-task", "session_id": "synthetic-session"}

    def call(op, **args):
        value = json.loads(handle_function_call("workflow_capture", {"op": op, **args},
                           tool_call_id=f"control-{op}", **ids))
        assert "error" not in value, value
        return value

    assert not root.exists(), "Enabling alone must not start recording"
    start = call("start")
    _emit_post_tool_call_hook(function_name="mcp__browserpane__pane_flow",
        function_args={"lease": "SYNTHETIC_SECRET", "stages": [{"steps": [
            {"op": "fill", "text": "SYNTHETIC_SECRET", "target": {"role": "textbox", "name": "SYNTHETIC_SECRET"}}]}]},
        result=json.dumps({"result": json.dumps({"v": 1, "completed": 1, "stages": 1})}),
        tool_call_id="synthetic-input", status="ok", duration_ms=2, **ids)
    from hermes_cli.lifecycle import invoke_hook
    invoke_hook("post_api_request", api_request_id="synthetic-api", usage={"input_tokens": 10,
        "output_tokens": 2, "cache_read_tokens": 3, "cache_write_tokens": 0, "reasoning_tokens": 0},
        response={"secret": "SYNTHETIC_SECRET"}, api_duration=0.01, **ids)
    finish = call("finish", run_id=start["run_id"])
    assert finish["browser_calls"] == 1 and finish["observed_model_calls"] == 1, finish
    assert finish["observed_tokens"]["input_tokens"] == 10
    assert finish["business_success"] == "unverified" and "parameter_1" in finish["draft"]
    assert not finish["observer_error_seen_in_process"]
    assert b"SYNTHETIC_SECRET" not in (root / "captures.sqlite3").read_bytes()
    from tools.skill_manager_tool import skill_manage
    saved = json.loads(skill_manage(action="create", name=f"browser-workflow-{start['run_id'][:8]}",
                                   content=finish["draft"], category="browser"))
    assert saved.get("success") is True and not saved.get("staged"), saved
    assert "Unverified browser workflow draft" in str(skill_view(f"browser-workflow-{start['run_id'][:8]}"))
    return {"enabledDiscovery": True, "actualToolDispatch": True, "actualHooks": True,
            "skillDiscovery": True, "skillDraftPersistence": True, "redaction": True, "modelCallsMade": 0}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--enabled", action="store_true")
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="bph-workflow-hermes-fixture-") as directory:
        # This process owns this fresh profile; never touches the caller's real Hermes home.
        os.environ["HERMES_HOME"] = directory
        os.environ["HERMES_DISABLE_LAZY_INSTALLS"] = "1"
        config = {"plugins": {"enabled": ["browserpane-workflows"] if args.enabled else []},
                  "platform_toolsets": {"cli": ["skills", "workflow_learning"]}}
        Path(directory, "config.yaml").write_text(json.dumps(config), encoding="utf-8")
        print(json.dumps(check(args.enabled)))
