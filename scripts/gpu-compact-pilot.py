#!/usr/bin/env python3
"""Finite GPU-only component pilot. No X11 connection, browser or LAN listener."""
import argparse
import hashlib
import json
import math
import re
import stat
import statistics
import subprocess
import uuid
from pathlib import Path


def summarize(output, *, deduplicate=False, profile_stages=False):
    assert len(output) <= 1024 * 1024, "Oversized output"
    lines = [json.loads(line) for line in output.splitlines()]
    assert len(lines) == 361 and lines[-1] == {
        "complete": True, "scope": "synthetic-gpu-content-index", "pixelErrors": 0}
    rows = lines[:-1]
    expected = [(w, h, scene, frame) for w, h, n in [(1279, 719, 4), (1280, 720, 32)]
                for scene in range(10) for frame in range(1, n + 1)]
    for row, identity in zip(rows, expected):
        assert tuple(row[k] for k in ("width", "height", "scene", "frame")) == identity
        w, h, _, frame = identity
        tiles = math.ceil(w / 32) * math.ceil(h / 32)
        assert type(row["dirtyTiles"]) is int and 0 <= row["dirtyTiles"] <= tiles
        assert type(row["moveTiles"]) is int and 0 <= row["moveTiles"] <= tiles - row["dirtyTiles"]
        assert row["readbackBytes"] == (3 * tiles + 1) * 4 + row["dirtyTiles"] * 4096
        assert row["measured"] is (w == 1280 and frame > 8)
        assert row["fullFirst"] is (frame % 2 == 1)
        assert row["deduplicate"] is deduplicate and row["profileStages"] is profile_stages
        stages = row["stageQueryNs"]
        assert isinstance(stages, list) and len(stages) == 4
        assert all(type(v) is int and (0 < v < 1_000_000_000 if profile_stages else v == 0)
                   for v in stages)
        for key in ("fullNs", "fullCpuNs", "compactNs", "compactCpuNs", "metadataNs", "payloadNs"):
            assert type(row[key]) is int and 0 <= row[key] < 10_000_000_000
        assert row["compactNs"] == row["metadataNs"] + row["payloadNs"]
        if frame == 1:
            assert row["dirtyTiles"] == tiles and row["moveTiles"] == 0
    result = {}
    for scene in range(10):
        selected = [r for r in rows if r["measured"] and r["scene"] == scene]
        result[scene] = {"n": len(selected)}
        for key in ("fullNs", "fullCpuNs", "compactNs", "compactCpuNs", "metadataNs", "payloadNs", "readbackBytes"):
            values = sorted(r[key] for r in selected)
            result[scene][key] = {"median": statistics.median(values),
                                 "p95": values[math.ceil(len(values) * .95) - 1], "max": max(values)}
        if profile_stages:
            result[scene]["stageQueryNs"] = {}
            for index, name in enumerate(("indexClear", "fingerprints", "lookup", "verifyGather")):
                values = sorted(r["stageQueryNs"][index] for r in selected)
                result[scene]["stageQueryNs"][name] = {"median": statistics.median(values),
                    "p95": values[math.ceil(len(values) * .95) - 1], "max": max(values)}
    return result


