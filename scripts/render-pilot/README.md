# Explicitly authorized Pi-to-viewer measurement

Operator-only laboratory, not a deployment command or CI integration. This starts
one disposable Chromium on an owned bridge and optionally one network-free GPU
custom Xorg/Vulkan sidecar. It never attaches to the live browser, Hermes, a saved
profile or a host display. Supported modes are `cpu` and `gpu-tail` only.

The viewer runs in a fresh sandboxed local Chrome process. The synthetic page
uses trusted viewer keyboard events to change a small marker or scroll 32/64 px.
Timing starts at that viewer's actual key event and ends when the expected marker
**and** content pixels are readable in its real compositor. This covers the
normal input, Chromium, X11 capture, damage/tile/cache, gateway, QUIC and viewer
path. It is not native-wheel/smooth-scroll latency or physical monitor scanout.
The rAF observer and tiny GPU readbacks add measurement overhead/quantization.

Reuse **exactly one Pi tab**: the existing startup `about:blank` tab. Diagnostics
never create another tab or open `chrome://gpu`; GPU information comes from CDP.
Installation, fixture inspections and GPU-status calls require one page, and
the report retains its `tabState` identity. An extra or replacement tab fails the
run instead of being silently closed/retargeted to hide its resource impact.
These are checkpoint assertions, not continuous target monitoring. The separate
local viewer also creates only one page. Never reuse or close production tabs.

Keep the existing scroll/recovery and display-control integration tests. A few
marker samples cannot prove whole-frame correctness, cache recovery, video-region
ownership, HiDPI behavior or transient artifact freedom. Quiescent full-surface
X11/viewer comparisons run separately, **outside** measured phase intervals. They
are truth checks, not the application's capture or transfer baseline.

## Preconditions and authorization

- Explicit permission for a disposable workload **and** two temporary LAN ports
  (HTTPS TCP and WebTransport UDP), restricted to one approved client IPv4.
- Trusted Linux/Docker operator with sudo; existing iptables `DOCKER-USER` hook.
  Do not use on an nftables-only backend without a separately reviewed adapter.
- ARM64 browser GPU-derivative and custom GPU live-display images built from the same current
  source. Use immutable image IDs. When transporting between image stores, compare
  architecture, OS, full Config and RootFS; exported/imported IDs may differ.
- At least 1 GiB host memory remains available, temperature below 78°C. Each
  browser has a 1536 MiB cgroup limit, display 768 MiB, no swap allowance, no CPU
  quota and low CPU shares. GPU allocations are not fully measured by cgroup RAM.
- Existing device paths must resolve to V3D render and VC4 (`vc4-drm`) display
  drivers; no host package/boot changes. Only GPU mode maps those two devices.

Prepare a **fresh private 0700** remote `/tmp/bph-render-pilot.XXXXXXXX` directory.
Copy this directory's reviewed Python and JavaScript modules
into its `code/` subdirectory (readable by UID10000); also copy the repository's
`runtime/host-runtime.env` and `runtime/chromium-seccomp.json` there. Do not copy
an operator `.env`, profiles, keys or Docker socket. Keep the parent private.

Prepare a private JSON file locally and remotely, using your own values:

```json
{
  "allowLan": true,
  "mode": "cpu",
  "hostIp": "192.0.2.10",
  "clientIp": "192.0.2.20",
  "tcpPort": 24490,
  "udpPort": 24433,
  "browserImage": "sha256:REPLACE_WITH_IMMUTABLE_ARM64_IMAGE_ID",
  "displayImage": "sha256:REPLACE_WITH_IMMUTABLE_ARM64_IMAGE_ID",
  "renderDevice": "/dev/dri/by-path/REPLACE_WITH_VERIFIED_RENDER_LINK",
  "displayDevice": "/dev/dri/by-path/REPLACE_WITH_VERIFIED_DISPLAY_LINK",
  "ssh": "operator@192.0.2.10",
  "remoteConfig": "/tmp/bph-render-pilot.XXXXXXXX/cpu.json",
  "viewerUrl": "https://192.0.2.10:24490/browser/",
  "samples": 20
}
```

