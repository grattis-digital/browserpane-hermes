"""Explicit operator entrypoint; not an automatically registered Hermes/MCP tool."""

import argparse
import asyncio
import json
import logging
import random
import sys
import time
import uuid

from .artifacts import ReportArtifacts
from .catalog import ExecutionCatalog
from .contracts import ReportContract, WorkflowError, require
from .journal import RunJournal
from .json_files import read_json
from .mcp import CompactClient
from .private_files import PrivateFiles
from .pacing_runtime import PacingRuntime
from .runner import ReportRunner


async def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("op", choices=("review", "approve", "register", "run", "status", "cancel", "reconcile", "abandon"))
    parser.add_argument("--recipe", required=True)
    parser.add_argument("--bindings", required=True)
    parser.add_argument("--endpoint", required=True)
    parser.add_argument("--downloads", required=True)
    parser.add_argument("--store", required=True)
    parser.add_argument("--digest")
    parser.add_argument("--run-id")
    parser.add_argument("--catalog")
    parser.add_argument("--pacing", default="off", help="off (default), or an explicitly reviewed pacing JSON file")
    args = parser.parse_args()
    require((args.op == "register") == (args.catalog is not None), "INVALID_COMMAND")
    # SDK transport errors can contain endpoint URLs. Public CLI returns codes only.
    logging.disable(logging.CRITICAL)
    pacing = None if args.pacing == "off" else read_json(args.pacing)
    require(args.pacing == "off" or type(pacing) is dict, "INVALID_PACING_POLICY")
    contract = ReportContract(read_json(args.recipe), read_json(args.bindings), args.endpoint, args.downloads, pacing=pacing)
    if args.op == "review":
        require(args.digest is None and args.run_id is None, "INVALID_COMMAND")
        return contract.review()
    journal = RunJournal(PrivateFiles(args.store), time.time, lambda: uuid.uuid4().hex)
    binding = contract.fingerprint()
    if args.op == "approve":
        require(args.run_id is None, "INVALID_COMMAND")
        run = journal.approve(binding, args.digest)
        return ReportRunner.status(journal.read(run, binding))
    require(args.run_id is not None, "RUN_ID_REQUIRED")
    if args.op == "abandon":
        journal.abandon(args.run_id, binding, args.digest)
    else:
        require(args.digest is None, "INVALID_COMMAND")
    if args.op == "register":
        ExecutionCatalog(args.catalog, journal, args.endpoint, args.downloads, time.time).register(args.run_id, contract)
    if args.op == "cancel":
        journal.cancel(args.run_id, binding)
    if args.op in ("status", "abandon", "register", "cancel"):
        return ReportRunner.status(journal.read(args.run_id, binding))
    pacer = PacingRuntime.create(contract, journal, time.monotonic, asyncio.sleep, time.time, random.random)
    runner = ReportRunner(contract, journal, ReportArtifacts(args.downloads), CompactClient.connect,
                          time.monotonic, asyncio.sleep, pacing=pacer)
    result = await runner.execute(args.run_id, reconcile=args.op == "reconcile")
    return result


if __name__ == "__main__":
    try:
        report = asyncio.run(main())
        print(json.dumps(report, separators=(",", ":"), allow_nan=False))
        sys.exit(2 if sys.argv[1] in ("run", "reconcile") and not report["verified"] else 0)
    except (Exception, KeyboardInterrupt) as error:
        print(json.dumps({"error": error.code if isinstance(error, WorkflowError) else "RUNNER_ERROR",
                          "next": "Inspect status; never repeat an uncertain action with a new approval."}))
        sys.exit(1)
