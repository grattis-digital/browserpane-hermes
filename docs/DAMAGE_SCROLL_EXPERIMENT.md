# Damage readback and realistic scroll qualification

Experimental follow-up to [the measured tile-pipeline baseline](RENDER_PIPELINE_PLAN.md).
Nothing here replaces the tile/cache/video protocol with full-frame streaming.
The production Compose defaults, codecs, cache limits and GPU selection are unchanged.

## What patch 0023 changes

`BPANE_EXPERIMENTAL_DAMAGE_READBACK=1` opts the host into one conservative sparse
X11 read when the acknowledged damage bounding rectangle covers at most one eighth
of the root. Missing/uncertain damage, first capture, resize, lost history, forced
snapshot and active video ownership retain the established full readback path.
Broad scroll damage is intentionally not optimized by this first readback step.
This flag is off by default; add it explicitly to the browser service environment
in a private experimental Compose override if qualifying it outside the harness.

Two complete owned CPU images still exist for exact motion/residual comparisons.
After a regional capture, the older rotating buffer needs only the previous
region repaired before the next read. After a full capture, one full seed copy is
required: that capture may include newer pixels outside the acknowledged bounds.
This avoids an unreported full-frame copy on every sparse update, but is neither
zero-copy nor a GPU-resident pipeline. MIT-SHM rows are copied directly into the
strided destination without an intermediate packed allocation. GetImage keeps its
owned reply allocation for full reads and scatters it for regional reads.

The X11 reply fences server writes before consuming SHM. RAW_RECTANGLES damage
arriving after acknowledgement remains pending for the next capture. A regional
read failure immediately falls back to full capture, forces an independent
repair, and disables regional mode for that session. Failed full reads invalidate
history. Format/size checks reject unsupported packed-pixel layouts. Existing
tile-specific damage tracking already bypasses small/repeated idle suppression;
this experiment preserves that behavior rather than claiming to introduce it.

`BPANE_CAPTURE_TIMINGS=1` adds separate request/reply, explicit pixel-copy and
history-repair measurements to the existing capture/scroll/classification/
dirty/encoding phases. Normal runs do not sample these clocks or log per frame.
Request time includes X-server work, waiting, synchronization and reply parsing;
it does **not** isolate GPU execution or GPU-memory traffic. GetImage ownership
transfer counts no extra application copy, but its socket/driver work is not free.
Requested pixels include attempted regional reads before fallback. Copy-byte
counts describe explicit copies, not physical memory-bus reads plus writes.

## Human scrolling is a separate test category

The original Pi latency pilot changes a synthetic DOM marker and list using exact
keyboard steps; it is not a native-wheel or human-scroll benchmark. The full viewer oracle
now also uses six deterministic *human-shaped*, not human-recorded, wheel traces:
burst, accelerating/decaying momentum, reversal, pause/resume, nested momentum,
and nested diagonal motion. Every input enters the viewer's actual wheel handler,
transport and host injector. The remote synthetic page records bounded trusted
wheel events and their targets; wrong-target/no-input runs fail. Pixel checks
must converge without an extra corrective scroll. Existing cache-loss, decoder
fault, resize and reconnect checks remain mandatory.

Two important current behaviors must not be hidden by the harness:

- `input-map.ts` accumulates pixel deltas in 60-pixel chunks before sending wheel
  notches. `pointer-input-runtime.ts` sends the current pointer location before
  each admitted scroll. Tiny deltas and reversals are not exact page movements.
- `cdp_video.rs` can snap the top-level page to tile-aligned scroll coordinates
  after a quiet period. A settled screenshot can therefore miss behavior before
  this extra page movement. Test with and without snapping; do not silently change
  the user's production input behavior as part of a capture experiment.

The trace runner uses absolute target times and records actual injection lateness.
Playwright/Chrome wheel dispatch may serialize at a slower cadence than requested.
Such runs are useful correctness checks, **not proof of 8 ms hardware input**, and
not a substitute for a real trackpad/mouse trace. Real-user reproduction remains
a release gate: opt-in recording must contain numeric deltas/timestamps/geometry
only, never page contents, URLs or keystrokes. No such recorder is enabled here.

Patch 0024 independently fixes an input-lifecycle defect: canvas-only pointer-up
handling could leave the remote mouse button held when a scrollbar drag ended
outside the viewer. It retains native pointer capture, observes an owned-pointer
document fallback, clamps out-of-bounds coordinates and releases once on up,
cancel, lost capture, blur, abort or reset. It does not change wheel normalization,
scroll snapping, the tile grid or the wire protocol. Seven client regressions cover
these paths. A real native-thumb test also jumps, reverses, releases outside the
canvas and checks that subsequent mouse movement no longer drags the page.
Wheel behavior remains the priority; forcing scrollbar movement onto the grid is
deferred. This input bug does not establish the cause of every reported tile hole.

