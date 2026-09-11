# Backporting the rendering work

`UPSTREAM_COMMIT` pins the original BrowserPane source. The canonical source is
the tracked wrapper plus `patches/*.patch` in filename order; `upstream/` is an
ignored generated snapshot. Docker prepares it automatically. Original upstream
history, attribution and AGPL terms remain; this guide does not grant an alternate
license.

## Patch map

Patch `0032-local-presentation-damage.patch` is frontend-only. It marks the WebGL
canvas and emits opt-in local damage events after every visible draw, including
video destinations, scroll regions, clear and resize. It changes no protocol,
capture policy, caches or input. Pair the hook with its notification tests.
The optional consumer lives in `client/enhancement/`: a bounded WebGPU model
adapter and separate, revision-fenced presentation cache. Backport its lifecycle,
halo, pixel-oracle and failure tests with it; do not filter the authoritative
framebuffer used by scroll-copy. See [client upscale](CLIENT_UPSCALE.md).
The Balanced/Quality selector and medium RGB model are wrapper-only additions
using that same hook. Keep their weight pins, fused-head shader, eight-pixel
halo and model-switch cancellation tests together; neither mode changes the wire.

GPU consumer recovery is tracked directly in `native/vulkan-lease/live-watch.*`,
the live listener/loop, `runtime/gpu-dummy-start.sh` and the wrapper's GPU health
checks. It does not change the viewer wire protocol or require a new upstream
patch. Backport the paired display/browser health changes and fault regressions
together; retain normal idle/parked behavior and bounded, same-UID health access.

Patch `0031-bounded-video-burst-presentation.patch` follows `0030`. It fences
both sides of keyframe delivery, rejects overtaken pre-IDR deltas using existing
wire timestamps, tolerates short decoder bursts and retains at most three
decoded viewer frames with a 50 ms stale-backlog policy. No wire change or
prebuffering timer is added. Its deterministic queue, reset and ordering tests
must accompany it; report texture commits separately from decode submissions.

Patch `0030-video-stability-and-delivery.patch` builds on `0028`/`0029`: one
bounded metadata-probe retry, finite GPU hint grace, independent bounded gateway
egress lanes with codec/keyframe ordering, and honest viewer presentation
counters. Pair it with the native pixel-level video-edge exclusion in
`tail-analyze.comp` and its synthetic boundary/move/exit cache tests. No new
wire format, network listener or CPU pixel path is introduced. The gateway lane
and viewer telemetry changes can be evaluated separately for backporting;
GPU-specific hint timing depends on the paired native video pipeline. See
[GPU_LIVE_TEST.md](GPU_LIVE_TEST.md) for limits and verification commands.

The [Pi video-decode candidate](GPU_VIDEO_DECODE.md) is wrapper/package work,
not another BrowserPane rendering patch. Its pinned Raspberry Pi Chromium
patches and MIT h264ify dependency belong to their respective upstream projects.
Keep the image, explicit decoder mapping and readiness checks together; do not
claim hardware playback from a package build or a generic GPU-rendering check.

