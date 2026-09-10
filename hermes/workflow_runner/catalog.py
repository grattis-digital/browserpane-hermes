"""Operator-published, immutable private execution bundles. Never an approval API."""

import os
from itertools import islice
import re
import uuid

from .contracts import ReportContract, canonical, closed, require
from .json_files import read_json
from .private_files import PrivateFiles


class ExecutionCatalog:
    def __init__(self, root, journal, endpoint, downloads, clock):
        self._files, self._journal = PrivateFiles(root), journal
        self._endpoint, self._downloads, self._clock = endpoint, str(downloads), clock

    @staticmethod
    def _id(run):
        require(isinstance(run, str) and re.fullmatch(r"[0-9a-f]{32}", run), "INVALID_RUN_ID")
        return run + ".json"

    def ids(self):
        if not self._files.root.exists():
            require(not self._files.root.is_symlink(), "UNSAFE_CATALOG")
            return []
        self._files.prepare()
        with os.scandir(self._files.root) as directory:
            entries = list(islice(directory, 35))
        require(len(entries) <= 34, "CATALOG_CAPACITY")
        require(all(re.fullmatch(r"[0-9a-f]{32}\.json", p.name) or p.name == "worker.lock"
                    or re.fullmatch(r"\.publish-[0-9a-f]{32}", p.name) for p in entries), "UNSAFE_CATALOG")
        ids = sorted(p.name[:-5] for p in entries if p.name.endswith(".json"))
        require(len(ids) <= 32, "CATALOG_CAPACITY")
        return ids

    def load(self, run):
        name = self._id(run)
        require(run in self.ids(), "EXECUTION_NOT_REGISTERED")
        value = read_json(self._files.root / name, private=True)
        closed(value, ("schema", "runId", "digest", "contract"))
        require(type(value["schema"]) is int and value["schema"] == 1 and value["runId"] == run)
        data = value["contract"]
        closed(data, ("runnerContract", "recipe", "bindings", "endpoint", "downloads")
               + (("pacing",) if isinstance(data, dict) and "pacing" in data else ()))
        require(type(data["runnerContract"]) is int and data["runnerContract"] == 1)
        require("pacing" not in data or type(data["pacing"]) is dict, "INVALID_PACING_POLICY")
        contract = ReportContract(data["recipe"], data["bindings"], data["endpoint"], data["downloads"], pacing=data.get("pacing"))
        require(contract.fingerprint() == value["digest"], "BINDING_MISMATCH")
        require(data["endpoint"] == self._endpoint and data["downloads"] == self._downloads, "CONFIGURATION_MISMATCH")
        self._journal.read(run, contract.fingerprint())
        return contract

    def register(self, run, contract):
        name, data = self._id(run), contract.data()
        require(data["endpoint"] == self._endpoint and data["downloads"] == self._downloads, "CONFIGURATION_MISMATCH")
        with self._files.fence():
            if run in self.ids():
                require(self.load(run).fingerprint() == contract.fingerprint(), "BINDING_MISMATCH")
                return
            row = self._journal.read(run, contract.fingerprint())
            require(row["state"] == "approved" and row["expires"] > self._clock(), "LIVE_REVIEW_REQUIRED")
            require(len(self.ids()) < 32, "CATALOG_CAPACITY")
            content = canonical({"schema": 1, "runId": run, "digest": contract.fingerprint(), "contract": data}).encode()
            require(len(content) <= 65536, "CONTRACT_SIZE")
            temporary = self._files.root / (".publish-" + uuid.uuid4().hex)
            fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            try:
                with os.fdopen(fd, "wb") as file:
                    file.write(content)
                    file.flush()
                    os.fsync(file.fileno())
                os.link(temporary, self._files.root / name, follow_symlinks=False)
            finally:
                temporary.unlink()
            directory = os.open(self._files.root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
