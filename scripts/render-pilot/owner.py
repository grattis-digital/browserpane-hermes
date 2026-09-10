"""Finite disposable browser/display ownership. Requires explicit LAN approval."""
import json
import re
from pathlib import Path
import socket
import stat
import subprocess
import time
import uuid
from firewall import PilotFirewall
from custom_chromium import CustomChromium
from stock_trace import StockTrace


class RenderOwner:
    LABEL = "io.browserpane.render-pilot"

    def __init__(self, config):
        assert config["allowLan"] is True and config["mode"] in ("cpu", "gpu-tail")
        self.features = self.features_from(config)
        self.custom_chromium = CustomChromium.parse(config)
        self.config, self.token = config, str(uuid.uuid4())
        self.stock_trace = StockTrace(self)
        self.prefix = "bph-render-" + self.token
        self.code = Path(__file__).resolve().parent
        assert self.code.parent.stat().st_mode & 0o077 == 0
        self.containers, self.network, self.volume = {}, None, None
        self.expected = {}
        self.images = {}
        for role in ("browser", "display"):
            assert re.fullmatch(r"sha256:[a-f0-9]{64}", config[role + "Image"]), "Immutable image ID required"
            image = self.inspect("image", config[role + "Image"])
            assert image["Architecture"] == "arm64" and image["Config"]["User"] == "10000:10000"
            self.images[role] = image["Id"]
        self.devices = []
        for kind, driver in (("render", "v3d"), ("display", "vc4-drm")):
            path = Path(config[kind + "Device"]).resolve(strict=True)
            assert stat.S_ISCHR(path.stat().st_mode)
            assert Path("/sys/class/drm", path.name, "device/driver").resolve().name == driver, "Unexpected " + kind + " driver"
            self.devices.append((str(path), "/dev/bpane-" + kind, str(path.stat().st_gid)))
        self.firewall = PilotFirewall(self.token, config["hostIp"], config["clientIp"], config["tcpPort"], config["udpPort"])
        self.original = self.inventory()
        self.firewall_before = self.firewall.command("-S", "DOCKER-USER").stdout
        self.input_before = self.firewall.command("-S", "INPUT").stdout
        self.record = {"token": self.token, "mode": config["mode"], "images": self.images, "containers": self.containers,
                       "features": self.features,
                       "customChromium": self.custom_chromium,
                       "expected": self.expected, "originalServices": self.original,
                       "firewallBefore": self.firewall_before, "inputBefore": self.input_before,
                       "network": None, "socketVolume": None, "firewallChain": self.firewall.chain, "cleaned": False}

    @staticmethod
    def features_from(config):
        features = {key: config.get(key, False) for key in ("damageReadback", "damageAnalysis", "captureTimings", "nativeDamageTrace", "stockGpuTrace", "stockGpuWorkloads")}
        assert all(type(value) is bool for value in features.values()), "Experimental flags must be booleans"
        assert not (features["stockGpuTrace"] and (features["nativeDamageTrace"] or config.get("customChromium"))), "Stock trace cannot mix with custom/native trace"
        assert not features["stockGpuTrace"] or features["stockGpuWorkloads"], "Stock trace requires bounded stock workloads"
        return features

    @staticmethod
    def docker(*args, timeout=20):
        result = subprocess.run(["docker", *args], text=True, capture_output=True, timeout=timeout)
        if result.returncode:
            raise RuntimeError("Docker " + args[0] + " failed: " + result.stderr[-2000:])
        return result.stdout.strip()

    def inspect(self, kind, target):
        return json.loads(self.docker(kind, "inspect", target))[0]

    def inventory(self):
        entries = [self.inspect("container", value) for value in self.docker("ps", "-q").splitlines()]
        return {v["Id"]: [v["Image"], v["State"]["StartedAt"], v["RestartCount"]] for v in entries
                if (v["Config"]["Labels"] or {}).get(self.LABEL) != self.token}

    def save(self):
        # Private parent, fixed run-specific file; no profile/page content.
        path = self.code.parent / ("owner-" + self.token + ".json")
        with path.open("w") as stream:
            json.dump(self.record, stream, indent=2)

    def owned(self, role):
        item = self.inspect("container", self.containers[role])
        expected = self.expected[role]
        assert item["Id"] == self.containers[role] and item["Image"] == expected["image"]
        assert item["Config"]["User"] == "10000:10000" and item["Config"]["Labels"][self.LABEL] == self.token
        # Freeze the exact inspected boundary at creation, after checking safety.
        changed = [key for key in item["HostConfig"].keys() | expected["host"].keys() if self.host_value(key, item["HostConfig"].get(key))
                   != self.host_value(key, expected["host"].get(key))]
        assert not changed, "Container boundary changed: " + ",".join(changed)
        assert item["Mounts"] == expected["mounts"], "Container mounts changed"
        return item

    @staticmethod
    def host_value(key, value):
        # Docker materializes an omitted nullable bool as false when starting.
        # Both retain the OOM killer. A true value is NEVER normalized away.
        return False if key == "OomKillDisable" and value is None else value

    def create(self, role, args):
        image = self.images[role]
        identifier = self.docker("create", "--name", self.prefix + "-" + role, "--label", self.LABEL + "=" + self.token,
            "--restart=no", "--user=10000:10000", "--cap-drop=ALL", "--security-opt=no-new-privileges:true",
            "--cpu-shares=128", "--log-opt=max-size=5m", "--log-opt=max-file=2", *args, image)
        self.containers[role] = identifier
        info = self.inspect("container", identifier)
        host = info["HostConfig"]
        # Record the exact object returned by our create before validation, so a
        # rejected, never-started object can still be cleaned up by immutable ID.
        self.expected[role] = {"image": image, "host": host, "mounts": info["Mounts"]}
        self.save()
        assert not host["Privileged"] and not host["CapAdd"] and host["CapDrop"] == ["ALL"]
        assert host["RestartPolicy"]["Name"] == "no" and host["NetworkMode"] != "host"
        assert not host["PidMode"] and host["Memory"] > 0 and host["PidsLimit"] > 0
        assert host["CpuQuota"] == 0 and host["NanoCpus"] == 0
        if role == "display":
            assert not host["PortBindings"] and host["NetworkMode"] == "none"
        else:
            assert host["PortBindings"] == {
                "8443/tcp": [{"HostIp": self.config["hostIp"], "HostPort": str(self.config["tcpPort"])}],
                "4433/udp": [{"HostIp": self.config["hostIp"], "HostPort": str(self.config["udpPort"])}]}
        display_memory = 768 if self.config["mode"] == "gpu-tail" else 256
        assert host["Memory"] == (display_memory if role == "display" else 1536) * 1048576
        assert host["PidsLimit"] == (128 if role == "display" else 512)
        assert "no-new-privileges:true" in host["SecurityOpt"]
        allowed = {}
        if role == "browser":
            allowed["/pilot"] = ("bind", str(self.code), False)
            assert host["NetworkMode"] == self.network
        if self.config["mode"] == "gpu-tail":
            allowed["/dev/dri"] = ("bind", "/dev/dri", False)
            allowed["/tmp/.X11-unix"] = ("volume", self.volume, True)
        mounts = {m["Destination"]: (m["Type"], m.get("Name") if m["Type"] == "volume" else m["Source"], m["RW"])
                  for m in info["Mounts"] if m["Type"] != "tmpfs"}
        assert mounts == allowed, "Unexpected persistent/bind mount"
        devices = [{"PathOnHost": s, "PathInContainer": a, "CgroupPermissions": "rw"} for s, a, _ in self.devices]
        assert (host["Devices"] or []) == (devices if self.config["mode"] == "gpu-tail" else [])
        self.owned(role)
        self.save()
        self.docker("start", identifier)

    def gpu(self):
        args = ["--mount=type=bind,src=/dev/dri,dst=/dev/dri,readonly"]
        for source, alias, group in self.devices:
            args += ["--device", source + ":" + alias + ":rw", "--group-add", group]
        return args

    def ready(self, role):
        deadline = time.monotonic() + 150
        while time.monotonic() < deadline:
            state = self.owned(role)["State"]
            assert state["Running"] and not state["OOMKilled"], role + " exited/OOM"
            if state.get("Health", {}).get("Status") == "healthy":
                return
            self.pressure()
            time.sleep(0.5)
        raise RuntimeError(role + " readiness deadline")

    @staticmethod
    def pressure():
        memory = dict(line.split(":", 1) for line in Path("/proc/meminfo").read_text().splitlines())
        value = {"availableMiB": int(memory["MemAvailable"].split()[0]) / 1024,
                 "temperatureC": int(Path("/sys/class/thermal/thermal_zone0/temp").read_text()) / 1000,
                 "load1": float(Path("/proc/loadavg").read_text().split()[0])}
        assert value["availableMiB"] >= 1024 and value["temperatureC"] < 78, "Host pressure stop"
        return value

    def start(self):
        self.record["hostBefore"] = self.pressure()
        self.firewall.command("-C", "FORWARD", "-j", "DOCKER-USER")
        for kind, port in ((socket.SOCK_STREAM, self.config["tcpPort"]), (socket.SOCK_DGRAM, self.config["udpPort"])):
            with socket.socket(socket.AF_INET, kind) as probe:
                probe.bind((self.config["hostIp"], port))  # Refuse an occupied endpoint, never replace it.
        self.save()
        self.firewall.install()  # Source restriction exists BEFORE publishing.
        self.network = self.docker("network", "create", "--label", self.LABEL + "=" + self.token, self.prefix)
        self.record["network"] = self.network
        network = self.inspect("network", self.network)
        assert network["Driver"] == "bridge" and not network["EnableIPv6"]
        assert not network["Containers"] and not network["Options"]
        self.firewall.isolate_bridge("br-" + self.network[:12])
        self.save()
        config = self.config
        extra = []
        if config["mode"] == "gpu-tail":
            self.volume = self.docker("volume", "create", "--label", self.LABEL + "=" + self.token, self.prefix + "-x11")
            self.record["socketVolume"] = self.volume
            display_memory = "768m" if config["mode"] == "gpu-tail" else "256m"
            self.create("display", ["--network=none", "--ipc=shareable", "--shm-size=256m", "--memory=" + display_memory, "--memory-swap=" + display_memory, "--pids-limit=128",
                "--tmpfs=/tmp:size=128m,mode=1777,nosuid,nodev", *self.gpu(), "--mount", "type=volume,src=" + self.volume + ",dst=/tmp/.X11-unix"])
            self.ready("display")
            extra = [*self.gpu(), "--ipc=container:" + self.containers["display"], "--mount", "type=volume,src=" + self.volume + ",dst=/tmp/.X11-unix"]
        else:
            extra = ["--shm-size=256m"]
        self.create("browser", ["--network", self.network, "--memory=1536m", "--memory-swap=1536m", "--pids-limit=512",
            "--security-opt", "seccomp=" + str(self.code / "chromium-seccomp.json"),
            "--tmpfs=/tmp:size=768m,mode=1777,nosuid,nodev", "--tmpfs=/data:size=256m,uid=10000,gid=10000,mode=0700",
            "--tmpfs=/shared:size=128m,uid=10000,gid=10000,mode=0700", *extra,
            "--mount", "type=bind,src=" + str(self.code) + ",dst=/pilot,readonly",
            "--publish", config["hostIp"] + ":" + str(config["tcpPort"]) + ":8443/tcp",
            "--publish", config["hostIp"] + ":" + str(config["udpPort"]) + ":4433/udp",
            "--env-file", str(self.code / "host-runtime.env"),
            "--dns=127.0.0.1",
            "-e", "VIEWER_ORIGIN=https://" + config["hostIp"] + ":" + str(config["tcpPort"]),
            "-e", "GATEWAY_URL=https://" + config["hostIp"] + ":" + str(config["udpPort"]),
            "-e", "BPANE_GPU_MODE=" + ("cpu" if config["mode"] == "cpu" else "v3d"),
            "-e", "BPANE_X11_BACKEND=" + {"cpu": "dummy", "gpu-tail": "gpu-dummy"}[config["mode"]],
            "-e", "BPANE_GPU_TAIL=" + str(int(config["mode"] == "gpu-tail")),
            "-e", "BPANE_RENDER_PILOT=" + self.token, "-e", "BPANE_PIPELINE_TEST=1",
            "-e", "BPANE_STOCK_GPU_TRACE=" + str(int(self.features["stockGpuTrace"])),
            "-e", "BPANE_STOCK_GPU_WORKLOADS=" + str(int(self.features["stockGpuWorkloads"])),
            "-e", "BPANE_CAPTURE_TIMINGS=" + str(int(self.features["captureTimings"])),
            "-e", "BPANE_EXPERIMENTAL_DAMAGE_READBACK=" + str(int(self.features["damageReadback"])),
            "-e", "BPANE_EXPERIMENTAL_DAMAGE_ANALYSIS=" + str(int(self.features["damageAnalysis"])),
            "-e", "BPANE_DEVICE_SCALE=1", "-e", "BPANE_URL=about:blank", "-e", "RUST_LOG=warn",
            *CustomChromium.environment(self.custom_chromium),
            "-e", "BPANE_CHROMIUM_SANDBOX_MODE=strict", "-e", "BPANE_CHROMIUM_EXTRA_FLAGS=--disable-setuid-sandbox"])
        self.ready("browser")
        self.owned("browser")
        custom = CustomChromium.verify(self)
        self.docker("exec", "-d", self.containers["browser"], "node", "/pilot/proxy.mjs")
        return {"token": self.token, "mode": config["mode"], "images": self.images,
                "features": self.features,
                "customChromium": custom,
                "url": "https://" + config["hostIp"] + ":" + str(config["tcpPort"]) + "/browser/"}

    def execute(self, *args, timeout=20):
        self.owned("browser")
        return self.docker("exec", self.containers["browser"], *args, timeout=timeout)

    def close(self):
        errors = []
        try:
            if getattr(self, "stock_trace", None) is not None:
                self.stock_trace.close()
        except Exception as error:
            errors.append(str(error))
        for role in list(self.containers)[::-1]:
            try:
                self.owned(role)
                logs = subprocess.run(["docker", "logs", "--tail=500", self.containers[role]],
                    capture_output=True, timeout=10)
                # Synthetic, owned container only; retain bounded failure evidence
                # before --rm removes its logs. No production profile is mounted.
                evidence = (logs.stdout + logs.stderr)[-2 * 1024 * 1024:]
                with (self.code.parent / ("logs-" + self.token + "-" + role + ".log")).open("xb") as stream:
                    stream.write(evidence)
                self.docker("stop", "--time=40", self.containers[role], timeout=50)
                self.owned(role)
                self.docker("rm", self.containers[role])
            except Exception as error:
                errors.append(str(error))
        for kind, target in (("volume", self.volume), ("network", self.network)):
            if not target:
                continue
            try:
                assert self.inspect(kind, target)["Labels"][self.LABEL] == self.token
                self.docker(kind, "rm", target)
            except Exception as error:
                errors.append(str(error))
        try:
            # Keep source/egress restrictions if any owned workload could remain.
            assert not errors, "Cleanup incomplete; retaining test firewall rules"
            self.firewall.close()
            assert self.firewall.command("-S", "DOCKER-USER").stdout == self.firewall_before, "Firewall changed during pilot"
            assert self.firewall.command("-S", "INPUT").stdout == self.input_before, "Host input firewall changed during pilot"
            assert self.inventory() == self.original, "Pre-existing service changed during pilot"
        except Exception as error:
            errors.append(str(error))
        self.record["cleaned"], self.record["cleanupErrors"] = not errors, errors
        self.save()
        assert not errors, str(errors)
