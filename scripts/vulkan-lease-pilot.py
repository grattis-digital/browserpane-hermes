#!/usr/bin/env python3
"""Opt-in Vulkan pipeline test in a fresh owned container; never a live browser."""
import argparse
import importlib.util
import json
from pathlib import Path
import signal
import subprocess
from vulkan_lease_results import summary
from vulkan_audit_results import summary as audit_summary
from vulkan_tail_results import summary as tail_summary

spec = importlib.util.spec_from_file_location("gpu_dummy_pilot", Path(__file__).with_name("gpu-dummy-pilot.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class VulkanPilot(module.DisplayPilot):
    @staticmethod
    def require_layout(item):
        layouts = [value for value in item["Config"].get("Env", []) if value.startswith("BPANE_GPU_LEASE_LAYOUT=")]
        assert layouts == ["BPANE_GPU_LEASE_LAYOUT=uif"]

    def owned(self):
        item = super().owned()
        self.require_layout(item)
        return item

    def run_vulkan(self, validation, inspect_inputs=False, audit=False, counters=False, tail=False):
        assert not (audit and inspect_inputs)
        assert not (tail and (audit or inspect_inputs))
        assert not counters or audit
        # Reject an incompatible image before creating any owned container.
        self.require_layout(self.inspect("image", self.image))
        self.create()
        self.ready()
        self.report["packages"] = self.docker("exec", self.container, "dpkg-query", "-W",
            "libgl1-mesa-dri", "libegl-mesa0", "mesa-vulkan-drivers", "libvulkan1", "xserver-xorg-core")
        self.probe("bpane-display-probe", "rejected_resize_unchanged=passed")
        self.probe("bpane-egl-probe", "v3d_x11_egl_swap_pixels=passed")
        self.owned()
        self.report["vulkanHostBefore"] = self.pressure()
        deadline = 180 if audit or tail else 90
        result = self.docker("exec", "--env=BPANE_GPU_VULKAN_PILOT=1", self.container,
            "timeout", str(deadline), "bpane-vulkan-probe", *(["--validate"] if validation else []),
            *(["--inspect-inputs"] if inspect_inputs else []),
            *(["--audit-counters" if counters else "--audit"] if audit else []),
            *(["--tail-export" if validation else "--tail"] if tail else []),
            timeout=deadline+5, check=False)
        self.report["consumerLog"] = result.stderr[-60000:]
        self.report["consumerExit"] = result.returncode
        if result.returncode:
            self.report["partialOutput"] = result.stdout[-10000:]
            raise RuntimeError("Vulkan gate failed: " + result.stderr[-6000:])
        self.report["vulkan"] = json.loads(result.stdout)
        self.report["summary"] = (tail_summary(self.report["vulkan"], validation=validation) if tail else
            audit_summary(self.report["vulkan"], validation=validation, counters=counters) if audit else
            summary(self.report["vulkan"], validation=validation, inspect_inputs=inspect_inputs))
        self.report["vulkanHostAfter"] = self.pressure()
        assert not self.owned()["State"]["OOMKilled"]
        if tail and validation:
            self.report["wireFile"] = "tail-wire-" + self.token + ".bin"
            # Docker's archive API cannot reliably see files on this tmpfs.
            # Read only our bounded synthetic export via the owned mount namespace.
            self.owned()
            with (self.output / self.report["wireFile"]).open("xb") as destination:
                exported = subprocess.run(["docker", "exec", self.container, "cat", "/tmp/bpane-gpu-tail.wire"],
                    stdout=destination, stderr=subprocess.PIPE, timeout=15, check=True)
                assert not exported.stderr and 0 < destination.tell() <= 32 * 1024 * 1024
        # Confirm the disposable display remains usable and stops cleanly.
        self.probe("bpane-display-probe", "rejected_resize_unchanged=passed")
        self.docker("stop", "--time=5", self.container)
        assert self.owned()["State"]["ExitCode"] == 0
        self.report["passed"] = True
        print(json.dumps({"summary": {"cases": len(self.report["summary"]), "audit": True, "counters": counters}
            if audit else self.report["summary"], "validation": validation, "inputOracleFirst": inspect_inputs}), flush=True)


def main():
    if not __debug__:
        raise RuntimeError("Qualification assertions must remain enabled")
    parser = argparse.ArgumentParser(description=__doc__)
    for option in ("image", "render", "render-gid", "output-dir"):
        parser.add_argument("--" + option, required=True)
    parser.add_argument("--validate", action="store_true", help="Separate diagnostic run; not clean timing")
    parser.add_argument("--inspect-inputs", action="store_true", help="Intrusive source-pixel diagnostic; not clean timing")
    parser.add_argument("--audit", action="store_true", help="Stage/serial/batch audit; no browser or timed output copies")
    parser.add_argument("--audit-counters", action="store_true", help="Separate audit with own-client DRM engine/job counters")
    parser.add_argument("--tail", action="store_true", help="GPU cache/QOI/wire state machine; no live browser")
    args = parser.parse_args()
    pilot = VulkanPilot(args.image, args.render, args.render_gid, args.output_dir, lease=True)
    def interrupted(signum, frame):
        raise RuntimeError("Vulkan pilot interrupted")
    signal.signal(signal.SIGTERM, interrupted)
    try:
        pilot.run_vulkan(args.validate, args.inspect_inputs, args.audit or args.audit_counters, args.audit_counters, args.tail)
    except Exception as error:
        pilot.report["error"] = str(error)[-6000:]
        raise
    finally:
        pilot.finish()
    print(json.dumps({"passed": pilot.report["passed"], "token": pilot.token,
        "originalServicesUnchanged": pilot.report["originalServicesUnchanged"]}))


if __name__ == "__main__":
    main()
