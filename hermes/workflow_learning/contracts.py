"""Closed recording contract. No executable recipes or success-claim input."""

import math
import re


class CaptureError(ValueError):
    def __init__(self, code):
        super().__init__(code)
        self.code = code


def bounded_number(value, maximum=1_000_000_000):
    return type(value) in (int, float) and math.isfinite(value) and 0 <= value <= maximum


def identity(value):
    if not isinstance(value, str) or not 1 <= len(value) <= 256:
        raise CaptureError("MISSING_IDENTITY")
    return value


def command(value):
    if not isinstance(value, dict):
        raise CaptureError("INVALID_ARGUMENT")
    op = value.get("op")
    fields = {"start": {"op", "ttl_minutes"}, "status": {"op", "run_id"},
              "finish": {"op", "run_id"}, "read": {"op", "run_id", "offset"}, "forget": {"op", "run_id"}}
    if not isinstance(op, str) or op not in fields or set(value) - fields[op]:
        raise CaptureError("INVALID_ARGUMENT")
    if op == "forget" and "run_id" not in value:
        raise CaptureError("INVALID_ARGUMENT")
    if "run_id" in value and (not isinstance(value["run_id"], str) or
                             not re.fullmatch(r"[0-9a-f]{32}", value["run_id"])):
        raise CaptureError("INVALID_ARGUMENT")
    for key, default, maximum in (("ttl_minutes", 10, 30), ("offset", 0, 128)):
        number = value.get(key, default)
        if type(number) is not int or not (1 if key == "ttl_minutes" else 0) <= number <= maximum:
            raise CaptureError("INVALID_ARGUMENT")
    return dict(value)


SCHEMA = {
    "name": "workflow_capture",
    "description": "Opt-in local learning record, not browser automation. Start only when the user asks to record/learn this run. Records operation shapes and usage, never page text, input values or live refs. finish returns an UNVERIFIED draft; read pages redacted evidence. forget permanently removes one finished capture: only on user request. Does not approve, replay, or prove success. Load skill browserpane-workflows:author before learning.",
    "parameters": {
        "type": "object", "additionalProperties": False, "required": ["op"],
        "properties": {
            "op": {"enum": ["start", "status", "finish", "read", "forget"]},
            "ttl_minutes": {"type": "integer", "minimum": 1, "maximum": 30},
            "run_id": {"type": "string", "pattern": "^[0-9a-f]{32}$"},
            "offset": {"type": "integer", "minimum": 0, "maximum": 128},
        },
    },
}
