"""Dedicated pacing tests only: deterministic randomness and a virtual clock."""

from workflow_fixture import WorkflowFixture
from workflow_runner.contracts import ReportContract
from workflow_runner.pacing_runtime import PacingRuntime
from workflow_runner.runner import ReportRunner


class PacingFixture(WorkflowFixture):
    def __init__(self, root):
        super().__init__(root)
        self.sleeps, self.on_sleep = [], lambda: None
        self.policy = {"schema": 1, "version": 1, "origin": "https://fixture.invalid",
                       "minIntervalMs": 1000, "jitterMs": 200, "maxActions": 20,
                       "windowMs": 60000, "maxWaitMs": 5000}
        self.configure()

    def configure(self, **changes):
        self.policy.update(changes)
        self.contract = ReportContract(self.recipe, self.bindings, "http://127.0.0.1:8931/mcp",
                                       str(self.downloads), pacing=self.policy)

    async def sleep(self, seconds):
        self.sleeps.append(seconds)
        self.now = round(self.now + seconds, 6)
        self.on_sleep()

    def pacer(self):
        return PacingRuntime.create(self.contract, self.journal, lambda: self.now, self.sleep,
                                    lambda: self.now, lambda: 0.5)

    def runner(self):
        return ReportRunner(self.contract, self.journal, self.artifacts, self.connect,
                            lambda: self.now, self.sleep, pacing=self.pacer())
