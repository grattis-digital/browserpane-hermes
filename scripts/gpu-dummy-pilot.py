#!/usr/bin/env python3
"""Explicitly authorized, finite Pi display qualification; no live browser access."""
import argparse
import json
import math
import os
from pathlib import Path
import signal
import stat
import statistics
import subprocess
import time
import uuid
from gpu_compare_results import summary as comparison_summary


def damage_summary(result):
    """Validate complete metadata evidence, not a throughput or capture claim."""
    assert (result["width"], result["height"]) == (1280, 720)
    assert result["swapInterval"] == 0
    assert result["submitted"] == [32, 96, 24, 24]
    assert "V3D" in result["renderer"] and "llvmpipe" not in result["renderer"]
    assert len(result["samples"]) == 6
    areas = {"swap": [], "swapWithDamage": []}
    for index, sample in enumerate(result["samples"]):
        mode = "swap" if index < 3 else "swapWithDamage"
        assert sample["mode"] == mode and sample["pixelErrors"] == 0
        assert type(sample["rectangles"]) is int and 0 < sample["rectangles"] <= 4096
        bounds = sample["observedBounds"]
        assert len(bounds) == 4 and all(type(value) is int for value in bounds)
        x, y, width, height = bounds
        assert 0 <= x <= 32 and 0 <= y <= 96 and width > 0 and height > 0
        assert 56 <= x + width <= 1280 and 120 <= y + height <= 720
        areas[mode].append(width * height)
    return {"boundingPixels": areas, "submittedPixels": 576,
            "selectivityObserved": all(area == 576 for area in areas["swapWithDamage"]),
            "scope": "Native EGL surface damage to root XDamage; not Chromium or latency qualification"}


def benchmark_summary(result):
    """Reject partial/non-finite results; never turn a timed-out probe into success."""
    assert (result["width"], result["height"], result["warmup"], result["swapInterval"]) == (1280, 720, 10, 0)
    assert result["pixelErrors"] == 0 and len(result["samples"]) == 60
    for sample in result["samples"]:
        assert type(sample["reads"]) is int and sample["reads"] >= 1
        for key in ("drawMs", "swapCaptureMs", "readMs"):
            assert type(sample[key]) in (int, float) and math.isfinite(sample[key]) and sample[key] >= 0
        assert sample["readMs"] <= sample["swapCaptureMs"] + 0.001
    summary = {}
    for key in ("drawMs", "swapCaptureMs", "readMs", "totalMs"):
        values = sorted(sample["drawMs"] + sample["swapCaptureMs"] if key == "totalMs" else sample[key]
                        for sample in result["samples"])
        summary[key] = {"median": statistics.median(values), "p95": values[math.ceil(len(values) * 0.95) - 1]}
    summary["reads"] = sum(sample["reads"] for sample in result["samples"])
    return summary


def lease_summary(result):
    """A real GPU handoff/component gate, not viewer latency or scroll reuse."""
    assert (result["width"], result["height"], result["metadataBytes"], result["pixelErrors"]) == (1280, 720, 64, 0)
    assert result["scrollFrames"] == 12
    for key in ("negativeRequests", "backpressure", "immutableLease", "resize", "disconnect", "scrollConsistency"):
        assert result[key] == "passed"
    assert len(result["samples"]) == 16
    for sample in result["samples"]:
        assert type(sample["gpuCopyPixels"]) is int and sample["gpuCopyPixels"] == 4096
        for key in ("acquireMs", "importMs", "dispatchMs", "metadataWaitMs", "compareMs"):
            assert type(sample[key]) in (int, float) and math.isfinite(sample[key]) and sample[key] >= 0
        assert abs(sample["dispatchMs"] + sample["metadataWaitMs"] - sample["compareMs"]) <= 0.00001
    return {key: {"median": statistics.median(sample[key] for sample in result["samples"]),
                  "p95": sorted(sample[key] for sample in result["samples"])[15]}
            for key in ("acquireMs", "importMs", "dispatchMs", "metadataWaitMs", "compareMs")}


