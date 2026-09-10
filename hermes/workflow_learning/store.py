"""Bounded private learning evidence, not an execution/approval journal."""

from contextlib import contextmanager
import hashlib
import hmac
import json
import os
from pathlib import Path
import sqlite3
import stat
import uuid

from .contracts import CaptureError, identity


class CaptureStore:
    MAX_RUNS = 32
    MAX_EVENTS = 128

    def __init__(self, home, clock):
        self._home = Path(home).resolve()
        self._root = self._home / "plugin-data" / "browserpane-workflows"
        self._path = self._root / "captures.sqlite3"
        self._clock = clock

    @contextmanager
    def _database(self, create=False):
        if not create and not self._path.exists():
            yield None
            return
        for path in (self._home / "plugin-data", self._root):
            if path.is_symlink():
                raise CaptureError("UNSAFE_STORAGE")
            path.mkdir(mode=0o700, exist_ok=True)
        if stat.S_IMODE(self._root.stat().st_mode) != 0o700:
            raise CaptureError("UNSAFE_STORAGE")
        fd = os.open(self._path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or stat.S_IMODE(info.st_mode) != 0o600:
                raise CaptureError("UNSAFE_STORAGE")
        finally:
            os.close(fd)
        db = sqlite3.connect(self._path, timeout=0.25)
        db.row_factory = sqlite3.Row
        try:
            db.execute("PRAGMA max_page_count=4096")
            db.execute("PRAGMA synchronous=FULL")
            db.execute("PRAGMA secure_delete=ON")
            db.execute("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value BLOB NOT NULL)")
            db.execute("INSERT OR IGNORE INTO meta VALUES ('key', ?)", (os.urandom(32),))
            db.execute("CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, owner TEXT NOT NULL, started REAL NOT NULL, expires REAL NOT NULL, state TEXT NOT NULL)")
            db.execute("CREATE TABLE IF NOT EXISTS events (run TEXT NOT NULL, id TEXT NOT NULL, sequence INTEGER NOT NULL, payload TEXT NOT NULL, UNIQUE(run,id))")
            db.execute("UPDATE runs SET state='expired' WHERE state='recording' AND expires<=?", (self._clock(),))
            yield db
            db.commit()
        except BaseException:
            db.rollback()
            raise
        finally:
            db.close()

    @staticmethod
    def _key(db, value):
        secret = db.execute("SELECT value FROM meta WHERE key='key'").fetchone()[0]
        return hmac.new(secret, value.encode(), hashlib.sha256).hexdigest()

    def _owner(self, db, session, task):
        return self._key(db, json.dumps([identity(session), identity(task)]))

    @staticmethod
    def _find(db, owner, run_id=None):
        if run_id:
            row = db.execute("SELECT * FROM runs WHERE owner=? AND id=?", (owner, run_id)).fetchone()
        else:
            row = db.execute("SELECT * FROM runs WHERE owner=? ORDER BY started DESC,rowid DESC LIMIT 1", (owner,)).fetchone()
        return dict(row) if row else None

    def start(self, session, task, minutes):
        identity(session), identity(task)
        with self._database(create=True) as db:
            owner = self._owner(db, session, task)
            active = db.execute("SELECT id FROM runs WHERE owner=? AND state='recording'", (owner,)).fetchone()
            if active:
                raise CaptureError("ALREADY_RECORDING")
            if db.execute("SELECT count(*) FROM runs").fetchone()[0] >= self.MAX_RUNS:
                raise CaptureError("CAPACITY_REACHED")
            run_id, now = uuid.uuid4().hex, self._clock()
            db.execute("INSERT INTO runs VALUES (?,?,?,?,?)", (run_id, owner, now, now + minutes * 60, "recording"))
            return run_id

    def append(self, session, task, event_id, event):
        identity(session), identity(task), identity(event_id)
        encoded = json.dumps(event, separators=(",", ":"), allow_nan=False)
        if len(encoded) > 4096:
            raise CaptureError("EVENT_TOO_LARGE")
        with self._database() as db:
            if db is None:
                return
            run = self._find(db, self._owner(db, session, task))
            if not run or run["state"] != "recording":
                return
            count = db.execute("SELECT count(*) FROM events WHERE run=?", (run["id"],)).fetchone()[0]
            key = self._key(db, event_id)
            if db.execute("SELECT 1 FROM events WHERE run=? AND id=?", (run["id"], key)).fetchone():
                return
            if count >= self.MAX_EVENTS:
                db.execute("UPDATE runs SET state='capacity' WHERE id=?", (run["id"],))
                return
            db.execute("INSERT INTO events VALUES (?,?,?,?)", (run["id"], key, count, encoded))

    def read(self, session, task, run_id=None, finish=False):
        identity(session), identity(task)
        with self._database() as db:
            if db is None:
                raise CaptureError("NOT_FOUND")
            run = self._find(db, self._owner(db, session, task), run_id)
            if not run:
                raise CaptureError("NOT_FOUND")
            if finish and run["state"] == "recording":
                db.execute("UPDATE runs SET state='finished' WHERE id=?", (run["id"],))
                run["state"] = "finished"
            rows = db.execute("SELECT payload FROM events WHERE run=? ORDER BY sequence", (run["id"],)).fetchall()
            return {"run_id": run["id"], "state": run["state"], "expires_at": run["expires"],
                    "events": [json.loads(row[0]) for row in rows]}

    def forget(self, session, task, run_id):
        identity(session), identity(task)
        with self._database() as db:
            run = self._find(db, self._owner(db, session, task), run_id) if db else None
            if not run:
                raise CaptureError("NOT_FOUND")
            if run["state"] == "recording":
                raise CaptureError("FINISH_FIRST")
            db.execute("DELETE FROM events WHERE run=?", (run_id,))
            db.execute("DELETE FROM runs WHERE id=?", (run_id,))
