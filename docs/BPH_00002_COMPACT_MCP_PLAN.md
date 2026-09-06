# Compact MCP execution experiment

Branch: `experiment/compact-mcp`, based on qualified bundle commit `4f406009`.

## Objective and boundaries

Reduce browser-tool latency, model-visible schema/output size and unnecessary
model round trips, while retaining the one persistent browser shared with humans.
Measure deterministic synthetic workflows against the pinned Playwright MCP
baseline. Do not claim model success rates, billed-token savings, anti-bot
invisibility or Raspberry Pi hardware improvements from local benchmarks.

No production deployment, profile migration, stealth patches, fingerprint changes,
CAPTCHA solving, proxy rotation or rate-limit bypass. Ordinary browser input and
Playwright actionability checks stay intact. A challenge requires human handoff.
Capture, viewer, sandbox, profile and networking contracts remain unchanged.

## Implementation plan

1. Measure the current MCP over real HTTP with fresh disposable Chromium and
   synthetic navigation, observation, form and extraction fixtures.
2. Add a versioned compact protocol inside standard MCP, keeping the installed
   pinned Playwright browser engine for reliable inputs. Remove orchestration
   sleeps, repeated code/log output and unconditional post-action snapshots.
3. Provide bounded observations with explicit continuation and opt-in deltas;
   bind observed references to a specific tab/document/view. Never guess targets.
4. Add bounded sequential action batches, explicit postconditions, short outcomes
   and request replay protection. Stop after errors, navigation, dialogs or other
   unexpected state changes; report completed work and never silently replay it.
5. Keep legacy Playwright MCP selectable for compatibility and advanced tasks.
   Integrate Hermes, documentation, private-listener checks and native CI.
6. Verify correctness before comparing speed: stale references, concurrent
   clients, lost responses, dialogs, navigation, downloads, disabled/covered
   elements, Unicode input, shared-browser lifecycle and output bounds.

## Evidence policy

Record raw per-operation latency, median/p95, schema bytes, request/result text
bytes and an explicitly labelled character-based token estimate. These are not
model-provider token counts or network wire sizes. Compare equivalent final DOM
and browser event outcomes; batching and observation omission must be reported
separately from execution-engine improvements. Keep all test resources disposable.

Status: implementation, paired benchmarks and local ARM64 Docker qualification
complete. The protocol has five tools, including a targeted read/aggregate tool
added after the benchmark exposed the cost of sending entire tables for tiny
summaries. See [measured results and tradeoffs](benchmarks/README.md).

Local qualification: 190 wrapper tests; 22 real-browser compact checks; compact
and legacy runtime/download checks; original tab, cookie, local storage and shared
file persistence through reconnect/restart/recreation; lean Hermes and actual
three-service Compose discovery; 16 scroll-pixel checkpoints and 27 display
checks. Strict upstream replay remains 18 patches / 820 byte-identical files.
The capture and viewer sources are unchanged. These results are not Raspberry Pi
hardware measurements. Hosted amd64/ARM64 CI status belongs on this branch's pull
request and Actions page; deployment remains a separate decision.
