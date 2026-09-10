# Removing the full-copy boundary: source research and component experiment

Status: experimental component research. The live custom Xorg/Vulkan integration
is described separately in [GPU live testing](GPU_LIVE_TEST.md).

## Why the copy boundary matters

A GPU-rendered browser can still feed a software-backed display server or a
CPU-readable capture API. Mapping a tiled image can require staging, conversion
and synchronization before the tile encoder ever sees it. GPU rendering being
enabled therefore does not prove a GPU-native capture path.

Mesa's V3D tiled-resource mapping can allocate staging storage and perform layout
conversion on read; linear resources take a different path. This is a mechanism
to investigate, not a measurement of every application's buffers.
[Mesa resource implementation](https://gitlab.freedesktop.org/mesa/mesa/-/blob/mesa-25.0.7/src/gallium/drivers/v3d/v3d_resource.c).

## What existing projects actually solve

| Project/path | Source-confirmed technique | Lesson and limitation for this fork |
| --- | --- | --- |
| GPU Screen Recorder, XComposite | Names an X11 window pixmap, imports it with `EGL_NATIVE_PIXMAP_KHR`, samples the resulting texture for GPU color conversion | Promising capture ingress for a GPU-backed X11 pixmap. It cannot remove a display server's software backing by itself. |
| GPU Screen Recorder, KMS | Imports plane DMA-BUFs with format, pitch, offsets and modifiers into EGL images | Avoid full CPU readback; handle all planes/modifiers. Physical scanout capture is not the same source as our headless virtual X11 output. |
| Sunshine, KMS GPU path | Passes GPU surface descriptors to compatible encoder paths instead of RAM image pixels | Preserve GPU ownership through consumers. Its separate RAM and X11 SHM paths show that the project's name alone is not a zero-copy guarantee. |
| xorgxrdp, EGL RemoteFX path | Computes 64×64 tile CRCs on GPU; reads the small CRC grid, then only changed tiles | Direct precedent for GPU-side damage refinement. Our design uses exact comparison and fused gathering instead of CRC-only omission and individual tile readbacks. |
| NeatVNC damage refinery | Narrows broad damage with CPU-side tile hashes | Useful damage/coalescing pattern, but not removal of CPU capture: this path maps pixel data first. |
| Windows Desktop Duplication | Provides a GPU surface plus dirty and move rectangles | Treat motion as explicit previous-frame reuse; apply moves from coherent history before dirty replacements. This is an established contract, not a Pi API. |

Primary sources inspected, pinned where repository source was cloned:

- [GPU Screen Recorder X11 texture](https://git.dec05eba.com/gpu-screen-recorder/tree/src/window_texture.c?id=c27160989c4c1b399a4a974dbacd7a04283b762f),
  [capture consumer](https://git.dec05eba.com/gpu-screen-recorder/tree/src/capture/xcomposite.c?id=c27160989c4c1b399a4a974dbacd7a04283b762f),
  [KMS](https://git.dec05eba.com/gpu-screen-recorder/tree/src/capture/kms.c?id=c27160989c4c1b399a4a974dbacd7a04283b762f).
- [Sunshine KMS](https://github.com/LizardByte/Sunshine/blob/019b1ba661d829e334706557a3e2bdc3d2374591/src/platform/linux/kmsgrab.cpp),
  [EGL import](https://github.com/LizardByte/Sunshine/blob/019b1ba661d829e334706557a3e2bdc3d2374591/src/platform/linux/graphics.cpp),
  [X11 capture](https://github.com/LizardByte/Sunshine/blob/019b1ba661d829e334706557a3e2bdc3d2374591/src/platform/linux/x11grab.cpp).
- [xorgxrdp GPU CRC and selective readback](https://github.com/neutrinolabs/xorgxrdp/blob/49bf2dd3546dc48b9d5bae62022762fde11793d0/module/rdpEgl.c).
- [NeatVNC CPU refinement](https://github.com/any1/neatvnc/blob/67c722dfb01076cc14faad1e62afb25be6afc2b8/src/damage-refinery.c),
  [per-buffer damage accumulation](https://github.com/any1/neatvnc/blob/67c722dfb01076cc14faad1e62afb25be6afc2b8/src/compositor.c).
- [Microsoft dirty/move/ownership contract](https://learn.microsoft.com/en-us/windows/win32/direct3ddxgi/desktop-dup-api).

No dependency source was copied into the implementation. No proprietary NVIDIA
capture interface, Wayland migration or video-only replacement is proposed.

## Experiment: exact GPU reduction and fused tile gathering

[Native implementation and measurement contract](../native/gpu-compact/README.md).
This is a Rust-owned finite test with a narrow C EGL/GL adapter and original GLSL.
It consumes GPU-resident current, previous and retained-checkpoint textures, not
a CPU screenshot uploaded back into the GPU. Fixture images are GPU-generated.

The revised prototype builds a compact GPU content index: sampled row
fingerprints for each 32-pixel column. At 720p fingerprints occupy 115,200 bytes;
the bounded hash lookup table adds 327,680 bytes, for 442,880 bytes per cached
frame (about 8.3× smaller than RGBA). Lookup checks at most eight buckets per
cache per tile, rather than scanning all 720 rows in each cache. Table clear and
bounded atomic insertion occur on GPU. Overflow loses a candidate, never pixel
correctness. It discovers a candidate location from content and verifies reuse.
Current index construction is measured; histories are retained rather than
rebuilt per frame. This is not driven by a supplied positive movement vector.

For each tile, compute exact pixel differences against two hypotheses:
stationary history and a region found in a cached frame. OR reduction
across **all** in-bounds pixels decides reuse. A candidate is never trusted on
the basis of a few matching samples. Dirty tiles reserve output slots and write
their pixel data in the same GPU dispatch. The CPU reads a small header and only
the occupied payload prefix. There is no CPU classification round trip before
gathering and no individual GPU fence per tile.

This separates **content lookup** from **proof of reuse**. Different regions can
choose different cached sources, so dynamic widgets need not invalidate the
surrounding scrolling page. Fingerprint collisions or ambiguous repeating
patterns can increase replacement traffic, but cannot certify an incorrect
reuse. Row positions are not snapped to the old tile grid. The small index
proposes candidates; only the exact verifier decides which pixels can be omitted.

The current search is vertical within each column, with previous/checkpoint
history. General 2-D atlas lookup, cache eviction and multiple candidate
verification are future work. A better source may be missed by the single
candidate rule; that conservatively emits dirty pixels. Independently moving,
rotated, fractional and genuinely new regions remain correct through replacement.
Unreferenced old content is retained only within the two bounded history slots;
no unbounded cache or client-side cache-generation protocol is implemented here.

It is not mathematically possible to guarantee every arbitrary pixel change was
detected by sampling only a proper subset of pixels without additional trusted
producer information: two frames can match all samples and differ elsewhere.
Statistics can prioritize work, not silently certify unchanged pixels. Trusted
damage regions can restrict exact comparison; unknown/broad damage needs the
conservative path. The experiment intentionally scans the whole GPU texture to
test the difficult broad-hint case while minimizing CPU readback.

## Raspberry Pi component results

The final packed-word, bounded-hash, 256-invocation variant passed two sequential
runs on V3D 4.2.14.0 / OpenGL ES 3.1 / Mesa 25.0.7. Each run reconstructed all
360 frames from ten scenarios at 1279×719 and 1280×720, with **zero pixel errors**.
The table gives separate run medians at 1280×720, after eight warmup frames and
24 measured paired frames per scenario. Ranges span the two run medians; they
are not confidence intervals. The full-readback baseline is 3,686,400 bytes.

| Scenario | Full readback median, ms | Indexed compact median, ms | Compact p95, ms | Compact readback, bytes (median) |
| --- | ---: | ---: | ---: | ---: |
| Unchanged | 13.59–16.05 | 21.13–21.77 | 23.68–23.93 | 11,044 |
| Sparse 24×24 update crossing tile boundaries | 14.33–14.59 | 21.27–21.63 | 23.30–24.22 | 27,428 |
| 31-pixel scrolling, fixed header | 14.02–14.64 | 22.91–24.65 | 25.62–26.02 | 502,564 |
| Genuine full-frame change | 13.66–14.90 | 32.61–33.70 | 37.69–39.87 | 3,779,364 |
| Last-pixel change | 15.07–15.08 | 21.49–21.50 | 23.50–26.14 | 15,140 |
| Intentionally wrong candidate | 13.50–14.62 | 32.94–33.79 | 35.67–35.74 | 3,615,524 |
| Scrolling with stationary overlay | 13.27–15.20 | 23.16–23.40 | 25.57–25.81 | 547,620 |
| Alternating forward scroll / cached return | 13.05–13.51 | 25.88–26.02 | 33.21–36.17 | 914,212 |
| Scrolling plus independently moving/changing widget | 15.29–15.33 | 23.46–24.21 | 25.33–26.94 | 551,716 |
| Colliding fingerprints with unsampled pixel changes | 14.97–15.03 | 32.00–32.95 | 37.54–38.09 | 3,615,524 |

Scrolling reduces CPU readback by **86.4%**; the independently changing widget
still permits approximately **85.0%** reduction. Across all 24 measured
cached-return frames, the result contains zero dirty tiles, 880 cached-region
reuses and only 11,044 metadata bytes. The remaining 40 tiles reuse stationary
history. This is a cache-reuse result, not full-frame recapture. The cached-return
subset always runs compact first because the fixture uses even frames for
returns; do not treat its timings as independently order-balanced. The combined
scenario's median above mixes forward and return behavior.

For scrolling, capture-thread CPU time drops from approximately 13 ms to 1.64 ms;
sparse updates use approximately 0.64–0.68 ms of capture-thread CPU. These are
not total-system CPU/energy measurements. Despite the CPU and readback savings,
the candidate loses the **component latency** comparison. Dense changes also
exceed full readback bytes because metadata and partial-tile padding remain.
No GPU payload compression, network transmission, client rendering or browser
workload is included in these numbers.

At scrolling, approximately 22–23 ms lies in the combined index/lookup/verify/
synchronization/header interval, with roughly 1 ms in payload mapping/copy.
The header is only 11 KB: this interval is **not 22 ms copying metadata**.
These CPU-observed spans do not separate GPU execution, queueing, driver work
and synchronization. Stage GPU timestamps, where supported and non-disjoint,
are needed for that attribution. Software-mirror measurements are not evidence for the custom Vulkan path.

### Rejected variants and diagnostic evidence

All entries below are single exploratory runs, not controlled multi-run effect
estimates. Their raw reports remain separate; unlike variants and diagnostic
runs are never pooled with the final two runs.

| Earlier variant | Idle / scrolling compact median, ms | Outcome |
| --- | ---: | --- |
| Supplied-vector, float image reads, 64 invocations | 42.3 / 46.3 | Correct reduction, but no content discovery and too slow |
| Sampled content index, linear historical scan, sampler reads, 64 invocations | 55.3 / 61.8 | Content/checkpoint reuse works; scanning historical rows adds work |
| Same scan index, packed R32UI image reads, 64 invocations | 44.3 / 50.7 | Less conversion overhead; still slower than full readback |
| Packed scan index, 16 invocations | 95.0 / 105.2 | Rejected: larger per-invocation work was much slower |
| Packed bounded hash index, 16 invocations | 85.5 / 94.8 | Bounded lookup helps this variant; still too slow |
| Final packed bounded hash index, 256 invocations | 21.1–21.8 / 22.9–24.7 | Substantial prototype improvement; latency gate still fails |

A separate Mesa `V3D_DEBUG=shaderdb` run of the packed scan-index/64-invocation
variant reported **zero register spills/fills** for every compiled shader.
Its lookup shader had 357 instructions and its compare/gather shader 771.
This rules out claiming observed register spills as that variant's cause; it
does not identify the dominant GPU stage, prove cache behavior, or describe the
final shaders' generated code. It was excluded from clean timings.

Four initial setup attempts failed before measurement: Docker log rotation
configuration, missing libepoxy in the minimal production display image, Mesa
DRM-node enumeration, and an unavailable GBM pbuffer configuration. These were
fixed only in the disposable harness/runtime selection. Each owned test
container was removed; failures were retained rather than counted as passing
hardware runs. The final runs used an existing experimental image, no CPU quota,
bounded memory, no network, no X11 connection and **zero browser tabs**. Original
service identities/start times/restart counters remained unchanged. Available
host memory stayed above 3.2 GiB and sampled temperatures below 55°C. Live
services remained active, so uncontrolled background load is a limitation.

Local qualification includes four Rust unit tests, strict Clippy/rustdoc,
formatting checks, 160 software-GPU pixel-oracle frames and three harness-parser
tests. Normal tests never access the Pi. Raw host/service identities and reports
are kept privately, not committed. No production rollout or remote publication
was performed.

### Next component step

Keep content identity separate from placement and use an adaptive regional
strategy, rather than merely adding a bigger motion search:

1. Attribute index construction, lookup and exact verification separately
   without adding synchronous CPU readback between stages. Track bounded-index
   misses/overflow and useful reuse, not just nominal GPU activity.
2. Avoid redundant verification of identical candidate/stationary sources;
   investigate fusing current signatures with stationary comparison. Use
   reliable producer damage and unchanged-region history to restrict work when
   available. Sparse sampling alone cannot authorize skipping unseen changes.
3. Subdivide mixed tiles around dynamic widgets, and coalesce verified adjacent
   reuse into rectangles. Extend to a bounded 2-D content atlas only after this
   smaller experiment beats its cost gate; eviction and placement updates are
   separate operations. Leaving the viewport need not immediately evict content.
4. Choose a conservative replacement path for dense or poor-match regions.
   Do not pay an expensive GPU search merely to discover that nearly every tile
   requires replacement. Validate the selector's total cost and correctness.

Those steps are proposals, not implemented production behavior. The present
experiment proves safe content-based reuse and low readback, **not that a small
index automatically makes frame analysis cheap enough on V3D**.

## Integration gates, in priority order

1. Lower the measured component cost on V3D, including dense and wrong-vector
   cases, before adding display-server hooks. The current latency gate fails;
   reduced bytes alone do not prove lower latency.
2. Acquire a stable GPU-backed X11 root/window frame from the experimental glamor
   DDX. Keep stock Chromium. Prefer a scoped capture hook or XComposite/DRI3 path
   over physical KMS access. Do not add another full software mirror on import.
3. Qualify producer completion, buffer lifetime and immutable history. A DMA-BUF
   FD is not a completed immutable frame. Use explicit generations, resize and
   reconnect invalidation, bounded leases/fences and backpressure. If a producer
   cannot retain a frame, an explicit GPU snapshot may still be necessary.
4. Join compact dirty tiles and verified moves to existing tile-cache semantics;
   keep lossless text, cache identity/acknowledgment, scroll overlap handling and
   framebuffer recovery. Do not flatten the payload back into a full CPU frame
   merely to feed the old capture interface.
5. Benchmark the **whole browser stack**, one disposable tab, against the clean
   CPU baseline with full-frame correctness oracles. GPU rendering, capture,
   tile encode, wire bytes and viewer presentation need separate attribution.

GPU video encoding remains appropriate for identified high-motion regions if
that existing branch wins on this hardware. Gaming video benchmarks do not prove
lossless UI sharpness, tile-cache behavior or V3D encoder support for this bundle.
