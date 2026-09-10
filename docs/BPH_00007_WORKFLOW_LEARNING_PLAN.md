# Learning reusable browser workflows through MCP

Status: original research and phased implementation plan. The bundle provides
opt-in [learning](WORKFLOW_LEARNING.md), [supervised replay](WORKFLOW_REPLAY.md)
and a [Hermes-local execution interface](WORKFLOW_EXECUTION.md), including a
reviewed catalog, run/status/cancel/reconcile and warm SDK reuse. A separate
workflow MCP server, protected enforcement/reservation and model routing remain
proposals. The [isolated Pi qualification](WORKFLOW_PI_QUALIFICATION.md) records
synthetic successes and failures; it is not authorization for production use.
Dependency provenance is maintained in UPSTREAM.md.

## Recommendation

Keep Hermes responsible for learning, selection, and exception handling. Keep
BrowserPane responsible for guarded browser execution. Add a small, opt-in
recipe runner between them, using existing MCP calls and local durable metadata.

The reusable unit should combine a concise Hermes skill with a typed, versioned
execution recipe and independent evidence of success. A transcript alone is not
a workflow; a saved skill is not a durable execution engine.

The intended lifecycle is:

```text
Observed run + verified outcome
        -> redacted evidence -> draft skill + parameterized recipe
        -> fixture validation + review -> approved immutable version
        -> guarded replay -> verify result
                                 |
                          mismatch / uncertainty
                                 -> stop, reconcile, or propose a repair
```

This is procedural learning, not model-weight training. The important saving is
avoiding repeated model decisions on familiar tasks, not inventing a smaller
replacement for JSON-RPC. Retain one shared Chromium session, its profile, the
viewer, normal browser input, and the capture/tile/rendering stack. Do not add a
distributed database, broker, generic enterprise administration platform, or
second browser automation backend.

## 1. What the bundle actually supports

### Hermes already provides much of the learning layer

The packaged source was inspected in an isolated, read-only container without
network access, user volumes, or model calls. Relevant findings:

| Capability | Evidence in pinned Hermes | Important limitation |
| --- | --- | --- |
| Learn a procedure from the recent conversation | `agent/learn_prompt.py`, `build_learn_prompt()` | `/learn` constructs an agent request; it does not compile or prove a program. |
| Persistent procedural skills | `tools/skills_tool.py`, `tools/skill_manager_tool.py` | Instructions and supporting files can still require model interpretation on every execution. |
| Progressive disclosure | `skills_list`, `skill_view`, supporting-file reads | Avoid loading all workflows or complete histories into every prompt. |
| Usage, provenance, curation | `tools/skill_usage.py`, `agent/curator.py` | `bump_use()` measures loading/reference, not successful business outcomes. |
| Background skill review | `agent/turn_finalizer.py`, `agent/background_review.py` | Conditional and model-driven; its calls and tokens must be included in learning cost. |
| Tool observation hooks | `agent/inline_tool_executors.py`, `model_tools.py` | `post_tool_call` is best-effort, not a write-ahead execution journal. |
| MCP resources and prompts | `tools/mcp_tool_registration.py`, `tools/mcp_tool_handlers.py` | Utility tools are registered only when capabilities/configuration allow them. |
| Legacy and newer protocol negotiation | `tools/mcp_tool_transport.py` | Negotiating a protocol does not prove support for every optional extension. |
| Programmatic tool calls | `execute_code` in the separate `code_execution` toolset | This toolset is not in this bundle's explicit CLI seed selection. |

