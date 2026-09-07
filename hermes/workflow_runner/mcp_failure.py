"""Allowlisted MCP failure metadata; never page text, messages or retry authority."""

from .contracts import WorkflowError


class CompactFailure(WorkflowError):
    CODES = frozenset(("STALE_VIEW", "STALE_REF", "STALE_SESSION", "STALE_STATE", "STALE_CURSOR",
        "TARGET_CHANGED", "TARGET_NOT_FOUND", "AMBIGUOUS_TARGET", "TAB_CLOSED", "UNKNOWN_TAB", "NO_TAB",
        "DISCONNECTED", "SESSION_CLOSED", "CLOSED", "BUSY", "CANCELLED", "DIALOG_OPEN", "INTERRUPTED_ACTION",
        "BATCH_TIMEOUT", "BROWSER_ERROR", "POSTCONDITION_FAILED", "INVALID_ARGUMENT", "INVALID_REQUEST",
        "REQUEST_REUSED", "REQUEST_EXPIRED"))

    def __init__(self, value):
        error = value.get("error") or value.get("observationError")
        code = error.get("code") if type(error) is dict else None
        super().__init__("MCP_" + code if type(code) is str and code in self.CODES else "MCP_ACTION_FAILED")
        self.progress = {key: value[key] for key in ("completed", "stages", "failedStage", "failedStep", "pendingStep")
                         if type(value.get(key)) is int and 0 <= value[key] <= 8}
        if type(value.get("mayHaveActed")) is bool:
            self.progress["mayHaveActed"] = value["mayHaveActed"]
