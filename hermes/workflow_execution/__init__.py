"""Independent opt-in executor; registration creates no files, threads or connections."""

from pathlib import Path
import sys
import time
import uuid


def register(ctx):
    from hermes_constants import get_hermes_home
    from hermes_cli.config import load_config_readonly
    # Bundle code is outside the upstream Hermes package; no SDK/lifecycle monkeypatches.
    bundle = "/opt/hermes-bundle"
    if bundle not in sys.path:
        sys.path.insert(0, bundle)
    from workflow_runner.catalog import ExecutionCatalog
    from workflow_runner.control import SCHEMA, WorkflowController
    from workflow_runner.contracts import require, url
    from workflow_runner.journal import RunJournal
    from workflow_runner.mcp import CompactClient
    from workflow_runner.private_files import PrivateFiles
    from workflow_runner.service import WorkflowService

    config = load_config_readonly() or {}
    server = config.get("mcp_servers", {}).get("browserpane", {})
    endpoint = url(server.get("url"))
    require(endpoint.endswith("/mcp") and not server.get("headers") and not server.get("auth"), "UNSUPPORTED_WORKFLOW_TRANSPORT")
    downloads = ctx.get_config("downloads", "/shared/downloads")
    require(isinstance(downloads, str) and Path(downloads).is_absolute(), "INVALID_DOWNLOADS")
    home = get_hermes_home()
    journal = RunJournal(PrivateFiles(home / "workflow-runs"), time.time, lambda: uuid.uuid4().hex)
    catalog = ExecutionCatalog(home / "workflow-catalog", journal, endpoint, downloads, time.time)
    service = WorkflowService(catalog, journal, CompactClient.connect, wait_seconds=ctx.get_config("wait_seconds", 5))
    controller = WorkflowController(service, time.time)
    ctx.on_unload(service.close)
    ctx.register_tool(name="workflow", toolset="workflow_execution", schema=SCHEMA,
                      handler=controller.handle, description="Supervised reviewed BrowserPane workflows")
