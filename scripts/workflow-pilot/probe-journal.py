"""Characterize status-read lock contention using only a fresh temporary journal.

Run on stdin inside the pinned, network-free Hermes image. This intentionally
prints observed behavior rather than asserting that the current lock bug is good.
No existing journal, catalog or host data is opened.
"""

import json
import importlib.util
import sqlite3
import sys
import tempfile
import time
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, "/opt/hermes-bundle")
from workflow_runner.journal import RunJournal
from workflow_runner.private_files import PrivateFiles
from workflow_runner.control import WorkflowController

with tempfile.TemporaryDirectory(prefix="owned-journal-probe-") as directory:
    root = Path(directory) / "runs"
    journal = RunJournal(PrivateFiles(root), time.time, lambda: "a" * 32)
    binding = "b" * 64
    run = journal.approve(binding, binding)
    trace = []
    connect = sqlite3.connect
    def traced(*args, **kwargs):
        db = connect(*args, **kwargs)
        db.set_trace_callback(trace.append)
        return db
    module = "journal_db" if importlib.util.find_spec("workflow_runner.journal_db") else "journal"
    with patch("workflow_runner." + module + ".sqlite3.connect", side_effect=traced):
        journal.read(run, binding)
    class Service:
        def status(self, identifier, **_options):
            return journal.read(identifier, binding)
    controller = WorkflowController(Service(), time.time)
    writer = connect(root / "journal.sqlite3")
    writer.execute("BEGIN IMMEDIATE")
    reserved_response = json.loads(controller.handle({"op": "status", "run_id": run}))
    writer.rollback()
    writer.execute("BEGIN EXCLUSIVE")
    started = time.monotonic()
    response = json.loads(controller.handle({"op": "status", "run_id": run}))
    error = None
    try:
        journal.read(run, binding)
    except Exception as exc:
        error = {"type": type(exc).__name__, "message": str(exc), "sqliteCode": getattr(exc, "sqlite_errorname", None)}
    finally:
        writer.rollback()
        writer.close()
    print(json.dumps({"sqlite": sqlite3.sqlite_version, "statusReadSql": trace,
                     "reservedWriterResponse": reserved_response, "exclusiveWriterResponse": response, "exception": error,
                     "twoContendedReadsMs": (time.monotonic() - started) * 1000,
                     "unchangedState": journal.read(run, binding)["state"]}, indent=2))
