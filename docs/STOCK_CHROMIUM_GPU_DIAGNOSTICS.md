# Stock Chromium GPU diagnostics

The custom Chromium build remains stopped. This operator-only follow-up extends
the existing disposable render pilot; it does not replace Chromium, change GPU
flags, deploy a new production backend, or use logs to authorize capture omission.

## Measurement contract

`stockGpuWorkloads: true` enables three additional finite real-viewer workloads:
irregular wheel deltas with reversal, a native scrollbar drag with reversal, and
a small compositor animation. The existing four keyboard/pixel-latency phases
remain. Each workload uses the normal input/tile/cache/WebTransport stack, then
checks the settled viewer against X11 outside the measured interval. Movement
and remote wheel events are asserted. These generated inputs are not recordings
of a physical user, transient artifact qualification or physical scanout timing.

`stockGpuTrace: true` additionally records each of these seven phases separately.
It requires `stockGpuWorkloads`, rejects custom Chromium/native-damage tracing,
and defaults off. Use identical immutable images and workload settings with
tracing off to measure perturbation. Independently compare `captureTimings` off/on.
Neither trace mode nor these extra workloads is enabled in ordinary tests or CI.

The collector discovers supported Chromium categories, requiring `cc`, `viz`,
`gpu` and `blink.user_timing`; it reports unavailable optional categories rather
than claiming coverage. It collects SystemInfo GPU features, backend, workarounds
and before/after process counters. Each trace has an 8 MiB buffer, a 60-second
deadline and a 32 MiB/200,000-event export limit. Buffer loss/pressure, absent clock
markers and malformed traces fail the diagnostic. No screenshots, shader dumps
or unbounded per-call logging are enabled. Some verbose GPU logging flags require
compile-time options and are not assumed available in distribution packages.

Host cgroup checkpoints retain memory/CPU/throttling and surviving per-process
CPU deltas; process start times prevent PID-reuse mistakes and churn is explicit.
Chromium's rewritten process titles are handled as well as NUL-separated argv.
Capture log timestamps are filtered to each measured phase, excluding previous
workloads and expensive pixel oracles. Raw cumulative logs remain private for
auditing that selection. Completion timestamps do not uniquely identify the
input that caused a frame, and a boundary capture may have started earlier.

Trace clock markers are bracketed by the collector's host monotonic/wall times.
Their call round-trip is an uncertainty bound, not a precise clock offset. Page
input marks are recorded in the renderer handler after the fixture mutation, not
at the viewer's input origin. Do not subtract unaligned host/viewer timestamps.

For keyboard phases, the stock `InputLatency::RawKeyDown` record already supplies
ordered input/renderer/display/GPU-swap component timestamps. A unique fixture
handler mark associates its sequence with the corresponding measured viewer
sample. Missing, duplicate, ambiguous or unordered components fail that coverage
gate; rounded 64-bit numeric trace IDs are never used as join keys. Subtracting
the paired Chromium interval from the measured end-to-end **duration** leaves an
explicitly unassigned remainder, not a separately measured network/codec delay.
`FRAME_SWAP` is Chromium's swap-completion endpoint, not physical monitor scanout.
Wheel, scrollbar and animation do not claim this keyed-input timing coverage.
The separate `SwapEndToPresentationCompositorFrame` summary uses string-valued
asynchronous IDs and deduplicates identical timestamp pairs: several latency
tracks can describe one frame. It reports Chromium's presentation-feedback
timestamps, not physical scanout or XDamage arrival. Trace-boundary truncation is
reported explicitly; those records do not qualify a host-capture frame join.
Five reliable input-channel barriers before/after the workloads give a control
round-trip reference, including host dispatch and queueing, not pure network RTT.

The offline summary supports complete `X` and nested `B/E` thread spans, reports
unmatched boundaries, preserves bounded damage rectangles, and excludes arbitrary
trace arguments from summaries. **Inclusive spans overlap.** A GL/EGL call's wall
time can include scheduling, IPC or synchronization; it is not hardware GPU
execution time. Asynchronous GPU jobs require additional driver-supported evidence
before attributing a stall to shader work. No additive end-to-end latency budget
or exact causal input/capture/presentation frame join is claimed.
Where trace thread CPU duration is present, the summary reports it separately
with its own sample coverage. Wall minus CPU may include blocking or descheduling;
it cannot distinguish those causes without scheduler/driver evidence.

The scrollbar thumb is located from a single bounded viewer pixel column before
the phase. This avoids assuming theme-specific arrow/minimum-thumb dimensions.
Continuous movement and a substantial drag in the requested direction are then
required; a track click cannot qualify as a successful drag. The column read and
all full-surface correctness reads are outside the measured interval and do not
drive the production capture pipeline.

## Operation and artifact handling

