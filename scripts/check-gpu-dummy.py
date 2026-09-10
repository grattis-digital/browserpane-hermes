#!/usr/bin/env python3
"""Owned, network-free Xorg ABI/geometry/Present checks; never claims GPU speed."""

import argparse
import json
import subprocess
import time
import uuid


class DisplayCheck:
    LABEL = "io.browserpane.test.gpu-dummy"

    def __init__(self, image):
        self.token = uuid.uuid4().hex
        self.image = self.docker("image", "inspect", image, "--format", "{{.Id}}")
        self.container = None

    @staticmethod
    def docker(*args, check=True, timeout=30):
        result = subprocess.run(["docker", *args], capture_output=True, text=True, timeout=timeout)
        if check and result.returncode:
            raise RuntimeError(result.stderr[-5000:])
        return result.stdout.strip() if check else result

    def owned(self):
        info = json.loads(self.docker("inspect", self.container))[0]
        assert info["Id"] == self.container
        assert info["Config"]["Labels"].get(self.LABEL) == self.token
        assert info["Image"] == self.image and info["Config"]["User"] == "10000:10000"
        assert info["HostConfig"]["NetworkMode"] == "none" and not info["HostConfig"]["PortBindings"]
        assert not info["HostConfig"]["Devices"] and not info["Mounts"]
        assert not info["HostConfig"]["Privileged"] and not info["HostConfig"]["CapAdd"]
        assert info["HostConfig"]["CapDrop"] == ["ALL"]
        assert info["HostConfig"]["SecurityOpt"] in (["no-new-privileges:true"], ["no-new-privileges"])
        return info

    def start(self):
        self.container = self.docker("create", "--name", "bph-dummy-check-" + self.token,
            "--label", self.LABEL + "=" + self.token, "--network", "none", "--cap-drop", "ALL",
            "--security-opt", "no-new-privileges:true", "--memory", "512m", "--pids-limit", "64",
            "--shm-size", "64m", self.image)
        self.owned()
        self.docker("start", self.container)

    def ready(self):
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            assert self.owned()["State"]["Running"], self.docker("logs", "--tail", "40", self.container, check=False).stderr
            if self.docker("exec", self.container, "timeout", "2", "xdpyinfo", check=False, timeout=5).returncode == 0:
                return
            time.sleep(0.1)
        raise AssertionError("Xorg readiness deadline")

    def verify(self):
        self.ready()
        log = self.docker("exec", self.container, "cat", "/tmp/Xorg.log")
        assert "BPANE_TEST_SOFTWARE_ONLY" in log and "BPANE_V3D_EGL_READY" not in log
        output = self.docker("exec", self.container, "timeout", "15", "bpane-display-probe", timeout=20)
        assert "getimage=passed mit_shm=passed present=passed" in output, output
        assert "live_window_resize=passed overlap_scroll=passed rejected_resize_unchanged=passed" in output, output
        assert not self.owned()["State"]["OOMKilled"]
        self.docker("stop", "--time", "5", self.container)
        if self.owned()["State"]["ExitCode"] != 0:
            logs = self.docker("logs", "--tail", "100", self.container, check=False)
            raise AssertionError("Unclean Xorg shutdown: " + (logs.stdout + logs.stderr)[-12000:])
        self.docker("start", self.container)
        self.ready()
        assert "current 1280 x 720" in self.docker("exec", self.container, "xrandr", "--query")
        return output

    def reject(self):
        code = self.docker("wait", self.container, timeout=15)
        assert code != "0"
        # Read stopped-container log without modifying it or a host path.
        log = self.docker("logs", self.container, check=False)
        assert "BPANE_GPU_INIT_FAILED" in log.stdout + log.stderr

    def close(self):
        if self.container:
            self.owned()
            self.docker("rm", "--force", self.container)


def main():
    if not __debug__:
        raise RuntimeError("Run without Python -O: this protocol oracle requires assertions")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--software-image", required=True)
    parser.add_argument("--gpu-image", required=True)
    args = parser.parse_args()
    for image, mode in ((args.software_image, "software"), (args.gpu_image, "reject")):
        check = DisplayCheck(image)
        try:
            check.start()
            if mode == "software":
                print(check.verify())
            else:
                check.reject()
        finally:
            check.close()
    print(json.dumps({"passed": True, "realXorgSoftwareFixture": True, "hardwareMissingFailsClosed": True,
                      "scope": "No DRM, Pi, browser profile or hardware performance qualification"}))


if __name__ == "__main__":
    main()
