"""Read-only cgroup checkpoints. No docker stats subprocess in timed input loops."""
from pathlib import Path
import os
import re
import time


class RenderMetrics:
    def __init__(self, owner):
        self.owner, self.paths = owner, {}
        for role, identifier in owner.containers.items():
            info = owner.owned(role)
            group = Path(f"/proc/{info['State']['Pid']}/cgroup").read_text().strip().split("0::")[1]
            assert identifier in group
            self.paths[role] = Path("/sys/fs/cgroup") / group.lstrip("/")

    def sample(self):
        result = {"monotonic": time.monotonic(), "wallTimeMs": time.time() * 1000,
                  "host": self.owner.pressure(), "containers": {}}
        for role, path in self.paths.items():
            cpu = dict(line.split() for line in (path / "cpu.stat").read_text().splitlines())
            events = {k: int(v) for k, v in (line.split() for line in (path / "memory.events").read_text().splitlines())}
            assert events.get("oom_kill", 0) == 0, "Pilot OOM"
            result["containers"][role] = {"cpuUsec": int(cpu["usage_usec"]),
                "throttledUsec": int(cpu.get("throttled_usec", 0)), "events": events,
                "memoryBytes": int((path / "memory.current").read_text()),
                "processes": self.processes(path)}
        return result

    @staticmethod
    def processes(group):
        # Only already-verified disposable cgroups, no production cmdlines.
        pids = (group / "cgroup.procs").read_text().split()
        assert len(pids) <= 512
        rows = {}
        ticks = os.sysconf("SC_CLK_TCK")
        for pid in pids:
            try:
                stat = Path("/proc", pid, "stat").read_text()
                values = stat[stat.rfind(")") + 2:].split()
                args = Path("/proc", pid, "cmdline").read_bytes()
            except (FileNotFoundError, ProcessLookupError):
                continue  # Churn is explicitly counted by the interval consumer.
            name = stat[stat.index("(") + 1:stat.rfind(")")]
            role = RenderMetrics.process_role(args, name)
            rows[pid + ":" + values[19]] = {"role": role,
                "cpuUsec": (int(values[11]) + int(values[12])) * 1000000 / ticks}
        return rows

    @staticmethod
    def process_role(args, name):
        # Chromium may rewrite its process title into one space-separated argv.
        match = re.search(rb"(?:^|[\x00 ])--type=(gpu-process|renderer|utility|zygote)(?:[\x00 ]|$)", args)
        return "chromium-" + match[1].decode("ascii") if match else name