Pinned upstream references: [learning prompt](https://github.com/NousResearch/hermes-agent/blob/ee5b5ec21e576ccf9b941f9ff71330418415a5cb/agent/learn_prompt.py),
[skill usage](https://github.com/NousResearch/hermes-agent/blob/ee5b5ec21e576ccf9b941f9ff71330418415a5cb/tools/skill_usage.py),
[tool observer](https://github.com/NousResearch/hermes-agent/blob/ee5b5ec21e576ccf9b941f9ff71330418415a5cb/agent/inline_tool_executors.py),
[MCP registration](https://github.com/NousResearch/hermes-agent/blob/ee5b5ec21e576ccf9b941f9ff71330418415a5cb/tools/mcp_tool_registration.py).

Our [seed configuration](../hermes/config.yaml) enables CLI skills and memory,
disables the alternative browser toolset, serializes BrowserPane tool calls,
and disables MCP sampling. The [image](../hermes/Dockerfile) persists Hermes
state under `/opt/data`; [Compose](../compose.yaml) gives it a named volume.
The seed is only installed on first initialization: this review does not establish
the effective settings of an existing operator profile or every gateway channel.

An immediate user-facing operation, without a new browser protocol, is:

```text
/learn Save the report-export procedure we just completed as a reusable skill.
Parameterize the reporting period. Include prerequisites, how to verify the
export, and when to stop. Do not save credentials or live element references.
```

The next invocation can use that skill through Hermes's normal skill discovery
or slash-command mechanism. This provides reusable guidance today, not automatic
zero-model replay. No command above was executed during this assessment.

### BrowserPane supplies guarded execution chunks, not stored workflows

The [compact surface](COMPACT_MCP.md) has six tools: `pane_view`, `pane_act`,
`pane_flow`, `pane_tabs`, `pane_read`, and `pane_image`.

`pane_flow` already resolves unique role/name targets from fresh stage snapshots,
preserves actionability checks, and stops on ambiguous targets, popup/dialog
changes, partial input, or failed waits. Its four-stage/eight-input limit is an
intentional bounded execution contract, not a limit to remove for long workflows.
Non-final stages require a postcondition; workflow completion needs an additional
business-level verifier, including for the final stage.

The [request ledger](../server/compact/request-ledger.mjs) retains at most 64
outcomes in memory per MCP session. It protects duplicate requests within that
contract. It is not persistent cross-restart idempotency. Saved leases, refs,
view/state handles, tab identifiers, and request numbers are not reusable
workflow selectors.

The [HTTP server](../server/compact/http-session.mjs) advertises tools only.
There is no workflow registry, durable run API, resource/prompt surface, or MCP
Tasks implementation there. [Timing instrumentation](../server/compact/metrics.mjs)
is deliberately content-free; it cannot establish what a business task achieved.

## 2. Market comparison: patterns worth adopting

These are documented capabilities and architectural comparisons, not a claim
that these products have equivalent scopes or that our bundle matches their
enterprise maturity.

| Reference | Established or documented pattern | Application to this bundle |
| --- | --- | --- |
| Browser Use Cloud | Parameterized tasks can become cached scripts; optional lightweight output validation can trigger full-agent regeneration. | Separate learning from replay; use a bounded correction path. Prefer deterministic business checks where available. |
| Stagehand | Discover an action, execute it, cache resolved actions across runs; substitute sensitive variables separately. | Cache validated action plans, not old browser refs or secret-filled transcripts. |
| UiPath Orchestrator | Versioned packages, controlled deployment, rollback, run records, and distinct business/technical failure handling. | Version recipes, freeze versions per run, distinguish retryable failures from invalid business inputs. |
| Temporal | Persist orchestration progress and activity results; design external side effects for safe retries. | Durable step boundaries and reconciliation, without running Temporal infrastructure on the Pi. |
| LangGraph | Persistent checkpoints and explicit human interrupts/resumption. | Model approval and correction as resumable states, not a blocked browser call or an open chat promise. |

Sources: [Browser Use session API](https://docs.browser-use.com/cloud/api-v3/sessions/create-session),
[Stagehand actions and caching](https://docs.stagehand.dev/v3/basics/act),
[UiPath package versions](https://docs.uipath.com/orchestrator/automation-cloud/latest/user-guide/managing-processes),
[UiPath exception categories](https://docs.uipath.com/orchestrator/automation-cloud/latest/user-guide/business-exception-vs-application-exception),
[Temporal activities](https://docs.temporal.io/activities), and
[LangGraph interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts).

Browser Use's documentation describes no LLM cost for cached script execution,
but also describes optional model-based validation. Do not translate that into
an unconditional zero-cost end-to-end workflow claim. Likewise, Stagehand's
Browserbase server cache is distinct from its filesystem action cache.

The enterprise lesson is not “add a canvas.” It is a lifecycle: typed inputs,
scoped credentials, reviewed versions, observable runs, deliberate approvals,
bounded retries, and recoverable failures. UiPath also distinguishes reaching
an internal MCP endpoint from authenticating its caller and the downstream
tool's credentials. Our private network is useful isolation, not equivalent
identity or authorization. [UiPath MCP integration flows](https://docs.uipath.com/orchestrator/automation-cloud/latest/user-guide/mcp-use-cases-and-flows).

Research supports learning from both successes and failures. ReUseIt synthesizes
guarded workflows and reports improved repeat-task performance in a study of
15 tasks and nine users. That is relevant directional evidence, not a Raspberry
Pi benchmark or production reliability guarantee. [ReUseIt paper](https://arxiv.org/abs/2510.14308).

## 3. The reusable artifact: skill, recipe, evidence

Keep three distinct records:

1. **Skill:** when to use the workflow, required context, input meanings,
   limitations, and the recipe identifier. Keep its main body short.
2. **Recipe:** immutable typed instructions, semantic targets, parameter/output
   bindings, preconditions, postconditions, risk classes, and stop/retry rules.
3. **Run evidence:** which version ran, verified step outcomes, failures, timing,
   token/cost accounting, approvals, and redacted artifact references.

A proposed package could contain `SKILL.md`, `recipe.json`, and small synthetic
fixtures. Approval records and production traces must remain outside the
agent-editable skill package. Package imports need schema/size/path validation;
no executable install hooks. Export sanitized definitions, not private profiles,
cookies, traces, or operator-specific endpoint/account bindings.

The recipe contract should include:

- Stable ID, version, content hash, author/provenance, supported executor version.
- JSON Schema inputs and outputs, explicit required/default values and bounds.
- Allowed origins/routes and a deployment-local account/profile binding.
- Secret references resolved at execution, never secret literals in the recipe.
- Initial state expectations and scoped, unique semantic target descriptors.
- Bounded execution segments, data extraction, assertions, and named outputs.
- Per-step side-effect classification, deadline, verification, and retry policy.
- Final business success condition and a defined uncertainty outcome.

Start with straight-line flows and a small closed predicate vocabulary. Add
bounded branches/iteration only for demonstrated tasks, with maximum item counts,
deadlines, and durable per-item progress. Do not accept arbitrary JavaScript,
Python, shell, CSS programs, or unbounded regular expressions in a recipe.

Existing `pane_flow` role/name matching is a good foundation. Repeated labels
inside tables or dialogs may eventually need closed semantic scope qualifiers;
that is a separate additive change with ambiguous-target regression tests.
Unsupported targeting should stop or fall back to supervised exploration.

Example: “export last month's report” becomes inputs for the date interval,
not hard-coded dates. Its success criterion checks the expected report period,
download completion, allowed destination, file format, and required columns—not
merely that the Export button was clicked. These structured artifact checks are
proposed additions, not existing `pane_flow` functionality.

### Learning and promotion

Capture only explicitly selected runs. Correlate Hermes task/tool-call IDs with
browser outcomes and the independently verified result. Record successful paths
and failed alternatives so ambiguity, loading states, and recovery boundaries
are represented. A human demonstration through the viewer would require a
separate opt-in semantic recorder; current MCP logs cannot reconstruct arbitrary
human actions reliably from pixels or mouse coordinates.

Use the existing Hermes skill authoring/curation machinery to propose a draft.
Deduplicate by task family and compare against existing versions. Ask for missing
business rules rather than infer permanent rules from a single example. Validate
with held-out parameter values and altered layouts before promotion.

An approved version never changes in place. A repair creates a new candidate,
with evidence and a reviewable diff. Support deprecation, quarantine, rollback,
and deletion/retention separately. Preserve definitions needed by unfinished runs.

## 4. Managing it through MCP

MCP provides interoperability; it does not itself learn procedures or guarantee
their business semantics. Keep the six browser tools stable. First use local
Hermes skills. Later expose the same runner through an optional workflow MCP
adapter, available to Hermes or another compatible client.

Proposed tool families—not implemented APIs:

| Tool | Contract |
| --- | --- |
| `workflow_find` | Search/list compact metadata; retrieve one version's input schema and policy. Paginate, and filter by caller access. |
| `workflow_run` | Start an allowed immutable version with typed inputs and an application-level idempotency key; return a durable run ID. |
| `workflow_status` | Read bounded status, outputs, verified progress, uncertainty, and evidence links. |
| `workflow_cancel` | Stop future work cooperatively; distinguish requested cancellation from settled execution. |
| `workflow_manage` | Draft, validate, promote, quarantine, or deprecate through strictly typed operations and separately enforced permissions. |

Do not expose a new tool schema for every learned workflow. Measure the schema
cost of this optional surface; the normal browser-only connection stays compact.
`workflow_manage` must not let an agent approve its own work by setting a boolean.
Static validation does not execute a browser. Execution-based validation requires
an explicitly selected disposable fixture/test account; calling it “dry run”
must never conceal real side effects.

Resources can expose an immutable recipe/schema and paginated run evidence,
using identifiers such as `workflow://report-export/versions/3`. Resource URIs
are identifiers, not access credentials. Prompts can offer a user-invoked teaching
template, but are not executable workflow definitions or mandatory initial scope.
The pinned Hermes can discover resource/prompt utility tools; adding them still
needs integration tests and increases model-visible tool schemas.

Return a small structured result by default: `runId`, version, status, verified
progress, typed outputs, failure category, and optional evidence references.
Keep full traces out of the model context. A deterministic runner should consume
raw typed MCP results rather than repeatedly parse Hermes's model-facing text
wrapper. Preserve errors and partial/uncertain outcomes across both paths.

### Standards compatibility matters here

MCP transport/session, discovery and task-extension contracts can evolve.
Preserve application leases and stale-action protections through any protocol
migration; negotiate capabilities instead of assuming every client supports
the same lifecycle. See the [MCP specification](https://modelcontextprotocol.io/specification).

The pinned Hermes already contains legacy/newer discovery negotiation, but the
BrowserPane server remains session-oriented. No end-to-end Tasks integration was
established in this review. Initially, ordinary tools returning durable run IDs
plus status/cancel calls provide a compatible application-level solution. Later,
map them onto negotiated MCP Tasks for asynchronous progress and input requests;
the server still has to implement durable storage and correct recovery itself.
[MCP Tasks](https://modelcontextprotocol.io/extensions/tasks/overview).

Skills over MCP is also being standardized around Resources. Its working-group
page lists the extension and reference implementation as in review. Treat it as
an interoperability direction, not universal installed-client support or an
execution engine. Keep local Agent Skills-compatible packages usable independently.
[Skills over MCP working group](https://modelcontextprotocol.io/community/working-groups/skills-over-mcp).

## 5. Reliability and authorization before unattended writes

### Crash recovery is not blind replay

Maintain a runner-owned journal with logical states such as prepared, dispatched,
verified, failed, and uncertain. Durably record intent before an action; store
verification after it. Browser actions and local database commits cannot be made
one atomic transaction. A crash between them remains an uncertainty window.

After reconnect/restart, obtain fresh browser handles, validate origin/account
and page state, and reconcile uncertain steps. Read-only operations can often be
repeated. An uncertain Submit must first check the created record/business key
or require human resolution. Use downstream idempotency keys where the application
actually supports them. Never claim exactly-once browser side effects.

The workflow idempotency key deduplicates creation of a logical run, scoped to
caller, version, and validated inputs; conflicting reuse must fail. It does not
make a website transaction idempotent. Duplicate MCP delivery, duplicate run
requests, and duplicate business submissions are three different problems.

Keep durable IDs separate from MCP session IDs and transient browser leases.
Freeze version and bindings when accepting a run. Use a single active worker
with fencing so restart cannot leave an old worker dispatching alongside a new
one. Do not release browser capacity while uncancellable input might still settle.

Use SQLite in a separate runner-owned file, not invasive changes to Hermes's
internal state database. Include schema migration, bounded retention, disk-full
failure handling, backup/restore tests, and a durability configuration suitable
for the advertised restart guarantees. This is local metadata, not a new database
service. A single Pi is not a high-availability platform.

### Shared browser ownership

Serializing individual MCP calls does not reserve the browser between calls.
Add a bounded workflow reservation integrated with all relevant input paths,
visible “agent running” state, and explicit human takeover. Human takeover pauses
future automated input and invalidates the continuation. Resume only after fresh
checks. Do not hold the browser indefinitely during approval or long external waits.
Where interception cannot be guaranteed, require a supervised run instead of
claiming isolation. The browser page itself remains dynamic even under reservation.

### Honest trust boundaries

Hermes's existing skill write approval is useful authoring machinery, not an
execution authorization boundary. Its pinned `_run_write_gate()` even proceeds
if the approval module cannot be imported. Do not reuse that failure behavior for
high-impact actions. The normal agent can also write its own state and run terminal
commands. An approval flag in the same writable directory is only a convention.

For enforceable policy, put approved recipes, grants, and the journal behind a
separate service identity or protected process/storage boundary. Authorize the
actual caller; bind approval to version, validated inputs, intended account,
effect, and expiry. Recheck revocation before dispatch. Separate read, execute,
author, and promote privileges; deny when authorization cannot be established.

This remains insufficient if the agent can bypass the runner through unrestricted
raw MCP input, CDP, browser network access, or terminal credentials. A future
governed mode must constrain those alternate write paths too. The current private,
single-user bundle must not be described as enterprise multi-tenant security.

Treat page content and downloaded files as untrusted data, not authoring or
approval instructions. Scrub sensitive inputs before storage and before learning;
omit cookies, authorization headers, passwords, and raw transcripts by default.
Allowlist evidence fields, separate public templates from private bindings, and
bound retention. Hashing a guessable personal value is not adequate redaction.
Best-effort observation hooks may support learning; mandatory audit/authorization
records must fail closed when they cannot be persisted.

## 6. Execution speed and token strategy

Use a tiered path:

1. **Deterministic replay:** validate parameters and prerequisites; execute approved
   segments and deterministic assertions without intermediate model decisions.
2. **Bounded local repair proposal:** a fast model receives only the failed step,
   relevant fresh view, and permitted alternatives. It cannot bypass a failed guard.
3. **Broader correction:** a stronger model investigates genuinely new structure
   within a fixed call/token/time budget, producing a candidate or explanation.
4. **Human decision:** uncertain writes, changed authority/account, invalid business
   input, expired login, or exhausted budgets stop rather than escalate indefinitely.

Selection of an existing recipe may need one model call for natural-language
requests. Explicit recipe calls can avoid that. Model-based output verification,
learning, curation, summaries, and repairs must be counted; “no intermediate model
decisions” does not automatically mean zero end-to-end billed tokens.

Keep parameter values out of cached plan text. Check fresh semantic guards on
each segment; neither a TTL nor matching URL establishes that a target remains
correct. Store minimal workflow-specific state, not complete accessibility trees
or screenshots on every step. Use event/condition waits with deadlines, not fixed
sleeps or repeated whole-page model inspections.

Keep the normal Playwright/CDP input path. Python is a reasonable first language
for the Hermes-side adapter; reuse Node for BrowserPane. There is no evidence that
Rust, C++, assembly, or a new wire protocol would address this orchestration cost.
Do not move provider credentials or model sampling into the browser service.

For N repetitions, compare total cost, not only warm-path cost:

```text
learned_total = learning_and_validation_cost
                + N * (replay_cost + repair_probability * repair_cost)
```

Measure against the existing agent's cost for N verified successes. Workflow reuse
cannot eliminate site/network loading or rendering time; report those separately.

## 7. Evaluation and acceptance gates

Use owned fixtures and fresh profiles, never an operator's browsing session. Start
with report lookup, structured extraction, and export; then reversible draft
editing. Irreversible submissions are a later, separately authorized test scope.

WorkArena supplies atomic and compositional enterprise-style task families.
WebArena-Verified emphasizes audited tasks and deterministic, structure-aware
scoring. Borrow their evaluation principles; do not claim benchmark scores from
our much smaller fixtures or run their infrastructure on the Pi by default.
[WorkArena](https://github.com/ServiceNow/workarena),
[WebArena-Verified](https://github.com/ServiceNow/webarena-verified).

Compare four arms on matched tasks and parameters: current compact MCP agent;
skill-guided agent; deterministic recipe; recipe plus bounded repair. Keep model,
reasoning settings, browser state policy, task limits, and success evaluators fixed
when isolating workflow effects. Test model choices as a separate experiment.

Required scenarios:

- Cold learning versus warm replay, with unseen parameter values held out.
- Duplicate labels, missing/renamed controls, DOM replacement and delayed loading.
- Wrong route/account, auth expiry, unexpected popup/dialog, invalid input data.
- Dropped responses and restarts before input, after input, and after verification.
- Duplicate run IDs/keys, stale workers, revocation, cancellation and human takeover.
- Disk full, evidence-write failure, malformed packages and oversized outputs.
- Page instructions attempting policy changes, secret disclosure, or approval forgery.
- False-success traps: wrong-period exports, empty files, stale success banners,
  and a technically completed action with an incorrect business result.

Report verified success, false-success, duplicate side effects, safe-stop rate,
repair/human-intervention rate, LLM calls, input/output/cached tokens, and total cost
per verified success. Include learning/curation cost and unsuccessful attempts.
Report P50/P95 end-to-end latency, browser wait/queue/snapshot time, output bytes,
and Pi CPU/RSS/temperature under a controlled fixture load. Separate local,
hosted CI, and actual Pi evidence.

Initial proposed release gates: all deterministic safety cases pass with no
forbidden/duplicate writes; stable held-out workflows preserve baseline correctness;
approved warm fixture execution makes no intermediate model calls; broken workflows
stop or reconcile rather than silently “succeed.” Run at least 30 varied held-out
cases per pilot workflow, plus the failure matrix, and publish counts/uncertainty.
That sample is a pilot gate, not evidence of a 99.9% production SLA. Set latency
and cost regression thresholds only after collecting a baseline.

Paid model benchmarks remain opt-in, explicitly budgeted, and outside CI. CI can
exercise the executor, mocked correction responses, and validators deterministically.

## 8. Ordered implementation plan

Each item is a separate reviewable change, after selecting a clean base containing
the current semantic fast-path corrections. Nothing here authorizes a deployment.

| Priority / change | Deliverable and likely location | Acceptance |
| --- | --- | --- |
| P0 — Contracts and baseline | Add synthetic task/evidence schemas and fixtures under `test/`; define the small recipe contract and baseline harness under `scripts/`. | Distinguish tool completion from business success; demonstrate false-success rejection. |
| P1 — Hermes learning integration | Bundle a narrow workflow-authoring skill and opt-in redacted observer through a supported Hermes extension point under `hermes/`; reuse `/learn` and `skill_manage`. | A run becomes a parameterized draft; secrets/ephemeral refs do not enter reusable content; learning costs are visible. |
| P2 — Guarded recipe runner | Small Hermes-side runner, typed bindings/assertions, `pane_flow` chunk adapter, own SQLite journal; retain current limits. | Stable workflows run without intermediate inference; uncertainty/restart tests fail safely. Pilot scope is supervised/read-oriented. |
| P3 — MCP lifecycle and protected execution | Optional workflow MCP adapter, compact discovery/results, durable run IDs, cancellation, reservation/takeover, protected approval/store and bypass review. | Reconnect does not duplicate effects; operator approval cannot be forged; normal six-tool browser mode remains unchanged. |
| P4 — Controlled repair and promotion | Bounded fast/strong correction, immutable version diffs, quarantine/rollback, evaluation-driven retrieval/curation. | Repairs preserve policy and improve verified success/cost on held-out tasks; no silent approved-version edits. |
| P5 — Interoperability and operator polish | Capability-tested Tasks/Skills-over-MCP adapters where supported; sanitized import/export, documentation and minimal run visibility. | Existing clients retain tools-only compatibility; extensions are never assumed from SDK version alone. |

Before P1, verify the packaged hook/plugin registration path and configuration on
an owned Hermes fixture. Avoid importing whole live trajectories. If a source
patch is necessary, pin, document, and test it through the repository's source
provenance process rather than editing generated upstream code.

Changes involving new storage, credentials, listeners, permissions, or operator
configuration must update the corresponding security/configuration documentation
when implemented. No new host-exposed MCP port is needed. Do not silently replace
existing operator configuration or change background-review budgets.

The first useful milestone is deliberately small: one real task family learned
into a skill, one parameterized recipe replayed on fixtures, one robust success
verifier, and honest before/after measurements. Only then expand the workflow
language or add model routing.

### Alternatives and stop/go decisions

- **Skills only:** lowest implementation cost and sufficient when tasks change
  often or are rarely repeated. Ship this first; retain it for exploratory work.
- **Reviewed scripts using Hermes's programmatic tool calling:** a useful baseline
  before building a runner. It can reduce model round trips, but the bundle does
  not currently select `code_execution`, and script storage alone does not provide
  restart reconciliation, approval enforcement, or business verification. Test
  this explicitly in an isolated configuration; do not enable it silently.
- **Closed recipe runner:** recommended for repeated, well-scoped tasks where
  validation can be deterministic. Continue beyond the pilot only if amortized
  cost and verified reliability justify maintaining the additional component.
- **External workflow engine:** consider integration only when requirements expand
  to multiple workers, cross-service orchestration, or availability beyond one Pi.
  Implementing a general Temporal/LangGraph alternative is not this project's goal.

## Assessment boundaries

This review inspected repository code, packaged pinned Hermes source, and current
primary documentation. It did not inspect private histories or effective live
profiles, execute `/learn`, benchmark models, modify the Raspberry Pi, deploy
software, or verify market-wide performance superiority. All new tools, recipe
formats, storage, policies, and release thresholds above are proposals.
