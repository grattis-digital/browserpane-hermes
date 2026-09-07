"""Bounded read-only cgroup-v2 and host sampling; no Docker socket in the agent."""

from pathlib import Path
import threading
import time


class PilotMetrics:
    def __init__(self, owner):
        self._paths = {}
        for role in ("browser", "hermes", "display", "fixture"):
            identifier = owner.containers[role]
            info = owner.owned("container", identifier)
            group = Path(f"/proc/{info['State']['Pid']}/cgroup").read_text().strip().split("0::")[1]
            assert identifier in group
            self._paths[role] = Path("/sys/fs/cgroup") / group.lstrip("/")
        self.rows, self.error, self._stop = [], None, threading.Event()
        self._thread = threading.Thread(target=self._run, daemon=True)

    @staticmethod
    def host():
        memory = dict(line.split(":", 1) for line in Path("/proc/meminfo").read_text().splitlines())
        return {"availableMiB": int(memory["MemAvailable"].split()[0]) / 1024,
                "temperatureC": int(Path("/sys/class/thermal/thermal_zone0/temp").read_text()) / 1000,
                "frequencyKHz": int(Path("/sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq").read_text()),
                "load1": float(Path("/proc/loadavg").read_text().split()[0])}

    def sample(self):
        row = {"monotonic": time.monotonic(), "host": self.host(), "containers": {}}
        for role, path in self._paths.items():
            cpu = {key: int(value) for key, value in (line.split() for line in (path / "cpu.stat").read_text().splitlines())}
            events = {key: int(value) for key, value in (line.split() for line in (path / "memory.events").read_text().splitlines())}
            row["containers"][role] = {"cpuUsec": cpu["usage_usec"], "throttledUsec": cpu.get("throttled_usec", 0),
                "memoryBytes": int((path / "memory.current").read_text()), "events": events}
        return row

    def _run(self):
        try:
            while not self._stop.wait(1):
                assert len(self.rows) < 2400, "Pilot duration limit"
                row = self.sample()
                self.rows.append(row)
                assert row["host"]["availableMiB"] >= 768 and row["host"]["temperatureC"] < 78, "Host pressure safety stop"
                assert all(c["events"].get("oom_kill", 0) == 0 for c in row["containers"].values()), "Pilot OOM"
        except Exception as error:
            self.error = str(error)

    def start(self):
        self.rows.append(self.sample())
        self._thread.start()

    def check(self):
        assert self.error is None, self.error

    def stop(self):
        self._stop.set()
        self._thread.join(3)
        self.check()
        self.rows.append(self.sample())
        first, last = self.rows[0], self.rows[-1]
        seconds = last["monotonic"] - first["monotonic"]
        return {"samples": len(self.rows), "seconds": seconds,
            "minimumAvailableMiB": min(row["host"]["availableMiB"] for row in self.rows),
            "maximumTemperatureC": max(row["host"]["temperatureC"] for row in self.rows),
            "containers": {role: {"sampledPeakMiB": max(row["containers"][role]["memoryBytes"] for row in self.rows) / 1048576,
                "meanCpuCores": (last["containers"][role]["cpuUsec"] - first["containers"][role]["cpuUsec"]) / 1e6 / seconds,
                "throttledUsec": last["containers"][role]["throttledUsec"] - first["containers"][role]["throttledUsec"],
                "oomKills": last["containers"][role]["events"].get("oom_kill", 0)} for role in self._paths}}
