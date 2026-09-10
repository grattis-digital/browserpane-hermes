"""Write-ahead local execution state. Browser input is NOT atomic with SQLite."""

import json
import re

from .contracts import canonical, require
from .journal_db import JournalDatabase


class RunJournal:
    ACTIVE = ("prepared", "navigating", "exporting", "verifying", "uncertain")

    def __init__(self, files, clock, ids):
        self._files, self._clock, self._ids = files, clock, ids
        self._database = JournalDatabase(files)

    def fence(self):
        return self._files.fence()

    def storage_root(self):
        return self._files.root

    def record_pacing(self, run_id, binding, evidence):
        with self._database.open(write=True) as db:
            row = self._get(db, run_id, binding)
            require(row["state"] in ("prepared", "navigating"), "INVALID_TRANSITION")
            value = canonical({**row["evidence"], "pacing": evidence})
            require(len(value) <= 65536, "EVIDENCE_LIMIT")
            db.execute("UPDATE runs SET evidence=? WHERE id=?", (value, run_id))

    @staticmethod
    def _get(db, run_id, binding):
        require(isinstance(run_id, str) and re.fullmatch(r"[0-9a-f]{32}", run_id), "INVALID_RUN_ID")
        row = db.execute("SELECT * FROM runs WHERE id=?", (run_id,)).fetchone()
        require(row is not None, "RUN_NOT_FOUND")
        require(row["binding"] == binding, "BINDING_MISMATCH")
        return {**dict(row), "evidence": json.loads(row["evidence"])}

    def approve(self, binding, acknowledged):
        require(isinstance(binding, str) and re.fullmatch(r"[0-9a-f]{64}", binding)
                and acknowledged == binding, "REVIEW_REQUIRED")
        with self._database.open(write=True, initialize=True) as db:
            require(db.execute("SELECT count(*) FROM runs").fetchone()[0] < 32, "JOURNAL_CAPACITY")
            run_id = self._ids()
            require(re.fullmatch(r"[0-9a-f]{32}", run_id), "INVALID_RUN_ID")
            db.execute("INSERT INTO runs VALUES (?,?,?,?,?,?)", (run_id, binding, self._clock() + 600, "approved", "{}", "REVIEW_ACKNOWLEDGED"))
            return run_id

    def read(self, run_id, binding):
        with self._database.open() as db:
            return self._get(db, run_id, binding)

    def begin(self, run_id, binding):
        with self._database.open(write=True) as db:
            row = self._get(db, run_id, binding)
            if row["state"] != "approved":
                return False  # Duplicate requests return state, never dispatch again.
            require(row["expires"] > self._clock(), "APPROVAL_EXPIRED")
            active = db.execute("SELECT count(*) FROM runs WHERE state IN ('prepared','navigating','exporting','verifying','uncertain')").fetchone()[0]
            require(active == 0, "UNRESOLVED_RUN")
            db.execute("UPDATE runs SET state='prepared',code='READY' WHERE id=?", (run_id,))
            return True

    def checkpoint(self, run_id, binding, expected, state, code, evidence=None):
        transitions = {"prepared": {"navigating", "stopped", "uncertain"},
                       "navigating": {"exporting", "stopped", "uncertain"},
                       "exporting": {"verifying", "uncertain"}, "verifying": {"verified", "uncertain"},
                       "uncertain": {"verifying", "stopped"}}
        require(state in transitions.get(expected, set()), "INVALID_TRANSITION")
        require(re.fullmatch(r"[A-Z_]{1,64}", code), "INVALID_CODE")
        with self._database.open(write=True) as db:
            row = self._get(db, run_id, binding)
            require(row["state"] == expected, "STALE_WORKER")
            cancelled = row["evidence"].get("cancelRequested", False)
            require(not cancelled or state not in ("navigating", "exporting"), "CANCEL_REQUESTED")
            merged = dict(row["evidence"] if evidence is None else evidence)
            if "pacing" in row["evidence"]:
                merged["pacing"] = row["evidence"]["pacing"]
            if cancelled:
                merged["cancelRequested"] = True
            value = canonical(merged)
            require(len(value) <= 65536, "EVIDENCE_LIMIT")
            db.execute("UPDATE runs SET state=?,code=?,evidence=? WHERE id=?", (state, code, value, run_id))

    def cancel(self, run_id, binding):
        # Do not acquire the worker fence or interrupt an in-flight SDK request.
        with self._database.open(write=True) as db:
            row = self._get(db, run_id, binding)
            if row["state"] == "approved" or row["state"] in self.ACTIVE:
                evidence = canonical({**row["evidence"], "cancelRequested": True})
                require(len(evidence) <= 65536, "EVIDENCE_LIMIT")
                state = "stopped" if row["state"] == "approved" else row["state"]
                code = "CANCELLED_BEFORE_START" if row["state"] == "approved" else row["code"]
                db.execute("UPDATE runs SET state=?,code=?,evidence=? WHERE id=?", (state, code, evidence, run_id))
            return self._get(db, run_id, binding)

    def abandon(self, run_id, binding, acknowledged):
        require(acknowledged == binding, "REVIEW_REQUIRED")
        with self.fence(), self._database.open(write=True) as db:
            row = self._get(db, run_id, binding)
            require(row["state"] in self.ACTIVE or row["state"] == "approved", "TERMINAL_RUN")
            db.execute("UPDATE runs SET state='abandoned',code='OPERATOR_CLOSED_UNVERIFIED' WHERE id=?", (run_id,))
