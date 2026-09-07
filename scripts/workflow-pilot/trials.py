"""Independent CSV/input-count oracle and matched cold/warm trials."""

import csv
import hashlib
import io
import json
import time


class PilotTrials:
    def __init__(self, owner, agent, metrics):
        self.owner, self.agent, self.metrics = owner, agent, metrics
        self.source = (owner.code / "cdp.mjs").read_text() + "\n" + (owner.code / "probe.mjs").read_text()
        self.previous = set()

    def control(self, op=None, **args):
        address = f"http://127.0.0.1:9130/{self.owner.token}/control"
        request = ["curl", "--fail", "--silent", "--show-error", "--max-time", "5", "-H", "X-Pilot: " + self.owner.token]
        if op:
            request += ["-H", "Content-Type: application/json", "--data", json.dumps({"op": op, **args})]
        return json.loads(self.owner.execute("fixture", *request, address))

    def probe(self, mode="inspect"):
        return json.loads(self.owner.execute("browser", "node", "--input-type=module", "-", mode, input=self.source))

    def verify(self, period, rows, result):
        assert result.get("verified") is True, result
        evidence = self.probe()
        files = evidence["files"]
        added = set(files) - self.previous
        assert len(added) == 1
        name = added.pop()
        assert name.startswith("report-" + period) and name.endswith(".csv")
        body = files[name]
        reader = csv.DictReader(io.StringIO(body))
        assert reader.fieldnames == ["period", "code", "quantity"]
        actual = list(reader)
        expected = [{"period": period, "code": row["code"], "quantity": str(row["quantity"])} for row in rows]
        assert actual == expected and hashlib.sha256(body.encode()).hexdigest() == result["artifact"]["sha256"]
        assert evidence["tabs"] == 1 and evidence["state"]["clicks"] == 1 and evidence["state"]["trusted"] is True
        state = self.control()
        assert state["requests"] == 1 and state["period"] == period
        self.previous = set(files)
        return {"rows": len(actual), "clicks": 1, "requests": 1, "trusted": True, "artifactBytes": len(body.encode())}

    def trial(self, period, rows, mode="warm"):
        self.metrics.check()
        self.control("select", period=period, rows=rows)
        run = self.agent.prepare(period, rows, mode)
        before = self.metrics.sample()
        result = self.agent.execute(run, mode)
        after = self.metrics.sample()
        assert result.get("mcpCalls") == 5, result
        assert result.get("policyWaitMs") == 0 and "pacing" not in result, "Pacing must be off in hardware benchmarks"
        verdict = self.verify(period, rows, result)
        duplicate = self.agent.execute(run, mode)
        assert duplicate["verified"]
        assert self.control()["requests"] == 1 and set(self.probe()["files"]) == self.previous
        self.metrics.check()
        return {"mode": mode, "period": period, "runId": run, "verdict": verdict,
                **{key: result[key] for key in ("wallMs", "executionMs", "mcpMs", "mcpCalls", "responseJsonBytes", "polls")},
                "cpuMs": {role: (after["containers"][role]["cpuUsec"] - before["containers"][role]["cpuUsec"]) / 1000
                          for role in ("browser", "hermes")}}

    def cancellation(self, period, rows, reconcile=True):
        self.control("select", period=period, rows=rows)
        run = self.agent.prepare(period, rows)
        self.control("hold")
        try:
            result = self.agent.call({"op": "run", "run_id": run})
            assert result.get("active"), result
            deadline = time.monotonic() + 15
            while self.control()["requests"] == 0:
                assert time.monotonic() < deadline
                time.sleep(0.05)
            result = self.agent.call({"op": "cancel", "run_id": run})
            assert result["cancelRequested"] and result["active"] and not result["verified"], result
        finally:
            self.control("release")
        deadline = time.monotonic() + 10
        while True:
            result = self.agent.call({"op": "status", "run_id": run})
            if not result["active"]:
                break
            assert time.monotonic() < deadline
            time.sleep(0.05)
        assert result["state"] == "uncertain" and result["code"] == "CANCEL_REQUESTED", result
        assert self.agent.execute(run)["state"] == "uncertain"
        if not reconcile:
            return run, result
        result = self.agent.execute(run, op="reconcile")
        assert result["mcpCalls"] == 1  # Reconciliation has one view and no navigation/fill/click.
        return run, self.verify(period, rows, result)