class DisplayPilot:
    LABEL = "io.browserpane.gpu-dummy-pilot"

    def __init__(self, image, render, group, output, backend="glamor", benchmark=False, damage=False, lease=False, comparison=False):
        assert backend == "glamor", "Only the custom GPU display is supported"
        assert sum((benchmark, damage, lease, comparison)) <= 1, "Select a single finite workload"
        assert not (lease or comparison) or backend == "glamor"
        self.backend, self.benchmark, self.damage = backend, benchmark, damage
        self.lease, self.comparison = lease or comparison, comparison
        self.token = str(uuid.uuid4())
        self.container = None
        self.render, self.group = str(Path(render).resolve(strict=True)), str(int(group))
        node = Path(self.render).name
        assert node.startswith("renderD") and stat.S_ISCHR(os.stat(self.render).st_mode)
        assert Path("/sys/class/drm", node, "device/driver").resolve().name == "v3d"
        assert str(os.stat(self.render).st_gid) == self.group
        metadata = self.inspect("image", image)
        assert metadata["Architecture"] == "arm64" and metadata["Config"]["User"] == "10000:10000"
        self.image = metadata["Id"]
        self.output = Path(output).resolve(strict=True)
        assert self.output.is_dir() and self.output.stat().st_mode & 0o077 == 0
        self.original = self.inventory()
        self.report = {"token": self.token, "image": self.image, "backend": backend, "passed": False,
                       "scope": "isolated synthetic display; no Chromium or viewer qualification", "phases": []}

    @staticmethod
    def docker(*args, timeout=15, check=True):
        result = subprocess.run(["docker", *args], text=True, capture_output=True, timeout=timeout)
        if check and result.returncode:
            raise RuntimeError(f"docker {args[0]}: {(result.stdout + result.stderr)[-6000:]}")
        return result.stdout.strip() if check else result

    def inspect(self, kind, identifier):
        return json.loads(self.docker(kind, "inspect", identifier))[0]

    def inventory(self):
        result = {}
        for identifier in self.docker("ps", "-q").splitlines():
            item = self.inspect("container", identifier)
            if item["Config"]["Labels"].get(self.LABEL) != self.token:
                result[item["Id"]] = {"image": item["Image"], "started": item["State"]["StartedAt"],
                                      "restarts": item["RestartCount"]}
        return result

    def owned(self):
        item = self.inspect("container", self.container)
        config = item["HostConfig"]
        assert item["Id"] == self.container and item["Image"] == self.image
        assert item["Config"]["Labels"].get(self.LABEL) == self.token
        assert item["Config"]["User"] == "10000:10000" and config["ReadonlyRootfs"]
        lease_env = [value for value in item["Config"].get("Env", []) if value.startswith("BPANE_GPU_LEASE=")]
        assert lease_env == (["BPANE_GPU_LEASE=1"] if self.lease else [])
        assert config["NetworkMode"] == "none" and not config["PortBindings"]
        assert not config["Privileged"] and not config["CapAdd"] and config["CapDrop"] == ["ALL"]
        assert config["SecurityOpt"] in (["no-new-privileges:true"], ["no-new-privileges"])
        assert config["RestartPolicy"]["Name"] == "no"
        assert config["Memory"] == 512 * 1024 * 1024 and config["PidsLimit"] == 128
        assert config["CpuShares"] == 128 and config["ShmSize"] == 128 * 1024 * 1024
        assert config["Tmpfs"] == {"/tmp": "size=128m,mode=1777,nosuid,nodev"}
        assert not config["PidMode"] and config["IpcMode"] == "private"
        assert config["Devices"] == [{"PathOnHost": self.render, "PathInContainer": "/dev/bpane-render",
                                      "CgroupPermissions": "rw"}]
        assert config["GroupAdd"] == [self.group]
        mounts = [entry for entry in item["Mounts"] if entry["Type"] != "tmpfs"]
        assert len(mounts) == 1 and mounts[0]["Type"] == "bind" and not mounts[0]["RW"]
        assert mounts[0]["Source"] == mounts[0]["Destination"] == "/dev/dri"
        return item

    @staticmethod
    def pressure():
        memory = dict(line.split(":", 1) for line in Path("/proc/meminfo").read_text().splitlines())
        result = {"availableMiB": int(memory["MemAvailable"].split()[0]) / 1024,
                  "temperatureC": int(Path("/sys/class/thermal/thermal_zone0/temp").read_text()) / 1000,
                  "load1": float(Path("/proc/loadavg").read_text().split()[0])}
        assert result["availableMiB"] >= 1024 and result["temperatureC"] < 78, "Host pressure stop"
        return result

    def create(self):
        self.report["hostBefore"] = self.pressure()
        command = ["/usr/lib/xorg/Xorg", ":99", "-config", "/etc/X11/bpane.conf", "-logfile", "/tmp/Xorg.log", "-verbose", "3"]
        self.container = self.docker("create", "--name", "bph-gpu-dummy-" + self.token,
            "--label", self.LABEL + "=" + self.token, "--user=10000:10000", "--network=none",
            "--restart=no", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges:true",
            "--device", self.render + ":/dev/bpane-render:rw", "--group-add", self.group,
            "--mount=type=bind,src=/dev/dri,dst=/dev/dri,readonly", "--memory=512m",
            "--cpu-shares=128", "--pids-limit=128", "--shm-size=128m",
            "--tmpfs=/tmp:size=128m,mode=1777,nosuid,nodev", "--log-opt=max-size=2m", "--log-opt=max-file=2",
            "--entrypoint=/usr/bin/tini", *(["--env=BPANE_GPU_LEASE=1"] if self.lease else []), self.image, "--", *command,
            "-nolisten", "tcp", "-noreset", "-nocursor", "-ac")
        self.owned()
        self.report["container"] = self.container
        self.save("ownership")
        self.docker("start", self.container)

    def ready(self):
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            assert self.owned()["State"]["Running"], "Xorg exited during initialization"
            self.pressure()
            result = self.docker("exec", self.container, "timeout", "2", "xdpyinfo", "-queryExtensions", check=False)
            if result.returncode == 0 and "DRI3" in result.stdout:
                log = self.docker("exec", self.container, "cat", "/tmp/Xorg.log")
                assert "BPANE_V3D_EGL_READY" in log and "BPANE_TEST_SOFTWARE_ONLY" not in log
                assert ("BPANE_GPU_LEASE_READY" in log) == self.lease
                return
            time.sleep(0.2)
        raise RuntimeError("GPU display readiness deadline")

    def probe(self, binary, marker):
        self.owned()
        self.pressure()
        result = self.docker("exec", self.container, "timeout", "20", binary, timeout=25)
        assert marker in result, "Probe success marker missing"
        assert not self.owned()["State"]["OOMKilled"]
        self.report["phases"].append({"probe": binary, "result": result, "host": self.pressure()})
        print(json.dumps({"probe": binary, "passed": True}), flush=True)

    def run(self):
        self.create()
        self.ready()
        self.report["packages"] = self.docker("exec", self.container, "dpkg-query", "-W",
            "libgl1-mesa-dri", "libegl-mesa0", "xserver-xorg-core")
        self.probe("bpane-display-probe", "rejected_resize_unchanged=passed")
        self.probe("bpane-egl-probe", "v3d_x11_egl_swap_pixels=passed")
        self.owned()
        self.docker("stop", "--time=5", self.container)
        assert self.owned()["State"]["ExitCode"] == 0, "Unclean Xorg shutdown"
        self.docker("start", self.container)
        self.ready()
        self.probe("bpane-display-probe", "rejected_resize_unchanged=passed")
        self.probe("bpane-egl-probe", "v3d_x11_egl_swap_pixels=passed")
        if self.benchmark:
            self.report["benchmarkHostBefore"] = self.pressure()
            result = self.docker("exec", self.container, "timeout", "25", "bpane-egl-probe", "--benchmark", timeout=30)
            self.report["benchmark"] = json.loads(result)
            self.report["summary"] = benchmark_summary(self.report["benchmark"])
            self.report["benchmarkHostAfter"] = self.pressure()
            print(json.dumps({"backend": self.backend, "summary": self.report["summary"]}), flush=True)
        if self.damage:
            self.pressure()
            result = self.docker("exec", self.container, "timeout", "20", "bpane-egl-probe", "--damage-test", timeout=25)
            self.report["nativeDamage"] = json.loads(result)
            self.report["damageSummary"] = damage_summary(self.report["nativeDamage"])
            self.report["damageHostAfter"] = self.pressure()
            print(json.dumps({"backend": self.backend, "damageSummary": self.report["damageSummary"]}), flush=True)
        if self.lease and not self.comparison:
            self.pressure()
            result = self.docker("exec", self.container, "timeout", "25", "bpane-lease-probe", timeout=30)
            self.report["lease"] = json.loads(result)
            self.report["leaseSummary"] = lease_summary(self.report["lease"])
            self.report["leaseHostAfter"] = self.pressure()
            print(json.dumps({"leaseSummary": self.report["leaseSummary"]}), flush=True)
        if self.comparison:
            self.pressure()
            result = self.docker("exec", self.container, "timeout", "45", "bpane-compare-probe", timeout=50)
            self.report["comparison"] = json.loads(result)
            self.report["comparisonSummary"] = comparison_summary(self.report["comparison"])
            self.report["comparisonHostAfter"] = self.pressure()
            print(json.dumps({"comparisonSummary": self.report["comparisonSummary"]}), flush=True)
        self.owned()
        self.docker("stop", "--time=5", self.container)
        assert self.owned()["State"]["ExitCode"] == 0, "Unclean final display shutdown"
        self.report["passed"] = True

    def save(self, prefix):
        with (self.output / (prefix + "-" + self.token + ".json")).open("x") as stream:
            json.dump(self.report, stream, indent=2)

    def finish(self):
        try:
            if self.container:
                info = self.owned()
                logs = self.docker("logs", "--tail=160", self.container, check=False)
                self.report["displayLogs"] = (logs.stdout + logs.stderr)[-22000:]
                self.report["finalState"] = info["State"]
                self.docker("stop", "--time=5", self.container)
                self.owned()
                self.docker("rm", self.container)
            self.report["originalServicesUnchanged"] = self.inventory() == self.original
            assert self.report["originalServicesUnchanged"], "A pre-existing service changed during qualification"
        except Exception as error:
            self.report["passed"] = False
            self.report["cleanupError"] = str(error)[-6000:]
            raise
        finally:
            self.save("report")


