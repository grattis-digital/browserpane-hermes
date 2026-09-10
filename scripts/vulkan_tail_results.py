"""Strict evidence validation for the GPU-resident cache/encode experiment."""
from vulkan_lease_results import number

STEPS = (
    ("cold", 0, 0, 0), ("unchanged", 0, 0, 0), ("tile-copy", 5, 0, 0), ("restore", 0, 0, 0),
    ("scroll", 4, 0, 0), ("scroll-unchanged", 4, 0, 0), ("noise", 6, 0, 0), ("gradient", 7, 0, 0),
    ("collision-restore", 0, 4, 0), ("collision-last-pixel", 3, 4, 0),
    ("dropped", 1, 0, 1), ("after-drop", 1, 0, 0), ("before-eviction", 0, 0, 0),
    ("cache-miss", 5, 0, 2), ("cache-recovery", 5, 0, 0), ("motion-disabled", 0, 8, 0),
    ("solid", 2, 0, 0), ("solid-unchanged", 2, 0, 0),
    ("solid-last-pixel", 8, 0, 0), ("solid-repair", 2, 0, 0), ("reconnect", 0, 0, 3),
)
DIMENSIONS = ((1280, 720), (1365, 767), (1920, 1080))


def summary(result, *, software=False, validation=False):
    assert result["schema"] == 1 and result["mode"] == "vulkan-gpu-tail"
    assert result["software"] is software and result["validation"] is validation
    assert result["intermediateReadbacks"] == result["senderRawPixelCopies"] == 0
    assert result["validationErrors"] == result["pixelErrors"] == 0
    assert (result["accepted"], result["dropped"], result["cacheMisses"]) == (57, 3, 3)
    assert len(result["steps"]) == len(STEPS) * len(DIMENSIONS)
    output = []
    for index, step in enumerate(result["steps"]):
        width, height = DIMENSIONS[index // len(STEPS)]
        expected = STEPS[index % len(STEPS)]
        assert (step["width"], step["height"]) == (width, height)
        assert tuple(step[key] for key in ("name", "scenario", "flags", "action")) == expected
        assert type(step["serial"]) is int and step["serial"] == index + 1
        assert step["pixelErrors"] == 0
        for key in ("prepareMs", "recordMs", "completionMs", "cpuMs", "transportMs", "decodeMs"):
            number(step[key])
        tiles = ((width + 63) // 64) * ((height + 63) // 64)
        for key in ("skipped", "fills", "refs", "qoi", "outputBytes"):
            assert type(step[key]) is int and step[key] >= 0
        assert sum(step[key] for key in ("skipped", "fills", "refs", "qoi")) == tiles
        assert type(step["scroll"]) is int and -64 <= step["scroll"] <= 64
        reset = step["name"] in ("cold", "cache-recovery", "reconnect")
        if reset:
            assert step["skipped"] == step["refs"] == step["scroll"] == 0
        overhead = 10 + 16 * reset + 16 * bool(step["scroll"]) + 14 * step["fills"] + 18 * step["refs"]
        assert overhead + 45 * step["qoi"] <= step["outputBytes"] <= overhead + 16428 * step["qoi"]
        if step["name"] in ("unchanged", "scroll-unchanged", "solid-unchanged"):
            assert step["outputBytes"] == 10 and step["skipped"] == tiles
        if step["name"] in ("tile-copy", "cache-miss"):
            assert step["refs"] >= 1
        if step["name"] == "solid":
            assert step["fills"] == tiles and step["qoi"] == 0
        if step["name"] == "solid-last-pixel":
            assert step["qoi"] == 1 and step["fills"] == step["refs"] == 0
        if step["name"] == "solid-repair":
            assert step["fills"] == 1 and step["qoi"] == 0 and step["outputBytes"] == 24
        if step["name"] == "scroll":
            assert step["scroll"] and step["skipped"] > step["qoi"]
        if step["flags"] & 8:
            assert step["scroll"] == 0
        if step["action"] == 1:
            assert step["transportMs"] == step["decodeMs"] == 0
        output.append({key: step[key] for key in ("width", "height", "name", "outputBytes", "skipped", "refs",
            "qoi", "scroll", "completionMs", "cpuMs", "recordMs", "transportMs", "decodeMs")})
    return output
