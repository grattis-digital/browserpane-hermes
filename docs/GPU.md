# Optional Raspberry Pi V3D rendering

This branch adds an explicit GPU configuration; the ordinary Compose setup stays
on its existing CPU/Xorg baseline. The GPU path keeps X11 and BrowserPane's
capture, lossless tiles, cache, WebTransport, audio and MCP implementations.
It does not substitute VNC streaming. One Chromium profile remains shared by the
human viewer and Hermes.

## Architecture and limits

`Dockerfile.gpu` extends the **current application image**, installing Mesa from
Debian bookworm-backports and a small opt-in Rust scheduling compatibility shim.
`Dockerfile.gpu-display` supplies TigerVNC's DRI3-capable X11 server in an isolated
sidecar. The dummy Xorg driver does not expose the DRI3 interface required by the
tested ANGLE GLES path. No display-server code is patched or driver invented.

The display has no network, published ports or VNC TCP listener. It shares only
a dedicated X11 Unix-socket volume and IPC namespace with the browser. Browser
profile/shared files are not mounted in the display. Both processes receive only
the verified V3D render node and VC4 display node, with their corresponding groups.
Stable private device aliases plus read-only `/dev/dri` visibility allow libdrm
to find canonical nodes even after card numbers change. The device-cgroup
allowlist grants access only to the two selected devices; a read-only bind alone
does not prevent device I/O. Qualification must prove other GPU nodes fail to open.
This intentionally expands kernel-driver access; read the [security boundary](SECURITY.md#optional-gpu-access).

Chromium uses ANGLE GLES/EGL, GPU rasterization and X11. GPU vsync is disabled:
TigerVNC's no-VNC-client frame clock otherwise stalls near one second. This does
not disable GPU rendering or alter BrowserPane's capture clock. The wrapper
removes only the old graphics-disable/backend switches, preserves other browser
flags, and rejects sandbox-disabling switches in V3D mode.

Mesa's shader disk-cache startup is disabled for the tested GPU sandbox path.
The Rust shim declines only an opted-in optional `SCHED_BATCH` priority-zero
pthread hint with `EPERM`, forwarding other scheduling requests. It does not
change seccomp, grant privileges or pretend a rejected hint succeeded. Only the
Chromium process tree receives this preload. Browser HTTP caching and BrowserPane
tile caches are unaffected. Driver/shader-cache behavior needs requalification
after Chromium/Mesa updates; distribution packages are not byte-pinned.

Hardware rendering does not remove JavaScript, DOM layout, capture, encoding or
network costs. Video encoding/decoding is not enabled by this configuration.
Earlier render-only Pi experiments improved scrolling/canvas cadence but showed
little DOM-repaint improvement and sometimes increased combined Chrome/X11 CPU.
Do not treat those numbers as current end-to-end viewer benchmarks.

## Opt in

Use a maintained Docker Compose release supporting `!reset`. Build CPU and GPU
images from the same reviewed checkout; never substitute an old GPU probe image.
The following commands do not change host drivers, firewall or boot configuration:

```sh
docker build -t browserpane-hermes-browser:local .
docker build -f Dockerfile.gpu -t browserpane-hermes-browser:gpu-local .
docker build -f Dockerfile.gpu-display -t browserpane-hermes-gpu-display:local .
bash scripts/gpu-devices.sh
```

Review the four printed assignments and add them to your private `.env`.
Discovery identifies driver names through sysfs and requires stable
`/dev/dri/by-path/` links. Device numbers such as `card0` can change across boot;
do not replace these links with assumed card numbers. Failures to find exactly
one V3D render and VC4 display device require explicit host investigation.

Back up the stopped profile before switching an existing installation. Qualify
the GPU images first with disposable synthetic pages/profiles, never your active
browser credentials. After qualification:

```sh
docker compose -f compose.yaml -f compose.gpu.yaml config --quiet
docker compose -f compose.yaml -f compose.gpu.yaml up -d --no-build
docker compose -f compose.yaml -f compose.gpu.yaml ps
```

Always include both Compose files for GPU operations. This adds a 768 MiB display
ceiling and a shared 512 MiB IPC allocation; ceilings are not reservations.
Account for actual combined use with Chromium and other services before changing
limits. The browser retains the default memory cap unless separately overridden.

The external-display generation watcher terminates the browser container if its
display disappears or is replaced, so the normal restart policy reconnects the
complete session. Compose starts the browser only after the display is healthy.
An internal liveness watchdog exits a hung display sidecar; Docker health status
alone would not restart it. Startup and periodic browser-level CDP checks reject
software fallback, lost GPU sandbox or recorded GPU crashes without reading tabs.
Recreate both services together when changing the display container/IPC namespace;
do not leave the browser attached to an abandoned display.

## Qualification gates

Service health is not proof of GPU support. In the remote Chromium, `chrome://gpu`
must show V3D/ANGLE hardware compositing and rasterization with the GPU sandbox
active. Read-only CDP `SystemInfo.getInfo` can check the same fields without
collecting page content. Software fallback, GPU-process crashes or context loss
fail qualification; do not compensate with `--no-sandbox` or blocklist overrides.

Also test correct hardware WebGL pixels, a visible browser header, input, exact
1280×720/1360×768 resizing, scroll/tile pixels, video transitions, MCP, stable
memory/OOM counters and persistence across both restart and recreation. The
virtual-output patch accepts only explicitly configured `VNC-0`, at origin,
covering the entire root; offset/multi-output/physical-monitor cases still fail.

## Initial hardware qualification — 6 September 2026

Finite synthetic tests passed on a Raspberry Pi 4B with 8 GB RAM, Chromium
152.0.7977.75, browser Mesa 25.0.7 from bookworm-backports and TigerVNC 1.15.
The tested application retained the compact MCP and current capture/tile patches;
it was not the earlier render-only GPU probe image. These were isolated test
containers with fresh profiles, not measurements from a user's browsing session.

- Browser-level CDP and the page's WebGL renderer both reported V3D. GPU
  compositing/rasterization were enabled, the GPU sandbox was active, and the
  recorded GPU-process crash count remained zero.
- An alternating green/magenta shader fixture produced matching WebGL,
  FFmpeg X11-readback and decoded Fill/Zstd/cache-tile pixels across
  1280×720 → 1360×768 → 960×640 → 1280×720. The browser header remained visible
  in the capture, measuring 87 pixels in that configuration.
- Both allowed GPU nodes could be opened; the other visible V3D primary node
  failed with `EPERM`. Read-only device-directory visibility did not broaden
  the cgroup device allowlist.
- All five compact MCP tools, trusted scroll down/up, console-download
  isolation and a genuine `.log` download passed without changing Chromium's PID.
  Synthetic cookies, local storage, shared files and downloads survived reconnect.
- Deliberately restarting the isolated display triggered one automatic browser
  container restart within eight seconds. Hardware status and the complete
  synthetic profile check passed after recovery. This is one observed recovery,
  not a restart-time guarantee or proof of arbitrary-hang recovery.
- After stopping and removing that test browser container, a new container from
  the same immutable image reused only its owned test data/shared volumes and
  the existing isolated display. Its existing tab, cookie, local storage, shared
  marker and genuine download were verified without navigating the restored tab;
  the hardware gate passed again. This proves browser-container recreation in
  that fixture, not display-container replacement.

Two short keyboard-to-completed-tile runs each delivered all 30 expected markers:

| Configuration | Median | p95 | Missing markers |
| --- | ---: | ---: | ---: |
| CPU/Xorg baseline | 23.70 ms | 30.79 ms | 0/30 |
| GPU/Xvnc configuration | 43.96 ms | 73.68 ms | 0/30 |

The boundary is host input injection to the matching decoded marker plus batch
completion, not network/viewer presentation or page loading. Background load was
not controlled and these compare complete configurations, not GPU rendering in
isolation. **These preliminary numbers do not establish a speedup.** They do not
supersede the earlier render-only experiment or justify a general slowdown claim.

Display-container replacement, a full network-viewer run, wider real-site/video
workloads and longer stability tests remain separate qualification work. The
display was restarted in place, not recreated. This evidence is not a
production-deployment claim. The initial GPU checkpoint passed 203 wrapper tests,
23 isolated Rust geometry tests and pristine replay of all 20 patches. The later
[tab-reuse follow-up](BPH_00005_TAB_REUSE_PLAN.md) records 230 wrapper tests,
21-patch replay and exact-tab-count CPU runtime qualification. Hosted CI and
actual Pi evidence must continue to be reported separately.

## Roll back

Stop the GPU browser gracefully and retain its profile, then explicitly stop the
GPU display service so its restart policy cannot leave an active orphan. Start
the reviewed CPU image using only `compose.yaml`; remove the stopped display service
after checking its identity. Do not delete `browser-data`, `shared-files`, agent
state or TLS volumes. GPU image rollback does not reverse Chromium profile
migrations. See the [backup and upgrade guide](CONFIGURATION.md).
