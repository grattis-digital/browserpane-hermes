"""Real SQLite read/write and POSIX-lock regressions on fresh private journals."""

import asyncio
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

from workflow_fixture import WorkflowFixture
from workflow_runner.contracts import WorkflowError
from workflow_runner.journal_db import JournalDatabase
from workflow_runner.private_files import PrivateFiles


class JournalTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="bph-journal-")
        self.addCleanup(self.temp.cleanup)
        self.f = WorkflowFixture(self.temp.name)
        self.run = self.f.approve()
        self.binding = self.f.contract.fingerprint()
        self.path = self.f.journal._files.root / "journal.sqlite3"

    def read(self):
        return self.f.journal.read(self.run, self.binding)

    def test_status_is_read_only_and_does_not_reinitialize_or_touch_database(self):
        before, metadata, trace = self.path.read_bytes(), self.path.stat(), []
        connect = sqlite3.connect
        def traced(*args, **kwargs):
            self.assertTrue(args[0].endswith("?mode=ro"))
            db = connect(*args, **kwargs)
            db.set_trace_callback(trace.append)
            return db
        with patch("workflow_runner.journal_db.sqlite3.connect", side_effect=traced):
            self.assertEqual(self.read()["state"], "approved")
        self.assertTrue(all(sql.startswith(("SELECT ", "PRAGMA user_version")) for sql in trace), trace)
        self.assertEqual(self.path.read_bytes(), before)
        self.assertEqual(self.path.stat().st_mtime_ns, metadata.st_mtime_ns)
        with self.f.journal._database.open() as db:
            with self.assertRaises(sqlite3.OperationalError):
                db.execute("UPDATE runs SET state='verified'")

    def test_missing_read_never_creates_a_directory_or_database(self):
        root = self.f.root / "not-created"
        database = JournalDatabase(PrivateFiles(root))
        with self.assertRaisesRegex(WorkflowError, "JOURNAL_NOT_FOUND"):
            with database.open():
                self.fail("Missing journal opened")
        self.assertFalse(root.exists())

    def test_read_during_reserved_writer_preserves_cross_process_locks(self):
        writer = sqlite3.connect(self.path)
        try:
            writer.execute("BEGIN IMMEDIATE")
            writer.execute("UPDATE runs SET state='prepared'")
            # Reader sees committed evidence, not the pending change. SQLite alone
            # must own database descriptors; a raw close() would unlock this writer.
            for _ in range(10):
                self.assertEqual(self.read()["state"], "approved")
            child = subprocess.run([sys.executable, "-c", """
import sqlite3, sys
db = sqlite3.connect(sys.argv[1], timeout=0)
try:
    db.execute('BEGIN IMMEDIATE')
except sqlite3.OperationalError:
    print('locked')
else:
    print('UNSAFE_UNLOCK')
finally:
    db.close()
""", str(self.path)], capture_output=True, text=True, check=True, timeout=5)
            self.assertEqual(child.stdout.strip(), "locked")
            writer.commit()
        finally:
            writer.close()
        self.assertEqual(self.read()["state"], "prepared")
        with self.f.journal._database.open() as db:
            self.assertEqual(db.execute("PRAGMA integrity_check").fetchone()[0], "ok")

    def test_busy_write_and_exclusive_read_are_typed_without_false_cancellation(self):
        writer = sqlite3.connect(self.path)
        connect = sqlite3.connect
        def quick(*args, **kwargs):
            return connect(*args, **{**kwargs, "timeout": 0.01})
        try:
            writer.execute("BEGIN EXCLUSIVE")
            with patch("workflow_runner.journal_db.sqlite3.connect", side_effect=quick):
                for call in (self.read, lambda: self.f.journal.cancel(self.run, self.binding)):
                    with self.assertRaisesRegex(WorkflowError, "JOURNAL_BUSY") as raised:
                        call()
                    self.assertIsInstance(raised.exception.__cause__, sqlite3.OperationalError)
        finally:
            writer.rollback()
            writer.close()
        self.assertNotIn("cancelRequested", self.read()["evidence"])
        self.assertEqual(self.read()["state"], "approved")

    def test_status_threads_and_cancellation_do_not_corrupt_or_drop_the_flag(self):
        self.f.journal.begin(self.run, self.binding)
        start, errors = threading.Barrier(4), []
        def worker(cancel=False):
            try:
                start.wait(timeout=3)
                for _ in range(30):
                    if cancel:
                        self.f.journal.cancel(self.run, self.binding)
                    else:
                        self.read()
            except BaseException as error:
                errors.append(error)
        threads = [threading.Thread(target=worker, args=(index == 0,)) for index in range(3)]
        for thread in threads:
            thread.start()
        start.wait(timeout=3)
        for thread in threads:
            thread.join(5)
            self.assertFalse(thread.is_alive())
        self.assertEqual(errors, [], [(str(error), repr(error.__cause__)) for error in errors])
        self.assertTrue(self.read()["evidence"]["cancelRequested"])
        with self.assertRaisesRegex(WorkflowError, "CANCEL_REQUESTED"):
            self.f.journal.checkpoint(self.run, self.binding, "prepared", "navigating", "NAVIGATION_INTENT")

    def test_writes_keep_full_sync_and_unknown_version_is_never_rewritten(self):
        with self.f.journal._database.open(write=True) as db:
            self.assertEqual(db.execute("PRAGMA synchronous").fetchone()[0], 2)
            db.execute("PRAGMA user_version=99")
        before = self.path.read_bytes()
        for access in ({}, {"write": True, "initialize": True}):
            with self.assertRaisesRegex(WorkflowError, "JOURNAL_VERSION"):
                with self.f.journal._database.open(**access):
                    pass
        self.assertEqual(self.path.read_bytes(), before)

    def test_unsafe_database_link_is_rejected_without_following_or_modifying_it(self):
        self.path.unlink()
        target = Path(self.temp.name) / "secret"
        target.write_text("untouched")
        self.path.symlink_to(target)
        for initialize in (False, True):
            with self.assertRaisesRegex(WorkflowError, "UNSAFE_STORE"):
                with self.f.journal._database.open(write=initialize, initialize=initialize):
                    pass
        self.assertEqual(target.read_text(), "untouched")

    def test_storage_codes_are_bounded_and_do_not_expose_exception_messages(self):
        for number, expected in ((5, "JOURNAL_BUSY"), (10, "JOURNAL_IO_ERROR"), (11, "JOURNAL_CORRUPT"),
                                 (13, "JOURNAL_FULL"), (776, "JOURNAL_RECOVERY_REQUIRED")):
            error = sqlite3.OperationalError("private/path?token=secret")
            error.sqlite_errorcode = number
            self.assertEqual(JournalDatabase.error_code(error), expected)

    def test_failed_full_sync_export_commit_prevents_browser_export_input(self):
        run, connect = self.run, sqlite3.connect
        class FailedCommit(sqlite3.Connection):
            def commit(self):
                if self.execute("SELECT state FROM runs WHERE id=?", (run,)).fetchone()[0] == "exporting":
                    error = sqlite3.OperationalError("simulated disk full")
                    error.sqlite_errorcode = 13
                    raise error
                return super().commit()
        def open_failed(*args, **kwargs):
            return connect(*args, **kwargs, factory=FailedCommit)
        with patch("workflow_runner.journal_db.sqlite3.connect", side_effect=open_failed):
            result = asyncio.run(self.f.runner().execute(self.run))
        self.assertEqual(result["state"], "stopped")
        self.assertEqual(result["code"], "JOURNAL_FULL")
        self.assertFalse(result["verified"])
        self.assertFalse(any(name == "pane_flow" for name, _ in self.f.calls))
