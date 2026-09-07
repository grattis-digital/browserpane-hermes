"""Actual private SQLite, including independent processes; no real pacing waits."""

import json
import fcntl
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from pacing_fixture import PacingFixture
from workflow_runner.contracts import WorkflowError
from workflow_runner.journal_db import JournalDatabase
from workflow_runner.pacing_ledger import PacingLedger
from workflow_runner.pacing_policy import PacingPolicy
from workflow_runner.pacing_store import PacingStore
from workflow_runner.private_files import PrivateFiles


class PacingLedgerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="bph-pacing-ledger-")
        self.addCleanup(self.temp.cleanup)
        self.f = PacingFixture(self.temp.name)
        self.root = self.f.root / "ledger"
        self.db = JournalDatabase(PrivateFiles(self.root), schema=PacingLedger.SCHEMA)
        self.ledger = PacingLedger(PacingStore(PrivateFiles(self.root), self.db), lambda: self.f.now)

    def policy(self, **changes):
        return PacingPolicy({**self.f.policy, **changes}, self.f.recipe["url"])

    def test_interval_jitter_quota_and_fixed_window_expiry(self):
        policy = self.policy(maxActions=2)
        self.assertEqual(self.ledger.reserve(policy, 200), 0)
        self.assertEqual(self.ledger.reserve(policy, 200), 1200)
        self.f.now += 1.2
        self.assertEqual(self.ledger.reserve(policy, 0), 0)
        self.assertEqual(self.ledger.reserve(policy, 0), 58800)
        self.f.now += 58.8
        self.assertEqual(self.ledger.reserve(policy, 0), 0)

    def test_completion_after_window_expiry_keeps_trailing_gap(self):
        policy = self.policy(windowMs=1000)
        self.ledger.reserve(policy, 200)
        self.f.now += 10
        self.ledger.complete(policy, 200)
        self.assertEqual(self.ledger.reserve(policy, 0), 1200)
        self.f.now += 1.2
        self.assertEqual(self.ledger.reserve(policy, 0), 0)

    def test_busy_publication_lock_returns_without_resetting_or_waiting_forever(self):
        fd = PrivateFiles(self.root).open("worker.lock")
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with patch("workflow_runner.pacing_store.time.monotonic", side_effect=[1, 3]), \
                    patch("workflow_runner.pacing_store.time.sleep", side_effect=AssertionError("Real wait")):
                with self.assertRaisesRegex(WorkflowError, "PACING_STORE_BUSY"):
                    self.ledger.reserve(self.policy(), 0)
            self.assertFalse((self.root / "journal.sqlite3").exists())
        finally:
            os.close(fd)
        self.assertEqual(self.ledger.reserve(self.policy(), 0), 0)

    def test_new_policy_retains_usage_and_cannot_shorten_prior_window_or_gap(self):
        self.assertEqual(self.ledger.reserve(self.policy(maxActions=1), 200), 0)
        shorter = self.policy(minIntervalMs=0, jitterMs=0, maxActions=1, windowMs=1000)
        self.assertEqual(self.ledger.reserve(shorter, 0), 60000)
        longer = self.policy(maxActions=1, windowMs=120000)
        self.assertEqual(self.ledger.reserve(longer, 0), 120000)
        looser = self.policy(minIntervalMs=0, maxActions=2)
        self.assertEqual(self.ledger.reserve(looser, 0), 1200)

    def test_independent_origin_budgets_and_private_permissions(self):
        one = self.policy(maxActions=1)
        two = PacingPolicy({**self.f.policy, "origin": "https://other.invalid"}, "https://other.invalid/report")
        self.assertEqual(self.ledger.reserve(one, 0), 0)
        self.assertEqual(self.ledger.reserve(two, 0), 0)
        self.assertGreater(self.ledger.reserve(one, 0), 0)
        self.assertEqual(self.root.stat().st_mode & 0o777, 0o700)
        self.assertEqual((self.root / "journal.sqlite3").stat().st_mode & 0o777, 0o600)

    def test_capacity_is_bounded_and_old_entries_are_not_evicted_to_grant_a_burst(self):
        for index in range(128):
            origin = f"https://site-{index}.invalid"
            policy = PacingPolicy({**self.f.policy, "origin": origin}, origin + "/report")
            self.assertEqual(self.ledger.reserve(policy, 0), 0)
        with self.assertRaisesRegex(WorkflowError, "PACING_CAPACITY"):
            self.ledger.reserve(self.policy(), 0)

    def test_clock_rollback_and_invalid_clock_or_randomness_fail_closed(self):
        self.ledger.reserve(self.policy(), 0)
        self.f.now -= 1
        with self.assertRaisesRegex(WorkflowError, "PACING_CLOCK_ROLLBACK"):
            self.ledger.reserve(self.policy(), 0)
        for value in (float("nan"), float("inf"), -1, True, "time", 9007199254740):
            self.f.now = value
            with self.assertRaisesRegex(WorkflowError, "PACING_CLOCK_INVALID"):
                self.ledger.reserve(self.policy(), 0)
        for jitter in (-1, 201, True, 1.5):
            with self.assertRaisesRegex(WorkflowError, "INVALID_PACING_RANDOM"):
                self.ledger.reserve(self.policy(), jitter)

    def test_independent_processes_cannot_double_spend_the_same_site_slot(self):
        source = """
import json, sys
from workflow_runner.journal_db import JournalDatabase
from workflow_runner.pacing_ledger import PacingLedger
from workflow_runner.pacing_policy import PacingPolicy
from workflow_runner.pacing_store import PacingStore
from workflow_runner.private_files import PrivateFiles
policy = PacingPolicy(json.loads(sys.argv[2]), 'https://fixture.invalid/report')
db = JournalDatabase(PrivateFiles(sys.argv[1]), schema=PacingLedger.SCHEMA)
print(PacingLedger(PacingStore(PrivateFiles(sys.argv[1]), db), lambda: 1000).reserve(policy, 0))
"""
        children = [subprocess.Popen([sys.executable, "-c", source, str(self.root), json.dumps(self.f.policy)],
                    cwd=Path(__file__).resolve().parent, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
                    for _ in range(4)]
        try:
            results = []
            for child in children:
                stdout, stderr = child.communicate(timeout=5)
                self.assertEqual(child.returncode, 0, stderr)
                results.append(int(stdout))
            self.assertEqual(sorted(results), [0, 1000, 1000, 1000])
        finally:
            for child in children:
                if child.poll() is None:
                    child.kill()
                child.communicate(timeout=5)

    def test_failed_durable_commit_preserves_previous_budget(self):
        self.ledger.reserve(self.policy(), 0)
        self.f.now += 1
        connect = sqlite3.connect
        class FailedCommit(sqlite3.Connection):
            def commit(self):
                error = sqlite3.OperationalError("private path")
                error.sqlite_errorcode = 13
                raise error
        def failed(*args, **kwargs):
            return connect(*args, **kwargs, factory=FailedCommit)
        with patch("workflow_runner.journal_db.sqlite3.connect", side_effect=failed):
            with self.assertRaisesRegex(WorkflowError, "JOURNAL_FULL"):
                self.ledger.reserve(self.policy(), 0)
        with self.db.open() as db:
            row = db.execute("SELECT * FROM budgets").fetchone()
            self.assertEqual(row["used"], 1)
            self.assertEqual(row["last_ms"], 1000000)

    def test_corrupt_rows_and_unsafe_symlinks_never_reset_the_budget(self):
        self.ledger.reserve(self.policy(), 0)
        with self.db.open(write=True) as db:
            db.execute("UPDATE budgets SET used=-1")
        with self.assertRaisesRegex(WorkflowError, "PACING_STORE_INVALID"):
            self.ledger.reserve(self.policy(), 0)
        path = self.root / "journal.sqlite3"
        path.unlink()
        target = self.f.root / "untouched"
        target.write_text("private")
        path.symlink_to(target)
        with self.assertRaisesRegex(WorkflowError, "UNSAFE_STORE"):
            self.ledger.reserve(self.policy(), 0)
        self.assertEqual(target.read_text(), "private")
