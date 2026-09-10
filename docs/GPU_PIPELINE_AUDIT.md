# GPU pipeline audit

Status: experimental. See [deployment modes](../README.md#rendering-modes) for
the exact selectable configurations. Component tests and source inspection are
not a claim of universal hardware acceleration or end-to-end latency.

## Boundaries to measure

| Stage | CPU baseline | Experimental GPU path |
| --- | --- | --- |
| Chromium | Software rendering under the default flags | Sandboxed V3D/ANGLE on X11; page JavaScript and browser coordination still use CPU |
| Xorg | Standard dummy framebuffer | Rust-core/glamor DDX with GPU-backed root pixmap; unsupported operations can fall back |
| Capture | X11/MIT-SHM CPU-readable pixels | Immutable GPU frame leases with explicit completion/ownership |
| Damage and scroll | CPU tile analysis and repair | Exact Vulkan comparison, candidate scroll verification and residual repair |
| Classification/cache | CPU flatness, hashes and bounded caches | GPU flatness, fingerprint-filtered exact cache matches and acknowledged metadata |
| Lossless encoding | CPU codecs | GPU QOI, prefix scans and final command packing |
| Video region | CPU capture/encode | Optional Pi 4 Vulkan crop/NV12 plus hardware V4L2 encoder |
| Transport/viewer | CPU networking; viewer decode/composition | Same transport; CPU networking and viewer QOI decode remain |

GPU-resident images do not remove GPU bandwidth, fence waits or driver submission.
Standard Xorg GetImage can download pixels even when the source pixmap is
GPU-backed. Use the frame-lease consumer rather than routing its images back
through that CPU capture interface. XDamage is a wake-up hint, not proof of exact
changed pixels. DMA-BUF sharing is not automatically zero-copy across every driver.

The custom driver delegates actual rendering to Mesa/glamor. It does not fake
DRM master, physical scanout or pageflip completion. Its synthetic Present clock
is bounded and monotonic, not a guarantee of viewer presentation cadence.
See [driver contracts](../native/gpu-dummy/README.md).

## Ownership and recovery

The tile path keeps one acknowledged and one pending immutable frame; a third
bounded slot serves independently paced video. A stale ACK never advances cache
state. Resize, disconnect, failed output and cache misses revoke dependent state
and require a complete refresh. Scroll copies are proposals with exact residual
repair, not assumptions that all page content moved together.

The private same-UID socket carries encoded output, not full raw frames.
GPU-worker progress and listener health drive bounded display/session recovery.
Preserve the host, gateway, viewer, lease driver and worker as a matched set.
See [live pipeline](GPU_LIVE_TEST.md), [frame leases](GPU_FRAME_LEASE.md) and
[cache/encoding](GPU_CACHE_ENCODING.md).

## Qualification

Use one disposable browser, no competing browser, fixed geometry and synthetic
content. Measure sparse input, arbitrary-pixel wheel/scrollbar movement,
independently animated regions, resize, video entry/exit and reconnect.
Full-frame pixel comparisons are correctness oracles outside timed intervals;
they are not the live capture/transfer design.

Report input-to-visible latency, encoded and IP-layer bytes, combined
browser/display CPU and memory, GPU work, fence waits and dropped/presented video
frames separately. Trace-off runs establish performance; diagnostic timings
attribute costs. Software Vulkan, source inspection and successful image builds
cannot replace Pi hardware tests. No component percentage is an end-to-end claim.

Relevant implementation references include the pinned Xorg/Mesa provenance in
[the driver guide](../native/gpu-dummy/README.md), the
[capture-project research](GPU_CAPTURE_RESEARCH.md) and the
[Vulkan stack audit](GPU_STACK_AUDIT.md).