def main():
    if not __debug__:
        raise RuntimeError("Do not disable qualification assertions")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", required=True)
    parser.add_argument("--render", required=True)
    parser.add_argument("--render-gid", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--backend", choices=("glamor",), default="glamor")
    parser.add_argument("--benchmark", action="store_true")
    parser.add_argument("--damage", action="store_true", help="Native damage metadata oracle, not a benchmark")
    parser.add_argument("--lease", action="store_true", help="Opt-in GPU snapshot/compute component oracle; no browser")
    parser.add_argument("--compare-lease", action="store_true", help="Isolated immutable-frame shader comparison; not viewer latency")
    args = parser.parse_args()
    pilot = DisplayPilot(args.image, args.render, args.render_gid, args.output_dir, args.backend, args.benchmark, args.damage, args.lease, args.compare_lease)
    def interrupted(signum, frame):
        raise RuntimeError("Pilot interrupted")
    signal.signal(signal.SIGTERM, interrupted)
    try:
        pilot.run()
    except Exception as error:
        pilot.report["error"] = str(error)[-6000:]
        raise
    finally:
        pilot.finish()
    print(json.dumps({"passed": pilot.report["passed"], "token": pilot.token,
                      "originalServicesUnchanged": pilot.report["originalServicesUnchanged"]}))


if __name__ == "__main__":
    main()
