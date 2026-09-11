# Experimental client-side Smart 2×

Select **Enhance → Smart 2× · Balanced / Quality · experimental** in the viewer toolbar.
**Original pixels** is the default and immediately disables the enhancement.
The preference is local to that viewer and survives reloads when local storage
is available. Other viewers, Hermes and shared Chromium are unaffected.

| Mode | Local processing | Intended trade-off |
| --- | --- | --- |
| Original pixels | No enhancement model or overlay | Default; original fidelity and lowest client cost |
| Smart 2× · Balanced | Four-layer small CNN, scalar detail residual | Lightweight experimental enhancement |
| Smart 2× · Quality | Seven feature layers, three fused RGB output heads | More client GPU work; an experimental quality candidate, not a guarantee of better text |

Only the selected model runs. Switching clears the overlay immediately, cancels
the old model and reprocesses original pixels; it never stacks two enhancements.
The existing Smart preference maps to Balanced. Both modes share the same
anti-ringing strength, damage/scroll/video rules and fallback budgets. Compare
the choices on the same settled page, especially small text and icons. Quality
is never selected automatically just because a client has a fast GPU.

Start with Auto resolution and 1×/Off HiDPI on a Retina/high-density monitor.
Smart 2× only runs when the displayed capture is enlarged by more than 5% in
physical monitor pixels. It automatically pauses when a capture is already
at native density, the viewer is hidden, or the display has no drawable space.
HiDPI and resolution retain their existing meanings; enabling enhancement never
changes either setting or sends a resize request.

## Client requirements and limits

- A trusted HTTPS viewer origin (or localhost), hardware WebGPU, a working
  OffscreenCanvas WebGPU presentation path, and the existing WebGL2 viewer.
  Plain HTTP on a LAN address is not a secure context. Missing support produces
  a visible Original/fallback status; do not bypass browser security flags.
- An Apple Silicon Mac is a candidate, but this is ordinary **GPU** computation,
  not Apple Neural Engine/Core ML/WebNN execution. Other supported GPUs can run
  the same WGSL model. Capability detection and a measured budget determine use,
  not an Apple-only user-agent check.
- Captures must fit the Full HD pixel budget: at most 2,073,600 pixels and no
  dimension over 4096. The 2× RGBA overlay at Full HD represents about 32 MiB;
  actual browser/compositor allocations can be higher. The convolution scratch
  size is fixed independently of capture dimensions. At a 144×144 input crop,
  intermediate and output buffers use about 0.63 MiB in Balanced versus 3.16 MiB in Quality,
  excluding textures, weights and browser overhead. Only one mode owns resources.
- There is no CPU/WASM inference fallback. Four consecutive patches over 20 ms
  after two warm-up samples disable enhancement. A 1.5 s work watchdog and 10 s
  initialization deadline also fall back. Toggle the option to retry after a
  failure; a hidden viewer releases resources and resumes when visible again.

The animation-trained CNNs can make enlarged edges/text look sharper, but
it does not recover missing factual detail. It can change glyphs, small icons
and image details. A conservative GPU-side range limiter preserves flat colors
and reduces ringing, but cannot guarantee faithful reconstruction. Use Original
for fidelity-critical reading or comparison. No universal quality/FPS claim is
made, and video super-resolution is not part of this first experiment.

## Presentation, not a new capture pipeline

The original framebuffer remains authoritative and immediately visible. A
separate transparent, pointer-ignoring canvas displays finished enhanced patches
under the existing cursor. Enhanced pixels never enter raw tile caches, video
textures, scroll-copy sources, screenshots taken via MCP, or network messages.

1. Patch `0032` emits opt-in **local** damage notifications after actual WebGL
   draws. Upload-only operations do not emit damage. With enhancement off, no
   damage event is constructed or dispatched.
2. Damage immediately clears affected enhancement cells, including neighboring
   cells whose convolution halo reads the changed pixels. The original view is
   exposed synchronously, without waiting for a model result.
