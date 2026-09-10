# Supervised report-export recipes

The P2 pilot turns one reviewed, data-only recipe into a deterministic export.
It is deliberately not a general workflow language, unattended agent, or workflow
MCP service. The Python runner uses the MCP SDK already in the Hermes image;
BrowserPane still uses its existing Playwright input and shared Chromium tab.
No inference, CDP connection, second browser, service, port or model credential is
added by the runner. Hermes selection/learning/repair can still use model tokens.
The independently opted-in [Hermes execution tool](WORKFLOW_EXECUTION.md) now
wraps this same runner with a private reviewed catalog, durable cancellation and
one warm SDK connection. The cold CLI remains supported.

## Supported contract

The sole verifier, `report-csv-v1`, accepts an explicitly known period and exact
rows of a small CSV: `period,code,quantity`. Codes must be `ITEM-` plus four digits;
quantities are nonnegative integers. This is a narrow pilot report format, not a
generic CSV/financial verifier. A real application's different schema needs its
own reviewed verifier and fixtures; do not weaken checks to make it pass.

Example **synthetic** recipe (replace with reviewed application values privately):

```json
{
  "schema": 1,
  "id": "report-export",
  "version": 1,
  "url": "https://reports.example.test/monthly",
  "marker": {"role": "heading", "name": "Reports — Example account"},
  "periodTarget": {"role": "textbox", "name": "Reporting period"},
  "exportTarget": {"role": "link", "name": "Export report"},
  "readyText": "Report exported",
  "verifier": "report-csv-v1"
}
```

Bindings are a separate private JSON file:

```json
{"period":"2026-06","rows":[{"code":"ITEM-0001","quantity":6}]}
```

There are no executable expressions, CSS selectors, JavaScript, arbitrary steps,
credentials, live references or caller-supplied success flags. The marker must
uniquely identify the intended page/account in visible accessibility state; it is
an accident check, not proof of server-side identity. A download-labelled link can
still cause server effects: review its actual behavior. Do not use this pilot for
purchases, messages, payments, account changes or other consequential submissions.

## Review, then run once

After a separately approved image update, `bpane-workflow` is available inside
Hermes. It needs the browser image containing optional `pane_flow.view` support;
old/legacy servers fail the capability check. Nothing auto-enables the runner or
migrates operator configuration. The learning plugin is not required to run it.

Save the two reviewed JSON files privately under the existing Hermes volume,
for example `/opt/data/report-recipe.json` and `/opt/data/report-bindings.json`.
Use regular files, not symlinks. Keep credentials and personal examples out of Git.
The downloads directory must already exist, use a canonical absolute path and
contain only intentional completed transfer files. Diagnostics stay elsewhere.

Run the following in an operator shell inside the Hermes container. The shell
function only abbreviates identical arguments; it does not approve anything:

```sh
workflow() {
  bpane-workflow "$@" \
    --recipe /opt/data/report-recipe.json \
    --bindings /opt/data/report-bindings.json \
    --endpoint http://browserpane:8931/mcp \
    --downloads /shared/downloads \
    --store /opt/data/workflow-runs
}
workflow review
```

The default is unpaced. To opt in, add `--pacing /opt/data/report-pacing.json` to
the function for all operations, then review the newly bound policy and digest.
See [policy configuration, bounds and recovery](WORKFLOW_PACING.md). Standard
tests and benchmarks explicitly use `--pacing off`; there is no ambient override.

Inspect the complete recipe, parameters, endpoint, directory, effect and digest.
The review command neither creates state nor connects to the browser. Only after
review, explicitly acknowledge the exact digest:

```sh
workflow approve --digest REVIEWED_DIGEST
workflow run --run-id RETURNED_RUN_ID
workflow status --run-id RETURNED_RUN_ID
```

Approval expires after ten minutes if not started. The fingerprint binds recipe
version/content, inputs, verifier contract version, MCP endpoint, artifact
directory and optional pacing policy. Changing any requires fresh review. One approval identifies one run;
repeating `run` returns its durable status, never executes it again. Each new
period/execution currently needs a new review acknowledgement. This intentionally
does not grant recurring or unattended authority.

Leave the shared default tab at `about:blank` or the exact recipe URL, signed in
as needed, and do not interact during execution. Another page yields
`SHARED_TAB_BUSY`; the runner will not create/switch tabs or commandeer that page.
It navigates the existing tab, checks the unique page marker, commits export
intent, then sends one two-input guarded `pane_flow` (fill + click).

Success requires one new completed download record correlated with one new file,
an exact CSV schema/period/row/value match, and stable file identity/content.
A banner, completed MCP action, plausible filename, old file, or model assertion
does not suffice. Only numeric counts, hashes and status are returned by default.

## Interruption and reconciliation

The SQLite journal uses durable intent-before-dispatch checkpoints and a single
POSIX worker lock. A process crash releases the OS lock but leaves unfinished
intent blocking another execution. Locks are never stolen based on a timeout.
These protections apply to runners using this same store on one host, not other
Hermes tools, a different store, another machine or the viewer.

```sh
workflow reconcile --run-id RETURNED_RUN_ID
```

