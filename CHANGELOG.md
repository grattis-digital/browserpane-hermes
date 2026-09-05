# Changelog

## Unreleased — initial Raspberry Pi/Hermes specialization

- Replaces the upstream platform tree with a focused single-browser wrapper,
  pinned upstream source generation and ordered, reviewable patches. Upstream
  Git history and attribution remain intact.
- Adds a portable three-service Compose bundle: Chromium/BrowserPane, a lean
  Hermes agent, and Caddy HTTPS ingress. Profiles, agent state, shared files and
  CA state have separate persistent volumes.
- Retains the previously qualified capture, cache, scroll-integrity and display
  controls work. Adds private CDP/admin listener hardening without replacing the
  rendering transport.
- Adds Hermes MCP configuration, one-browser tool selection, non-overwriting
  initialization, safe SQLite linkage and tests without paid model calls.
- Replaces platform pipelines with bundle-specific validation and gated image
  publishing, including native ARM64 and x86-64 build targets.
- Adds bounded, redacted viewer-failure diagnostics and fixes window-state
  cleanup after failed CDP resize requests, covered by native regression tests.
- Adds setup/security/operations documentation, measured optimization evidence,
  backport guidance, an original AI-assisted mark and a real synthetic-session
  screenshot.

This packaging work does not migrate or replace an existing deployment's data.
Experimental GPU work is not enabled by this initial supported bundle.
