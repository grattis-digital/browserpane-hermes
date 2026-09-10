"""Bounded, cooperative waits before fresh browser observations and intent commits."""

import math

from .contracts import WorkflowError, require


class WorkflowPacer:
    def __init__(self, policy, ledger, clock, sleep, random_source):
        self._policy, self._ledger = policy, ledger
        self._clock, self._sleep, self._random = clock, sleep, random_source
        self._wait_ms, self._admissions, self._reason, self._retry_ms = 0.0, 0, "PACING_READY", 0
        self._jitter = 0

    def fingerprint(self):
        return self._policy.fingerprint()

    def evidence(self):
        return {"digest": self.fingerprint(), "version": self._policy.data()["version"],
                "waitMs": round(self._wait_ms, 3), "admissions": self._admissions,
                "code": self._reason, "retryAfterMs": self._retry_ms}

    async def admit(self, check_cancel):
        values = self._policy.data()
        try:
            random_value = self._random() if values["jitterMs"] else 0
            require(type(random_value) in (int, float) and math.isfinite(random_value) and 0 <= random_value < 1,
                    "INVALID_PACING_RANDOM")
            jitter = math.floor(random_value * (values["jitterMs"] + 1))
            self._jitter = jitter
            remaining = max(0, values["maxWaitMs"] - self._wait_ms)
            deadline = self._clock() + remaining / 1000
            # Even a broken fake clock/sleeper cannot create an unbounded loop.
            for attempt in range(102):
                check_cancel()
                if attempt and self._clock() > deadline:
                    raise WorkflowError("PACING_WAIT_LIMIT")
                delay = self._ledger.reserve(self._policy, jitter)
                self._retry_ms = delay
                if delay == 0:
                    check_cancel()
                    self._admissions += 1
                    self._reason = "PACING_ADMITTED"
                    return
                available = max(0, (deadline - self._clock()) * 1000)
                # Do not truncate a cooldown and then send early. The execution
                # stops; status/run of this same ID never schedules another try.
                if delay > available + 0.001:  # Float roundoff only; never skip the remaining cooldown.
                    raise WorkflowError("PACING_DEFERRED")
                before = self._clock()
                try:
                    await self._sleep(min(delay / 1000, 0.1))
                finally:
                    self._wait_ms += max(0, (self._clock() - before) * 1000)
            raise WorkflowError("PACING_WAIT_LIMIT")
        except WorkflowError as error:
            self._reason = error.code
            raise

    def complete(self):
        self._ledger.complete(self._policy, self._jitter)
