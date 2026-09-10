# GPU runtime design

Status: experimental, explicit opt-in.

The baseline remains CPU/Xorg. The GPU alternative combines sandboxed Chromium
V3D rendering, a custom Rust-core/glamor Xorg dummy display, immutable frame
leases and Vulkan tile/cache/encoding. There is one browser, one private display
sidecar and no additional public listener.

## Invariants

- Both drivers expose the exact sole-output DUMMY0 resize contract.
- V3D startup requires the custom GPU display; unknown backends fail closed.
- Keep the Chromium sandbox, bounded resources and per-device access checks.
- Correctness comes from image comparison and acknowledged cache state, not
  XDamage metadata alone. Scroll reuse is optional and repaired when uncertain.
- Preserve profile ownership, shared downloads, MCP and transport.
- Frame and video queues remain bounded across timeout, resize and reconnect.
- CPU/Xorg stays usable without any graphics device or Vulkan dependency.
- Do not equate software-fixture passes with real hardware qualification.

See [operator setup](../README.md#rendering-modes),
[GPU capture contracts](GPU_LIVE_TEST.md) and
[isolated measurement harness](../scripts/render-pilot/README.md).