Follow [the render pilot's authorization and lifecycle boundary](../scripts/render-pilot/README.md).
Copy the entire reviewed `scripts/render-pilot/` Python/JavaScript module set,
plus its two documented runtime files, into a fresh private remote staging
directory. No live profiles or displays; no arbitrary websites or egress; no
host package, boot, production firewall or service changes. Temporary endpoints
remain restricted to the one approved client.

The trace controller is a single ownership-checked `docker exec -i` subprocess.
There is no concurrent trace or unbounded request queue. EOF, errors and owner
cleanup close the collector before destroying only the owned disposable services.
Raw traces, stderr, host logs, image identities and reports remain private and
must not be published as CI artifacts. New trace exports are exclusive files.
On collector failure, stderr and the owner failure record survive cleanup;
unexported trace bytes inside the disposable container do not.

## Actual Pi evidence

The disposable Pi 4 / 8 GiB retired GPU/software-mirror tests used stock Chromium 152.0.7977.75,
the same immutable ARM64 browser/display images, and a 1280×720 surface at 1×.
The browser test image was already built locally and transferred to the Pi;
no Chromium compilation or production container replacement was performed.
Image architecture, OS, full Config and RootFS were compared across transfer.
The viewer was a fresh, sandboxed, headless Chrome 152.0.7977.83 on macOS.
The earlier experimental test image includes the pointer-input corrections;
`damageReadback` and `damageAnalysis` were enabled, with custom/native Chromium
tracing disabled. Disposable services had bounded RAM, low CPU shares and no CPU
quota. This is not a measurement of the supported default Compose configuration.

Hardware rendering remained enabled throughout the completed runs: Chromium used
ANGLE / Broadcom V3D / Mesa 25.0.7; the viewer reported hardware WebGL2 on Metal.
Chromium's GPU process remained sandboxed with zero reported crashes. Hardware
video encode/decode was **not** enabled; these tile workloads emitted no video
frames and do not qualify video throughput or an entirely GPU-resident pipeline.

Two full traced runs collected 14 bounded traces (58,337,664 raw JSON bytes).
All 160 measured keyboard inputs matched their Chromium timing records. No trace
reported loss; maximum reported buffer occupancy was 28.1%. A separate 80-input
run enabled only host timing logs. Two completed clean runs (160 inputs) kept
both logging modes off. The five completed runs therefore cover 400 measured
inputs and 40 settled full-surface oracles; failed/preliminary trials below are
retained separately. No per-input failures were removed from successful runs.
Each complete run also checks wheel, actual scrollbar-thumb drag, finite
compositor animation, idle traffic, and eight settled full-surface pixel oracles.

Clean input-to-readable-pixel results, pooled across the two completed repeats
(40 samples per phase; nearest-rank percentiles):

| Keyboard phase | Median | p95 | Maximum |
| --- | ---: | ---: | ---: |
| Sparse update | 68.2 ms | 131.5 ms | 157.1 ms |
| Half-tile scroll | 77.4 ms | 134.6 ms | 165.9 ms |
| Tile scroll | 82.1 ms | 140.6 ms | 151.2 ms |
| Cached return | 84.2 ms | 127.9 ms | 184.9 ms |

The host-logging-only run's medians were 79.4, 88.9, 83.7 and 76.8 ms, with a
327.4 ms maximum in half-tile scrolling. Traced medians were generally higher,
but shared load and short repeat counts prevent a precise causal overhead claim.
These are observable viewer pixels, including the bounded pixel observer's
overhead, not physical scanout or animation frame rate.

Pooled **traced** input-stage medians below have 40 samples per keyboard phase.
These durations are diagnostic, not the clean performance baseline:

| Keyboard phase | Viewer input → readable pixel | Chromium input → frame swap | Unassigned paired remainder |
| --- | ---: | ---: | ---: |
| Sparse update | 91.6 ms | 37.2 ms | 52.1 ms |
| Half-tile scroll | 98.6 ms | 39.6 ms | 60.2 ms |
| Tile scroll | 104.8 ms | 39.4 ms | 63.5 ms |
| Cached return | 98.8 ms | 42.3 ms | 58.8 ms |

Medians of individual components do not add to the median of their total.
The 95th-percentile traced end-to-end values were 156.5, 150.6, 138.7 and
184.2 ms respectively; maxima were 216.3, 162.4, 220.3 and 244.2 ms.
Control-barrier median round trips were approximately 5 ms in most checkpoints,
including dispatch/queueing. This argues against control-channel transit being
the dominant cost in these synthetic cases, not against every possible network
or website bottleneck.

Other measured observations:

- In the host-logging-only run, median capture/tile-loop processing was
  14.6–19.7 ms across the four keyboard phases, 49.1 ms during scrollbar dragging
  and 53.0 ms during animation. Animation p95 was 105.6 ms. This is not delivery
  time: `encode_send_us` includes codec work and bounded-channel backpressure,
  not just encoding or final network transmission.
- Those keyboard-phase captures still requested all 921,600 pixels and performed
  an explicit 3,686,400-byte application copy each, despite selective tile
  transmission. In the second trace, 19 of 20 sparse root-damage records were
  only 24×24; one covered the page region. Precise upstream damage and broad host
  readback therefore coexist. This does **not** mean whole frames cross the wire:
  sparse updates needed only 279 tile-command bytes per measured batch.
- The irregular wheel gesture used five or six scroll copies per completed run;
  native scrollbar dragging used zero. Both reached the intended remote
  positions and passed settled pixel checks. Different gestures cover different
  distances, so their total bytes are not a normalized efficiency comparison.
- The small animation generated roughly 33–34 image commands per tile batch,
  including when the changed content was narrow. Source inspection identifies a
  plausible amplification source: static/content grid boundary tiles deliberately
  bypass unchanged-hash and sent-cache reuse to repair overlap. This is a lead,
  **not yet per-position payload attribution** or permission to remove repairs.
- In the second animation trace, 55 `SkiaOutputSurfaceImplOnGpu::SwapBuffers`
  spans accumulated 750.3 ms wall time but 123.2 ms thread CPU time. Median wall
  time was 13.9 ms versus 2.0 ms CPU. Waiting/descheduling is material; these
  counters cannot decide between GPU synchronization and host scheduling.
- The second trace's keyboard phases each had 20 unique presentation-feedback
  records with no unmatched boundaries. Median reported swap-end → presentation
  intervals were 9.1, 6.6, 10.4 and 10.9 ms. These are not physical presentation
  timings and cannot be blindly added to host processing or the paired remainder.
- Settled idle checkpoints emitted no tile batches. No completed run reported
  cache misses, accidental downloads, viewer script errors, or cgroup CPU-quota
  throttling. Endpoint memory values are not peak memory measurements.

### Qualification failures retained

The initial trace smoke test revealed that guessed scrollbar geometry could
produce a track click instead of a drag. Its scrollbar result is not qualified;
the harness now locates the real thumb and asserts continuous forward movement.
An initial clean trial overlapped a diagnostic-file SSH download; the entire
trial is retained but excluded from clean comparisons, not trimmed selectively.

A later clean repeat failed after 60 measured inputs because a short-lived
process exited during `/proc` CPU-counter collection (`ProcessLookupError`). Its
private owner record confirms successful container/rule cleanup and unchanged
pre-existing services. It remains a failed run, not a partial baseline. The
collector now treats both ENOENT and ESRCH as process churn, while propagating
unrelated errors. The RPC client also retains watchdog failures sent between
requests instead of replacing the cause with a generic owner-exit message.
Regression tests cover these cases, exclusive evidence exports and bounded
collector cleanup. Local Node tests (330) and render-pilot Python tests (27) pass.
The repeat after that fix passed all 80 inputs, three extra workloads and cleanup.
The failed report was not overwritten or reclassified as a pass.

### Next work, not implemented here

1. Add bounded per-batch timestamps for capture completion, encoding CPU,
   channel enqueue/dequeue, gateway transmission and viewer decode/draw. Measure
   queue age independently; retain clock uncertainty and avoid full-frame reads
   in the runtime path. This is needed to assign the remaining latency honestly.
2. Attribute image bytes to tile coordinates/layers, then test generation- and
   overlap-aware boundary-cache reuse with existing scroll/resize/reconnect
   oracles. Keep fresh repair when reuse cannot be proven safe.
3. Extend scroll-copy qualification to pointer-driven scrollbar motion with
   conservative damage checks and bounded fallback, not wheel-only hints.
4. Investigate Chromium/display presentation and GPU/CPU handoff waits with stock
   tracing and, where available and separately scoped, scheduler/driver counters.
   Do not infer a fixed 50 ms capture delay from the XDamage poll timeout: queued
   damage returns immediately and tile capture disables damage aggregation.

These are diagnostic results under shared, variable Pi background load, not a
GPU-versus-CPU backend A/B, site-load benchmark, sustained frame-rate guarantee,
physical-human-scroll test or production speedup. Trace/logging changes also
perturb execution; keep clean results separate and do not extrapolate a universal
tracing-overhead percentage. The custom Chromium build remains stopped.
Across the five completed runs, sampled one-minute load varied from 4.76 to 7.11,
maximum sampled temperature was 55.0°C, and available host RAM stayed above
2.9 GiB. No host package, GPU flag or live service was changed. All five cleanup
audits restored the exact original firewall state and running-service inventory;
a final read-only check found the original services healthy where healthchecks
exist and no remaining pilot containers or firewall chains. Imported test images
and private diagnostic evidence are retained, not published. The local custom
Chromium builder is still exited with automatic restart disabled.

References: [Chromium GPU debugging](https://chromium.googlesource.com/chromium/src/+/main/docs/gpu/debugging_gpu_related_code.md),
[CDP Tracing](https://chromedevtools.github.io/devtools-protocol/tot/Tracing/),
[CDP SystemInfo](https://chromedevtools.github.io/devtools-protocol/tot/SystemInfo/).
