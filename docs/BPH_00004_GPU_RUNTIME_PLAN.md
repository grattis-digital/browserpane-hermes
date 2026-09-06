# Opt-in Pi GPU runtime integration

Branch: `experiment/pi-runtime-recovery`, based on `4bfef255`. User-requested
follow-up: establish actual Chromium GPU rendering while preserving X11 capture,
the existing remote-browser experience, one shared session and persistent state.
Host-network repairs and operator-specific deployment details are not public
repository configuration or hardware benchmark evidence.

## Scope and invariants

- Keep the latest compact MCP, host/gateway/client rendering patches and CPU
  default. Do not deploy an obsolete render-only probe as the application.
- Add an explicit Mesa/V3D derivative and private DRI3-capable X11 sidecar.
  No VNC streaming, public control listener, second production browser, Docker
  socket, host networking or privileged container is introduced.
- Preserve Chromium's namespace/GPU sandbox, no-new-privileges and capability
  drops. Limit GPU I/O to driver-identified V3D-render and VC4-display devices.
  Keep stable source links and canonical libdrm path visibility distinct from
  the two-device cgroup access boundary.
- Preserve strict exact geometry: DUMMY0 by default, only explicit VNC-0 in
  GPU mode, one active origin-aligned output covering the complete capture root.
- Reject silent software fallback or lost GPU sandbox; recover when the external
  display exits, hangs or is replaced through existing container restart policy.
- Keep profiles, operator addresses, secrets and raw deployment records out of
  source, public documentation and CI. No paid model calls are needed.

## Implementation

1. Ordered patches 0019/0020 add typed virtual-display selection, exact VNC-0
   resizing and external-display readiness without changing CPU defaults.
2. GPU image/wrapper selects ANGLE GLES/EGL and tested narrow Rust scheduling
   compatibility. Browser HTTP/tile caches and transport are unchanged.
3. The opt-in Compose override supplies private X11 socket/IPC sharing, bounded
   display resources and stable driver discovery. The browser retains its normal
   memory cap unless the operator separately selects an override.
4. Browser-level read-only CDP checks enforce V3D rendering and an active,
   crash-free GPU sandbox. Display generation/liveness monitoring integrates with
   normal supervised shutdown and profile flushing.
5. Setup, driver-access trust boundaries and backport dependencies are documented
   in GPU.md, SECURITY.md and BACKPORTING.md.

## Verification and remaining gates

Completed locally: 203 wrapper tests, 23 isolated Rust geometry tests, native
ARM64 image/shim builds, and pristine 20-patch replay matching generated source.
The unchanged CPU path passed the existing runtime/MCP/download checks and
synthetic profile persistence through reconnect, restart and recreation.

Completed on isolated Pi fixtures: actual V3D hardware/sandbox state, correct
shader/X11/decoded-tile pixels across 1280×720, 1360×768 and 960×640, visible
browser header, expected denied GPU-node access, all five compact MCP tools,
trusted scroll/download isolation and profile recovery after one forced display
restart. Browser-container recreation from the same immutable image on the same
owned test volumes also restored its tab, cookie, local storage, shared marker
and genuine download without navigating the restored tab; the hardware gate
passed again. Initial display qualification found a real pipefail/SIGPIPE readiness
bug; draining xdpyinfo output fixed it, with a large-output regression proving
the original failure and the corrected positive/negative cases.

Display-container replacement, a full network-viewer run, wider real-site/video
workloads and extended stability remain distinct gates; only an in-place display
restart was tested. Short 30-input runs had no missing markers but
did not demonstrate a speedup; load was uncontrolled and the boundary excluded
transport/viewer presentation. See GPU.md, not generic hardware claims.

Status: implementation and initial synthetic hardware qualification complete;
remaining qualification and any production rollout are separate operator steps.
This document does not assert a completed production deployment or green hosted
CI for an unpushed worktree. No commit or push is part of this checkpoint.
