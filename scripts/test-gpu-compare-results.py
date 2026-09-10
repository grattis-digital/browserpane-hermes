#!/usr/bin/env python3
"""Finite comparison schema guards; no GPU, network or Docker access."""
import copy
import unittest
from gpu_compare_results import VARIANTS, summary


class CompareResultsTest(unittest.TestCase):
    def setUp(self):
        self.result = {"schema": 1, "mode": "immutable-pair-comparison", "metadataBytes": 64,
                       "warmup": 3, "rounds": 10, "pixelErrors": 0, "cases": []}
        for width, height in ((1280, 720), (1365, 767)):
            for scenario in range(4):
                self.result["cases"].append({"width": width, "height": height, "scenario": scenario,
                    "producerDrainMs": 1.0, "maskErrors": 0, "samples": [
                        {"variant": name, "round": iteration, "setupMs": 0.1, "submitMs": 0.2, "waitMs": 0.7, "totalMs": 1.0}
                        for name in VARIANTS for iteration in range(10)]})

    def test_complete_result(self):
        result = summary(self.result)
        self.assertEqual(len(result), 8)
        self.assertEqual(result[0]["variants"]["reference_cached"]["medianMs"], 1.0)

    def test_bad_measurement_or_identity(self):
        for key, value in (("variant", "unknown"), ("round", True), ("round", 10),
                           ("totalMs", float("nan")), ("waitMs", -1), ("setupMs", True), ("totalMs", 100)):
            invalid = copy.deepcopy(self.result)
            invalid["cases"][0]["samples"][0][key] = value
            with self.subTest(key=key, value=value), self.assertRaises(AssertionError):
                summary(invalid)

    def test_missing_duplicate_or_failed_case(self):
        for action in (lambda r: r["cases"].pop(),
                       lambda r: r["cases"][0]["samples"].pop(),
                       lambda r: r["cases"][0].update(maskErrors=1),
                       lambda r: r.update(pixelErrors=1),
                       lambda r: r["cases"].__setitem__(1, copy.deepcopy(r["cases"][0])),
                       lambda r: r["cases"][0]["samples"].__setitem__(1, copy.deepcopy(r["cases"][0]["samples"][0]))):
            invalid = copy.deepcopy(self.result)
            action(invalid)
            with self.assertRaises(AssertionError):
                summary(invalid)


if __name__ == "__main__":
    if not __debug__:
        raise RuntimeError("Run without Python -O")
    unittest.main()