Patch `0028-experimental-gpu-video.patch` adds stable/expiring CDP video-region
hints, bounded GPU-worker H.264 output forwarding and screen-geometry validation
for late viewer frames. It requires `0027` and the matching native Vulkan/V4L2
worker, shaders and optional video Compose layer. The native conversion/encoder
is in `native/vulkan-lease/video-*.c` and `shaders/video-nv12.comp`; no FFmpeg
screen-capture path is re-enabled. See the [video setup and verification
boundaries](GPU_LIVE_TEST.md#optional-pi-4-hardware-video-regions).

Patch `0027-experimental-gpu-tail-integration.patch` pairs the encoded-byte host
bridge, gateway admission/refresh, wire messages and viewer applied-batch ACK.
It is opt-in and requires the native lease/encoder and display entrypoint; do
not backport only one side. See [GPU_LIVE_TEST.md](GPU_LIVE_TEST.md).

The separate [GPU-backed Xorg driver experiment](../native/gpu-dummy/README.md)
is original `native/gpu-dummy/` code, not a new upstream rendering patch. Its
Rust core, C/Xorg adapter, image and protocol tests must travel together. The explicit GPU Compose live target uses this driver with the Vulkan lease
consumer, encoded-output bridge and recovery watchers. Do not cherry-pick only
a driver binary or assume software-fixture passes qualify the full stack.

The [compact MCP experiment](COMPACT_MCP.md) is original wrapper code, not an
upstream rendering patch. Its observation, replay and transport layers can be reviewed independently
of these rendering patches. The pinned generic Playwright MCP settlement-timer
issue is documented with measurements; this branch bypasses that orchestration,
without modifying or claiming to fix all later upstream releases.
The later [scoped observation extension](MCP_SCOPED_OBSERVATIONS.md) **does** patch
the pinned Playwright dependency, separately from these rendering patches.
Backport its installer, four-file hash checks, server coverage/ref contract and
real-browser tests together. Do not copy edited `node_modules` or assume a new
Playwright version has equivalent private internals. It does not modify CDP,
Chromium, the X11/GPU capture stack or the viewer protocol.

Paths below are relative to upstream `code/`. Host means
`apps/bpane-host/src`, gateway means `apps/bpane-gateway/src`, and client means
`web/bpane-client/js`. Patches include their focused regression tests.

| Patch | Primary files | Change |
| --- | --- | --- |
| 0001 capture scheduling | Host `capture/x11.rs`, `config/`, `tile_loop/{run,dirty_set,classify,mod}.rs` | Damage ordering, idle/capture cadence, buffer reuse |
| 0002 tile cache/transport | Host `tiles/{emitter,sent_hash_cache}.rs`, `tile_loop/emit.rs`; gateway `session_hub/refresh.rs`, `transport/egress.rs` | Bounded LRU, dimension-aware content identity, reusable Zstd; fresh join/lag recovery |
| 0003 client rendering | Client tile cache/compositor, `render/`, session video/surface runtimes | GPU tile reuse/accounting, reliable video ownership, bounded decoding, context-loss recovery |
| 0004 capture diagnostics | Host `tile_loop/run.rs` | Opt-in `BPANE_CAPTURE_TIMINGS=1` phase logging |
| 0005 scroll memory locality | Host `scroll/detect.rs` | Exact contiguous-column search and differential/benchmark tests |
| 0006 video exit repair | Host `tile_loop/{run,h264_region,emit}.rs`, `tiles/emitter.rs` | Fresh lossless repair after relinquishing video ownership |
| 0007 scroll integrity | Host `scroll/residual.rs`, `tile_loop/scroll_*.rs`, `dirty_set.rs`, `integrity_tests.rs`, `tiles/emitter.rs` | Exact regional repair, cross-grid position validity, coalesced full recovery |
| 0008 client scroll integrity | Client `render/` scroll-copy/command/draw runtimes and `tile-compositor.ts` | Exact clipping and failed-batch recovery barrier |
| 0009 gateway integrity | Gateway `session_hub/`, `transport/{egress,bootstrap,negotiation}.rs` | Fail closed on unusable deltas, bounded/retired H264 bootstrap state |
| 0010 exact sub-tile reuse | Host `scroll/`, `config/`, `tile_loop/{scroll_send,scroll_residual,integrity_tests}.rs`, `tiles/emitter.rs` | Exact 32-pixel copy policy and fractional-row position invalidation |
| 0011 capture alignment | Client resize/surface/session runtimes and public types | Opt-in physical 8×2 alignment and matching fractional CSS |
| 0012 static position repair | Host `tiles/emitter.rs`, `tile_loop/integrity_tests.rs` | Invalidate static positions throughout whole-row copy region, including partial bottom rows |
| 0013 exact dummy modes | Host `capture/ffmpeg.rs` | Validate and apply exact DUMMY0 geometry; acknowledge only verified applied size |
| 0014 display control API | Client public/session/resize/surface APIs and option validators | Live explicit physical capture size and local density, locked-viewer authority, listener cleanup |
| 0015 internal listener isolation | Gateway `app/builders/runtime.rs`, `config/gateway.rs`; upstream `deploy/start-host.sh` | Separate optional admin bind from transport bind; optional CDP proxy disable for colocated MCP |
| 0016 failed-resize state restoration | Host `cdp_video.rs`, `cdp_video/resize_tests.rs` | Attempt restoration of the prior window state even when the intermediate numeric-bounds request fails |
| 0017 browser-owned window resize | Host `cdp_video.rs`, `cdp_video/{resize_tests,browser_resize_tests}.rs` | Keep top-level window commands on a browser-level CDP connection that survives the identifying tab closing |
| 0018 drawable renderer fallback | Client `session-surface-runtime.ts`, `render/session-canvas-factory.ts` | Finalize renderer/context before mounting; replace rejected WebGL canvases with drawable Canvas2D, fail explicitly if neither exists |
| 0019 virtual display validation | Host `capture/ffmpeg.rs` | Only dummy/gpu-dummy accepted; shared exact-root/sole-DUMMY0-output geometry contract |
| 0020 external X11 startup | Upstream `deploy/start-host.sh` | Opt-in DRI3 display readiness without deleting another server's socket or spawning dummy Xorg |
| 0021 restore without extra tab | Upstream `deploy/start-host.sh` | Recheck saved session state on every supervised launch; keep initial URL only for a fresh shared profile |
| 0022 deterministic token retry tests | Gateway tests `apps/bpane-gateway/tests/compose_api_surface/support.rs` | Use one Tokio clock for retry deadlines/sleeps; paused-clock retry, timeout and immediate-success assertions |

Patch names are descriptive; use the actual ordered filenames, not this table,
as the application manifest. The bundle sets the 0015 gateway API bind to loopback
and disables the unused CDP proxy; defaults stay compatible for other upstream
consumers. See [SECURITY.md](SECURITY.md) for the wrapper's trust boundaries.

## Contracts that must travel together

Do not arbitrarily cherry-pick cumulative patches because their concepts look
independent. Later patches refine earlier behavior and depend on its context.

- Host, gateway and client recovery are one contract. The gateway's full-snapshot
  request reuses `CacheMiss { frame_seq: 0, col: 65535, row: 65535, hash: 0 }`.
  An old host does not acquire these semantics just because the wire schema is
  unchanged. Ordinary zero hashes are also valid uncacheable repair metadata.
- A full refresh captures fresh pixels, discards pending pre-snapshot scroll
  copies and sends the grid/draw mode/offset plus every visible row, including
  offset edge coverage. Ordinary cache misses are coalesced into this recovery
  path. The client aborts the failed batch and dependent deltas until a complete
  new snapshot batch, with reconnect as a bounded fallback.
- Lost stateful broadcast commands cannot be safely skipped. Gateway lag closes
  that stream so reconnect requests a new snapshot; it must not silently resume
  later scroll/cache commands.
- Client video ownership from 0003 and backend retirement/repair from 0006 must
  agree. Clearing only a dirty bit is insufficient if a position hash suppresses
  an unchanged tile that still needs to replace a video overlay.
- 0010 keeps content-addressed L2 entries but invalidates both physically moved
  position tables for fractional-row copies. Use it with the residual and client
  integrity fixes, and 0012's later whole-row/static correction. The copy quantum
  defaults to 32; the browser wheel-step default was not changed to 32.
- 0011 aligns requested capture dimensions; 0013 separately checks actual X11
  geometry. Neither alone fixes every mismatch. In particular, libxcvt can name
  a 1360×768 mode while producing 1366 active pixels. The exact-mode helper is
  limited to the virtual DUMMY0 display, not a physical monitor timing override.
  The special case is present in the [libxcvt 0.1.2 source](https://www.x.org/releases/individual/lib/libxcvt-0.1.2.tar.xz),
  `lib/libxcvt.c`, lines 294–299.
- 0014 is backward-compatible opt-in client configuration, not a new remote
  Chromium DPR protocol. Fixed capture sizes remain fixed when local CSS density
  changes. The wrapper controls and their tests are separate tracked files.
- 0016 fixes cleanup after a CDP resize error, independently of the X11-mode
  verification in 0013. It restores only the state this operation temporarily
  changed; normal/minimized windows are not forced maximized. A failed bounds
  request or failed restoration still returns failure. This is not a retry,
  persistent window-state policy, or guarantee that a disconnected CDP peer can
  be restored. The protocol and native resolution acknowledgement are unchanged.
- 0017 resolves the visible page's window ID and prior state before mutation,
  then opens the browser-level `/json/version` WebSocket for window commands.
  Page hints and device emulation remain page-scoped. Browser connection failure
  aborts before normalization; a vanished window returns failure without
  retargeting another window. Keep 0016's restoration-on-error behavior. This
  protects tab closure during resize, not a Chromium-process crash or every
  asynchronous window-manager transition.
- 0018 preserves automatic hardware selection and the Canvas2D software policy.
  A canvas cannot change context type after WebGL creation, even after losing
  that context; all cursor/recording/video/resize consumers must receive the
  final drawable canvas. Real-browser failure injection validates context
  ownership and exact Fill/QOI/Zstd/cache/scroll pixels; it is not a GPU
  performance claim.
- 0019/0020 travel with the GPU wrapper, Mesa/shim image, private X11 sidecar and
  generation watcher. They do not enable GPU by themselves or weaken the exact
  virtual-root gate. Keep physical outputs rejected and CPU defaults unchanged.
  See [GPU configuration and qualification](GPU.md).
- 0021 is independent of GPU mode. A positional startup URL is additional to
  session restoration, so omit it when the bundle's `Default` profile has session
  records larger than Chromium's eight-byte header. Preferences, empty files and
  closed-tab-only records do not count. This is a conservative presence check,
  not validation or repair of Chromium's session format; Chromium still owns
  restoration. The header is two `int32_t` fields in Chromium's
  [session storage implementation](https://chromium.googlesource.com/chromium/src.git/+/34e2627ec26ed07f0398ede339e323c4b39d44fe/components/sessions/core/command_storage_backend.cc).
  Keep the check inside the restart loop and retain `--app=` behavior.
  Never close existing tabs or rewrite session files. A backport supporting named
  profiles must resolve its selected profile instead of assuming this bundle's
  single `Default` profile. Executable shell regressions and the disposable
  runtime's exact tab-list checks cover this wrapper contract.

The video wire format still has no ownership generation identifier. Immediate
re-entry into the same rectangle can admit an older in-flight frame within that
newly authorized region; the bounded retirement checks are not a new wire-level
ordering guarantee.

Patch 0022 is an independent, test-only correction, not a rendering or runtime
change. The inherited retry unit test could spend its entire 100 ms wall-clock
budget descheduled on a loaded CI runner. Its async sleep and deadline now use
Tokio's clock; unit runtimes start paused and assert exact virtual elapsed time,
attempt counts and the final failure cause. The existing `test-util` dev feature
is sufficient. Do not change only the test attribute: Tokio's paused clock does
not affect `std::time::Instant` ([Tokio 1.50 clock documentation](https://docs.rs/tokio/1.50.0/tokio/time/fn.pause.html)).
Real Compose callers retain real-time waits and the same timeout/retry settings.
No native regression is skipped and no CI timing budget is enlarged.

## Rebuild and verify from the pin

Patch 0029 corrects the experimental GPU-video cadence introduced in 0028.
The host accepts multiple bounded access units between complete tile batches;
geometry, framing, region revocation and incomplete-batch rejection remain.
Its private header version 2 requires the paired native display worker. Backport
with the three-slot lease policy, independently owned video Vulkan/codec worker,
atomic output serialization and revocation checks, not just removal of the host
one-frame gate. The existing viewer protocol and tile ACK/cache contracts stay
unchanged. See [GPU live testing](GPU_LIVE_TEST.md) for scope and qualification.

The separate [Chromium surface-damage experiment](../native/chromium-damage/README.md)
targets Chromium commit `4999cc1efed37c4d91dc4ce6ec4b0a50e2a9a8cb`, not the
BrowserPane pin below. Its patch, overlay and exact source digests must travel
together. It is default-off and not yet compiled/qualified in Chromium. Do not
add it to the BrowserPane ordered series or backport only the EGL call: retain
logical-damage, sequence/producer, transition and failure guards with their tests.
The Chromium experiment is independent of the ordered BrowserPane patch series.

Patch 0023 adds default-off sparse X11 readback with two-buffer history repair,
conservative unknown/resize/video/error fallback, and diagnostic-only copy/request
accounting. It retains the tile protocol and needs the prior capture/damage fixes.
Keep all native regional/SHM/GetImage and late-damage regressions, not just the
flag. See [damage and human-scroll qualification](DAMAGE_SCROLL_EXPERIMENT.md).

Patch 0024 retains viewer pointer ownership until release, including outside-canvas
release, cancellation, capture loss and teardown. It is independent of regional
readback and changes no wire messages or wheel/grid policy. Retain its seven
pointer regressions and the native-thumb outside-release oracle when backporting.

Patch 0025 makes classifier hashing demand/region-aware behind an independent
default-off flag and reports exact damage/readback admission decisions. It depends
on 0023's verified regional-frame/history contract, not just raw damage hints.
Retain the differential hash and full classifier-lifecycle regressions.
Patch 0026 fixes dropped trailing pointer motion with a bounded latest-position
timer, preserving 0024's cancellation/release ownership. See
[damage-directed analysis](DAMAGE_DIRECTED_ANALYSIS.md) for scope and evidence.

```sh
npm ci
sh scripts/fetch-upstream.sh
node scripts/audit-upstream.mjs
npm test
npm run test:client
npm run test:linux
```

The fetch refuses to replace an existing nonempty snapshot. Move your generated
tree aside deliberately before regenerating it; never discard local work to make
a test pass. The audit independently extracts the pinned commit into an owned
temporary directory, checks/applies every patch with strict whitespace checking,
and compares all generated source bytes. It does not trust a reverse-only patch
roundtrip. Set `BPANE_UPSTREAM_REPO=/absolute/path/to/a/local/git/checkout` to use
an existing object store read-only instead of fetching the public source again.

For a new patch, save exact pre-edit originals outside the worktree, change only
the selected source/tests, and create a new ordered patch with `a/`/`b/` paths.
New/deleted files require their Git mode metadata; `/dev/null` must never become
an actual path. Run the pristine audit, affected unit/native tests and real pixel
regressions. Update this map and explain dependencies. Do not hand-edit old
patches to hide a newer correction or commit generated `upstream/`.

See [OPTIMIZATIONS.md](OPTIMIZATIONS.md) for bounded historical measurements and
[CONTRIBUTING.md](../CONTRIBUTING.md) for current test commands. Performance
benchmarks are opt-in diagnostics; CI correctness must not rely on Pi-specific
timing thresholds or credentials.
