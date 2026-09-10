#!/usr/bin/env python3
"""No GPU, Docker, network, browser or model calls."""
import copy
import importlib.util
from pathlib import Path
import unittest
from vulkan_lease_results import summary

spec = importlib.util.spec_from_file_location("vulkan_pilot", Path(__file__).with_name("vulkan-lease-pilot.py"))
pilot_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pilot_module)


def fixture():
    result = {"schema": 1, "mode": "vulkan-lease-pipeline", "software": False, "validation": False,
        "warmup": 2, "rounds": 8, "inputOracleFirst": False, "intermediateReadbacks": 0, "validationErrors": 0, "pixelErrors": 0, "cases": []}
    for width, height in ((1280, 720), (1365, 767), (1920, 1080)):
        tiles = ((width + 63) // 64) * ((height + 63) // 64)
        for scenario in range(5):
            case = {"width": width, "height": height, "scenario": scenario, "importMs": 1,
                "prepareMs": 1, "pixelErrors": 0, "samples": [], "gles": []}
            for index in range(8):
                for variant in ("empty", "pipeline"):
                    commands = 0 if variant == "empty" or scenario == 0 else tiles if scenario in (2, 4) else 1
                    raw = 0 if scenario == 2 else commands
                    case["samples"].append({"variant": variant, "round": index,
                        "submitMs": .1, "waitMs": 1, "copyMs": .1, "totalMs": 1.2, "cpuMs": .2,
                        "outputBytes": 16 + 16 * commands + 16384 * raw, "commands": commands, "rawTiles": raw})
                for variant in ("reference_cached", "probe_first64"):
                    case["gles"].append({"variant": variant, "round": index, "totalMs": 2, "cpuMs": .1})
            result["cases"].append(case)
    return result


class ResultsTest(unittest.TestCase):
    def test_layout_gate(self):
        pilot_module.VulkanPilot.require_layout({"Config": {"Env": ["BPANE_GPU_LEASE_LAYOUT=uif"]}})
        for env in ([], ["BPANE_GPU_LEASE_LAYOUT=legacy"], ["BPANE_GPU_LEASE_LAYOUT=uif"] * 2):
            with self.subTest(env=env), self.assertRaises(AssertionError):
                pilot_module.VulkanPilot.require_layout({"Config": {"Env": env}})

    def test_bad_image_is_rejected_before_creation(self):
        pilot = object.__new__(pilot_module.VulkanPilot)
        pilot.image = "sha256:" + "a" * 64
        pilot.inspect = lambda *args: {"Config": {"Env": []}}
        pilot.create = lambda: self.fail("Incompatible image must not create a container")
        with self.assertRaises(AssertionError):
            pilot.run_vulkan(False)

    def test_complete(self):
        self.assertEqual(len(summary(fixture())), 15)

    def test_modes_fail_closed(self):
        for field, value in (("software", True), ("validation", True), ("intermediateReadbacks", 1),
                             ("inputOracleFirst", True),
                             ("pixelErrors", 1), ("validationErrors", 1)):
            with self.subTest(field=field), self.assertRaises(AssertionError):
                result = fixture(); result[field] = value; summary(result)

    def test_missing_duplicate_case_and_round(self):
        for mutate in (lambda r: r["cases"].pop(),
                       lambda r: r["cases"].__setitem__(1, copy.deepcopy(r["cases"][0])),
                       lambda r: r["cases"][0]["samples"].pop(),
                       lambda r: r["cases"][0]["samples"].__setitem__(2, r["cases"][0]["samples"][0]),
                       lambda r: r["cases"][0]["gles"].pop()):
            with self.assertRaises(AssertionError):
                result = fixture(); mutate(result); summary(result)

    def test_invalid_timings(self):
        for value in (-1, float("inf"), float("nan"), True):
            with self.subTest(value=value), self.assertRaises(AssertionError):
                result = fixture(); result["cases"][0]["samples"][0]["waitMs"] = value; summary(result)

    def test_bad_counts_and_sizes(self):
        for field, value in (("commands", 513), ("rawTiles", -1), ("outputBytes", 0),
                             ("round", True), ("totalMs", 99), ("variant", "unknown")):
            with self.subTest(field=field), self.assertRaises(AssertionError):
                result = fixture(); result["cases"][0]["samples"][0][field] = value; summary(result)


if __name__ == "__main__":
    unittest.main()
