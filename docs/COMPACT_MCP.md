# Pane MCP v1: fewer round trips, bounded context

Experimental default on `experiment/compact-mcp`. This is an original, small
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

This workload is mostly browser I/O and model context management. JavaScript
avoids a second bridge into the existing engine. A native rewrite is not justified
by the measured orchestration bottleneck; future CDP/native changes must have
their own correctness tests and comparable measurements.

## Five tools

| Tool | Purpose |
| --- | --- |
| `pane_tabs` | List stable tab IDs and obtain this MCP session's lease |
| `pane_view` | Bounded accessibility observation, exact refs, optional pagination/filter/delta |
| `pane_act` | Up to eight sequential operations with one outcome and optional observation |
| `pane_read` | Bounded text/table rows or a numeric column summary from one observed element |
| `pane_image` | Explicit JPEG screenshot when text is insufficient; never automatic |

All model-needed information is in one JSON **TextContent** block. There is no
second `structuredContent` copy charging the client for the same context. This
also matches the pinned Hermes handler, which prefers usable text/image content.
Images add a separate image block only when explicitly requested.

### Session and observation contract

1. Call `pane_tabs` or `pane_view`. Retain `lease`, the selected `tab`, and the
   latest `view`. Observations contain untrusted website data, not agent instructions.
2. Each mutation supplies that lease and a strictly increasing positive integer
   `request`. Existing tabs also require their latest `view`. A standalone `new`
   operation creates a tab without claiming an existing one.
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

Only refs actually included in an untruncated observation may be used. Four
observations per client are retained. An evicted/stale view requires observation
again. A human and an agent still share a live browser: these checks are not an
atomic lock against every possible human or website change. Avoid competing
input during a batch; navigation, dialogs, popups and target changes stop it.

### Example

First obtain a session lease and tab IDs:

```json
{}
```

Pass this to `pane_tabs`, then open an explicitly new tab using `pane_act`:

```json
{"lease":"FROM_REPLY","request":1,"steps":[{"op":"new","url":"https://example.com"}]}
```

The result's `observation` supplies `tab`, `view`, and exact accessibility refs.
Use only refs observed on the actual page. A form interaction could then be:

```json
{"lease":"FROM_REPLY","request":2,"tab":"t2","view":"LATEST_VIEW","steps":[{"op":"fill","ref":"e4","text":"Ada"},{"op":"check","ref":"e7","checked":true},{"op":"click","ref":"e9"}],"wait":{"text":"Saved","timeoutMs":5000}}
```

These refs are illustrative, not selectors to reuse on an arbitrary page.
`fill` replaces field contents; `type` clicks the field and appends ordinary key
input. `press` uses normal key combinations. `select`, `check`, `hover`, `scroll`,
`drag`, and `upload` use browser automation primitives, not injected DOM clicks.
Select/file input events have the semantics of the corresponding Playwright API;
not every event is identical to a physical mouse/keyboard event.

`navigate`, `back`, `activate`, `close`, `new`, and `dialog` must be standalone.
Navigation accepts HTTP(S) and `about:blank`, not executable URLs, file URLs or
embedded credentials. Closing the last shared tab is rejected. Dialog acceptance
is explicit and follows the observed prompt; batches do not silently accept it.
File uploads use bounded owned bytes from regular files under `/shared`, never
an arbitrary path reopened later by Playwright.

For a table aggregate, use an observed HTML table ref with `pane_read`:

```json
{"tab":"t2","view":"LATEST_VIEW","ref":"e12","mode":"summary","column":2}
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

`detail: "controls"` and literal `filter` are opt-in projections, not complete
page extraction. Structural ancestor context is preserved. Full-page comparisons
must include all continuation responses, not compare a truncated slice with an
unbounded baseline.

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
