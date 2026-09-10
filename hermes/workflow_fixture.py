"""Synthetic-only test collaborators, never packaged into the application."""

from contextlib import asynccontextmanager
from pathlib import Path
import uuid

from workflow_runner.artifacts import ReportArtifacts
from workflow_runner.contracts import ReportContract
from workflow_runner.journal import RunJournal
from workflow_runner.private_files import PrivateFiles
from workflow_runner.runner import ReportRunner


class WorkflowFixture:
    def __init__(self, root):
        self.root = Path(root).resolve()
        self.downloads = self.root / "downloads"
        self.downloads.mkdir()
        self.recipe = {"schema": 1, "id": "report-export", "version": 1, "url": "https://fixture.invalid/report",
                       "marker": {"role": "heading", "name": "Synthetic account"},
                       "periodTarget": {"role": "textbox", "name": "Reporting period"},
                       "exportTarget": {"role": "link", "name": "Export report"},
                       "readyText": "Report exported", "verifier": "report-csv-v1"}
        self.bindings = {"period": "2026-06", "rows": [{"code": "ITEM-0001", "quantity": 6}]}
        self.contract = ReportContract(self.recipe, self.bindings, "http://127.0.0.1:8931/mcp", str(self.downloads), pacing=None)
        self.now, self.calls, self.records = 1000.0, [], []
        self._request, self.healthy = 0, True
        self.url, self.fault, self.after_export = "about:blank", None, lambda: None
        self.journal = RunJournal(PrivateFiles(self.root / "journal"), lambda: self.now, lambda: uuid.uuid4().hex)
        self.artifacts = ReportArtifacts(self.downloads)

    @asynccontextmanager
    async def connect(self, _endpoint):
        yield self

    async def sleep(self, seconds):
        self.now += seconds

    def runner(self):
        return ReportRunner(self.contract, self.journal, self.artifacts, self.connect, lambda: self.now, self.sleep)

    def approve(self):
        return self.journal.approve(self.contract.fingerprint(), self.contract.fingerprint())

    def row(self, run):
        return self.journal.read(run, self.contract.fingerprint())

    def metrics(self):
        return {"mcpCalls": len(self.calls), "responseJsonBytes": 0, "mcpMs": 0}

    def next_request(self):
        self._request += 1
        return self._request

    async def call(self, name, args):
        self.calls.append((name, args))
        if name == "pane_view":
            return {"v": 1, "lease": "lease", "tab": "tab", "view": "view", "url": self.url,
                    "matches": 0 if self.fault == "marker" else 1, "downloads": list(self.records)}
        if name == "pane_act":
            self.url = self.recipe["url"]
            return {"v": 1, "completed": 1, "stopped": "navigation"}
        assert name == "pane_flow" and args["view"] == "view"
        if self.fault != "missing":
            period = "1999-12" if self.fault == "wrong" else self.bindings["period"]
            output = self.downloads / f"report-{self.bindings['period']}.csv"
            index = 1
            while output.exists():
                output = self.downloads / f"report-{self.bindings['period']} ({index}).csv"
                index += 1
            output.write_text(f"period,code,quantity\n{period},ITEM-0001,6\n", encoding="utf-8")
            self.records.append({"file": str(output), "status": "complete"})
        self.after_export()
        if self.fault == "lost":
            raise ConnectionError("RAW-PROVIDER-SECRET")
        if self.fault == "partial":
            return {"v": 1, "completed": 1, "stages": 0, "stopped": "dialog", "pendingStep": 1}
        return {"v": 1, "completed": 2, "stages": 1}