Reconciliation is **read-only**: no navigation, fill, click or input replay. It
either verifies the surviving artifact/download evidence, closes an interruption
known to precede export, or leaves the run uncertain. Browser restart can erase
download correlation; an artifact alone will not be promoted to success.
Cancellation/timeout can leave an already dispatched browser action settling.
There is no exactly-once transaction spanning SQLite, MCP and the website.

If evidence cannot resolve a run, inspect the browser and any effects, wait for
pending work to settle, and decide manually. Only an explicit operator decision
should close an unresolved run:

```sh
workflow abandon --run-id RETURNED_RUN_ID --digest REVIEWED_DIGEST
```

`abandon` records **unverified closure**, not rollback or success. It neither
deletes the journal nor retries the task; a fresh reviewed run is a separate
decision. Never automate abandonment/new approval as an error handler.

## Persistence, limits and trust

State lives at the explicitly supplied store, normally
`/opt/data/workflow-runs/journal.sqlite3`, separate from Hermes's internal database
and the learning recorder. The parent directory must exist; the runner creates
only its private `0700` child directory and `0600` files. SQLite schema version 1,
FULL synchronous commits, secure deletion and a 16 MiB default-page-size ceiling
are used. Unknown schema versions fail; there is no silent downgrade/reset.
The journal holds at most 32 approvals/runs with bounded evidence and no automatic
pruning. Back up with all writers stopped. At capacity, archive deliberately;
starting a new store loses cross-store duplicate protection. Do not rotate stores
automatically or restore older checkpoints over pending work.

Artifact enumeration stops at 256 entries, each report is at most 32 KiB, and
contracts at most 64 KiB. Unsafe paths, changed files, unrelated new downloads,
disk errors and ambiguous outputs fail closed. The journal keeps fingerprints,
file identity/count metadata and the final artifact digest—not raw CSV, URL,
target labels, parameters, screenshots or ephemeral browser handles. Fingerprints
of guessable data are **not anonymization**; treat the journal, bindings, downloads
and backups as sensitive. `review` deliberately displays the private bindings.

Review acknowledgements are **not a protected authorization system**. Hermes and
the operator share a writable identity; an agent with terminal/file access can
invoke approval or change these files. This pilot must not be represented as
enforced separation of duties. Human takeover/reservation, protected grants,
cross-client fencing, general workflow MCP lifecycle and automatic repair remain
later milestones. Website content cannot supply approval, policy or repair code.

The optional initial view guard compares the full raw accessibility snapshot,
even when its returned projection was filtered. It checks again during first-stage
preflight. Dynamic content may cause conservative stops. It is not an atomic lock
against every subsequent human/website change; use supervised download tasks only.

## Tests and measurements

```sh
python3 -m unittest discover -s hermes -p 'test_*.py' -v
npm test
npm run test:mcp
# In a fresh Python >=3.11 virtualenv, install the isolated test requirements:
python -m pip install -r hermes/workflow-test-requirements.txt
export BPANE_WORKFLOW_PYTHON=/absolute/path/to/that/venv/bin/python
npm run test:replay
npm run bench:replay -- 30
```

The test interpreter needs the pinned SDK; production uses Hermes's unchanged
`uv.lock`. The browser fixture uses installed pinned Chromium, real HTTP MCP and
the actual Python CLI, but only fresh owned profiles and synthetic data. It
auto-acknowledges **only fixture** contracts. It never accesses operator profiles
or makes paid calls. Image verification separately exercises the production SDK
and journal against a loopback fake browser, not Chromium.

The paired benchmark reports baseline browser time, recipe time including SDK
connection/discovery, cold CLI wall time, review time, MCP call count and serialized
result bytes. It alternates order on fresh per-pair profiles and verifies actual
artifacts independently. It is not an agent/model comparison or a sustained
bulk-download qualification. There is no claim of billed-token reduction, latency
speedup or Raspberry Pi results without those measurements. See also the
[original learning baseline and endurance limitation](WORKFLOW_LEARNING.md).

Local qualification (ARM64 Mac, 30 parameter pairs): all 30 recipe
exports and all 30 baseline exports passed independent business verification.
Median baseline time was 103.9 ms; recipe MCP work was 86.6 ms, but recipe execution
including SDK connection/discovery was 399.5 ms and cold CLI wall time 508.0 ms
(p95 648.9 ms). Fixture review/acknowledgement was separately 128.3 ms median.
The baseline used four MCP calls/1,250 result bytes median; the guarded recipe
used five/1,659. This is **not a raw latency or protocol-size improvement** over
an already scripted baseline. Its benefit is executing a reviewed procedure
without intermediate model decisions; an actual agent cost comparison remains
unmeasured. The subsequent [warm-service comparison](WORKFLOW_EXECUTION.md#qualification-and-measured-benefit)
measures that startup overhead against this same Python CLI, not the four-call
JavaScript baseline. It requires separate explicit opt-in. The 14-case browser safety matrix covers false outputs,
changed/ambiguous targets, account/route mismatch, layout changes, process death
and browser restart, with no duplicate exports in these fixtures.
