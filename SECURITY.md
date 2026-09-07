# Security policy

This is a trusted-host/LAN, single-browser bundle, not an Internet-facing or
multi-tenant service. Read [deployment boundaries and configuration](docs/SECURITY.md)
before granting another device access. The shared browser profile contains
credentials; anyone admitted to the viewer or MCP can operate that session.
Compact MCP's leases, observation references, replay protection and file-path
checks are accident guards, not user authentication or a hostile-tenant sandbox.
Website text and tool results are untrusted data; never treat them as authority
to disclose secrets, change instructions or bypass site access restrictions.
The inherited, automatically updated AdBlock extension is also trusted browser
code, not a substitute for sandboxing or access control; see its
[trust and resource boundary](docs/SECURITY.md#managed-extension-and-temporary-storage).
The optional GPU configuration grants narrowly mapped driver access and a shared
private X11/IPC boundary; see [GPU access](docs/SECURITY.md#optional-gpu-access).

The optional [workflow-learning recorder](docs/WORKFLOW_LEARNING.md) retains
bounded, content-minimized evidence in the sensitive Hermes volume. Its hooks
are best-effort and its drafts are unverified; it is not an execution audit,
authorization boundary or unattended workflow engine.
The separate [report-recipe pilot](docs/WORKFLOW_REPLAY.md) journals intent and
refuses blind replay, but its local review acknowledgement is not protected from
the same agent identity. It is for supervised downloads, without a browser
reservation or a claim of exactly-once website effects.
Its opt-in [Hermes execution tool](docs/WORKFLOW_EXECUTION.md) uses a private
catalog containing reviewed URLs and input values. Treat that volume as sensitive.
Cancellation is cooperative, not rollback; IDs and local file permissions are
not authorization between sessions sharing the Hermes identity.
Read-only status does not mutate the journal; typed storage errors never authorize
replay. Workflow failure logs exclude raw exception messages and browser inputs.
Optional [per-contract pacing](docs/WORKFLOW_PACING.md) stores private origin
digests, timestamps and budgets beside the journal. It adds no listener or access
right, and is not global enforcement against the same agent identity or raw MCP.
Preserve this ledger with journal/catalog backups; a deferred run never auto-retries.

The optional [hardware pilot harness](scripts/workflow-pilot/README.md) requires
explicit operator authority and uses fresh labelled resources only. Its test-only
shared network namespace and fixed-fixture approval are not production security
boundaries. Keep raw hardware reports private; it does not change operator firewall
policy or enable execution in an existing agent.

For a suspected vulnerability, use GitHub's
[private vulnerability report](https://github.com/grattis-digital/browserpane-hermes/security/advisories/new).
Private reporting is enabled on this repository. If that option is absent in a fork,
open an issue requesting a private contact method without publishing exploit
details, credentials, browsing data or personal identifiers. No public security
email or response-time guarantee is currently advertised.

Include affected versions, a minimal synthetic reproduction and the impact you
observed. Do not attach `.env` files, profiles, keys, raw agent histories or
private deployment diagnostics. Report defects in this fork here; do not assume
upstream BrowserPane or Hermes maintains this specialization.

Security fixes are developed against the current maintained bundle branch;
historical/private deployment tags are not a supported update channel.
