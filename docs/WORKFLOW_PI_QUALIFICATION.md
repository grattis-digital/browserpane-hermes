# Raspberry Pi workflow qualification

Short checkpoint IDs below identify locally retained qualification records. The
public workflow series is squashed; those IDs are not separately published commits.
Preserving them distinguishes historical test images from the later pacing feature.

## Verdict: isolated workflow gate passed; no production rollout

The investigation reproduced and explained the export-action error:
a successful click/download exceeded the three-second post-input completion
deadline. An untraced Hermes run stopped during pair 24 after 48 verified exports;
a separate protocol-traced diagnostic reproduced it on export 31. The local fix
uses the existing navigation budget for clicks and deducts awaited guard time.
See [failure evidence and regression](WORKFLOW_CLICK_COMPLETION.md). The repaired
image passed fresh Pi smoke/recovery and then all 30 cold/warm pairs **and recovery**
in a new invocation. One coded GPU-readiness CDP query timeout was retained during
the soak; later readiness checks passed. This is a qualified workflow result with
a diagnostic caveat, not a claim to eliminate Chromium stalls. Production rollout,
GitHub push and merge still require separate approval. Historical failures below
are preserved, not retrospectively relabeled successful.

This is an **unpaced** baseline. The later opt-in [pacing implementation](WORKFLOW_PACING.md)
has separate local tests; this report does not qualify it on Raspberry Pi hardware.

The earlier explicitly authorized **isolated** follow-up on 2026-09-07 passed its
smoke/recovery test, but the subsequent 30-pair run **failed during pair 13**, after
25 verified exports. The earlier attempt failed during pair 24; neither is a
successful 30-pair benchmark or a production rollout. Existing
browser/profile, Hermes, DNS, ingress and operator firewall policy were preserved;
the disposable containers, profiles, volumes and network were removed.
Nothing was pushed to GitHub. Each attempt and its limitations are recorded below.

The reusable [pilot harness](../scripts/workflow-pilot/README.md) records private
per-attempt evidence, validates exact resource ownership and bounds the workload.
Raw operator reports are deliberately excluded from Git and public artifacts.

## Repaired-image benchmark, 2026-09-07

The new invocation uses browser checkpoint `bb9d6d2e` and unchanged Hermes
checkpoint `538e4c55`, with Chromium 152.0.7977.75/V3D/X11. It completed an initial
export and all 30 alternating cold/warm pairs: **61 independently verified
exports in one uninterrupted browser/profile session**. A subsequent health CSV
and the cancellation/reconciliation checks also passed. This is separate from
the fresh repaired-image smoke/recovery invocation, which passed in full.

| Metric | Cold CLI | Warm Hermes tool |
| --- | ---: | ---: |
| Median wall time | 19,233.2 ms | 4,095.0 ms |
| p95 wall time, nearest rank | 21,623.2 ms | 7,575.1 ms |
| Median MCP-only time | 4,805.0 ms | 3,520.3 ms |
| Median Hermes-container CPU time during execution | 12,860.3 ms | 512.8 ms |
| Median SDK result JSON bytes | 2,615 | 2,615 |
| MCP calls per successful export | 5 | 5 |
| Median / p95 additional status polls | 0 / 0 | 0 / 1 |

These are all 30 completed pairs, not selected successes from a failed attempt.
The median warm wall time is about 4.7 times shorter in this loaded-host comparison;
the benefit is amortized process/SDK startup, **not** a rendering speedup from the
click-timeout fix. JSON bytes are not model tokens. Intentional site pacing and
raw CDP protocol tracing were absent; there were no model calls or input retries.
Twenty of thirty warm runs returned without another status poll; ten needed one.
Initial warm startup took 18.8 seconds and two polls. These timings exclude model
selection, reasoning, real-site network latency and human decisions.

The same long invocation then passed Hermes restart, browser restart and full
browser/Hermes recreation on its owned volumes. Exact CSV files/contents, cookie
and local storage, one tab, catalog/cancel state and V3D/sandbox readiness survived.
An interrupted export remained uncertain after its browser download metadata was
lost; a surviving file did not authorize replay or imply verified success.
Both the smoke and long invocation confirmed existing services unchanged and
removed their owned containers, volumes and networks. Private reports were retained.

