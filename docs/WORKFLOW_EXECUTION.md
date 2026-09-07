# Reviewed workflows inside Hermes

The optional `browserpane-replay` plugin exposes one **Hermes-local** `workflow`
tool for the [supervised report-export pilot](WORKFLOW_REPLAY.md). It discovers
operator-registered executions, runs one, reports progress, requests cancellation,
and reconciles interrupted exports. BrowserPane still exposes exactly six MCP
tools. This adds no service, listener, separate browser, or inference backend.

This is a narrow execution interface, **not full P3 enterprise enforcement**:
no protected approvals, browser reservation/takeover, automatic repair, recurring
grants, arbitrary workflow language, or independent workflow MCP server.

## Enable deliberately

After a separately authorized image update, merge these entries into the existing
`/opt/data/config.yaml`; retain other deliberately enabled plugins and toolsets:

```yaml
plugins:
  enabled: [browserpane-replay]
  entries:
    browserpane-replay:
      settings:
        downloads: /shared/downloads
        wait_seconds: 5 # Optional bounded run/status wait, 0–10 seconds
platform_toolsets:
  cli: [terminal, file, skills, todo, memory, browserpane, workflow_execution]
```

Restart the relevant Hermes process/session to load the change. Configure gateway
channels explicitly if needed. Recording is independent: `browserpane-workflows`
and `workflow_learning` remain optional and are not enabled by this example.
Existing installations/configuration are never auto-migrated. Disabling the
executor does not delete its catalog or receipts.

The plugin reads the existing `mcp_servers.browserpane.url`, normally
`http://browserpane:8931/mcp`, and defaults to `/shared/downloads`. This pilot
supports the bundle's unauthenticated, trusted-network HTTP MCP connection, not
custom headers/authentication or stdio transports. It checks guarded-flow support
on connection. The catalog's endpoint and download directory must match exactly;
changing either needs freshly reviewed execution bundles, not silent rebinding.

## Publish one reviewed execution

