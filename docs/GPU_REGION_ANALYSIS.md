# GPU region-analysis follow-up

This is a default-off component
experiment; no production capture, browser, Compose or remote repository change.
The [checkpoint results](GPU_CAPTURE_RESEARCH.md) remain the previous baseline.

## First bounded increment

Before changing the tile representation, determine which work deserves that
complexity and remove a provably redundant comparison:

- `--deduplicate` avoids loading/comparing the same previous-frame pixel twice
  when the lookup candidate is exactly the stationary source (bank zero, delta
  zero). Both comparison bits remain exact. Other candidates and invalid history
  retain the complete verification. Format, cache history and readback geometry
  are unchanged. The option is off by default for controlled comparison and
  selects a compile-time shader variant, not a per-pixel mode uniform.
- `--profile-stages` measures four driver-query intervals: index clear,
  fingerprint construction, content lookup, and exact verification/gathering.
  No application-side readback or CPU decision is inserted between these stages.
  Query collection takes place after the complete capture, with a diagnostic-only
  final wait outside recorded capture spans. Unsupported, unavailable, zero,
  oversized or disjoint results invalidate the diagnostic instead of appearing
  as successful zero-time stages. No polling loop is used.
- The same binary can run the control and candidate. Mode flags are included in
  every frame and checked against the harness request. Diagnostic output cannot
  be silently summarized as a clean run. Shader statistics and query diagnostics
  cannot be requested together in the pilot.

## What the timer means on this driver

