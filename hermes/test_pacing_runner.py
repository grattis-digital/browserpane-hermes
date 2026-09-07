"""Paced workflow boundaries. Every deliberate delay advances virtual time only."""

import asyncio
import tempfile
import unittest
from unittest.mock import patch

from pacing_fixture import PacingFixture
from workflow_runner.contracts import WorkflowError
from workflow_runner.journal import RunJournal
from workflow_runner.private_files import PrivateFiles


class PacingRunnerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="bph-pacing-runner-")
        self.addCleanup(self.temp.cleanup)
        self.f = PacingFixture(self.temp.name)

    def execute(self, run, reconcile=False):
        return asyncio.run(self.f.runner().execute(run, reconcile))

    def test_jitter_waits_before_fresh_view_not_inside_batch_and_evidence_survives(self):
        events, original, sleep = [], self.f.call, self.f.sleep
        async def call(name, args):
            events.append(name)
            return await original(name, args)
        async def wait(seconds):
            events.append("sleep")
            await sleep(seconds)
        self.f.call, self.f.sleep = call, wait
        result = self.execute(self.f.approve())
        self.assertTrue(result["verified"], result)
        self.assertAlmostEqual(result["policyWaitMs"], 1100, delta=1)
        self.assertEqual(result["pacing"]["admissions"], 2)
        self.assertEqual(events[:2], ["pane_view", "pane_act"])
        self.assertEqual(events[-3:], ["pane_view", "pane_flow", "pane_view"])
        self.assertTrue(all(value == "sleep" for value in events[2:-3]))
        self.assertEqual(len(self.f.calls), 5)
        ledger = (self.f.root / "workflow-pacing" / "journal.sqlite3").read_bytes()
        self.assertNotIn(b"fixture.invalid", ledger)

    def test_next_run_and_separate_cold_journal_share_the_same_site_cooldown(self):
        self.assertTrue(self.execute(self.f.approve())["verified"])
        self.f.journal = RunJournal(PrivateFiles(self.f.root / "cold-runs"), lambda: self.f.now,
                                   lambda: "c" * 32)
        result = self.execute(self.f.approve())
        self.assertTrue(result["verified"], result)
        self.assertAlmostEqual(result["policyWaitMs"], 2200, delta=2)

    def test_slow_browser_operation_does_not_erase_gap_before_following_input(self):
        original = self.f.call
        async def slow(name, args):
            value = await original(name, args)
            if name == "pane_act":
                self.f.now += 10
            return value
        self.f.call = slow
        result = self.execute(self.f.approve())
        self.assertTrue(result["verified"], result)
        self.assertAlmostEqual(result["policyWaitMs"], 1100, delta=1)

    def test_completion_storage_failure_leaves_export_uncertain_without_replay(self):
        run = self.f.approve()
        with patch("workflow_runner.pacing.WorkflowPacer.complete", side_effect=WorkflowError("JOURNAL_IO_ERROR")):
            # The first navigation fails its trailing ledger commit: no export input.
            self.assertEqual(self.execute(run)["state"], "stopped")
        self.assertEqual(len(self.f.calls), 2)
        run = self.f.approve()
        pacer = self.f.pacer()
        complete = pacer.complete
        calls = 0
        def fail_after_export():
            nonlocal calls
            calls += 1
            if calls == 2:
                raise WorkflowError("JOURNAL_FULL")
            complete()
        with patch.object(self.f, "pacer", return_value=pacer), patch.object(pacer, "complete", side_effect=fail_after_export):
            result = self.execute(run)
        self.assertEqual(result["state"], "uncertain")
        self.assertEqual(result["code"], "JOURNAL_FULL")
        self.execute(run)
        self.assertEqual(sum(name == "pane_flow" for name, _ in self.f.calls), 1)

    def test_long_quota_wait_returns_without_sleep_or_export_and_same_id_never_retries(self):
        self.f.configure(maxActions=1, maxWaitMs=1000)
        run = self.f.approve()
        result = self.execute(run)
        self.assertEqual(result["code"], "PACING_DEFERRED")
        self.assertEqual(result["state"], "stopped")
        self.assertEqual(result["policyWaitMs"], 0)
        self.assertEqual(result["pacing"]["retryAfterMs"], 60000)
        self.assertEqual(self.f.sleeps, [])
        self.assertEqual([name for name, _ in self.f.calls], ["pane_view", "pane_act"])
        self.f.now += 60
        self.execute(run)
        self.execute(run, reconcile=True)
        self.assertEqual(len(self.f.calls), 2)

    def test_zero_wait_budget_allows_immediate_admission_but_never_sleeps(self):
        self.f.configure(minIntervalMs=0, jitterMs=0, maxWaitMs=0)
        result = self.execute(self.f.approve())
        self.assertTrue(result["verified"], result)
        self.assertEqual(result["policyWaitMs"], 0)
        self.assertEqual(self.f.sleeps, [])

    def test_cancellation_during_wait_is_durable_and_prevents_export_intent(self):
        run = self.f.approve()
        self.f.on_sleep = lambda: self.f.journal.cancel(run, self.f.contract.fingerprint())
        result = self.execute(run)
        self.assertEqual(result["state"], "stopped")
        self.assertEqual(result["code"], "CANCEL_REQUESTED")
        self.assertTrue(result["cancelRequested"])
        self.assertNotIn("baseline", self.f.row(run)["evidence"])
        self.assertFalse(any(name == "pane_flow" for name, _ in self.f.calls))

    def test_human_navigation_during_wait_is_rechecked_before_export(self):
        self.f.on_sleep = lambda: setattr(self.f, "url", "https://another.invalid/")
        result = self.execute(self.f.approve())
        self.assertEqual(result["code"], "PAGE_GUARD_FAILED")
        self.assertEqual(result["state"], "stopped")
        self.assertFalse(any(name == "pane_flow" for name, _ in self.f.calls))

    def test_overslept_deadline_does_not_send_late_input(self):
        self.f.on_sleep = lambda: setattr(self.f, "now", self.f.now + 20)
        result = self.execute(self.f.approve())
        self.assertEqual(result["code"], "PACING_WAIT_LIMIT")
        self.assertFalse(any(name == "pane_flow" for name, _ in self.f.calls))

    def test_clock_that_never_advances_cannot_hold_worker_forever(self):
        async def frozen(seconds):
            self.f.sleeps.append(seconds)
        self.f.sleep = frozen
        result = self.execute(self.f.approve())
        self.assertEqual(result["code"], "PACING_WAIT_LIMIT")
        self.assertLessEqual(len(self.f.sleeps), 102)
        self.assertFalse(any(name == "pane_flow" for name, _ in self.f.calls))

    def test_uncertain_export_and_reconciliation_never_get_new_admissions_or_sleeps(self):
        self.f.fault = "lost"
        run = self.f.approve()
        result = self.execute(run)
        self.assertEqual(result["state"], "uncertain")
        waits = list(self.f.sleeps)
        with patch("workflow_runner.pacing_ledger.PacingLedger.reserve", side_effect=AssertionError("Replay")):
            self.execute(run)
            result = self.execute(run, reconcile=True)
        self.assertTrue(result["verified"])
        self.assertEqual(self.f.sleeps, waits)
        self.assertEqual(result["pacing"]["admissions"], 2)
        self.assertEqual(sum(name == "pane_flow" for name, _ in self.f.calls), 1)

    def test_failed_ledger_commit_cannot_reach_browser_input(self):
        with patch("workflow_runner.pacing_ledger.PacingLedger.reserve", side_effect=WorkflowError("JOURNAL_FULL")):
            result = self.execute(self.f.approve())
        self.assertEqual(result["code"], "JOURNAL_FULL")
        self.assertEqual(self.f.calls, [])

    def test_wait_budget_is_shared_across_both_admissions(self):
        self.assertTrue(self.execute(self.f.approve())["verified"])
        self.f.configure(maxWaitMs=1500)
        result = self.execute(self.f.approve())
        self.assertEqual(result["code"], "PACING_DEFERRED")
        self.assertAlmostEqual(result["policyWaitMs"], 1100, delta=1)
        self.assertEqual(result["pacing"]["admissions"], 1)

    def test_invalid_randomness_records_reason_without_admitting_or_opening_browser(self):
        for value in (float("nan"), float("inf"), -1, 1, True, "random"):
            pacer = self.f.pacer()
            with patch.object(pacer, "_random", return_value=value), patch.object(self.f, "pacer", return_value=pacer):
                result = self.execute(self.f.approve())
            self.assertEqual(result["code"], "INVALID_PACING_RANDOM")
            self.assertEqual(result["pacing"]["code"], "INVALID_PACING_RANDOM")
        self.assertEqual(self.f.calls, [])
        self.assertEqual(self.f.sleeps, [])

    def test_interrupted_wait_never_resumes_or_spends_a_second_admission(self):
        run = self.f.approve()
        def interrupted():
            raise KeyboardInterrupt()
        self.f.on_sleep = interrupted
        with self.assertRaises(KeyboardInterrupt):
            self.execute(run)
        self.assertEqual(self.f.row(run)["state"], "navigating")
        with patch("workflow_runner.pacing_ledger.PacingLedger.reserve", side_effect=AssertionError("Replay")):
            self.execute(run)
            result = self.execute(run, reconcile=True)
        self.assertEqual(result["code"], "INTERRUPTED_BEFORE_EXPORT")
        self.assertEqual(result["pacing"]["admissions"], 1)
        self.assertEqual([name for name, _ in self.f.calls], ["pane_view", "pane_act"])
