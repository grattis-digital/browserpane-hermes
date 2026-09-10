# Shared-session research admission

Status: design requirement, **not implemented or deployed**. Keep this separate
from the experimental Chromium damage patch and its performance qualification.

## What already exists

CompactRuntime creates one SerialExecutor shared by every compact MCP session:
one executing tool call, at most eight waiting calls, cancellation before start,
and no early release while an underlying operation is still settling. Default
tab reuse is shared too. A pane_flow occupies that executor for its whole bounded
flow. The optional Hermes WorkflowService admits one active reviewed catalog run
and rejects a different run with WORKER_BUSY; it does not queue whole research
jobs. These mechanisms do not reserve the browser between separate MCP calls.

A completed navigation call is not proof that page loading, JavaScript, workers
or downloads have stopped. A single renderer can exhaust the container budget.
Serial commands and extra RAM therefore cannot guarantee freedom from OOM.

## Required next increment

1. Admit **whole automation jobs**, not only individual tool calls. Use a bounded
   FIFO with one owner for the shared browser, shared by the Hermes entry points
   that can start research. A research job must explicitly identify its start,
   completion and cancellation; an MCP connection is not itself a job.
2. Bind a job reservation to an opaque generation and validate it at the MCP
   execution boundary. Queue payloads are small job descriptors, not screenshots,
   raw observations, open pages or pre-issued browser mutations. Keep the existing
   per-call executor and stale-view/idempotency checks beneath this reservation.
3. Queued jobs perform no browser I/O or tab creation. Supply bounded waiting,
   queue-full responses, status and cancellation. On expiry/disconnection stop
   admitting old-owner input; **do not transfer ownership until its running work
   settles**. Restart does not silently replay an approved or uncertain action.
4. Reuse the existing default research tab. Bound additional automation-created
   tabs separately from registry capacity. Never silently close human tabs,
   navigation popups or authentication windows. Popups interrupt a flow and need
   explicit handling; preserving one session is not the same as one renderer.
5. Check container and host memory headroom before admitting another job, and
   recheck before expensive browser operations. Reject/pause new work with a
   typed resource-pressure outcome. Keep status, cancellation and explicitly
   requested cleanup available. Admission checks are preventive signals, not hard
   limits on a page's subsequent allocations; retain container resource limits.
6. Human viewer input is not placed in the automation FIFO. A human navigation,
   focus/context change or ambiguous input must invalidate/pause affected agent
   work, not let it continue against a different page. Do not automatically submit
   a form again or reload an uncertain operation after recovery.
7. Report content-free queue wait, depth, owner generation, resource rejection,
   cancellation and recovery counters. No raw URLs, page text or profiles in logs.

## Recovery boundary

Docker restart policy covers container exits, not a renderer killed while the
container remains healthy. The current wrapper separately relaunches a terminated
browser, and the GPU/display watchdogs terminate the wrapper on repeated failure.
The added cgroup-v2 memory watchdog now covers observed renderer-like OOM kills
through the existing graceful shutdown and Docker restart path; see
[recovery evidence](OOM_RECOVERY.md). It does not implement workload admission,
detect every renderer crash, or prevent repeated failures on a memory-heavy page.
Retain profile state and the no-blind-replay rule. Workload retry/cooldown belongs
to the next admission increment. Do not kill a live user session to test this.

## Acceptance gates

- Concurrent job producers: exactly one active job, FIFO admission and bounded
  backlog; every job's individual MCP calls remain within its ownership period.
- Cancelled/expired queued jobs produce zero browser operations; an interrupted
  in-flight action cannot overlap the next owner even if its reply arrives late.
- Burst navigation/new-tab attempts: bounded automation tabs and memory-pressure
  rejection, while human-owned tabs and profile data remain intact.
- Slow loads and a single memory-heavy page: no claim that queueing alone avoids
  OOM; verify scoped recovery on disposable synthetic browser/container resources.
- Restart, disconnect, modal/popup and manual navigation: preserve uncertain
  outcomes, clear ownership generation and require new observations before input.
- Deterministic tests use virtual clocks and synthetic pressure. No pacing waits,
  paid models, private browsing data or automatic actions in normal test runners.
- Qualify the actual Raspberry Pi separately, including total browser/display
  memory and host headroom. No production rollout or publication is implied by
  this plan or by a local test result.
