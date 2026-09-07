# Workflow site policy: pacing and challenge handling

## Status and user constraint

Research/proposal, 2026-09-07, followed by a local **pacing-only implementation**.
See [configuration and exact limits](WORKFLOW_PACING.md). Disabled by default;
automatic website backoff/challenge handling below remains proposed. This is
separate from the click-completion fix and its Pi qualification. No deployment,
paid service, GitHub mutation or new browser permission is implied.

The user explicitly requires intentional pacing to be **disabled in standard
testing**. Unit, replay, integration, CI and performance/soak fixtures must not
inherit real-site delays or wait for a human. Dedicated policy tests use injected
time and deterministic fixtures. Optional real-time checks require a separate,
explicit invocation and a hard wall-clock cap.

## Current implementation

`ReportRunner` uses one shared browser, verified page markers, a durable intent
journal and a bounded `pane_flow` containing fill plus click. Optional exact-origin
intervals, bounded jitter and fixed-window admission limits now bind to each
reviewed contract. Cold/warm processes share durable budgets; waits precede fresh
observations, are cancellable and have a total cap of ten seconds. Excessive
cooldowns stop without replay. Standard tests remain explicitly off; dedicated
policy tests use virtual time or zero-delay policies. Browser actionability waits,
download polling and tool-completion deadlines are not traffic pacing.

The ten-second click maximum is a completion deadline, **not a sleep**. It returns
as soon as Chromium completes. The existing MCP HTTP concurrency/429 controls
protect this server; they do not detect a target website's rate limits. Current
documentation calls for viewer handoff on challenges, but that is not a dedicated
automatic challenge-classification/resume subsystem.

## What other vendors document

These are first-party product/API descriptions, not independently measured block
rates or evidence that any approach works on every site.

