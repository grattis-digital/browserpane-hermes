"""One small Hermes-local tool. No agent-supplied recipes or approval operation."""

import json

from .contracts import WorkflowError, require
from .diagnostics import WorkflowDiagnostics


SCHEMA = {"name": "workflow", "description":
    "Supervised, operator-reviewed report exports. discover lists registered execution IDs; run uses one existing shared tab, "
    "run/status wait briefly for completion before returning active progress; status never replays work. "
    "reconcile verifies an interrupted export without repeating input. cancel stops later calls, "
    "not an already-sent browser batch. Only verified=true proves the report contents. Never approve, invent a new ID, or retry an "
    "uncertain export through browser tools. No arbitrary recipes, bindings or scripts. This tool does not record a learning capture.",
    "parameters": {"type": "object", "additionalProperties": False, "required": ["op"], "properties": {
        "op": {"enum": ["discover", "run", "status", "cancel", "reconcile"]},
        "run_id": {"type": "string", "pattern": "^[0-9a-f]{32}$"},
        "offset": {"type": "integer", "minimum": 0, "maximum": 32}}}}


class WorkflowController:
    def __init__(self, service, clock):
        self.service, self._clock = service, clock

    def dispatch(self, args):
        require(type(args) is dict and isinstance(args.get("op"), str), "INVALID_ARGUMENT")
        op = args["op"]
        if op == "discover":
            require(not set(args) - {"op", "offset"}, "INVALID_ARGUMENT")
            offset = args.get("offset", 0)
            require(type(offset) is int and 0 <= offset <= 32, "INVALID_ARGUMENT")
            ids, rows = self.service.catalog.ids(), []
            for run in ids[offset:offset + 16]:
                contract = self.service.catalog.load(run)
                row = self.service.journal.read(run, contract.fingerprint())
                recipe = contract.data()["recipe"]
                rows.append({"runId": run, "recipe": recipe["id"], "version": recipe["version"],
                             "state": row["state"], "runnable": row["state"] == "approved" and row["expires"] > self._clock()})
            return {"executions": rows, "nextOffset": offset + 16 if offset + 16 < len(ids) else None}
        require(op in ("run", "status", "cancel", "reconcile") and set(args) == {"op", "run_id"}, "INVALID_ARGUMENT")
        run = args["run_id"]
        if op in ("run", "reconcile"):
            return self.service.execute(run, reconcile=op == "reconcile")
        return self.service.cancel(run) if op == "cancel" else self.service.status(run, wait=True)

    def handle(self, args, **_context):
        try:
            result = self.dispatch(args)
        except Exception as error:
            WorkflowDiagnostics.report("tool", error)
            result = {"error": error.code if isinstance(error, WorkflowError) else "WORKFLOW_ERROR",
                      "next": "Inspect status. Ask the operator about unresolved runs; do not replay input."}
        return json.dumps(result, separators=(",", ":"), allow_nan=False)
