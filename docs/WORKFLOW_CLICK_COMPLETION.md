# Pi click-completion timeout investigation

## Reproduced failure

A fresh isolated Pi run using the browser candidate and the unchanged Hermes image
stopped during pair 24: 23 complete pairs plus that pair's warm arm and the initial
export made **48 verified exports**. The next cold arm failed at `pane_flow` with
`MCP_BROWSER_ERROR`, `completed: 1`, `failedStep: 1`, `mayHaveActed: true`.
The retained underlying error was a three-second `elementHandle.click` timeout
**after** “click action done”, during the post-input navigation/synchronization wait.
The independent fixture saw one trusted click, one export request and the correct
CSV for the failed attempt. The runner correctly kept it uncertain and did not retry.

A separate fresh browser-only diagnostic reproduced the same failure on export
31 after 30 successful exports. Content-free extraction from the fixture-only CDP
trace showed the download completing before the error; a subsequent `Page.enable`
reply took **3,042 ms**, alongside **3,034 ms** for object cleanup. No requested
navigation event accompanied that download. This identifies a transient renderer-
side CDP stall exceeding the click budget, **not** a permanently missing navigation
signal. Raw protocol tracing changes load and is not a performance benchmark.
The deeper Chromium/host scheduling reason for the transient stall is not proven.

The untraced Hermes run retained V3D/sandbox readiness, no GPU warnings, no owned
OOM/CPU-quota throttling, at least 2,696 MiB available host memory and at most
57.9°C. Production containers were unchanged; both attempts removed their owned
containers, volumes and networks. These observations explain the newly reproduced
failure, not retrospectively every older generic error whose detail was lost.

## Fix and safety boundary

`ActionRunner` had classified `click` as a short input even though its promise
also waits for Chromium synchronization or navigation. It now gives clicks the
existing ten-second navigation/back budget, limited by the original 15-second
action-batch deadline. The remaining budget is calculated **after** awaited target
guards, fixing an additional deadline-accounting gap.

There is no added sleep, retry, `force`, `noWaitAfter`, alternate target, automatic
reconciliation or new MCP operation. Pinned handles, accessibility guards,
visibility/actionability checks, modal/navigation stops, serialized ownership,
request replay protection and durable workflow intent remain. Other inputs retain
their three-second budget. A longer unresolved stall can still fail and must stay
uncertain; this is bounded tolerance, not a claim to eliminate Chromium pauses.
No dependency, CDP or rendering-stack patch was needed.

## Regression and qualification gate

`npm run test:mcp` now also runs an owned real-browser fixture whose click starts
a navigation taking 3.6 seconds. Before the fix it produced the same post-click
timeout; afterward it completes once, stops the next batch input, and returns the
recorded result on duplicate request without another click. Unit tests cover
per-operation limits, time spent in guards, and expiry before further input.

Local unit, replay and real-browser checks pass. The repaired ARM64 image passed
fresh Pi smoke/recovery and all 30 pairs in a separate uninterrupted run, followed
by cancellation, restart/recreation and cleanup checks. One GPU-readiness CDP
query timeout was retained in the long run; later V3D/sandbox checks passed. This
does not establish the deeper cause of Chromium stalls. See the complete
[qualification result and caveat](WORKFLOW_PI_QUALIFICATION.md). No production
rollout, GitHub push or merge is authorized by these tests.
