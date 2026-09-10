#!/usr/bin/env python3
"""Deterministic evidence parser tests: no GPU, network, Docker or browser."""
import unittest
from vulkan_tail_results import summary, STEPS, DIMENSIONS


def fixture():
    result = {"schema": 1, "mode": "vulkan-gpu-tail", "software": False, "validation": False,
        "intermediateReadbacks": 0, "senderRawPixelCopies": 0, "validationErrors": 0, "pixelErrors": 0,
        "accepted": 57, "dropped": 3, "cacheMisses": 3, "steps": []}
    for width, height in DIMENSIONS:
        tiles = ((width + 63) // 64) * ((height + 63) // 64)
        for name, scenario, flags, action in STEPS:
            reset = name in ("cold", "cache-recovery", "reconnect")
            unchanged = name in ("unchanged", "scroll-unchanged", "solid-unchanged")
            refs = int(name in ("tile-copy", "cache-miss"))
            fills = tiles if name == "solid" else int(name == "solid-repair")
            qoi = tiles if reset else 0 if refs or unchanged or fills else 1
            scroll = 13 if name == "scroll" else 0
            step = dict(width=width, height=height, name=name, scenario=scenario, flags=flags, action=action,
                serial=len(result["steps"])+1, pixelErrors=0, skipped=tiles-refs-qoi-fills, fills=fills, refs=refs, qoi=qoi,
                scroll=scroll, outputBytes=10+16*reset+16*bool(scroll)+18*refs+200*qoi+14*fills,
                prepareMs=1, recordMs=.1, completionMs=3, cpuMs=.2, transportMs=0, decodeMs=0)
            result["steps"].append(step)
    return result


class TailResultsTest(unittest.TestCase):
    def test_complete(self):
        self.assertEqual(len(summary(fixture())), 63)

    def test_wrong_mode_or_incomplete(self):
        for key, value in (("software", True), ("validation", True), ("pixelErrors", 1), ("accepted", 50),
                           ("senderRawPixelCopies", 1), ("intermediateReadbacks", 1), ("cacheMisses", 0)):
            with self.subTest(key=key), self.assertRaises(AssertionError):
                result = fixture(); result[key] = value; summary(result)
        result = fixture(); result["steps"].pop()
        with self.assertRaises(AssertionError):
            summary(result)

    def test_invalid_sample(self):
        for key, value in (("serial", True), ("serial", 2), ("outputBytes", 99999999), ("width", 1),
                           ("cpuMs", float("nan")), ("recordMs", -1), ("skipped", 1), ("scroll", 65),
                           ("scroll", 1), ("refs", True), ("qoi", -1), ("scenario", 9)):
            with self.subTest(key=key), self.assertRaises(AssertionError):
                result = fixture(); result["steps"][0][key] = value; summary(result)

    def test_reordered_or_nonfunctional_cases(self):
        for index, key, value in ((1, "outputBytes", 11), (2, "refs", 0), (4, "scroll", 0),
                                 (10, "decodeMs", .1), (15, "scroll", 1)):
            with self.assertRaises(AssertionError):
                result = fixture(); result["steps"][index][key] = value; summary(result)
        result = fixture(); result["steps"][1], result["steps"][2] = result["steps"][2], result["steps"][1]
        with self.assertRaises(AssertionError):
            summary(result)


if __name__ == "__main__":
    unittest.main()
