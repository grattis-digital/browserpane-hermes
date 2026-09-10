# Current architecture and working boundaries

This repository packages one persistent Chromium session shared by a human
viewer and Hermes over MCP. It has no multi-tenant administration platform.
Read AGENTS.md, README.md and the language standards before changing it.

## Deployment

The default is CPU Chromium/Xorg. The only GPU deployment is the explicitly
experimental custom Rust-core/glamor Xorg driver and Vulkan tile pipeline.
See [the mode comparison and setup](../README.md#rendering-modes).
Optional Pi 4 video encoding and decoding are separate hardware-dependent
overrides. Persistent profiles and shared files stay in the same named volumes.

## Source of truth

The wrapper, native components and ordered patches are tracked source.
`upstream/` is an ignored generated snapshot: replay patches against
UPSTREAM_COMMIT, never hand-edit it as the only copy of a change.
Keep host/gateway/client contracts together, especially GPU ACK/cache ownership,
video ordering, resize and recovery. See [backporting](BACKPORTING.md).

Compact MCP uses bounded progressive observations, immutable observation
pagination and guarded Playwright actions in the existing shared tab.
Workflow learning, supervised replay and site pacing remain opt-in.
They grant no additional authority for submissions or other consequential acts.

## Verification and publication

Run wrapper/client/Python regressions, strict pristine patch replay, affected
native tests and Compose checks. Browser fixtures must own disposable profiles
and use one browser at a time. Software Vulkan tests do not establish Pi
performance; hardware tests require a separately authorized isolated window.

Keep operational addresses, profiles, credentials, raw browsing traces,
implementation chronology and private development revisions out of public
documentation and performance records. Retain synthetic measurement durations,
workload definitions, dependency provenance and honest qualification limits.
The deployment must never be changed as a side effect of repository tests.
