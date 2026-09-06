# Rendering optimizations and evidence

This bundle preserves BrowserPane's remote browser pipeline while reducing its
administration layer. It does not replace the transport with screenshots or VNC.
The changes are recorded as ordered patches; [BACKPORTING.md](BACKPORTING.md)
maps them to upstream files and recovery contracts.

## What changed

| Area | Implementation | Purpose |
| --- | --- | --- |
| Capture scheduling | Damage acknowledged before capture, damage retained during processing, reusable X11/SHM buffers, bounded idle polling | Avoid missing small final updates and unnecessary allocation/work |
| Scroll detection | Gather the existing sampled columns contiguously before the exact search | Improve memory locality without approximating scores, thresholds or tie order |
| Host caches and encoding | Bounded O(1) sent-hash LRU, dimension-aware hashes, reused level-1 Zstd context and output scratch | Reduce bookkeeping/allocation while retaining independently decodable tiles |
| Client rendering | CPU accounting, bounded WebGL texture reuse, reduced redundant decode/upload | Reuse valid tiles without retaining mutable video/canvas sources |
| Scroll integrity | Exact regional residual repair; invalidate position hashes that no longer describe copied pixels; preserve content-addressed L2 reuse | Prevent persistent holes and stale fixed/footer tiles, including partial rows and direction reversals |
| Half-tile scrolling | Verified 32-pixel copies with exact residuals and both position maps invalidated for fractional-row moves | Reuse copied pixels without incorrectly shifting 64-pixel tile hashes |
| Recovery | Fail closed on missing stateful commands; coalesced fresh snapshots; failed client batch blocks dependent deltas until recovery completes | Make loss/reconnect/cache eviction recoverable, including idle pages |
| Video transitions | Reliable region ownership, fresh lossless exit repair, bounded decoder/bootstrap backlog | Stop stale video covering the newly lossless page |
| Geometry | Optional 8×2 capture alignment and validated exact virtual-display modes | Keep the actual X11 dimensions and displayed bitmap consistent |
| Resize error cleanup | Restore the saved Chrome window state after a failed intermediate CDP bounds request | Avoid leaving a temporarily normalized window in normal state after failure |
| Window-control ownership | Resolve a visible page's window, then resize/restore it over the browser-level CDP connection | Keep closing that page from interrupting top-level window restoration |
| Drawable fallback | Replace a rejected WebGL canvas before mounting the Canvas2D renderer; fail when neither renderer can draw | Avoid receiving tiles into a context-less, permanently blank surface |

The browser remains at device scale 1 by default. Viewer density controls change
local display/capture sizing, not Chromium's page/device scale. Auto uses a
readability-first 1× policy and a 1280×720 pixel-area budget; this is a conservative
policy, not a dynamically measured optimum. Larger presets through 1920×1080
are opt-in. A historical 4K snapshot sometimes exceeded the stateful broadcast
queue, so 2560/3840-wide presets are not exposed as qualified options.

Patch 0016 has six native regression tests using the actual resize function and
a private scripted CDP WebSocket peer. Before the fix, three regressions failed;
afterward all six passed. They cover successful and rejected bounds requests,
later resizes, prior normal/minimized/maximized/fullscreen states, and restoration
failure. A failed operation still reports failure; there is no forced-maximize
or global retry policy. This proves the cleanup defect, not that it triggered
every observed geometry failure or an unrelated initial-viewer timeout. A peer
that rejects restoration can still leave the window in normal state.

Patch 0017 addresses a separately reproduced lifetime failure: closing the page
while a resize had temporarily normalized its surviving browser window also
closed the page-scoped control socket. A local Chromium 152 trace recorded tab
destruction 84 ms after normalization, inside the host's 120 ms interval. A
controlled real-browser check confirmed that restoration then failed over the
closed page socket, but succeeded for the same window over a browser-level
connection. Four additional native mock-CDP tests cover this closure, a vanished
pinned window, and missing/rejected browser connections; the six earlier state
regressions remain. This does not establish the cause of unrelated initial-viewer
timeouts or make native window-manager transitions synchronous.

Patch 0018 corrects a different fallback defect: after WebGL had claimed a
canvas, rejecting that renderer and asking the same canvas for Canvas2D yielded
no drawable context. Four unit regressions fail on the old path and pass with
the replacement-canvas path; the full client suite passes 775 tests. Actual
Chromium 146 tests injected software-renderer rejection, metadata-query failure
and shader failure and compared exact Fill/QOI/Zstd/cache/scroll pixels with
zero differing channels. Complete Canvas2D failure is explicit before mounting.
Hosted diagnostics showed a ready transport receiving 595,258 bytes in 1,700
frames while drawing counters stayed zero, but did not identify that runner's
renderer hardware. The controlled checks prove the fallback defect without
claiming every initial-viewer timeout has the same cause.

## Historical Raspberry Pi evidence

