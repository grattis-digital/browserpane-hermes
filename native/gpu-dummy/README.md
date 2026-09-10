# Experimental GPU-backed X11 virtual display

This is a new Xorg DDX, not a patch claiming that `xf86-video-dummy` becomes
accelerated. A dependency-free **Rust core** owns bounded geometry and the
synthetic Present clock; a small **C ABI adapter** uses the installed Xorg headers
and delegates rendering/buffer handling to Mesa/glamor. It is not a pure-Rust
X server, a kernel driver, or an end-to-end zero-copy capture implementation.

Status: **experimental**. The GPU Compose option selects this driver's live
Vulkan target; CPU Compose does not. The isolated display tests cover EGL pixels,
resize, Present and lifecycle, not universal browser/driver compatibility.
See [operator enablement](../../README.md#rendering-modes) and
[live capture, video and recovery](../../docs/GPU_LIVE_TEST.md).

## Implementation

- `src/geometry.rs`: exact dimensions, checked size arithmetic, 32–8192 pixels
  per axis and a 64 MiB per-root allocation ceiling. This is not a total GPU-memory
  quota; old/new roots coexist briefly during resize and clients own other pixmaps.
- `src/clock.rs`: monotonic 60 Hz presentation in the adapter, with fractional
  frame periods derived from an epoch rather than accumulated rounding. At most
  256 queued events, duplicate rejection, cancellation and no idle frame timer.
  It is a virtual clock, not physical scanout timing or a throughput guarantee.
- `src/ffi.rs`: opaque Rust-owned state. Only fixed-width scalars, booleans and
  pointers to bounded output arrays cross FFI; no guessed Xorg struct layouts.
  Xorg's main thread owns all calls; timers are cancelled before freeing state.
- `abi/driver.c`: one render node at `/dev/bpane-render`, verified as the kernel
  `v3d` DRM render device. EGL must report V3D. No KMS, DRM master, connector,
  physical monitor, console, input-device access or software-fallback switch.
- `abi/surface.c`: glamor GPU root pixmap, cleared before publication; resize
  preserves the overlapping area and replaces existing window backing references.
  Allocation failure leaves the current root intact. Ordinary X11 readback remains
  supported and still synchronizes/copies pixels to CPU memory.
- `abi/randr.c`: one `DUMMY0` output, origin-only, no rotation/transform/multihead.
  Revalidation uses Xorg's full root-clip lifecycle, including existing GCs and
  child windows. Arbitrary accepted mode names do not change the 60 Hz clock;
  only 59–61 Hz progressive modelines are accepted in this experiment.
- `abi/present.c`: real copy-present via Xorg, bounded timer delivery and GPU
  submission. No fictitious pageflip, scanout-completion or explicit-fence claim.
- `abi/dri3.c`: fresh render-node file context per client, with device identity
  checked against the server FD. Standard glamor import/export/format/modifier
  APIs handle buffers; there is no custom CPU-shadow copy implementation.

Glamor can fall back for individual unsupported operations. A V3D renderer string
is necessary, but does not prove that every draw, import or capture is GPU-only.
Context-loss recovery currently means failing/restarting this isolated display;
the live target wires display-generation changes to browser/session recovery.

## Local checks without GPU access

The default-off [GPU frame-lease experiment](../../docs/GPU_FRAME_LEASE.md)
adds three bounded GPU snapshots (two tile/ACK slots plus one video slot), per-slot accumulated damage and DMA-BUF/native
fence transfer to a separate GPU consumer. Its exact RGB compute probe reads only
a 64-byte change mask during comparison. Run the finite Pi pilot with `--lease`
to enable it in an owned disposable display. The live target connects these leases to BrowserPane's Vulkan capture/cache path.
GPU snapshot copies and synchronization costs still exist.
The separate `--compare-lease` pilot tests cached shader layouts and safe
positive-only/bidirectional early exits on immutable GPU frames; see the
[methodology and limits](../../docs/GPU_COMPARISON_LAYOUTS.md). It leaves the
reference shader and production stack unchanged.

From the repository root:

```sh
cargo fmt --manifest-path native/gpu-dummy/Cargo.toml --all --check
cargo test --manifest-path native/gpu-dummy/Cargo.toml --locked --offline
cargo clippy --manifest-path native/gpu-dummy/Cargo.toml --locked --offline --all-targets -- -D warnings
docker build -f Dockerfile.gpu-dummy --target test-display -t browserpane-gpu-dummy:fixture .
docker build -f Dockerfile.gpu-dummy --target gpu-display -t browserpane-gpu-dummy:driver .
docker build -f Dockerfile.gpu-dummy --target gpu-check -t browserpane-gpu-dummy:check .
python3 scripts/test-gpu-dummy.py
python3 scripts/test-gpu-dummy-pilot.py
python3 scripts/check-gpu-dummy.py --software-image browserpane-gpu-dummy:fixture --gpu-image browserpane-gpu-dummy:driver
```

The fixture is a **separate compile-time binary**, with a conspicuous
`BPANE_TEST_SOFTWARE_ONLY` marker. It exercises the same ABI, geometry, root
replacement, Present and lifecycle, but substitutes CPU pixmaps and omits EGL/
DRI3 initialization. An environment variable cannot enable it in `gpu-display`.
The negative test requires the real driver to fail without DRM, including its
`BPANE_GPU_INIT_FAILED` diagnostic. Do not run the harness with Python `-O`.

The harness creates UUID-labelled, network-free, UID10000 containers with no
devices, mounts, host ports or browser. It checks immutable image/ownership before
starting/restarting/removing them and cleans up only those exact containers.
The protocol probe checks full pixels through GetImage and MIT-SHM, timed
NotifyMSC/copy-present, live child windows across exact resize, overlapping scroll
copies, rejected resize without geometry mutation, and container restart.
It explicitly requires exit code zero before restarting: merely reaching a new
ready server can hide corruption during the previous process's shutdown.
Printed Present intervals are broad hang/deadline checks, **not frame-latency
benchmarks**. CI is configured to run this software-only gate on native amd64/ARM64; it does not
publish these experimental images or contact hardware.

`gpu-check` additionally verifies that the GLES runtime library can be loaded at
build time; this catches packaging omissions without claiming hardware execution.
Optional `asan-test-display` instruments the C adapter and can replace the
software fixture above. Xorg, Rust and Mesa are not sanitizer-instrumented and
leak detection is disabled; a pass is not a whole-stack memory-safety result.

## Isolated Raspberry Pi qualification

Use only an explicitly authorized development host/test session. The standalone
`compose.gpu-dummy-test.yaml` creates a laboratory display, not an application
override. Do not combine it with `compose.yaml` or `compose.gpu.yaml` and do not
point an existing browser/profile at it. It has no restart loop or readiness
watchdog: a hung driver fails qualification rather than repeatedly restarting.

Review device identity with `bash scripts/gpu-devices.sh`. Supply the verified
`BPANE_GPU_RENDER_DEVICE` and `BPANE_GPU_RENDER_GID` in a private environment file.
The lab deliberately grants only the render node, not the VC4 display node.
The read-only `/dev/dri` bind is name visibility; the device-cgroup allowlist is
the access boundary. Failure with this boundary must be investigated, not fixed
by granting all devices, privileged mode or host networking.

After choosing an unused Compose project name and verifying that it owns no
pre-existing resources, the intended operator sequence is:

```sh
docker compose -p bph-gpu-dummy-lab -f compose.gpu-dummy-test.yaml config --quiet
docker compose -p bph-gpu-dummy-lab -f compose.gpu-dummy-test.yaml up -d --build
docker compose -p bph-gpu-dummy-lab -f compose.gpu-dummy-test.yaml exec -T gpu-dummy-test timeout 15 bpane-display-probe
docker compose -p bph-gpu-dummy-lab -f compose.gpu-dummy-test.yaml exec -T gpu-dummy-test timeout 15 bpane-egl-probe
```

Use `--env-file` if the private settings are not in `.env`. `bpane-egl-probe`
requires V3D and checks twelve alternating GPU-rendered X11 EGL swap/readback
frames. It deliberately waits for pixels and is not a speed test. This probe is
now exercised successfully on Pi 4 V3D. Passing it does not prove
Chromium's ANGLE path, every DMA-BUF modifier/fence case, or viewer behavior.
Check the exact project's containers/labels/images before stopping/removing it;
never delete application volumes. No host Xorg installation or reboot is needed.

For a finite, automatically cleaned qualification instead of manually managed
Compose resources, build `gpu-check` and run `scripts/gpu-dummy-pilot.py` on the
authorized Pi. It needs local Docker permission and a pre-created private output
directory (mode 0700); it does not SSH or choose a host for you:

```sh
python3 scripts/gpu-dummy-pilot.py --image browserpane-gpu-dummy:check \
  --render "$BPANE_GPU_RENDER_DEVICE" --render-gid "$BPANE_GPU_RENDER_GID" \
  --output-dir "$BPANE_PILOT_OUTPUT" --benchmark
```

The harness verifies ARM64 image identity, the actual V3D device/ownership, and
its exact UUID-labelled container boundary before lifecycle operations. It uses
512 MiB RAM, 128 MiB SHM, 128 MiB temporary storage, 128 PIDs and low CPU shares;
no hard CPU quota is introduced. It rejects low available host RAM or high
temperature between bounded phases, not through a continuous safety watchdog.
It compares pre-existing running container identities/start times/restart counts
before and after, removes only its own container, and keeps private JSON evidence.
Do not publish raw reports: they include host and container metadata. Do not use
Python `-O`. Failed checks remain failures, including cleanup or service changes.

`--benchmark` runs a V3D EGL-to-full-frame MIT-SHM pixel oracle on the custom
display: swap interval zero, 1280×720, 10 warm-up frames and 60 measured frames
with every pixel verified. Drawing includes `glFinish`; presentation/capture
includes waits and repeated reads. Verification is outside the timing boundary.
This serialized component diagnostic is not the live GPU capture path, viewer
FPS or browser input latency.

`--damage` runs six native EGL updates and compares ordinary swaps with known
24×24 surface-damage rectangles, observing XDamage before full pixel verification.
Use `--backend glamor --damage`; do not combine it with `--benchmark`.

Test missing devices, context loss, resize, scroll, video, reconnect and
sandboxed Chromium on the exact paired application/display build. The finite
standalone driver probe is not a substitute for these acceptance gates.

## Dependencies and attribution

The separate [Vulkan frame-lease consumer](../vulkan-lease/README.md) explores
storage-image diff, GPU-only prefix compaction and final-payload gathering in the
`vulkan-check` target. Its component targets are isolated; the opt-in live target uses the same Vulkan
implementation with this display driver and the paired application bridge. Its hardware harness uses the same isolation
and private-evidence policy as the display pilot.

The image builds the adapter against distribution Xorg headers and loads it in
the same Debian release's server. The loader checks the compiled video ABI. Base
image manifests are pinned; apt packages are not byte-pinned. The local build used
Xorg 21.1.16 (`2:21.1.16-1.3+deb13u3`), Mesa 25.0.7 and Rust 1.93.1. Requalify after
any Xorg/Mesa/Chromium/kernel update; copying the `.so` into an arbitrary host Xorg
installation is unsupported. New code retains the repository's AGPL-3.0-only
terms; dependencies retain their original licenses, not a new project license.

Implementation references were the [Xorg 21.1.16 source release](https://www.x.org/releases/individual/xserver/xorg-server-21.1.16.tar.xz)
(`glamor`, `present`, `randr`, `fb`, `dix/window.c`), and
[xorgxrdp](https://github.com/neutrinolabs/xorgxrdp) for established headless
glamor initialization/resize patterns. Their implementations are not vendored or
patched here. Mesa/GBM/glamor remain responsible for actual GPU programming.