class CompactPilot:
    LABEL = "io.browserpane.gpu-compact-pilot"

    def __init__(self, args):
        if not __debug__:
            raise RuntimeError("Do not disable pilot assertions with Python -O")
        self.token, self.container = str(uuid.uuid4()), None
        self.shader_stats = args.shader_stats
        self.deduplicate, self.profile_stages = args.deduplicate, args.profile_stages
        assert not (self.shader_stats and self.profile_stages), "Keep diagnostics separate"
        self.command = ["--signal=TERM", "--kill-after=3s", "90", "/pilot/probe", "--hardware-test"]
        if self.deduplicate:
            self.command.append("--deduplicate")
        if self.profile_stages:
            self.command.append("--profile-stages")
        self.output = Path(args.output).resolve(strict=True)
        assert self.output.is_dir() and self.output.stat().st_mode & 0o077 == 0
        self.binary = Path(args.binary).resolve(strict=True)
        data = self.binary.read_bytes()
        assert self.binary.is_file() and not self.binary.stat().st_mode & 0o022
        assert len(data) < 8 * 1024 * 1024 and data[:6] == b"\x7fELF\x02\x01" and data[18:20] == b"\xb7\x00"
        assert re.fullmatch(r"[a-f0-9]{64}", args.sha256) and hashlib.sha256(data).hexdigest() == args.sha256
        assert re.fullmatch(r"sha256:[a-f0-9]{64}", args.image)
        image = self.inspect("image", args.image)
        assert image["Architecture"] == "arm64" and image["Config"]["User"] == "10000:10000"
        assert not image["Config"].get("Volumes"), "No implicit volumes"
        self.image = image["Id"]
        self.render = Path(args.render).resolve(strict=True)
        assert stat.S_ISCHR(self.render.stat().st_mode) and self.render.name.startswith("renderD")
        assert Path("/sys/class/drm", self.render.name, "device/driver").resolve().name == "v3d"
        self.group = str(self.render.stat().st_gid)
        self.original = self.inventory()
        self.report = {"token": self.token, "image": self.image, "binarySha256": args.sha256,
                       "scope": "synthetic-gpu-content-index", "passed": False, "cleaned": False,
                       "originalServices": self.original, "hostBefore": self.pressure()}
        self.report["shaderStats"] = self.shader_stats
        self.report["deduplicate"] = self.deduplicate
        self.report["profileStages"] = self.profile_stages
        self.save()

    @staticmethod
    def docker(*args, timeout=15):
        result = subprocess.run(["docker", *args], capture_output=True, text=True, timeout=timeout)
        if result.returncode:
            raise RuntimeError(f"docker {args[0]}: {(result.stdout + result.stderr)[-2000:]}")
        return result.stdout.strip()

    def inspect(self, kind, target):
        return json.loads(self.docker(kind, "inspect", target))[0]

    def inventory(self):
        values = [self.inspect("container", cid) for cid in self.docker("ps", "-q").splitlines()]
        return {v["Id"]: [v["Image"], v["State"]["StartedAt"], v["RestartCount"]] for v in values
                if (v["Config"]["Labels"] or {}).get(self.LABEL) != self.token}

    @staticmethod
    def pressure():
        memory = dict(line.split(":", 1) for line in Path("/proc/meminfo").read_text().splitlines())
        result = {"availableMiB": int(memory["MemAvailable"].split()[0]) / 1024,
                  "temperatureC": int(Path("/sys/class/thermal/thermal_zone0/temp").read_text()) / 1000,
                  "load1": float(Path("/proc/loadavg").read_text().split()[0])}
        assert result["availableMiB"] > 1024 and result["temperatureC"] < 75, "Host pressure stop"
        return result

    def save(self):
        (self.output / (self.token + ".json")).write_text(json.dumps(self.report, indent=2))

    def identity(self):
        item = self.inspect("container", self.container)
        assert item["Id"] == self.container and item["Image"] == self.image
        assert item["Config"]["Labels"].get(self.LABEL) == self.token
        return item

    def owned(self):
        item = self.identity()
        config = item["HostConfig"]
        assert item["Config"]["User"] == "10000:10000" and config["ReadonlyRootfs"]
        assert config["NetworkMode"] == "none" and not config["PortBindings"]
        assert not config["Privileged"] and not config["CapAdd"] and config["CapDrop"] == ["ALL"]
        assert config["SecurityOpt"] in (["no-new-privileges:true"], ["no-new-privileges"])
        assert config["RestartPolicy"]["Name"] == "no" and config["Memory"] == 256 * 1024 * 1024
        assert config["PidsLimit"] == 64 and config["CpuShares"] == 128 and config["NanoCpus"] == 0
        assert config["CpuQuota"] == 0 and config["MemorySwap"] == 256 * 1024 * 1024
        assert config["Tmpfs"] == {"/tmp": "size=32m,mode=1777,nosuid,nodev"}
        assert item["Config"]["Entrypoint"] == ["/usr/bin/timeout"]
        assert item["Config"]["Cmd"] == self.command
        assert "V3D_DEBUG=" + ("shaderdb" if self.shader_stats else "") in item["Config"]["Env"]
        assert not config["PidMode"] and config["IpcMode"] == "private"
        assert config["Devices"] == [{"PathOnHost": str(self.render), "PathInContainer": "/dev/bpane-render",
                                      "CgroupPermissions": "rw"}]
        assert config["GroupAdd"] == [self.group]
        mounts = [m for m in item["Mounts"] if m["Type"] != "tmpfs"]
        assert len(mounts) == 2 and all(m["Type"] == "bind" and not m["RW"] for m in mounts)
        assert {m["Destination"]: m["Source"] for m in mounts} == {
            "/pilot/probe": str(self.binary), "/dev/dri": "/dev/dri"}
        return item

    def run(self):
        try:
            self.container = self.docker("create", "--name", "bph-gpu-compact-" + self.token,
                "--label", self.LABEL + "=" + self.token, "--user=10000:10000", "--network=none",
                "--restart=no", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges:true",
                "--device", str(self.render) + ":/dev/bpane-render:rw", "--group-add", self.group,
                "--mount", "type=bind,src=" + str(self.binary) + ",dst=/pilot/probe,readonly",
                # Mesa/libdrm enumerates DRM node names. Cgroup permits opening
                # ONLY the render node above, not the physical display devices.
                "--mount=type=bind,src=/dev/dri,dst=/dev/dri,readonly",
                "--memory=256m", "--memory-swap=256m", "--cpu-shares=128", "--pids-limit=64",
                "--tmpfs=/tmp:size=32m,mode=1777,nosuid,nodev", "--log-opt=max-size=1m", "--log-opt=max-file=2",
                "--env=BPANE_GPU_COMPACT_PILOT=1", "--env=MESA_SHADER_CACHE_DISABLE=true",
                "--env=V3D_DEBUG=" + ("shaderdb" if self.shader_stats else ""),
                "--entrypoint=/usr/bin/timeout", self.image,
                *self.command)
            self.report["container"] = self.container
            self.save()
            self.owned()
            self.docker("start", self.container)
            self.docker("wait", self.container, timeout=100)
            state = self.owned()["State"]
            # stderr includes renderer identity; preserve it separately from JSON.
            log = subprocess.run(["docker", "logs", self.container], text=True, capture_output=True,
                                 timeout=15, check=True)
            (self.output / (self.token + ".jsonl")).write_text(log.stdout)
            self.report["rendererLog"] = log.stderr
            self.report["state"] = state
            assert state["ExitCode"] == 0 and not state["OOMKilled"] and not state["Running"]
            assert "renderer=V3D" in log.stderr and "llvmpipe" not in log.stderr
            self.report["summary"] = summarize(log.stdout, deduplicate=self.deduplicate,
                                               profile_stages=self.profile_stages)
            self.report["hostAfter"] = self.pressure()
            self.report["passed"] = True
        except Exception as error:
            self.report["error"] = str(error)
            raise
        finally:
            if self.container:
                self.identity()
                self.docker("rm", "-f", self.container)
            self.report["cleaned"] = True
            self.report["servicesUnchanged"] = self.inventory() == self.original
            self.report["passed"] = self.report["passed"] and self.report["servicesUnchanged"]
            self.save()
            assert self.report["servicesUnchanged"], "Original service inventory changed"
        print(json.dumps({"token": self.token, "passed": self.report["passed"], "cleaned": True}), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for key in ("image", "binary", "sha256", "render", "output"):
        parser.add_argument("--" + key, required=True)
    parser.add_argument("--shader-stats", action="store_true", help="Separate diagnostic; never pool with clean timings")
    parser.add_argument("--deduplicate", action="store_true", help="Opt-in identical-source comparison optimization")
    parser.add_argument("--profile-stages", action="store_true", help="Intrusive driver-query intervals, not pure GPU time")
    arguments = parser.parse_args()
    CompactPilot(arguments).run()
