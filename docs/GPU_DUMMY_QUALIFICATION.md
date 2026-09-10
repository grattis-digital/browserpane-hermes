# GPU dummy-driver qualification

Status: **bounded Pi 4 display correctness passes; application promotion is not
ready. The synthetic full-frame probe is not the BrowserPane workload baseline.**
This is evidence for the integration, not a production deployment.
The test sources are `native/gpu-dummy/tests/`, with the finite driver in
`scripts/gpu-dummy-pilot.py`. See the [driver guide](../native/gpu-dummy/README.md)
for reproducible commands and [pipeline audit](GPU_PIPELINE_AUDIT.md) for next gates.

## Boundary and hardware

The explicitly authorized pilot used a Raspberry Pi 4B revision 1.4, 8 GB RAM,
ARM64 Linux `7.0.0-1017-raspi`. It started only fresh UUID-labelled containers,
each with a verified immutable test image, UID10000, one V3D render device,
read-only DRM-name visibility, private X11/IPC, no network or published ports,
no capabilities, a read-only root and bounded temporary storage/memory/PIDs.
The workload had low CPU shares, not a CPU-count restriction or hard quota.

It did not access live X11 sessions, browser profiles, real websites or the MCP
service. Existing service IDs, image IDs, start times and restart counts were
unchanged in every report. Test containers were removed after ownership checks.
Private imported images and reports remain for diagnosis, not in this repository.
No host packages, boot settings, firewall, live services or GitHub refs changed.

The driver evidence uses Mesa `25.0.7-2+deb13u1` and Xorg
`2:21.1.16-1.3+deb13u3`. Base manifests are pinned; apt packages are not
byte-pinned. Requalify after dependency/kernel changes.

## Failures preserved and fixed

1. **Missing GLES runtime.** The first Pi image started V3D glamor and passed the
   X11 display oracle, but the EGL client aborted because `libGLESv2.so.2` was
   absent. The runtime now installs `libgles2`. The `gpu-check` build explicitly
   loads the library, and CI builds that target without claiming GPU execution.
2. **RandR mode ownership.** After that fix, both display and EGL pixels passed,
   but server shutdown aborted with `malloc_consolidate(): unaligned fastbin
   chunk detected` (exit 134). The adapter released an RRMode reference after
   transferring it to `RROutputSetModes`. Xorg adopts that reference rather than
   adding one; the extra release left a dangling output-mode pointer. The adapter
   now releases only on failed transfer. This is our driver bug, not an upstream
   Xorg fix. The contract was checked in Xorg 21.1.16 `randr/rroutput.c` and the
   established caller in `hw/vfb/InitOutput.c`.

The previous local harness restarted a container and checked the next server's
readiness, which missed the previous process's shutdown failure. The strengthened
normal software test reproduced exit 134 before the fix and passes after it.
Pi tests now require exit zero both before restart and at final shutdown.
An optional AddressSanitizer adapter fixture also passes, but did **not** detect
the original bug: Xorg/Mesa/Rust are not instrumented and allocator layout differs.
This is not a whole-stack memory-safety or leak proof.

## Correctness evidence

The fixed DDX passed three fresh Pi pilot runs, each with:

- V3D glamor initialization and a client EGL renderer check rejecting llvmpipe.
- Full-pixel GetImage and MIT-SHM oracles, exact RandR geometry, live child windows
  across resize, overlapping scroll copies and rejected invalid resize.
- Timed NotifyMSC and copy-present completion checks (not an FPS measurement).
- Twelve alternating GPU-rendered EGL swap/readback frames before restart and
  another twelve afterwards, plus clean server stop/start/final stop.
- Zero full-frame pixel errors in the synthetic capture workload and no reported
  container OOM. Every run cleaned up its own container and passed the unchanged
  pre-existing-service inventory check.

The display log also contains software **indirect GLX** initialization. The
qualified path is direct EGL/V3D; these results do not claim that every GLX API
or every Xorg primitive is accelerated. Primary DRM nodes remain ungranted; no
extra device access was added to silence incidental GLX/device warnings.

## Component measurement boundary

The standalone oracle serializes GPU draw, swap, synchronization and full-window
MIT-SHM capture, checking every pixel outside timing. It does not run Chromium,
a tile codec, video encoder, transport or viewer. It cannot select the fastest
live deployment: the Vulkan lease consumer avoids that CPU readback interface.
Comparisons against the removed display backend are intentionally not a runtime
recommendation. Use [the render pilot](../scripts/render-pilot/README.md) for
matched whole-pipeline comparisons.

## Interpretation and acceptance gates

Keeping Xorg pixmaps on the GPU is not enough when every admitted capture still
needs a complete CPU-readable image. In pinned Xorg, `glamor_get_image_gl` calls
`glamor_download_boxes`, whose transfer implementation uses `glReadPixels` into
CPU memory. This source evidence is consistent with the measured readback gap,
but does not attribute it precisely between synchronization, layout conversion,
memory copying and scheduling; that needs finer profiling.

The explicit GPU application path adds leases, Vulkan cache/encoding and recovery.
Requalify the paired stack for format/modifier/stride/offset handling, malformed
requests, FD/fence lifetime, context loss, resize, one shared Chromium session,
whole-viewer correctness and combined resource use. Standalone display results
do not establish those broader guarantees.

## Local verification

ARM64 image builds, Rust's seven tests/fmt/strict Clippy, C warnings-as-errors,
normal and ASAN software display oracles, clean lifecycle and real-driver
missing-DRM rejection passed. Python ownership/result tests passed (2 existing
and 7 pilot tests); all 270 wrapper unit tests passed after adding real-viewer
counter coverage. Standalone laboratory
Compose configuration validates. CI was adapted to build the GLES runtime check
and run pilot-unit tests without hardware; no hosted CI run or push was performed.
The separately instrumented local whole-viewer run and its limits are recorded
in [RENDER_PIPELINE_PLAN.md](RENDER_PIPELINE_PLAN.md); it does not qualify the Pi DDX.
