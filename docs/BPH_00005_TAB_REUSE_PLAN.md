# Reuse shared tabs and bound restart-related tab growth

User-requested follow-up on the integration: avoid unnecessary
tabs on resource-constrained hosts. Reuse an existing default whenever possible,
without closing human tabs or silently redirecting guarded input.

## Implementation contract

- Untargeted compact observations select one suitable existing tab and keep it
  stable across clients, popups and MCP session reconnects until it closes.
- Prefer existing web/new-tab pages to internal browser UI. Registration order
  is not a promise about visual tab-strip order after rearrangement or restore.
- Mark the default in `pane_tabs`; guide normal URL changes through guarded
  `navigate` in that tab. Explicit `new` remains a deliberate operation.
- Preserve per-session leases, request replay and exact tab/view checks. Never
  retarget stale mutations to a replacement default. No auto-close or focus
  changes during discovery, listing or observation.
- Suppress redundant startup URLs when restoring an existing Chromium session;
  retain the configured initial URL for fresh profiles and existing app-mode
  semantics. No profile/session-file rewriting or automatic tab cleanup.
- Keep tool guidance, Quick Start and Hermes description-refresh caveats aligned.

## Verification

Default-tab implementation passes nine focused regression tests, including actual
MCP SDK HTTP session deletion/reconnection against counted synthetic pages.
The full Node suite passed 212 tests before the separate startup follow-up.
The disposable real-Chromium MCP suite passed all 23 named checks, including
HTTP multi-client reuse, repeated in-place navigation, reconnect, default closure
and fail-closed stale input. These are local synthetic checks, not paid model
behavior or production-profile tests.

Startup patch 0021 passes twelve executable shell regressions: fresh/preferences-only,
empty/header-only/closed-tab-only records, modern and legacy session records,
and two supervised launches in each fresh/restored and normal/app combination.
URL selection is recalculated for every retry; the bundle's single `Default`
profile is the explicit scope. Chromium remains responsible for session validity.
The startup checkpoint passed 224 Node tests, and strict pristine replay of all 21 patches
matches the generated source byte-for-byte.

A subsequent isolated Pi check exposed a close/title-list race. Listing now
omits only pages confirmed closed, reconciles the surviving default after title
reads, and propagates unrelated errors or browser disconnection. Six deterministic
regressions cover immediate/delayed closure and live-page failures. The combined
suite passes 230 Node tests; all 23 real-Chromium MCP checks pass again.

The native ARM64 CPU image passed the full disposable runtime check: a fresh
profile opened exactly the configured first-launch URL, then the test deliberately
added a second synthetic tab. Reconnect, an actual container restart and removal/
recreation on the same owned volumes each preserved exactly those two tab URLs,
without navigation to mask lost state. Cookie, local storage, shared file, genuine
download, five MCP tools, trusted scrolling, console/download isolation and
foreign-origin rejection also passed. These checks use fresh isolated resources,
not production profiles; they do not establish GPU performance or model behavior.

The final GPU derivative also passed isolated Pi checks: three successive HTTP
MCP runs kept five existing synthetic tabs at five through observation,
navigation, session reconnect and explicit temporary-tab cleanup/replay. The
same five tab URLs survived browser-container recreation and a further restart;
the hardware GPU/sandbox gate and cookie/local-storage/shared-download checks
passed afterward. The derivative retains the qualified native/Chromium/Mesa
layers; it changes only server/startup source and the corresponding source archive.
This is not a paid-model behavior or end-to-end rendering benchmark.

Production deployment, hosted CI and publication remain separate operator steps;
no such outcome is asserted here. Operator artifacts remain private.
