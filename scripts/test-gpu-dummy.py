#!/usr/bin/env python3
"""Ownership oracle tests: no Docker or hardware calls."""
import copy
import importlib.util
import json
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("gpu_dummy_check", Path(__file__).with_name("check-gpu-dummy.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class OwnershipTest(unittest.TestCase):
    def setUp(self):
        self.info = {"Id": "a" * 64, "Image": "sha256:" + "b" * 64,
            "Config": {"User": "10000:10000", "Labels": {module.DisplayCheck.LABEL: "fixture"}},
            "HostConfig": {"NetworkMode": "none", "PortBindings": {}, "Devices": [], "Privileged": False,
                "CapAdd": None, "CapDrop": ["ALL"], "SecurityOpt": ["no-new-privileges:true"]}, "Mounts": []}

    def check(self, info):
        check = object.__new__(module.DisplayCheck)
        check.container = self.info["Id"]
        check.image = self.info["Image"]
        check.token = "fixture"
        check.docker = lambda *args: json.dumps([info])
        return check.owned()

    def test_exact_owned_identity(self):
        self.assertEqual(self.check(self.info), self.info)

    def test_foreign_or_broadened_boundary_is_rejected(self):
        changes = [("Id", "c" * 64), ("Image", "sha256:" + "d" * 64),
            ("Mounts", [{"Source": "/not-a-fixture"}])]
        for key, value in changes:
            with self.subTest(key=key):
                invalid = copy.deepcopy(self.info)
                invalid[key] = value
                with self.assertRaises(AssertionError):
                    self.check(invalid)
        for key, value in [("NetworkMode", "host"), ("PortBindings", {"6000/tcp": []}),
            ("Devices", [{"PathOnHost": "/dev/dri/renderD128"}]), ("Privileged", True),
            ("CapAdd", ["SYS_ADMIN"]), ("CapDrop", []), ("SecurityOpt", [])]:
            with self.subTest(key=key):
                invalid = copy.deepcopy(self.info)
                invalid["HostConfig"][key] = value
                with self.assertRaises(AssertionError):
                    self.check(invalid)
        for key, value in [("User", "0"), ("Labels", {}), ("Labels", {module.DisplayCheck.LABEL: "foreign"})]:
            with self.subTest(key=key, value=value):
                invalid = copy.deepcopy(self.info)
                invalid["Config"][key] = value
                with self.assertRaises(AssertionError):
                    self.check(invalid)


if __name__ == "__main__":
    if not __debug__:
        raise RuntimeError("Run without Python -O")
    unittest.main()
