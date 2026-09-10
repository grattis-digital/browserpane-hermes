"""Bounded completion waiting avoids model polls without blocking cancellation."""

import asyncio
import json
import logging
import sqlite3
import tempfile
import threading
import unittest

from workflow_fixture import WorkflowFixture
from workflow_runner.catalog import ExecutionCatalog
from workflow_runner.contracts import WorkflowError
from workflow_runner.diagnostics import WorkflowDiagnostics
from workflow_runner.service import WorkflowService


class WaitTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="bph-wait-")
        self.addCleanup(self.temp.cleanup)
        self.f = WorkflowFixture(self.temp.name)
        self.catalog = ExecutionCatalog(self.f.root / "catalog", self.f.journal,
            self.f.contract.data()["endpoint"], self.f.downloads, lambda: self.f.now)
        self.service = WorkflowService(self.catalog, self.f.journal, self.f.connect, wait_seconds=1)
        self.addCleanup(self.service.close)
        self.run = self.f.approve()
        self.catalog.register(self.run, self.f.contract)
        self.entered, self.release = threading.Event(), threading.Event()
        self.addCleanup(self.release.set)
        original = self.f.call
        async def held(name, args):
            result = await original(name, args)
            if name == "pane_flow":
                self.entered.set()
                while not self.release.is_set():
                    await asyncio.sleep(0.001)
            return result
        self.f.call = held

    def test_run_returns_completed_work_without_a_status_turn(self):
        replies = []
        caller = threading.Thread(target=lambda: replies.append(self.service.execute(self.run)))
        caller.start()
        self.assertTrue(self.entered.wait(2))
        self.release.set()
        caller.join(2)
        self.assertFalse(caller.is_alive())
        self.assertTrue(replies[0]["verified"])
        self.assertFalse(replies[0]["active"])
        self.assertEqual(replies[0]["mcpCalls"], 5)

    def test_long_status_wait_does_not_hold_admission_or_cancel_lock(self):
        self.service._wait = 0
        self.assertTrue(self.service.execute(self.run)["active"])
        self.assertTrue(self.entered.wait(2))
        self.service._wait = 1
        replies = []
        caller = threading.Thread(target=lambda: replies.append(self.service.status(self.run, wait=True)))
        caller.start()
        cancelled = self.service.cancel(self.run)
        self.assertTrue(cancelled["cancelRequested"] and cancelled["active"])
        self.release.set()
        caller.join(2)
        self.assertFalse(caller.is_alive())
        self.assertEqual(replies[0]["state"], "uncertain")
        self.assertFalse(replies[0]["active"])
        self.assertEqual(sum(name == "pane_flow" for name, _ in self.f.calls), 1)

    def test_wait_is_bounded_and_never_queues_another_browser_job(self):
        self.service._wait = 0
        self.service.execute(self.run)
        self.assertTrue(self.entered.wait(2))
        calls = len(self.f.calls)
        result = self.service.status(self.run, wait=True)
        self.assertTrue(result["active"])
        self.assertEqual(result["pollAfterMs"], 1000)
        self.assertEqual(len(self.f.calls), calls)
        self.release.set()

    def test_operator_wait_configuration_rejects_unbounded_or_mistyped_values(self):
        for value in (True, -1, 11, "5", float("inf"), float("nan")):
            with self.assertRaisesRegex(WorkflowError, "INVALID_WORKFLOW_WAIT"):
                WorkflowService(self.catalog, self.f.journal, self.f.connect, wait_seconds=value)

    def test_failure_diagnostics_never_include_exception_text_or_private_values(self):
        cause = sqlite3.OperationalError("https://private.invalid/?token=SECRET /private/catalog")
        cause.sqlite_errorcode = 5
        error = WorkflowError("JOURNAL_BUSY")
        error.__cause__ = cause
        detail = WorkflowDiagnostics.fields("tool", error)
        self.assertEqual(detail, {"phase": "tool", "code": "JOURNAL_BUSY", "type": "OperationalError", "sqliteCode": 5})
        self.assertNotIn("private", json.dumps(detail))
        with self.assertLogs("workflow_runner", level="WARNING") as logs:
            WorkflowDiagnostics.report("tool", error)
        self.assertNotIn("SECRET", str(logs.output))
        class Broken(logging.Handler):
            def emit(self, record):
                raise OSError("logger unavailable")
        logger, handler = logging.getLogger("workflow_runner"), Broken()
        logger.addHandler(handler)
        try:
            WorkflowDiagnostics.report("tool", error)
        finally:
            logger.removeHandler(handler)
