# Security policy

This is a trusted-host/LAN, single-browser bundle, not an Internet-facing or
multi-tenant service. Read [deployment boundaries and configuration](docs/SECURITY.md)
before granting another device access. The shared browser profile contains
credentials; anyone admitted to the viewer or MCP can operate that session.

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
