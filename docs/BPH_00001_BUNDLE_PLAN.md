# Raspberry Pi + Hermes bundle specialization

## Metadata

- Canonical issue: grattis-digital/browserpane-hermes#1 (user-requested fork specialization).
- State: In Progress.
- Target: a shareable, reproducible single-browser Compose bundle, not the upstream platform.
- Baseline: BrowserPane `91e0e1b0c772f8ac333b9ccd6fa09ea35b2673e3` plus the locally qualified 14-patch single-browser implementation.
- Publication: work on `feat/raspberry-hermes-bundle`; preserve upstream Git history. PR first unless the user chooses direct main publication.

## Business outcome and example use case

A Raspberry Pi owner starts one persistent Chromium session and a Hermes agent
with Docker Compose. They log in or intervene through the browser viewer; Hermes
uses MCP against that same browser. The profile and shared downloads survive
container recreation. No second browser, separate database service, enterprise admin console or
Docker socket is required by this specialization.

The agent must ask the human for consequential actions or MFA rather than
assuming that sharing a logged-in browser gives unlimited authority.

## Scope

- Replace the fork's platform-oriented current tree with the minimal qualified
  wrapper, pinned upstream source retrieval and versioned optimization patches.
- Portable Compose, private internal MCP, persistent browser/agent/shared data,
  documented TLS/UDP/LAN configuration, and usable Hermes onboarding.
- Honest README: setup, configuration, use cases, alternatives/tradeoffs,
  architecture, browser/MCP interaction, constraints, upgrades and backups.
- Public optimization/backport guide with source attribution and bounded
  measurement claims; do not publish private deployment records or browser data.
- Original logo and a real screenshot from a disposable synthetic browser session.
- Focused pipelines for this specialization: static/security/config tests,
  upstream patch replay, frontend tests, container/runtime smoke, profile
  persistence and MCP behavior, ARM64 build qualification and gated releases.
- Contributor/security guidance, issue/PR templates, repository links/metadata.

## Non-goals

- No changes to the user's running Raspberry Pi deployment.
- No enterprise multi-tenancy, OIDC platform, broker, workflow engine or recordings.
- No GPU enablement or new capture/transport redesign in this packaging slice.
- No fabricated speed rankings, screenshots, benchmarks or production guarantees.
- No paid LLM calls or social-media publication as part of CI or verification.
- No change to upstream license grants or implied third-party endorsement.

## Decisions and dependencies

The user's explicit fork specialization supersedes the upstream platform roadmap
for this repository only. Runtime behavior comes from the previously qualified
single-browser implementation; pinned dependency source and patches remain
traceable for backports. Preserve the root AGPL license and dependency notices.
Verify current Hermes source, CLI, configuration and Docker compatibility before
documenting commands. Keep existing-agent attachment available alongside the
bundled-agent path.

## Contract changes

- API/protocol: preserve existing single-browser gateway/bootstrap/MCP contract.
- Database: no separate service or upstream migrations; Hermes owns its persistent SQLite state.
- Administration: single viewer and setup files, no upstream admin application.
- CLI/SDK: setup/doctor and normal Compose commands where justified; no duplicate agent framework.
- Deployment/configuration: remove hard-coded operator addresses, paths and identities.
- Documentation: replace platform README, current context and agent guide with
  specialization-specific equivalents; document the new trust boundary.

## Security and data impact

This is a trusted-user LAN bundle, not an internet-facing multi-user service.
Treat the persistent browser profile and MCP as credentials. Do not publish CDP,
gateway admin or MCP by default. Explain Docker firewall behavior, HTTPS secure
contexts, direct WebTransport UDP and why an HTTP reverse proxy does not tunnel
that UDP path. Keep unprivileged Chromium sandbox settings and no Docker socket.
Secrets stay in ignored operator files or volumes, never image layers or logs.
Tests use marked synthetic tabs and unique owned disposable resources only.

## Migration and rollback

The existing public fork history remains intact. The new branch removes unused
platform files from its current tree without rewriting history. Keep the separate
qualified deployment checkout intact. Community upgrades must reuse named volumes,
stop profile writers before backups and never automatically restore old profiles
over newer user data. Document image rollback independently of data restoration.

## Observability

Use bounded health/readiness checks and redacted diagnostics. Report component
health, versions and test evidence; never expose profile contents, browsing URLs,
cookies, access tickets, API keys or raw environment dumps in artifacts.

## Implementation slices

1. Extract and sanitize the minimal runtime, retaining provenance and regression tests.
2. Add portable Compose, Hermes onboarding and configuration validation.
3. Adapt specialized CI, smoke/persistence tests and contributor/security docs.
4. Add README, original assets and optimization/backport evidence.
5. Run clean-checkout validation, review, publish the branch and report actual gates.

## Test strategy

- Unit: setup/config validation, malformed values, gateway origin/session handling,
  display controls, download isolation and source/patch packaging.
- Integration: Compose interpolation, services/networks/volumes, no sensitive
  published ports or Docker socket; exact pinned-source patch replay.
- Browser: real synthetic remote fixture; first frame, input, resize/fitting,
  display settings, cache correctness, reconnection and no accidental downloads.
