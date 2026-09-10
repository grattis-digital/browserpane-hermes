# Damage-directed analysis and conservative regions of interest

Local experimental follow-up to [regional readback](DAMAGE_SCROLL_EXPERIMENT.md),
Neither production defaults nor the tile/cache/video protocol
change. This is not a new framebuffer-streaming baseline or a live deployment.

## Approximate area does not have to mean inaccurate pixels

An oversized rectangle around a real change is useful: read a little extra,
retain sharp lossless pixels, and avoid work on the rest of the image. Patch 0023
already admits a small trustworthy XDamage bounding rectangle. Its one-eighth
area limit also accounts conservatively for repairing two rotating CPU buffers;
smaller X11 requests alone are not a guarantee of fewer total copies.

Predicting a region from pointer position, recent changes or focused controls is
different. A tooltip, network result or notification can change somewhere else.
Such hints may prioritize work but cannot certify unchanged pixels. An optional
predictive policy should have a bounded rolling audit, forced recovery on resize,
navigation, video transitions and scroll, and maximum-staleness telemetry. Audits
must run even after the last input/damage event. Do not claim that sparse sampled
pixels prove every unsampled pixel stayed unchanged.

This increment does **not** enable guessed capture regions or intentionally stale
pixels. It first removes proven unnecessary analysis and measures why the current
GPU backend prevents trustworthy narrow readback. Wheel/scrollbar grid policy,
codecs and content-cache identity remain unchanged.

## Patch 0025: less classifier work, explicit damage decisions

`BPANE_EXPERIMENTAL_DAMAGE_ANALYSIS=1` is an independent, default-off host flag.
Set it in the browser service environment in a private experimental override;
setting an arbitrary variable in `.env` alone does not forward it to the service.

- Without a video-region hint **and** without video tile bounds, omit classifier
  hashes. This does not disable video or bypass lossless tile emission, whose
  hashes/cache are independent. Score decay, classification and latch cleanup
  still run through the original logic.
- When a hint returns, derive invalid classifier baselines lazily from the retained
  previous image. The first new motion is still detected; it is not silently
  treated as an unchanged initialization frame. Count these previous-image hashes
  separately so the returning-hint cost is visible.
- After a successful regional capture, reuse classifier hashes for tiles wholly
  outside that region. The reconstructed current image is known equal to the
  previous image there. Never apply this shortcut to a full read merely because
  its earlier damage bounds were small: newer pixels may have arrived after
  acknowledgement. Unknown history, missing hashes and geometry changes retain
  conservative behavior.

With `BPANE_CAPTURE_TIMINGS=1`, logs now report admission reasons, raw damage area,
event count, damage geometry, and current/previous/reused/inactive classifier tile
counts. Readback reasons distinguish disabled, forced, missing history, unknown,
invalid and broad damage. Damage reasons distinguish absent support, invalidation,
empty bounds, acknowledgement failure and geometry mismatch. These are bounded
test-run observations, not GPU timers, production telemetry or an input/frame join.

The harness's optional JSON boolean `damageAnalysis` passes this flag. Existing
`damageReadback` and `captureTimings` remain independent. Matching patched images
are required for the new diagnostic parser; missing/mixed metrics fail rather
than appearing as zero work. Normal tests never add site-pacing delays.

## Patch 0026: retain the final pointer movement

The first full-viewer run exposed a separate throttle defect: a short native-thumb
drag could lose its last movement inside the existing 16 ms interval. Exact pixels
matched the host, but the host had never moved to that endpoint. This was an input
failure, not evidence that classifier hashing corrupted tiles; the failed report
is retained. A deterministic unit test reproduced the missing trailing delivery.

The viewer now retains one latest point and at most one timer. It sends the trailing
movement when the interval expires without needing another input event. Button
release, cancellation, capture loss, blur, abort and reset cancel pending movement;
button and wheel positions supersede older pending coordinates. Browser scheduling
can delay a timer, so 16 ms is a target, not a hard delivery guarantee. This patch
is independently backportable and changes no wire messages or wheel quantization.

## Evidence and limitations

Pure Rust tests compare optimized hashes against full hashing across 240 synthetic
frames with odd/clipped edges, full reads, small regions and returning video hints.
A real production-classifier differential test constructs host state on an isolated
X11 display and compares scores, video latches, hold counters, bounding-box history,
motion counts and tile classes through 30 hint/region transitions. The original
native capture and full-viewer recovery tests remain required.

Final local checks passed: 294 wrapper tests, 789 frontend tests, nine harness
ownership/firewall tests, Linux host/gateway tests, nine native X11 capture
regressions and the new classifier-lifecycle regression. Strict pristine replay
verified all 26 ordered patches and exact bytes for 835 upstream source files.
With both experimental flags on and scroll snapping/quantization off, the final
CPU/X11 viewer passed all 27 scroll/recovery pixel checkpoints, admitted nine
regional captures, and reported no page errors or downloads. All 27 display-control
stages also passed on that viewer. A fresh container with both experimental flags
off and the default scroll policy also passed all 27 scroll/recovery checkpoints
with no page errors or downloads. Owned local test containers were removed; private
test images/reports remain available. These local checks are not hosted CI results.

