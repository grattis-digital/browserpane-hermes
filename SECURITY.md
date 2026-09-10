# Security policy

The opt-in [GPU-tail experiment](docs/GPU_LIVE_TEST.md) adds a mode-0600 Unix
socket inside the trusted shared X11 volume, with same-UID peer checks. It adds
no network port and supports one acknowledged viewer. Deploy all paired
components together; this path is not production-qualified.
Its optional video layer grants the display service access to one hardware
encoder node. It does not expose that device to Chromium or add a network port.
The independent video worker requires the paired version-2 host and three-slot
driver; the existing single X11 capture owner and tile ACK checks remain.
See [GPU video boundaries](docs/GPU_LIVE_TEST.md#optional-pi-4-hardware-video-regions).
The separate [incoming decode candidate](docs/GPU_VIDEO_DECODE.md) additionally
grants Chromium one decoder device and loads pinned h264ify code on YouTube.
This expands its trusted driver/extension surface; sandboxing remains required.

This is a trusted-host/LAN, single-browser bundle, not an Internet-facing or
multi-tenant service. Read [deployment boundaries and configuration](docs/SECURITY.md)
before granting another device access. The shared browser profile contains
credentials; anyone admitted to the viewer or MCP can operate that session.
Compact MCP's leases, observation references, replay protection and file-path
checks are accident guards, not user authentication or a hostile-tenant sandbox.
Website text and tool results are untrusted data; never treat them as authority
to disclose secrets, change instructions or bypass site access restrictions.
The inherited, automatically updated AdBlock extension is also trusted browser
code, not a substitute for sandboxing or access control; see its
[trust and resource boundary](docs/SECURITY.md#managed-extension-and-temporary-storage).
The optional GPU configuration grants narrowly mapped driver access and a shared
private X11/IPC boundary; see [GPU access](docs/SECURITY.md#optional-gpu-access).
The separate [GPU dummy-driver laboratory](docs/SECURITY.md#experimental-gpu-dummy-driver)
contains experimental native display-server code. The GPU Compose option uses
its live Vulkan target; the standalone laboratory is a separate test boundary.
Its finite Pi pilot requires explicit host authorization and keeps diagnostic
reports private; a synthetic hardware pass does not qualify browser isolation.
Its default-off [GPU frame-lease extension](docs/GPU_FRAME_LEASE.md) passes screen
DMA-BUFs and synchronization FDs to one cooperating local X11 consumer. The private
X11 socket remains the trust boundary; leases are not read-only-buffer enforcement.
The separate [Pi-to-viewer render pilot](scripts/render-pilot/README.md) requires
explicit temporary LAN-port/firewall approval. It uses source-restricted ephemeral
HTTPS/UDP endpoints and a fresh synthetic test browser, never the live profile.
Its test-context HTTPS trust exception is not a production deployment option.
Its default-off native-damage tracing retains private Chromium metadata and is
restricted to the disposable synthetic fixture; never publish the raw traces.
The [Chromium surface-damage patch](native/chromium-damage/README.md) is a
default-off, source-only experiment. It is not installed by Compose and grants
no device, listener or sandbox exception. Source hashes verify selected bytes,
not native-code safety or full dependency provenance; custom-browser runtime
qualification remains outstanding.

On cgroup v2, the memory watchdog reads the container's OOM-kill counter and
requests graceful session recovery when it increases. It adds no privileges or
listeners and never replays MCP input. Recovery may still lose unsaved page state;
resource limits and the watchdog are not protection against a hostile website
exhausting memory repeatedly. See [operations](docs/CONFIGURATION.md#memory-pressure-and-recovery).

The optional [workflow-learning recorder](docs/WORKFLOW_LEARNING.md) retains
bounded, content-minimized evidence in the sensitive Hermes volume. Its hooks
are best-effort and its drafts are unverified; it is not an execution audit,
authorization boundary or unattended workflow engine.
The separate [report-recipe pilot](docs/WORKFLOW_REPLAY.md) journals intent and
refuses blind replay, but its local review acknowledgement is not protected from
the same agent identity. It is for supervised downloads, without a browser
reservation or a claim of exactly-once website effects.
Its opt-in [Hermes execution tool](docs/WORKFLOW_EXECUTION.md) uses a private
catalog containing reviewed URLs and input values. Treat that volume as sensitive.
Cancellation is cooperative, not rollback; IDs and local file permissions are
not authorization between sessions sharing the Hermes identity.
Read-only status does not mutate the journal; typed storage errors never authorize
replay. Workflow failure logs exclude raw exception messages and browser inputs.
Optional [per-contract pacing](docs/WORKFLOW_PACING.md) stores private origin
digests, timestamps and budgets beside the journal. It adds no listener or access
right, and is not global enforcement against the same agent identity or raw MCP.
Preserve this ledger with journal/catalog backups; a deferred run never auto-retries.

The optional [hardware pilot harness](scripts/workflow-pilot/README.md) requires
explicit operator authority and uses fresh labelled resources only. Its test-only
shared network namespace and fixed-fixture approval are not production security
boundaries. Keep raw hardware reports private; it does not change operator firewall
policy or enable execution in an existing agent.

For a suspected vulnerability, use GitHub's
[private vulnerability report](https://github.com/grattis-digital/browserpane-hermes/security/advisories/new).
Private reporting is enabled on this repository. If that option is absent in a fork,
open an issue requesting a private contact method without publishing exploit
details, credentials, browsing data or personal identifiers. No public security
email or response-time guarantee is currently advertised.

Include affected versions, a minimal synthetic reproduction and the impact you
observed. Do not attach `.env` files, profiles, keys, raw agent histories or
private deployment diagnostics. Report defects in this fork here; do not assume
upstream BrowserPane or Hermes maintains this specialization.

Security fixes are developed against the current maintained bundle branch;
historical/private deployment tags are not a supported update channel.

The default-off [Vulkan frame-lease experiment](native/vulkan-lease/README.md)
has disposable synthetic test targets and an explicitly opt-in live Compose target. DMA-BUFs, shaders and the local producer
are trusted; container isolation does not isolate faults in the shared GPU.
Its optional stack audit reads only its own DRM client counters; it does not
enable global tracing or change the host scheduler. See [audit scope](docs/GPU_STACK_AUDIT.md).
Experimental live capture recovery adds a same-UID, mode-0600 health socket in
the private X11 volume, without new network listeners or privileges. Deploy its
browser/display health changes together; see [recovery limits](docs/GPU_LIVE_TEST.md#capture-failure-recovery).
