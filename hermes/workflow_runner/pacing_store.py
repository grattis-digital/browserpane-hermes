"""Short bounded writer/publication lock; never held during browser work or pacing."""

from contextlib import contextmanager
import fcntl
import os
import time

from .contracts import WorkflowError


class PacingStore:
    def __init__(self, files, database):
        self._files, self._database = files, database

    @contextmanager
    def open(self, *, write=False, initialize=False):
        if not write:
            with self._database.open() as db:
                yield db
            return
        # Serialize first publication too: another creator must not inspect the
        # temporary two-link inode between link() and unlink(). Keep nlink=1 checks.
        fd = self._files.open("worker.lock")
        try:
            deadline = time.monotonic() + 1
            for attempt in range(102):
                try:
                    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except BlockingIOError as error:
                    if time.monotonic() >= deadline or attempt == 101:
                        raise WorkflowError("PACING_STORE_BUSY") from error
                    time.sleep(0.01)  # Bounded storage contention, not site pacing.
            with self._database.open(write=True, initialize=initialize) as db:
                yield db
        finally:
            os.close(fd)
