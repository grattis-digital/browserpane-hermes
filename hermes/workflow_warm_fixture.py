"""Test-only stdio driver for the actual service; no approval or production packaging."""

from contextlib import asynccontextmanager
import asyncio
import json
import logging
from pathlib import Path
import sys
import time
import uuid

from workflow_runner.catalog import ExecutionCatalog
from workflow_runner.control import WorkflowController
from workflow_runner.journal import RunJournal
from workflow_runner.mcp import CompactClient
from workflow_runner.private_files import PrivateFiles
from workflow_runner.service import WorkflowService


def main():
    root, endpoint, downloads = Path(sys.argv[1]).resolve(), sys.argv[2], sys.argv[3]
    assert root.name.startswith("bph-warm-fixture-") and root.is_dir()
    assert endpoint.startswith("http://127.0.0.1:") and endpoint.endswith("/mcp")
    logging.disable(logging.CRITICAL)  # This test subprocess only, never the Hermes plugin.
    metrics = {"opened": 0, "closed": 0, "sameTask": True}

    @asynccontextmanager
    async def connect(address):
        task = asyncio.current_task()
        async with CompactClient.connect(address) as client:
            metrics["opened"] += 1
            try:
                yield client
            finally:
                metrics["closed"] += 1
                metrics["sameTask"] = metrics["sameTask"] and asyncio.current_task() is task

    journal = RunJournal(PrivateFiles(root / "workflow-runs"), time.time, lambda: uuid.uuid4().hex)
    catalog = ExecutionCatalog(root / "workflow-catalog", journal, endpoint, downloads, time.time)
    service = WorkflowService(catalog, journal, connect)
    controller = WorkflowController(service, time.time)
    print(json.dumps({"ready": True}), flush=True)
    try:
        while True:
            line = sys.stdin.readline(65537)
            if not line:
                break
            assert len(line) <= 65536 and line.endswith("\n")
            args = json.loads(line)
            if args == {"fixture": "metrics"}:
                value = json.dumps(metrics)
            elif args == {"fixture": "close"}:
                service.close()
                print(json.dumps({"closed": True, "metrics": metrics}), flush=True)
                break
            else:
                value = controller.handle(args)
            print(value, flush=True)
    finally:
        service.close()


if __name__ == "__main__":
    main()
