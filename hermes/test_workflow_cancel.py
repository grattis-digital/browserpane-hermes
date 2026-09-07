"""Cooperative cancellation survives restarts and never promises to undo input."""

import asyncio
import tempfile
import unittest
from unittest.mock import patch

from workflow_fixture import WorkflowFixture


class CancelTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="bph-cancel-")
        self.addCleanup(self.temp.cleanup)
        self.f = WorkflowFixture(self.temp.name)
        self.run_id = self.f.approve()

    def cancel(self):
        return self.f.journal.cancel(self.run_id, self.f.contract.fingerprint())

    def execute(self, reconcile=False):
        return asyncio.run(self.f.runner().execute(self.run_id, reconcile))

    def test_before_start_stops_without_connection_and_is_idempotent(self):
        self.assertEqual(self.cancel()["state"], "stopped")
        self.cancel()
        result = self.execute()
        self.assertEqual(result["code"], "CANCELLED_BEFORE_START")
        self.assertTrue(result["cancelRequested"])
        self.assertEqual(self.f.calls, [])

    def test_cancel_during_navigation_prevents_export(self):
        original = self.f.call
        async def call(name, args):
            result = await original(name, args)
            if name == "pane_act":
                self.cancel()
            return result
        with patch.object(self.f, "call", side_effect=call):
            result = self.execute()
        self.assertEqual(result["state"], "stopped")
        self.assertEqual(result["code"], "CANCEL_REQUESTED")
        self.assertFalse(any(name == "pane_flow" for name, _ in self.f.calls))

    def test_cancel_after_dispatch_is_uncertain_until_read_only_reconciliation(self):
        self.f.after_export = self.cancel
        result = self.execute()
        self.assertEqual(result["state"], "uncertain")
        self.assertTrue(result["cancelRequested"])
        calls = list(self.f.calls)
        self.execute()
        self.assertEqual(self.f.calls, calls)
        verified = self.execute(reconcile=True)
        self.assertTrue(verified["verified"] and verified["cancelRequested"])
        self.assertTrue(all(name == "pane_view" for name, _ in self.f.calls[len(calls):]))
        self.assertEqual(sum(name == "pane_flow" for name, _ in self.f.calls), 1)

    def test_cancel_does_not_relabel_a_completed_export(self):
        self.assertTrue(self.execute()["verified"])
        row = self.cancel()
        self.assertEqual(row["state"], "verified")
        self.assertNotIn("cancelRequested", row["evidence"])

    def test_cancel_racing_export_checkpoint_preserves_flag_and_prevents_dispatch(self):
        original = self.f.journal.checkpoint
        def checkpoint(*args, **kwargs):
            if args[3] == "exporting":
                self.cancel()
            return original(*args, **kwargs)
        with patch.object(self.f.journal, "checkpoint", side_effect=checkpoint):
            result = self.execute()
        self.assertEqual(result["state"], "stopped")
        self.assertTrue(result["cancelRequested"])
        self.assertFalse(any(name == "pane_flow" for name, _ in self.f.calls))
