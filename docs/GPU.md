# Rendering configuration

There are two deployment modes: the default CPU/Xorg baseline and the
**experimental custom Xorg/Vulkan pipeline**. The complete operator instructions
are in [README: rendering modes](../README.md#rendering-modes), including device
discovery, paired builds, enablement, validation, video options and rollback.

## Configuration contract

- `compose.yaml`: standard Xorg dummy display and software Chromium rendering;
  no graphics-device mounts or display sidecar.
- `compose.yaml` + `compose.gpu.yaml`: `BPANE_GPU_MODE=v3d`,
  `BPANE_X11_BACKEND=gpu-dummy`, `BPANE_GPU_TAIL=1`; selects
  `Dockerfile.gpu-dummy` target `gpu-live-display`.
- `BPANE_GPU_BROWSER_IMAGE` selects the matching browser derivative
  (default `browserpane-hermes-browser:gpu-local`). Build it with
  `Dockerfile.gpu` over the current base application.
- Device paths and groups come from `scripts/gpu-devices.sh`, run on the host.
  Both processes remain UID 10000 with narrowly mapped devices and no added
  capabilities. The sidecar has no network.
- The Chromium namespace sandbox stays active. The GPU scheduler shim is
  inherited by Chromium only, never the host/gateway/display processes.
  Readiness rejects software fallback, missing rasterization/compositing,
  GPU-process crashes and an unresponsive capture worker.
- Only `dummy` and `gpu-dummy` are accepted X11 backends; both use the exact
  sole-output `DUMMY0` resize contract. GPU mode requires `gpu-dummy`.

The custom Vulkan path is opt-in and Pi 4/V3D-focused. GPU rendering alone does
not guarantee source-video decoding, outgoing-video encoding, faster pages or
lower total resource use. The CPU transport, driver submissions and viewer
decode work do not disappear.

See [live pipeline and recovery](GPU_LIVE_TEST.md),
[optional source-video decoder](GPU_VIDEO_DECODE.md),
[driver architecture](../native/gpu-dummy/README.md) and
[security boundaries](SECURITY.md). Performance checks must use one disposable
browser and compare the same geometry, workload, viewer and complete backend
resource accounting.
