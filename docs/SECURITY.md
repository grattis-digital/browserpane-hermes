# Trusted-host and LAN configuration

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