During benchmark/safety sampling, 1,237 observations over 1,250.5 seconds recorded
at least **2,580.9 MiB** available host memory and at most **58.9°C**. Browser/Hermes
sampled cgroup peaks were **459.1/304.7 MiB**; no owned OOM kills or CPU-quota
throttling were observed. Recovery has separate readiness/persistence checks, not
continuous resource sampling. The separate repaired smoke sampled at least
3,048.3 MiB available RAM, at most 57.9°C, and no GPU warnings or owned OOM/throttling.

**Diagnostic caveat:** the long-run browser recorded one
`GPU_CDP_QUERY_TIMEOUT`, identifying expiry of the readiness probe's 2.5-second CDP
query deadline. Session and post-recovery V3D/sandbox checks passed. This warning is
not evidence by itself of lost GPU rendering, nor proof that a transient stall is
harmless. Its deeper Chromium/host cause is unproven; no probe timeout was enlarged
or warning suppressed. No workflow storage errors were retained. Expected
cancellation and lost-download-metadata outcomes remain in the safety evidence.

Local validation for the fix passed **264 Node tests, 100 Hermes tests and 13 pilot
tests**, the real MCP/slow-click regression, 14-case replay and warm cancellation
fixtures, plus the ARM64 application/GPU image build. No new hosted CI result is
claimed because the branch was not pushed. Real-site/challenge handling, production
bridge transport, full-host reboot, viewer/video and longer endurance are outside
this gate.

## Prior follow-up: smoke passed, long run stopped

The revised Pi images used browser checkpoint `50d7bf21` and Hermes checkpoint
`6d76e3aa`, with the same Chromium 152.0.7977.75/V3D/X11 setup. The fresh smoke
invocation passed export, duplicate-run, cancellation, read-only reconciliation,
restart and full browser/agent recreation. Exact filenames **and CSV contents**,
cookie/local storage, one tab, catalog/cancel state and GPU sandbox survived.
The expected lost-download-metadata case stayed uncertain. No GPU warnings or
workflow storage errors appeared in its retained diagnostics.

A separate fresh long-run invocation verified the initial export plus 12 complete
cold/warm pairs. During pair 13, the cold export-action call returned
`MCP_ACTION_FAILED` after four MCP calls. The journal correctly retained
`uncertain`; the input was not replayed. The adapter discarded the underlying
MCP reason before the newer diagnostic change described below, so the precise
browser-side cause and whether input was applied are **not established**.
This invocation did not reach the later health-report/recovery phases.

**Provisional completed-pair results only** (12 pairs; failed attempt excluded):

| Metric | Cold CLI | Warm Hermes tool |
| --- | ---: | ---: |
| Median wall time | 17,780.8 ms | 3,774.9 ms |
| p95 wall time, nearest rank | 19,753.6 ms | 6,409.4 ms |
| Median MCP-only time | 3,862.7 ms | 2,981.1 ms |
| Median SDK result JSON bytes | 2,615 | 2,615 |
| MCP calls per successful export | 5 | 5 |
| Median / p95 additional status polls | 0 / 0 | 0 / 1 |

**11 of 12** completed warm runs returned without another status poll; the other
needed one. Initial warm startup was 19.2 seconds with two polls. This demonstrates
reduced polling in this attempt, not a measured model bill or unconditional agent
speedup. The host was loaded differently from the earlier attempt: do not use the
tables as a controlled before/after rendering or absolute-latency comparison.

The run sampled at least **3,167 MiB** available host RAM and at most **58.4°C**.
Browser/Hermes cgroup peaks were **441/290 MiB**, with no owned OOM kills or CPU-quota
throttling. All services were healthy in the failure snapshot, V3D/sandbox readiness
passed, and no GPU warning or journal error was retained. This is evidence against
those observed failure modes, not proof of the browser-action cause.

