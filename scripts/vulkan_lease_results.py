"""Strict parser for finite Vulkan component evidence; never a browser FPS claim."""
import math
import statistics


def number(value):
    assert type(value) in (int, float) and math.isfinite(value) and value >= 0
    return value


def summary(result, *, software=False, validation=False, inspect_inputs=False):
    assert result["schema"] == 1 and result["mode"] == "vulkan-lease-pipeline"
    assert result["software"] is software and result["validation"] is validation
    assert result["inputOracleFirst"] is inspect_inputs
    assert result["warmup"] == 2 and result["rounds"] == 8
    assert result["intermediateReadbacks"] == result["validationErrors"] == result["pixelErrors"] == 0
    expected = {(w, h, s) for w, h in ((1280, 720), (1365, 767), (1920, 1080)) for s in range(5)}
    seen, output = set(), []
    assert len(result["cases"]) == len(expected)
    for case in result["cases"]:
        key = (case["width"], case["height"], case["scenario"])
        assert key in expected and key not in seen and case["pixelErrors"] == 0
        seen.add(key)
        number(case["importMs"]); number(case["prepareMs"])
        tiles = ((key[0] + 63) // 64) * ((key[1] + 63) // 64)
        rounds, values = set(), {variant: [] for variant in ("empty", "pipeline")}
        assert len(case["samples"]) == 16
        for sample in case["samples"]:
            variant, index = sample["variant"], sample["round"]
            assert variant in values and type(index) is int and 0 <= index < 8
            assert (variant, index) not in rounds
            rounds.add((variant, index))
            for field in ("submitMs", "waitMs", "copyMs", "totalMs", "cpuMs"):
                number(sample[field])
            assert abs(sum(sample[field] for field in ("submitMs", "waitMs", "copyMs")) - sample["totalMs"]) < 0.00001
            commands, raw = sample["commands"], sample["rawTiles"]
            assert type(commands) is int and type(raw) is int and 0 <= raw <= commands <= tiles
            assert type(sample["outputBytes"]) is int and sample["outputBytes"] == 16 + 16 * commands + 16384 * raw
            if variant == "empty" or key[2] == 0:
                assert commands == raw == 0
            elif key[2] in (1, 3):
                assert commands == raw == 1
            elif key[2] == 2:
                assert commands == tiles and raw == 0
            values[variant].append(sample)
        row = {"width": key[0], "height": key[1], "scenario": key[2], "variants": {}}
        for variant, samples in values.items():
            assert len(samples) == 8
            row["variants"][variant] = {
                field: statistics.median(sample[field] for sample in samples)
                for field in ("totalMs", "cpuMs", "waitMs", "copyMs", "outputBytes")}
        if not software:
            assert len(case["gles"]) == 16
            seen_gl, gl_values = set(), {"reference_cached": [], "probe_first64": []}
            for sample in case["gles"]:
                variant, index = sample["variant"], sample["round"]
                assert variant in gl_values and type(index) is int and 0 <= index < 8
                assert (variant, index) not in seen_gl
                seen_gl.add((variant, index))
                number(sample["totalMs"]); number(sample["cpuMs"])
                gl_values[variant].append(sample["totalMs"])
            row["glesMaskOnlyMs"] = {variant: statistics.median(times) for variant, times in gl_values.items()}
        output.append(row)
    assert seen == expected
    return output
