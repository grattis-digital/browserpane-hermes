"""Read only completed, bounded artifacts under one explicitly configured directory."""

import hashlib
import os
from pathlib import Path
import re
import stat

from .contracts import digest, require


class ReportArtifacts:
    def __init__(self, directory):
        self._root = Path(directory)

    def _directory(self):
        require(self._root.is_absolute() and self._root.resolve() == self._root, "UNSAFE_ARTIFACT_DIRECTORY")
        fd = os.open(self._root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        return fd

    @staticmethod
    def _signature(info):
        return [info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns]

    def snapshot(self):
        fd = self._directory()
        try:
            directory = os.fstat(fd)
            entries = {}
            # Stop enumeration at the cap; no unbounded os.listdir allocation.
            with os.scandir(fd) as iterator:
                for index, entry in enumerate(iterator):
                    require(index < 256, "ARTIFACT_DIRECTORY_CAPACITY")
                    if entry.name.startswith("."):
                        continue  # MCP private staging directories are never outputs.
                    info = entry.stat(follow_symlinks=False)
                    require(stat.S_ISREG(info.st_mode), "UNSAFE_ARTIFACT_ENTRY")
                    entries[digest(entry.name)] = self._signature(info)
            return {"directory": [directory.st_dev, directory.st_ino], "files": entries}
        finally:
            os.close(fd)

    def candidate(self, before, period):
        current = self.snapshot()
        require(current["directory"] == before["directory"], "ARTIFACT_DIRECTORY_CHANGED")
        require(all(current["files"].get(key) == value for key, value in before["files"].items()), "ARTIFACT_SET_CHANGED")
        added = set(current["files"]) - set(before["files"])
        require(len(added) <= 1, "AMBIGUOUS_ARTIFACT")
        if not added:
            return None
        key = next(iter(added))
        fd = self._directory()
        try:
            directory = os.fstat(fd)
            require([directory.st_dev, directory.st_ino] == before["directory"], "ARTIFACT_DIRECTORY_CHANGED")
            name = None
            with os.scandir(fd) as iterator:
                for index, entry in enumerate(iterator):
                    require(index < 256, "ARTIFACT_DIRECTORY_CAPACITY")
                    if digest(entry.name) == key:
                        name = entry.name
                        break
            require(name is not None and re.fullmatch(r"report-" + re.escape(period) + r"(?: \([1-9][0-9]{0,5}\))?\.csv", name), "WRONG_ARTIFACT_NAME")
            file = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
            try:
                info = os.fstat(file)
                require(stat.S_ISREG(info.st_mode) and 0 < info.st_size <= 32768, "ARTIFACT_SIZE")
                require(self._signature(info) == current["files"][key], "ARTIFACT_CHANGED")
                data = bytearray()
                while len(data) <= 32768:
                    chunk = os.read(file, min(4096, 32769 - len(data)))
                    if not chunk:
                        break
                    data.extend(chunk)
                require(len(data) == info.st_size and self._signature(os.fstat(file)) == current["files"][key], "ARTIFACT_CHANGED")
                return {"key": key, "signature": current["files"][key], "sha256": hashlib.sha256(data).hexdigest(),
                        "bytes": len(data), "text": data.decode("utf-8", errors="strict"), "name": name}
            finally:
                os.close(file)
        finally:
            os.close(fd)

    def verify(self, bindings, candidate, downloads, previous):
        # Match one NEW completion record from the current tab to the actual forwarded file.
        require(type(downloads) is list and len(downloads) <= 4, "DOWNLOAD_NOT_CORRELATED")
        added = [row for row in downloads if digest(row) not in previous]
        require(len(added) == 1 and added[0].get("status") == "complete", "DOWNLOAD_NOT_CORRELATED")
        require(added[0].get("file") == str(self._root / candidate["name"]), "DOWNLOAD_NOT_CORRELATED")
        lines = candidate["text"].replace("\r\n", "\n").split("\n")
        if lines[-1] == "":
            lines.pop()
        require(lines.pop(0) == "period,code,quantity", "WRONG_REPORT_SCHEMA")
        expected = {row["code"]: row["quantity"] for row in bindings["rows"]}
        require(len(lines) == len(expected), "WRONG_REPORT_ROWS")
        seen = set()
        for line in lines:
            fields = line.split(",")
            require(len(fields) == 3 and re.fullmatch(r"[0-9]{1,16}", fields[2]), "INVALID_REPORT_ROW")
            period, code, quantity = fields
            require(period == bindings["period"] and code in expected and code not in seen
                    and int(quantity) == expected[code], "WRONG_REPORT_CONTENT")
            seen.add(code)
        return {"sha256": candidate["sha256"], "bytes": candidate["bytes"], "rows": len(seen)}