The subsequent diagnostic follow-up preserves allowlisted MCP
reason codes and bounded action-progress fields without raw messages/page data.
It records cold CLI failure lines and attempts an independent read-only fixture/
artifact snapshot before disposal. Real-browser tests distinguish changed/missing/
ambiguous targets without permitting replay. Those diagnostics enabled the next
Pi reproduction described above. At that earlier checkpoint local checks passed
100 Hermes tests, 11 pilot tests, 261 Node tests, real MCP, the 14-case replay matrix
and warm-cancellation checks.

**Gate at that checkpoint:** reproduce the export-action failure with these diagnostics, determine
the actual cause, and repeat fresh smoke plus a complete uninterrupted 30-pair/
recovery run. Do not weaken page guards, retry uncertain input, or promote the
branch merely because the journal regression tests and smoke are green.

## Follow-up implementation and new startup finding

Local checkpoint `50d7bf21` makes journal status truly read-only, removes raw
open/close operations on a live SQLite database inode, serializes short in-process
database lifetimes, and classifies contention/storage failures. A reserved writer
now permits a committed status read; an exclusive writer returns `JOURNAL_BUSY`.
Cross-process lock tests and a failed durable-intent test preserve the no-replay
boundary. This fixes reproduced weaknesses, not a retrospective proof of the
original pair-24 exception, whose raw evidence was unavailable.

Run/status calls now wait up to five seconds for existing work, with a one-second
polling hint if still active. Waiting holds no admission lock. No additional
model, browser action, automatic retry or journal durability downgrade is added.
GPU failures have content-free reason codes; the harness retains bounded workflow,
GPU, journal and health-check evidence before cleanup. The unused gateway MCP
alias is disabled in the disposable test home only.

The first follow-up smoke attempt stopped **before exports** because the running
Hermes gateway's health probe repeatedly exceeded its existing five-second
deadline. One direct Pi measurement took 4.63 seconds importing `gateway.status`
through the eager messaging package, and 4.93 seconds including the state/PID
check. Checkpoint `6d76e3aa` loads the unmodified pinned status helper directly,
retaining upstream PID/lock/profile validation and the same deadline. A separate
Pi import-only probe took 0.62 seconds; these are diagnostic observations under
uncontrolled load, not a matched end-to-end benchmark. The failed startup's report
was retained and its owned resources removed; existing services were unchanged.
The subsequent smoke passed, but its long-run result blocked promotion at that checkpoint.

## Method and scope

- Raspberry Pi 4, 8 GB RAM, ARM64; newly built Chromium **152.0.7977.75**, strict
  sandbox, qualified V3D/X11 image and existing qualified display image.
- Actual pinned Hermes **tool dispatch**, Python 3.13, MCP SDK 2.0.0 and SQLite
  3.53.4. No model decisions, credentials or paid model calls.
- A new browser/profile/tab for each invocation, then one uninterrupted session
  throughout that invocation's benchmark. Cold CLI and warm Hermes executions use
  the same contract, SDK/verifier and five MCP calls. Input/CSV/request oracles
  are independent of the runner's own success flag.
- Both arms use loopback HTTP within an owned shared network namespace, on an
  internal Docker network with no published ports. Standard bridge traffic was
  blocked by operator policy; that policy was not relaxed. Production bridge
  networking, WAN/site latency, the viewer and a full-host reboot are not covered.
- Existing services remained running. Test CPU shares were 128 without a hard
  quota; memory caps and one-second cgroup/host sampling are documented in the
  harness guide. This is a loaded-host comparison, not exclusive hardware access.

## Earlier attempt (`38cc5629`): completed-pair timing, not qualification

The failed run independently verified **47 exports**: the initial warm export
and 23 completed cold/warm pairs. The next warm attempt returned a generic
`WORKFLOW_ERROR` while polling and the harness stopped. Its browser-side outcome
was not established and it was not blindly replayed.

The following table includes **only those 23 completed pairs**. It excludes the
failed attempt, so it cannot serve as an unconditional latency/reliability claim:

| Metric | Cold CLI | Warm Hermes tool |
| --- | ---: | ---: |
| Median wall time | 8,848.9 ms | 2,778.4 ms |
| p95 wall time, nearest rank | 9,962.5 ms | 3,876.0 ms |
| Median MCP-only time | 1,196.7 ms | 1,581.6 ms |
| Median Hermes-container CPU time during execution | 7,202.6 ms | 1,003.9 ms |
| Median SDK result JSON bytes | 2,615 | 2,617 |
| MCP calls per successful export | 5 | 5 |
| Median additional status polls | 0 | 5 |

