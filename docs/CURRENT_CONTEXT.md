# Current fork context

This fork specializes BrowserPane for one persistent Raspberry Pi Chromium
session shared with Hermes. Issue #1 and BPH_00001_BUNDLE_PLAN.md are the current
scope; upstream enterprise roadmap items are not implementation authority here.

The source import comes from the qualified single-browser wrapper. Fourteen
rendering/display patches plus the fork's fifteenth listener-isolation patch
target upstream 91e0e1b0c772f8ac333b9ccd6fa09ea35b2673e3. The public specialization
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

Local qualification covers pristine 15-patch replay, wrapper/client/native tests,
real WebGL/X11 pixels, profile restart/recreation, deterministic MCP and the actual
three-service Compose bundle. CI runs the native amd64/ARM64 image and integration
matrix without paid model calls. Its current run status belongs on PR #2 and the
Actions page; an image build alone is not proof of runtime or viewer correctness.

PR #2 remains the review path; merging or deployment is a separate decision. Retain
upstream history and original licenses; do not publish private implementation
history, operator addresses, profiles or raw deployment artifacts.
