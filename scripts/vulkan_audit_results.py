"""Stage attribution: distinguish completion latency, throughput and kernel job time."""
import statistics
from vulkan_lease_results import number

STAGES = ("empty", "bare", "classify", "compact", "full")
MODES = ("single", "serial8", "batch8")
ENGINES = ("bin", "render", "tfu", "csd", "cache_clean", "cpu")


def summary(result, *, software=False, validation=False, counters=False):
    assert result["schema"] == 1 and result["mode"] == "vulkan-stack-audit"
    assert result["software"] is software and result["validation"] is validation
    assert result["counters"] is counters and not (software and counters)
    assert result["warmup"] == 1 and result["rounds"] == 6
    assert result["intermediateReadbacks"] == result["timedOutputCopies"] == 0
    assert result["validationErrors"] == result["pixelErrors"] == 0
    assert set(result["clockReadMeanNs"]) == {"monotonic", "threadCpu", "processCpu"}
    for value in result["clockReadMeanNs"].values():
        number(value)
    expected = {(w, h, s) for w, h in ((1280, 720), (1365, 767), (1920, 1080)) for s in range(5)}
    seen, rows = set(), []
    assert len(result["cases"]) == len(expected)
    for case in result["cases"]:
        key = case["width"], case["height"], case["scenario"]
        assert all(type(value) is int for value in key)
        assert key in expected and key not in seen and case["pixelErrors"] == 0
        seen.add(key)
        number(case["importMs"]); number(case["prepareMs"])
        variants = {(stage, mode): [] for stage in STAGES for mode in MODES}
        unique = set()
        assert len(case["samples"]) == len(variants) * 6
        for sample in case["samples"]:
            stage, mode, index = sample["stage"], sample["mode"], sample["round"]
            assert (stage, mode) in variants and type(index) is int and 0 <= index < 6
            assert (stage, mode, index) not in unique
            unique.add((stage, mode, index))
            operations, waits = (1 if mode == "single" else 8), (8 if mode == "serial8" else 1)
            assert type(sample["operations"]) is int and sample["operations"] == operations
            assert type(sample["waits"]) is int and sample["waits"] == waits
            for field in ("wallMs", "threadCpuMs", "processCpuMs", "userCpuMs", "systemCpuMs"):
                number(sample[field])
            for field in ("voluntarySwitches", "involuntarySwitches"):
                assert type(sample[field]) is int and sample[field] >= 0
            assert ("engines" in sample) is counters
            if counters:
                assert set(sample["engines"]) == set(ENGINES)
                for engine in sample["engines"].values():
                    number(engine["activeMs"])
                    assert type(engine["jobs"]) is int and engine["jobs"] >= 0
                assert sample["engines"]["csd"]["jobs"] >= operations
                # CPU jobs are evidence, not an assertion: never hide a fallback
                # by rejecting the very diagnostic that discovers it.
            variants[stage, mode].append(sample)
        row = {"width": key[0], "height": key[1], "scenario": key[2], "variants": {}}
        for (stage, mode), samples in variants.items():
            assert len(samples) == 6
            output = {field + "PerOp": statistics.median(s[field] / s["operations"] for s in samples)
                      for field in ("wallMs", "threadCpuMs", "processCpuMs")}
            output["meaning"] = "completion latency" if mode == "single" else "amortized time; not frame latency"
            if counters:
                output["enginesPerOp"] = {engine: {
                    field: statistics.median(s["engines"][engine][field] / s["operations"] for s in samples)
                    for field in ("activeMs", "jobs")} for engine in ENGINES}
            row["variants"][stage + "/" + mode] = output
        rows.append(row)
    assert seen == expected
    return rows
