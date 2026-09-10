# Vulkan GPU frame-lease pipeline experiment

Default-off, finite component test. Not a production capture backend, GPU video
encoder, new transport or browser deployment. X11/glamor, Chromium and the existing
tile/cache protocol remain unchanged. No browser or tab is launched.

The connected [GPU cache/encoding follow-up](../../docs/GPU_CACHE_ENCODING.md)
is selected separately with `--tail`. It replaces the raw-output endpoint with
GPU-generated Fill/CacheHit/QOI/ScrollCopy frames and ACK-controlled state. The
original comparison and audit modes below remain available and unchanged.

## Data path

The hardware probe imports the existing [GPU frame leases](../../docs/GPU_FRAME_LEASE.md)
into Vulkan storage images using their actual DRM format, modifier, stride, offset
and DMA-BUF FD. It imports the producer sync-file as a temporary binary semaphore
and acquires foreign queue-family ownership. Unsupported formats/modifiers fail
closed: there is no CPU image upload, implicit application conversion, or hidden
application-side copy into an alternative input texture.

One pre-recorded command buffer performs these logical stages:

1. Exact RGB comparison and uniform-colour classification, one 16×16 workgroup
   per 64×64 tile, with sixteen pixels per invocation. Independent output words
   avoid cross-workgroup atomics on a packed dirty mask. Shared-memory atomic OR
   and explicit memory/execution barriers remain inside each workgroup.
2. A bounded, stable exclusive prefix scan compacts commands and raw-payload
   slots independently. At most 510 tiles are admitted at 1920×1080; the scan has
   512 entries. Unchanged tiles generate no command, solid changed tiles generate
   Fill, other changed tiles generate Raw. No global append counter is required.
3. A fixed-capacity gather dispatch reads the GPU-generated count and commands.
   Unused/fill workgroups return uniformly. Only raw tiles are read again and
   gathered; partial edge tiles have deterministic zero padding.

Compute-to-compute storage barriers order these passes. Intermediate buffers are
allocated once and **never mapped**. Only the final output buffer is persistently
host-mapped. The CPU waits for one final completion fence, then copies its header,
occupied commands and raw-payload prefix. It does not inspect flags/counts to decide
what GPU work to submit between passes. The compacted list is an internal GPU
format, not a change to BrowserPane's public wire protocol.

The final header is 16 bytes, each occupied command 16 bytes, and each Raw slot
16,384 bytes. An unchanged frame therefore returns 16 bytes, one changed Raw tile
16,416 bytes, and a fully changed solid 1080p frame 8,176 bytes. These are CPU
readback amounts, **not network bytes**: Raw pixels have not received QOI/Zstd
encoding. Persistent device output reserves bounded worst-case capacity; tiny
emitted output does not mean tiny allocation or zero GPU memory traffic.

## Raspberry Pi constraints

- The experimental image sets `BPANE_GPU_LEASE_LAYOUT=uif`. Lease snapshots
  explicitly request Broadcom UIF tiling with `GBM_BO_USE_RENDERING`, without
  `GBM_BO_USE_SCANOUT`. The ordinary driver keeps its existing allocator when
  this variable is unset or `legacy`; unknown values fail allocation. The
  separate `BPANE_GPU_LEASE=1` opt-in is still required. Only lease snapshots
  change allocation, not Chromium or the root display surface.
- Mesa 25.0.7 V3DV adds 64 bytes of TFU read-ahead padding, rounded to 4 KiB,
  even for imported storage-only images. A page-sized GBM image with exactly
  the reported required bytes is therefore rejected at memory import. The UIF
  allocator uses a short-lived GBM layout template and public V3D `CREATE_BO`
  allocation to reserve one additional page. It imports that fresh BO back into
  GBM with identical dimensions, modifier, stride and offset, then clears it on
  the GPU. There is no template-pixel copy or CPU image mapping. Never fake this
  padding by increasing image height: height changes the UIF memory layout.
  This setup allocation is separate from per-frame processing. The minimal
  vendored UAPI declaration retains its Broadcom MIT notice; no private driver
  structures or GPU command-submission ABI are used.
- The first hardware attempt rejected legacy LINEAR leases with
  `VK_ERROR_FORMAT_NOT_SUPPORTED`: this V3DV version does not support them as
  storage images. Do not work around that rejection with CPU image uploads.
  Mesa's GLES sampler path instead creates tiled shadow textures for linear
  2D resources. External sharing prevents its usual unchanged-buffer shortcut;
  this is an allocation issue worth testing independently of shader/API choice.
- Select actual Mesa V3DV and verify its DRM render-device identity against the
  explicitly granted render node. Never silently select lavapipe on the Pi.
- CPU-visible memory is normal on UMA. It does not mean the CPU executes shaders.
  Only the output allocation is mapped/accessed by this implementation.
- Do not use `vkCmdDispatchIndirect` here. The pinned Mesa 25.0.7 V3DV path
  implements it using a CPU job to read dispatch parameters. Fixed dispatch sizes
  with GPU-side bounds checks avoid that specific dependency.
