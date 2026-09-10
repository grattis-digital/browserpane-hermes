# Trusted-host and LAN configuration

The [GPU-tail test](GPU_LIVE_TEST.md) adds mode-0600 Unix sockets inside
the trusted X11 volume. Host and worker validate peer UID 10000. It adds no network
port or privilege. Its versioned ACK has one viewer owner; older clients cannot
drive the GPU cache safely. Keep the complete paired deployment together.

The additional `bpane-gpu-health.sock` responds with eight fixed status bytes;
it cannot request capture, send input or return page data. Its native endpoint
checks the peer UID and handles clients without blocking; the browser checks
socket ownership/mode and enforces a 1.5-second response deadline. No TCP port,
Docker socket, root privilege or new device mapping is introduced. Native worker
failure/progress timeouts exit the display service for its existing restart
policy; the browser's display-generation watchdog restarts its session. This is
recovery, not isolation from shared-kernel GPU faults or a guarantee that unsaved
in-memory page state survives. See [recovery limits](GPU_LIVE_TEST.md#capture-failure-recovery).

The optional `compose.gpu-video.yaml` extends the trusted display service's
kernel-driver surface with one explicitly selected `bcm2835-codec-encode` node.
Do not map all `/dev/video*`, DMA heaps or `/dev` wholesale. The service remains
network-isolated, UID 10000, capability-dropped and resource-limited. Exported
raw DMA-BUFs remain inside the display worker; they are not an untrusted-client
capability. The browser host receives only bounded compressed access units and
validates their rectangle against the preceding complete reliable tile batch.
H.264 is lossy; only the advertised video region may be overlaid. Client checks
reject stale crop/screen geometry, but ordinary video transport remains distinct
from the lossless batch ACK and is not an end-to-end video-decode acknowledgement.
Hardware errors revert to lossless tiles, not a hidden CPU capture/encoder path.
Independent video cadence uses one extra bounded snapshot (three slots total),
not an unbounded queue or another capture owner. Its private access-unit header
is version 2: replace host and display together, retaining geometry validation,
generation revocation, whole-message output serialization and finite I/O waits.
No new network/device permission is introduced by this scheduling change.

The separate `compose.gpu-decode.yaml` candidate grants the **browser** one
explicitly identified `bcm2835-codec-decode` node. Its primary GID is that device's
group; UID 10000 and the existing capability/sandbox boundaries remain. Decoder
and encoder ownership are separate. Pinned Pi Chromium adds sandbox broker
permissions for decoder/GBM access rather than disabling Chromium's sandbox.
The candidate also bundles pinned MIT-licensed h264ify, trusted third-party code
with `scripting`/`storage` and YouTube-domain permissions. It modifies site codec
APIs, not unrelated sites or network listeners, and does not auto-update. Review
both package/extension pins for security updates; do not mistake the capability
readiness gate for per-video proof or a prohibition on software fallback. See
[qualification and source provenance](GPU_VIDEO_DECODE.md).
An empty legacy CDP codec-profile list is reported as unverified; the gate still
rejects disabled video decode, a software GPU renderer, inactive sandbox and GPU
crashes. Actual per-player V4L2 playback must be checked before rollout. The
X11 BGR4 compatibility switch changes output format, not sandbox permissions.

This bundle intentionally has no viewer login. Anyone who can reach the viewer
can obtain a browser-connect ticket and control the same logged-in Chromium
session as Hermes. Treat access to the viewer and MCP as access to your browser
credentials. Origin checks prevent cross-site browser bootstrap requests; they
are not user authentication. MCP tool exclusions prevent accidents, not abuse.

Do not expose this configuration to the public Internet, forward its ports on
your router, or attach untrusted containers to its Docker networks. It is not a
multi-tenant isolation boundary. For access outside a trusted LAN, first establish
an authenticated private network or an operator-managed access-control boundary;
the direct UDP transport must be included in that design.

## Default and LAN settings

Run `./scripts/setup.sh` to create `.env` without overwriting an existing file.
Only a POSIX shell and Docker Compose are required for this step. The script
validates Compose syntax; runtime settings receive additional validation before
Chromium starts. No firewall, DNS or system trust settings are changed.

| Setting | Default | Meaning |
| --- | --- | --- |
| `BIND_ADDRESS` | `127.0.0.1` | One host IPv4 address used for both published ports |
| `VIEWER_HOST` | `localhost` | DNS hostname or IPv4 address used by the viewing browser |
| `HTTPS_PORT` | `8443` | Published HTTPS TCP port |
| `GATEWAY_PORT` | `4433` | Published WebTransport UDP port |
| `TZ` | `UTC` | Container timezone |

Defaults are reachable only from the Docker host. For LAN access, explicitly set
`BIND_ADDRESS` to the server's LAN IPv4 address and `VIEWER_HOST` to that address
or a hostname that resolves to it from every viewing device. Wildcard binds are
rejected. Do not include a scheme, path, credentials or port in `VIEWER_HOST`.
IPv6 publishing is not supported by this minimal configuration.

Open `https://VIEWER_HOST:HTTPS_PORT/browser/` after completing certificate trust.
Compose derives the exact bootstrap origin and the gateway URL from these
settings; alternate hostnames are not automatically authorized. Recreate the
services after changing configuration. Preserve the existing volumes.

The browser page travels over HTTPS TCP through Caddy. Render/input/media use
the BrowserPane gateway's direct UDP port, with scoped connect tickets. Caddy
serves HTTP/1.1 and HTTP/2 only; it does not advertise an unpublished HTTP/3 port,
or tunnel or terminate the WebTransport path. Allow the selected TCP and
UDP ports from only the intended clients. A working HTML page alone does not
prove UDP reachability.

Docker-published traffic can bypass ordinary UFW rules. Verify the Docker-aware
forwarding rules appropriate to your host's iptables/nftables backend; do not
disable Docker's firewall management or assume a LAN bind filters source subnets.
See [Docker's firewall documentation](https://docs.docker.com/engine/network/packet-filtering-firewalls/).

## HTTPS trust: export only the root certificate

Caddy issues local certificates using its own CA. Its issuer data persists in
`caddy-data`; deleting that volume changes the CA and invalidates existing trust.
After startup, copy only the public root certificate:

```sh
docker compose cp web:/data/caddy/pki/authorities/local/root.crt ./caddy-root.crt
```

Verify the certificate through your trusted local Docker connection, then import
it into the trust store used by each viewing device/browser. Distribution and
trust are explicit operator actions. Do not export or share `root.key`, the
entire Caddy volume, the browser profile, or agent state. Do not commit exported
certificates or use browser-wide certificate-validation bypass flags. A clicked
certificate-warning exception is not a supported substitute for proper trust.
See [Caddy local HTTPS](https://caddyserver.com/docs/automatic-https#local-https).

The gateway uses a separate short-lived P-256 certificate. The viewer retrieves
its SHA-256 hash over the trusted HTTPS page and pins it for WebTransport. The
gateway rotates its certificate without restarting Chromium; viewers reconnect.
You do not install the gateway certificate into system trust or give Caddy its key.

## Private control interfaces

The cgroup-v2 OOM watchdog uses read-only container-local memory counters, with
no Docker socket, cgroup write access or new privileges. An observed kill asks
the existing supervisor to shut down the browser and exit; Docker owns restart.
This is availability recovery, not website isolation or an exactly-once action
guarantee. Unsaved page state can be lost, and a persistently memory-heavy workload
can trigger repeated recovery. No MCP mutation is automatically replayed.

| Interface | Container binding | Host publication |
| --- | --- | --- |
| Viewer HTTP | Browser container TCP8090 | None; Caddy proxies only `/browser/` |
| Compact MCP (or selectable Playwright compatibility backend) | Browser container TCP8931 | None; Hermes uses `http://browserpane:8931/mcp` |
| Gateway admin HTTP | Loopback TCP8932 | None |
| Chromium CDP | Loopback TCP9222 | None |
| Legacy CDP proxy | Disabled | None |

The MCP Host allowlist accepts the Compose service name and loopback health/test
clients, not arbitrary host headers. It is not bearer authentication. Docker
network peers and the Docker host remain trusted. Browser code must be treated
as untrusted even though Chromium is sandboxed; do not use the shared browser
for accounts whose risk exceeds this trust model.

The compact backend rejects all browser `Origin` headers, limits request bodies
to 64 KiB and sessions to eight, and serializes browser work with a bounded queue.
Its session leases prevent accidental mutation replay after reconnect; they do
not authenticate the caller. Observation refs, output budgets and upload guards
are correctness/accident controls, not a multi-tenant security boundary. Uploads
are limited to regular files under `/shared` and copied into bounded owned buffers;
trusted operators must not race file changes during upload. No arbitrary-code
tool is exposed in compact mode. Selecting the legacy backend restores its broad
tool capabilities and original transport behavior. Treat page text as untrusted
data, preserve agent approval policies, and hand challenges to a human.

Scoped MCP observations use only refs from the requesting client's latest view,
not arbitrary CSS/XPath or injected agent scripts. Coverage explicitly describes
unvisited content. Target-only preflight checks the target, not all unrelated
page state; guarded workflows retain full-page comparisons and reject scoped
guards. Ref caches/coverage are not authorization, nor an atomic human-input lock.
The four-file private Playwright extension is hash-pinned and installed with the
bundle; dependency upgrades require requalification. See
[scoped observation limits](MCP_SCOPED_OBSERVATIONS.md#limits-and-next-qualification).

The optional [Hermes workflow recorder](WORKFLOW_LEARNING.md) is disabled by
default and records only explicitly selected session/task intervals. Its closed
projection omits page/field/credential content; bounded private SQLite evidence
lives under the existing Hermes volume, not in shared downloads. Treat that
volume and backups as sensitive nonetheless. Hooks can lose events and never
constitute a complete audit or proof of business success. Captures expire/stop at
limits; deleting an exact completed capture requires an explicit `forget` call.
Deletion does not erase backups or Hermes's separate conversation history.

The agent still has terminal/file access and can modify its own state. Capture
ownership checks, skill write approvals and draft status are not enforceable
enterprise authorization. The separate [supervised report-recipe pilot](WORKFLOW_REPLAY.md)
adds a private, bounded SQLite execution journal and an explicit content/input-bound
review acknowledgement. These are not protected grants: the same writable agent
identity can bypass them. A worker lock prevents overlapping runners using the
same local store, not raw MCP calls or viewer input. No protected approval store,
cross-client browser reservation or automatic uncertain-write replay is added.
An optional `pane_flow.view` guard rejects changed first-stage accessibility state;
it does not make the page atomic or authenticate the account. Review link effects,
supervise downloads, and do not use this pilot for consequential submissions.
Journal/CSV fingerprints are not anonymization; back up sensitive state with
writers stopped. Never restore or rotate journals to retry uncertain effects.
Status uses read-only SQLite connections; mutation checkpoints retain FULL
durability. Storage contention and hot-journal recovery errors fail closed with
typed codes, not browser retries. Workflow diagnostics contain bounded codes,
exception classes and SQLite numbers only, excluding raw messages and run inputs.
MCP failure diagnostics can also include bounded progress counters and a
`mayHaveActed` flag; these cannot relax uncertainty or authorize replay.
The independent [Hermes execution plugin](WORKFLOW_EXECUTION.md) adds one lazy
worker/SDK connection, not a listener or another browser. Its private catalog
retains full reviewed URLs, target labels and bindings: protect it and backups
as sensitive data. All tool-enabled sessions in the same Hermes home share
execution IDs; this is not multi-tenant authorization. The tool cannot publish or
approve, but the same agent's filesystem/terminal identity can bypass that limit.
Cooperative cancellation stops later calls, not an already-sent fill/click batch;
only explicit read-only reconciliation may resolve a cancelled uncertain export.

Optional [workflow pacing](WORKFLOW_PACING.md) binds a policy to each reviewed
contract and adds a private, bounded origin-digest ledger beside the run journal.
It shares admission budgets across cold/warm processes with that same parent;
it does not reserve the browser or constrain raw MCP, unpaced work or another home.
Treat digest/timing metadata and backups as sensitive, stop writers for backups,
and never reset budgets to bypass a site's limits. Trusted host time is required.
Storage failure or excessive cooldown stops the run without automatic retry;
uncertain issued input still requires read-only reconciliation. No challenge
solver, hidden browser identity change or new permission is added.

The separate [Pi qualification harness](../scripts/workflow-pilot/README.md) is
an explicitly authorized, trusted-operator test. Its disposable browser, Hermes
and fixed fixture share one owned internal network namespace, using loopback
HTTP without published ports, host networking or operator firewall-policy edits. This deliberately
does not qualify production bridge access controls or isolation between those
test containers. Only the host runner has Docker authority; test images have no
operator credentials or live profiles. Fixed-fixture approval must never be reused
for arbitrary user workflows. Raw reports and their isolated failure logs stay
private; cleanup validates exact ownership and removes only test resources.

Optional `BPANE_MCP_TIMINGS=1` records only tool/phase names, monotonic durations,
counts, result size and stable error code in the already bounded container log.
It deliberately omits URLs, page text, accessible names, selectors and input
values. Diagnostics are best-effort and cannot change a browser outcome. This is
not a promise that unrelated Chromium, Hermes or site logs contain no sensitive
data; retain and share complete container logs accordingly.

No service mounts the Docker socket, uses host networking, or receives privileged
mode. The default has no GPU devices; the separate opt-in is described below.
Chromium and Hermes run as UID/GID10000. Chromium's strict
namespace sandbox, explicit seccomp profile, dropped capabilities and
`no-new-privileges` remain enabled. If sandbox startup fails, diagnose host
support; do not switch to `--no-sandbox`. Caddy uses its image's default user
with all capabilities dropped except `NET_BIND_SERVICE`, required by that image's
executable file capability even when listening on port8443, and no-new-privileges.

## Managed extension and temporary storage

The inherited Chromium policy force-installs AdBlock and configures EasyPrivacy.
Treat the extension, its publisher and subsequent Store updates as trusted code
inside the shared browser; ad blocking is not an authentication, privacy or
malware-isolation boundary. Its default Acceptable Ads behavior is preserved.
Extension/filter downloads contact external services, and their versions are
not locked by the application's Git revision. Installation state persists in
the sensitive browser profile; do not publish that profile to troubleshoot it.

The browser's `/tmp` is a bounded 1 GiB tmpfs with `nosuid,nodev`, allowing the
extension to unpack. This capacity is not preallocated and counts against the
unchanged 2300 MiB container memory limit. Heavy browsing during installation or
updates can still exhaust that limit. No host mount, listener, capability or
sandbox exception was added. Verify installation separately from service health
using the [operator checks](CONFIGURATION.md#managed-ad-blocking).

## Optional GPU access

`compose.gpu.yaml` explicitly grants the browser and display sidecar access to
the verified V3D render and VC4 display nodes. Stable by-path device links avoid
accidentally selecting a different driver after reboot. This exposes additional
kernel-driver attack surface; it is not equivalent to the device-free baseline.
`/dev/dri` is also visible read-only so libdrm can resolve canonical node names
after renumbering. The two-device cgroup allowlist, not the read-only mount,
restricts device I/O; other visible GPU nodes must fail to open in qualification.
The display and browser share a dedicated X11 socket volume and IPC namespace.
X11 peers must be mutually trusted; do not attach unrelated containers to either.
The display has no network or published listener, no profile/shared-file mounts,
and runs UID10000 with dropped capabilities/no-new-privileges. Its unused VNC
socket remains private inside its own temporary filesystem.

Chromium's namespace/GPU sandbox and explicit seccomp remain active. The narrow
opt-in Rust scheduling shim returns EPERM for one optional thread-priority hint,
not a forged success or a sandbox exception. It is preloaded only in Chromium's
process tree, not globally. A failed V3D/sandbox hardware check blocks promotion;
do not use no-sandbox or disable-gpu-sandbox flags. Follow [GPU qualification](GPU.md).

## Experimental GPU dummy driver

The related [Chromium damage patch](../native/chromium-damage/README.md) is
source-only and default-off; product images do not include it. Its preparation
helper only creates a new private source subset with pinned hashes and bounded
downloads. It does not execute fetched hooks or replace an existing checkout.
Treat the patch, compiler and dependencies as trusted native code: hash checks
are provenance checks, not sandboxing or a hostile-local-user boundary. The
internal metadata comes from Viz, not a new page/CDP permission or protocol.
No ports, device grants, host settings, browser sandbox rules or production flags
are changed. Any future custom-binary test needs the existing disposable-profile
and explicit hardware authorization boundaries; passing the standalone policy
does not qualify the modified browser.

`compose.gpu-dummy-test.yaml` is a standalone opt-in lab, not an application
override. It runs new native Xorg driver code with a Rust core and C adapter;
Rust does not make Xorg, the adapter, Mesa or kernel drivers memory-safe.
The isolated Pi 4 synthetic display gate passes; Chromium and viewer execution
are not qualified. Never attach an existing browser,
credential-bearing profile, host display or unrelated X11 client to it.

The lab grants one verified V3D render-node alias to UID10000 plus its device
group, with read-only `/dev/dri` visibility for libdrm. Other visible DRM nodes
must remain blocked by the device cgroup. No KMS/VC4 display device, DRM master,
extra capability, Docker socket, network, published port or persistent volume is
granted. The X11 server uses `-ac` only inside its private network/Unix-socket
namespace: this is not authentication. DRI3 hands connected trusted X11 clients
a render-device FD; the X11 socket itself therefore grants GPU access. Do not
share it beyond the intended trust boundary or rely on a receiving container's
device-open rules to revoke an already passed FD.

The root filesystem is read-only and temporary/SHM memory is bounded. The 64 MiB
driver root-allocation ceiling is not a total pixmap/GPU-memory limit, and GPU
allocations may not all be accounted identically to ordinary container memory.
Watch host GPU memory as well as cgroup/OOM counters. The lab has no automatic
restart loop; a hang or context loss fails its finite qualification. Xorg logs
are bounded by container rotation but should still be reviewed before sharing.

`test-display` is a separately compiled software fixture, never selected by the
lab or application. Its local harness validates immutable image, UID, unique label,
network, mounts and devices before lifecycle changes or cleanup. Both fixture
and real-driver images are tested without device access for a fail-closed gate.
The CPU baseline and Chromium sandbox rules remain unchanged. Follow
the [driver guide](../native/gpu-dummy/README.md); build/test success does not
authorize changing host packages, boot settings, firewall or live services.

The optional `BPANE_GPU_LEASE=1` [frame-lease experiment](GPU_FRAME_LEASE.md)
adds a local X11 extension, not a new listener or production setting. It exports
the captured display's DMA-BUFs and native completion fences. Only one local,
native-endian capture owner controls the three-slot pool; token checks prevent accidental stale
release, not hostile access. DMA-BUFs are not read-only and the consumer must
complete GPU reads before release. Already exported FDs cannot be revoked by
device cgroups or X11 disconnect. Retained client imports may keep GPU memory
alive after server cleanup; three slots bound the server pool, not hostile-client
memory retention. Do not expose this socket to unrelated clients or workloads.
The finite probe uses synthetic pixels and keeps full-frame CPU oracles outside
measurement; it never attaches to a live browser. The default CPU Compose does not select the driver. The explicit GPU Compose
selects its live target, enabling leases and the Vulkan worker together.

The finite `scripts/gpu-dummy-pilot.py` alternative requires explicit permission
for its temporary host workload. It validates the immutable ARM64 image, UUID
label, UID, network/device/mount/capability boundary and resource limits before
lifecycle operations. It grants only the verified render node; there is no
Docker socket inside the test container. It checks memory/temperature between
bounded probes, not continuously, and leaves a private ownership/report record
for recovery if the harness is killed. Inspect exact identity before manual
cleanup; never prune unrelated resources. Reports contain host/container metadata
and must remain private until sanitized. Imported test images and reports are
not automatically deleted. The optional ASAN fixture instruments only the C adapter, not the whole stack.

## Explicitly authorized render-pipeline pilot

The separate [render-pipeline pilot](../scripts/render-pilot/README.md) requires
explicit approval for its temporary HTTPS TCP and WebTransport UDP listeners,
restricted to one client IPv4. It adds exact owned iptables rules before publishing
and removes only those rules after removing its containers/network. An incomplete
cleanup retains restrictions and requires exact-identity manual recovery; no
global firewall reload, policy change or pruning is allowed. Only the trusted host
runner has Docker authority. CDP, MCP, gateway admin and X11 remain unpublished.

Its fresh browser test context accepts the synthetic endpoint's self-signed HTTPS
certificate; this does not install trust, disable Chromium sandboxing or disable
the existing WebTransport hash pin/origin guards. This deliberately narrow testing
exception does not qualify production certificate trust. The dedicated bridge
blocks unsolicited egress and host access; store/extension installation and real
website loads are outside the pilot. Private ownership/failure reports and imported
images remain on the host; never share raw reports or operator configuration.

The default-off `nativeDamageTrace` diagnostic may retain internal Chromium layer
and GPU trace metadata, even though the page is synthetic. It accepts only the
pilot's single token-checked blank-page fixture and private loopback CDP endpoint;
it never attaches to a live browser. Raw traces remain in the private pilot
directory, are bounded and exclusively created, and must not enter Git or CI
artifacts. The normal latency phases are skipped while tracing. The native EGL
`--damage` oracle uses the existing network-free display pilot with no new host
devices or listeners; its full pixel reads are correctness checks, not production
capture behavior. Neither diagnostic enables a new runtime capture backend.

The default-off `vulkan-check` target and `vulkan-lease-pilot.py` add a trusted
Vulkan consumer only inside an owned synthetic display container. No production
image, service, listener or host Vulkan installation is changed. It validates
V3DV render-device identity, bounded geometry and the exact imported storage-image
format/modifier, imports producer fences, and releases foreign queue ownership
before relinquishing leases. Intermediate buffers are never CPU-mapped. Output
counts are bounded before CPU copying; source frames remain private.
Unsupported imports and validation/oracle errors fail the test without a CPU
conversion fallback. The shared physical GPU is not fault-isolated by Docker.
The `uif` lease allocator uses only the existing render-node allowance and public
V3D BO-allocation UAPI, with a bounded trailing guard page for Mesa import
compatibility. It does not add KMS/master access, a CPU mapping or a new listener.
Fresh buffers are cleared before export; layout metadata is allocator-derived.
The 90-second test deadline and pressure checks bound normal workload execution,
not recovery from a hung kernel/driver. Retain raw reports privately and never
run this probe on a production display or against a live browser profile.

The optional [stack audit](GPU_STACK_AUDIT.md) has a 180-second workload deadline
and the same container/device/ownership restrictions. Diagnostic engine counters
come only from the consumer's own `/proc/self/fdinfo`; DRM client IDs deduplicate
shared descriptors. No host PID namespace, profiling capability, debugfs mount,
global trace configuration or scheduler/clock setting is added. Stage correctness
oracles may copy intermediate flags **after** measurement into the existing
bounded final buffer; the timed GPU stream never reads those flags on the CPU.

The opt-in [GPU cache/encoding tail](GPU_CACHE_ENCODING.md) keeps the same device
and ownership restrictions, with a 180-second workload deadline. Its trusted
consumer retains at most an ACK image and pending image. Cache tokens require
exact pixel verification and receiver acknowledgement; rejection never promotes
pending metadata. No public endpoint or production viewer ACK handling is added.
The final-byte transport test uses an unnamed local socket pair, not a listener.
Optional wire evidence contains only synthetic fixtures, is created exclusively
in the owned container's tmpfs, is capped at 32 MiB and is exported into the
private pilot directory. It must not be confused with consent to record a user's
display or profile. GPU fault isolation and production recovery remain unproven.

## Persistent data and shared files

- `browser-data` mounts only into Chromium's container at `/data`; the profile
  lives at `/data/profile` and contains cookies, sessions and credentials.
- `hermes-data` mounts only into Hermes at `/opt/data`; model configuration,
  secrets, memory and agent sessions stay separate from the browser.
- `shared-files` mounts into both at `/shared`. Both images initialize this path
  for UID/GID10000. Do not override only one service's runtime UID.
- `/shared/downloads` is the browser file-transfer directory. Files put there
  may be automatically downloaded by connected viewers. MCP diagnostics instead
  use `/shared/mcp-artifacts`, preventing log-download loops.
- `caddy-data` and `caddy-config` belong only to ingress. Keep the CA key private.

Empty named volumes inherit image directory ownership. Verify writable volumes
on initial setup and after migration; do not solve permission errors with
world-writable permissions or recursive ownership changes on arbitrary host
directories. Bind-mount conversions require deliberate matching ownership and
are not performed by setup. Shared downloads and logs consume disk indefinitely
unless the operator applies retention; resource limits are not storage quotas.

Use `docker compose stop` for graceful profile flushing before backups. Back up
each named volume separately while its writers are stopped. Preserve volumes
when upgrading or recreating containers. Never use `docker compose down -v`
unless you explicitly intend to delete the profile, agent state and TLS issuer.
Image rollback does not reverse changes to a newer browser profile.

## Diagnostics and limitations

`./scripts/doctor.sh` checks runtime configuration, local readiness, loopback
CDP/admin listeners, disabled CDP proxy and the MCP listener. It prints only
boolean results and Compose service state, not tokens, environment variables or
browsing URLs. It does not prove client DNS, TLS trust, UDP reachability, model
access, full sandbox effectiveness or firewall isolation. Open the real viewer
and complete the deterministic MCP smoke for those integration checkpoints.

Disposable tests may explicitly set `BPANE_PIPELINE_TEST=1` to permit a loopback
HTTP viewer origin (a browser secure-context exception). Compose never enables
this flag; it cannot authorize a non-loopback HTTP origin or an HTTP gateway.

Hosted MCP tests install a temporary AppArmor user-namespace exception for one
exact test-Chromium executable on their ephemeral GitHub-hosted Ubuntu runner.
This is CI setup, not a product policy or a local setup command. The helper refuses
developer/self-hosted environments, retains Chromium sandboxing and does not
disable Ubuntu's global user-namespace restriction. As with any path-based policy,
code able to replace that exact runner binary can reuse the exception; CI runs
untrusted repository code only on disposable runners without deployment secrets.
The profile is removed by owned cleanup; no policy is installed on the Raspberry.

Report suspected vulnerabilities using the repository's [security reporting
guidance](../SECURITY.md). Remove secrets, browser content and personal identifiers
from diagnostics; do not upload raw profiles, `.env` files or operator histories.
