# Contributing

Keep this a one-browser bundle. Read [AGENTS.md](AGENTS.md), the relevant language
standards, and [the current scope](docs/CURRENT_CONTEXT.md). Do not restore the
upstream control plane or copy operator profiles, credentials, private addresses,
deployment logs or screenshots into contributions.

## Local correctness checks

Development uses Node 22, npm, Git, Docker and Docker Compose. Users building the
bundle only need Git and Docker Compose: Docker prepares the pinned source.

```sh
npm ci
npm audit --omit=dev --audit-level=high
sh scripts/fetch-upstream.sh
node scripts/audit-upstream.mjs
npm test
npm run test:client
npm run build
docker compose --env-file .env.example config --quiet
python3 -m unittest discover -s hermes -p 'test_*.py' -v
npm run test:linux
```

The generated `upstream/` must not already contain unrelated edits. The fetch
refuses to overwrite it. The pristine audit can read an existing local Git object
store with `BPANE_UPSTREAM_REPO=/absolute/path/to/checkout`; it never changes that
checkout. See [BACKPORTING.md](docs/BACKPORTING.md) for new ordered patches.

`test:linux` builds a small native Linux toolchain container. Only source (read
only) and build-cache volumes are mounted. Dependency fetching has network access;
the actual Rust tests run with networking disabled. Seven explicitly registered,
ignored X11/MIT-SHM regressions run serially on a private Xvfb. A missing test is
an error, not a successful zero-test filter. Cache volumes named
`browserpane-pipeline-cargo` and `browserpane-pipeline-target` are retained for
subsequent builds; no user/production X11 socket or profile is used.

## Real rendering and persistent-runtime checks

```sh
npx playwright install --with-deps chromium
export BPANE_TEST_BROWSER_PATH="$(node --input-type=module -e "import {chromium} from 'playwright';process.stdout.write(chromium.executablePath())")"
npm run test:webgl
docker build --tag browserpane-hermes:test .
npm run test:runtime
node scripts/test-viewer.mjs browserpane-hermes:test
docker build --tag browserpane-hermes-agent:test ./hermes
python3 hermes/check-container.py --image browserpane-hermes-agent:test
node scripts/test-compose.mjs browserpane-hermes:test browserpane-hermes-agent:test
```

`test:webgl` starts its own browser/profile and checks real WebGL pixels, texture
reuse and context loss. It also exercises the auto-renderer fallback with real
canvas contexts: synthetic software metadata and initialization failures must
produce exact Canvas2D Fill/QOI/Zstd/cache/scroll pixels; complete context failure
must leave no mounted surface. It is not a GPU speed benchmark. An existing Chrome can
instead be selected with `BPANE_TEST_BROWSER_CHANNEL=chrome`; it still launches
a fresh isolated browser, never attaches to your active profile.

`test:runtime` creates UUID-labelled containers, an internal fixture network and
two fresh named volumes. It checks health and internal listener policy, shared
viewer bootstrap, actual MCP downloads/console isolation, and restored
tab/cookie/localStorage/shared files after disconnect, restart and container
recreation. It does not accept an existing container or profile path. Helpers
`verify-profile.mjs` and `verify-mcp-downloads.mjs` are launcher internals, not
commands for diagnosing a live deployment. Cleanup verifies exact IDs and labels
before removing only these test resources. Interrupted/killed jobs may leave
labelled test resources; inspect them before deliberate cleanup, never run a
global Docker prune against a developer's machine.

`test-viewer.mjs` owns a separate tmpfs-only container and fixed loopback ports
18090/TCP and 24433/UDP. It refuses an existing `browserpane-pipeline-viewer`
container. It checks complete settled RGBA against direct X11 capture, including
scroll reversals, cache loss, decode faults and actual display geometry. Retained
copy coverage requires nonempty GPU blits for WebGL or nonempty main-canvas
Canvas2D copies for the auto-selected backend; the separate WebGL gate remains.
The display check covers local density, fixed sizes, ownership, odd geometry and
keyboard input. Reports/screenshots contain synthetic fixtures and go into ignored
`test-results/`. Neither script may target a production browser or shared profile.

Scroll setup requires one genuine viewer click witnessed by the owned page, with
content focus and no scroll displacement. Each wheel sequence then waits for its
matching host Ping/Pong acknowledgement before the existing settled-pixel checks.
Capture runs separately from input: a correct first frame does not mean startup
resize work has drained from the host input queue. These bounded readiness checks
do not replay gestures, force page scrolling, or replace the movement/pixel
assertions. Their recorded wait times are diagnostics, not a latency benchmark.
Both scroll and display child oracles run even if one fails; any failure still
fails the overall job and retains its original cause.

The Hermes integration uses a labelled no-WAN fixture network, real gateway and
deterministic fake MCP service. It verifies discovery/tool exclusions and
persistence without provider keys or paid model calls. MCP exclusions are a
usability guard, not a security boundary.

`test-compose.mjs` separately checks the actual three-service Compose bundle with
unique project/token-labelled resources and dynamic loopback ports. It trusts the
disposable Caddy root only inside its Node TLS request, not in your host/browser
trust store; it checks protected routes, bootstrap, private listeners and real
Hermes discovery against the colocated browser MCP. Cleanup checks ownership.

## CI and publication

The bundle workflow checks pristine patch replay, wrapper/client correctness,
Compose configuration, real WebGL pixels and Hermes configuration. Native
`ubuntu-24.04` and `ubuntu-24.04-arm` jobs run Linux/X11 tests, build both runtime
images and run browser/MCP/profile and Hermes integrations. The amd64 job also
runs the full local viewer oracles. ARM64 hosted CI does not prove Pi thermal or
GPU behavior; the [evidence guide](docs/OPTIMIZATIONS.md) separates those claims.

A weekly scheduled run rebuilds and checks the pinned source with the current
distribution packages/base tags; schedules never publish. The production npm
dependency audit rejects high/critical reported issues, but is not a comprehensive
supply-chain audit. Hermes dependencies remain pinned by the upstream source/lock;
Dependabot here watches wrapper npm, actions and Docker definitions.

Pull requests use no registry login, paid API, deployment host or enterprise
secret. There is no `pull_request_target` or privileged execution of artifacts
from another workflow. Actions are commit-pinned; Dependabot proposes updates.

Only trusted pushes to this fork's `main` or validated `vMAJOR.MINOR.PATCH` tags
publish to `ghcr.io/grattis-digital/browserpane-hermes` and
`ghcr.io/grattis-digital/browserpane-hermes-agent`. Each passing architecture job
can publish a run-scoped tested staging tag. Rerunning a failed architecture job
can replace only that run/source/architecture staging tag after its checks pass.
Public `main`/version and source-SHA
multi-architecture manifests are created only if **both** jobs pass. A partial
failure can leave staging tags but cannot update those public manifests. No
images are published into the upstream project's namespace and no deployment is
performed by CI. A new fork must deliberately change that repository guard and
namespace before enabling its own publication.

Keep correctness regressions with fixes. Record benchmark hardware, exact source,
fixture and measurement boundary separately; do not encode historical Pi timings
as flaky pass/fail thresholds.
