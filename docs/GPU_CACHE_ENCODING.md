# GPU-resident cache, classification and lossless wire encoding

Status: experimental. The isolated `--tail` oracle and the opt-in live GPU
worker share the cache/encoding implementation. See [live integration](GPU_LIVE_TEST.md).
This connects the GPU image lease to **final existing-protocol bytes**, rather
than stopping at a damage mask or raw-tile readback. Browser integration and
application-level acknowledgement/recovery remain separate qualification gates.

## Data path and flat-color shortcut

```text
Immutable GPU image leases + last acknowledged frame
    → GPU cache index / distributed motion candidates
    → exact damage + flat-color classification
        unchanged → no tile command
        flat      → Fill(color), no hashing or image compression
        textured  → fingerprint + exact acknowledged-cache lookup
                      hit → CacheHit(token)
                      miss → parallel lossless QOI
    → GPU byte-length prefix scan → framed byte packing
    → one completion fence → final encoded span → transport
```

For a 64×64 tile, 256 shader invocations each inspect up to sixteen pixels.
Each invocation accumulates whether any pixel differs from the tile's first
RGB color; a shared-memory OR reduction determines whether the entire tile is
flat. This is the same exact flatness predicate as `min == max`, without needing
two extrema. There is no tolerance or sampling in the final flatness/damage test.
Root alpha is intentionally opaque (255), matching the display contract.

A damaged flat tile emits an existing Fill message: **14 framed bytes** instead
of a 16,384-byte raw tile. A single-tile batch also needs the 10-byte BatchEnd.
One differing RGB bit anywhere, including the last pixel of a partial edge tile,
rejects Fill. Unchanged flat tiles emit nothing. This classification precedes
hashing, cache candidate verification and QOI, all on the GPU.

The seven shader dispatches stay in one command buffer. Producer sync-file waits
and foreign image acquire/release are part of that same submission. There is no
intermediate fence wait, CPU damage list, CPU hash computation, raw tile readback,
CPU encoder, or CPU packet repacking. Dispatch dimensions are fixed from geometry;
GPU-side guards skip unused work. This avoids the pinned V3DV indirect-dispatch
CPU-job path described in the [previous experiment](../native/vulkan-lease/README.md).

## Cache ownership and recovery

- Two existing immutable frame leases: last ACK plus pending. At most one
  pending packet; output storage cannot be reused before ACK or rejection.
- Two GPU metadata banks, a 256-bucket/four-way lookup, and a 512-tile bound.
  Cache pixels are retained frame leases, not another full-frame CPU/GPU copy.
- Fingerprints only filter candidates. Every candidate hit receives exact RGB
  verification. Bucket overflow means a safe miss, not a dropped tile.
- The existing opaque 64-bit cache key carries a unique frame-serial/tile token.
  A token is referenceable only after receiver acceptance. The serial cannot wrap;
  a new encoder/connection requires a cache epoch reset in the live adapter.
- Unchanged tiles inherit ACK metadata. Uniform tiles and framebuffer-only scroll
  reuse are not falsely advertised as receiver QOI-cache entries.
- Wrong/duplicate ACKs cannot advance state. Dropping an unsent packet retains
  the old ACK image and metadata; subsequent output is based on that old image.
- A cache miss rejects the complete test-peer transaction. The sender invalidates
  its cache and sends a full refresh. Resize/reconnect likewise invalidates state.
  This transactional peer is a test oracle; the live `GpuBegin`/`GpuAck` bridge
  couples reliable delivery, complete application, cache invalidation and lease
  release. Both sides must be deployed together.

The bounded motion search tests vertical source displacements −64…+64 using
256 deterministic jittered points per candidate, distributed across workgroups.
This avoids periodic sampling-grid aliasing. It is only a prediction: every
reused destination pixel is checked exactly. One full-region ScrollCopy plus
residual tiles repairs fixed headers, independently moving overlays and uncovered
edges. Repetitive textures can admit more than one useful displacement; the
pixel oracle, not an assumed physical scroll offset, determines correctness.
Horizontal/large/ambiguous movements fall back to exact tile updates. This is
not unrestricted object tracking or a persistent multi-frame GPU atlas.

Displacement and encoding grids are independent: **there is no 16-pixel scroll
tick or tile-alignment requirement**. Confidence requires at least 192/256 sample
matches and 24 more matches than zero displacement; this only selects a proposal.
Exact pixel comparison then conservatively reduces residual damage to affected
64×64 encoding tiles. Therefore a newly exposed 13-pixel strip can still require
whole boundary tiles on the wire. True rectangle-only residual encoding needs
negotiated placement/cache semantics in the live protocol adapter; it is not
implemented by pretending an ordinary tile message can address an arbitrary
interior rectangle. Predicted scroll plus complete repair must apply as one
ordered batch, before presentation, in the paired live integration.

## QOI and byte ownership

