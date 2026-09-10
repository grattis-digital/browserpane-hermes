# Renderer OOM recovery

The wrapper now reads its own cgroup-v2 `memory.events` counter before browser
startup and supervises a five-second watcher. An observed change in `oom_kill`
terminates the watcher, which triggers the existing graceful session shutdown
and lets Docker's restart policy recover the container. Counters are baselined
per wrapper lifetime; old history alone does not trigger another restart.
Three consecutive malformed/unavailable reads also request recovery. On systems
without readable cgroup-v2 events, an explicit message records that the watcher
is unavailable. No privileged cgroup writes or host watchdog daemon is added.

This addresses a failure class in which the kernel kills a Chromium child while
the main browser, MCP health endpoint and container remain alive. It is not
general renderer-crash detection, automatic workflow retry, or proof that the
application cannot exhaust its memory allocation. A single complex page can
exhaust memory even with sequential MCP calls. See the separate
[whole-job admission plan](MCP_WORKLOAD_ADMISSION_PLAN.md).

## Qualification

- Five deterministic shell/unit tests cover initial history, new OOM kills,
  bounded read failures and recovery, malformed/reset counters, and supervision
  before browser startup. Fake sleeps keep normal tests finite and fast.
- All 57 focused lifecycle/GPU/compact-queue/default-tab tests pass. These do not
  qualify full Chromium source compilation or GPU damage performance.
- The full local repository Node suite also passes: 307 tests, no skips or
  failures. Hosted CI has not run for this unpushed checkpoint.
- A network-free Linux ARM64 container, limited to 384 MiB, deliberately exhausts
  its own memory with a disposable Node child. The main process survives the
  kill, the watcher requests recovery and Docker restarts it exactly once.
  This passed locally and on the Raspberry Pi; the latter's pre-existing service
  inventory was unchanged and the test container was removed.
- A separate local ARM64 full-browser test seeds two synthetic tabs, a cookie,
  local storage, a shared file and a genuine MCP download. With a one-GiB test
  limit, a disposable child then triggers cgroup OOM. The actual wrapper and
  Chromium recover through exactly one automatic container restart. All seeded
  state and the exact two-tab count pass verification afterward. This is local
  CPU/X11 evidence, not a Pi GPU/profile-loss guarantee.

The test resources never use an existing profile. Unsaved forms, active downloads
and the killed renderer's in-memory state are not recoverable promises. Recovery
does not replay an MCP request; clients must reconnect and observe fresh state.
Repeated memory-heavy workloads can still cause repeated restarts.

The explicit, finite local fault-injection check is:

```sh
node scripts/check-oom-recovery.mjs --induce-oom YOUR_LOCAL_BROWSER_IMAGE
```

Use a Linux Docker engine with cgroup v2 and sufficient host headroom. This creates
its own internal network, synthetic fixture and profile/shared volumes, validates
their identities, constrains only its new browser to one GiB with no swap, and
removes those test resources afterward. It accepts no existing container/profile
target and is deliberately absent from normal tests and CI. It biases a synthetic
child for OOM selection; it does not guarantee the kernel's victim selection.
Run it separately from performance measurements. No real research is replayed.

Retained qualification failures:

- The first Pi fixture could not read a user-owned private directory after all
  capabilities were dropped. A separate reproduction confirmed permission
  denial. Binding its individual synthetic code files fixed the fixture without
  broadening permissions on the live browser or host.
- The first overlay image spelled its user as `bpane`; the safety oracle requires
  the original exact `10000:10000` configuration. Packaging was corrected rather
  than weakening the oracle.
- An early full-browser fixture attempted download verification without first
  running the download seeding step. The final fixture verifies the complete
  baseline before inducing OOM and verifies it again afterward.

The source archive in the narrow maintenance image includes the modified startup
script and new watcher. Existing image configuration, profile/shared/display
mounts, GPU flags and sandbox settings are preserved. Deployment-specific image
identities, addresses and raw logs remain private. No GitHub publication is part
of this local checkpoint.
