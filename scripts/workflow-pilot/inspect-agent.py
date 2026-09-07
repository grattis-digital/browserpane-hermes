"""Bounded private evidence before disposal; never create/recover or mutate a journal."""

import json
import os
from pathlib import Path
import sqlite3
import uuid


def main():
    token = os.environ["BPANE_WORKFLOW_PILOT"]
    assert str(uuid.UUID(token)) == token
    result = {}
    for home in ("warm", "safety"):
        root = Path("/opt/data") / home
        state = {"journals": {}, "diagnostics": []}
        for name in ("workflow-runs", "cold-runs"):
            path = root / name / "journal.sqlite3"
            if not path.exists():
                continue
            assert not path.is_symlink() and path.stat().st_size <= 16777216
            db = None
            try:
                db = sqlite3.connect(path.as_uri() + "?mode=ro", uri=True, timeout=0.05)
                rows = db.execute("SELECT id,state,code,evidence FROM runs ORDER BY rowid DESC LIMIT 32").fetchall()
                state["journals"][name] = [{"runId": run, "state": status, "code": code,
                    "cancelRequested": json.loads(evidence).get("cancelRequested", False)} for run, status, code, evidence in rows]
            except sqlite3.Error as error:
                state["journals"][name] = {"error": type(error).__name__, "sqliteCode": getattr(error, "sqlite_errorcode", 0)}
            finally:
                if db is not None:
                    db.close()
        for name in ("workflow-diagnostics.log.1", "workflow-diagnostics.log"):
            path = root / name
            if path.exists():
                assert not path.is_symlink() and path.stat().st_size <= 65536
                state["diagnostics"].extend(path.read_text().splitlines()[-100:])
        result[home] = state
    print(json.dumps(result))


if __name__ == "__main__":
    main()
