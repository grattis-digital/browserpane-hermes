"""Deterministic journal/input boundaries; no browser, SDK or model required."""

import asyncio
from contextlib import closing
import json
import tempfile
import unittest
from unittest.mock import patch

from workflow_fixture import WorkflowFixture
from workflow_runner.contracts import WorkflowError


class RunnerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="bph-recipe-test-")
        self.addCleanup(self.temp.cleanup)
        self.f = WorkflowFixture(self.temp.name)

    def execute(self, run, reconcile=False):
        return asyncio.run(self.f.runner().execute(run, reconcile))

    def test_review_gate_and_binding_conflicts_precede_browser_connection(self):
        with self.assertRaisesRegex(WorkflowError, "REVIEW_REQUIRED"):
            self.f.journal.approve(self.f.contract.fingerprint(), "yes")
        run = self.f.approve()
        with self.assertRaisesRegex(WorkflowError, "BINDING_MISMATCH"):
            self.f.journal.begin(run, "another-version")
        self.assertEqual(self.f.calls, [])

    def test_expired_approval_does_not_start(self):
        run = self.f.approve()
        self.f.now += 600
        with self.assertRaisesRegex(WorkflowError, "APPROVAL_EXPIRED"):
            self.execute(run)
        self.assertEqual(self.f.calls, [])

    def test_verified_export_duplicate_run_and_restart_make_no_additional_input(self):
        run = self.f.approve()
        first = self.execute(run)
        self.assertTrue(first["verified"])
        self.assertEqual(first["artifact"]["rows"], 1)
        calls = list(self.f.calls)
        self.assertTrue(self.execute(run)["verified"])
        self.assertTrue(self.execute(run, reconcile=True)["verified"])
        self.assertEqual(self.f.calls, calls)
        self.assertEqual(sum(name == "pane_flow" for name, _ in calls), 1)

    def test_wrong_report_does_not_trust_successful_tool_or_banner(self):
        self.f.fault = "wrong"
        run = self.f.approve()
        result = self.execute(run)
        self.assertFalse(result["verified"])
        self.assertEqual(result["state"], "uncertain")
        self.assertEqual(result["code"], "WRONG_REPORT_CONTENT")
        self.assertNotIn("1999-12", json.dumps(result))

    def test_wrong_marker_and_busy_tab_stop_before_export(self):
        self.f.fault = "marker"
        self.assertEqual(self.execute(self.f.approve())["code"], "PAGE_GUARD_FAILED")
        self.f.url, self.f.fault = "https://another.invalid/", None
        self.assertEqual(self.execute(self.f.approve())["code"], "SHARED_TAB_BUSY")
        self.assertFalse(any(name == "pane_flow" for name, _ in self.f.calls))

    def test_lost_reply_reconciles_by_reading_only_and_never_replays_export(self):
        self.f.fault = "lost"
        run = self.f.approve()
        first = self.execute(run)
        self.assertEqual(first["state"], "uncertain")
        self.assertNotIn("SECRET", json.dumps(first))
        count = len(self.f.calls)
        self.assertTrue(self.execute(run, reconcile=True)["verified"])
        self.assertTrue(all(name == "pane_view" for name, _ in self.f.calls[count:]))
        self.assertEqual(sum(name == "pane_flow" for name, _ in self.f.calls), 1)

    def test_hard_crash_after_dispatch_preserves_intent_and_fence_releases(self):
        class Crash(BaseException):
            pass
        def crash():
            raise Crash()
        self.f.after_export = crash
        run = self.f.approve()
        with self.assertRaises(Crash):
            self.execute(run)
        self.assertEqual(self.f.row(run)["state"], "exporting")
        calls = list(self.f.calls)
        self.assertFalse(self.execute(run)["verified"])
        self.assertEqual(self.f.calls, calls)
        self.assertTrue(self.execute(run, reconcile=True)["verified"])

    def test_browser_restart_loses_correlation_and_cannot_promote_artifact_alone(self):
        self.f.fault = "lost"
        run = self.f.approve()
        self.execute(run)
        self.f.records.clear()
        result = self.execute(run, reconcile=True)
        self.assertFalse(result["verified"])
        self.assertEqual(result["code"], "DOWNLOAD_NOT_CORRELATED")

    def test_uncertain_run_blocks_new_approval_execution_until_explicit_abandon(self):
        self.f.fault = "missing"
        run = self.f.approve()
        self.assertEqual(self.execute(run)["code"], "DOWNLOAD_TIMEOUT")
        following = self.f.approve()
        with self.assertRaisesRegex(WorkflowError, "UNRESOLVED_RUN"):
            self.execute(following)
        self.f.journal.abandon(run, self.f.contract.fingerprint(), self.f.contract.fingerprint())
        self.assertEqual(self.f.row(run)["state"], "abandoned")

    def test_failed_intent_commit_prevents_export_and_failed_result_commit_prevents_success(self):
        original = self.f.journal.checkpoint
        def fail_intent(run, binding, expected, state, code, evidence=None):
            if state == "exporting":
                raise OSError("DISK-FULL-SECRET")
            return original(run, binding, expected, state, code, evidence)
        with patch.object(self.f.journal, "checkpoint", side_effect=fail_intent):
            result = self.execute(self.f.approve())
        self.assertEqual(result["state"], "stopped")
        self.assertFalse(any(name == "pane_flow" for name, _ in self.f.calls))
        def fail_result(run, binding, expected, state, code, evidence=None):
            if state == "verified":
                raise OSError("DISK-FULL-SECRET")
            return original(run, binding, expected, state, code, evidence)
        with patch.object(self.f.journal, "checkpoint", side_effect=fail_result):
            result = self.execute(self.f.approve())
        self.assertFalse(result["verified"])
        self.assertEqual(result["state"], "uncertain")

    def test_partial_action_never_implies_verification_or_continuation(self):
        self.f.fault = "partial"
        result = self.execute(self.f.approve())
        self.assertFalse(result["verified"])
        self.assertEqual(result["code"], "INCOMPLETE_ACTION")

    def test_worker_fence_cannot_be_stolen_or_timed_out(self):
        run = self.f.approve()
        with self.f.journal.fence():
            with self.assertRaisesRegex(WorkflowError, "WORKER_BUSY"):
                self.execute(run)
        self.assertEqual(self.f.calls, [])

    def test_interrupted_before_dispatch_can_close_without_browser_connection(self):
        run = self.f.approve()
        self.f.journal.begin(run, self.f.contract.fingerprint())
        result = self.execute(run, reconcile=True)
        self.assertEqual(result["state"], "stopped")
        self.assertEqual(self.f.calls, [])

    def test_journal_omits_bindings_urls_page_text_and_ephemeral_handles(self):
        self.execute(self.f.approve())
        data = (self.f.root / "journal" / "journal.sqlite3").read_bytes()
        for value in (b"2026-06", b"ITEM-0001", b"fixture.invalid", b"Synthetic account", b'"lease"', b'"view"'):
            self.assertNotIn(value, data)

    def test_journal_capacity_preserves_existing_receipts(self):
        first = self.f.approve()
        for _ in range(31):
            self.f.approve()
        with self.assertRaisesRegex(WorkflowError, "JOURNAL_CAPACITY"):
            self.f.approve()
        self.assertEqual(self.f.row(first)["state"], "approved")

    def test_reconciliation_does_not_close_other_pending_runs(self):
        first = self.f.approve()
        self.f.fault = "lost"
        self.execute(first)
        second = self.f.approve()
        self.assertEqual(self.execute(second, reconcile=True)["state"], "approved")
        self.assertEqual(self.f.row(first)["state"], "uncertain")

    def test_unknown_journal_schema_is_rejected_without_reset(self):
        import sqlite3
        self.f.approve()
        database = self.f.root / "journal" / "journal.sqlite3"
        with closing(sqlite3.connect(database)) as db:
            db.execute("PRAGMA user_version=99")
        with self.assertRaisesRegex(WorkflowError, "JOURNAL_VERSION"):
            self.f.approve()
        with closing(sqlite3.connect(database)) as db:
            self.assertEqual(db.execute("PRAGMA user_version").fetchone()[0], 99)
            self.assertEqual(db.execute("SELECT count(*) FROM runs").fetchone()[0], 1)