Among successful pairs the median warm wall time was about **3.2× shorter**.
The benefit is amortized Python/SDK/process startup, not faster browser rendering
or smaller browser replies. The initial warm call still took **10.4 seconds**.
Per-container CPU counters include background work during each timing window;
they are not isolated function CPU profiles. JSON bytes are not model tokens.

The harness polls mechanically through real Hermes dispatch, without an LLM.
An actual model driving those five median polls could incur extra inference
latency and tokens. The Pi results therefore motivate a bounded longer initial
wait or host-managed completion handling; they do not demonstrate an end-to-end
agent token bill or universal agent speedup.

During the failed run the minimum sampled available host memory was **2,852 MiB**
and maximum temperature **54.0°C**. Test browser/Hermes sampled cgroup peaks were
**449/342 MiB**. No owned OOM kills or cgroup CPU-quota throttling were observed.
This does not rule out transient I/O contention, GPU faults or power problems.

## What passed in the earlier separate smoke invocation

The short invocation completed an initial warm export, one cold/warm pair, and a
reviewed CSV containing a live read-only snapshot of Pi RAM, temperature and CPU
frequency. It also passed:

- Exact CSV contents/hash, one trusted click/export request, and duplicate-run
  non-replay; one browser tab throughout.
- Cancellation after dispatch, followed by explicit read-only reconciliation;
  cancellation before dispatch; uncertain execution never blindly replayed.
- Test Hermes restart, browser restart, then browser and Hermes recreation on
  the same owned volumes. Cookie/local-storage values, download-file presence,
  catalog and cancelled/pending execution state persisted.
- V3D and sandbox readiness before/after recovery. A pending export whose browser
  download metadata was lost remained uncertain rather than becoming successful
  merely because a file existed.

These recovery checks belong to the separate smoke session. The failed long
invocation did **not** reach its health-report or recovery phases.

## Earlier findings that motivated this follow-up

These observations describe the original `38cc5629` attempt, before the fixes
above. Its exact generic-error/GPU-warning causes cannot be reconstructed from
the incomplete historical evidence.

1. **Reproducible journal contention weakness.** `RunJournal.read()` uses the same
   database path as writes: it sets `user_version`, creates/checks schema and
   requests `BEGIN IMMEDIATE` on every status read. A writer held past the 250 ms
   SQLite busy timeout produces `SQLITE_BUSY`; the controller hides it as the
   same generic `WORKFLOW_ERROR`. This was reproduced inside the exact pinned
   Hermes image with a fresh synthetic journal. It is a strong candidate for the
   Pi failure, **not proof of that attempt's original exception**, which the
   current diagnostics did not retain.
2. **An unresolved GPU-readiness warning.** The failed invocation logged one
   generic readiness-check failure. That check covers both a 2.5-second CDP
   timeout and invalid GPU/sandbox/crash state; the message cannot distinguish
   them. No matching kernel GPU/OOM messages were found in the checked interval.
   Do not label this either confirmed GPU loss or a harmless timeout.
3. **Improve diagnosis before another soak.** Preserve bounded, private failure
   evidence (typed storage errors, run state and readiness failure reason) before
   disposable cleanup. Remove the unused test gateway's default MCP discovery
   retries: the workflow helper used the correct loopback endpoint, but the
   separate gateway emitted DNS failures for its unused default alias.
4. **Then fix and requalify.** Separate truly read-only journal access from schema
   initialization/writes, retain FULL-synchronous intent checkpoints and the
   no-replay boundary, test read/write/cancel contention and stable busy errors,
   and address model-facing polling overhead. Rerun the smoke and complete
   30-pair/recovery qualification without resetting the browser/profile mid-run.

At that historical checkpoint, the local harness and ownership/oracle checks were version-controlled;
86 Python tests (78 existing plus eight harness tests), 257 Node tests and workflow
syntax validation passed. Green unit checks do not override the failed hardware
gate. No production promotion, push or merge occurred at that checkpoint or in
the follow-up described above.
