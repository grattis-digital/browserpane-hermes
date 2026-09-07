"""One supervised export, zero inference. Unknown outcomes never authorize replay."""

from .contracts import WorkflowError, digest, require
from .diagnostics import WorkflowDiagnostics


class ReportRunner:
    def __init__(self, contract, journal, artifacts, connect, clock, sleep, *, pacing=None):
        self._contract, self._journal, self._artifacts = contract, journal, artifacts
        self._connect, self._clock, self._sleep = connect, clock, sleep
        policy = contract.data().get("pacing")
        require((policy is None and pacing is None) or (policy is not None and pacing is not None
                and pacing.fingerprint() == digest(policy)), "PACING_CONFIGURATION_MISMATCH")
        self._pacing = pacing

    @staticmethod
    def status(row):
        return {"runId": row["id"], "digest": row["binding"], "state": row["state"], "code": row["code"],
                "verified": row["state"] == "verified", "modelCalls": 0,
                "cancelRequested": row["evidence"].get("cancelRequested", False),
                "artifact": row["evidence"].get("verifiedArtifact"),
                "policyWaitMs": row["evidence"].get("pacing", {}).get("waitMs", 0),
                **({"pacing": row["evidence"]["pacing"]} if "pacing" in row["evidence"] else {}),
                "accounting": "Runner only; Hermes selection, learning and repair are outside this interval."}

    def _checkpoint(self, run, state, code, evidence=None):
        row = self._journal.read(run, self._contract.fingerprint())
        self._journal.checkpoint(run, row["binding"], row["state"], state, code, evidence)

    def _check_cancel(self, run):
        require(not self._journal.read(run, self._contract.fingerprint())["evidence"].get("cancelRequested"), "CANCEL_REQUESTED")

    async def _admit(self, run):
        if self._pacing is not None:
            try:
                await self._pacing.admit(lambda: self._check_cancel(run))
            finally:
                self._journal.record_pacing(run, self._contract.fingerprint(), self._pacing.evidence())

    async def _input(self, client, name, arguments):
        try:
            value = await client.call(name, arguments)
        except BaseException:
            if self._pacing is not None:
                try:
                    self._pacing.complete()
                except Exception as error:
                    WorkflowDiagnostics.report("pacing", error)
            raise  # Preserve the input failure and uncertainty, never retry.
        if self._pacing is not None:
            self._pacing.complete()
        return value

    async def execute(self, run, reconcile=False):
        start, metrics = self._clock(), {"mcpCalls": 0, "responseJsonBytes": 0, "mcpMs": 0}
        with self._journal.fence():
            binding = self._contract.fingerprint()
            if not reconcile and not self._journal.begin(run, binding):
                return self.status(self._journal.read(run, binding))
            row = self._journal.read(run, binding)
            if reconcile and row["state"] not in self._journal.ACTIVE:
                return self.status(row)
            try:
                if reconcile and "baseline" not in row["evidence"]:
                    self._checkpoint(run, "stopped", "INTERRUPTED_BEFORE_EXPORT")
                else:
                    if not reconcile:
                        await self._admit(run)
                    async with self._connect(self._contract.data()["endpoint"]) as client:
                        before = client.metrics()
                        try:
                            if reconcile:
                                await self._verify(run, client, reconcile=True)
                            else:
                                await self._export(run, client)
                        except Exception as error:
                            self._fail(run, error)
                        finally:
                            metrics = {key: value - before[key] for key, value in client.metrics().items()}
            except Exception as error:
                self._fail(run, error)
            result = self.status(self._journal.read(run, binding))
            return {**result, **metrics, "executionMs": (self._clock() - start) * 1000}

    def _fail(self, run, error):
        WorkflowDiagnostics.report("execution", error)
        row = self._journal.read(run, self._contract.fingerprint())
        # If persistence itself failed, this checkpoint may fail too. The last
        # durable intent remains unresolved and blocks the next run.
        if row["state"] in self._journal.ACTIVE:
            state = "stopped" if row["state"] in ("prepared", "navigating") else "uncertain"
            if row["state"] != state:
                self._checkpoint(run, state, error.code if isinstance(error, WorkflowError) else "EXECUTION_UNCERTAIN")

    @staticmethod
    def _complete(value, count, stages=None):
        require(not value.get("error") and not value.get("observationError") and not value.get("stopped")
                and type(value.get("completed")) is int and value["completed"] == count
                and value.get("pendingStep") is None and value.get("failedStage") is None, "INCOMPLETE_ACTION")
        if stages is not None:
            require(type(value.get("stages")) is int and value["stages"] == stages, "INCOMPLETE_ACTION")

    async def _view(self, client, tab=None):
        recipe = self._contract.data()["recipe"]
        value = await client.call("pane_view", {**({"tab": tab} if tab else {}),
            "query": {**recipe["marker"], "exact": True}, "limit": 4, "maxChars": 1024})
        require(value.get("url") == recipe["url"] and type(value.get("matches")) is int and value["matches"] == 1
                and not value.get("dialog") and not value.get("truncated"), "PAGE_GUARD_FAILED")
        require(all(isinstance(value.get(key), str) and value[key] for key in ("lease", "tab", "view")), "INVALID_MCP_REPLY")
        return value

    async def _export(self, run, client):
        data = self._contract.data()
        recipe, bindings = data["recipe"], data["bindings"]
        self._check_cancel(run)
        current = await client.call("pane_view", {"detail": "controls", "limit": 1, "maxChars": 64})
        # Do not commandeer some other task's tab. No implicit tab creation or selection.
        require(current.get("url") in ("about:blank", recipe["url"]) and not current.get("dialog"), "SHARED_TAB_BUSY")
        require(all(isinstance(current.get(key), str) and current[key] for key in ("lease", "tab", "view")), "INVALID_MCP_REPLY")
        self._checkpoint(run, "navigating", "NAVIGATION_INTENT")
        self._check_cancel(run)
        value = await self._input(client, "pane_act", {"lease": current["lease"], "tab": current["tab"], "view": current["view"],
            "request": client.next_request(), "steps": [{"op": "navigate", "url": recipe["url"]}], "observe": "none"})
        self._check_cancel(run)
        if value.get("stopped") == "navigation" and value.get("completed") == 1:
            value = {key: item for key, item in value.items() if key != "stopped"}
        self._complete(value, 1)
        await self._admit(run)
        view = await self._view(client, current["tab"])
        evidence = {"baseline": self._artifacts.snapshot(), "downloads": [digest(row) for row in view.get("downloads", [])]}
        # This FULL-synchronous commit must finish before sending the export input.
        self._checkpoint(run, "exporting", "EXPORT_INTENT", evidence)
        self._check_cancel(run)
        value = await self._input(client, "pane_flow", {"lease": view["lease"], "tab": view["tab"], "view": view["view"],
            "request": client.next_request(), "observe": "none", "stages": [{"steps": [
                {"op": "fill", "target": {**recipe["periodTarget"], "exact": True}, "text": bindings["period"]},
                {"op": "click", "target": {**recipe["exportTarget"], "exact": True}}],
                "wait": {"text": recipe["readyText"], "timeoutMs": 5000}}]})
        self._complete(value, 2, 1)
        self._check_cancel(run)
        await self._verify(run, client, view["tab"])

    async def _verify(self, run, client, tab=None, reconcile=False):
        data = self._contract.data()
        row = self._journal.read(run, self._contract.fingerprint())
        if row["state"] != "verifying":
            self._checkpoint(run, "verifying", "VERIFYING_ARTIFACT")
        evidence = row["evidence"]
        deadline = self._clock() + 5
        for _ in range(101):
            if not reconcile:
                self._check_cancel(run)
            candidate = self._artifacts.candidate(evidence["baseline"], data["bindings"]["period"])
            if candidate is not None:
                break
            require(self._clock() < deadline, "DOWNLOAD_TIMEOUT")
            await self._sleep(0.05)
        require(candidate is not None, "DOWNLOAD_TIMEOUT")
        view = await self._view(client, tab)
        if not reconcile:
            self._check_cancel(run)
        verdict = self._artifacts.verify(data["bindings"], candidate, view.get("downloads", []), evidence["downloads"])
        # Recheck identity after the awaited browser observation before promoting the result.
        fresh = self._artifacts.candidate(evidence["baseline"], data["bindings"]["period"])
        require(fresh is not None and fresh["signature"] == candidate["signature"]
                and fresh["sha256"] == candidate["sha256"], "ARTIFACT_CHANGED")
        self._checkpoint(run, "verified", "BUSINESS_VERIFIED", {**evidence, "verifiedArtifact": verdict})
