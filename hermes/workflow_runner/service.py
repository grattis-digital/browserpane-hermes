"""Bounded in-process worker: one active job, no queue of browser mutations."""

import asyncio
from concurrent.futures import Future, TimeoutError
import math
import threading

from .contracts import require
from .runner import ReportRunner
from .warm import WarmLoop


class WorkflowService:
    def __init__(self, catalog, journal, connect, idle_seconds=30, wait_seconds=5):
        require(type(wait_seconds) in (int, float) and math.isfinite(wait_seconds)
                and 0 <= wait_seconds <= 10, "INVALID_WORKFLOW_WAIT")
        self.catalog, self.journal = catalog, journal
        self._connect, self._idle, self._wait = connect, idle_seconds, wait_seconds
        self._lock, self._ready = threading.RLock(), threading.Event()
        self._thread, self._loop, self._queue, self._active = None, None, None, None
        self._closed, self._failed, self._results = False, False, {}

    def _completed(self, job, result):
        with self._lock:
            self._results[job[0]] = result
            if len(self._results) > 32:
                self._results.pop(next(iter(self._results)))
            self._active = None
            job[3].set_result(result)

    def _thread_main(self):
        async def run():
            self._loop, self._queue = asyncio.get_running_loop(), asyncio.Queue(maxsize=1)
            self._ready.set()
            await WarmLoop(self.journal, self._connect, self._completed, self._idle).run(self._queue)
        try:
            asyncio.run(run())
        except BaseException:
            with self._lock:
                self._failed = True
                if self._active:
                    result = {"error": "WORKER_STOPPED", "next": "Inspect the durable run; do not replay."}
                    self._results[self._active[0]] = result
                    self._active[3].set_result(result)
                    self._active = None
        finally:
            self._ready.set()

    def _start(self):
        if self._thread is None:
            self._thread = threading.Thread(target=self._thread_main, name="browserpane-workflow", daemon=True)
            self._thread.start()
            require(self._ready.wait(5) and self._queue is not None, "WORKER_START_FAILED")
        require(not self._failed and self._thread.is_alive(), "WORKER_STOPPED")

    def status(self, run, *, wait=False):
        contract = self.catalog.load(run)
        if wait:
            with self._lock:
                future = self._active[3] if self._active and self._active[0] == run else None
            if future is not None:
                try:
                    future.result(timeout=self._wait)
                except TimeoutError:
                    pass  # Read current durable state; waiting never submits a job.
        with self._lock:
            # Read state while completion publication is excluded: never pair an old
            # exporting row with active=false from the worker that just verified it.
            row = self.journal.read(run, contract.fingerprint())
            active = self._active is not None and self._active[0] == run
            cached = self._results.get(run, {})
            if "error" in cached:
                cached = {"workerError": cached["error"]}
            elif cached.get("state") != row["state"]:
                cached = {}
            return {**cached, **ReportRunner.status(row), "active": active,
                    **({"pollAfterMs": 1000} if active else {})}

    def execute(self, run, reconcile=False):
        contract = self.catalog.load(run)
        with self._lock:
            require(not self._closed, "WORKER_CLOSED")
            if self._active:
                require(self._active[0] == run, "WORKER_BUSY")
                # A concurrent reconcile request joins the existing run; it cannot queue new work.
                future = self._active[3]
            else:
                row = self.journal.read(run, contract.fingerprint())
                eligible = row["state"] in self.journal.ACTIVE if reconcile else row["state"] == "approved"
                if not eligible:
                    return self.status(run)
                self._start()
                future = Future()
                self._results.pop(run, None)
                job = (run, contract, reconcile, future)
                self._active = job
                self._loop.call_soon_threadsafe(self._queue.put_nowait, job)
        try:
            result = future.result(timeout=self._wait)
            return result if "error" in result else self.status(run)
        except TimeoutError:
            return self.status(run)

    def cancel(self, run):
        contract = self.catalog.load(run)
        self.journal.cancel(run, contract.fingerprint())
        return self.status(run)

    def close(self):
        with self._lock:
            if self._closed:
                return
            self._closed = True
            try:
                if self._active:
                    run, contract, _, _ = self._active
                    self.journal.cancel(run, contract.fingerprint())
            finally:
                if self._loop and self._thread.is_alive():
                    # Enqueue shutdown behind the single active job; never cancel its SDK task.
                    asyncio.run_coroutine_threadsafe(self._queue.put(None), self._loop)
        if self._thread:
            self._thread.join(timeout=25)
            require(not self._thread.is_alive(), "WORKER_STILL_SETTLING")
