<p align="center">
  <img src="assets/brand/logo.png" width="160" alt="BrowserPane Hermes: a winged browser pane shared by a person and an agent">
</p>

<h1 align="center">BrowserPane Hermes</h1>
<p align="center"><strong>One browser. Your Raspberry Pi. You and your agent.</strong></p>
<p align="center">A small, self-hosted Docker Compose bundle for a persistent Chromium session,<br>an interactive remote viewer, and a Hermes agent connected over MCP.</p>

Browser automation does not have to happen in an invisible, disposable browser.
Open the viewer, sign in yourself, and let Hermes work in that **same session**.
When a task needs your judgment or MFA, take over. Your browser profile and
downloads remain on your machine across container restarts and recreation.

Two deployment modes are available: the default CPU/Xorg baseline and an explicitly
**experimental custom Xorg/Vulkan GPU pipeline**. See [rendering modes](#rendering-modes)
for build, enablement, hardware checks and rollback instructions.

This is a focused fork of [BrowserPane](https://github.com/ITmedes/browserpane),
integrated with [Hermes Agent](https://github.com/NousResearch/hermes-agent).
It keeps BrowserPane’s native capture, tile/cache renderer, WebTransport, video
and audio paths, while replacing the platform administration layer with three
Compose services. It is an independent community integration, not an official
Raspberry Pi, BrowserPane, or Nous Research product.

## See the shared session

![A real BrowserPane viewer showing the bundle's synthetic shared-session demo](docs/images/shared-session.png)

*A real streamed Chromium session in a disposable test container, not a UI mockup.
The page is a synthetic demo; no private browsing data or live model response is shown.*

## Why this bundle?

- **Human and agent see the same browser.** No second browser hidden behind MCP.
- **Persistent by default.** Separate volumes hold the browser profile, Hermes
  configuration/memory, and shared downloads. Restart restores the saved browser
  session without appending another startup tab.
- **Compact agent control.** Six focused MCP tools provide bounded observations,
  immutable-state pagination, semantic flows and guarded action batches. Untargeted observations
  reuse one shared default tab; normal navigation stays in that tab. The original Playwright
  MCP remains selectable; see the [protocol and limits](docs/COMPACT_MCP.md).
  Compact MCP reuses existing tabs and rejects explicit extra-tab creation;
  `new` is reserved for recovery when no tabs remain. Fresh accessibility
  outlines and observed-region expansion bound browser traversal, while cached
  pagination avoids recapture. See [progressive observations and measurements](docs/MCP_SCOPED_OBSERVATIONS.md).
- **Managed ad blocking.** Upstream AdBlock with EasyPrivacy uses the persistent
  browser profile. See [installation, defaults and checks](docs/CONFIGURATION.md#managed-ad-blocking);
  blocking is not a security boundary or a guaranteed bandwidth reduction.
- **Designed around a little always-on box.** ARM64 support, CPU/X11 capture,
  a 720p-oriented automatic display policy, and carefully paired rendering fixes.
- **Small administration surface.** No separate database service, identity provider, broker,
  dashboard, or Docker socket. The browser itself is still a substantial workload.
- **Inspectable and repairable.** Pinned upstream revisions, ordered patches,
  corresponding source in the viewer, focused tests, and documented tradeoffs.

Useful for research with existing logins, form preparation, checking a web task
as it runs, assisted downloads into shared storage, and resuming a task later.
Give the agent explicit instructions to ask before submissions, purchases,
deletions, or other consequential actions. Shared access is not unlimited authority.

## Quick start

Use a **64-bit Linux host** with Docker Engine and the Compose plugin. Raspberry
Pi 4/5 with 8 GB RAM is the practical target; the measured reference was a Pi 4B
8 GB. An SSD, active cooling, and wired Ethernet are sensible for sustained use.
ARM64 and x86-64 images are build targets; the supported rendering baseline is
CPU Chromium on X11, not an experimental GPU path.

Choose the default below, or follow the experimental GPU instructions after
configuring the common networking, HTTPS and persistent volumes.

```sh
git clone https://github.com/grattis-digital/browserpane-hermes.git
cd browserpane-hermes
./scripts/setup.sh
docker compose build
docker compose up -d
./scripts/doctor.sh
```

The first source build compiles Rust and installs Chromium and Hermes. It can
take a while on a Pi and requires Internet access and spare disk space. Node,
Rust, and Python do **not** need to be installed on the host. Source revisions
and application dependencies are pinned; distribution packages and base-image
tags still receive updates, so builds are not claimed to be bit-reproducible.

The default is loopback-only at `https://localhost:8443/browser/`. For access
from another computer, edit `.env` before starting:

```dotenv
BIND_ADDRESS=192.168.1.50
VIEWER_HOST=pi-browser.home.arpa
HTTPS_PORT=8443
GATEWAY_PORT=4433
```

Use your Pi’s actual static/reserved LAN address. Make `VIEWER_HOST` resolve to
that address on the viewer computer, or use the IP itself. It is a hostname or
IP, **not a URL**. The bundle requires one explicit IPv4 bind address; wildcard
binding and IPv6-only deployments are rejected by the runtime validator before
Chromium starts.

### Trust HTTPS and permit the two viewer ports

Caddy creates a local CA. Export its **public root certificate** and trust it on
each viewer computer, following [configuration and TLS](docs/CONFIGURATION.md).
Never copy the CA private key. Use a current Chromium-based viewer browser with
WebTransport/WebCodecs support; an insecure certificate warning bypass is not a
substitute for installing trust.

Allow only trusted viewer computers to reach TCP `8443` and UDP `4433` on the
chosen bind address. HTTPS loads the viewer; WebTransport uses a separate direct
UDP connection. An HTTP reverse proxy or tunnel alone does not carry that stream.
Docker-published ports need Docker-aware firewall rules: UFW rules alone may not
filter them as expected. See [security and firewall guidance](docs/SECURITY.md).

**There is no viewer login or MCP authentication layer.** Anyone who can reach
the viewer can control its logged-in browser. Keep it on a genuinely trusted
network; never port-forward it to the Internet. MCP, browser debugging, and the
gateway administration API are not published to the host.

### Set up Hermes

```sh
docker compose exec hermes hermes model
docker compose exec hermes hermes --cli
```

Configure a provider and model through Hermes. OpenRouter is the documented
core-dependency path for this lean image; the wizard may offer other integrations
whose optional SDKs are not bundled. See the Hermes guide before selecting those.
Model usage may incur your provider’s charges; no API key is included. Credentials
and Hermes state live in the persistent agent volume, not the Git repository or image.

Self-hosted browser state does **not** mean all task data stays local: page text,
screenshots and file contents used by Hermes may be sent to your configured model
provider. Choose accounts, tasks and a provider appropriate to that privacy boundary.

The bundled configuration connects Hermes to `http://browserpane:8931/mcp`,
selects the `browserpane` toolset, and disables Hermes’s separate native browser
toolset. Ask it, for example:

> Use the shared BrowserPane browser to inspect the current page. Summarize it
> without navigating away. Ask me before sending data or submitting anything.

See [Hermes setup, tool names, and existing-agent integration](docs/HERMES.md).

For repeatable tasks, the optional [workflow-learning plugin](docs/WORKFLOW_LEARNING.md)
records content-minimized operation evidence and helps Hermes author a parameterized
skill. It is disabled by default; drafts are unverified guidance, not unattended
automation or an approval system.
The next, deliberately narrow [report-recipe pilot](docs/WORKFLOW_REPLAY.md) runs
one explicitly reviewed export without intermediate model calls. It adds durable
checkpoints and read-only reconciliation—not unattended authority or auto-repair.
The optional [Hermes execution tool](docs/WORKFLOW_EXECUTION.md) adds discovery,
run/status/cancel/reconcile for operator-registered executions and a warm MCP
connection. It stays supervised and disabled by default. The
[isolated Raspberry Pi pilot](docs/WORKFLOW_PI_QUALIFICATION.md) passed the repaired
unpaced workflow gate, with a retained GPU-readiness warning and no production rollout.
Optional [per-site pacing](docs/WORKFLOW_PACING.md) adds reviewed intervals, bounded
jitter and a persistent cold/warm budget. It is off by default, including standard
tests and benchmarks; it is not a bot-detection bypass and is locally qualified only.

## How it fits together

```text
Your browser ── HTTPS ──► web (Caddy) ──► viewer/bootstrap
             └── UDP/WebTransport ─────► browserpane
                                         │ one Chromium + persistent profile
Hermes agent ── internal MCP ─────────────┘
     └──────── shared files /shared ──────┘
```

| Service | Responsibility | Persistent data |
| --- | --- | --- |
| `browserpane` | Chromium, X11 capture, gateway, viewer and MCP bridge | `/data` browser profile |
| `hermes` | Agent CLI and background gateway | `/opt/data` config, credentials, memory |
| `web` | HTTPS entry point and local CA | Caddy certificate/CA state |

BrowserPane and Hermes also share `/shared`; genuine browser downloads are in
`/shared/downloads`. MCP diagnostic artifacts are isolated from downloads.
The browser profile and Hermes credentials are **not** cross-mounted.

The first connected viewer owns shared capture resizing. Other viewers fit the
same capture locally. Resolution presets set actual capture pixels; HiDPI adjusts
local display density and fitting, not Chromium’s shared DPI or zoom. Small
captures are centered. See [display controls](docs/DISPLAY.md).
The optional **Enhance → Smart 2×** modes enhance enlarged, settled tiles entirely
on the viewer's WebGPU-capable GPU. **Balanced** uses a lightweight model;
**Quality** tests a larger RGB model with more local GPU work. Both are experimental,
and a larger model does not guarantee more faithful text. Original pixels remain
the default; video/scrolling bypass enhancement and unsupported/slow clients
fall back automatically. It does not change Pi capture or bandwidth and does
not use Apple's Neural Engine. See [requirements, limits and tests](docs/CLIENT_UPSCALE.md).
Scrollbar drags retain pointer ownership when leaving the viewer and release on
mouse-up or cancellation; this does not force scrollbar movement onto the tile grid.

## What is different from other approaches?

| Approach | What it is good at | Tradeoff this bundle addresses |
| --- | --- | --- |
| Headless browser automation | Repeatable unattended jobs and fresh contexts | Here you can see and take over a persistent desktop browser |
| A conventional VNC desktop | General-purpose remote desktop access | Here the browser, shared files and agent MCP connection come pre-wired |
| A hosted browser service | Managed capacity and remote infrastructure | Here browser state stays on infrastructure you operate; you also maintain it |
| The full BrowserPane platform | Broader administration and multi-service deployments | Here one trusted shared session has a much smaller operational surface |

This is not a claim that every alternative is slower or cannot support MCP.
The specialization is the ready-to-run combination and its explicit one-session
contract. It is not multi-tenant isolation, a cloud browser fleet, or a general
desktop replacement.

## Rendering modes

Both modes use the same persistent Chromium profile, Hermes MCP endpoint, viewer,
ports and shared downloads. They are alternatives: run **one browser service**,
not one of each. The GPU mode adds one private display/encoder sidecar, not
another Chromium session.

| | CPU / Xorg (default) | Custom Xorg / Vulkan (**experimental**) |
| --- | --- | --- |
| Chromium page rendering | Software rendering with the bundled default flags | Sandboxed V3D rendering through X11/ANGLE |
| Display | Standard Xorg dummy driver, `DUMMY0` | Custom Rust-core/glamor driver, `DUMMY0`, immutable DMA-BUF leases |
| Capture and tile work | CPU capture, damage analysis, classification and tile encoding | Vulkan comparison, scroll verification, flat-colour classification, acknowledged tile cache, lossless QOI and command packing |
| CPU boundary | Captured pixel buffers are processed on CPU | CPU forwards encoded tile commands; browser logic, driver submission, networking and viewer decoding still use CPU |
| Video | Existing CPU capture/encoding path | Tile-only by default; optional Pi 4 hardware video-region encoding and separate source decoding |
| Hardware scope | 64-bit Linux; ARM64 and x86-64 build targets | Qualified target: Pi 4 / V3D 4.2, 64-bit Linux; not a generic GPU or Pi 5 compatibility promise |
| Select | `compose.yaml` | `compose.yaml` + `compose.gpu.yaml` |

“CPU” describes the actual shipped baseline, not merely its capture backend:
the standard dummy display and launch flags do **not** promise GPU-accelerated
Chromium. Do not remove flags manually to create an undocumented third mode.

### CPU / Xorg baseline

Use the quick start above. No graphics devices, extra sidecar or GPU environment
variables are needed:

```sh
docker compose build
docker compose up -d
./scripts/doctor.sh
```

This is the portable fallback and the reference for comparisons. Capture uses
the existing damage/tile/cache transport rather than sending every screen as
a full-frame video. High-resolution animation and software video can still
saturate a Pi; begin at 1280×720 and keep agent work on the shared default tab.

### Experimental custom GPU / Vulkan pipeline

This is an opt-in coupled stack, not a production-support or universal-FPS
guarantee. It supports **one interactive viewer**, with capture up to
**1920×1080**. Hermes is not another viewer. Start at 1280×720; test resize,
scroll, reconnect and video with synthetic content before trusting a real task.
The CPU capture thread is not started when this pipeline is enabled.

Run these commands on the ARM64 Pi, or build matching ARM64 images elsewhere
and load them onto it. Build browser, gateway, client and display from the
**same checkout**; mixing versions can break acknowledgement/cache ownership.

1. Run `./scripts/setup.sh` if needed and configure the common `.env` settings.
   Use a current Docker Compose plugin supporting `!reset`.
2. Discover the Linux host's devices:

   ```sh
   ./scripts/gpu-devices.sh
   ```

   Copy its four `BPANE_GPU_RENDER_DEVICE`, `BPANE_GPU_DISPLAY_DEVICE`,
   `BPANE_GPU_RENDER_GID` and `BPANE_GPU_DISPLAY_GID` assignments into your
   private `.env`. Discovery requires stable V3D render and VC4 display links.
   Do not guess `card0`, add privileged mode or expose every device. If discovery
   fails, fix the host's supported DRM driver configuration before continuing.

3. Build the paired images:

   ```sh
   docker compose build browserpane hermes
   docker build -f Dockerfile.gpu -t browserpane-hermes-browser:gpu-local .
   docker compose -f compose.yaml -f compose.gpu.yaml build gpu-display
   docker compose -f compose.yaml -f compose.gpu.yaml config --quiet
   ```

   The GPU derivative adds compatible Mesa libraries and a narrowly scoped
   Chromium scheduler shim; it does not rebuild Chromium. To select another
   matching local browser image, set `BPANE_GPU_BROWSER_IMAGE` in `.env`.
   The override enables `BPANE_GPU_MODE=v3d`,
   `BPANE_X11_BACKEND=gpu-dummy` and `BPANE_GPU_TAIL=1` together.

4. Stop users/agent tasks, retain your previous images and back up persistent
   volumes with writers stopped. Switch the same Compose project:

   ```sh
   docker compose stop hermes browserpane
   docker compose -f compose.yaml -f compose.gpu.yaml up -d
   docker compose -f compose.yaml -f compose.gpu.yaml exec browserpane node server/check-gpu.mjs
   docker compose -f compose.yaml -f compose.gpu.yaml ps
   ```

   The check requires sandboxed V3D, enabled compositing/rasterization, no
   reported GPU-process crashes and a responsive capture worker. Failure must
   be investigated, not bypassed with `--no-sandbox` or a software renderer.
   Reload the viewer to obtain the matching client. Keep using both `-f`
   arguments for subsequent GPU-mode operations.

Only the selected DRM nodes are openable; read-only `/dev/dri` visibility lets
libdrm resolve their canonical identities. X11, IPC and the encoded-output socket
are private to the browser/display pair. There are no extra published ports.
The browser retains its 2300 MiB memory limit; the display has a 768 MiB limit.
These are caps, not reservations. CPU shares are relative weights, not a fixed
CPU-core quota. Monitor the combined browser/display load.

GPU-side work includes exact changed-tile comparison, arbitrary-pixel scroll
reuse with repair, flat-colour commands, cache references and lossless changed
tile encoding. Only encoded output crosses to the host's transport path.
DMA-BUF sharing still has synchronization and GPU memory-bandwidth costs;
the pipeline is **not** claimed to be zero-copy or CPU-free end to end.

#### Optional Pi 4 video

Without another override, video motion is carried as lossless tiles. For
outgoing H.264 video regions, identify the `bcm2835-codec-encode` node and put
its path/GID in `BPANE_GPU_VIDEO_DEVICE` and `BPANE_GPU_VIDEO_GID` in `.env`.
Then include `-f compose.gpu-video.yaml` after the GPU override:

```sh
docker compose -f compose.yaml -f compose.gpu.yaml -f compose.gpu-video.yaml config --quiet
docker compose -f compose.yaml -f compose.gpu.yaml -f compose.gpu-video.yaml up -d
```

The worker crops and converts the video region on GPU into the Pi's hardware
encoder; surrounding UI stays lossless. Video has an independent bounded
cadence capped at 30 fps, not a guaranteed delivered frame rate. Hardware
encoder failure restores lossless tiles, not a hidden CPU video encoder.
See [video setup, device identity and acceptance checks](docs/GPU_LIVE_TEST.md#optional-pi-4-hardware-video-regions).

**Source playback decoding is separate.** GPU compositing does not mean that
Chromium decodes YouTube's AV1 stream in hardware. The additional experimental
`Dockerfile.gpu-decode` / `compose.gpu-decode.yaml` option uses pinned Pi
Chromium, a selected V4L2 decoder device and h264ify. Follow the
[decoder build/configuration and player-level checks](docs/GPU_VIDEO_DECODE.md).
Do not enable Pi 4 codec overrides on hardware without the matching codec nodes.

#### Recovery and return to CPU mode

Both modes retain the profile and shared files. Docker restarts exited services
unless explicitly stopped. GPU mode also monitors worker progress and display
generation: a failed worker triggers display/session recovery. This can lose
unsaved page state and does not guarantee recovery from a wedged kernel.
See [capture recovery](docs/GPU_LIVE_TEST.md#capture-failure-recovery).

To return to the baseline, finish agent work and stop the GPU pair with the
same override set used to start it; then recreate the base browser:

```sh
docker compose -f compose.yaml -f compose.gpu.yaml stop hermes browserpane gpu-display
docker compose up -d --force-recreate browserpane
docker compose up -d hermes web
```

Include any video/decode overrides in the stop command if enabled. Keep the
project name and volumes unchanged. Do **not** use `down -v`.
If the decoder candidate changes Chromium versions, use a compatible profile
backup when reverting; browser profile downgrades are not guaranteed safe.

## Performance, correctness, and upstream backports

The fork carries capture scheduling, buffer reuse, tile/subtile caches, scroll
repair, client texture reuse, bounded video delivery, recovery and exact display
geometry changes. Host, gateway and viewer changes must travel together.

Read the [optimization evidence and limits](docs/OPTIMIZATIONS.md),
[ordered backport guide](docs/BACKPORTING.md) and
[GPU ownership/protocol guide](docs/GPU_LIVE_TEST.md).
Synthetic component timings, host processing time and actual input-to-photon
latency are different measurements. No universal FPS or bandwidth claim follows
from a component benchmark. The [render pilot](scripts/render-pilot/README.md)
uses one disposable browser and synthetic fixtures, never a live profile.

[Scoped MCP observations](docs/MCP_SCOPED_OBSERVATIONS.md) bound accessibility
traversal and response size while retaining Playwright's input safeguards.
[GPU cache/encoding](docs/GPU_CACHE_ENCODING.md) documents flat-colour and cache
commands, lossless output and correctness oracles. The
[custom Chromium source experiment](native/chromium-damage/README.md) is a
separate, default-off research path; no custom Chromium build is needed for
either deployment mode.

## Operations and development

- [Configuration, TLS, networking, backups and upgrades](docs/CONFIGURATION.md)
- [Hermes and MCP integration](docs/HERMES.md)
- [Security boundaries and reporting](docs/SECURITY.md)
- [Development and verification](CONTRIBUTING.md)
- [Source provenance and dependency attribution](UPSTREAM.md)

`docker compose down` preserves named volumes. **`docker compose down -v`
deletes them**, including profile, credentials and CA state. Keep the Compose
project name stable across upgrades, and stop writers before making backups.

The wrapper also recovers from cgroup-v2 OOM kills that leave the main browser
alive; see [recovery behavior and qualification](docs/OOM_RECOVERY.md). This does
not prevent memory exhaustion or replay interrupted agent actions. Compact MCP
serializes individual calls; [whole-research-job admission](docs/MCP_WORKLOAD_ADMISSION_PLAN.md)
is a separate planned safeguard, not an active feature.

The pipelines are tailored to this bundle: patch replay, wrapper/client/native
regressions, Compose and exposure checks, real container smoke tests, MCP and
profile persistence, and architecture-specific image builds. Hosted ARM64 checks
verify that architecture, not Pi hardware latency. Publishing is separately gated;
pull requests do not get registry credentials or run paid model calls.

## License and acknowledgments

The BrowserPane derivative retains the upstream [AGPL-3.0 license](LICENSE).
Hermes and other dependencies retain their own licenses; see [UPSTREAM.md](UPSTREAM.md).
The viewer’s **Source** link serves the corresponding bundled source. Preserve
notices and review the obligations relevant to your distribution or changes.

Thanks to the BrowserPane, Hermes, Chromium, Playwright, Rust and Linux projects
whose work makes this small shared-browser setup possible. The original project
mark was created with AI assistance; it does not imply affiliation with those projects.
