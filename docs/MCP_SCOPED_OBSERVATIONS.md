# Progressive MCP observations

Status: local experimental implementation; not a production rollout or an
enterprise certification. The six-tool MCP interface, persistent browser, input
engine and viewer transport remain in place.

## Decision: spend round trips to avoid unrelated browser work

Previously, `pane_view` captured the entire accessibility snapshot before applying
output filters. Ordinary action preflight captured it again, followed by the
post-action observation. A short response could therefore require a large DOM walk.

The new recommended sequence is a shallow outline, an expansion of an **observed**
region, and a guarded action or targeted read. See [exact arguments and recovery
rules](COMPACT_MCP.md#progressive-capture-for-large-pages). The expansion is not a
full snapshot followed by a text filter: traversal starts at the selected node
inside Playwright's injected accessibility implementation.

| Operation | Browser-side work | Coverage contract |
| --- | --- | --- |
| `pane_view {capture:"outline"}` | Depth 1 by default, at most 256 visited nodes | Deferred children/frames are explicit |
| `pane_view {tab,view,root}` | Selected subtree, at most 1,024 visited nodes | Complete only within that scope, when no limit applies |
| `pane_view {state,...}` / `{cursor}` | No new capture; project retained immutable text | Cannot widen the original capture |
| Ordinary action preflight | One-node semantic refresh per unique target, then existing handle/actionability guards | No permission to substitute a changed target |
| Guarded `pane_flow` | Existing whole-page comparison | Rejects a scoped starting view |
| `pane_view {capture:"full"}` or `{}` | Legacy whole-page capture | Existing output pagination and raw-size limits |

Single-child unnamed generic wrappers do not consume outline depth, but still
consume its node budget. This makes common wrapper-heavy applications navigable
without requiring an agent call for every nested `div`. Explicit iframe entry
uses an observed iframe ref. Shadow DOM retains Playwright's traversal semantics.

The adapter maintains at most 4,096 additional weak ref identities per injected
world so interleaved scoped captures do not erase another client's exact targets.
Eviction fails closed. This is not a DOM-content cache: retained observations are
still session-owned, and ordinary target semantics are refreshed before input.
Playwright's existing latest-snapshot retention is separate from this weak cache.

## What established products suggest

These are documented product concepts, not an
independent ranking, certification audit or evidence that another implementation
has the same browser-side complexity as ours.

| Primary source | Relevant concept | Choice for this bundle |
| --- | --- | --- |
| [Stagehand observe](https://docs.stagehand.dev/v3/references/observe) | Scope observation and extraction to a selected region; optionally exclude unrelated areas | Adopt region expansion, but accept only already-observed refs, not guessed CSS/XPath |
| [Stagehand MCP tools](https://docs.stagehand.dev/v3/integrations/mcp/tools) | Separate observe/act/extract and explicit session lifecycle/attachment | Keep the existing shared session; no per-call browser or model service |
| [Stagehand caching](https://docs.stagehand.dev/v3/best-practices/caching) | Reuse cached action inference and reduce unrelated cache invalidation | Keep immutable observation reuse; do not confuse cached reasoning with permission to replay input |
| [agent-browser snapshots](https://agent-browser.dev/snapshots) | Compact, interactive, depth-limited and scoped observations; ref lifecycle | Adopt progressive disclosure and explicit ref freshness. Its CLI output options alone do not prove traversal savings |
| [Browser Use CLI](https://docs.browser-use.com/open-source/browser-use-cli) | Separate page state, interaction, extraction and screenshots | Text first; bounded targeted extraction; screenshots only when needed |
| [Microsoft Playwright MCP](https://github.com/microsoft/playwright-mcp) | Accessibility references and a mature browser-input engine | Preserve Playwright actionability, frame handling and input, rather than replace them with DOM clicks |
| [AWS AgentCore Browser](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/browser-tool.html) | Session isolation, live human view, recording and operational observability | Keep content-free timing and explicit lifetime/queue controls; do not claim equivalent IAM, isolation or protected audit storage |

Stagehand supplies an actual MCP integration. AgentCore is browser infrastructure;
agent-browser and Browser Use also document CLI/library interfaces. They are not
all interchangeable MCP servers. The useful common pattern is selective observation
plus deterministic execution and visible recovery—not simply the fewest calls.

The [MCP tools specification](https://modelcontextprotocol.io/specification/latest/server/tools)
supports structured results and resource links. This bundle retains its single
JSON TextContent result for compatibility with the pinned Hermes consumer, rather
than sending duplicate content or assuming Hermes automatically follows links.
Our snapshot cursor is application-level pagination inside `pane_view`;
[standard MCP pagination](https://modelcontextprotocol.io/specification/latest/server/utilities/pagination)
defines list-operation cursors, not these tool arguments.
[Cancellation](https://modelcontextprotocol.io/specification/latest/basic/utilities/cancellation)
does not undo a submitted browser action: shared execution remains held until
uncancellable work settles. Partial outcomes and the replay ledger remain essential.

## Paired local evidence

Run `npm run bench:scoped -- 5`. The fixture launches one disposable Chromium,
one tab and a loopback MCP HTTP server. It never attaches to the operator's browser
or Pi. Both paths fill the same field and click the same button exactly once;
the DOM value, result text and click count are independently checked.

The synthetic page has 3,000 unrelated articles around a small form. One warmup
pair is excluded; five measured pairs alternate execution order. The baseline
reproduces the previous full observation, one full action preflight shared by
both targets, and full post-action observation. Both paths use the current input
engine. This is not an entire historical release benchmark.

| Median, macOS ARM64, Node 22.23.2, Chromium 146 | Previous capture pattern | Scoped path |
| --- | ---: | ---: |
| MCP workflow wall time | 346.55 ms | 61.94 ms |
| Renderer task time delta | 286.57 ms | 12.47 ms |
| MCP tool calls | 2 | 4 |
| Full-page captures | 3 | 0 |
| Visited capture nodes, summed | 45,055 | 25 |
| Raw snapshot bytes, summed | 1,206,143 | 860 |
| Model-facing result JSON bytes | 6,489 | 2,583 |

That is about **5.6× faster tool execution**, **96% lower renderer task time**, and
**60% fewer output bytes** on this fixture. Renderer task time is a Chromium
performance counter, not whole-machine CPU utilization. The scoped path omits
unrelated article content intentionally; this is equivalent task success, not
equivalent whole-page information. Raw bytes are not model tokens or network bytes.
There are no paid model calls, tokenizer estimates or Raspberry Pi speed claims.
The [checked-in synthetic report](benchmarks/scoped-mcp-local.json) contains all
ten measured trials. New runs write the ignored `test-results/scoped-mcp.json`.

Extra model turns and network round trips can offset the browser savings. Use
scoped discovery when a large page contains a small task-relevant region; reuse
the immutable state for local filtering and batch already-known inputs. Use
whole-page capture for a genuinely whole-page task. CI checks the business outcome
and capture counts, not a fragile machine-dependent timing threshold.

## Limits and next qualification

- Limits bound visited traversal nodes, not all accessible-name/layout work.
  A target may derive its name from a large subtree or an external label; the
  renderer may already be busy. This is not a constant-time capture guarantee.
- Depth/width limits can omit useful regions. Expand a returned ancestor, increase
  outline depth, or explicitly request a full view. Cached output pagination
  cannot discover nodes excluded by a capture limit. Nothing silently widens scope.
- Automatic observations after scoped actions are fresh page outlines, including
  after navigation. `observe:"full"` still means a self-contained response, not
  forced whole-page capture. Request a full `pane_view` explicitly when needed.
- Ordinary actions validate their targets, not every unrelated page element.
  Strict workflow comparisons retain whole-page capture and reject scoped guards.
  Human/page activity is not atomically locked by MCP views.
- A private Playwright extension adds maintenance cost. Installation verifies
  exact version and original hashes, patches four files reproducibly, and rejects
  drift. Upgrades require real frame/shadow/staleness and input qualification.
- No vendor code integration, new model/router, GPU semantic parser, arbitrary
  selector endpoint or autonomous retry is introduced. Site challenges still
  require human handling; pacing and safety policies are unchanged.

Next: qualify the same fixture on the Pi under an approved rollout window, then
measure a supervised real task including model latency and discovery success.
An adaptive policy should choose scoped versus full capture from those outcomes,
not from DOM size alone. Only then consider dependency-aware semantic caching or
native [CDP partial accessibility queries](https://chromedevtools.github.io/devtools-protocol/tot/Accessibility/).
Native AX has different ref/lifecycle semantics and may add tracking overhead;
it is an experiment to measure, not an assumed speed upgrade. Protected approval,
identity isolation and durable security auditing are separate enterprise work.