The first isolated Pi GPU diagnostic control used the candidate image with
`damageReadback=true`, `damageAnalysis=false` and timings enabled. All 69 observed
captures had a 921,600-pixel damage bounding box, matching the entire 1280×720 root.
One capture was forced/invalidated at startup; the other 68 had known bounds but
were rejected as broad. There were no missing-support or geometry-mismatch reasons.
Thus broad reported damage—not just an unknown eligibility condition—explains the
lack of regional admission in this run. It does not identify which upstream draw
operation expanded the damage, or imply every real webpage has this behavior.

The control hashed 16,560 current tiles (240 per capture). Diagnostic phase
medians were 6.026 ms classification and 28.252 ms total host work; p95 values
were 31.861 and 94.062 ms. Phase percentiles are not additive. Timings include
logging and uncontrolled background load, so this is not a clean latency result.
The workload and exact service/firewall cleanup audits passed.

With analysis enabled in the same candidate image, all 74 diagnostic captures
again had whole-root bounds (one forced, 73 broad). Classifier current-image hashes
fell to zero: 17,760 tile visits correctly had no video-hash consumer. Classification
median/p95 became **0.016/0.061 ms**, versus **6.026/31.861 ms** in the control.
This fixture demonstrates demand-based skipping, not regional reuse on the GPU.
Returning video hints and regional reuse are covered by the differential tests.

That stage improvement is **not an established end-to-end speedup**. Total host
median/p95 were 29.668/161.788 ms enabled versus 28.252/94.062 ms disabled; capture,
scroll and encoding varied substantially under uncontrolled background load.
The short diagnostic runs have eight measured inputs per phase, log overhead and
no exact input/frame association. Do not subtract their phase percentiles, claim
whole-machine CPU savings, or hide the worse enabled tail.

### Timing-logs-off viewer comparison

A separate enabled-then-disabled pair used 20 measured inputs per phase, with three
warmups before each phase and direct X11/viewer pixel checks at settled checkpoints.
Both used the exact same ARM64 candidate image, retired GPU/software-mirror backend, 1280×720 geometry,
regional-readback flag enabled and no per-capture timing logs. No local viewer
qualification ran concurrently with this pair. These are sequential trials on a
busy Pi, not a randomized repeated benchmark or a production workload.

| Input | Disabled median / p95 (ms) | Enabled median / p95 (ms) |
| --- | ---: | ---: |
| Small marker update | 83.5 / 107.1 | 76.9 / 111.3 |
| 32 px scroll | 127.4 / 442.8 | 91.2 / 117.4 |
| 64 px scroll | 101.2 / 143.4 | 112.1 / 166.8 |
| Cached return | 92.5 / 172.0 | 107.3 / 146.9 |

The result is mixed: sparse updates and 32 px scroll had better medians, but the
other two medians got worse. The sample cannot establish a general speedup or a
regression. Background one-minute load was roughly 6.8–8.3, and neither CPU quota
throttling nor test-container OOM was observed. Stage skipping is established;
stable user-visible improvement still needs repeated controlled measurements.

Small updates used exactly 279 application tile-command bytes per input in both
modes. Scroll-copy reuse was 86.2% for forward-scroll eligible tiles and 98.5% on
cached return, with zero cache misses in both modes. Eligibility counts and total
bytes varied with capture cadence; these ratios are not whole-screen/wire savings.
This change does not redesign the codec or establish lower network usage.

The Pi pair used the candidate host with the preceding viewer revision on both
sides; it isolates the analysis flag, not patch 0026's drag fix. All four Pi runs
passed their settled pixel checks and ownership/cleanup audits. Full arbitrary
webpages, video playback performance, transient pixel correctness during motion,
display scanout latency and the final pointer fix on Pi remain outside this result.

### Next bounded experiment, not implemented here

1. Instrument the display's synchronization boundary before rewriting it: count
   pixmaps/bytes, GPU waits and CPU copies separately from host tile processing.
   A narrow request is not useful if the dependency still synchronizes everything.
2. Derive a small activity map from already-detected changed tiles and input/scroll
   hints, without introducing another full-image hash pass. Coalesce likely tiles
   into a bounded number of rectangles; account for history-buffer repair too.
3. For coarse damage, prioritize those rectangles and rotate an audit across the
   rest of the screen, including while idle. Define and test a maximum stale-pixel
   interval. Scroll, navigation, resize and video transitions need explicit recovery
   policies; scrollbar movement must not masquerade as an ordinary wheel delta.
4. Accept the experiment only after comparing missed-update recovery, total copied
   bytes, bandwidth and input latency on repeated sparse, scroll and video trials.

### Synchronization remains a separate boundary

A small GetImage request does not guarantee small upstream GPU work. A software
mirror or tiled-image map can synchronize and copy a larger allocation first.
These component observations concern the retired comparison stack, not the
custom Vulkan deployment. See [the current audit](GPU_PIPELINE_AUDIT.md).
