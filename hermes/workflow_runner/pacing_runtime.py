"""Explicit composition; disabled contracts create no pacing files or timers."""

from .contracts import require
from .journal_db import JournalDatabase
from .pacing import WorkflowPacer
from .pacing_ledger import PacingLedger
from .pacing_policy import PacingPolicy
from .pacing_store import PacingStore
from .private_files import PrivateFiles


class PacingRuntime:
    @staticmethod
    def create(contract, journal, clock, sleep, wall_clock, random_source):
        data = contract.data()
        if "pacing" not in data:
            return None
        root = journal.storage_root().parent / "workflow-pacing"
        require(root != journal.storage_root(), "PACING_STORE_COLLISION")
        policy = PacingPolicy(data["pacing"], data["recipe"]["url"])
        files = PrivateFiles(root)
        store = PacingStore(files, JournalDatabase(files, schema=PacingLedger.SCHEMA))
        ledger = PacingLedger(store, wall_clock)
        return WorkflowPacer(policy, ledger, clock, sleep, random_source)
