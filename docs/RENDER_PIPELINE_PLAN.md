# Small-footprint, sharp, low-latency rendering

The user-defined objective is the smallest practical **end-to-end footprint**:
sharp text/UI, small updates delivered promptly, strong bounded caches and
intelligent damage/scroll handling, saving Pi resources without visual holes or
sluggish recovery. GPU utilization, raw capture FPS and smallest compressed
payload in isolation are not the success criteria. More compression can cost too
much CPU/latency; larger caches can cost too much memory. Measure those tradeoffs.

## Actual baseline, not a screenshot streamer

Source audit: pinned `UPSTREAM_COMMIT` plus all 22 ordered patches, pristine replay
checked against the generated sources. Paths below are within
`upstream/code/apps/bpane-host/src/` or `upstream/code/web/bpane-client/js/`.

1. `tile_loop/run.rs` skips unchanged frames and applies the existing capture
   cadence. On an admitted frame it currently reads the X11 root through reusable
   MIT-SHM/GetImage storage. That is a **readback boundary**, not raw-frame network
   streaming. `capture/x11.rs` preserves damage arriving during processing.
2. `tile_loop/cdp_scroll*` and `scroll_*` reconcile input/CDP hints, actual sampled
   pixel motion, static browser chrome and exact residual repair. Scroll reuse
   avoids re-sending already-present content; exposed strips and changed interior
   areas still require correct pixels.
3. `tile_loop/dirty_set.rs` conservatively narrows the emit set against XDamage
   bounds, including both unshifted and shifted tile grids. A forced snapshot,
   resize or lost baseline deliberately broadens work for correctness.
4. `tiles/emitter.rs` first skips valid same-position content, then reuses a
   dimension-aware content-addressed cache, then emits Fill or new lossless
   Zstd/QOI tiles. Separate static/content position tables and reused scratch/
   codec state are already present; replacing them with naive tile hashes would
   discard existing optimizations.
5. The retained host/gateway protocol sends tile commands and batch boundaries,
   not screenshots. Reliable stateful deltas and separately handled video have
   different recovery rules. Gateway lag closes the affected viewer for a fresh
   snapshot instead of dropping dependent scroll/cache commands silently.
6. The real client decodes/reuses cached tiles, applies ordered batches, reuses
   GPU textures and performs scroll copies, with Canvas2D fallback. Framebuffer
   correctness depends on valid epochs and cache recovery, not just arrival of a
   BatchEnd. Missing decoded content requests a fresh independent snapshot.
7. Video region ownership, encode/decode, and return-to-lossless repair remain
   part of the system. `video_tiles` defaults are retained; do not disable them
   silently to improve a benchmark.

The [GPU full-frame microbenchmark](GPU_DUMMY_QUALIFICATION.md) exercises none
of steps 2–7. It is useful to isolate readback and GPU correctness, but cannot
select the best complete backend or establish wire bandwidth/interaction speed.

## Measurement contract

Run the same synthetic workloads through **Chromium → real host capture/tile
loop → gateway/WebTransport → actual viewer decoder/cache/compositor**. Keep
resolution/DPI, codecs, cache bounds, Chromium/Mesa revisions, input sequence and
resource policy fixed. Retain the actual protocol, including full snapshots only
where required. Use fresh disposable profiles; separate cold connection and
warm-cache phases. Neither a raw SHM test nor a substitute tile decoder is the
end-to-end baseline.

| Workload | Important evidence |
| --- | --- |
| Settled idle and tiny text/hover/caret updates | Idle wakeups/CPU, missed final updates, admission-to-pixels, bytes per input |
| Cold initial view, then repeated content | Bootstrap cost separately from position skips, content/texture cache hits and new payload bytes |
| 32/64-pixel scroll, non-aligned scroll, reversal | Copy/reuse rate, exposed-strip bytes, residual repairs, final exact pixels |
| Fixed/sticky content, nested/horizontal scrolling | Conservative damage and correct coordinate/epoch handling, not just fast happy-path scrolling |
| Cache eviction/missing tile, decode fault, reconnect | Bounded repair cost/time, no holes requiring another user scroll, no cascading repair flood |
| Resize/HiDPI and partial edge tiles | Correct physical geometry, bounded memory, proper invalidation and sharp output |
| Small animated/video region and exit | Region ownership, tile/video bytes, encode/decode queues, lossless text and clean exit repair |

Report these independently, not as a single misleading FPS score:

- Actual viewer input event to matching completed viewer pixels: p50/p95/p99,
  missing samples and queue age. A rAF callback is not paint; a submitted GL draw
  is not physical monitor scanout. Clearly name the measured boundary.
