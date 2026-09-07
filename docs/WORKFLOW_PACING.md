# Opt-in workflow pacing

The supervised report runner can space business operations and share a bounded
site budget across cold CLI and warm Hermes executions. It is **off by default**,
adds no model calls or MCP tools, and does not alter capture, rendering or the
guarded fill+click batch. This is pacing, not a promise to avoid bot detection.
The [research and remaining site-policy plan](BPH_00008_WORKFLOW_SITE_POLICY_PLAN.md)
separates timing from authorization, challenge detection and server backoff.

## Enable for a reviewed execution

After a separately approved Hermes image update, save a private regular JSON file
such as `/opt/data/report-pacing.json`. Start from the
[synthetic example](../config/workflow-pacing.example.json), replacing its origin
with the recipe's exact canonical origin: scheme, lowercase ASCII/IDNA hostname
and nondefault port, without a path or trailing slash. No wildcard/site groups.

```json
{
  "schema": 1,
  "version": 1,
  "origin": "https://reports.example.test",
  "minIntervalMs": 750,
  "jitterMs": 250,
  "maxActions": 20,
  "windowMs": 60000,
  "maxWaitMs": 5000
}
```

Add `--pacing /opt/data/report-pacing.json` to the shell function in the
[review/run instructions](WORKFLOW_REPLAY.md#review-then-run-once), then review and
approve the new digest. Supply the same file for **every** CLI operation, including
status, cancellation, registration and reconciliation. Its entire contents bind
to the reviewed contract; changing the version or any value requires fresh review.
The warm `workflow` tool reads the policy from the registered catalog entry; the
agent cannot override it through tool arguments. This is local review, not a
protected authorization boundary against the same filesystem identity.

Omitting the flag or using `--pacing off` creates an unpaced contract. There is no
environment, Compose or global plugin switch. Existing unpaced fingerprints stay
unchanged; an old runner rejects a paced catalog instead of silently ignoring it.
Never reapprove an uncertain action merely to change or disable its policy.

## Bounds and behavior

All fields are required; unknown fields, nulls, booleans and fractional numbers
are rejected. The example is a conservative starting point, not a universal
human timing profile; choose limits consistent with the site's permitted usage.

| Field | Meaning | Accepted range |
| --- | --- | --- |
| `schema` / `version` | Format / operator policy revision | `1` / integer 1–1,000,000 |
| `minIntervalMs` | Minimum gap before the next paced operation | 0–60,000 |
| `jitterMs` | Additional uniformly sampled integer gap, 0 through this value | 0–5,000 |
| `maxActions` | Maximum admissions within one fixed window | 1–1,000 |
| `windowMs` | Fixed-window duration, starting with its first admission | 1,000–3,600,000 |
| `maxWaitMs` | Total intentional wait budget across one execution | 0–10,000 |

One export normally consumes **two admissions**: navigation and the guarded
fill+click operation. These are not counts of keystrokes, clicks or HTTP requests.
An admitted attempt still consumes budget if later cancelled or rejected by a
page guard. There are no refunds, automatic retries or background scheduling.

Waits occur before fresh observations, never between pinned target selection and
input, nor inside fill+click. Each paced MCP input's completion extends the next
cooldown, so a slow navigation does not consume the next operation's gap. Page,
shared-tab and durable-intent checks remain in place. Observation, CSV verification
and read-only reconciliation receive no artificial delay.

Long cooldowns that do not fit the remaining budget return `stopped` with
`PACING_DEFERRED` immediately, without sleeping partway and sending early.
`maxWaitMs: 0` permits immediately available admissions but never policy sleeps.
No human prompt is opened. A stopped run ID remains stopped even after its budget
refills. Inspect the outcome before separately reviewing new work. An uncertain
issued export still requires read-only reconciliation, never replay.

Waits check durable cancellation in at-most-100 ms sleep slices; this does not
cancel an already-issued browser batch. Monotonic deadlines, a finite iteration
cap and an oversleep check prevent endless waits. OS pauses and storage contention
can exceed a requested duration; the cap is not a hard real-time wall-clock SLA.
Existing SDK, input and artifact deadlines are unchanged.

Results/status include `policyWaitMs` (zero when off) and, after policy admission
is attempted, `pacing` with its digest, version, admissions, wait time, code and
`retryAfterMs`. That last value is a local budget estimate, **not** a website
`Retry-After` header or permission to retry. `executionMs` includes policy time;
`mcpMs` does not. Abrupt process death can leave only the last checkpoint's timing.

## Persistence and trust boundary

The ledger is `<journal parent>/workflow-pacing/journal.sqlite3`, normally
`/opt/data/workflow-pacing/journal.sqlite3`, with a separate `worker.lock`. Journal
stores sharing a parent share site budgets across processes/restarts. Another
Hermes home or machine does not. The directory is private (`0700`), files `0600`;
only origin digests, timestamps and counts enter the ledger. Digests are not
anonymization. Protect the catalog, run journal, ledger and backups together.

Admissions use short serialized, FULL-synchronous SQLite transactions. No pacing
wait or browser work holds a database transaction or ledger lock; the existing
single-run safety fence stays held. Policy changes retain prior usage and cannot
shorten committed cooldown/window boundaries. Fixed windows can admit work on
both sides of a boundary; this is not a sliding-window request limiter. Capacity
is 128 origins, without eviction that could grant a fresh burst. Storage errors,
clock rollback and exhausted lock deadlines stop work; they do not reset budgets.

Persistent eligibility uses a trusted host wall clock; wait deadlines use
monotonic time. Detected backward steps fail closed; forward clock jumps can age
out budgets. This is not a distributed limiter or protection against the host
owner. Stop writers before backups; do not delete/restore ledgers to bypass limits.

The policy does not reserve the browser against viewers, raw MCP calls, explicitly
unpaced contracts or runners in another home. Atomic admission does not make
independent journals' browser operations atomic. This remains one supervised
runner per shared browser, not multi-tenant enforcement.

## Tests and remaining work

Standard unit, replay, warm, image/runtime and performance/pilot fixtures explicitly
remain unpaced and assert `policyWaitMs == 0`. Dedicated Python tests advance
virtual time for jitter, cooldowns, quotas, cancellation, oversleep and interrupted
runs. Actual SQLite tests cover concurrent first use, durable failures, private
storage and clock changes without intentional real-time delays.

```sh
python3 -m unittest discover -s hermes -p 'test_pacing*.py'
# Use the isolated pinned SDK environment described in WORKFLOW_REPLAY.md:
BPANE_WORKFLOW_PYTHON=/absolute/path/to/venv/bin/python npm run test:pacing
```

The dedicated integration uses fresh owned Chromium and the real Python SDK/tool
with zero-delay, zero-wait policies. It checks cold/warm shared quotas, helper
restart, no replay and explicit off. CI runs it separately from benchmarks.
Local checks do not qualify paced performance on a Raspberry Pi; the earlier
[hardware qualification](WORKFLOW_PI_QUALIFICATION.md) is an unpaced baseline.

Local validation on 2026-09-07 passed 31 dedicated policy tests on macOS ARM64 and
inside Linux ARM64, 131 Hermes unit tests, 13 pilot-harness unit tests and 264 Node
tests. Real SDK/Chromium pacing, warm, 14-case replay and MCP regressions passed;
a three-pair cold/warm check verified seven exports with zero policy delay.
The ARM64 Hermes image built and passed isolated gateway, restart/recreation,
catalog, journal and cancellation checks. Workflow syntax passed locally. These
are local results, not hosted CI, paid-model, live-site or Pi pacing evidence.

Automatic target-site HTTP 429/403 classification, `Retry-After` ingestion,
challenge recognition and a structured human-resume protocol are **not implemented**
by this increment. Existing page/operation failures stop as before. If a site
challenges or denies access, stop and use the viewer/operator path; delays do not
grant access. No CAPTCHA solving, fingerprint changes, proxy rotation or stealth
behavior is added.
