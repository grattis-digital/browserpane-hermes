# BrowserPane Hermes — contributor and agent guide

This fork is a deliberately small Raspberry Pi / Hermes integration, not the
upstream multi-tenant BrowserPane platform. The user-approved scope is tracked in
issue #1 and docs/BPH_00001_BUNDLE_PLAN.md. See docs/CURRENT_CONTEXT.md.

## Boundaries

- Keep one persistent Chromium session shared by the viewer and Hermes over MCP.
- Keep BrowserPane's capture, tile/cache, WebTransport, video and audio stack.
- Do not restore the enterprise admin UI, database, broker or worker platform.
- No production-host changes while developing this public repository.
- No operator-specific IPs, domains, profile data, credentials, private screenshots
  or historical deployment records in code, docs, commits or CI artifacts.
- The tracked wrapper and ordered patches are the editable source of truth.
  upstream/ is a generated, ignored snapshot of the pinned source plus patches.
  Do not hand-edit it without producing and testing the corresponding patch.
- Keep original license/attribution and document dependency pins and changes.
  Root AGPL terms are retained; do not invent alternative upstream licensing.

## Working practices

- Read the code, Compose manifests and relevant tests before trusting prose.
- Use a branch, focused plan and reviewable commits; do not rewrite upstream history.
- Use the repository identity approved by the user. Never mutate the upstream project.
- User-visible or setup changes need README/configuration documentation together.
- Changes to listeners, credentials, storage or deployment need SECURITY.md and
  docs/SECURITY.md updates with honest trust boundaries.
- Follow NODEJS_STANDARDS.md and RUST_STANDARDS.md for their respective code.
  Existing imported wrapper/harness layouts are intentionally preserved during
  extraction; do not refactor hot paths merely for style or file length.
- Do not commit generated dist/, upstream/, node_modules/, data/, .env,
  credentials, test-results/ or container/CI caches.
- Tests and screenshots use fresh, labelled disposable resources and synthetic
  content. Validate exact container identity before writes or cleanup.
- Never use production profiles or a contributor's active browser for tests.
- MCP tool exclusions reduce accidents; they are not a security boundary.

## Verification and claims

- Run the narrow unit/config/build checks and affected integration tests.
- Replay patches on the pinned upstream commit and verify source provenance.
- Preserve negative origin/input/config tests and profile/reconnect regressions.
- Keep host/gateway/client recovery patches together where their contracts couple.
- Separate local synthetic, hosted CI and actual Raspberry Pi hardware evidence.
- No universal FPS, bandwidth, GPU, security or alternative-product superiority claims.
- Update the backport guide when a new upstream patch is introduced.
- A successful image build is not proof of runtime/browser/profile behavior.
- Never run paid model calls in CI; verify MCP with deterministic fixtures.

## Layout

- client/: minimal viewer and local display controls.
- server/ and runtime/: one-browser bootstrap, process lifecycle and sandbox.
- patches/: ordered, backportable upstream changes.
- hermes/: pinned lean agent packaging and safe initial configuration.
- config/ and compose.yaml: portable ingress/network/storage configuration.
- scripts/ and test/: development, packaging and isolated verification.
- docs/: operator, architecture, optimization and evidence documentation.
- .github/: pipelines and contribution templates scoped to this bundle.

The supported commands and evidence are maintained in README.md and the
configuration, development and optimization docs as the extraction is completed.
