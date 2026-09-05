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
| Playwright MCP | Browser container TCP8931 | None; Hermes uses `http://browserpane:8931/mcp` |
| Gateway admin HTTP | Loopback TCP8932 | None |
| Chromium CDP | Loopback TCP9222 | None |
| Legacy CDP proxy | Disabled | None |

The MCP Host allowlist accepts the Compose service name and loopback health/test
clients, not arbitrary host headers. It is not bearer authentication. Docker
network peers and the Docker host remain trusted. Browser code must be treated
as untrusted even though Chromium is sandboxed; do not use the shared browser
for accounts whose risk exceeds this trust model.

No service mounts the Docker socket, uses host networking, or receives privileged
mode or GPU devices. Chromium and Hermes run as UID/GID10000. Chromium's strict
namespace sandbox, explicit seccomp profile, dropped capabilities and
`no-new-privileges` remain enabled. If sandbox startup fails, diagnose host
support; do not switch to `--no-sandbox`. Caddy uses its image's default user
with all capabilities dropped except `NET_BIND_SERVICE`, required by that image's
executable file capability even when listening on port8443, and no-new-privileges.

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

Report suspected vulnerabilities using the repository's [security reporting
guidance](../SECURITY.md). Remove secrets, browser content and personal identifiers
from diagnostics; do not upload raw profiles, `.env` files or operator histories.
