# Explicitly authorized Raspberry Pi workflow pilot

Pilot contracts and cold CLI calls explicitly disable site pacing; result oracles
require `policyWaitMs == 0`. Do not inject real-site policies into these timings.
Use the separate [dedicated pacing fixtures](../../docs/WORKFLOW_PACING.md#tests-and-remaining-work)
for virtual-time or zero-delay policy checks.

This is a disposable **hardware qualification harness**, not a deployment script
for an existing installation. It runs the current ARM64 browser/GPU image and
pinned Hermes image, with real Hermes tool dispatch and MCP, without model calls,
credentials, production profiles, published ports or a Docker socket in Hermes.
Only an operator may run it after explicitly authorizing the extra Pi workload.
It does not enable a plugin in an existing agent or change GitHub.

The latest [recorded Pi qualification](../../docs/WORKFLOW_PI_QUALIFICATION.md)
passed fresh repaired-image smoke/recovery and a separate full 30-pair/recovery
run. Earlier failures and one coded GPU-readiness query timeout in the successful
soak remain documented. This is an isolated workflow gate, not production rollout
authority or proof of general real-site/endurance behavior.

## Preconditions and staging

- Linux ARM64 Pi, cgroup v2, Docker, Python 3, Bash, existing qualified V3D/X11
  devices and enough free memory/disk for a second, temporary browser bundle.
- Build the browser from the reviewed local commit, its `Dockerfile.gpu`
  derivative, and the pinned `hermes/` image. Load those exact images on the
  target. Supply a separately qualified ARM64 display-sidecar image. No registry
  push is required. A new browser build can resolve a newer Chromium package;
  the report records its actual version, not merely the source commit.
- Create a private, operator-owned directory using
  `mktemp -d /tmp/bph-workflow-pilot.XXXXXXXX`. Keep that parent mode `0700`.
  Stage the eleven runtime helpers from this directory into its `code/` child:
  `run.py`, `owned.py`, `metrics.py`, `driver.py`, `agent.py`, `trials.py`,
  `fixture.mjs`, `probe.mjs`, `diagnostics.py`, `inspect-agent.py`, `seed.py`.
  The child must be `0755`, files `0644`, so the
  unprivileged test containers can read the read-only bind mount.
- Also stage `scripts/runtime-test/cdp.mjs`, `scripts/gpu-devices.sh`,
  `runtime/chromium-seccomp.json` and `runtime/host-runtime.env` into `code/`,
  retaining their basenames. Do not copy `.env`, credentials or live data.

On the target, replace the staging path and three image references explicitly:

```sh
sudo -n python3 -u /tmp/bph-workflow-pilot.EXAMPLE/code/run.py \
  --browser reviewed-browser-gpu:local \
  --hermes reviewed-hermes:local \
  --display qualified-gpu-display:local \
  --samples 1
```

Run a smoke pass first. After it passes, repeat with `--samples 30`. Each invocation
creates a new UUID and fresh profile; never combine different invocations into a
single uninterrupted-session claim. Python assertions enforce ownership and
test oracles: do **not** use `python -O` or `PYTHONOPTIMIZE` with this harness.

## Isolation and resource ownership

Every test container, volume and network carries a unique
`io.browserpane.workflow-pilot` label. Exact IDs, labels, image IDs, architecture,
non-privileged mode and absent port publication are checked. No existing volumes
or containers are accepted as workload targets. The host runner needs Docker
authority; this is a trusted operator test, not a hostile-code security boundary.

The fixture owns an internal Docker network namespace; only the disposable
browser and Hermes join it. Their HTTP traffic uses loopback. This accommodates
hosts that deliberately block new bridge-to-bridge traffic **without changing
operator firewall policy**. Docker still manages rules for its owned network.
This does not qualify production bridge ACLs, DNS, WAN, ingress,
viewer latency or cross-container network isolation. The display sidecar has no
network and a separate owned X11 volume/IPC namespace. Host networking is unused.
The private test Hermes home is seeded without the unused gateway MCP alias;
the actual helper supplies its own fixed loopback endpoint. No live config is read.

Memory caps are browser 1536 MiB, Hermes 768 MiB, display 256 MiB and fixture
128 MiB. CPU shares are 128, with no hard CPU quota. The existing services remain
running, so host CPU contention is not controlled. One-second cgroup/host samples
check for owned OOM kills, less than 768 MiB available host RAM, or temperature at
least 78°C. Checks stop further trials on pressure; they are not a hardware
watchdog. Resource sampling ends before deliberate container recovery changes
cgroup identity. Reported memory is sampled cgroup usage, not process RSS.

## What is measured and verified

One existing browser/tab/profile handles an initial warm export, 30 alternating
cold CLI/warm pairs, and one report containing a read-only snapshot of host RAM,
temperature and CPU frequency. Both arms use the same reviewed contract, Python
SDK/verifier and five MCP calls. Timers exclude approval, registration, SSH and
initial Docker-exec/helper startup in both arms. Cold subprocess/SDK startup is
included; warm timings include actual Hermes dispatch and necessary status polls.
The five-second bounded tool wait usually absorbs short executions; any additional
status calls use the same bounded wait and the returned one-second polling hint.
Initial warm startup is reported separately. No claimed model-token bill or
general autonomous-agent speedup follows from these deterministic timings.

The fixture auto-acknowledges **only** its own fixed, bounded test contract. It
cannot accept an arbitrary URL, recipe or credential. This must never become
an automatic approval path for user workflows. Live Pi values are a small useful
report input, not an integration with an arbitrary authenticated report portal.

Every timed export independently checks exact CSV rows and hash, one trusted
click, one HTTP export and one new file, plus duplicate-run non-replay. Subsequent
checks cover cancellation after dispatch, read-only reconciliation, cancellation
before dispatch, agent restart, browser restart, and browser/agent recreation.
Cookie, local storage, exact download filenames/contents, catalog/cancel state and one tab must
survive. GPU/sandbox readiness is checked before and after recovery. A pending
export with lost browser download metadata must remain uncertain, not replay or
become verified solely because a file exists. No full-host reboot is attempted.

## Evidence and cleanup

Private `ownership-UUID.json` and `report-UUID.json` files remain in the staging
parent. Keep raw reports private: they may include operator hardware details,
image IDs and isolated-container failure logs. Only sanitized aggregate evidence
belongs in Git. Reports are created without overwriting earlier attempts.
Before cleanup, the harness captures bounded container log tails, classified GPU
warnings, a fresh readiness check, and read-only journal states/error codes. The
last three Docker health-check outcomes/durations are retained as well. The
helper records only content-free workflow diagnostics in a private rotating log.
Cold CLI failures are retained as well. After an export failure, a bounded,
read-only fixture/CSV snapshot is attempted before disposal; it never retries input.
Content-free MCP phase timings are enabled in these disposable browser containers.
The failure snapshot also includes fixture focus and viewport state.
Capture failures are recorded, not allowed to prevent cleanup. Session and
post-recovery readiness remain mandatory; diagnostics do not relax either gate.

The runner removes only its owned containers, volumes and network, then checks
pre-existing running-container IDs, images, start times and restart counts are
unchanged. Test profiles/downloads are intentionally discarded; imported images
and private staging/reports remain. SIGTERM invokes cleanup; host loss/SIGKILL
cannot guarantee it. For interrupted runs, inspect the exact manifest UUID and
each exact resource ID/label before removing anything. Never use broad prune,
name-glob or production-volume cleanup commands.

### Browser-only diagnostic repetition

For an explicitly authorized investigation, also stage `stress.py` and
`stress.mjs`. Invoke `stress.py` with the same three image arguments and
`--exports 100` (maximum 100). It creates its own fresh labelled resources and
repeats the fixed fixture's guarded MCP export without Python SDK startup between
exports. Exact CSV contents, one trusted click/request and one tab are checked;
the first failure ends the attempt without another export. This is **not** a
Hermes timing benchmark, approval path or restart qualification.

Optional `--protocol-trace` enables raw Playwright CDP logging **only in that
disposable fixture browser**. It changes timings; never enable it on an operator
profile or use its results as performance qualification. Rotating Docker logs
remain bounded; the report retains the original bounded MCP failure reply and
the usual pre-cleanup diagnostics. Private `stress-UUID.json` reports are not
public/CI artifacts. A failed attempt exits nonzero.

Fast checks (no Pi or Docker required):

```sh
python3 -m unittest discover -s scripts/workflow-pilot -p 'test_*.py'
node --test test/workflow-pilot-fixture.test.mjs
```

The separate `probe-journal.py` characterizes the status-read contention found
during qualification. It creates only a fresh temporary synthetic journal. Run it
inside the pinned Hermes image, never against operator data:

```sh
docker run --rm --network none --read-only \
  --label io.browserpane.workflow-diagnostic=journal-contention \
  --tmpfs /tmp:size=8m,mode=1777 --cap-drop ALL \
  --security-opt no-new-privileges:true --entrypoint python \
  -i browserpane-hermes-agent:workflow-warm - \
  < scripts/workflow-pilot/probe-journal.py
```

Its JSON shows the actual SQL executed by a status read, the exception from a
contending writer and the controller response. This is diagnostic evidence, not
an assertion that `WORKFLOW_ERROR` is the desired behavior or proof of the original
hardware attempt's exception. Keep FULL-synchronous intent durability when fixing it.
