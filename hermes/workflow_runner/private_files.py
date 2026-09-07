"""POSIX private storage and process-scoped advisory fencing for this local runner."""

from contextlib import contextmanager
import fcntl
import os
from pathlib import Path
import stat
import tempfile

from .contracts import WorkflowError, require


class PrivateFiles:
    def __init__(self, root):
        self.root = Path(root).absolute()

    def prepare(self, *, create=True):
        # The configured parent must already exist. Never mkdir/chmod an arbitrary tree.
        require(self.root.parent.is_dir() and self.root.parent.resolve() == self.root.parent, "UNSAFE_STORE")
        if create:
            self.root.mkdir(mode=0o700, exist_ok=True)
        info = self.root.lstat()
        require(stat.S_ISDIR(info.st_mode) and stat.S_IMODE(info.st_mode) == 0o700
                and info.st_uid == os.getuid(), "UNSAFE_STORE")

    def open(self, name, *, create=True):
        require(name in ("journal.sqlite3", "worker.lock"), "UNSAFE_STORE")
        self.prepare(create=create)
        access = os.O_CREAT | os.O_RDWR if create else os.O_RDONLY
        fd = os.open(self.root / name, access | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
        info = os.fstat(fd)
        if not (stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_uid == os.getuid()
                and stat.S_IMODE(info.st_mode) == 0o600):
            os.close(fd)
            raise WorkflowError("UNSAFE_STORE")
        return fd

    def database(self, *, initialize=False):
        """Validate without raw open/close on a live SQLite inode (POSIX lock safety)."""
        self.prepare(create=initialize)
        path = self.root / "journal.sqlite3"
        if initialize and not path.exists() and not path.is_symlink():
            # Close the new descriptor BEFORE publishing its inode. Never truncate,
            # chmod or replace an existing database, including concurrent creation.
            fd, temporary = tempfile.mkstemp(prefix=".journal-create-", dir=self.root)
            os.close(fd)
            try:
                try:
                    os.link(temporary, path, follow_symlinks=False)
                except FileExistsError:
                    pass
            finally:
                os.unlink(temporary)
            directory = os.open(self.root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
        info = path.lstat()
        require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_uid == os.getuid()
                and stat.S_IMODE(info.st_mode) == 0o600, "UNSAFE_STORE")
        return info.st_dev, info.st_ino

    @contextmanager
    def fence(self):
        fd = self.open("worker.lock")
        try:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as exc:
                raise WorkflowError("WORKER_BUSY") from exc
            yield
        finally:
            os.close(fd)  # Kernel releases on exit/crash; journal still blocks uncertain dispatch.
