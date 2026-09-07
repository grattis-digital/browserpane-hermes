# Learn browser procedures with Hermes

This is the first workflow-learning milestone: opt-in recording, an unverified
skill scaffold, and an isolated business-outcome benchmark. It does not yet
execute stored recipes, approve actions, or provide unattended recovery.
The separate [P2 report-recipe pilot](WORKFLOW_REPLAY.md) now supplies explicit
review, guarded execution and read-only reconciliation for one narrow report
format. Recording never automatically invokes it. The six browser tool names and
rendering stack remain unchanged; the pilot adds optional `pane_flow.view` guarding.
An independent [Hermes-local executor](WORKFLOW_EXECUTION.md) now exposes reviewed
run IDs and warm execution; recording alone never enables or invokes it.

## Enable deliberately

The image ships the `browserpane-workflows` Hermes plugin as read-only application
code. It is **disabled by default**; no operator configuration is migrated.
After deliberately updating the Hermes image, enable the plugin in the existing
Hermes configuration and select its toolset for the desired channel. Merge these
entries with existing settings—do not replace the complete config or credentials:

```yaml
plugins:
  enabled: [browserpane-workflows] # retain other intentionally enabled plugins
platform_toolsets:
  cli: [terminal, file, skills, todo, memory, browserpane, workflow_learning]
```

The config is normally `/opt/data/config.yaml` in the Hermes container. Plugin
selection is also available through `hermes plugins enable browserpane-workflows`
and tool selection through `hermes tools`. Start a fresh Hermes CLI/chat after
changing configuration. Configure other gateway channels explicitly as needed.
No browser restart, extra port, host mount, model key, or Compose setting is needed.

Disabling the plugin stops its hooks/tools on the next process/session reload;
it does not delete already saved evidence. Finishing a capture stops recording
that run without disabling the plugin.

## Record one authorized task

Ask Hermes, for example:

> Load browserpane-workflows:author. Record the report export I requested,
> verify the downloaded report, and learn a parameterized skill from the result.
> Ask before any consequential submission. Do not save credentials or private data.

The plugin adds one **Hermes-local** tool, `workflow_capture`, not a seventh
BrowserPane MCP tool. Its operations are:

| Input | Result |
| --- | --- |
| `{"op":"start"}` | Start a ten-minute capture for this exact Hermes session/task; return a run ID. |
| `{"op":"status","run_id":"ID"}` | Counts, recording state, observed token buckets, and explicit accounting limitations. |
| `{"op":"finish","run_id":"ID"}` | Stop and return an unverified Markdown skill scaffold. Repeating finish is safe. |
| `{"op":"read","run_id":"ID","offset":0}` | At most sixteen redacted events; use `next_offset` when present. |
| `{"op":"forget","run_id":"ID"}` | Permanently delete one owned, non-recording capture, only when requested. No automatic deletion. |

`start` optionally accepts `ttl_minutes` from 1 to 30. A second active capture
for the same identity is rejected. `finish`, `status`, and `read` may omit the
run ID to select the latest capture for the current identity; `forget` requires
an exact ID and rejects an active recording. Deleted evidence is recoverable
only from a separate backup. A new session/task cannot use another one's IDs
through this tool; this is an accident guard, not tenant authentication.

Only the exact six `mcp__browserpane__pane_*` tools are recorded. Other MCP servers,
terminal/file tools, and legacy Playwright-mode tools are not captured. Learning
from a human's viewer actions is not implemented.

Finish even when the browser task fails. Hermes uses the built-in authoring skill,
current authorized conversation, and redacted evidence to fill in prerequisites,
typed parameters, semantic targets, verification and stop rules. It searches
existing skills first, then uses its existing `skill_manage`/`/learn` machinery.
The recorder never silently writes or approves a learned skill.

## What is retained, and what is not

Evidence is stored in the existing Hermes volume at
`/opt/data/plugin-data/browserpane-workflows/captures.sqlite3`. No store is created
by discovery/enabling alone. The plugin directory is read-only image content;
evidence is separate from it and from Hermes's internal state database.

