"""Strict finite GPU-comparison diagnostic schema; no hardware or Docker access."""
import math
import statistics

VARIANTS = ("reference_cached", "branchless64", "reduce16", "reduce8", "pixel_atomic", "probe_first64", "probe_both64")


def summary(result):
    assert result["schema"] == 1 and result["mode"] == "immutable-pair-comparison"
    assert (result["metadataBytes"], result["warmup"], result["rounds"], result["pixelErrors"]) == (64, 3, 10, 0)
    assert len(result["cases"]) == 8
    cases, output = set(), []
    for case in result["cases"]:
        key = (case["width"], case["height"], case["scenario"])
        assert key[:2] in ((1280, 720), (1365, 767)) and type(key[2]) is int and 0 <= key[2] < 4
        assert key not in cases and case["maskErrors"] == 0
        cases.add(key)
        assert type(case["producerDrainMs"]) in (int, float) and math.isfinite(case["producerDrainMs"]) and case["producerDrainMs"] >= 0
        assert len(case["samples"]) == len(VARIANTS) * 10
        seen, values = set(), {variant: [] for variant in VARIANTS}
        for sample in case["samples"]:
            identity = (sample["variant"], sample["round"])
            assert identity[0] in VARIANTS and type(identity[1]) is int and 0 <= identity[1] < 10
            assert identity not in seen
            seen.add(identity)
            for field in ("setupMs", "submitMs", "waitMs", "totalMs"):
                assert type(sample[field]) in (int, float) and math.isfinite(sample[field]) and sample[field] >= 0
            assert abs(sample["setupMs"] + sample["submitMs"] + sample["waitMs"] - sample["totalMs"]) < 0.00001
            values[identity[0]].append(sample["totalMs"])
        output.append({"width": key[0], "height": key[1], "scenario": key[2],
                       "producerDrainMs": case["producerDrainMs"],
                       "variants": {name: {"medianMs": statistics.median(times), "maxMs": max(times)}
                                    for name, times in values.items()}})
    return output
