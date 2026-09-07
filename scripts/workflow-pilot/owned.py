"""Own every deployment target by exact ID and label; never accept existing state volumes."""

import json
from pathlib import Path
import subprocess
import time
import uuid


class OwnedPilot:
    LABEL = "io.browserpane.workflow-pilot"

    def __init__(self, code, browser, hermes, display, devices, protocol_trace=False):
        self.code, self.token = Path(code).resolve(), str(uuid.uuid4())
        self.prefix = "bph-workflow-" + self.token
        self.network, self.volumes, self.containers = None, {}, {}
        self.images = {role: self.inspect("image", ref)["Id"] for role, ref in
                       (("browser", browser), ("hermes", hermes), ("display", display))}
        for image in self.images.values():
            assert self.inspect("image", image)["Architecture"] == "arm64"
        self.devices = devices
        self.protocol_trace = protocol_trace
        self.original = self.inventory()

    def docker(self, *args, input=None, timeout=60):
        result = subprocess.run(["docker", *args], input=input, text=True, capture_output=True, timeout=timeout)
        if result.returncode:
            raise RuntimeError(f"Docker {args[0]} failed: {result.stderr[-1500:]}")
        return result.stdout.strip()

    def inspect(self, kind, target):
        return json.loads(self.docker(kind, "inspect", target))[0]

    def inventory(self):
        ids = self.docker("ps", "-q").splitlines()
        return {item["Id"]: {"image": item["Image"], "started": item["State"]["StartedAt"],
                "restarts": item["RestartCount"]} for item in
                (self.inspect("container", value) for value in ids) if item["Config"]["Labels"].get(self.LABEL) != self.token}

    def owned(self, kind, target):
        value = self.inspect(kind, target)
        labels = value["Config"]["Labels"] if kind == "container" else value["Labels"]
        assert labels.get(self.LABEL) == self.token, "Refusing unowned resource"
        if kind == "container":
            assert not value["HostConfig"]["PortBindings"] and not value["HostConfig"]["Privileged"]
        return value

    def mount(self, volume, target):
        name = self.volumes[volume]
        self.owned("volume", name)
        return ["--mount", f"type=volume,src={name},dst={target}"]

    def create(self, role, image, args=(), command=()):
        assert role not in self.containers
        identifier = self.docker("create", "--name", self.prefix + "-" + role,
            "--label", self.LABEL + "=" + self.token, "--restart=no", "--cap-drop=ALL",
            "--security-opt=no-new-privileges:true", "--log-opt=max-size=2m", "--log-opt=max-file=2",
            "-e", "BPANE_WORKFLOW_PILOT=" + self.token, *args, image, *command)
        self.containers[role] = identifier
        value = self.owned("container", identifier)
        assert value["Image"] == self.inspect("image", image)["Id"]
        self.docker("start", identifier)
        return identifier

    def prepare(self):
        self.network = self.docker("network", "create", "--internal", "--label", self.LABEL + "=" + self.token, self.prefix)
        assert self.owned("network", self.network)["Internal"]
        for role in ("profile", "shared", "agent", "x11"):
            name = self.prefix + "-" + role
            assert not self.docker("volume", "ls", "-q", "--filter", "name=" + name)
            self.volumes[role] = self.docker("volume", "create", "--label", self.LABEL + "=" + self.token, name)
        init = self.create("init", self.images["hermes"], ["--network=none", "--user=0:0", "--cap-add=CHOWN", "--cap-add=FOWNER",
            *self.mount("profile", "/data"), *self.mount("shared", "/shared"), *self.mount("agent", "/opt/data"),
            *self.mount("x11", "/tmp/.X11-unix"), "--entrypoint=python"], ["-c",
            "import os; [(os.chown(p,10000,10000),os.chmod(p,0o700)) for p in ['/data','/shared','/opt/data','/tmp/.X11-unix']]"])
        assert self.docker("wait", init) == "0"
        seed = self.create("seed", self.images["hermes"], ["--network=none", "--entrypoint=python",
            *self.mount("agent", "/opt/data"), "--mount", f"type=bind,src={self.code},dst=/pilot,readonly"], ["/pilot/seed.py"])
        assert self.docker("wait", seed) == "0"
        self.create("fixture", self.images["browser"], ["--network", self.network,
            "--memory=128m", "--pids-limit=64", "--cpu-shares=128", "--init", "--no-healthcheck", "--entrypoint=node",
            "--mount", f"type=bind,src={self.code},dst=/pilot,readonly"], ["/pilot/fixture.mjs"])
        self.execute("fixture", "curl", "--retry", "5", "--retry-connrefused", "--retry-delay", "1",
                     "-fsS", "--max-time", "5", "http://127.0.0.1:9130/" + self.token + "/report")
        self.create("display", self.images["display"], ["--network=none", "--ipc=shareable", "--shm-size=256m",
            "--memory=256m", "--pids-limit=128", "--cpu-shares=128", "--tmpfs=/tmp:size=128m,mode=1777,nosuid,nodev",
            *self.gpu(), *self.mount("x11", "/tmp/.X11-unix")])
        self.healthy("display")
        self.start_browser()
        self.start_hermes()

    def gpu(self):
        return ["--device", self.devices["render"] + ":/dev/bpane-render:rw",
                "--device", self.devices["display"] + ":/dev/bpane-display:rw",
                "--group-add", self.devices["renderGid"], "--group-add", self.devices["displayGid"],
                "--mount", "type=bind,src=/dev/dri,dst=/dev/dri,readonly"]

    def start_browser(self):
        self.owned("container", self.containers["fixture"])
        self.create("browser", self.images["browser"], ["--network=container:" + self.containers["fixture"],
            "--memory=1536m", "--pids-limit=512", "--cpu-shares=128", "--ipc=container:" + self.containers["display"],
            "--security-opt", "seccomp=" + str(self.code / "chromium-seccomp.json"),
            "--tmpfs=/tmp:size=1g,mode=1777,nosuid,nodev", *self.gpu(), *self.mount("x11", "/tmp/.X11-unix"),
            *self.mount("profile", "/data"), *self.mount("shared", "/shared"), "--env-file", str(self.code / "host-runtime.env"),
            "-e", "VIEWER_ORIGIN=https://pilot.invalid", "-e", "GATEWAY_URL=https://pilot.invalid:4433",
            "-e", "BPANE_GPU_MODE=v3d", "-e", "BPANE_X11_BACKEND=xvnc", "-e", "BPANE_DEVICE_SCALE=1",
            "-e", "BPANE_URL=http://127.0.0.1:9130/" + self.token + "/report", "-e", "BPANE_CHROMIUM_SANDBOX_MODE=strict",
            "-e", "BPANE_CHROMIUM_EXTRA_FLAGS=--disable-setuid-sandbox", "-e", "BPANE_MCP_MODE=compact",
            "-e", "BPANE_MCP_TIMINGS=1", "-e", "RUST_LOG=warn",
            *(["-e", "DEBUG=pw:protocol", "-e", "DEBUG_COLORS=0"] if self.protocol_trace else [])])
        self.healthy("browser")

    def start_hermes(self):
        self.owned("container", self.containers["fixture"])
        self.create("hermes", self.images["hermes"], ["--network=container:" + self.containers["fixture"], "--memory=768m", "--pids-limit=256",
            "--cpu-shares=128", *self.mount("agent", "/opt/data"), *self.mount("shared", "/shared"),
            "--mount", f"type=bind,src={self.code},dst=/pilot,readonly"])
        self.healthy("hermes")

    def healthy(self, role):
        deadline = time.monotonic() + 150
        while time.monotonic() < deadline:
            info = self.owned("container", self.containers[role])
            assert info["State"]["Running"], role + " exited"
            if info["State"].get("Health", {}).get("Status") == "healthy":
                return
            time.sleep(1)
        raise RuntimeError(role + " health timeout")

    def execute(self, role, *args, input=None, timeout=60):
        identifier = self.containers[role]
        self.owned("container", identifier)
        return self.docker("exec", "-i", identifier, *args, input=input, timeout=timeout)

    def restart(self, role):
        self.owned("container", self.containers[role])
        self.docker("restart", "--time=45", self.containers[role], timeout=60)
        self.healthy(role)

    def remove(self, role):
        identifier = self.containers[role]
        self.owned("container", identifier)
        self.docker("stop", "--time=45", identifier, timeout=60)
        self.docker("rm", identifier)
        del self.containers[role]

    def cleanup(self):
        for role in list(self.containers)[::-1]:
            self.remove(role)
        for name in self.volumes.values():
            self.owned("volume", name)
            self.docker("volume", "rm", name)
        if self.network:
            self.owned("network", self.network)
            self.docker("network", "rm", self.network)
        assert self.inventory() == self.original, "A pre-existing service changed during the pilot"