Use the operator-shell `workflow()` abbreviation and private recipe/bindings from
[the recipe guide](WORKFLOW_REPLAY.md#review-then-run-once), with the fixed store
`/opt/data/workflow-runs`. Inspect `workflow review`, then explicitly acknowledge
its digest. To make that existing approval selectable by Hermes:

```sh
workflow approve --digest REVIEWED_DIGEST
workflow register --run-id RETURNED_RUN_ID --catalog /opt/data/workflow-catalog
```

`register` does **not** approve anything. It requires a matching, unexpired approval
and atomically publishes its frozen contract, including private bindings, into
`/opt/data/workflow-catalog/RETURNED_RUN_ID.json`. Repeating registration is
idempotent and cannot overwrite the bundle. Approval still expires ten minutes
after creation; registration/discovery do not extend it. Each new execution or
different parameter set needs its own review and run ID.

Hermes can now use `workflow`:

| Input | Meaning |
| --- | --- |
| `{"op":"discover"}` | At most 16 execution IDs, recipe IDs/versions, states, and unexpired-approval flags. Follow `nextOffset` using `offset`. |
| `{"op":"run","run_id":"ID"}` | Execute one registered approval or return its existing outcome. No arbitrary parameters, paths, code, or new tabs. |
| `{"op":"status","run_id":"ID"}` | Durable state and verification evidence; `active` means this process is still settling the job. |
| `{"op":"cancel","run_id":"ID"}` | Persist a cooperative cancellation request; never claim an input already sent was undone. |
| `{"op":"reconcile","run_id":"ID"}` | Inspect surviving artifact/browser evidence without navigation, fill, click, or replay. |

An unexpired approval does not guarantee execution: a busy worker, another
unresolved run, changed page/account, configuration mismatch or missing evidence
can still stop it. The default shared tab must be blank or at the exact recipe
URL. Keep the browser supervised and do not interact during a run.

Run/reconcile and active status calls wait up to five seconds by default for the
existing worker. Longer jobs return `active:true` and `pollAfterMs:1000`; inspect
`status` rather than issuing another browser action. `wait_seconds` accepts a
finite number from 0 through 10. Waiting releases the admission lock, so another
caller can request cancellation immediately; its durable write may still contend.
Status never starts a job, adds browser input, or invokes a model.
An idle process can still report an interrupted durable state, so `active:false`
alone does not mean complete. Only `verified:true` proves the supported report's
contents. Errors use bounded codes and never copy page text or SDK exceptions.
`workerError`, when present in status, is this process's last admission/worker
error, not a new durable journal state; it does not survive process restart.

There is one active job and no mutation backlog. A duplicate ID joins that job;
a different ID receives `WORKER_BUSY` without consuming its approval. Completed
IDs never export again, including after a worker/process restart. Uncertain
exports block new execution in this journal until explicitly resolved. The tool
cannot approve, abandon, register, delete, or silently repair an execution.

## Warm connection and cancellation

The first actual execution starts one lazy background thread and initializes an
SDK connection. Subsequent runs reuse it for up to 30 idle seconds. Initialization
and teardown stay in the same asyncio task, as required by the pinned SDK's AnyIO
contexts. Request IDs increase for that connection; timings are per-run deltas.
Observations/leases/targets are refreshed for every run, never cached as authority.
This is one additional MCP connection to the same browser, not reuse of Hermes's
internal SDK object or a second Chromium. The normal chat connection is unchanged.

Cancellation before start closes the approval as `stopped`. During execution it
sets a durable flag checked before later calls. An already-dispatched `pane_flow`
contains both fill and click; cancellation cannot split or undo that batch. If
export intent has been recorded, cancellation conservatively leaves `uncertain`
until explicit read-only reconciliation can prove the result. A cancellation
arriving after verification does not relabel a successful export as cancelled.

Unload requests cancellation and gives the worker up to 25 seconds to settle; it
does not cancel an SDK task or release its fence prematurely. A still-settling
worker can outlive that timeout; no new run is accepted by that service. Hard
process termination leaves the last journal checkpoint for recovery. A failed
transport is discarded, never transparently retried for the same logical run.

## Storage and trust

The catalog uses a private `0700` directory and `0600` regular files, with at most
32 entries of at most 64 KiB each. Publication is serialized, non-overwriting and
fsynced. Symlinks, loose permissions, duplicate JSON keys, mismatched digests and
extra contract fields fail closed. There is no automatic pruning or rotation.
The journal retains its schema-1 format; cancellation is stored in bounded evidence.
Status reads use SQLite read-only connections without creating files, changing
pragmas or initializing schema. Short database lifetimes are serialized within a
journal instance; cross-process SQLite locks remain authoritative. Mutations keep
FULL-synchronous intent-before-dispatch durability. Lock, storage and recovery
failures return bounded `JOURNAL_*` codes, never an automatic browser retry.
`JOURNAL_RECOVERY_REQUIRED` means a read-only connection cannot recover a hot
rollback journal: stop and investigate with the operator, rather than deleting
journal files or replaying an uncertain export. Content-free diagnostics record
only phase, stable code, exception class and SQLite error number, never exception
messages, URLs, parameters or run IDs. Protect and bound the host's log sink.
Allowlisted browser failures retain an `MCP_*` reason code. Diagnostic logs may
also retain bounded completed/stage/step counters and `mayHaveActed`; those fields
are diagnostic claims, never permission to retry or proof of a verified export.
Unknown remote codes/messages are not copied. A durable export intent still
becomes uncertain on any such failure, including a reported preflight rejection.

Unlike the redacted learning recorder and fingerprint-only journal, **the catalog
contains URLs, target labels, and parameter values**. Do not put credentials in
recipes. Protect the whole Hermes volume and backups; stop writers before backup.
Do not rotate/reset a full journal to bypass pending outcomes. Unexpected staging
files after a crash require operator inspection, not automatic catalog repair.

All tool-enabled sessions in one Hermes home can discover/run/cancel these IDs.
IDs are not secrets, tenant identities, or authentication. Hermes and the operator
share writable file/terminal access, so neither catalog permissions nor digest
acknowledgements enforce separation of duties. The worker fence does not block raw
MCP, another store/machine, or the human viewer. This remains supervised only.

Direct runner MCP calls do not pass through Hermes's six chat-tool observer hooks.
Use its journal for execution evidence; a `workflow_capture` transcript is not a
complete execution audit. Selection/learning/repair may consume model tokens even
though a deterministic runner execution makes zero model calls.

## Qualification and measured benefit

The container's read-only health probe loads the pinned upstream `gateway/status.py`
directly, avoiding the eager messaging imports in `gateway/__init__.py`. It still
uses upstream runtime-state and PID/lock/profile checks with stale-file cleanup
disabled. Its five-second deadline is unchanged; this is process liveness, not
proof of configured channels, model access or successful workflow execution.

Run the existing Python/unit/MCP/replay checks, then with the isolated pinned
Python SDK environment described in the recipe guide:

```sh
npm run test:warm
npm run bench:warm -- 30
docker build -t browserpane-hermes-agent:workflow-warm hermes
python3 hermes/check-container.py --image browserpane-hermes-agent:workflow-warm
```

The warm benchmark uses **one uninterrupted browser/profile/tab**, alternating
30 cold CLI and 30 warm executions, plus a separately reported initial warm run.
Each export has independent CSV, trusted-click and request-count verification.
Both arms use the same Python recipe/SDK/verifier and five MCP calls. Only the
owned synthetic fixtures auto-acknowledge their contracts. No timing threshold or
paid model is used in CI; CI runs a shorter persistent-profile smoke test.

Local ARM64 Mac / headless sandboxed Chromium 146, 2026-09-07:

| Metric | Cold CLI | Warm service |
| --- | ---: | ---: |
| Median wall time | 593.4 ms | 118.1 ms |
| p95 wall time | 768.3 ms | 173.3 ms |
| Median MCP-only time | 73.6 ms | 74.4 ms |
| Median SDK result JSON bytes | 3,515 | 3,517 |
| MCP calls per run | 5 | 5 |

All **61 exports verified**, with one warm SDK connection and no duplicate exports.
Steady-state median wall time improved about **5× (80%)** by amortizing startup,
not by speeding up page rendering or shrinking browser replies. Initial warm wall
time was 769.6 ms, including two status polls; all 30 subsequent warm runs completed
within the initial 250 ms tool wait. Operator review/registration is separately
timed and excluded. Reply bytes are SDK-serialized results, not tokens or wire bytes.
No actual model bill, real-site reliability, or Raspberry Pi latency is inferred.

A repeat on the final implementation again verified all 61 exports on one fresh,
then uninterrupted profile: cold/warm medians **493.2/88.0 ms**, p95
**532.0/102.7 ms**, one warm connection, no extra exports or steady-state polls.
These are two separate 61-export series, not 122 exports on one profile. The full
local checks also pass 78 Python tests, 256 Node tests, the 14-case replay matrix,
real MCP and warm-cancellation fixtures, image/runtime verification and CI syntax.

The earlier rapid-download stall was not reproduced in this persistent-profile
series; its historical cause is still unproven, not declared fixed. At that
checkpoint broader/Pi soak testing remained necessary. The real-browser cancellation fixture additionally
proves busy/duplicate behavior, cancellation after dispatch, read-only recovery,
and process restart. The ARM64 image qualifies actual pinned Hermes registration,
dispatch/unload and SDK reuse against a loopback fake browser; owned container
restart/recreation preserves catalog, pending intent and cancellation with no
replayed input. None of this changes or deploys an operator's Raspberry Pi.

The subsequent, explicitly authorized [isolated Raspberry Pi pilot](WORKFLOW_PI_QUALIFICATION.md)
passed its short smoke/recovery invocation but failed during pair 24 of a 30-pair
run. Successful-pair median wall times were 8.85 seconds cold and 2.78 seconds warm;
these provisional figures exclude the failed attempt, not a reliability pass.
The journal/polling follow-up and lightweight health probe passed a new isolated
smoke/recovery test. Its subsequent long run stopped during pair 13 with an
uncertain MCP action failure, after 25 verified exports. Of the 12 completed warm
runs, 11 needed no extra status poll. No GPU warning or storage error was retained
in that attempt, but its precise browser failure remains unresolved.

New reason-code/oracle diagnostics subsequently reproduced a successful download
followed by a three-second post-click completion timeout. The bounded fix in
browser checkpoint `bb9d6d2e` passed fresh Pi smoke/recovery and then all 30 pairs
plus recovery in a new invocation: 61 benchmark exports in one profile, followed
by health-report/cancellation and persistence checks. Cold/warm median wall times
were 19.23/4.10 seconds; 20 of 30 warm runs needed no extra poll and ten needed one.
One `GPU_CDP_QUERY_TIMEOUT` was retained; subsequent V3D/sandbox checks passed.
See the qualification report for all attempts, the warning and timing limitations.
The isolated workflow gate passed; production services were unchanged and rollout,
GitHub push and merge still require separate authorization. The later
[opt-in pacing increment](WORKFLOW_PACING.md) binds site intervals, jitter and a
shared quota to reviewed catalog entries. It is off in standard testing and was
not part of this hardware benchmark. Automatic website backoff/challenge handling
remains in the [site-policy plan](BPH_00008_WORKFLOW_SITE_POLICY_PLAN.md).