- Application tile/video/control bytes, command counts and cold/warm cache reuse;
  report actual UDP/QUIC bytes separately when measured. Do not label decoded
  pixels or application payload counts as wire packets.
- Pi CPU time, available/cgroup memory, GPU memory where observable, readback
  pixels/bytes/waits, dirty/encoded tiles and queue high-water marks. Keep thermal,
  firmware-throttling availability and background load beside the results.
- Exact settled pixel/geometry checks and transient marker continuity. Do not
  blur text, under-report damage or skip recovery to manufacture savings.

Do not sum phase percentiles or subtract unsynchronized host/viewer clocks.
Use paired alternating runs, deterministic inputs and no site-pacing policy in
standard tests. Keep diagnostic phase logging separate from final performance
runs because logging and pixel oracles have overhead.

## Instrumentation added in this increment

`scripts/viewer-pipeline-metrics.mjs` records **real-client** counter deltas at
the existing scroll-integrity checkpoints: payload bytes, batches, Fill/QOI/Zstd,
cache reuse/misses, scroll copies/savings/exposed/interior repairs, snapshot
headers and video counters. New sessions and counter resets are explicit; cold
and warm values are never silently subtracted across reconnects. This observes
existing public counters without changing codecs, cache limits or draw scheduling.

The same oracle optionally summarizes the existing `BPANE_CAPTURE_TIMINGS=1`
host records: capture, scroll, classification, dirty/residual, encode/channel-send
and cadence waits. Host records are an aggregate bounded log sample, **not** an
exact input/frame trace. Checkpoint windows include settling and truth-capture
overhead, so neither elapsed time nor bytes per batch is advertised as latency/FPS.

Run locally with fresh labelled resources and loopback-only ports:

```sh
node --test test/viewer-pipeline-metrics.test.mjs
BPANE_CAPTURE_TIMINGS=1 node scripts/test-viewer.mjs browserpane-hermes:YOUR_BUILT_IMAGE
```

This currently validates the CPU/X11 bundle and a fresh local Chrome viewer.
It is not yet a Pi GPU comparison. Existing pixel/reconnect/cache-loss tests stay
enabled; normal production telemetry remains unchanged and opt-in timings stay
off by default. Reports remain in ignored `test-results/` and require privacy
review before publication.

### Initial whole-pipeline correctness/accounting run

The fresh local ARM64 Linux CPU/X11 bundle plus Chrome 152.0.7977.77 viewer
(Apple M4 Pro/ANGLE Metal) passed all **16 exact scroll/recovery checkpoints**
and the separate **27-stage display-control oracle**, with no page errors or
unexpected downloads. This uses the actual gateway/WebTransport/client stack,
not the standalone EGL probe. The scroll workload's initial root was 1280×688;
do not compare its phase timings directly with the 1280×720 Pi microbenchmark.

The sixteen 32-pixel list steps produced 16 scroll-copy commands and 512,526
tile-command bytes; sixteen 64-pixel steps produced 15 copies, 76 actual cache
hits and 914,026 tile-command bytes. Host candidate-reuse counters were 100% and
87.5%, respectively. Those denominators describe the host's scroll candidates,
**not all pixels or bytes saved**: new strip/boundary/chrome tiles still travel.
The forced cache-loss and decoder-failure stages each reported one missing-tile
event, one new snapshot header and exact final pixels without a repair scroll.

The optional host log sample contained 101 admitted captures, with median capture
362 µs, scroll 276 µs, classification 300 µs, dirty/residual 33 µs and encode/
channel-send 1,034 µs; median total was 2,589 µs. Different phase percentiles do not
sum. These are local diagnostic distributions including varied cold/warm/fault
work, not Pi timings, input latency or a speedup claim. They illustrate why one
display readback microbenchmark cannot identify the whole-system bottleneck.

Six new counter/parser unit tests pass; all 270 wrapper tests and exact pristine
replay of 22 patches/821 generated files pass. All disposable test containers were
removed. That checkpoint did not measure Pi-to-viewer latency/wire/CPU. The
follow-up pilot below addresses the synthetic tile path; active video workloads
and the new GPU driver's application integration remain outstanding.

## Pi-to-viewer synthetic baseline

The explicitly authorized [Pi-to-viewer pilot](../scripts/render-pilot/README.md)
now implements input-to-readable-pixel timing on the real compositor, independent
quiescent X11/viewer truth checks, actual source-scoped IP-byte accounting and
cgroup CPU/memory checkpoints. It compares the same image in CPU/dummy-Xorg and
retired GPU/software-mirror configurations; the experimental DDX is not silently substituted. CI
runs only its no-hardware ownership/firewall/pixel-observer unit tests, never its
LAN workload. Its test-only proxy/context trust boundary is documented separately.

