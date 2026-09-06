# Bundled Hermes agent

The `hermes` service uses the same persistent Chromium session as the browser
viewer. Hermes connects to BrowserPane's existing MCP endpoint; it does not launch
another Chromium. The browser profile is not mounted into the agent container.

## First use

Complete the repository's Compose/TLS setup, then start the services:

```sh
docker compose up -d --build
docker compose exec hermes hermes model
docker compose exec hermes hermes --cli
```

`hermes model` selects a provider/model and stores credentials in the persistent
Hermes home. OpenRouter is the simplest core-dependency path in this lean image.
Use your own provider account; model requests may incur charges. The automated
checks below do not make model requests.

The agent's default foreground process is `hermes gateway run`. It remains alive
for cron even without configured messaging platforms. It is not a web dashboard
or a chat connection: use the interactive CLI command above to talk to the agent.
Container health means the gateway process is running, not that a provider,
messaging channel, or account balance has been validated.

This image deliberately omits the Node-based TUI/dashboard, built-in Chromium,
voice/media toolchain, and optional messaging/provider SDKs. Use `--cli`, not
`--tui`. To add a feature requiring an SDK, extend the locked image with its
explicit upstream extra and test it; runtime lazy installation is disabled.
Do not install services with `hermes gateway install` inside the container.
Compose manages the foreground process.

## State and shared files

| Named volume | Container path | Purpose |
| --- | --- | --- |
| `hermes-data` | Hermes `/opt/data` | Config, credentials, conversations, memories and cron state |
| `browser-data` | BrowserPane `/data` | Persistent Chromium profile; not exposed to Hermes as files |
| `shared-files` | Both `/shared` | Files the agent and browser intentionally exchange |

Both containers run as UID/GID `10000:10000`, with image-owned mount points so
fresh named volumes have the correct ownership. Do not replace these with
root-owned bind mounts without preparing those exact directories deliberately.

The initial configuration is copied to `/opt/data/config.yaml` only when absent,
with private permissions and atomic no-overwrite publication. A restart/rebuild
never overwrites an operator's existing config or `.env`. Changes to the shipped
template therefore do not silently migrate existing installations.

Hermes' terminal runs **inside the agent container**, with `/shared` as its
working directory. It has no Docker socket, host terminal, or privileged mode.
Its file-write allowlist includes `/opt/data` and `/shared`. That allowlist is an
accident-reduction guard for file tools, not a sandbox for arbitrary terminal code.

Browser downloads belong in `/shared/downloads`; MCP screenshots, PDFs and logs
belong in `/shared/mcp-artifacts`. Keeping diagnostics outside the watched
downloads directory avoids accidental log downloads in the viewer. Because both
containers see the same `/shared` path, MCP upload paths need no translation.
Example file exchange:

```sh
docker compose exec -T hermes sh -c \
  'umask 077; set -C; cat > /shared/document.txt' < ./document.txt
docker compose cp hermes:/shared/downloads ./downloads
```

