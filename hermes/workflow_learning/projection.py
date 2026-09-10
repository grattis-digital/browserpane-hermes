"""Allowlist-only observer projection; raw content never crosses into storage."""

import json

from .contracts import bounded_number


class EventProjection:
    TOOLS = frozenset("pane_view pane_act pane_flow pane_tabs pane_read pane_image".split())
    OPS = frozenset("navigate back activate close click hover fill type press select check scroll drag upload dialog new".split())
    ROLES = frozenset("button textbox combobox checkbox link radio menuitem option tab searchbox slider spinbutton".split())
    TOKENS = ("input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "reasoning_tokens")

    @staticmethod
    def _result(raw):
        # Real Hermes wraps MCP text in {result: string}; fixtures may pass SDK content.
        for _ in range(5):
            if isinstance(raw, str):
                if len(raw) > 131072:
                    return {}
                try:
                    raw = json.loads(raw)
                except (ValueError, RecursionError):
                    return {}
            elif isinstance(raw, dict):
                if type(raw.get("v")) is int and raw["v"] == 1:
                    return raw
                if raw.get("isError") or raw.get("error"):
                    return {"error": True}
                if "result" in raw:
                    raw = raw["result"]
                elif isinstance(raw.get("content"), list) and len(raw["content"]) == 1:
                    block = raw["content"][0]
                    raw = block.get("text") if isinstance(block, dict) and block.get("type") == "text" else None
                else:
                    return {}
            else:
                return {}
        return {}

    @classmethod
    def tool(cls, payload):
        name = payload.get("tool_name")
        if not isinstance(name, str) or not name.startswith("mcp__browserpane__"):
            return None
        name = name.removeprefix("mcp__browserpane__")
        if name not in cls.TOOLS:
            return None
        args = payload.get("args")
        args = args if isinstance(args, dict) else {}
        stages = args.get("stages", []) if name == "pane_flow" else [{"steps": args.get("steps", [])}]
        shapes, incomplete = [], False
        if not isinstance(stages, list) or len(stages) > 4:
            stages, incomplete = [], True
        for index, stage in enumerate(stages):
            steps = stage.get("steps", []) if isinstance(stage, dict) else None
            if not isinstance(steps, list) or len(steps) > 8:
                incomplete = True
                continue
            for step in steps:
                if not isinstance(step, dict) or not isinstance(step.get("op"), str) or step["op"] not in cls.OPS:
                    incomplete = True
                    continue
                shape = {"stage": index, "op": step["op"]}
                target = step.get("target")
                if isinstance(target, dict) and isinstance(target.get("role"), str) and target["role"] in cls.ROLES:
                    shape["role"] = target["role"]
                if any(key in step for key in ("text", "values", "paths", "url", "key", "checked", "dx", "dy")):
                    shape["binding_required"] = True
                shapes.append(shape)
        raw = cls._result(payload.get("result"))
        status = payload.get("status")
        status = status if status in ("ok", "error", "blocked", "timeout", "cancelled") else "unknown"
        outcome = "unknown"
        if raw.get("error") or status in ("error", "blocked", "timeout", "cancelled"):
            outcome = "error"
        elif raw.get("stopped") or raw.get("observationError") or raw.get("mayHaveActed"):
            outcome = "uncertain"
        elif raw.get("v") == 1:
            if name in ("pane_act", "pane_flow"):
                complete = type(raw.get("completed")) is int and raw["completed"] == len(shapes) > 0
                if name == "pane_flow":
                    complete = complete and type(raw.get("stages")) is int and raw["stages"] == len(stages)
                outcome = "tool_completed" if complete and not incomplete else "uncertain"
            else:
                outcome = "tool_returned"
        event = {"kind": "tool", "tool": name, "steps": shapes[:8], "outcome": outcome,
                 "projection_incomplete": incomplete or len(shapes) > 8, "business_success": "unverified"}
        for key in ("completed", "stages", "failedStage", "failedStep"):
            if type(raw.get(key)) is int and 0 <= raw[key] <= 128:
                event[key] = raw[key]
        event["may_have_acted"] = raw.get("mayHaveActed") is True or outcome == "uncertain" or (
            name in ("pane_act", "pane_flow") and outcome in ("error", "unknown"))
        if bounded_number(payload.get("duration_ms")):
            event["duration_ms"] = payload["duration_ms"]
        return event

    @classmethod
    def usage(cls, payload):
        usage = payload.get("usage")
        usage = usage if isinstance(usage, dict) else {}
        buckets = {key: usage[key] for key in cls.TOKENS if type(usage.get(key)) is int and bounded_number(usage[key])}
        event = {"kind": "usage", "tokens": buckets, "usage_complete": len(buckets) == len(cls.TOKENS)}
        if bounded_number(payload.get("api_duration"), 3600):
            event["duration_ms"] = payload["api_duration"] * 1000
        return event