The GPU emits standard [QOI](https://qoiformat.org/qoi-specification.pdf) using
RGB, DIFF, LUMA and RUN; no cross-lane INDEX state. Each invocation encodes a
16-pixel segment with the correct preceding pixel. Shared prefix scans place
variable-length segments; split runs are legal. Edge tiles keep their real size.
High-entropy tiles may expand; no universal compression ratio is promised.

GPU byte-length scans place complete BrowserPane channel/length/command frames.
Boundary words are cleared and atomically merged; interior words are overwritten
once. There is no full-capacity output clear or host repack. The final 64-byte
private header supplies length/counters; it is not transmitted as browser data.
Only the occupied framed byte span is passed to the transport consumer.

Metadata is about 31 KiB; encoded scratch reserves about 8 MiB and final output
9 MiB. Both scratch capacities are fixed and reused. Intermediate allocations
are never mapped, even on UMA. The inherited comparison harness also reserves
its own legacy buffers; this is not a production memory-footprint measurement.

The socket-pair test passes the final mapped span directly to `send()`. Kernel
socket copies still exist: this is **not GPUDirect networking or zero-copy in
the literal sense**. The Pi shares system RAM with the GPU. The gain being tested
is eliminating application-side raw-image round trips and transmitting encoded
content/references. Xorg lease updates still perform required GPU snapshot copies.

## Qualification and reproduction

```sh
python3 scripts/test-vulkan-tail-results.py
docker build -f Dockerfile.gpu-dummy --target vulkan-check -t browserpane-vulkan:check .
tail_evidence_dir=$(mktemp -d)
docker build -f Dockerfile.gpu-dummy --target vulkan-tail-evidence --output "type=local,dest=$tail_evidence_dir" .
node scripts/check-gpu-tail-wire.mjs "$tail_evidence_dir/tail-wire.bin"
```

The build runs software Vulkan with Khronos validation; that proves correctness,
not Pi speed. The wire checker imports the **actual unchanged viewer tile parser
and QOI decoder** from the materialized upstream tree (Node with TypeScript
stripping, e.g. current Node 22). It reconstructs all accepted synthetic frames
and checks every RGB/alpha pixel independently; it does not launch a browser.

For explicitly authorized Pi checks, run `scripts/vulkan-lease-pilot.py --tail`
with the existing image/render-node/group/private-output arguments. All imported
result-parser modules must be beside the script. Use a separate `--validate`
run to export the bounded synthetic stream for the same viewer-decoder checker.
The finite workload has a 180-second deadline and uses a fresh owned, network-free
display, never production profiles. Hardware selection fails closed on non-V3DV.
See [security boundaries](SECURITY.md#experimental-gpu-dummy-driver).

The 63 transitions cover three sizes (1280×720, 1365×767, 1920×1080), cold frames,
unchanged frames, tile copying, 13-pixel scroll with fixed/dynamic content, noise,
gradients, forced fingerprint collisions, dropped packets, bad/duplicate ACKs,
cache eviction/recovery, disabled motion, uniform fills, a one-bit last-pixel
exception to uniformity, uniform repair, reconnect and resize. Malformed/truncated
QOI and incomplete/wrong-sequence packets must reject without committing state.
Exactly 57 frames are accepted, three intentionally dropped and three rejected
for missing cache entries. Software/native sanitizer and old pipeline regression
checks are separate from clean hardware timings.

### Observed Pi 4 results

The final local ARM64 artifact passed one V3DV/Khronos validation run and two
separate clean runs on Pi 4 (Mesa 25.0.7). Each completed all 63 transitions with
zero pixel errors and unchanged pre-existing service identities. The actual
viewer parsers independently reconstructed all 57 accepted hardware frames and
3,306 QOI tiles. Local ASan/UBSan, SPIR-V validation, the full Docker software
gates, result-parser tests and workflow syntax checks also passed. Hosted CI was
not run or pushed as part of this local experiment.

These are ranges of two clean component samples per row, not percentiles:

| Case | Final framed bytes | Submit-to-output ms | Sender process CPU ms |
| --- | ---: | ---: | ---: |
| 720p unchanged | 10 | 20.6–27.0 | 1.55–1.64 |
| 720p one cached tile copy | 28 | 14.4–18.2 | 1.48–1.49 |
| 720p scroll + overlay repair | 16,314 | 20.3–29.1 | 1.37–1.62 |
| 720p one tile restored to flat | 24 | 16.0–16.5 | 1.36–2.41 |
| 1080p scroll + overlay repair | 37,733 | 50.8–50.9 | 1.26–3.65 |

The 720p scroll reuses 196/240 tiles; 1080p reuses 446/510. A changed flat frame
requires no QOI tiles at all. In contrast, changing one bit at the last pixel of
an otherwise flat frame requires exactly one QOI tile; repairing it uses exactly
one Fill. Neither flatness nor motion is allowed to hide that exception.

The first layout redundantly recomputed unchanged fingerprints; an intermediate
parallel-motion layout redundantly selected the vector in each tile. The final
layout inherits unchanged metadata and performs one GPU vector selection per
frame. These remove unnecessary work, but the samples do **not** demonstrate a
production speedup. In particular, synthetic full-root fixture redraws make GPU
producer readiness part of completion, unlike the previous pre-drained immutable
pair benchmark. Do not compare these times to a mask-only shader and attribute
the difference to GPU encoding. End-to-end paired qualification is still needed.

`completionMs` covers submit through the final fence, including producer readiness
and driver/kernel scheduling. Recording, fixture draw/acquire/import, socket handoff,
receiver decode and full-pixel checks are separate. `cpuMs` covers sender process
CPU during recording/submission/completion, not Xorg, receiver, kernel-wide work or
energy. No intrusive GPU timestamp query is required. These are component samples,
not input-to-photon latency, LAN throughput or a comparison against production main.

Before live integration: qualify viewer ACK/eviction/reset coupling, asynchronous
bounded output lifetime, real scroll/animation workloads, backend recovery and
paired end-to-end timings with the existing transport. GPU-only placement alone
does not establish a speed improvement.