Two alternating pairs (CPU → retired GPU/software-mirror → CPU → retired GPU/software-mirror), same ARM64 application
image/source/settings and 1280×720 root, passed **320 measured inputs**, 48 warmup
inputs and **20 exact settled full-surface checkpoints**. Each mode/workload has
40 measured samples; all timeouts would fail and remain in the private reports.
Remote content was 1280×577 at DPR1, with the same 143-pixel browser chrome in
both modes. The fresh Chrome 152.0.7977.77 viewer used Apple M4 Pro/ANGLE Metal.
The Pi was a 4B/8 GB; the GPU path reported V3D 4.2.14.0/Mesa 25.0.7, enabled
compositing/rasterization, active sandbox and zero GPU-process crashes. The final
repeat additionally checked GPU status after the workload. Chromium's video
encode/decode feature status remained software; this is not end-to-end GPU media.

Pooled **input-event to readable matching viewer pixels**, milliseconds (not
physical scanout, native wheel, page-load timing or a general website benchmark):

| Synthetic action | CPU p50 / p95 | retired GPU/software-mirror p50 / p95 | Mean outbound IP bytes/input, CPU / GPU |
| --- | ---: | ---: | ---: |
| 24×24 marker change | 59.1 / 90.3 | 84.4 / 145.1 | 463 / 490 |
| 32-pixel scroll | 95.6 / 134.8 | 103.1 / 153.9 | 19,221 / 20,063 |
| 64-pixel scroll | 95.4 / 164.4 | 108.0 / 174.5 | 9,696 / 10,086 |
| Cached return scroll | 97.6 / 159.3 | 101.1 / 140.4 | 9,338 / 9,688 |

The largest measured latency was **395.8 ms** on GPU half-tile scrolling; it is
included, not discarded. These small non-randomized run pairs with uncontrolled
background load (roughly 6–8 one-minute load average) do not establish a universal
backend ranking or isolate the causal cost of GPU rendering. Temperature at
phase endpoints was approximately 54–56.5°C, with over 3 GiB available memory.
No test cgroup CPU throttling or OOM kill was observed. This page does not exercise
heavy shaders, real websites, network loading, installed AdBlock or active media.

The sparse marker emits exactly **279 tile-command bytes/input** in both modes;
IP counts also include QUIC/UDP/IP/control/ACK overhead, not Ethernet overhead.
Real cached-return reuse totaled 2,652 client hits in each mode, with no cache
misses/evictions or unexpected snapshots during the measured phases. These are
synthetic repeating rows; don't extrapolate the hit rate to arbitrary content.
Initial connection is checked for exact pixels separately, not benchmarked as
a cold-bootstrap bandwidth or first-frame-latency result.

Both 3-second idle intervals per mode had zero application tile bytes/batches;
each still exchanged one small QUIC packet each way. Sampled idle CPU was
0.19–0.33 cores for CPU versus **0.58–0.59 combined browser+display cores** for
retired GPU/software-mirror. Endpoint combined memory was about 444–466 MiB versus 487–500 MiB;
these are not memory peaks or complete GPU-memory accounting. The diagnostic
checkpoint/wait overhead is included in resource intervals. Thus low wire traffic
does not imply negligible idle host work, and this light workload does not show
a GPU footprint/median-latency win.

All four completed runs restored their exact temporary firewall rules and removed
their browser/display containers, socket volumes and dedicated networks; the
original service inventory (IDs/images/start times/restart counts) was unchanged.
Earlier harness failures are preserved privately: wrong kernel driver/mode
names, Docker's nullable OOM default normalization, and an ambiguous two-canvas
locator. The early cleanup refusal was resolved against the exact recorded IDs;
the guard now accepts only the equivalent null/false OOM setting, retains rules
on incomplete cleanup and preserves empty assertion failures as failures. No live
service/profile, host package/boot setting or production ingress was changed.

Eleven new Node observer/oracle/RPC tests and eight no-hardware Python ownership/
firewall tests pass; all 281 wrapper tests, workflow syntax validation and exact
pristine replay of 22 patches/821 source files pass. Production rendering code,
default Compose, cache limits, codecs and protocol remain unchanged. This
increment establishes a repeatable hardware baseline; it does not claim that the
new driver has been integrated or the readback optimizations below implemented.

## Next implementation priorities