Stored fields are a closed allowlist: browser tool/operation names, selected role
enums, unresolved input slots, numeric timings/counts, conservative outcome flags,
and numeric token buckets. IDs used for correlation are locally keyed hashes.
Page text, accessible names, URLs, field values, cookies, raw errors, screenshots,
raw model responses, credentials, and live browser references are not stored.
Because these details are omitted, the scaffold intentionally contains TODOs.
Hermes must resolve them from authorized context or ask, not invent them.

The store allows 32 captures, each with at most 128 events, and a 16 MiB SQLite
page limit at the default page size. Capture expires at its deadline; hitting
event capacity stops further recording and reports `capacity`. Hitting run capacity
rejects a new start until the operator forgets selected completed evidence.
There is no silent pruning. Read pages and the generated scaffold are bounded.
The evidence directory is mode `0700`, its database `0600`; filesystem backups
and the same container user remain trusted.

Observer hooks are best-effort. Lost hooks, a restart, disk-full conditions or
other storage failures can leave gaps. An observer failure cannot alter a browser
action's result; it emits a generic warning without raw payloads. A live controller
reports whether it saw such failures. This indicator is not a durable completeness
guarantee. Evidence persists across restart, but is never labeled verified success.

Token totals cover only observed API calls for this session/task during capture.
Input, output, cache-read, cache-write, and reasoning buckets are separate;
reasoning is not added again to an output total. Missing usage is flagged.
Before-start selection, after-finish learning/curation/summary, unobserved retries,
and unrelated/background tasks are outside this interval. Dollar cost is unknown,
not zero. Recording/drafting itself makes no model calls; Hermes learning can.

The plugin adds a small tool schema and guidance section only when enabled.
It is not a full cost optimizer until later deterministic execution is implemented.
Current conversational histories may already contain private material even though
this additional recorder minimizes content. Normal model-provider privacy rules
still apply.

## Local verification

```sh
python3 -m unittest discover -s hermes -p 'test_*.py' -v
npm test
npm run bench:workflow -- 3
docker build --tag browserpane-hermes-agent:workflow-learning ./hermes
python3 hermes/check-container.py --image browserpane-hermes-agent:workflow-learning
```

The browser benchmark needs the repository's installed pinned Chromium, as with
`bench:mcp`. It accepts 1–30 parameter samples, uses fresh owned browser/profile
resources and a loopback fixture, and saves reports under ignored `test-results/`.
Each parameter pair gets a fresh profile; both arms share that profile and their
order alternates. Startup/cleanup are excluded from the trial timing. This avoids
accumulated download/history state influencing later pairs. It is not a sustained
bulk-download test: an exploratory single-profile rapid loop intermittently stopped
producing download events after many exports, and the oracle correctly failed.
The cause of that endurance limit is not established by this milestone; no browser
download protections or production flags were changed to make the benchmark pass.
It measures scripted separate versus batched compact calls, including actual
export completion and an independent CSV/state oracle. Neither arm is an LLM or
learned-recipe benchmark. Four deliberately bad exports show a success banner and
complete the MCP action, but must fail business verification. Payload bytes are
not billed tokens; local hardware timings are not Raspberry Pi results.

Image checks exercise the actual pinned Hermes plugin discovery, dispatch,
observer hooks, skill loading and draft persistence on disposable homes, with no
model calls. Container qualification also checks restart, recreation, preserved
operator configuration and unchanged six-tool MCP discovery. CI definitions run
these deterministic checks without paid model calls.

The local 2026-09-07 qualification completed 30 paired parameter cases: all 60
valid exports passed and all four deliberately invalid exports were rejected.
Separate versus batched calls used four versus three MCP requests, with median
serialized MCP result sizes of 1,250 versus 1,113 bytes. Median trial times were
115.1 versus 116.5 ms on the local ARM64 Mac: this run demonstrated no latency
improvement. It establishes a verification baseline, not model-token savings or
Raspberry Pi performance. The local ARM64 Hermes image passed restart/recreation
qualification. Neither these results nor the edited CI definition establish a
remote green build or a production deployment.

See the [full analysis and next milestones](BPH_00007_WORKFLOW_LEARNING_PLAN.md)
for subsequent human takeover, protected approvals and optional workflow MCP APIs.
The separate supervised report runner is only a narrow first execution milestone;
it does not implement those broader management or authorization features.
