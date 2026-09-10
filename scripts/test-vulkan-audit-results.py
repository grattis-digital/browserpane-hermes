#!/usr/bin/env python3
"""Deterministic parser tests; no Docker, GPU, network or user browser."""
import copy
import unittest
from vulkan_audit_results import summary, STAGES, MODES, ENGINES


def fixture(counters=False):
    result = {"schema": 1, "mode": "vulkan-stack-audit", "software": False, "validation": False,
        "counters": counters, "warmup": 1, "rounds": 6, "intermediateReadbacks": 0,
        "timedOutputCopies": 0, "validationErrors": 0, "pixelErrors": 0,
        "clockReadMeanNs": {"monotonic": 50, "threadCpu": 200, "processCpu": 300}, "cases": []}
    for width, height in ((1280, 720), (1365, 767), (1920, 1080)):
        for scenario in range(5):
            case = {"width": width, "height": height, "scenario": scenario, "importMs": 1,
                    "prepareMs": 1, "pixelErrors": 0, "samples": []}
            for stage in STAGES:
                for mode in MODES:
                    for index in range(6):
                        ops = 1 if mode == "single" else 8
                        sample = {"stage": stage, "mode": mode, "round": index, "operations": ops,
                            "waits": 8 if mode == "serial8" else 1, "wallMs": ops * 2,
                            "threadCpuMs": .1, "processCpuMs": .2, "userCpuMs": .1, "systemCpuMs": .1,
                            "voluntarySwitches": 1, "involuntarySwitches": 0}
                        if counters:
                            sample["engines"] = {e: {"activeMs": 1 if e == "csd" else 0,
                                "jobs": ops if e == "csd" else 0} for e in ENGINES}
                        case["samples"].append(sample)
            result["cases"].append(case)
    return result


class AuditResultsTest(unittest.TestCase):
    def test_complete(self):
        for counters in (False, True):
            rows = summary(fixture(counters), counters=counters)
            self.assertEqual(len(rows), 15)
            self.assertEqual(rows[0]["variants"]["bare/batch8"]["wallMsPerOp"], 2)

    def test_mode_separation(self):
        for field, value in (("counters", True), ("software", True), ("validation", True),
                             ("pixelErrors", 1), ("timedOutputCopies", 1), ("intermediateReadbacks", 1)):
            with self.subTest(field=field), self.assertRaises(AssertionError):
                r = fixture(); r[field] = value; summary(r)

    def test_missing_duplicate(self):
        for mutate in (lambda r: r["cases"].pop(), lambda r: r["cases"][0]["samples"].pop(),
                       lambda r: r["cases"].__setitem__(1, copy.deepcopy(r["cases"][0])),
                       lambda r: r["cases"][0]["samples"].__setitem__(1, r["cases"][0]["samples"][0])):
            with self.assertRaises(AssertionError):
                r = fixture(); mutate(r); summary(r)

    def test_bad_sample(self):
        for field, value in (("round", True), ("wallMs", float("nan")), ("processCpuMs", -1),
                             ("threadCpuMs", float("inf")), ("waits", 8), ("operations", True),
                             ("voluntarySwitches", -1), ("stage", "unknown")):
            with self.subTest(field=field), self.assertRaises(AssertionError):
                r = fixture(); r["cases"][0]["samples"][0][field] = value; summary(r)

    def test_counter_completeness(self):
        for mutate in (lambda s: s.pop("engines"), lambda s: s["engines"].pop("cpu"),
                       lambda s: s["engines"]["csd"].__setitem__("jobs", 0),
                       lambda s: s["engines"]["csd"].__setitem__("activeMs", -1)):
            with self.assertRaises(AssertionError):
                r = fixture(True); mutate(r["cases"][0]["samples"][0]); summary(r, counters=True)

    def test_cpu_job_is_reported_not_hidden(self):
        r = fixture(True)
        for s in r["cases"][0]["samples"]:
            s["engines"]["cpu"] = {"activeMs": 2, "jobs": s["operations"]}
        rows = summary(r, counters=True)
        self.assertEqual(rows[0]["variants"]["bare/batch8"]["enginesPerOp"]["cpu"]["jobs"], 1)


if __name__ == "__main__":
    unittest.main()
