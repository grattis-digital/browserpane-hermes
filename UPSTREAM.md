# Provenance

Source: https://github.com/ITmedes/browserpane
Commit: 91e0e1b0c772f8ac333b9ccd6fa09ea35b2673e3

Reused with the focused, versioned performance/correctness patches in `patches/`:
bpane-host, bpane-gateway and the browser client's capture/cache/rendering paths.
`scripts/fetch-upstream.sh` applies these patches to the pinned source; it refuses
to overwrite an existing snapshot. Host and gateway must be upgraded together:
the paired build uses a reserved CacheMiss coordinate to request a full snapshot.
The original WebTransport, lossless tile, scroll-copy, H.264 and audio architecture
remains; this is not a replacement streaming implementation.

Reused without edits: bpane-protocol, Xorg dummy configuration, CSS extension,
managed policies and Playwright MCP resolver. The host startup script additionally
gets the private-listener patch. Tracked `runtime/host-runtime.env` retains the
upstream capture/audio/codec values; single-browser display, startup URL and logging
are explicit Compose overrides.
`scripts/build.mjs` bundles the patched client with no transport substitution.
The audio worklet is copied unchanged alongside the bundle.

The gateway uses its existing static_single runtime and in-memory state. Its
other administration capabilities remain compiled but unused. There is no
separate database service, OIDC server, broker, workflow worker, recording service
or admin UI. Hermes maintains its own SQLite state in the agent volume.

New administration code: single-session HTTP bootstrap, short-lived gateway
certificate supervisor, persistent-profile lifecycle wrapper and simple viewer
shell. Runtime overrides select existing persistent paths, blank startup page,
strict namespace sandbox and non-verbose logging. Rendering/codec tuning comes
from the upstream runtime file unchanged. The earlier custom WebSocket adapter
and disabled-video configuration have been removed.

The viewer shell provides physical capture presets and local density/fitting
controls. Patch `0014-client-display-controls.patch` adds live client display
configuration and ownership reporting; it does not change the transport protocol,
native capture pipeline or shared Chromium DPI. See
`docs/DISPLAY.md` for the monitor policy and verification.

Patch `0016-restore-window-state-after-resize-failure.patch` fixes host CDP resize
cleanup: an intermediate bounds error no longer skips the attempt to restore a
temporarily changed window state. Its native tests use a scripted WebSocket peer;
it does not force maximization or change capture/transport protocols. Sixteen
ordered patches now define the generated snapshot; see `docs/BACKPORTING.md`.

Debian packaging includes a WirePlumber 0.4 override disabling its optional
logind seat integration: there is no host system bus or Bluetooth device in
this container. The original virtual desktop-audio sink and Opus path remain.

This derivative retains the upstream root AGPL-3.0 license and attribution.
Upstream Cargo metadata says MIT, which conflicts with its root license; this
project preserves the root license rather than changing upstream licensing.
Playwright MCP uses Apache-2.0; other dependencies retain their own licenses.
Corresponding source is served on the private LAN at `/browser/source`.

## Hermes integration

Hermes Agent source: https://github.com/NousResearch/hermes-agent

Pinned revision: `ee5b5ec21e576ccf9b941f9ff71330418415a5cb`.
Hermes retains its upstream MIT license and notices inside its image. This bundle
adds a focused build, initialization/configuration and MCP wiring; it does not
claim authorship of the agent. The image builds against the upstream frozen lock
with the MCP extra instead of shipping the full upstream dashboard/TUI/browser stack.
See `hermes/` and `docs/HERMES.md` for the exact runtime contract and verification.

## Build provenance

`UPSTREAM_COMMIT` and the ordered `patches/` are canonical. `upstream/` is generated
and ignored, not a second editable source of truth. Docker prepares it from the
pinned revision. `scripts/package-source.sh` uses a public-source allowlist to
include the derivative source and patched native/client snapshot in the runtime
source archive without operator profiles, credentials or environment files.

The fork preserves upstream Git history. Removed enterprise components are not
part of the current tree or runtime bundle. Historical private rollout artifacts
from the development machine are not included in this repository.

Chromium namespace-sandbox seccomp profile: Microsoft Playwright v1.58.2,
utils/docker/seccomp_profile.json, Apache-2.0:
https://github.com/microsoft/playwright/blob/v1.58.2/utils/docker/seccomp_profile.json
The Apache license text is retained in `runtime/LICENSE.chromium-seccomp`.
One adaptation allows `chroot` without container CAP_SYS_CHROOT because
Chromium needs it inside its own user namespace. All browser-container capabilities
remain dropped. This is not a no-sandbox deployment.

Caddy is used as its published official image (Apache-2.0), not reimplemented.
Its pinned reference is in `compose.yaml`; its image retains its own notices.
The browser image retains distribution and npm dependency license files.