3. A fixed 128×128 presentation grid coalesces pending work. Each crop includes
   an 8-pixel halo and is clipped to source bounds. Only one patch is in flight;
   revisions reject results overtaken by new damage. Resize/reconnect also fence
   old work and dispose its GPU resources.
4. Settled cells pass through the selected GPU model, 2× pixel shuffle and a
   conservative anti-ringing limiter. The model and pipelines initialize only
   after opt-in; weights ship with the frontend, without external model fetches.
   Balanced uses four spatial convolutions. Quality uses seven plus one fused
   RGB-head dispatch; all passes share one submission per patch. Both fit the
   same eight-pixel halo and use the same output dimensions.
5. Completed patch bitmaps populate the overlay and are closed immediately. The
   overlay is the bounded presentation cache. There is no idle full-frame loop.

Ordinary tile damage waits for 60 ms of stability; scroll regions wait for
120 ms, and video regions for 750 ms without further video updates. These waits
apply **only to optional enhancement**, not input, original tiles or video
presentation. Active scrolling/video therefore keep original pixels, and a
settled final frame can be enhanced later. Scrolling still uses arbitrary
integer-pixel CopyRect; this presentation grid does not change wheel ticks or
the wire tile grid. Reusing enhanced scroll cells is deliberately deferred.

Scheduling yields after at most four asynchronous patches or an 8 ms batch.
There is no JavaScript pixel readback or CPU model evaluation in production:
the adapter requests a cropped canvas-to-WebGPU copy, runs GPU math and presents
the result. Browser drivers may still perform internal copies/conversions;
this is not a universal zero-copy guarantee.

Capture resolution, Pi rendering/encoding, compressed payloads and network
bandwidth are unchanged. This feature spends **client GPU resources** to improve
local presentation; it does not itself reduce transmitted bytes or Pi CPU use.
Sending a lower-resolution capture with enhancement may be a future paired
experiment, not an automatic change in this implementation.
Quality does add about 34 KiB of unminified coefficient JSON to the bundled
frontend source, plus adapter code; this is a one-time frontend asset cost,
not additional browser-stream traffic. Both models remain bundled even when off.

## Verification and diagnostics

```sh
npm run build             # Includes strict enhancement TypeScript checks
npm test                 # Deterministic queues, lifecycle, fallback and scope guards
npm run test:client       # Upstream renderer and damage-notification regressions
npm run test:enhancement  # Also requires local Chrome with real hardware WebGPU
node scripts/audit-upstream.mjs
```

The browser check runs both models sequentially in one disposable browser and
one synthetic page, never a shared session or production profile. It compares odd-sized GPU output against
an independent CPU **test-only** oracle, checks whole-image versus halo-patched
output, verifies raw framebuffer identity, video bypass, pointer passthrough,
disable behavior and absence of external page requests. A separate 720p fixture
reports whole-view settle time including scheduling and initialization; patch
elapsed times are not GPU timestamp-query measurements or input latency.
Warm patch p50/p95 values use 40 repeated crops after warm-up. These synthetic
results check cost and correctness, not improved readability or model quality
across arbitrary websites. The small/medium distinction is also checked so a
selector-only change cannot pass as a second model.
The hardware check intentionally fails when WebGPU is unavailable instead of
claiming GPU qualification from a software renderer. Ordinary CI runs the
deterministic tests and type checks without requiring hardware or adding model
pacing delays.

For a labelled synthetic Original/Balanced/Quality PNG, set `BPANE_UPSCALE_PROOF_PATH` to an owned
scratch destination when running `scripts/check-smart-upscale.mjs`. Screenshots
and raw benchmark output are not tracked. The separate container-backed display
suite requires its disposable pipeline-viewer fixture; this local check does
not substitute for live deployment/capture qualification.

In the viewer console, `browserpaneEnhancement.diagnostics()` reports local
selected mode, status, completed/stale patches, pending cells, requested crop pixels and last
patch elapsed milliseconds. No page content, URLs, absolute timestamps or
telemetry is collected. Requested crop pixels include halos and do not measure
browser-internal memory traffic or network bytes.

See [model provenance and licenses](../client/enhancement/model/README.md).