These are development measurements from the precursor implementation, not a
benchmark run of every new fork commit. They used a Raspberry Pi 4B with 8 GB,
ARM64, Chromium 152.0.7977.75, CPU/Xorg rendering, device scale 1 and a 1280×720
framebuffer. Other services were running. The keyboard harness measured from
Unix input submission until the matching marker-center pixel and BatchEnd were
received. It did **not** measure LAN delay, client presentation or perceived
end-to-end interaction latency.

Three matched runs of 60 physical keyboard samples per version, with phase
logging disabled, recorded:

| Metric | Before | After capture/cache/locality work |
| --- | ---: | ---: |
| Median marker latency | 127.0 ms | 22.3 ms |
| p95 marker latency | 214.0 ms | 39.0 ms |
| Timeouts | 0/180 | 0/180 |
| IPC bytes per input | 1239.6 | 1247.3 |

This is approximately 5.7× lower median latency for that synthetic host path,
not a bandwidth reduction: bytes increased by about 0.62%. Twelve small hover
updates had four >2-second misses before, and none after. Separate phase logging
identified the old strided scroll search at approximately 82 ms per warm frame;
the contiguous-column implementation reduced that phase to approximately 2.7 ms
in a small diagnostic run. Capture was approximately 3.3 ms. Those diagnostics
explain the bottleneck; they are not an additional large matched benchmark.

Later scroll-correctness work did not establish another keyboard latency gain.
A matched 180-sample Pi check measured median 22.15→22.56 ms and p95
35.19→41.19 ms, with no timeouts. A 12-sample hover check was slower
(21.47→27.22 ms median, 32.58→63.08 ms p95); a fresh matched control measured
21.27→21.81 ms median and 39.30→40.52 ms p95, again with no misses. Small samples
and host contention matter; neither equal tails nor a universal speedup is claimed.

## Scroll and cache correctness evidence

A disposable ARM64 Linux container on a Mac and a fresh local Chrome viewer
used the same frozen harness for both revisions. At 16 settled checkpoints it
compared the complete normalized viewer RGBA bitmap with a direct X11 capture,
and separately checked physical X11 geometry. Fixtures included fixed/sticky
content, a partial bottom tile, upward scrolling, nested/horizontal scrolling,
32/64-pixel movements, explicit cache loss and an injected decode failure.

| Result | Before | After integrity/geometry fixes |
| --- | ---: | ---: |
| Checkpoints with both pixels and geometry correct | 7/16 | 16/16 |
| Exact compared pixel rectangles | 10/16 | 16/16 |
| Physical geometry correct | 13/16 | 16/16 |
| Wrong pixels after natural upward scrolling | 16,684 in 19 tiles | 0 |
| Wrong pixels after injected decode failure at idle | 2,240 | 0 |
| Cache-miss reports in forced cache-loss burst | 152 | 1 |
| Actual copies in sixteen 32-pixel scroll steps | 0 | 16 |
| Tile bytes in the measured scroll sequence | 863,354 | 679,446 |

The final row is a 21.3% reduction for that fixture, not all traffic, all pages,
or all network conditions. Checkpoint equality does not prove every transient
frame is artifact-free. A deterministic host model also exercises retained
copies with randomized reversals, partial regions, grid offsets and matching
stationary colors; it is not a replacement for the real X11 comparison.

Local CPU microbenchmarks isolate narrower work: a 50-frame, three-round paired
half-tile host test measured median total 28,465→15,656 µs and encoded bytes
321,206→171,662. This excludes Chrome, capture, network and the viewer. The
warm-LRU bookkeeping and reused-Zstd benchmarks likewise are component tests,
not whole-frame or Pi performance claims.

## GPU investigation is not the default configuration

An isolated Pi rendering experiment used Xvnc/DRI3 and Mesa 25, without
BrowserPane capture or transport. Three runs per mode used 10-second phases
after a 2-second warm-up. Measured rAF cadence improved from 39.3 to 59.9/s for
scrolling and 39.7 to 58.6/s for canvas animation. DOM work was essentially
unchanged (10.2→10.5/s, overlapping ranges). Combined Chrome/X CPU decreased for
scrolling but increased for the canvas workload; idle/power savings were not
established. rAF cadence is not proof of displayed frame rate.

That experiment required an alternate X11 server and driver-specific workarounds.
The small Rust shim explored there was a thread-scheduling compatibility shim,
not a new X11/GPU driver. It is not bundled or silently enabled here. The
portable default remains the qualified CPU/Xorg path; no GPU or alternative
remote-desktop-product superiority is claimed.

## Reproduce and extend

See [CONTRIBUTING.md](../CONTRIBUTING.md) for disposable native, real-WebGL,
runtime persistence/MCP and full scroll/display checks. CI checks correctness on
native Linux amd64 and ARM64; hosted ARM64 is not a Raspberry Pi GPU or thermal
test. Keep hardware, versions, image/source identity, fixture, sample count and
timing boundary with new results. Keep raw operator logs/profiles out of this
public repository. Do not turn historical timings into flaky CI thresholds.
