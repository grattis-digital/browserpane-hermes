# GPU-resident exact tile compaction experiment

Default-off, standalone, finite **component test**, not a production capture
backend. No Chromium build, tabs, X11 attachment, profile, listener or video
codec. The existing diagnostic interposer remains pass-through and unchanged.

The [region-analysis follow-up](../../docs/GPU_REGION_ANALYSIS.md) adds explicit
`--deduplicate` and diagnostic-only `--profile-stages` modes. Neither is enabled
by default. The pixel transport and cache representation below are unchanged.
The tested deduplication variant helps unchanged/sparse frames but regresses
scrolling, so it is retained only as an opt-in experiment, not a new default.

Three RGBA8 textures remain GPU-resident: current, preceding and retained
checkpoint. Each cache has a smaller content index: sampled row fingerprints
(115,200 bytes per 720p frame) plus a bounded hash lookup table (327,680 bytes),
versus 3,686,400 pixel bytes. The total index is 442,880 bytes, about 8.3× smaller
than RGBA. GPU lookup checks at most eight buckets in each historical index
per output tile instead of scanning up to 1,440 row positions. The CPU provides
**no correct scroll vector**. Matching is content-based, not based on wheel
events or one global displacement.

Row-index positions can differ by any integer vertical offset, not just a tile
multiple. This preserves match candidates through grid-crossing scroll. Sampled
fingerprints propose a cache location; they do not certify equality. An ES 3.1
compute dispatch verifies every pixel against stationary history and the
proposed cached region. Per-tile OR reduction produces stationary reuse,
verified cached reuse or dirty pixels. Dirty workgroups gather into bounded
linear SSBO slots in that **same verification dispatch**. Only metadata and the
occupied payload prefix are read by the CPU. Fingerprint creation, lookup and
verification are GPU-ordered passes with no intervening CPU readback.

Hash insertion has eight bounded atomic probes and a GPU-only clear pass. A full
bucket cluster loses a match candidate and falls back to replacement; it never
accepts an unchecked match or spins waiting for another workgroup. The exact
verifier also protects against sampled-fingerprint collisions. No CPU upload
of zero-filled tables or full framebuffer is needed to build the index.

Read-only access uses a size-compatible R32UI view of immutable RGBA8 storage,
checked at initialization, to compare packed words without float conversion or
repacking. There is no extra texture copy to make this view. The qualified
variant uses 256 invocations per 32×32 tile, with four pixels per invocation.
Dirty pixels are loaded again after classification rather than retaining them
across barriers. This deliberately trades a second GPU read of dirty pixels for
lower temporary-storage pressure on reused regions. No unsynchronized mapping,
precision-reduction driver flag or skipped correctness check is used.

The Rust oracle rejects malformed counts, duplicate/missing slots, missing
history, unknown cache banks and out-of-bounds moves; reuse reads immutable
history/checkpoint data rather than overwriting its own sources.
GPU-generated fixtures include idle, boundary-crossing sparse updates, scroll
with a fixed header, dense changes, a last-pixel change, deliberately wrong
scroll candidates, a stationary overlay, a separately moving/color-changing
widget during scrolling and return to retained cached content. An adversarial
fixture changes only unsampled pixels while making every row fingerprint
collide and overflowing the bounded index. It must still replace changed tiles.
Each frame is reconstructed and compared with an independent CPU fixture **and**
a full GPU readback, outside optimized timing. Fresh odd-sized and normal
contexts exercise partial tiles and history invalidation.

## Measurement contract

- Baseline: synchronous full `glReadPixels` from the same ready texture.
- Candidate: current-index construction, content lookup, exact comparisons,
  reduction, compaction, synchronization,
  metadata and compact-payload copy to CPU; monotonic wall and thread CPU times.
- Producer `glFinish` before BOTH strategies excludes rendering and its wait.
- Initial history/index construction occurs before the scenario. Indexing each
  newly produced frame is included in the measured compact operation.
- Paired order alternates. Eight warmup frames precede 24 measured frames per
  scene at 1280×720. All raw samples retained; no filtered outliers.
- Partial tiles are zero-padded. Payload byte counts include that padding plus
  metadata. They are **readback bytes, not network bytes or measured DRAM traffic**.
- The oracle, fixture creation and JSON output are outside timing. They influence
  cache/host state; this is not an isolated steady-state application benchmark.
- Software llvmpipe validates correctness only. Hardware mode requires V3D,
  an explicit `BPANE_GPU_COMPACT_PILOT=1`, and `/dev/bpane-render`.
- The pilot's optional `--shader-stats` is a separate diagnostic run, not part
  of clean timing or normal tests. Compile statistics are not GPU durations.
- `--profile-stages` uses availability/disjoint-checked elapsed queries around
  four stages. Collection adds a diagnostic-only final wait after capture;
  there is no per-stage CPU readback. V3D's CPU-queue timestamp implementation
  measures driver-scheduled intervals, not pure GPU cycles. This mode cannot be
  pooled with clean runs or combined with `--shader-stats` in the pilot.

At the content-index checkpoint, two Pi runs passed all 720 reconstructed frames.
Scrolling readback fell
from 3.686 MB to approximately 0.503 MB, but component median latency was
22.9–24.7 ms versus 14.0–14.6 ms for full readback. The content-reuse experiment
passes correctness/readback reduction, **not the latency gate**. It is not ready
for production integration. See the [checkpoint results](../../docs/GPU_CAPTURE_RESEARCH.md)
and the separate [region-analysis results](../../docs/GPU_REGION_ANALYSIS.md).

The C adapter only owns EGL/GBM/GL resources; Rust owns geometry, bounded output
storage, orchestration and verification. No third-party Rust dependencies. Linux
little-endian ARM64 is the qualified target; software tests use the same target.
No shared mutable frame is exported or borrowed from another process.

Build locally on ARM64 with Docker, exporting the artifacts target; the build
runs Rust tests/Clippy/rustdoc and the software GPU oracle. Run hardware only in
a fresh labelled non-root, read-only, network-disabled container with the V3D
render node, bounded memory/time and no production mounts. Never grant KMS/master
or privileged access for this component test. The pilot exposes DRM node names
read-only for Mesa enumeration; the device cgroup permits only the V3D render
device, not physical display nodes. The removed software-mirror display image lacks
libepoxy; use the experimental GPU-check runtime with EGL/GLES/epoxy installed.

## Deliberately not claimed

Lookup currently searches **vertical offsets within each 32-pixel column**;
horizontal/rotated/scaled matching, a general GPU atlas/LRU eviction policy and
cross-session cache identities are not implemented. There is exactly one
retained checkpoint plus the previous frame, reset per scenario. This is an
initial content-index experiment, not an unbounded historical cache.

Not arbitrary damage-hint validation, DMA-BUF producer fencing/lease
qualification, multi-buffer compositor history, video encoding or an end-to-end
browser speedup. A software-mirror display
must still be bypassed by a coherent GPU-backed display/capture integration.
Broad producer damage can be narrowed without guessing here, but a full GPU
comparison still reads the input textures. Dense changes may make full readback
cheaper. Results determine whether this experiment deserves integration. See
[research and results](../../docs/GPU_CAPTURE_RESEARCH.md).
