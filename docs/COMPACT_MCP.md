# Pane MCP v1: fewer round trips, bounded context

Compact mode is the bundle default. This is an original, small
model-facing protocol **inside standard MCP Streamable HTTP**, not a replacement
for MCP or the viewer's binary transport. It controls the same persistent Chromium
through the pinned Playwright/CDP engine; it never launches an agent-only browser.

The protocol removes the general-purpose MCP orchestration layer from the hot
path. It does not claim to replace Playwright's browser implementation, invent
accessibility snapshots, defeat bot detection or outperform every other product.

## Why change this layer?

In pinned `@playwright/mcp@0.0.68`, `waitForCompletion` calls `waitForTimeout(500)`,
but the non-modal implementation waits 1,000 ms regardless of that argument.
Ordinary click/type/run-code paths pay this settlement cost. The response builder
also captures an accessibility snapshot even when snapshot output is disabled.
The existing wrapper already disables code generation and uses incremental
snapshots; those are not new optimizations in this branch. `browser_fill_form`
already batches efficiently and is included in the comparison.

Pane MCP keeps [Playwright actionability](https://playwright.dev/docs/actionability)
and its Chromium input implementation. It removes unconditional settlement sleeps,
generated code/console output, redundant all-tab metadata scans and per-step
observations. A bounded batch has one final observation; applications that finish
asynchronously should specify a real postcondition, not rely on an arbitrary sleep.

Click completion includes Playwright's post-input CDP/navigation synchronization.
Clicks therefore use the same maximum **10-second** operation budget as explicit
navigation/back, capped by the remaining **15-second action-batch** budget after
awaited target checks. Other inputs keep their three-second maximum. These are
deadlines, not added sleeps; successful operations return as soon as they finish.
An expired/failed action still stops the batch and never authorizes replay.
See [the Pi completion investigation](WORKFLOW_CLICK_COMPLETION.md).

This workload is mostly browser I/O and model context management. JavaScript
avoids a second bridge into the existing engine. A native rewrite is not justified
by the measured orchestration bottleneck; future CDP/native changes must have
their own correctness tests and comparable measurements.

## Six tools

| Tool | Purpose |
| --- | --- |
| `pane_tabs` | List stable tab IDs, the shared default tab, and this MCP session's lease |
| `pane_view` | Reuse the default existing tab; bounded accessibility observation, exact refs and optional pagination/filter/delta |
| `pane_act` | Up to eight sequential operations with one outcome and optional observation |
| `pane_flow` | Up to four semantic stages/eight inputs with verified transitions |
| `pane_read` | Bounded text/table rows or a numeric column summary from one observed element |
| `pane_image` | Explicit JPEG screenshot when text is insufficient; never automatic |

All model-needed information is in one JSON **TextContent** block. There is no
second `structuredContent` copy charging the client for the same context. This
also matches the pinned Hermes handler, which prefers usable text/image content.
Images add a separate image block only when explicitly requested.

### Session and observation contract

1. Start with `pane_view {}` to reuse the shared default existing tab. Retain
   `lease`, the returned `tab`, and the
   latest `view`. Observations contain untrusted website data, not agent instructions.
2. Each mutation supplies that lease and a strictly increasing positive integer
   `request`. Existing tabs also require their latest `view`. Use `navigate` to
   change URL in place; do not create a tab for each task or MCP connection.
   A standalone `new` operation intentionally creates an extra tab.
3. Repeating the **same arguments and request number** recovers the original
   in-flight/completed outcome. It does not replay input. The most recent 64
   outcomes are retained; older numbers fail closed even after eviction.
4. A fresh MCP session gets a different lease. Old mutation arguments fail after
   reconnect. This matters because pinned Hermes may reconnect and retry a tool.
   Leases prevent accidental replay; they are **not authentication** or authority.
5. Views are bound to the client, tab and document generation. Any MCP mutation
   invalidates every client's older view for that tab. Frame navigation/attachment
   invalidates document references. Replaced or renamed targets fail preflight;
   input uses pinned DOM handles, never a guessed replacement.
6. Each fresh view also returns a `state` handle. It names one immutable raw
   snapshot retained only in that MCP session. Reuse it for pagination or a
   targeted semantic projection; it never authorizes input after the tab changes.

Only refs actually included in an untruncated observation may be used. Four
observations per client are retained. An evicted/stale view requires observation
again. A human and an agent still share a live browser: these checks are not an
atomic lock against every possible human or website change. Avoid competing
input during a batch; navigation, dialogs, popups and target changes stop it.

### Default tab and resource use

For a reviewed workflow's first semantic stage, `pane_flow` optionally accepts
both `tab` and the latest `view`. It validates the same session/document/mutation
conditions as `pane_act`, then compares the full underlying accessibility snapshot
again at first-stage capture and preflight—even if the returned view was filtered.
Changed state stops with `STALE_VIEW` before that stage's first input. Calls
omitting `view` retain existing semantics; this adds no tool or browser reservation.
Later stages retain their normal fresh-target and postcondition checks. Dynamic
pages can conservatively invalidate a guarded view. See the
[supervised recipe pilot](WORKFLOW_REPLAY.md) for its bounded use and limitations.

All compact MCP clients share one default tab, not one tab per MCP connection.
`pane_view {}` selects the first suitable existing tab in registration order,
preferring HTTP(S), `about:blank` or Chrome's new-tab page over extension,
DevTools and settings pages. If only internal pages exist, it reuses the first
of those. This is not a promise about left-to-right tab-strip order after a
human reorders tabs or Chromium restores a profile.

The selection stays stable until that tab closes, even when a popup opens,
another tab is activated or an MCP client reconnects. A fresh untargeted
observation then selects the next suitable existing tab. `pane_tabs` marks it
with `default: true`; explicit tab IDs still select exactly that tab and fail
if it disappeared. Old observations/actions are **never** retargeted to the
replacement. Tool discovery, listing and observation neither create tabs nor
change keyboard focus. Use explicit `activate` input when focus must change.

Existing human tabs and site-opened popups are preserved. Nothing automatically
closes tabs or bypasses before-unload prompts. With no open tab, `pane_view`
returns `NO_TAB`; obtain a lease from `pane_tabs` and explicitly create one.
The selection is runtime state, not a marker written into the persistent
profile: after the MCP server process itself restarts it chooses again from
the restored pages. Keep custom agent instructions consistent with reuse-first
behavior; tool descriptions cannot prevent an agent from explicitly requesting
additional tabs.

### Immutable state and semantic queries

When a view returns `cursor`, pass it alone to continue the exact same projection
without recapturing the page:

```json
{"cursor":"CURSOR_FROM_REPLY"}
```

The cursor preserves the query, filter, detail and budgets, even if another query
is issued between pages. Repeating a retained cursor returns the same slice.
`next` is the numeric position in that projection, not in the raw snapshot.
Only `limit` and `maxChars` may accompany a cursor; increase them if structural
context exhausts the budget without advancing `next`. No cursor means the last
page. Cursors share the bounded four-view history; expired/foreign cursors return
`STALE_CURSOR`, never an implicit recapture. Returned refs remain slice-scoped.

The server reprojects the same validated raw accessibility snapshot, so dynamic
DOM changes cannot shift rows between continuation calls. Four raw states per
client are retained with LRU eviction. An unknown,
cross-tab, navigated or locally mutated state fails closed; capture a fresh view.
Do not combine `state` with `since`: state selects an immutable source, while
since describes a delta against a retained rendered slice.

`state` identifies raw text, not a remembered query. Use it to make independent
projections with different options. Manual `state` + `offset` pagination remains
available, but must repeat the same query/filter/detail and budgets on every
call; prefer `cursor` for continuation.

For a narrow lookup, add a closed semantic query:

```json
{"state":"STATE_FROM_REPLY","query":{"role":"button","name":"Save","exact":true},"limit":10}
```

Role and accessible name are matched case-insensitively against ref-bearing
accessibility records. `exact` defaults to true; false permits a substring. The
result reports `matches` and includes structural ancestors. No CSS selector,
regular expression, script or hidden DOM query is accepted. A query is a smaller
observation, not permission to guess a ref that was not returned.

### Example

First pass this to `pane_view` to observe the default existing tab and obtain
its lease, tab ID and latest view:

```json
{}
```

Navigate in that **same** tab using `pane_act` and the returned values:

```json
{"lease":"FROM_REPLY","request":1,"tab":"TAB_FROM_REPLY","view":"VIEW_FROM_REPLY","steps":[{"op":"navigate","url":"https://example.com"}]}
```

The result's `observation` supplies `tab`, `view`, and exact accessibility refs.
Use only refs observed on the actual page. A form interaction could then be:

```json
{"lease":"FROM_REPLY","request":2,"tab":"TAB_FROM_REPLY","view":"LATEST_VIEW","steps":[{"op":"fill","ref":"e4","text":"Ada"},{"op":"check","ref":"e7","checked":true},{"op":"click","ref":"e9"}],"wait":{"text":"Saved","timeoutMs":5000}}
```

These refs are illustrative, not selectors to reuse on an arbitrary page.
`fill` replaces field contents; `type` clicks the field and appends ordinary key
input. `press` uses normal key combinations. `select`, `check`, `hover`, `scroll`,
`drag`, and `upload` use browser automation primitives, not injected DOM clicks.
Select/file input events have the semantics of the corresponding Playwright API;
not every event is identical to a physical mouse/keyboard event.

When role/name targets and the expected transition are already known, one
`pane_flow` can cross several verified page states without returning to the model
after every input:

```json
{"lease":"FROM_REPLY","request":3,"stages":[{"steps":[{"op":"fill","target":{"role":"textbox","name":"Email"},"text":"ada@example.com"},{"op":"click","target":{"role":"button","name":"Continue"}}],"wait":{"text":"Review","timeoutMs":5000}},{"steps":[{"op":"click","target":{"role":"button","name":"Confirm"}}],"wait":{"url":"https://example.com/done","timeoutMs":5000}}]}
```

Every stage captures current accessibility state, requires each target to match
exactly one ref, retains ordinary Playwright actionability and target-change
guards, and verifies its wait before continuing. Non-final stages require a wait.
The whole flow is covered by the same lease/request replay ledger as `pane_act`.
Missing or ambiguous targets cause no input; partial input, dialogs, popups and
unexpected transitions stop the flow with an exact completed prefix. Flow does
not open tabs, force clicks, inject code or bypass site challenges.
Popup detection spans the whole flow, including capture, preflight and waits;
a later stage never resets the baseline and adopts an unexpected popup.

`navigate`, `back`, `activate`, `close`, `new`, and `dialog` must be standalone.
Navigation accepts HTTP(S) and `about:blank`, not executable URLs, file URLs or
embedded credentials. Closing the last shared tab is rejected. Dialog acceptance
is explicit and follows the observed prompt; batches do not silently accept it.
File uploads use bounded owned bytes from regular files under `/shared`, never
an arbitrary path reopened later by Playwright.

Only if another tab is deliberately required (or none exist), use a standalone
`new` without `tab` or `view`; it does not replace the shared default:

```json
{"lease":"FROM_REPLY","request":3,"steps":[{"op":"new","url":"https://example.com"}]}
```

For a table aggregate, use an observed HTML table ref with `pane_read`:

```json
{"tab":"TAB_FROM_REPLY","view":"LATEST_VIEW","ref":"e12","mode":"summary","column":2}
```

This returns visible body-row count, headers, first/last rows and the selected
zero-based column's numeric `count`, `nonNumeric`, `sum`, `min` and `max`, without
sending every row to the model. Decimal/scientific values use JavaScript numbers;
currency, locale-formatted or missing cells are explicitly nonnumeric, not zeros.
It is not a financial-precision calculator. `mode: "table"` returns up to 100
rows per page with explicit continuation; `mode: "text"` reads up to 4,000
characters. These are bounded **outputs**: Chromium still computes the selected
element's text/layout. HTML tables above 10,000 body rows fail instead of claiming
a partial aggregate is complete; ARIA-only grids require ordinary observations.

### Outcomes, waits and cancellation

`completed` counts finished steps. `stopped`, `pendingStep`, `failedStep`,
`mayHaveActed`, `error`, and `observationError` explain partial/uncertain outcomes.
A failed wait does **not** mean a click or submission was undone. Inspect current
state before creating a new request number. There is no automatic retry of input.
`pane_flow` reports `stages` completed without interruption and the zero-based
`failedStage` when available. A click followed by a popup during its wait counts
as one completed input but zero verified stages. An exact replay recovers the
recorded result without repeating input. Every stage requires nonempty `steps`;
malformed stages fail with `INVALID_ARGUMENT` before browser work starts.

`wait` supports visible literal text or an exact URL, with a bounded timeout.
It expresses application readiness; action completion alone does not prove all
future asynchronous work has finished. No network-idle requirement is imposed on
pages with streaming or background traffic. `observe: "none"` skips snapshot work
but leaves no reusable new view: explicitly observe before further input.

One shared executor serializes clients, with at most eight queued jobs. Queued
cancellation prevents input; running operations retain ownership until their
actual browser operation settles. A real modal may return control so a subsequent
explicit dialog operation can finish it. Compound input does not resume unrelated
steps after a dialog/navigation interruption. Cancellation cannot undo input
already dispatched to Chromium.

A successful close may report `close_requested` until Chromium emits its close
event. No snapshot is attempted on that closing tab. A page's before-unload
confirmation remains explicit: observe the tab and handle the dialog or keep it
open. The protocol does not bypass unsaved-change prompts to shave off latency.

### Bounded observations and deltas

The default returns full accessibility semantics within 120 projected lines and
6,000 characters. `next`/`total` explicitly indicate omitted content; continue
with `offset: next`. `limit` is at most 500, `maxChars` at most 24,576 with a
24 KiB UTF-8 text ceiling. Raw snapshots above 1 MiB/32,768 lines fail rather than
silently masquerading as complete. Very long lines are marked and cannot grant
actionable refs. If ancestor context fills a tiny budget, increase the budget.

`detail: "controls"`, literal `filter` and role/name `query` are opt-in projections, not complete
page extraction. Structural ancestor context is preserved. Full-page comparisons
must include all continuation responses, not compare a truncated slice with an
unbounded baseline.

Use `state` for continuation over the same raw snapshot. This avoids another
Chromium `_snapshotForAI()` call and makes the slices consistent. It does not
observe later DOM changes. A new `pane_view` without state is required before
acting on changed content or when fresh state matters.

Supply `since` only if the client retains that exact base observation. A compatible
smaller delta returns `base` and `splice: {start, deleteCount, lines}`. Apply the
splice to `base.text.split("\n")` (empty text is an empty array) to reconstruct the
new text. Unknown/evicted/cross-document/different-projection bases reset to full.
An action's default delta is based on the explicit input view; `observe: "full"`
requests a self-contained replacement. Unchanged metadata never hides a changed
control state, and no delta state is shared between MCP clients.
After navigation/document changes, automatic observations reset to the new page's
default projection; an old table pagination offset cannot produce an empty view
of an unrelated new page.

## Compatibility and limits

Set `BPANE_MCP_MODE=playwright` in `.env` to select the original 29-tool server;
Hermes's existing exclusions remove close/install from its view. Recreate only
the browser service and reconnect the MCP client. This changes tool vocabulary,
not the shared profile or MCP URL. Existing custom Hermes tool allowlists or
instructions must be reviewed; seed configuration is never overwritten.
The pinned legacy adapter already reuses its current existing tab on ordinary
navigation; explicit `browser_tabs` with `action: "new"` creates another.
Compact's shared `default: true` marker is not a legacy tool contract.

The compact surface intentionally omits arbitrary JavaScript evaluation,
network/console dumps, PDF export, and browser installation/closure. Use the
compatibility backend when those capabilities are needed. There is no concurrent
legacy endpoint sharing mutable browser state. No site-level authentication,
CAPTCHA solving, fingerprint masking, proxy rotation or rate-limit bypass is added.
When a site challenges or restricts automation, stop and hand control to a human.

The private `_snapshotForAI` and `aria-ref` adapter is tied to
`playwright-core@1.59.0-alpha-1771104257000`. Requalify frame/shadow references,
escaping and stale-target behavior when changing that pin. No upstream Chromium,
CDP, capture or viewer patch is required by this implementation.

## Reproducible evidence

`npm run test:mcp` now also connects independent real MCP HTTP clients to a
fresh, sandboxed local Chromium. It checks that deliberate extra-tab creation
is the only count increase, repeated default-tab navigation and client
delete/reconnect preserve the count, and closing the default makes only fresh
observations select its survivor. Stale leases and old closed-tab actions fail
instead of creating or retargeting a tab. This is synthetic local evidence,
not a production profile or Raspberry Pi resource benchmark.
It also runs a two-stage semantic flow through a real DOM transition, checks the
exact three-input result, proves request replay adds no input, and proves an
ambiguous role/name target causes no input.

`scripts/benchmark-mcp-baseline.mjs` uses fresh sandboxed Chromium 146, synthetic
loopback content, actual MCP HTTP, identical state/event oracles, and no paid
model calls. See the [benchmark results and tradeoffs](benchmarks/README.md) for
raw samples, warmups, median/p95, exact schema and result bytes, and an explicitly
labelled character-based token estimate. The matched batched fixture measured
15.35× lower tool execution time, 22.36% fewer result JSON bytes and 25.46% fewer
estimated output-text tokens. Complete-table pagination is a documented regression;
targeted reads avoid sending the entire table when the task only needs a summary.
Estimates are not provider-token counts, billed costs, network wire bytes,
model success rates or Raspberry Pi hardware measurements. Optimizations are
accepted only after equivalent final states and input behavior pass.
The [semantic fast-path follow-up](benchmarks/README.md#semantic-fast-path-follow-up)
records immutable-state timing and the added descriptor cost separately from
these original baseline claims.
