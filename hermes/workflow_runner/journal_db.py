"""Short read-only snapshots; serialized FULL-synchronous writes, never browser retries."""

from contextlib import contextmanager
import sqlite3
import threading

from .contracts import WorkflowError, require


class JournalDatabase:
    SCHEMA = "CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, binding TEXT NOT NULL, expires REAL NOT NULL, state TEXT NOT NULL, evidence TEXT NOT NULL, code TEXT NOT NULL)"

    def __init__(self, files, *, schema=None):
        self._files = files
        self._schema = self.SCHEMA if schema is None else schema
        self._lock = threading.RLock()

    @staticmethod
    def error_code(error):
        extended = getattr(error, "sqlite_errorcode", 0)
        # Older host Pythons lack extended codes; pinned runtime supplies them.
        if not extended and str(error) in ("database is locked", "database table is locked"):
            return "JOURNAL_BUSY"
        if extended == 776:  # SQLITE_READONLY_ROLLBACK: read-only access cannot recover a hot journal.
            return "JOURNAL_RECOVERY_REQUIRED"
        return {5: "JOURNAL_BUSY", 6: "JOURNAL_BUSY", 8: "JOURNAL_READ_ONLY",
                10: "JOURNAL_IO_ERROR", 11: "JOURNAL_CORRUPT", 13: "JOURNAL_FULL",
                14: "JOURNAL_UNAVAILABLE", 26: "JOURNAL_CORRUPT"}.get(extended & 255, "JOURNAL_ERROR")

    @contextmanager
    def open(self, *, write=False, initialize=False):
        require(not initialize or write, "INVALID_JOURNAL_ACCESS")
        # Only short database lifetimes, never network/browser work. SQLite still
        # arbitrates independent processes; status sees committed evidence only.
        require(self._lock.acquire(timeout=1.0), "JOURNAL_BUSY")
        try:
            with self._connection(write=write, initialize=initialize) as db:
                yield db
        finally:
            self._lock.release()

    @contextmanager
    def _connection(self, *, write, initialize):
        db = None
        try:
            # Reads must neither create private directories/files nor recover a hot
            # rollback journal behind the operator's back. No immutable=1 shortcut.
            identity = self._files.database(initialize=initialize)
            path = (self._files.root / "journal.sqlite3").as_uri()
            db = sqlite3.connect(path + ("?mode=rw" if write else "?mode=ro"), uri=True,
                                 timeout=1.0, isolation_level=None)
            db.row_factory = sqlite3.Row
            require(self._files.database() == identity, "UNSAFE_STORE")
            if write:
                db.execute("PRAGMA synchronous=FULL")
                db.execute("BEGIN IMMEDIATE")
                db.execute("PRAGMA secure_delete=ON")
                db.execute("PRAGMA max_page_count=4096")
            version = db.execute("PRAGMA user_version").fetchone()[0]
            require(version == 1 or (initialize and version == 0), "JOURNAL_VERSION")
            if version == 0:
                db.execute(self._schema)
                db.execute("PRAGMA user_version=1")
            try:
                yield db
                if write:
                    db.commit()
            except BaseException:
                # Preserve the primary failure even if the disk also rejects rollback.
                try:
                    db.rollback()
                except sqlite3.Error:
                    pass
                raise
        except sqlite3.Error as error:
            raise WorkflowError(self.error_code(error)) from error
        except FileNotFoundError as error:
            raise WorkflowError("JOURNAL_NOT_FOUND") from error
        except OSError as error:
            raise WorkflowError("JOURNAL_IO_ERROR") from error
        finally:
            if db is not None:
                db.close()