## Established techniques and our next design

These are primary-source design references, not comparable vendor benchmarks or
code copied into this project:

| Reference | Useful pattern | Application here |
| --- | --- | --- |
| [Microsoft Desktop Duplication](https://learn.microsoft.com/en-us/windows/win32/direct3ddxgi/desktop-dup-api) | Separate move and non-overlapping dirty rectangles; moves precede repairs | One ordered reconstruction contract, including exposed strips and overwrites |
| [Xpra motion implementation, pinned source](https://github.com/Xpra-org/xpra/blob/5ce03e54666014b4117f32df2bcf83ccd7777c5b/xpra/server/window/motion.pyx) | Row checksums, displacement candidates, matched/unmatched row coverage; geometry changes invalidate references | Cheap region-local motion proposals, then exact verification before suppressing pixels |
| [RFB CopyRect specification](https://www.rfc-editor.org/rfc/rfc6143.html#section-7.7.2) | Reuse already-known framebuffer pixels | Preserve source validity and overlap-safe move ordering, not just tile-cache membership |
| [Chromium rendering path](https://www.chromium.org/developers/the-rendering-critical-path/) | Scrolling can composite on a separate thread and reveal newly rasterized content | Input delta/CDP scrollY is a hint, not proof the captured frame contains that movement |

Our current scroll resolver explicitly keeps `grid_offset_y=0`. Fractional scroll
invalidates affected *position* hashes while retaining content-addressed bitmaps.
This distinction matters: low position-skip counts do not prove L2 eviction.
Non-solid cache identity includes dimensions, so clipped edge tiles cannot alias
full tiles. Static/content overlaps already invalidate both grids where required.
Keep these correctness safeguards; removing invalidation is not a cache fix.

The next candidate is a **region-local move-and-damage planner**, not a global
grid that chases every wheel delta:

1. Keep canonical half-open physical-pixel rectangles and explicit capture/viewer
   generations. Normalize overlapping damage into bounded non-overlapping bands;
   merge nearby bands only when saved request overhead exceeds extra pixels read.
2. Propose motion per scrollable region using hints plus row fingerprints; require
   exact current-versus-previous pixel agreement before omitting a residual. Keep
   fixed/sticky overlays and nested scrollers separate. Current ScrollCopy lacks
   an arbitrary left bound, so generalized nested moves need a versioned protocol
   change, not an assumption that all regions start at x=0.
3. Track content-cache identity separately from screen position/coverage. Explore
   region-local stable content coordinates or cached subrectangles for arbitrary
   scroll distances. Carry clipped dimensions and source generation explicitly;
   returning to a previous position does not prove content stayed unchanged.
4. Apply all moves from a valid previous image before residual repair; account for
   overlapping sources/destinations, reversal, resize, async decode completion and
   lossless/video ownership transitions. Unknown history requires repair, not a
   speculative cache hit. Preserve bounded memory and existing recovery barriers.
5. Choose sparse read, merged read or full read by measured total cost, including
   X11 round trips, seed copies, analysis and downstream encoding. A smaller damage
   area can still be slower if each rectangle introduces a synchronization wait.

Start with property tests for complete, non-overlapping coverage at every tile
phase and odd viewport size, then actual input/capture/viewer traces. Acceptance
requires no holes at rest **or during gesture transitions**, lower measured work
or latency, bounded recovery, and no hidden full-copy replacement. A passing
settled-pixel test alone does not establish transient visual quality.

## Reproduction and evidence boundaries

```sh
npm test
BPANE_PIPELINE_TEST_SKIP_BUILD=1 BPANE_PIPELINE_TEST_OFFLINE=1 npm run test:linux
# Build your matching application image first. The helper uses fresh tmpfs data.
BPANE_PIPELINE_IMAGE=browserpane-hermes:YOUR_IMAGE \
  BPANE_PIPELINE_NAME=browserpane-pipeline-viewer BPANE_PIPELINE_VIEWER=1 \
  BPANE_EXPERIMENTAL_DAMAGE_READBACK=1 BPANE_CAPTURE_TIMINGS=1 \
  BPANE_CDP_SCROLL_SNAP_CSS_PX=0 BPANE_SCROLL_COPY_QUANTUM_PX=0 \
  bash scripts/start-pipeline-probe.sh
node scripts/check-scroll-integrity.mjs damage-unsnapped
```

Keep feature-off controls and diagnostic runs separate from clean latency samples.
The helper retains its labelled disposable container for inspection; remove only
the exact inspected test ID afterward, never an unrelated service. Pi pilots
require the separately documented source-scoped temporary-LAN approval and finite
ownership harness. Raw reports stay private/ignored; publish sanitized aggregates.

## Isolated Raspberry Pi diagnostic results

Four short runs used the same locally built ARM64 candidate and existing GPU
display image: CPU/off, GPU/off, GPU/on, CPU/on. Each had eight measured plus three
warm-up actions per phase, four phases, five separate full-surface truth checks,
and per-capture logging enabled. These are diagnostic samples, **not clean timing
comparisons**. Background load remained uncontrolled; no CPU quota was imposed.
The candidate uses X11 plus the existing retired software-mirror display GPU backend, not the Rust DDX.
Pi measurements used the 0023 host and pre-0024 viewer. The pointer fix was
qualified separately in local derivative images; subsequent host edits were
formatting-only. No live deployment or Pi qualification of the pointer fix is
claimed. Private reports retain exact image identities.

| Mode / regional flag | Captures / regional | X11 wait p50 / p95 (ms) | Explicit copy p50 / p95 (ms) | Copy bytes including history repair |
| --- | ---: | ---: | ---: | ---: |
| CPU / off † | 71 / 0 | 3.573 / 14.921 | 3.016 / 12.340 | 261,734,400 |
| GPU / off | 70 / 0 | 3.133 / 9.345 | 3.085 / 21.468 | 258,048,000 |
| GPU / on | 67 / 0 | 3.064 / 18.657 | 2.894 / 23.152 | 246,988,800 |
| CPU / on | 73 / 11 | 3.030 / 15.141 | 2.711 / 11.918 | 232,291,584 |

All observed reads used SHM, with no GetImage or regional-error fallback. The
GPU/off copy-time maximum was 135.585 ms. These are **wall times**: scheduling can
inflate a CPU copy, so this is not evidence of a 135 ms GPU transfer. Median
request/copy times do not explain the entire GPU latency difference. Joining
capture IDs to input/presentation, recording selection reasons and comparing
thread CPU time with wall time are still needed before attributing the tail.

The CPU/on run read exactly 24×24 pixels for 11 sparse captures. Readback copies
were 228,582,144 bytes, plus 3,709,440 bytes repairing the rotating history. Against
the arithmetic full-read cost for those **same 73 captures** (269,107,200 bytes),
that is 36,815,616 fewer explicit copy bytes, or 13.7%. This is a counterfactual
copy-accounting calculation, not a measured latency, total RAM-bus or network
speedup. Different runs have different capture counts; do not compare byte totals
as if the sampled work were identical. The existing tile transfer path is unchanged.

The GPU/on run admitted **no regional reads**. Its damage eligibility needs a
separate investigation; broad compositor damage or unknown bounds are candidates,
not a proven driver defect. The synthetic fixture really changes only a small DOM
marker during the sparse phase; it does not redraw an entire canvas in JavaScript.
This backend difference is the next useful target. Keep the feature off by default;
there is no demonstrated GPU or end-to-end latency win from enabling it here.

† CPU/off completed its pixel workload but failed the final cleanup handshake:
slow local Chrome shutdown let the remote inactivity watchdog finish first. Its
failed report is retained, not relabelled a pass. The private owner record confirmed
cleanup with no cleanup errors. The harness now finishes/audits remote ownership
before closing the local viewer; both error preservation and order are unit-tested.
The following three runs passed their workload and cleanup audits. No production
services, profiles, devices or boot settings were changed; temporary owned Pi
containers, bridges, socket volumes and firewall rules were cleaned up.

Local qualification additionally passed all nine real-X11 regressions (including
SHM/GetImage, strided regions and damage arriving after acknowledgement), the full
client suite and strict pristine replay of all 24 patches. Wheel/recovery tests
passed 22 settled pixel checkpoints with regional mode on, both with the usual
snap behavior and with snap/copy-quantum disabled; display controls passed 27
stages. These local results are not Raspberry Pi input-latency measurements.

The new scrollbar oracle reproduced the old input bug without wheel events:
after outside release, merely moving the pointer changed scrollY from 3271 to
6428. Its first attempt failed a harness geometry assumption in the quirks-mode
fixture; the corrected test reads the actual scrolling element. Neither failure
is counted as a passing run. The fixed viewer passed all 27 wheel/scrollbar/recovery
pixel checkpoints in each of two fresh runs: regional readback on with snap/copy
quantum disabled, and regional readback off with normal defaults. Remote button
release was verified and subsequent pointer movement left scrollY unchanged.
Moving a held thumb outside the viewport can itself change scrollY; this is normal
native drag behavior, not a promise that leaving the canvas freezes the scrollbar.
Transient in-gesture correctness and real-user recordings remain separate work.

The final local wrapper suite passed 292 tests; the client suite passed 782 tests.
Linux host/gateway tests and all nine opt-in native-X11 regressions passed. Existing
Rust warnings remain; this is not a claim of a warning-free Clippy/workspace audit.
The fixed viewer also passed all 27 display-control stages with normal defaults,
including fitted small viewports, persistent settings and viewer ownership changes;
no page errors or downloads were observed.