The [Khronos query contract](https://registry.khronos.org/OpenGL/extensions/EXT/EXT_disjoint_timer_query.txt)
requires availability/disjoint checks; a CPU timestamp around asynchronous GL
submission is not equivalent to completed GPU work. Profiling is explicitly
separate from clean performance qualification.

In Mesa 25.0.7, V3D enables timestamp/elapsed queries only with CPU-queue and
multisync support. Its query implementation submits timestamp operations as
`DRM_V3D_EXT_ID_CPU_TIMESTAMP_QUERY` CPU jobs ordered with rendering work.
The timestamps use the CPU clock. These are **driver-scheduled completion
intervals, not pure GPU shader durations or hardware cycle counts**. They can
include scheduling and synchronization effects and perturb batching. Do not
subtract them from clean wall times as if they were exact stage attribution.
Sources: [V3D capabilities](https://gitlab.freedesktop.org/mesa/mesa/-/blob/mesa-25.0.7/src/gallium/drivers/v3d/v3d_screen.c),
[V3D query implementation](https://gitlab.freedesktop.org/mesa/mesa/-/blob/mesa-25.0.7/src/gallium/drivers/v3d/v3d_query.c).

## Pi stage diagnostic

A separate V3D 4.2.14.0 / Mesa 25.0.7 run of the initial runtime-switch variant
advertised 64-bit elapsed queries and
passed all 360 pixel oracles. At 1280×720, the driver-query medians over 24
post-warmup frames were:

| Stage | Unchanged frame, ms | Scrolling with fixed header, ms |
| --- | ---: | ---: |
| Hash-index clear | 1.081 | 1.106 |
| Fingerprint construction | 3.740 | 3.760 |
| Content lookup | 0.410 | 0.428 |
| Exact verification / gather | 16.709 | 19.442 |

This identifies verification/gathering as the largest **instrumented interval**,
not as 19.4 ms of independently measured GPU execution. Query instrumentation
adds CPU-queue jobs, and the timings must not be applied directly to clean runs.
No unsupported timer, disjoint result or pixel error was accepted. The temporary
container was removed; original service identity/start/restart records matched.

### Rejected runtime-switch implementation

The first implementation selected deduplication with a runtime shader uniform.
Four clean runs in control/candidate/candidate/control order passed all 1,440
pixel oracles. Within that binary, idle medians improved from 23.06–23.19 ms to
20.35–20.48 ms and scrolling from 26.70–26.72 ms to 25.50–25.80 ms. However,
the control itself was slower than the prior checkpoint's 21.13–21.77 ms idle
and 22.91–24.65 ms scrolling. That older comparison was not a contemporaneous
paired experiment, so shader cost versus host drift was not fully separated.
It still prevents claiming a net improvement over the checkpoint.

The runtime-switch source/binary/reports are retained privately and excluded
from the final variant's measurements. The revised implementation selects the
shader at compilation, preserving the original control's verification code
without an added per-pixel mode branch. No correctness check was weakened.

## Compile-time variant: clean ABBA comparison

Four further runs used one binary/image in control/candidate/candidate/control
order, with no timer queries or shader statistics. All **1,440 reconstructed
frames** passed. Each scenario has 24 post-warmup measured frames per run at
1280×720, plus the separate odd-geometry correctness workload. Ranges below
span two run statistics, not confidence intervals; no outliers were discarded.

| Scenario | Control median, ms | Deduplicated median, ms | Control p95, ms | Deduplicated p95, ms |
| --- | ---: | ---: | ---: | ---: |
| Unchanged | 21.05–21.41 | 18.94–19.26 | 22.98–23.24 | 22.04–22.55 |
| Sparse boundary-crossing update | 21.25–21.56 | 18.39–19.09 | 23.62–25.84 | 21.30–22.90 |
| Scrolling with fixed header | 22.84–23.71 | 25.23–25.42 | 25.47–26.00 | 27.27–27.73 |
| Genuine full-frame change | 32.12–32.70 | 31.32–31.70 | 36.60–38.61 | 33.75–48.01 |
| Last-pixel change | 21.01–21.15 | 18.72–19.29 | 23.67–24.09 | 21.63–22.14 |
| Deliberately wrong candidate | 32.69–32.81 | 35.54–35.66 | 36.94–38.50 | 39.42–40.97 |
| Scrolling with stationary overlay | 22.72–23.10 | 25.03–25.77 | 25.84–26.31 | 27.56–29.47 |
| Alternating forward / cached return | 24.73–26.28 | 27.13–27.27 | 32.07–33.20 | 31.46–34.17 |
| Scrolling with moving/changing widget | 23.81–24.51 | 25.10–25.40 | 26.98–28.08 | 27.14–27.40 |
| Colliding fingerprints / unsampled changes | 31.45–31.53 | 34.73–34.83 | 35.93–36.29 | 38.11–42.01 |

The control's GLSL tokens match the content-index checkpoint after preprocessing;
its clean times are again in the checkpoint's range. Comparing the two adjacent
control/candidate pairs, unchanged frames improve approximately 10%, and sparse
updates 11.5–13.5%. Scrolling **regresses by approximately 6–11%**, with worse p95
in both pairs. This is not accepted as a global optimization. The candidate stays
opt-in and the default shader keeps the checkpoint behavior.

Median readback bytes are unchanged in all ten scenarios, including 502,564
bytes for scrolling and 551,716 for the moving widget. This change targets
verification work, not a new wire format or finer tile representation. Both
paths still lose the component latency comparison against full ready-texture
readback; neither is a deployed browser capture backend or end-to-end speedup.

These measurements show that eliminating texture reads is not enough: the
candidate's additional control flow has a workload-dependent cost. They do not
identify instruction scheduling/register pressure as the sole cause. A next
experiment should classify/specialize work at tile level, keeping the existing
moving-tile verifier intact, before attempting hierarchical mixed-tile
subdivision. If GPU-generated work lists/indirect dispatch are considered, first
verify V3D's implementation and ensure it does not add an application-side CPU
round trip. No such work-list or hierarchical protocol change is implemented.

## Qualification and cleanup

- Final local ARM64 build: five Rust tests, strict Clippy/rustdoc/format checks,
  and 480 software-GPU oracle frames across control, candidate and profiling.
- Four harness-parser tests reject mode mixing and invalid query metrics. The
  existing Node suite (339 tests) and render-pilot Python suite (32 tests) pass.
- The two hardware variants and separate diagnostic total nine finite runs /
  3,240 pixel-oracle frames. Earlier runtime-switch measurements are retained
  separately, not pooled with the final compile-time variant.
- Final clean runs sampled 3.3+ GiB available memory and approximately 53–55°C.
  Live services remained active, so host-load variation remains a limitation.
- Every owned pilot container was removed. Original service identities, start
  times and restart counters matched; no browser tabs, X11 connections, firewall
  rules, production mounts or service replacements were introduced. Raw reports,
  binaries and the rejected source archive remain private.
- The custom Chromium builder remains stopped. No push or production rollout.

## Acceptance and next decision

The independent CPU/full-readback oracle must still match every output pixel,
including wrong candidates, independently moving/color-changing widgets,
checkpoint returns and fingerprint collisions. Compare clean control/candidate
runs in both run orders, with the same ready-texture boundary, binary, geometry,
sample counts and bounded resource policy. Retain failures and raw outliers.
Query runs are diagnostic only. Software GPU results qualify correctness, not
Raspberry Pi performance. The pilot never opens an X11 connection or browser tab.

Use the evidence to decide whether hierarchical mixed-region subdivision or
index construction is the next target. Do not add an unbounded 2-D atlas, change
the live protocol, or weaken exact verification to produce a favorable number.
