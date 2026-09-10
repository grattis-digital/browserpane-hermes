"""One lazy SDK connection, owned and closed by the same asyncio task (AnyIO)."""

import asyncio
from contextlib import AsyncExitStack, asynccontextmanager
import time
import random

from .artifacts import ReportArtifacts
from .contracts import WorkflowError, require
from .diagnostics import WorkflowDiagnostics
from .runner import ReportRunner
from .pacing_runtime import PacingRuntime


class WarmLoop:
    def __init__(self, journal, connect, completed, idle_seconds=30):
        self._journal, self._connect, self._completed = journal, connect, completed
        self._idle = idle_seconds
        self._stack, self._client, self._endpoint = AsyncExitStack(), None, None
        self.connections = 0

    async def _release(self):
        try:
            await self._stack.aclose()
        finally:
            self._client, self._endpoint = None, None

    @asynccontextmanager
    async def _borrow(self, endpoint):
        if self._client is None:
            self._client = await self._stack.enter_async_context(self._connect(endpoint))
            self._endpoint = endpoint
            self.connections += 1
        require(endpoint == self._endpoint, "CONFIGURATION_MISMATCH")
        yield self._client

    async def run(self, queue):
        try:
            while True:
                try:
                    job = await asyncio.wait_for(queue.get(), self._idle) if self._client else await queue.get()
                except asyncio.TimeoutError:
                    await self._release()
                    continue
                if job is None:
                    return
                run, contract, reconcile, _future = job
                started = time.monotonic()
                try:
                    pacer = PacingRuntime.create(contract, self._journal, time.monotonic, asyncio.sleep, time.time, random.random)
                    runner = ReportRunner(contract, self._journal, ReportArtifacts(contract.data()["downloads"]),
                                          self._borrow, time.monotonic, asyncio.sleep, pacing=pacer)
                    result = await runner.execute(run, reconcile)
                except Exception as error:
                    WorkflowDiagnostics.report("worker", error)
                    result = {"error": error.code if isinstance(error, WorkflowError) else "EXECUTION_UNCERTAIN"}
                # A broken transport is discarded, never retried for this logical execution.
                try:
                    if self._client and not self._client.healthy:
                        await self._release()
                except Exception:
                    pass  # Durable result is authoritative, even if transport teardown fails.
                self._completed(job, {**result, "workerMs": (time.monotonic() - started) * 1000})
        finally:
            await self._release()
