# Semantic MCP fast-path experiment

Branch: `experiment/semantic-fast-path`, based on merged `main` commit
`70129e2c2b506bba8d6a3153e99131ef5d6888ca`.

## Objective and boundaries

Reduce repeated Chromium accessibility serialization and model/browser round
trips without replacing MCP, Playwright input, the shared browser, or the
existing stale-target and replay protections. Establish protocol measurements
before adding any model router. No paid model call, implicit production deployment,
stealth behavior, arbitrary JavaScript, CSS selector or CAPTCHA handling belongs
in this experiment.

## Change set

1. Emit opt-in content-free per-call timing records for queue, snapshot,
   projection, guard snapshot, input, wait, read/image, total time and output
   bytes.
2. Return a bounded per-session `state` handle with `pane_view`. Reproject
   pagination and semantic queries from that immutable raw snapshot without a
   new `_snapshotForAI()` call. Reject evicted, cross-tab or changed states.
3. Add a closed role/name `query` to `pane_view`. It returns only ref-bearing
   semantic matches plus structural ancestors; no model-provided selector or
   source code crosses into Chromium.
4. Add replay-safe `pane_flow`: at most four stages/eight inputs on the existing
   shared tab. Every stage resolves unique semantic targets from a fresh state;
   non-final stages require an exact URL or visible-text postcondition. Existing
   Playwright actionability, pinned handles, popup/dialog/navigation stops and
   request-ledger semantics remain in force.
5. Qualify pure projection/validation, fake-browser session behavior, real
   sandboxed Chromium over MCP, Compose configuration and the existing full
   wrapper/native matrix. Benchmark state reuse separately from model behavior.

## Pre-merge review corrections

- Keep one popup generation across the entire flow, including stage capture,
  action preflight and postcondition waits. An interrupted stage retains its
  applied-input prefix but does not count as a successfully verified stage.
- Add a view-bound continuation cursor that preserves projection options across
  pages and interleaved queries, within the existing four-view memory bound.
  Keep raw `state` independently queryable; do not mutate per-state defaults.
- Require `steps` in every stage at schema validation, before browser work or
  request recording; malformed input returns `INVALID_ARGUMENT`.
- Regress these boundaries in deterministic unit tests and disposable real
  Chromium. Re-run the equal-information HTTP MCP benchmark with cursor paging.
- After local checks, use the separately authorized local ARM64 build and Pi
  rollout. Keep profile backups, GPU/display setup and rollback image intact;
  production checks are read-only health/integration checks, not fixture tests.

## Promotion gates

- No input on zero or multiple semantic matches.
- No replayed input after a lost/duplicate response.
- No continuation to another stage without its required postcondition.
- State pagination returns the same complete fixture rows while invoking one
  Chromium snapshot instead of one per page.
- Timing output contains no URL, page text, selector, input value or credential.
- Existing compact, legacy, profile, tab-reuse, viewer and architecture checks
  remain green.

Only after these gates and Raspberry Pi measurements should a separate branch
evaluate deterministic recipe reuse and a fast-model/strong-corrector router.
That router belongs in Hermes orchestration; this MCP server remains deterministic
and model-provider agnostic.
