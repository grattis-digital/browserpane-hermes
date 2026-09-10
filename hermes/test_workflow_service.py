"""Warm task ownership, concurrency, shutdown and per-run accounting."""

import asyncio
from contextlib import asynccontextmanager
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

from workflow_fixture import WorkflowFixture
from workflow_runner.catalog import ExecutionCatalog
from workflow_runner.contracts import WorkflowError
from workflow_runner.service import WorkflowService


class ServiceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="bph-warm-")
        self.addCleanup(self.temp.cleanup)
        self.f = WorkflowFixture(self.temp.name)
        self.opened, self.closed, self.ownership = [], [], []
        self.catalog = ExecutionCatalog(self.f.root / "catalog", self.f.journal,
            self.f.contract.data()["endpoint"], self.f.downloads, lambda: self.f.now)
        self.service = WorkflowService(self.catalog, self.f.journal, self.connect, wait_seconds=0.01)
        self.addCleanup(self.service.close)

    @asynccontextmanager
    async def connect(self, endpoint):
        task = asyncio.current_task()
        self.opened.append(task)
        try:
            yield self.f
        finally:
            self.closed.append(task)
            self.ownership.append(asyncio.current_task() is task)

    def register(self):
        run = self.f.approve()
        self.catalog.register(run, self.f.contract)
        return run

    def settled(self, run):
        deadline = time.monotonic() + 3
        while True:
            result = self.service.status(run)
            if not result["active"]:
                return result
            self.assertLess(time.monotonic(), deadline)
            time.sleep(0.005)

    def test_repeated_runs_share_connection_ids_increase_and_metrics_do_not_accumulate(self):
        runs = [self.register(), self.register()]
        for run in runs:
            self.service.execute(run)
            result = self.settled(run)
            self.assertTrue(result["verified"], result)
            self.assertEqual(result["mcpCalls"], 5)
        self.assertEqual(len(self.opened), 1)
        self.assertEqual([args["request"] for name, args in self.f.calls if name != "pane_view"], [1, 2, 3, 4])
        self.service.execute(runs[0])
        self.assertEqual(len(self.f.calls), 10)
        self.service.close()
        self.assertEqual(len(self.closed), 1)
        self.assertTrue(all(self.ownership))

    def test_idle_releases_connection_in_its_owner_task(self):
        self.service._idle = 0.05
        run = self.register()
        self.service.execute(run)
        self.settled(run)
        deadline = time.monotonic() + 2
        while not self.closed and time.monotonic() < deadline:
            time.sleep(0.01)
        self.assertEqual(len(self.closed), 1)
        run = self.register()
        self.service.execute(run)
        self.assertTrue(self.settled(run)["verified"])
        self.assertEqual(len(self.opened), 2)
        self.assertTrue(all(self.ownership))

    def test_busy_rejects_other_id_and_same_id_joins_without_queued_replay(self):
        entered, release = threading.Event(), threading.Event()
        self.addCleanup(release.set)
        original = self.f.call
        async def call(name, args):
            if name == "pane_flow":
                entered.set()
                while not release.is_set():
                    await asyncio.sleep(0.001)
            return await original(name, args)
        self.f.call = call
        first, second = self.register(), self.register()
        self.service.execute(first)
        self.assertTrue(entered.wait(2))
        self.assertTrue(self.service.execute(first)["active"])
        with self.assertRaisesRegex(WorkflowError, "WORKER_BUSY"):
            self.service.execute(second)
        self.assertEqual(self.f.row(second)["state"], "approved")
        self.assertTrue(self.service.cancel(first)["cancelRequested"])
        release.set()
        self.assertEqual(self.settled(first)["state"], "uncertain")
        self.service.execute(first, reconcile=True)
        self.assertTrue(self.settled(first)["verified"])
        self.assertEqual(sum(name == "pane_flow" for name, _ in self.f.calls), 1)

    def test_unload_requests_cancel_but_allows_dispatched_batch_to_settle(self):
        entered, release = threading.Event(), threading.Event()
        self.addCleanup(release.set)
        original = self.f.call
        async def call(name, args):
            result = await original(name, args)
            if name == "pane_flow":
                entered.set()
                while not release.is_set():
                    await asyncio.sleep(0.001)
            return result
        self.f.call = call
        run = self.register()
        self.service.execute(run)
        self.assertTrue(entered.wait(2))
        closer = threading.Thread(target=self.service.close)
        closer.start()
        deadline = time.monotonic() + 2
        while not self.f.row(run)["evidence"].get("cancelRequested") and time.monotonic() < deadline:
            time.sleep(0.005)
        self.assertTrue(closer.is_alive())
        release.set()
        closer.join(3)
        self.assertFalse(closer.is_alive())
        self.assertFalse(self.service._thread.is_alive())
        self.assertEqual(self.f.row(run)["state"], "uncertain")
        self.assertTrue(all(self.ownership))

    def test_restart_and_unknown_outcome_do_not_replay(self):
        self.f.fault = "lost"
        run = self.register()
        self.service.execute(run)
        self.assertEqual(self.settled(run)["state"], "uncertain")
        self.service.close()
        calls = len(self.f.calls)
        again = WorkflowService(self.catalog, self.f.journal, self.connect)
        self.addCleanup(again.close)
        self.assertEqual(again.execute(run)["state"], "uncertain")
        self.assertEqual(len(self.f.calls), calls)
        self.assertIsNone(again._thread)

    def test_async_admission_errors_remain_visible_in_status_without_dispatch(self):
        run = self.register()
        self.f.now += 600
        self.service._wait = 0
        self.service.execute(run)
        result = self.settled(run)
        self.assertEqual(result["state"], "approved")
        self.assertEqual(result["workerError"], "APPROVAL_EXPIRED")
        self.assertEqual(self.f.calls, [])

    def test_status_reads_its_published_row_under_the_completion_lock(self):
        run, owned = self.register(), []
        original = self.f.journal.read
        def read(*args):
            owned.append(self.service._lock._is_owned())
            return original(*args)
        with patch.object(self.f.journal, "read", side_effect=read):
            result = self.service.status(run)
        self.assertTrue(owned[-1])
        self.assertEqual(result["state"], "approved")
        self.assertFalse(result["active"])

    def test_failed_transport_is_discarded_without_automatic_retry(self):
        self.f.fault = "lost"
        self.f.after_export = lambda: setattr(self.f, "healthy", False)
        run = self.register()
        self.service.execute(run)
        self.assertEqual(self.settled(run)["state"], "uncertain")
        self.assertEqual(len(self.closed), 1)
        self.assertEqual(sum(name == "pane_flow" for name, _ in self.f.calls), 1)
        self.f.healthy = True
        self.service.execute(run, reconcile=True)
        self.assertTrue(self.settled(run)["verified"])
        self.assertEqual(len(self.opened), 2)
        self.assertEqual(sum(name == "pane_flow" for name, _ in self.f.calls), 1)