The example addresses are documentation-only. For the matched GPU configuration,
use `"mode": "gpu-tail"`, another config filename, and **the same browser image**.
Run one pilot at a time, alternating CPU/GPU with repeat runs and cooling/load
checks. A pre-existing service inventory change fails the cleanup audit; it does
not grant permission to repair/restart that service.

Optional JSON booleans `damageReadback` and `captureTimings` both default to false;
strings and numeric lookalikes are rejected. Regional readback requires a matching
candidate image containing patch 0023. With timings on, reports are marked
`diagnosticOnly` and include bounded request/copy/history accounting. Keep these
runs separate from clean latency samples and compare flag-on/off with identical
images. See [damage-readback evidence](../../docs/DAMAGE_SCROLL_EXPERIMENT.md) for
units, limitations and why smaller pixel reads do not prove a GPU speedup.
`damageAnalysis` is a third independent default-false boolean for patch 0025's
classifier optimization. New diagnostic runs require a 0025-capable image and
include damage admission reasons and current/previous/reused/inactive hash counts;
see [the follow-up evidence](../../docs/DAMAGE_DIRECTED_ANALYSIS.md).

`nativeDamageTrace` is a separate default-false boolean. It replaces the normal
latency phases with six finite CDP inputs on the token-checked synthetic page,
recording Chromium compositor/EGL events. Copy `diagnostic-cdp.mjs`,
`native-damage-trace.mjs`, `native-damage-summary.mjs` and `xdamage-observer.mjs` into the same `code/`
directory before starting. Geometry summaries retain no arbitrary layer args;
raw traces are private, bounded to 32 MiB/200,000 events and exported exclusively
through the owned container's mount namespace. Missing/malformed/buffer-lost
evidence fails the run. These traces are **not** production capture authority,
human-scroll benchmarks or latency results. See [native damage evidence and the
GPU-resident follow-up](../../docs/NATIVE_DAMAGE_METADATA.md).
The summary additionally recognizes the experimental custom Chromium marker
`NativeViewGLSurfaceEGL:SurfaceDamageSwap`. `eglDamageSwaps` reports its bounded
rectangles separately from ordinary `eglSwaps`, with explicit bottom-left EGL
coordinates and converted top-left Y. A marker proves neither successful
presentation nor reduced GPU work. This parser support does not install or
enable the [source-only Chromium patch](../../native/chromium-damage/README.md).

For an explicitly built custom Chromium image, add `customChromium` with exactly
`sha256` (the 64-digit lowercase hash of its packaged `chrome` binary) and
`surfaceDamage` (a JSON boolean). Both A/B runs must use the same immutable image
and hash; change only the boolean. This requires `mode: "gpu-tail"`. The custom image's
test-only launcher preserves other flags, defaults the feature off and refuses
ordinary non-test startup. No normal product image or Compose setting uses it.

Copy `custom_chromium.py`, `custom-chromium-check.mjs` and `diagnostic-cdp.mjs` into
the owned `code/` directory. Before measurements, the pilot verifies the actual
running executable path/hash, pinned build/version and effective feature flag;
an installed but unused binary fails. `nativeDamageTrace` additionally requires
`xdamage-observer.mjs` and the compiled `bph-xdamage-observer` in the custom package.
This bounded observer reads XDamage rectangles only, never pixels, and runs only
during diagnostics. Its millisecond times are relative to its own start, **not**
a causal join with Chromium trace timestamps. The enabled diagnostic must contain
actual custom selective-swap markers; the disabled diagnostic must contain none.
Both custom diagnostic modes must also yield non-empty XDamage evidence.
Missing markers fail qualification rather than being reported as no improvement.