- Storage-image import requires support for the precise format/modifier/usage
  combination. Use formatless readonly image loads with the required feature,
  preserving RGBA/BGRA interpretation instead of reinterpreting imports as R32UI.
- Prefix scan uses ordinary shared-memory operations, not optional subgroup scan
  or ballot capabilities. Shader work and all loops have fixed upper bounds.

## Reproduction

From the repository root:

```sh
python3 scripts/test-vulkan-lease-results.py
docker build -f Dockerfile.gpu-dummy --target vulkan-check -t browserpane-vulkan:check .
```

The build compiles C with warnings as errors, compiles GLSL into SPIR-V, validates
SPIR-V, and runs the complete owned-image fixture matrix on software Vulkan with
Khronos validation enabled. Software results establish correctness only, never
Pi GPU performance. The default `gpu-display` target does not acquire Vulkan
dependencies. `vulkan-artifacts` exports the driver, ARM64 consumer and shaders for small
local-build transfers; runtime Vulkan/Mesa dependencies must still match.

The explicit `--software` fixture requires Mesa llvmpipe and allows up to
30 seconds per Vulkan completion wait for cold software-shader compilation or
slow CI scheduling. This is a maximum, not a sleep or retry. Hardware probes and
live Pi rendering retain the two-second limit, including video conversion.
There is no environment override, and a live context cannot select the longer
deadline. Timeout/device errors still fail; all pixel/cache/video checks and
the Docker build's outer 110/180-second limits remain active. A native fake-driver
regression checks both deadlines, single-call behavior and error propagation.

The explicit hardware entry point is `scripts/vulkan-lease-pilot.py`. Supply
`--image`, `--render`, `--render-gid` and a private existing `--output-dir`, as for
the existing display pilot. Keep `gpu-dummy-pilot.py`, `gpu_compare_results.py` and
`vulkan_lease_results.py` beside the script. Use `--validate` in a separate
diagnostic run; do not combine its timings with clean qualification.
`--inspect-inputs` adds an intrusive full source-pixel oracle before processing
to investigate readiness/layout failures; its output is separately labelled and
must not be accepted as clean timing.

The harness uses a new labelled, network-disabled, read-only UID10000 container,
512 MiB memory, 128 PIDs, low CPU shares and only the V3D render node. It checks
exact identity before actions, uses a 90-second workload deadline, checks host
pressure between phases, removes only its own container, and verifies pre-existing
service identities/start/restart records. Sharing the physical GPU still means a
driver fault or GPU contention could affect other clients. This is not hardware
fault isolation. All host-specific reports remain private, outside the repository.

## Evidence and comparison contract

The matrix includes 1280×720, 1365×767 and 1920×1080. Each size tests unchanged
textured content, a 24×24 change, a full solid replacement, a last-pixel one-level
colour change, and a 13-pixel scroll with a fixed header and independent overlay.
Every case has two warm-ups and eight measured rounds for the complete Vulkan
pipeline and an almost-empty shader using the same final submission/readback path.

The CPU oracle independently predicts changed tiles, stable compact order, Fill
colours, Raw slot assignment, every gathered pixel, padding and counts. Real X11
source/destination frames also receive full GL pixel oracles after each entire
timed case. Failure, partial matrices, invalid timings and validation errors are
not accepted as performance evidence.

These are repeated immutable-pair measurements. Fixture drawing/acquisition/
import, producer-fence draining, pipeline creation/recording and CPU correctness
checks are outside the reported processing span. Acquisition/import and preparation
wall times are reported separately. A live implementation must queue acquisition
and processing together, not copy this intrusive producer-draining test boundary.
Final output readback includes completion wait and occupied-payload memcpy.
`cpuMs` measures only the calling thread, not driver workers, kernel/Xorg work or
total-system energy. Software Vulkan rendering workers are especially excluded.

The hardware run also measures the existing GLES reference and positive-probe
comparisons on the same imported image pair, **after** Vulkan completes and
releases foreign ownership. The earlier GLES-first order intermittently missed
changed tiles; full source reads before processing masked that race. In the
pinned V3D source, the EGL native input fence is consumed by render-job submission,
but CSD submission waits the local output sync object rather than consuming that
input fence. Vulkan's explicit semaphore wait now establishes readiness without
CPU pixel reads or sleeps. This is a fixed-order component comparison, not a
balanced API benchmark or proof that standalone GLES lease consumption is safe.
Those GLES kernels produce only a 64-byte dirty
mask; Vulkan additionally classifies, compacts and gathers. The workloads and
dispatch layouts differ, so this is a useful component comparison, **not proof
that changing the API alone produces a particular speedup**. Eight samples are
exploratory, not a robust tail-latency estimate. No browser FPS is inferred.

## Remaining integration gates

