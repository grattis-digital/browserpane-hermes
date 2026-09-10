"""Parser failures are not successful hardware runs."""
import copy
import importlib.util
import json
import math
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("compact_pilot", Path(__file__).resolve().parents[1] /
                                             "scripts/gpu-compact-pilot.py")
pilot = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pilot)


def fixture():
    rows = []
    for width, height, frames in [(1279, 719, 4), (1280, 720, 32)]:
        tiles = math.ceil(width / 32) * math.ceil(height / 32)
        for scene in range(10):
            for frame in range(1, frames + 1):
                dirty = tiles if frame == 1 else 0
                rows.append(dict(width=width, height=height, scene=scene, frame=frame,
                    measured=width == 1280 and frame > 8, fullFirst=frame % 2 == 1,
                    dirtyTiles=dirty, moveTiles=0, readbackBytes=(3 * tiles + 1) * 4 + dirty * 4096,
                    fullNs=100, fullCpuNs=80, compactNs=50, compactCpuNs=10, metadataNs=40, payloadNs=10,
                    deduplicate=False, profileStages=False, stageQueryNs=[0, 0, 0, 0]))
    rows.append(dict(complete=True, scope="synthetic-gpu-content-index", pixelErrors=0))
    return rows


class SummaryTest(unittest.TestCase):
    def parse(self, rows, **modes):
        return pilot.summarize("\n".join(json.dumps(row) for row in rows), **modes)

    def test_complete(self):
        result = self.parse(fixture())
        self.assertEqual(result[0]["n"], 24)

    def test_truncated_missing_reordered(self):
        rows = fixture()
        for malformed in (rows[:-1], rows[1:], rows[::-1]):
            with self.assertRaises(AssertionError):
                self.parse(malformed)

    def test_invalid_metrics_and_success(self):
        for key, value in [("dirtyTiles", -1), ("readbackBytes", 0), ("compactNs", float("nan")),
                           ("fullNs", True), ("measured", True), ("moveTiles", 920)]:
            rows = fixture()
            rows[0][key] = value
            with self.subTest(key=key), self.assertRaises(AssertionError):
                self.parse(rows)
        rows = copy.deepcopy(fixture())
        rows[-1]["pixelErrors"] = 1
        with self.assertRaises(AssertionError):
            self.parse(rows)

    def test_profiling_and_candidate_cannot_be_mixed_with_controls(self):
        rows = fixture()
        for row in rows[:-1]:
            row.update(deduplicate=True, profileStages=True, stageQueryNs=[10, 20, 30, 40])
        with self.assertRaises(AssertionError):
            self.parse(rows)
        result = self.parse(rows, deduplicate=True, profile_stages=True)
        self.assertEqual(result[0]["stageQueryNs"]["verifyGather"]["median"], 40)
        for stages in ([0, 20, 30, 40], [10, 20], [10, 20, 30, True], [1_000_000_000, 1, 1, 1]):
            rows[0]["stageQueryNs"] = stages
            with self.assertRaises(AssertionError):
                self.parse(rows, deduplicate=True, profile_stages=True)


if __name__ == "__main__":
    unittest.main()
