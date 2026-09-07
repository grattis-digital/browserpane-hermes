"""Seed only the disposable gateway; workflow helpers have their own explicit config."""

import json
import os
from pathlib import Path
import stat
import uuid


def main():
    token = os.environ["BPANE_WORKFLOW_PILOT"]
    assert str(uuid.UUID(token)) == token
    root = Path("/opt/data")
    info = root.lstat()
    assert stat.S_ISDIR(info.st_mode) and stat.S_IMODE(info.st_mode) == 0o700 and info.st_uid == os.getuid()
    path = root / "config.yaml"
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "w") as file:
        json.dump({"plugins": {"enabled": []}, "mcp_servers": {},
                   "platform_toolsets": {"cli": ["workflow_execution"]}}, file)
        file.flush()
        os.fsync(file.fileno())


if __name__ == "__main__":
    main()
