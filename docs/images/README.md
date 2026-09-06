# Real session screenshot

`shared-session.png` captures the actual BrowserPane viewer streaming a Chromium
desktop from a disposable ARM64 Linux container on a Mac. It is not an AI-generated
image, a composited mockup, or a screenshot of the production Raspberry Pi.

The synthetic page comes from `docs/demo/index.html`. The handoff field was filled
through the real Playwright MCP endpoint using `browser_run_code`. No model was
called and no provider output is represented. The viewer uses a 1440×920 viewport
and shows a 1280×720 capture at 1× density, including Chromium's own tabs/address bar.

Reproduce on a development machine with Docker and an isolated Chrome available:

```sh
docker build --tag browserpane-hermes:test .
BPANE_PIPELINE_IMAGE=browserpane-hermes:test \
  BPANE_PIPELINE_NAME=browserpane-pipeline-viewer BPANE_PIPELINE_VIEWER=1 \
  bash scripts/start-pipeline-probe.sh
node scripts/capture-demo.mjs
```

The launcher refuses an existing named container. The capture script verifies
its test label, test flag, lack of persistent mounts and loopback-only bindings.
It never attaches to an existing personal browser profile. Its demo server lives
only inside that disposable container; remove the exact test container after
inspection. Do not retarget either helper at a production session. The normal
automated viewer test launcher handles cleanup for its own tests.

The original project mark is documented separately in `assets/brand/README.md`.
