# Managed AdBlock installation fix

Focused follow-up to the bundle setup scope in
issue #1, requested by the user after qualifying the existing managed extension.

## Problem and use case

A fresh shared-browser profile should receive upstream AdBlock and EasyPrivacy
without a manual extension installation. The image already carries the correct
managed policy, but the Compose `/tmp` limit of 256 MiB prevents CRX unpacking.

## Scope

- Raise only the production browser's `/tmp` ceiling to 1 GiB, retaining the
  2300 MiB container memory cap and `nosuid,nodev` flags.
- Preserve the inherited extension policy, normal Store updates, persistent
  profile, sandbox, listeners and rendering/MCP implementation.
- Add deterministic policy/packaging/resource regression tests and operator
  documentation, including trust, first-install memory pressure and verification.
- No extension vendoring, unsafe debugging, production-host changes or private
  deployment records. No paid model calls or external extension downloads in
  unit tests. Smaller isolated capture/runtime fixtures are not installation
  qualification; actual Compose integration uses the production configuration.

## Verification

1. Reproduce a failing resource-contract test with the old 256 MiB setting.
2. Apply the 1 GiB setting; run policy/resource tests and the wrapper suite.
3. Validate rendered Compose: only the intended browser tmpfs size changes.
4. Reuse the already completed fresh-profile ARM64 Chromium152 / AdBlock6.45.4
   qualification: the old limit failed unpacking; 1 GiB installed successfully,
   with sampled temporary usage above 512 MiB. The normal loopback fixture script
   loaded while an advertising-pattern script was blocked before reaching its
   server. Live MCP reads remained healthy for 60 seconds with the same browser.
   This is version-specific synthetic evidence, not a bandwidth guarantee.
5. Review the public diff for secrets/operator records, commit and push to the
   existing branch. Hosted checks run through the existing bundle workflow.

Status: implementation and local verification complete. The new resource test
failed against the old setting, then all 197 wrapper tests passed with the fix.
Rendered Compose comparison proved that only the browser tmpfs ceiling changes.
Policy packaging/non-conflict checks pass. Hosted status belongs to the branch's
existing pull request; no live installation or paid-model test was added to CI.