The sparse fixture changes a 24×24 marker, while the admitted capture currently
reads the 1280×720 root into reusable storage before filtering/emission. The source
therefore identifies a concrete candidate: selective readback for trustworthy
sparse damage. That is **not** a promise of an equivalent network-byte reduction;
the emitted lossless sparse tiles are already tiny. A regional implementation
must avoid replacing readback with a full-frame baseline copy between the two
rotating buffers. Track each buffer's valid history and repair only stale regions,
with a full invalidation path for unknown damage, resize or failed capture.

Two further source-level checks must accompany optimization: idle small-damage
suppression must not strand a final update without another input, and scroll
reuse must not corrupt fixed chrome or shifted-grid residuals. The synthetic
keyboard pilot alone does not exercise inactive-page final-damage throttling,
native wheel/smooth scrolling, video transitions or missing-cache recovery.

### Bounded streaming and buffer ownership

Information should move downstream without repeated materialization. The target
is an ownership-aware stream of necessary changes, not a new full-frame push
pipeline or an unbounded chain of asynchronous jobs:

- Lease a small fixed pool of capture/snapshot buffers. A producer may recycle a
  buffer only after all consumers and GPU fences have completed; a cheap borrowed
  view into mutable/reused storage is not a valid copy elimination.
- Let damage selection, exact comparisons and tile analysis share the same
  coherent source. Feed suitable tile/video consumers from that immutable source
  rather than capturing the same pixels twice, subject to their differing cadence,
  format, region-ownership and synchronization requirements.
- Move owned encoded buffers downstream or share immutable buffers where needed.
  Audit actual allocations/copies before replacing them: the capture loop already
  rotates reusable storage, the emitter already reuses codec scratch, and gateway
  broadcast already shares frames with `Arc`. Do not remove lifetime-protecting
  copies without replacing their ownership contract.
- Keep the existing reliable tile stream and appropriate video datagrams. Small
  commands need not become one QUIC stream or syscall each; measure bounded
  batching/flush thresholds against both packet overhead and input latency.
- Apply byte/age-aware backpressure. Stop producing unnecessary work early instead
  of buffering stale updates. Scroll/cache/offset commands are dependent state:
  overload must preserve their order or establish an independent snapshot epoch,
  never arbitrarily discard packets and continue drawing against missing history.

This is the design criterion for follow-up changes, not a claim that the current
implementation is zero-copy or has all these bounds. Fences, socket transport,
codec formats and GPU/CPU boundaries sometimes require synchronization or copies.

### Ordered work

1. **Extend the matched Pi whole-stack baseline.** Preserve the new pilot's real
   viewer/settings, independent pixel oracle and separate cold/warm observations;
   extend coverage to native scrolling, final idle damage, recovery and video.
   Do not change live services or open ports implicitly. The new driver
   additionally needs its remaining DRI3/lifetime,
   explicit backend, sandbox/recovery and viewer correctness gates.
2. **Move conservative damage knowledge earlier.** Candidate: maintain a coherent
   frame baseline and read only damaged regions when safe. First measure how much
   admitted damage is truly sparse. Preserve damage arriving during processing,
   both grids, chrome overlays, video ownership and full invalidation on unknown
   damage, resize, lost baseline or failed capture. Do not feed stale pixels to
   scroll/classification to reduce readback numbers.
3. **Avoid repeated analysis and payload work.** Measure overlapping classifier,
   scroll/residual and emitter scans. Reuse exact results where their coordinate,
   pixel format and epoch contracts match. Compare per-region damage against the
   current conservative bounding box before choosing a more complex GPU dirty
   mask. Keep collision/recovery rules and bounded caches intact.
4. **Bound work in flight by bytes and age, not only message count.** The current
   host/gateway channels are count-bounded, while viewer batch sequencing uses a
   promise chain. Establish actual queue depth/age and memory before changing
   flow control. Protocol Frames are often tile commands, not complete captured
   images; queue capacity divided by FPS is not a latency estimate. Safe overload
   handling must preserve dependent batches or establish a fresh snapshot epoch.
5. **GPU/codec changes only at measured boundaries.** GPU snapshot/difference
   reduction, selective readback and video color conversion can avoid work;
   merely moving compression or tiny bookkeeping to the GPU can add dispatch,
   synchronization and memory cost. Keep client texture reuse and sharp lossless
   text; never infer viewer hardware support from server GPU support.

Promotion requires improved matched footprint/latency results with no correctness,
recovery, memory or sandbox regression. No universal target FPS or superiority
claim is established yet. Changes stay local until publication is authorized.
