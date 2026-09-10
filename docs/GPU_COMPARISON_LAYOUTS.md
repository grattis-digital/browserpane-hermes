# GPU comparison layout diagnostic

This is a finite, default-off diagnostic of the existing experimental
[GPU frame lease](GPU_FRAME_LEASE.md). It does not change the driver, production
capture path, browser flags or viewer protocol. No new browser tab is opened.

## Question

The initial 1280×720 comparison plus GPU wait was about 16.3 ms. That wall time
does not establish how much was actual comparison versus pending producer work,
driver submission or synchronisation. The reference shader is already parallel,
but uses only 240 workgroups at that size, with 64 lanes per group and up to 64
serial pixel comparisons per lane.

The diagnostic isolates completed comparison on the **same immutable pair** of
real X11-exported GPU textures. Programs and 64-byte output buffers are compiled/
allocated once and reused. A bounded fence wait drains producer/import work
before each case and is reported separately. Full CPU pixel oracles run only
after the complete case, never between competing variants. This is an intrusive
component measurement, not a proposed production fence-draining strategy.

## Variants

All variants produce the same exact 64×64 dirty-tile mask. No checksum collision,
lossy approximation, scroll estimate or omitted unchanged-looking region is
accepted.

| Variant | Difference from reference |
| --- | --- |
| `reference_cached` | Original shader, but cached program and buffer |
| `branchless64` | Same layout, accumulate differences without short-circuit reads |
| `reduce16` | More workgroups, four pixels per lane, shared reduction |
| `reduce8` | One pixel per lane, shared reduction |
| `pixel_atomic` | No shared reduction/barriers; each changed pixel sets the output bit |
| `probe_first64` | Distributed positive-only probes; a mismatch ends the whole tile |
| `probe_both64` | Also probe backward from the opposite clipped tile edge |

The per-pixel atomic variant is intentionally tested on fully changed frames:
many threads writing the same mask word can contend. More parallel lanes are
not automatically faster than fewer lanes with better memory access.

Early exits are safe only after a **positive** mismatch. If the probes agree,
the complete exact comparison still runs. A tile can be declared dirty after one
different pixel, but it cannot be declared unchanged after one matching pixel.
The probe decision is shared and immutable after its barrier; every lane exits
together, so no lane leaves peers waiting at a later barrier. The bidirectional
variant clips its reverse endpoint to the actual image boundary.

## Reproduction and evidence boundaries

Build `Dockerfile.gpu-dummy --target gpu-check`, then run the existing owned Pi
pilot with `--compare-lease` instead of `--lease`. Keep `gpu_compare_results.py`
beside `gpu-dummy-pilot.py` if transferring the runner without the repository.
The new container still has no network, host display, persistent volume or
production profile. The finite comparison process has a 45-second deadline;
resource/temperature checks and exact container cleanup remain in force.

The matrix covers 1280×720 and odd-edge 1365×767, each with unchanged, 24×24
changed, fully changed and last-single-pixel-changed frames. Every case runs
three warm-up rounds and ten measured rounds for each variant, rotating and
reversing variant order. Every output bit, including unused padding, must equal
the expected mask. The original and changed frame both receive full pixel oracles.
The parser rejects incomplete matrices, duplicated rounds, unexpected variants,
invalid timings and any failed pixel/mask check.

Timings include setup/reset, submission, and blocking metadata map/wait through
completion, with a total covering all three. The metadata payload is 64 bytes
for every variant. A tiny payload does not mean the wait is tiny: completion can
include queued GPU work and driver scheduling. These are not pure GPU cycle
measurements; see the [Khronos timing contract](https://registry.khronos.org/OpenGL/extensions/EXT/EXT_disjoint_timer_query.txt)
and the [V3D timestamp limitations](GPU_REGION_ANALYSIS.md#what-the-timer-means-on-this-driver).

Ten samples per case are exploratory, not a stable tail-latency estimate. Repeated
immutable textures deliberately remove live producer churn and do not qualify
fresh-frame/browser/viewer latency. Any candidate selected here still needs the
original fresh-frame, scroll, resize and lifecycle tests before replacing even
the experimental comparison baseline. No production promotion follows from this
diagnostic alone.

## First hardware observations

The seven-variant matrix passed on Pi 4 V3D: 560 measured comparisons plus 168
warm-ups, with every mask checked and full pixel oracles for all sixteen source/
destination snapshots. These are component tests, not browser FPS or viewer latency.
At 1280×720, median completed comparison times in the first run were:

| Frame contents | Reference cached | Positive probes | Bidirectional probes |
| --- | ---: | ---: | ---: |
| Unchanged | 16.26 ms | 13.43 ms | 14.10 ms |
| 24×24 change | 15.19 ms | 13.28 ms | 13.28 ms |
| Entire frame changed | 8.60 ms | 6.04 ms | 6.12 ms |
| Last pixel changed | 16.75 ms | 13.64 ms | 13.59 ms |

Smaller workgroups were slower here: `reduce8` took roughly 30–41 ms. The simple
per-pixel atomic implementation took roughly 21–31 ms. More workgroups alone did
not deliver the proposed 5 ms target. Whole-tile positive early exits helped,
especially for dense changes; checking both ends did not show a clear additional
benefit in this initial matrix. Unchanged and sparse frames still require proving
most pixels equal in this deliberately full-screen comparison workload.
The unchanged-case improvement cannot be attributed to an early exit: no mismatch
exists there. Shader-code generation and scheduling may differ between variants;
that causal attribution has not been established by this wall-time experiment.

The initial producer/import drain was 4.46 ms; subsequent case drains were
0.07–0.19 ms. The reference still took about 15–18 ms on mostly unchanged immutable
frames, so pending producer work does not explain away the original 16.3 ms.
Metadata wait still includes execution, submission/scheduling and synchronization;
this does not identify a pure GPU-cycle budget or prove memory bandwidth is the
only bottleneck.

A separate packed-`R32UI` image-load experiment was **rejected**, not promoted:
the import advertised RGBA8 and BY_SIZE format compatibility, but the exact mask
oracle detected spurious changed tiles for a 24×24 update. Its adapter/API/driver
cause is not established. No timing from that failed matrix counts as a valid
performance result. Its source, binary and failing report were retained privately;
the default diagnostic retains only the seven verified variants. This is also why
an apparently compatible import is insufficient without pixel-level qualification.

A second run of the same verified image reproduced the broad result at 1280×720:
reference versus positive-probe medians were 15.83 versus 13.64 ms (unchanged),
16.77 versus 12.84 ms (24×24 change), 8.84 versus 5.98 ms (fully changed), and
16.25 versus 13.15 ms (last pixel). Bidirectional probing was again not consistently
better. Across the two successful runs, all 1,120 measured masks and 336 warm-up
masks passed; all 32 source/destination frame pixel oracles passed as well.

Five milliseconds is therefore **not a validated general comparison budget**.
The next candidate is to skip comparison entirely for tiles whose trusted producer
damage state has not changed, with exact fallback when damage is broad or unknown.
That must be distinguished from falsely declaring a tile unchanged because a few
sample pixels matched. Scroll reuse/content indexing and viewer transaction
correctness remain separate requirements; a dirty mask alone does not solve them.

All temporary test containers were removed and pre-existing service identities
were unchanged, including after the rejected experiment. No shader was selected
as a new production/default capture backend. The existing original fresh-frame
lease probe remains unchanged apart from exposing its shader string for reuse.
