#!/usr/bin/env python3
"""Pi pilot boundary and result-oracle tests; no Docker, network or hardware."""
import copy
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("gpu_dummy_pilot", Path(__file__).with_name("gpu-dummy-pilot.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class PilotTest(unittest.TestCase):
    def setUp(self):
        self.pilot = object.__new__(module.DisplayPilot)
        self.pilot.container = "a" * 64
        self.pilot.image = "sha256:" + "b" * 64
        self.pilot.token = "test-only"
        self.pilot.lease = False
        self.pilot.render, self.pilot.group = "/dev/dri/renderD129", "777"
        self.info = {"Id": self.pilot.container, "Image": self.pilot.image,
            "Config": {"User": "10000:10000", "Labels": {module.DisplayPilot.LABEL: self.pilot.token}},
            "HostConfig": {"ReadonlyRootfs": True, "NetworkMode": "none", "PortBindings": {},
                "Privileged": False, "CapAdd": None, "CapDrop": ["ALL"],
                "SecurityOpt": ["no-new-privileges:true"], "RestartPolicy": {"Name": "no"},
                "Memory": 512 * 1024 * 1024, "PidsLimit": 128, "CpuShares": 128,
                "ShmSize": 128 * 1024 * 1024, "Tmpfs": {"/tmp": "size=128m,mode=1777,nosuid,nodev"},
                "PidMode": "", "IpcMode": "private", "GroupAdd": ["777"],
                "Devices": [{"PathOnHost": self.pilot.render, "PathInContainer": "/dev/bpane-render", "CgroupPermissions": "rw"}]},
            "Mounts": [{"Type": "bind", "Source": "/dev/dri", "Destination": "/dev/dri", "RW": False}]}
        self.pilot.inspect = lambda *_: self.info

    def test_exact_identity_and_boundary(self):
        self.assertEqual(self.pilot.owned(), self.info)

    def test_capture_opt_in_is_exact(self):
        self.info["Config"]["Env"] = ["BPANE_GPU_LEASE=1"]
        with self.assertRaises(AssertionError):
            self.pilot.owned()
        self.pilot.lease = True
        self.pilot.owned()
        self.info["Config"]["Env"] = ["BPANE_GPU_LEASE=0"]
        with self.assertRaises(AssertionError):
            self.pilot.owned()

    def test_foreign_identity(self):
        for path, value in [("Id", "c" * 64), ("Image", "sha256:" + "d" * 64),
                            ("Config", {"User": "0", "Labels": {}})]:
            with self.subTest(path=path):
                original = self.info
                self.info = copy.deepcopy(original)
                self.info[path] = value
                with self.assertRaises(AssertionError):
                    self.pilot.owned()
                self.info = original

    def test_broadened_host_boundary(self):
        for key, value in [("ReadonlyRootfs", False), ("NetworkMode", "host"), ("PortBindings", {"6000/tcp": []}),
                           ("Privileged", True), ("CapAdd", ["SYS_ADMIN"]), ("CapDrop", []), ("SecurityOpt", []),
                           ("RestartPolicy", {"Name": "always"}), ("Memory", 0), ("PidsLimit", -1),
                           ("CpuShares", 1024), ("ShmSize", 1024), ("Tmpfs", {"/profile": "rw"}),
                           ("PidMode", "host"), ("IpcMode", "host"), ("GroupAdd", ["777", "44"]),
                           ("Devices", [{"PathOnHost": "/dev/dri/card0"}])]:
            with self.subTest(key=key):
                original = self.info["HostConfig"][key]
                self.info["HostConfig"][key] = value
                with self.assertRaises(AssertionError):
                    self.pilot.owned()
                self.info["HostConfig"][key] = original

    def test_mount_changes(self):
        for change in [{"RW": True}, {"Source": "/private"}, {"Destination": "/profile"}, {"Type": "volume"}]:
            with self.subTest(change=change):
                original = self.info["Mounts"]
                self.info["Mounts"] = [{**original[0], **change}]
                with self.assertRaises(AssertionError):
                    self.pilot.owned()
                self.info["Mounts"] = original
        self.info["Mounts"].append({"Type": "bind", "Source": "/profile"})
        with self.assertRaises(AssertionError):
            self.pilot.owned()


class DamageTest(unittest.TestCase):
    def setUp(self):
        self.result = {"width": 1280, "height": 720, "swapInterval": 0, "submitted": [32, 96, 24, 24], "renderer": "V3D 4.2",
                       "samples": [{"mode": "swap" if i < 3 else "swapWithDamage", "rectangles": 1,
                                    "observedBounds": [0, 0, 1280, 720] if i < 3 else [32, 96, 24, 24],
                                    "pixelErrors": 0} for i in range(6)]}

    def test_selective_and_nonselective_are_valid_measurements(self):
        self.assertTrue(module.damage_summary(self.result)["selectivityObserved"])
        for sample in self.result["samples"]:
            sample["observedBounds"] = [0, 0, 1280, 720]
        self.assertFalse(module.damage_summary(self.result)["selectivityObserved"])

    def test_missing_stale_outside_or_invalid_metadata_fails(self):
        for key, value in [("mode", "unknown"), ("rectangles", 0), ("rectangles", True), ("pixelErrors", 1),
                           ("observedBounds", [32, 96, 12, 24]), ("observedBounds", [-1, 0, 1281, 720]),
                           ("observedBounds", [0, 0, 1281, 720]), ("observedBounds", [32, 96, 24.0, 24])]:
            invalid = copy.deepcopy(self.result)
            invalid["samples"][0][key] = value
            with self.subTest(key=key, value=value), self.assertRaises(AssertionError):
                module.damage_summary(invalid)
        self.result["samples"].pop()
        with self.assertRaises(AssertionError):
            module.damage_summary(self.result)


class BenchmarkTest(unittest.TestCase):
    def setUp(self):
        self.result = {"width": 1280, "height": 720, "warmup": 10, "swapInterval": 0, "pixelErrors": 0,
                       "samples": [{"drawMs": 2.0, "swapCaptureMs": 5.0, "readMs": 4.0, "reads": 1} for _ in range(60)]}

    def test_summary(self):
        summary = module.benchmark_summary(self.result)
        self.assertEqual(summary["totalMs"], {"median": 7.0, "p95": 7.0})
        self.assertEqual(summary["reads"], 60)

    def test_incomplete_or_wrong_workload(self):
        for key, value in [("width", 640), ("height", 480), ("swapInterval", 1), ("warmup", 0),
                           ("pixelErrors", 1), ("samples", self.result["samples"][:-1])]:
            with self.subTest(key=key):
                invalid = {**self.result, key: value}
                with self.assertRaises(AssertionError):
                    module.benchmark_summary(invalid)


    def test_invalid_measurements(self):
        for key, value in [("drawMs", float("nan")), ("swapCaptureMs", float("inf")), ("drawMs", -1),
                           ("drawMs", True), ("readMs", 20), ("reads", 0), ("reads", 1.5)]:
            with self.subTest(key=key, value=value):
                invalid = copy.deepcopy(self.result)
                invalid["samples"][0][key] = value
                with self.assertRaises(AssertionError):
                    module.benchmark_summary(invalid)


class LeaseTest(unittest.TestCase):
    def setUp(self):
        self.result = {"width": 1280, "height": 720, "metadataBytes": 64, "pixelErrors": 0, "scrollFrames": 12,
                       **{key: "passed" for key in ("negativeRequests", "backpressure", "immutableLease", "resize", "disconnect", "scrollConsistency")},
                       "samples": [{"acquireMs": 1.0, "importMs": 0.5, "dispatchMs": 0.2,
                                    "metadataWaitMs": 2.0, "compareMs": 2.2, "gpuCopyPixels": 4096} for _ in range(16)]}

    def test_complete(self):
        self.assertEqual(module.lease_summary(self.result)["compareMs"]["median"], 2.2)

    def test_incomplete_or_failure(self):
        for key, value in [("samples", []), ("metadataBytes", 128), ("pixelErrors", 1), ("resize", "failed")]:
            with self.subTest(key=key), self.assertRaises(AssertionError):
                module.lease_summary({**self.result, key: value})

    def test_invalid_timing_or_copy(self):
        for key, value in [("compareMs", float("nan")), ("acquireMs", -1), ("importMs", True),
                           ("gpuCopyPixels", 1280 * 720), ("compareMs", 100)]:
            invalid = copy.deepcopy(self.result)
            invalid["samples"][0][key] = value
            with self.subTest(key=key), self.assertRaises(AssertionError):
                module.lease_summary(invalid)

if __name__ == "__main__":
    if not __debug__:
        raise RuntimeError("Run without Python -O")
    unittest.main()
