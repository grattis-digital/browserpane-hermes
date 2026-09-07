"""Conservative cross-process admissions. A failed/cancelled action gets no refund."""

import math

from .contracts import require


class PacingLedger:
    SCHEMA = """CREATE TABLE budgets (site TEXT PRIMARY KEY, last_ms INTEGER NOT NULL,
        next_ms INTEGER NOT NULL, window_start_ms INTEGER NOT NULL, window_end_ms INTEGER NOT NULL,
        used INTEGER NOT NULL)"""

    def __init__(self, database, wall_clock):
        self._database, self._wall = database, wall_clock

    def _now(self):
        value = self._wall()
        require(type(value) in (int, float) and math.isfinite(value) and 0 <= value < 9007199254740,
                "PACING_CLOCK_INVALID")
        return math.floor(value * 1000)

    @staticmethod
    def _validate(row):
        require(all(type(row[key]) is int for key in ("last_ms", "next_ms", "window_start_ms", "window_end_ms", "used")),
                "PACING_STORE_INVALID")
        require(0 <= row["window_start_ms"] <= row["last_ms"]
                and row["window_start_ms"] < row["window_end_ms"] <= row["window_start_ms"] + 3600000
                and row["last_ms"] <= row["next_ms"] <= row["last_ms"] + 65000
                and 1 <= row["used"] <= 1000, "PACING_STORE_INVALID")

    def reserve(self, policy, jitter):
        values, key = policy.data(), policy.site_key()
        require(type(jitter) is int and 0 <= jitter <= values["jitterMs"], "INVALID_PACING_RANDOM")
        with self._database.open(write=True, initialize=True) as db:
            # Read the clock after acquiring the writer; queued writers must not
            # spend an old timestamp or release the transaction across an await.
            now = self._now()
            row = db.execute("SELECT * FROM budgets WHERE site=?", (key,)).fetchone()
            start, end, used, due = now, now + values["windowMs"], 0, now
            if row is not None:
                self._validate(row)
                require(now >= row["last_ms"], "PACING_CLOCK_ROLLBACK")
                start = row["window_start_ms"]
                end = max(row["window_end_ms"], start + values["windowMs"])
                used = row["used"]
                # Policy changes preserve usage and cannot shorten an existing
                # cooldown/window. Expired windows start at the next admission.
                if now >= end:
                    start, end, used = now, now + values["windowMs"], 0
                due = max(now, row["next_ms"], row["last_ms"] + values["minIntervalMs"])
                if used >= values["maxActions"]:
                    due = max(due, end)
            else:
                require(db.execute("SELECT count(*) FROM budgets").fetchone()[0] < 128, "PACING_CAPACITY")
            if due > now:
                return due - now  # No future slot reservation or automatic retry.
            db.execute("INSERT OR REPLACE INTO budgets VALUES (?,?,?,?,?,?)",
                       (key, now, now + values["minIntervalMs"] + jitter, start, end, used + 1))
            return 0

    def complete(self, policy, jitter):
        values, key = policy.data(), policy.site_key()
        require(type(jitter) is int and 0 <= jitter <= values["jitterMs"], "INVALID_PACING_RANDOM")
        with self._database.open(write=True) as db:
            now = self._now()
            row = db.execute("SELECT * FROM budgets WHERE site=?", (key,)).fetchone()
            require(row is not None, "PACING_STORE_INVALID")
            self._validate(row)
            require(now >= row["last_ms"], "PACING_CLOCK_ROLLBACK")
            # A slow preflight/input must not consume the gap before the next
            # business action. Never release a later concurrent reservation early.
            due = max(row["next_ms"], now + values["minIntervalMs"] + jitter)
            db.execute("UPDATE budgets SET last_ms=?,next_ms=? WHERE site=?", (now, due, key))
