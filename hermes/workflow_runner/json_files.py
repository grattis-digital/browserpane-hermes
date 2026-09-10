"""Bounded JSON files, no symlink/FIFO reads or ambiguous duplicate keys."""

import json
import os
import stat

from .contracts import require


def read_json(path, private=False):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as file:
        info = os.fstat(file.fileno())
        require(stat.S_ISREG(info.st_mode) and info.st_size <= 65536, "CONTRACT_SIZE")
        if private:
            require(info.st_uid == os.getuid() and info.st_nlink == 1
                    and stat.S_IMODE(info.st_mode) == 0o600, "UNSAFE_CATALOG")
        data = file.read(65537)
    require(len(data) <= 65536, "CONTRACT_SIZE")
    def pairs(items):
        value = {}
        for key, item in items:
            require(key not in value, "DUPLICATE_FIELD")
            value[key] = item
        return value
    return json.loads(data, object_pairs_hook=pairs)
