# Current fork context

Active development is now `experiment/compact-mcp`, based on qualified commit
`4f406009`. See BPH_00002_COMPACT_MCP_PLAN.md and COMPACT_MCP.md. This adds an
experimental compact MCP default plus an explicit original-Playwright fallback;
it does not authorize a production deployment or a capture/renderer rewrite.

This fork specializes BrowserPane for one persistent Raspberry Pi Chromium
session shared with Hermes. Issue #1 and BPH_00001_BUNDLE_PLAN.md are the current
bundle scope; BPH_00002_COMPACT_MCP_PLAN.md records the subsequent MCP experiment.
Upstream enterprise roadmap items are not implementation authority here.

The source import comes from the qualified single-browser wrapper. Fourteen
rendering/display patches plus listener-isolation patch 0015, CDP resize cleanup
and connection-ownership patches 0016–0017, and drawable renderer-fallback patch
0018 target upstream 91e0e1b0c772f8ac333b9ccd6fa09ea35b2673e3.
The public specialization
is implemented in PR #2: portable Compose, lean pinned Hermes packaging, setup and
doctor commands, focused CI, public guides and synthetic-only verification tools.
Deployment-specific records, credentials and profiles are not included.

Existing Raspberry Pi deployments and operator workspaces remain out of scope for
mutation. All tests and screenshots use disposable resources.

Canonical dependencies are pinned. The tracked wrapper and patches generate an
ignored upstream snapshot; Docker builds prepare that snapshot automatically
so a user needs Git and Docker Compose, not a host Rust/Node toolchain.

The long-running services are browserpane, hermes and HTTPS ingress.
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

Pull requests remain the review path; merging or deployment is a separate decision. Retain
upstream history and original licenses; do not publish private implementation
history, operator addresses, profiles or raw deployment artifacts.