The upload creates a private file as UID10000 and refuses to overwrite an
existing file. Plain `docker compose cp` into a container can instead create
root-owned files, leaving a source file with private permissions unreadable by
Hermes. See [Docker copy ownership](https://docs.docker.com/reference/cli/docker/container/cp/).

Treat all three volumes as sensitive. The browser session may already be logged
in, and agent transcripts may contain private material. Stop writers before a
backup. `docker compose down` keeps volumes; `down --volumes` deletes their data.
Self-hosting the profile does not keep every agent interaction offline: page
text, screenshots, extracted content and shared files can be included in requests
to the configured model provider. Review the task, provider and account policies
before granting the agent access to sensitive browsing sessions.

## MCP configuration

The initial config contains:

```yaml
terminal:
  backend: local
  cwd: /shared
agent:
  disabled_toolsets: [browser]
platform_toolsets:
  cli: [terminal, file, skills, todo, memory, browserpane]
mcp_servers:
  browserpane:
    url: http://browserpane:8931/mcp
    timeout: 120
    connect_timeout: 30
    supports_parallel_tool_calls: false
    sampling:
      enabled: false
    tools:
      exclude: [browser_close, browser_install]
```

The literal MCP server key `browserpane` is also its toolset name. Current Hermes
tool names are prefixed `mcp__browserpane__`; the exclusion list uses the original
unprefixed names. Native Hermes browser tools are disabled. Parallel tool calls
and server-initiated model sampling are not enabled for this shared browser.

Excluding browser-close/install tools prevents common mistakes; it does not
prevent an agent with arbitrary-code tools from performing equivalent actions.
Give the agent an explicit task and require confirmation for consequential
actions. Human intervention and MFA stay in the viewer.

MCP port `8931` is reachable on the private Compose networks, with Hermes using
the `agent` network; it has no host port mapping. BrowserPane also joins the
`viewer` network, whose containers can reach that listener. Browser CDP remains
loopback inside BrowserPane. The Hermes service
has no published ports. See [security guidance](SECURITY.md) for the trusted-user
LAN boundary and the limits of Docker network isolation.

### Attach an existing Docker-based Hermes

Start only the browser and ingress if you do not want the bundled agent:

```sh
docker compose up -d --build browserpane web
```

The default Compose project name is `browserpane-hermes`. Keep it stable: its
agent network is `browserpane-hermes_agent` and its shared volume is
`browserpane-hermes_shared-files`. If you use `-p` or `COMPOSE_PROJECT_NAME`,
substitute that project's actual names below. A different project name creates
different storage; it is not an upgrade of the existing profile.

For an already running **trusted** agent container, attach the private network
(replace `existing-hermes` with that exact container's name):

```sh
docker network connect browserpane-hermes_agent existing-hermes
```

Now merge the MCP entry above into that agent's own `config.yaml`, disable its
native browser toolset, and include the `browserpane` toolset for its intended
platform. Do not replace an existing configuration wholesale. Start a fresh
Hermes session so it discovers the new tools. The endpoint is
`http://browserpane:8931/mcp`: Docker supplies the `browserpane` DNS name to peers
on this network. The agent must already have a compatible MCP client dependency.
Its provider credentials and Hermes home remain its own.

An ad-hoc network connection survives a container restart but not replacement.
For persistence, add an **external** network to the existing agent's own Compose
configuration and attach its service to it, retaining its existing networks:

```yaml
services:
  hermes: # Use the existing agent's actual service key.
    networks: [default, browserpane-agent]
networks:
  browserpane-agent:
    external: true
    name: browserpane-hermes_agent
```

Basic browser control needs no shared-volume mount. File exchange is optional:
declare `browserpane-hermes_shared-files` as an external volume in the agent's
Compose configuration and mount it at `/shared`. Match UID/GID10000 and permit
`/shared` in the agent's file-write policy. Adding a mount requires recreating
the agent container from its own complete configuration; `docker network connect`
cannot add a volume. Preserve its existing home/config volumes when doing so.

Attaching an agent gives it a route to the private browser control interfaces;
do not attach untrusted containers. A host-native Hermes process cannot use this
Compose DNS name directly. Host-native or remote attachment requires a separately
designed private route and is not provided by this minimal recipe. Do not publish
unauthenticated MCP to the internet as a shortcut.

## Configuration and credentials

Prefer `hermes model` or `hermes setup` inside the container so credentials are
stored in `/opt/data/.env`, not the image or repository. Keep credentials out of
Compose command arguments, Git and diagnostic output. The root bundle `.env`
configures deployment and is not automatically forwarded into Hermes.

`model.default` in `/opt/data/config.yaml` selects the model; the old `LLM_MODEL`
environment variable is not supported. Hermes expands `${VAR}` strings in config,
but an operator must ensure required variables exist. The persistent Hermes
`.env` overrides inherited process environment values, so do not maintain two
conflicting copies of the same API key.

Restart the agent after changing startup configuration:

```sh
docker compose restart hermes
```

Use Compose rebuild/recreate for upgrades, not an in-container `hermes update`.
The image installs immutable source at `/opt/hermes` and an immutable virtualenv
at `/opt/venv`; writable state stays under the mounted directories.

## Verification without paid calls

Read-only MCP initialization and tool discovery against the running bundle:

```sh
docker compose exec hermes python /opt/hermes-bundle/verify.py --mcp
```

This checks the pinned revision, native imports, linked SQLite/FTS5, MCP
connectivity and tool exclusions. It lists tools but does not navigate a page,
execute browser tools, or call a model. Import checks can initialize ordinary
Hermes runtime files in its own home.

Development checks use a separate image and disposable, identity-checked
containers, volumes and an internal-only Docker network:

```sh
python3 -m unittest discover -s hermes -p 'test_*.py' -v
docker build --platform linux/arm64 -t browserpane-hermes-agent:bundle-test ./hermes
python3 hermes/check-container.py --image browserpane-hermes-agent:bundle-test
```

The integration fixture has no browser, secrets, published port, WAN access or
model. It tests real Hermes startup, MCP registration/filtering, and persistence
across restart and recreation. Real BrowserPane session/rendering checks are
separate. Building ARM64 on another ARM64 machine is not Raspberry Pi hardware
qualification.

## Pins and attribution

- Hermes: [`ee5b5ec21e576ccf9b941f9ff71330418415a5cb`](https://github.com/NousResearch/hermes-agent/tree/ee5b5ec21e576ccf9b941f9ff71330418415a5cb), version `0.21.0`.
- Python dependency graph: that source revision's `uv.lock`, installed frozen
  with only the `mcp` extra. The MCP SDK is `2.0.0`.
- Debian `13.4` and uv `0.11.6` source images are digest-pinned in
  [the Dockerfile](../hermes/Dockerfile). Debian security package indexes are
  intentionally resolved at build time, so this is not a bit-reproducible image.
- SQLite `3.53.4` source is SHA-256 checked. The runtime must actually link SQLite
  at least `3.51.3` and pass an FTS5/trigram query, matching upstream's WAL safety
  requirement; copying the library without setting loader precedence is not enough.

Hermes is by Nous Research under its original MIT license, retained in the image
at `/opt/hermes/LICENSE`. This integration does not change BrowserPane's license
or imply endorsement. The lean packaging preserves a source checkout rather than
using the unsupported Hermes wheel/sdist distribution path.