Real frame turnover, resize/lifecycle recovery under load, explicit consumer
completion transfer back to the producer, GPU content-cache/moved-region reuse,
client acknowledgement/recovery, compression and viewer transactions are separate
work. In particular, compaction alone does not recognize scrolled cached pixels:
the scrolling fixture may gather most of the frame. Preserve the existing reuse
stack when integrating; do not replace it with full-frame video.

GPU lossless encoding is not implemented by labelling Raw gathering an encoder.
Measure it separately against the existing CPU codecs. No production promotion,
new listener, host package installation or public-repository push follows from a
successful component test.

## Initial Raspberry Pi 4 result

V3D 4.2, Mesa 25.0.7, Xorg 21.1.16, real exported UIF leases. The final ordering
passed one Khronos-validation run and two separate clean runs across all fifteen
cases, including exact gathered-pixel/edge-padding oracles. The existing lease
lifecycle/scroll suite also passed with the UIF allocator. No Chromium, production
display or browser tabs were used. Pre-existing service identities/start/restart
records were unchanged and all owned test containers were removed.

Ranges below are the two clean **per-run medians**, eight measured samples per
case per run. They include submission, final completion wait and copying occupied
output, but exclude fixture/import/producer preparation and correctness checks.
The Pi remained an active shared host, not an idle or clock-locked benchmark;
the disposable consumer used the low CPU shares described above:

| Case | 1280×720 | 1920×1080 | Final readback bytes |
| --- | ---: | ---: | ---: |
| Unchanged textured frame | 6.47–6.68 ms | 14.32–14.86 ms | 16 |
| One 24×24 patch | 6.45–6.94 ms | 13.89–14.70 ms | 16,416 |
| Full solid replacement | 6.61–6.76 ms | 14.24–14.63 ms | 3,856 / 8,176 |
| Non-aligned scroll + overlay | 22.24–25.54 ms | 46.25–46.62 ms | 3,936,016 / 8,364,016 |

Calling-thread CPU medians for the first three cases are approximately
0.09–0.19 ms. This is **not** total-system CPU. For scroll, raw-output copying
alone takes 7.21–10.12 ms at 720p and 17.03–17.29 ms at 1080p; the GPU work and
completion wait also increase. CPU-free intermediate stages have been achieved,
but keeping the CPU out of large raw-payload handling has **not**.

For context, the GLES reference dirty-mask-only kernel on these same UIF images
takes 12.18–12.51 ms for unchanged 720p and 26.70–26.78 ms at 1080p; its positive
probe variant takes 9.55–9.76 ms and 21.37–21.39 ms. This is not the production
baseline, not the same amount of work, and not evidence of a universal speedup:
GLES can stop early for changed tiles, whereas the current Vulkan classifier also
checks uniformity and gathers Raw payloads. No main-branch end-to-end comparison
has been performed here. Neither a 5 ms 1080p target nor full GPU encoding has
been reached.

Before assigning the observed completion time to shader execution, use the
[stage/CPU/synchronization audit](../../docs/GPU_STACK_AUDIT.md). It compares
single waits and batches, removes classification in a separate exact-diff kernel,
measures whole-process CPU, and optionally reads per-client kernel engine/job
counters without inserting timestamp-query commands.

GPU-side cached-content reuse and compact encoding **before** host output access
remain integration requirements, with separate producer/compute/encode/output measurements.
Moving uncompressed scrolling frames through this pipeline is not a replacement
for BrowserPane's existing tile/cache stack. Retain its recovery semantics.

Primary references: [DRM modifier import](https://docs.vulkan.org/refpages/latest/refpages/source/VkImageDrmFormatModifierExplicitCreateInfoEXT.html),
[FD memory ownership](https://docs.vulkan.org/refpages/latest/refpages/source/VkImportMemoryFdInfoKHR.html),
[sync-file import](https://docs.vulkan.org/refpages/latest/refpages/source/VkImportSemaphoreFdInfoKHR.html),
[V3DV indirect dispatch](https://gitlab.freedesktop.org/mesa/mesa/-/blob/mesa-25.0.7/src/broadcom/vulkan/v3dv_cmd_buffer.c#L4401),
[V3D linear sampler shadows](https://gitlab.freedesktop.org/mesa/mesa/-/blob/mesa-25.0.7/src/gallium/drivers/v3d/v3dx_state.c#L1109),
[shared-resource shadow refresh](https://gitlab.freedesktop.org/mesa/mesa/-/blob/mesa-25.0.7/src/gallium/drivers/v3d/v3d_resource.c#L1020),
[V3DV import padding](https://gitlab.freedesktop.org/mesa/mesa/-/blob/mesa-25.0.7/src/broadcom/vulkan/v3dv_device.c#L2210),
[V3D compute submission](https://gitlab.freedesktop.org/mesa/mesa/-/blob/mesa-25.0.7/src/gallium/drivers/v3d/v3dx_draw.c#L1567),
[native input-fence consumption](https://gitlab.freedesktop.org/mesa/mesa/-/blob/mesa-25.0.7/src/gallium/drivers/v3d/v3d_job.c#L648).
