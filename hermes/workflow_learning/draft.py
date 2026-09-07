"""Deterministic, explicitly incomplete skill scaffold from redacted events."""

from .projection import EventProjection


class DraftBuilder:
    @staticmethod
    def summary(run):
        tools = [event for event in run["events"] if event["kind"] == "tool"]
        usage = [event for event in run["events"] if event["kind"] == "usage"]
        return {
            "run_id": run["run_id"], "state": run["state"], "expires_at": run["expires_at"],
            "event_count": len(run["events"]), "browser_calls": len(tools),
            "problem_calls": sum(event["outcome"] not in ("tool_completed", "tool_returned") for event in tools),
            "observed_model_calls": len(usage),
            "observed_tokens": {key: sum(event["tokens"].get(key, 0) for event in usage) for key in EventProjection.TOKENS},
            "missing_usage_calls": sum(not event["usage_complete"] for event in usage),
            "cost_usd": None, "business_success": "unverified", "observer_delivery": "best_effort",
            "accounting_scope": "Only this session/task during explicit capture. Before-start selection, after-finish learning/summary/curation and unobserved retries are excluded; not a billing total.",
        }

    @staticmethod
    def build(run):
        lines = ["---", f"name: browser-workflow-{run['run_id'][:8]}",
                 "description: Draft browser procedure requiring verification", "---", "",
                 "# Unverified browser workflow draft", "",
                 "Not executable or approved. Never infer success from this record.", "",
                 "## Purpose and prerequisites", "",
                 "TODO: describe the user-authorized task, allowed origin/account and initial state.", "",
                 "## Parameters and observed operation shapes", "",
                 "TODO: map the slots below to typed business inputs using the current conversation.",
                 "Never copy credentials, concrete private values, URLs with secrets, or live refs.", ""]
        slot, index = 0, 0
        for event in run["events"]:
            if event["kind"] != "tool":
                continue
            for step in event["steps"]:
                index += 1
                if index > 32:
                    break
                binding = ""
                if step.get("binding_required"):
                    slot += 1
                    binding = f"; input slot parameter_{slot} (unresolved)"
                target = f"; role {step['role']}" if "role" in step else ""
                lines.append(f"{index}. {step['op']}{target}{binding}; observed {event['outcome']}.")
            if index > 32:
                lines.append("Further operations omitted from this scaffold; read paginated evidence.")
                break
        if index == 0:
            lines.append("No action shapes captured. Do not invent an action sequence.")
        lines.extend(["", "## Targets, transitions, and outcome verification", "",
                      "TODO: specify unique semantic targets, stage guards, and an independent business verifier.",
                      "Resolve targets from fresh observations, never stored lease/view/ref/request IDs.",
                      "A success banner or completed click alone is insufficient.", "",
                      "## Stop and recovery", "",
                      "Stop on ambiguity, changed account/origin, popups, failed guards or human takeover.",
                      "Never replay uncertain writes. Reconcile their effects or ask the user.",
                      "Keep pane_flow's four-stage/eight-input limits; no arbitrary code or new tabs.", "",
                      "## Validation and provenance", "",
                      f"Local capture: {run['run_id']}; recording state: {run['state']}.",
                      "Evidence is content-minimized and best-effort, not proof of complete execution.",
                      "TODO: add held-out synthetic cases and a false-success test; review before reuse."])
        return "\n".join(lines) + "\n"