| Project/vendor | Documented approach | Relevant lesson for this bundle |
| --- | --- | --- |
| Browser Use | Configurable action spacing (`wait_between_actions`, documented default 0.5 seconds), page-state waits and persistent profiles. Its cloud product separately advertises managed stealth, proxies and CAPTCHA handling. | Keep timing policy distinct from observation/transport speed and distinguish the open-source runner from managed infrastructure. [Parameters](https://docs.browser-use.com/open-source/customize/browser/all-parameters), [cloud](https://docs.browser-use.com/cloud/quickstart). |
| Apify / Crawlee | Request/concurrency caps, same-domain spacing and bounded crawl/retry counts. Session rotation has its own limit and is not counted toward ordinary request retries. | Share budgets across runs and account for every retry path; do not transplant crawler retries into side-effecting workflows. [Browser options](https://crawlee.dev/js/api/browser-crawler/interface/BrowserCrawlerOptions), [domain policy](https://crawlee.dev/js/api/basic-crawler/interface/BasicCrawlerOptions). |
| Browse AI | Advertises automatic request spacing, human-like interaction timing, proxy management and alternative-method retries when challenged. | Adaptive admission and structured block outcomes are useful; vendor claims are not a reason to retry uncertain business actions. [Vendor explanation](https://help.browse.ai/en/articles/12901847-how-browse-ai-handles-bot-detection-and-rate-limiting). |
| Browserbase | Documents persistent authentication, live human handoff, verified browsers and signed-agent partnerships allowing participating sites to recognize authorized agents. It also offers proxy/CAPTCHA services and recommends variable delays in its extraction guide. | Persistent sessions and explicit authorization are separate from timing. Partner recognition is not a portable capability we can claim for a local Pi. [Identity](https://docs.browserbase.com/platform/identity/overview), [authentication](https://docs.browserbase.com/platform/identity/authentication), [extraction](https://docs.browserbase.com/use-cases/web-data-retrieval). |

Cloudflare documents detection based on fingerprints, JavaScript checks, headers,
session characteristics and browser signals. **Our inference:** random delays
alone cannot reliably prevent detection; there is no universal "human" delay
range. Session continuity is useful but does not prove human operation or confer
permission. [Cloudflare detection engines](https://developers.cloudflare.com/bots/concepts/bot-detection-engines/).

## Recommended first increment

Delivery split: points 1–2 are implemented for exact origins and operation
admissions, without site groups or pacing inside a batch. Local `PACING_DEFERRED`
is implemented; points 3–5's automatic target-site classification, server
`Retry-After` ingestion and structured human-resume protocol remain follow-ups.
Their additional test cases below are future acceptance criteria, not passed tests.

Keep the rendering/MCP fast path fast. Add an **operator-approved, opt-in site
policy** around business operations, without extra model calls:

1. **Admission before input.** Scope policy to an explicitly configured origin or
   operator-defined site group and the reviewed workflow. Budget repeated
   navigations/exports across cold and warm runs in the same Hermes home, not a
   fresh budget for every run. Do not claim a global guarantee across other
   machines, direct MCP clients or human activity in the shared browser.
2. **Bounded cadence.** Configure a minimum interval, burst/run limit and maximum
   total policy wait. Optional small jitter smooths synchronized work; it is not
   a stealth guarantee. No artificial delays in observation, artifact verification,
   capture, cache handling or MCP responses. Business-action cadence does not cap
   all of Chromium's background HTTP requests.
3. **Explicit outcomes.** Distinguish target-site rate limiting, access denial,
   challenge requiring an operator and ordinary browser failure. A 403 alone does
   not prove bot detection. Use bounded structured evidence; do not retain full
   pages or treat page instructions as authority. Target-site HTTP status signals
   require new observation plumbing; the MCP transport's status is not a substitute.
4. **Honor server backoff.** A target's `Retry-After` can specify seconds or an
   HTTP date. Do not retry earlier if it exceeds our budget: return a deferred or
   blocked outcome instead. Bound and validate missing/malformed/huge values.
   Retry only explicitly safe operations, with capped backoff and attempt counts;
   do not introduce business-input retry in the first increment.
   [Retry-After semantics](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Retry-After).
5. **Human handoff.** On a challenge, stop further input and return control to the
   viewer. Persist an explicit outcome rather than sleeping indefinitely in a tool
   call. Resumption is explicit, rechecks the page/account/approval and never
   invents a fresh request ID to replay uncertain input. Authorized site APIs,
   service accounts or owner allowlisting are preferable where available.

Policy waits must be cancellable and charged to an overall bounded budget, without
extending existing browser-action deadlines. Schedule before taking page snapshots
or pinned handles; after a wait, observe and guard again. Do not hold a SQLite
write transaction or admission mutex while waiting. The single-execution safety
fence must not be released while issued browser work is still settling.

If later required, pacing **inside** a `pane_flow` needs a separate reviewed server
contract: the current fill+click batch cannot be paced by sleeping in Hermes
between MCP calls. Any such feature must wait before fresh target guards, retain
the batch deadline/cancellation rules, and remain opt-in. Do not silently split
batches or introduce per-keystroke/mouse animation overhead in this increment.

Store the approved policy version/digest with execution review and evidence so a
configuration change is not silently applied to already-reviewed work. Exact new
states/schema and cross-process storage rules for the deferred challenge/backoff
work still need design review. The pacing increment uses existing stopped/uncertain
states and a separate private admission ledger, described in WORKFLOW_PACING.md.
Report `policyWaitMs`, policy reason and site-limit events separately from browser,
MCP, model and total wall time. Do not label a policy-induced slowdown a rendering
regression, or claim JSON byte savings equal model token savings.

## Test gates: no indefinite waiting

- Default construction is policy-off. Standard harnesses explicitly select off,
  ignore ambient operator pacing configuration and assert zero policy sleeps and
  unchanged MCP/input counts. Existing real readiness/deadline checks remain.
- Inject monotonic time, wall time (for HTTP dates), sleeper and seeded randomness
  into dedicated policy tests; advance a fake clock without real waiting.
- Cover off/on, zero intervals, numeric/date `Retry-After`, expired/malformed/huge
  values, deadline exhaustion, cancellation during waiting and process recovery.
- An already-issued uncertain click followed by a challenge/timeout must yield
  **zero second clicks**. Blocked/paused runs must not create implicit retries.
- Cover shared cold/warm budgets, policy-version changes, stale views after waits,
  a human changing the tab, origin changes and scheduler rejection before input.
- Test long server cooldowns with virtual time: return promptly with a bounded
  outcome, never truncate a cooldown and then send early. Challenge fixtures must
  return operator-required immediately; no interactive prompts in CI.
- Use owned local challenge/429 fixtures, not live anti-bot sites. Keep existing
  no-replay, persistent-profile, cancellation and GPU qualification unchanged.

## Non-goals and acceptance

No CAPTCHA solver, fingerprint spoofing, proxy rotation, rate-limit bypass, stealth
browser fork, paid vendor integration or promise of avoiding blocks. No changes to
the shared browser/capture stack for this policy layer. Success means controlled
request cadence, explicit bounded failure/handoff and unchanged deterministic test
speed—not appearing indistinguishable from a human.