```sh
node --test test/render-pilot.test.mjs
python3 scripts/render-pilot/test_firewall.py
python3 scripts/render-pilot/test_owner.py
node scripts/render-pilot/benchmark.mjs /PRIVATE/config.json /PRIVATE/new-report.json
```

Reports are created exclusively, not overwritten. They contain host addresses,
ownership metadata and synthetic browser diagnostics: keep them out of Git/CI.
The Pi also retains private owner/failure records and imported test images.
Do not publish raw records as benchmark artifacts.

For stock-Chromium investigation, `stockGpuWorkloads: true` appends finite real
viewer wheel, native scrollbar and compositor-animation tests. Independently
enable `stockGpuTrace: true` to bracket each phase with discovered-category GPU/
compositor traces. Both default off; stock tracing rejects custom/native trace
mode and requires the stock workloads. Compare identical trace-off runs and
independent host-timing on/off runs. See [measurement contracts and limits](../../docs/STOCK_CHROMIUM_GPU_DIAGNOSTICS.md).
Run `npm test` and
`python3 -m unittest discover -s scripts/render-pilot -p 'test_*.py'` for the
local parser, ownership, process-churn and controller regressions before copying
the reviewed harness. These checks do not start LAN or live-profile workloads.

## Network and lifecycle boundary

Only the exact two selected original destination IP/ports enter the owned
iptables chain. Source `/32` accepts precede its DROP. Dedicated bridge input/
output drops prevent other forwarded access and unsolicited egress; host INPUT
also blocks that bridge. No DNS forwarding is configured. Thus extension/store
updates and arbitrary website loads are intentionally unavailable in this fixture.
This is not an AdBlock installation or site-load test.

A test-only streaming HTTPS proxy inside the owned browser uses its ephemeral
gateway certificate and serves only `/browser/` with the expected Host. The fresh
test browser context tolerates this self-signed HTTPS certificate; **no system
trust is changed**, Chromium's sandbox stays enabled and WebTransport hash
pinning/origin checks remain unchanged. This is a controlled measurement exception,
not a supported production trust configuration. MCP/CDP/admin/X11 are unpublished.

The SSH-stdio owner has bounded operations, a 15-minute total deadline, a 90-second
client-inactivity limit, and one-second pressure/OOM checks between requests.
Subprocesses/readiness/cleanup have separate deadlines. EOF, ordinary exceptions
and handled signals initiate cleanup. SIGKILL, host loss and Docker failure cannot
guarantee cleanup: inspect the private owner record and exact resource identities
before manual recovery. Never use `docker prune`, broad stop/remove commands or
flush existing firewall chains. On incomplete container removal, scoped firewall
rules remain in place for manual recovery. Cleanup restores only owned rules;
foreign changes fail the audit rather than being overwritten.
The client requests remote cleanup and waits for owner exit before closing its
local browser. A slow local browser shutdown must not hold remote resources open.
All cleanup errors remain failures in the report.

## Interpreting the result

- Preserve failed/time-out samples and failed runs; do not select only successes.
- Report p50/p95/max with sample counts. Twenty samples cannot establish a useful
  p99 or broad enterprise/endurance guarantee.
- `network.*.ipBytes` are counted IP-layer bytes in the owned firewall chain, not
  Ethernet frames or application bytes. Offloading affects packet counts. Separate
  HTTPS bootstrap from warm QUIC traffic; report application counters separately.
- Resource intervals include diagnostic checkpoint and inter-input waiting
  overhead. Endpoint memory samples are not peaks. Add browser **and** display
  CPU/memory for GPU mode; do not credit a backend by hiding its sidecar cost.
- Existing live/background load, temperature, host frequency, and short intervals
  can confound differences. Host/viewer clocks are never subtracted from each other.
- The selected mode determines its capture path; compare matched builds and
  explicitly record any video/cadence overrides. Do not infer a speedup or promote a GPU backend from a build
  or standalone full-frame capture microbenchmark.
