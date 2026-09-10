"""Content-free failure classification: no messages, paths, run IDs, URLs or input."""

import logging
import json
import re
import sqlite3

from .contracts import WorkflowError
from .mcp_failure import CompactFailure


class WorkflowDiagnostics:
    @staticmethod
    def fields(phase, error):
        phase = phase if phase in ("tool", "worker", "execution") else "unknown"
        code = error.code if isinstance(error, WorkflowError) else "UNEXPECTED_ERROR"
        if not isinstance(code, str) or not re.fullmatch(r"[A-Z_]{1,64}", code):
            code = "UNEXPECTED_ERROR"
        cause = error.__cause__ if error.__cause__ is not None else error
        kind = type(cause).__name__
        if not re.fullmatch(r"[A-Za-z]{1,64}", kind):
            kind = "UnknownError"
        storage = getattr(cause, "sqlite_errorcode", 0) if isinstance(cause, sqlite3.Error) else 0
        storage = storage if type(storage) is int and 0 <= storage <= 65535 else 0
        return {"phase": phase, "code": code, "type": kind, "sqliteCode": storage,
                **({"progress": error.progress} if isinstance(error, CompactFailure) else {})}

    @classmethod
    def report(cls, phase, error):
        detail = cls.fields(phase, error)
        try:
            logging.getLogger("workflow_runner").warning("workflow_failure phase=%s code=%s type=%s sqlite=%s progress=%s",
                detail["phase"], detail["code"], detail["type"], detail["sqliteCode"],
                json.dumps(detail.get("progress", {}), separators=(",", ":")))
        except Exception:
            pass  # Best-effort observability cannot prevent an uncertainty checkpoint.
