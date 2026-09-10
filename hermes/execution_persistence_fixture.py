"""Test-only payload, invoked only after check-container validates container ownership."""

from pathlib import Path
import sys
import time

sys.path.insert(0, "/opt/hermes-bundle")
from workflow_runner.catalog import ExecutionCatalog
from workflow_runner.contracts import ReportContract
from workflow_runner.journal import RunJournal
from workflow_runner.private_files import PrivateFiles
from workflow_runner.service import WorkflowService


def main():
    root = Path("/opt/data/execution-persistence-fixture")
    run = "d" * 32
    if sys.argv[1] == "setup":
        root.mkdir(mode=0o700)
        (root / "downloads").mkdir(mode=0o700)
    recipe = {"schema": 1, "id": "persistence-fixture", "version": 1, "url": "https://fixture.invalid/report",
              "marker": {"role": "heading", "name": "Synthetic account"}, "periodTarget": {"role": "textbox", "name": "Period"},
              "exportTarget": {"role": "link", "name": "Export"}, "readyText": "Done", "verifier": "report-csv-v1"}
    contract = ReportContract(recipe, {"period": "2026-06", "rows": [{"code": "ITEM-0001", "quantity": 6}]},
                              "http://browserpane:8931/mcp", str(root / "downloads"), pacing=None)
    journal = RunJournal(PrivateFiles(root / "journal"), time.time, lambda: run)
    catalog = ExecutionCatalog(root / "catalog", journal, contract.data()["endpoint"], root / "downloads", time.time)
    binding = contract.fingerprint()
    if sys.argv[1] == "setup":
        journal.approve(binding, binding)
        catalog.register(run, contract)
        assert journal.begin(run, binding)
        journal.checkpoint(run, binding, "prepared", "navigating", "NAVIGATION_INTENT")
        journal.checkpoint(run, binding, "navigating", "exporting", "EXPORT_INTENT")
        journal.cancel(run, binding)
    else:
        assert sys.argv[1] == "check"
        assert catalog.load(run).fingerprint() == binding
        def forbidden(_endpoint):
            raise AssertionError("A duplicate must not open a connection")
        service = WorkflowService(catalog, journal, forbidden)
        try:
            state = service.execute(run)
            assert state["state"] == "exporting" and state["cancelRequested"] and not state["verified"]
        finally:
            service.close()


if __name__ == "__main__":
    main()
