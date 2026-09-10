# Native damage metadata and GPU-resident processing

Local experimental diagnostic for patch 0026. This increment adds
reproducible diagnostics and a native EGL/XDamage oracle. It does **not** change
Chromium, promote the experimental DDX, or enable a GPU capture backend. No push,
merge or production rollout is implied. The existing 26 upstream patches and
normal tile/cache/scroll/transport behavior are unchanged.

## Measured result

The producer already knows about small changes. In two successful isolated Pi
Chromium traces, six synthetic updates each produced these compositor damage
rectangles, in order:

- `0,143 1280x577` (first marker update also invalidated the content area).
- `32,239 24x24`, twice (subsequent marker changes).
- `0,143 1280x577`, three times (32/64/reverse scroll updates).

Both traces recorded six ordinary `NativeViewGLSurfaceEGL:RealSwapBuffers` calls
at 1280×720 and six `egl::Surface::swap` calls; no `swapWithDamage` was recorded.
The final trace had 3,629 events / 830,249 bytes. Settled full-surface viewer/X11
correctness checks passed. Its 33 observed host captures all requested 921,600
pixels; none admitted regional readback. These are diagnostic observations, not
a one-to-one frame-ID join or clean latency measurements. The six CDP inputs
also produced six layer-tree changes but **zero** `LayerTree.layerPainted` events:
that event stream alone cannot safely authorize capture omission.

Hardware/configuration: Pi 4 V3D, Chromium 152.0.7977.75, ANGLE GLES/EGL,
GaneshGL, Mesa 25.0.7 bookworm backport, sandbox enabled, GPU process crash count
zero at the diagnostic observation. Browser image contained patch 0025, with
readback/analysis/timing diagnostics enabled. The existing pilot image precedes
0026's viewer pointer fix; these keyboard/CDP tests do not qualify pointer changes.

A second, independent experiment submitted known damage directly through native
Mesa EGL, without Chromium or a viewer. Both the retired software-mirror display display and experimental
Rust/glamor DDX preserved the supplied region:

| Producer operation | Root XDamage bounding area, each of 3 updates | Pixel oracle |
| --- | ---: | --- |
| Ordinary EGL swap | 921,600 pixels (1280×720) | Passed |
| EGL swap with known surface damage | 576 pixels (24×24) | Passed |

That is **1,600× less reported damaged area**, not 1,600× faster rendering, lower
wire traffic or an end-to-end speedup. The test submits a complete valid back
buffer in both cases; only the presentation metadata differs. Damage events are
collected **before** pixel readback. Full pixel reads then verify every pixel,
including the unchanged area. They neither choose the damage nor represent the
application's normal capture/transfer baseline.

Native test versions: Mesa 25.0.7-2+deb13u1, retired software-mirror display
1.15.0+dfsg-2.1~deb13u1, Xorg 21.1.16 distribution build. This is not byte-identical
to Chromium's bookworm Mesa client. Each backend used the same immutable native
test image and render node, no network, UID10000, bounded resources and a fresh
display. The DDX also passed its existing display/EGL checks before and after
restart. Original service inventory was unchanged and owned containers removed.

Negative results remain part of the evidence:

- The first Chromium diagnostic failed exporting its tmpfs trace with `docker cp`;
  cleanup succeeded, but that run remains failed. Export now reads inside the
  ownership-checked container namespace and creates a new private artifact.
- The first native test's initial pixel check failed with swap interval 1 and
  a fixed 200 ms wait on an idle, viewer-free retired software-mirror display display. The final fixture uses
  interval 0, as the existing native benchmark does, so it does not wait for the
  idle server's future MSC tick. This is a fixture scheduling correction, not a
  recommended Chromium flag or a production rendering fix.

## Where the metadata is lost

The pinned source agrees with the trace:

