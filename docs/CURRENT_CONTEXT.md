# Current fork context

This fork specializes BrowserPane for one persistent Raspberry Pi Chromium
session shared with Hermes. Issue #1 and BPH_00001_BUNDLE_PLAN.md are the current
scope; upstream enterprise roadmap items are not implementation authority here.

The source import comes from the qualified single-browser wrapper. Its 14 ordered
patches target upstream 91e0e1b0c772f8ac333b9ccd6fa09ea35b2673e3. The public fork
must remove deployment-specific data and add portable Compose, Hermes packaging,
focused CI and public documentation before publication.

The existing Raspberry Pi deployment and separate browserpane-single checkout
are out of scope for mutation. All tests and screenshots use disposable resources.

Canonical dependencies are pinned. The tracked wrapper and patches generate an
ignored upstream snapshot; Docker builds will prepare that snapshot automatically
so a user needs Git and Docker Compose, not a host Rust/Node toolchain.

The intended long-running services are browserpane, hermes and HTTPS ingress.
No Docker socket, enterprise admin, Postgres, broker or separate agent browser.
Security work must close the unused CDP forwarding listener and isolate the
gateway admin API without changing the rendering transport.

Publication defaults to a review PR unless the user chooses direct main. Retain
upstream history and original licenses; do not publish private implementation
history, operator addresses, profiles or raw deployment artifacts.