- Runtime: fresh isolated container, strict sandbox, one Chromium process,
  readiness, MCP initialize/tools, profile persistence across restart/recreate.
- Pipeline: validate workflows, permissions, pinned actions, resource cleanup,
  no secrets for PR checks and release-only registry writes.
- Build: qualify actual architecture separately from unit-only claims; document
  anything not executed on Raspberry Pi hardware.

## Post-implementation smoke sequence

1. From a clean checkout, install locked dependencies and fetch the pinned source.
2. Run configuration/unit/client checks and build the viewer.
3. Render the example Compose configurations and exercise negative validation.
4. Build the container; start an isolated loopback-only stack with temporary data.
5. Initialize MCP, operate only a marked demo tab and verify viewer input/rendering.
6. Restart/recreate with test volumes and verify the marked profile state survives.
7. Capture the real demo screenshot and close only the test's owned resources.
8. Verify documentation links, public-data/secret hygiene and exact final Git tree.
9. Push the branch, inspect specialized CI, and publish according to user direction.

Runnable checks (see CONTRIBUTING.md for isolated browser selection):

```sh
npm ci
sh scripts/fetch-upstream.sh
node scripts/audit-upstream.mjs
npm test
npm run test:client
npm run build
npm audit --omit=dev --audit-level=high
python3 -m unittest discover -s hermes -p 'test_*.py' -v
docker compose --env-file .env.example config --quiet
npm run test:linux
npm run test:webgl
docker build --tag browserpane-hermes:test .
npm run test:runtime
node scripts/test-viewer.mjs browserpane-hermes:test
docker build --tag browserpane-hermes-agent:test ./hermes
python3 hermes/check-container.py --image browserpane-hermes-agent:test
node scripts/test-compose.mjs browserpane-hermes:test browserpane-hermes-agent:test
```

The fetch intentionally refuses an existing generated snapshot; run that step
once per clean checkout, not over local source. No enterprise deployment gate is
represented as evidence for this narrowed bundle.

## Local qualification and publication status

Implementation slices 1–4 are complete. Before publication, local ARM64 Linux
containers on a Mac passed the following checks; hosted GitHub CI is a separate
gate, not inferred from local success:

- Initial strict pristine replay before patch 0016: 15 ordered patches,
  816 source files, exact byte match.
- Wrapper/configuration/safety/source-packaging: 92 tests; frontend: 771 tests.
- Native gateway: 532 passed, 1 intentionally ignored; host: 419 passed,
  20 intentionally ignored. Gateway integration suites passed. All seven private
  X11/MIT-SHM regressions and three new listener regressions explicitly ran.
- Both actual ARM64 images built. Hermes bootstrap: six tests; linked SQLite
  3.53.4 with working FTS5/trigram; classic CLI and idle gateway startup passed.
- Real MCP and browser tab/cookie/localStorage/shared-file persistence passed
  through reconnect, restart and recreation using fresh owned volumes.
- Full Compose passed local-CA-verified HTTPS, redirect, protected bootstrap,
  hidden control routes, private listeners and real Hermes discovery of 27
  permitted BrowserPane tools. No provider key, paid call or host CA change.
- Real viewer: 27 display checkpoints; scroll: 16/16 complete pixel and geometry
  checkpoints. No display page errors or unexpected downloads. WebGL texture
  reuse, resize and context-loss checks passed with zero mismatched channels.
- Actionlint/ShellCheck passed; npm production audit reported zero vulnerabilities.
  This is not a comprehensive vulnerability or security guarantee.
- Screenshot captured from the synthetic demo through real WebTransport, with
  the visible field edited through real MCP. Original AI-assisted logo inspected.

Follow-up patch 0016 has independent pristine replay of 16 patches and 817 source
files. Its six real mock-CDP regressions reproduced three failures before the
minimal cleanup fix and all passed afterward; the regenerated native Linux host
suite passed 425 tests with 20 intentionally ignored. These tests establish the
cleanup behavior, not the cause of every intermittent viewer connection failure.

Follow-up patches 0017–0018 have independent pristine replay of 18 patches and
820 source files. The native host suite passes 429 tests (20 intentionally
ignored), including browser-owned restoration after page-socket closure; the
client suite passes 775 tests. Real Chromium reproduces the page-close lifetime
failure and verifies browser-level restoration, and separate injected renderer
failures verify a drawable Canvas2D fallback with exact pixels. These focused
results are not a substitute for the hosted CI and full viewer integration gates.

The existing Raspberry Pi deployment was not changed or benchmarked again.
Historical Pi measurements remain explicitly labelled in docs/OPTIMIZATIONS.md.
Publish as a review branch/PR by default; do not infer a merge or release from
these local results. Record the hosted workflow outcome on the PR/canonical issue.

## Definition of done

Portable setup and documentation agree with tested code. Rendering optimizations
are preserved and attributable. Profile persistence and shared-session MCP are
qualified without production interaction. Relevant CI is adapted and its actual
status is disclosed. The repository has no operator-specific state, secrets or
private screenshots; branding does not imply upstream/vendor endorsement.
