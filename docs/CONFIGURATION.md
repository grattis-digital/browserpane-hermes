# Configuration and operations

Run commands from the repository root. The default project name is
`browserpane-hermes`. Keep a stable project name: changing it creates different
named volumes and can look like lost data. Never run two browser or Hermes
writers against the same state volume.

## Start and configure

```sh
./scripts/setup.sh
docker compose up -d --build
./scripts/doctor.sh
```

The browser and lean Hermes images build from pinned source. No host Rust, Node
or Python installation is required. Prebuilt images are an optional future
release path, not a prerequisite or a claim that published images already exist.
Allow time and disk space for the first native ARM64 build.

The default viewer is `https://localhost:8443/browser/`, reachable only from the
Docker host. Edit `.env` for explicit LAN access; see the [settings and trust
boundary](SECURITY.md#default-and-lan-settings). Setup never changes your firewall,
DNS or system certificate stores. Configure model access inside the persistent
agent volume using the [Hermes guide](HERMES.md), not Compose's public `.env`.

`BPANE_MCP_MODE=compact` is the experimental branch's default: five compact tools,
bounded observations and batched input. `BPANE_MCP_MODE=playwright` selects the
original tool vocabulary on the same private endpoint. After a change, recreate
the browser service and reconnect Hermes; retain all volumes. Existing custom
tool allowlists/instructions may need adjustment and are never automatically
overwritten. See the [protocol and compatibility guide](COMPACT_MCP.md).

## Trust the viewer certificate

Follow [root-certificate export](SECURITY.md#https-trust-export-only-the-root-certificate)
first and verify that the file came from your own stack. Trusting this CA lets
its private-key holder issue certificates accepted by the affected trust store.
Install only its public certificate, never its private key.

- Debian-based clients: place one PEM certificate with a `.crt` extension under
  `/usr/local/share/ca-certificates/`, then run `sudo update-ca-certificates`.
  For this exported file, the commands are below.
  [Debian documentation](https://manpages.debian.org/bookworm/ca-certificates/update-ca-certificates.8.en.html)
- macOS: import the exported certificate in Keychain Access, open the certificate
  and use its **Trust** settings to authorize SSL trust after verification.
  [Apple documentation](https://support.apple.com/en-gb/guide/keychain-access/kyca11871/mac)
- Windows: `certutil -user -addstore Root .\caddy-root.crt` adds it to the current
  user's root store. Follow organizational policy on managed devices.
  [Microsoft documentation](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/certutil#-addstore)

```sh
sudo install -m 0644 ./caddy-root.crt /usr/local/share/ca-certificates/browserpane-hermes.crt
sudo update-ca-certificates
```

These are optional operator actions on the viewing device, not setup automation.
Browser-specific trust policies can differ, especially on managed systems;
verify the actual Chromium viewer has no certificate warning. Keep the Caddy
volume across recreation so the root does not unexpectedly change.

## Stop and back up

The following procedure targets only the default project and its five named
volumes. It fails if a service is missing, replicated, uses a different project
or points the checked path at a bind mount or different volume. Do not bypass
those checks to make it work with an unfamiliar deployment. Adapt and review
the names explicitly if you intentionally use a different project.

Run this block in one shell. It creates a new private backup directory beside,
not inside, the checkout. Stop all writers before copying; a failed backup stays
available for diagnosis and services remain stopped until you restart them.

```sh
set -eu
umask 077
check_mount() {
  container_id=$(docker compose ps -a -q "$1")
  case "$container_id" in ''|*[!0-9a-f]*) return 1;; esac
  owner=$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' "$container_id")
  [ "$owner" = browserpane-hermes ] || return 1
  mount=$(docker inspect --format "{{range .Mounts}}{{if eq .Destination \"$2\"}}{{.Name}}:{{.Type}}{{end}}{{end}}" "$container_id")
  [ "$mount" = "browserpane-hermes_$3:volume" ] || return 1
  owner=$(docker volume inspect --format '{{index .Labels "com.docker.compose.project"}}' "browserpane-hermes_$3")
  [ "$owner" = browserpane-hermes ]
}
check_mount browserpane /data browser-data
check_mount browserpane /shared shared-files
check_mount hermes /opt/data hermes-data
check_mount hermes /shared shared-files
check_mount web /data caddy-data
check_mount web /config caddy-config
backup_dir=$(mktemp -d ../browserpane-backup.XXXXXX)
previous_commit=$(git rev-parse HEAD)
mkdir "$backup_dir/browser-data" "$backup_dir/hermes-data" "$backup_dir/shared-files" \
  "$backup_dir/caddy-data" "$backup_dir/caddy-config"
docker compose stop browserpane hermes web
docker compose cp browserpane:/data/. "$backup_dir/browser-data"
docker compose cp hermes:/opt/data/. "$backup_dir/hermes-data"
docker compose cp browserpane:/shared/. "$backup_dir/shared-files"
docker compose cp web:/data/. "$backup_dir/caddy-data"
docker compose cp web:/config/. "$backup_dir/caddy-config"
printf '%s\n' "$previous_commit" > "$backup_dir/source-commit.txt"
if [ -f .env ]; then cp .env "$backup_dir/compose.env"; fi
printf 'Private backup: %s\n' "$backup_dir"
```

This backup contains credentials and CA private keys: protect it, encrypt any
off-host copy and never upload it to an issue or source repository. Inspect the
copy and test restoration into a separate, isolated project before relying on
it. Preserve UID/GID10000 for restored browser/Hermes/shared files; Caddy uses its
own ownership. Do not restore over a running or newer profile automatically.

To resume without upgrading: `docker compose up -d --no-build`.
Do not add `-v` to `docker compose down`; that deletes persistent volumes.

## Upgrade and image rollback

Back up first and ensure `git status --short` is clean. Retain the current local
images before building replacements; these tags are local safeguards, not registry
publications. Replace `REVIEWED_COMMIT_OR_TAG` with the release or commit you have
reviewed. Keep `.env` and the named volumes unchanged.

```sh
previous_commit=$(git rev-parse HEAD)
docker image tag browserpane-hermes-browser:local browserpane-hermes-browser:rollback
docker image tag browserpane-hermes-agent:local browserpane-hermes-agent:rollback
docker compose stop browserpane hermes web
git fetch origin
git switch --detach REVIEWED_COMMIT_OR_TAG
docker compose build --pull
docker compose up -d --no-build
./scripts/doctor.sh
```

If the new images fail and the persisted data remains compatible, use the same
shell's saved `previous_commit` (also recorded in the backup) to restore the prior
source configuration and image tags without deleting volumes:

```sh
docker compose stop browserpane hermes web
git switch --detach "$previous_commit"
docker image tag browserpane-hermes-browser:rollback browserpane-hermes-browser:local
docker image tag browserpane-hermes-agent:rollback browserpane-hermes-agent:local
docker compose up -d --no-build
./scripts/doctor.sh
```

An older Chromium or Hermes may not accept state migrated by a newer release.
Image rollback is not data rollback. In that case stop and plan a separate
restore from the stopped-writer backup; never overwrite the newer data blindly.
Do not prune the rollback images until the upgrade is qualified.

## Troubleshooting

| Symptom | Checks |
| --- | --- |
| Page opens, viewer keeps reconnecting | Confirm the client resolves `VIEWER_HOST` correctly, trusts the HTTPS certificate, supports WebTransport, and can reach `GATEWAY_PORT` over UDP. A TCP-only proxy cannot carry it. |
| Certificate warning after recreation | Confirm the original `caddy-data` volume/project name is still used. Check hostname and clock. Do not bypass certificate verification. |
| Slow Pi input or high CPU | Start with Auto or 1280×720 capture, one controlling viewer, and close busy tabs/video. Higher capture resolutions require more work; local HiDPI is not Chromium zoom or GPU enablement. Inspect `docker stats --no-stream` before changing limits. |
| Browser unhealthy or repeatedly starting | Run doctor, then inspect `docker compose logs --tail=100 browserpane` privately. Check memory pressure, disk space, writable UID10000 volumes and host support for the strict Chromium sandbox. |
| Hermes is healthy but cannot answer | Health proves its process, not a configured provider or paid-model access. Follow `docs/HERMES.md`; verify the selected model and MCP discovery separately. |
| Downloads arrive unexpectedly | Only place intentional transfer files in `/shared/downloads`; keep logs and generated diagnostics in `/shared/mcp-artifacts`. |
| State appears empty | Check project name and actual named-volume mounts before creating, deleting or copying anything. |

Logs may contain browsing URLs or tool output. Do not post them unredacted.
No operation in this guide requires exposing CDP/MCP/admin ports, mounting the
Docker socket, enabling GPU devices or disabling Chromium's sandbox.
