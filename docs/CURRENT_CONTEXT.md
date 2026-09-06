# Current fork context

Active development is now `experiment/semantic-fast-path`, based on merged main
commit `70129e2c`. See BPH_00006_SEMANTIC_FAST_PATH_PLAN.md for immutable MCP
states, targeted semantic projections, content-free timing and bounded verified
flows. Model routing is intentionally deferred until deterministic protocol
effects are measured. See BPH_00004_GPU_RUNTIME_PLAN.md and GPU.md
for the explicit V3D/X11 integration and bounded hardware qualification. The
ordinary Compose configuration remains CPU/Xorg; GPU access requires a separate
opt-in. Compact MCP now reuses a shared default existing tab for untargeted
observations instead of rejecting them when multiple tabs exist. Explicit new
tabs and the original-Playwright fallback remain available; see
BPH_00005_TAB_REUSE_PLAN.md, BPH_00002_COMPACT_MCP_PLAN.md and COMPACT_MCP.md.

This fork specializes BrowserPane for one persistent Raspberry Pi Chromium
session shared with Hermes. Issue #1 and BPH_00001_BUNDLE_PLAN.md are the current
bundle scope; BPH_00002_COMPACT_MCP_PLAN.md records the subsequent MCP experiment,
BPH_00003_ADBLOCK_INSTALL_PLAN.md its managed-extension resource follow-up, and
BPH_00004_GPU_RUNTIME_PLAN.md the later GPU integration request, and
BPH_00006_SEMANTIC_FAST_PATH_PLAN.md the current MCP performance follow-up.
Upstream enterprise roadmap items are not implementation authority here.

The source import comes from the qualified single-browser wrapper. Fourteen
rendering/display patches plus listener-isolation patch 0015, CDP resize cleanup
and connection-ownership patches 0016–0017, and drawable renderer-fallback patch
0018, opt-in VNC-0 exact geometry patch 0019, external-X11 startup patch 0020,
and saved-session startup-tab patch 0021
target upstream 91e0e1b0c772f8ac333b9ccd6fa09ea35b2673e3.
The public specialization
is implemented in PR #2: portable Compose, lean pinned Hermes packaging, setup and
doctor commands, focused CI, public guides and synthetic-only verification tools.
Deployment-specific records, credentials and profiles are not included.

Repository development does not implicitly authorize changes to an existing
Raspberry Pi deployment or operator workspace. Deployment is a separately
authorized operator step. All tests and screenshots use disposable resources.

Canonical dependencies are pinned. The tracked wrapper and patches generate an
ignored upstream snapshot; Docker builds prepare that snapshot automatically
so a user needs Git and Docker Compose, not a host Rust/Node toolchain.

The default long-running services are browserpane, hermes and HTTPS ingress.
The optional GPU configuration adds a private, network-free X11 display sidecar,
not another browser. Device aliases and a two-node cgroup allowlist preserve
driver identity across enumeration changes; canonical device names are visible
read-only for libdrm, which is not itself the device-I/O security boundary.
No Docker socket, enterprise admin, Postgres, broker or separate agent browser.
The unused CDP forwarding listener is disabled, and the gateway admin API binds
to loopback without moving its public rendering transport. These are trusted-LAN
boundaries, not a multi-tenant or public-internet security guarantee.

Qualification covers pristine ordered-patch replay, wrapper/client/native tests,
real WebGL/X11 pixels, profile restart/recreation, deterministic MCP and the actual
three-service Compose bundle. CI runs the native amd64/ARM64 image and integration
matrix without paid model calls. The bundle was merged through PR #2; the compact
MCP experiment is reviewed separately against `main`. Each branch's
current run status belongs on its pull request and the Actions page; an image
build alone is not proof of runtime or viewer correctness.

The 0016 native mock-CDP regressions prove restoration is attempted after failed
bounds changes, without forcing a user-chosen normal window to maximize. Patch
0017 keeps top-level window commands on a browser-owned connection so closing a
page does not interrupt restoration. Patch 0018 selects a drawable canvas before
mounting it: a canvas that acquired WebGL cannot subsequently become Canvas2D.
Real-context fallback tests verify tile decoding, cache hits and scroll-copy
pixels; the full viewer oracle retains backend-specific copy coverage.

Initial isolated Pi GPU checks prove V3D/sandbox state, exact shader/X11/tile pixels
through four sizes, a visible browser header, negative device access, MCP/download
isolation and synthetic profile recovery after one display restart and subsequent
browser-container recreation on its owned test volumes. Display-container
replacement, a full network-viewer run and broader real-site/video/endurance
qualification remain outstanding at this checkpoint. The short input-to-tile
comparison did not establish a speedup;
background load was uncontrolled and no end-to-end viewer latency was measured.
See GPU.md for exact boundaries. No production deployment is asserted here.

Pull requests remain the review path; merging or deployment is a separate decision. Retain
upstream history and original licenses; do not publish private implementation
history, operator addresses, profiles or raw deployment artifacts.
