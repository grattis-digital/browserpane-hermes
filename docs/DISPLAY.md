# Display controls

The viewer retains the optimized BrowserPane renderer. The toolbar is a small
local control layer, not an alternative capture or streaming path.

- **Auto** chooses an aspect-aware capture near 921,600 pixels (720p), within the
  supported bounds. This is a practical Pi workload policy, not a monitor benchmark.
- **Resolution** presets specify physical capture pixels up to 1920×1080. The
  browser desktop resizes without restarting Chromium or discarding its profile.
- **HiDPI** changes local display density. Off/1× favors readable UI; with a fixed
  resolution, higher density makes the same capture smaller and sharper where
  the monitor allows. Native follows the viewer monitor’s device pixel ratio,
  capped at 3×. With Auto resolution, density changes can also select a new
  physical capture within the Pi pixel budget; locked secondary viewers never
  resize the shared capture.
- Small views are centered; large ones fit while preserving aspect ratio.
- **Enhance** optionally applies experimental, viewer-local Smart 2× to enlarged
  stable tiles. Balanced uses a lightweight model; Quality tests a larger RGB
  model with the same safety limits. Original pixels are the default. It neither changes capture
  settings nor uses Pi/cloud inference; HTTPS and hardware WebGPU are required.
  See [client upscale](CLIENT_UPSCALE.md) for fidelity, video and resource limits.
- Local preferences survive viewer reloads. The first viewer owns shared capture
  sizing; subsequent viewers fit locally until ownership changes.

Chromium itself stays at 1×. These controls do not change the shared browser’s
operating-system DPI, page zoom, or restart behavior. A lower-density monitor does
not require changing Chrome’s global DPI for everyone. Page zoom remains a shared
browser action and should be coordinated with the agent and other viewers.

Use Auto first, then 1280×720/1× if diagnosing a slow Pi. Higher capture resolution
means more pixels to render, capture, encode, transfer and compose. A high-DPI
monitor does not make the Pi’s physical capture free.

Display regression checks cover live resizing, centering, scale changes, monitor
DPR changes, secondary-viewer ownership, persistence and unexpected downloads.
See the development guide for the actual commands and evidence boundaries.