1. [Chromium's DirectRenderer](https://github.com/chromium/chromium/blob/152.0.7977.75/components/viz/service/display/direct_renderer.cc)
   observes compositor damage before deciding whether the output requires a full
   redraw. Without partial-swap support, it expands damage to the output viewport.
2. [SkiaOutputDeviceGL](https://github.com/chromium/chromium/blob/152.0.7977.75/components/viz/service/display_embedder/skia_output_device_gl.cc)
   derives that capability from `GLSurface::SupportsPostSubBuffer()`.
3. [NativeViewGLSurfaceEGL](https://github.com/chromium/chromium/blob/152.0.7977.75/ui/gl/gl_surface_egl.cc)
   checks NV post-sub-buffer support separately from KHR swap-with-damage support.
4. Chromium's pinned ANGLE revision is
   `736ed80c7552a4b267bd54a282b971aa4555cb3e`.
   [DisplayEGL](https://github.com/google/angle/blob/736ed80c7552a4b267bd54a282b971aa4555cb3e/src/libANGLE/renderer/gl/egl/DisplayEGL.cpp)
   advertises swap-with-damage, but not post-sub-buffer;
   [SurfaceEGL](https://github.com/google/angle/blob/736ed80c7552a4b267bd54a282b971aa4555cb3e/src/libANGLE/renderer/gl/egl/SurfaceEGL.cpp)
   leaves post-sub-buffer unimplemented.

The runtime advertised KHR swap-with-damage and buffer age, but not NV
post-sub-buffer. `disable_post_sub_buffers_for_onscreen_surfaces` was **not** an
active workaround. Disabling an unrelated Mesa workaround is therefore not the
fix for this run. Nor should we falsely advertise NV support: the
[KHR specification](https://registry.khronos.org/EGL/extensions/KHR/EGL_KHR_swap_buffers_with_damage.txt)
requires a valid complete back buffer and distinguishes surface damage from
per-buffer repair. The APIs are not interchangeable merely because both accept
rectangles.

## Next implementation contract

The [Chromium surface-damage source increment](../native/chromium-damage/README.md)
now implements the proposed metadata path for stage 1 behind a default-off flag.
Its immutable-source replay and standalone policy checks pass. A full Chromium
build and real-browser Pi qualification remain outstanding; this does not alter
the measured baseline above or complete the GPU-resident stages below.

The destination is GPU-resident image processing, including scroll verification;
not repeated CPU readback followed by GPU re-upload. Prefer existing compositor
metadata over running a new whole-screen comparison shader just to rediscover it.
The following remains the end-to-end contract; stages 2–5 are still proposed:

1. **Preserve logical surface damage independently of rendering damage.** Carry
   compositor damage through Viz/Skia's GL output to KHR swap-with-damage, even
   when the renderer must repaint its complete back buffer. Keep buffer repair
   independent. Resize, surface recreation, uncertain overlay/occlusion changes,
   coordinate/scale changes and lost history require conservative full damage.
   This needs a pinned, compiled Chromium change and real browser qualification;
   a driver shim cannot recover rectangles Chromium has already discarded.
2. **Acquire a coherent GPU frame lease.** Use the experimental GPU-backed X11
   path, correct DMA-BUF format/modifier/stride/offset import, producer completion
   and explicit consumer lifetime. The mutable root is not an immutable snapshot.
   Bound retained frames and ownership; never overwrite an in-use buffer or queue
   unbounded frames. Where ownership cannot transfer, account for any necessary
   GPU-to-GPU damage copy rather than calling it zero-copy. Union damage since the
   retained baseline when frames are skipped; resize/context loss resets it.
3. **GPU damage reduction and scroll verification.** Inspect authoritative dirty
   regions first. Use compositor transforms or input observations only to propose
   region-local translations, then compare the reused pixels on GPU. Exact
   comparisons, not hash/reference-point matches alone, authorize omission.
   Return compact dirty masks and verified scroll-copy operations, with their
   baseline generation. At 1280×720 with 64px tiles, a 240-bit mask needs 30 bytes
   before metadata; that is arithmetic, not a measured protocol payload.
4. **Retain the existing tile/cache protocol initially.** Feed verified dirty
   sets and scroll copies into its current ordering/recovery rules. Do not snap
   human scrolling to a global tile grid. Handle partial tiles/exposed strips,
   scrollbar dragging/reversal, sticky/fixed content, nested and diagonal scroll,
   animated overlays and fractional device-pixel movement. Ambiguous pixels are
   dirty, not silently omitted. Cache identity and the viewer's retained state
   must survive location changes without trusting an obsolete baseline.
5. **Read/encode only new payload.** Keep frames, comparisons and scroll copies
   on GPU; initially read only regions still needed by CPU lossless codecs. Reuse
   the same coherent frame for video consumers where the hardware/format permits.
   GPU compression/hardware video are separate measured gates, not a reason to
   replace sharp text tiles with a full-frame video stream. Compressed payload,
   control messages, transport and browser DOM/layout still involve the CPU.

The Pi shares physical memory between CPU and GPU: this is not a discrete-GPU
PCIe model. Track producer wait, import/format conversion, GPU dispatch/wait,
GPU copies, CPU-mapped bytes, explicit CPU copies, encoding, queue age and viewer
presentation separately. Do not insert `glFinish` into the production hot path
or assume asynchronous dispatch is completed work. Retain a bounded fallback.

Promotion requires the existing lossless/scroll/resize/reconnect/context-loss
oracles plus fence/resource-lifetime failures, mid-animation changes and human
wheel/drag traces. Measure p50/p95 input-to-visible latency, bytes and total
browser/display CPU on matched workloads **without tracing** before claiming a
benefit. A metadata pass alone does not qualify full GPU capture or scroll reuse.

## Reproduce the diagnostic, not a deployment

Use the [render pilot](../scripts/render-pilot/README.md) with an explicitly
approved disposable workload and `nativeDamageTrace: true` in its private config.
This mode skips normal latency phases and uses only the token-checked synthetic
page. Raw traces stay private; the summary exports bounded geometry/counts only.

For the native oracle, build `Dockerfile.gpu-dummy` target `gpu-check` for ARM64
and use the [display pilot boundary](../native/gpu-dummy/README.md).
Run `scripts/gpu-dummy-pilot.py` with an immutable image ID, verified render
node/GID, private output directory and `--backend glamor --damage`.
Do not combine `--damage` and `--benchmark`. Never use a live display.
Comparative observations below are component evidence, not a deployable backend.

Local verification: 300 wrapper Node tests, 12 render-pilot Python tests,
9 display-pilot Python tests and 2 driver-boundary tests; ARM64 probe compilation
with warnings as errors. The tracked Dockerfile's `gpu-check` ARM64 build and
runtime-library check also passed. The Node suite includes exact ordered-patch replay.
The measured native image reused the existing qualified display/Mesa base and
recompiled the probe locally, adding only its XDamage runtime dependency. Image
Config, RootFS, architecture and OS matched after import. No full Chromium build
or new DMA-BUF/compute backend was completed or qualified in this increment.
