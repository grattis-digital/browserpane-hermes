# GPU frame leases: experimental driver-to-capture handoff

Status: local experiment, default off. No application backend, production
deployment, network protocol replacement or viewer performance claim.

## Purpose and plan

Keep the display and analysis GPU-resident. Do not call XGetImage/MIT-SHM to
obtain a CPU framebuffer and upload it again. The existing Rust/glamor DDX owns
a GPU root pixmap; the missing contract is a coherent frame that another GPU
context may read while Xorg continues drawing.

1. Implement bounded ownership and a real DMA-BUF/fence handoff.
2. Qualify direct GPU texture comparison, generations, damage accumulation,
   backpressure, resize and disconnect with independent pixel oracles.
3. Connect the existing content-index/movement prototype without reconstructing
   a full CPU framebuffer. Qualify input-independent scroll reuse and latency.
4. Integrate selective tile readback/encoding and the existing cache/transport
   contract, then qualify Chromium and viewer behavior before any promotion.

This increment implements the first two mechanisms. The finite harness is the
qualification gate; merely compiling the code does not pass it.

The follow-up [Vulkan consumer](../native/vulkan-lease/README.md) implements
GPU-resident diff/classification, prefix compaction and Raw gathering. It also
adds an opt-in UIF snapshot allocator and explicit Vulkan producer-semaphore
waiting. Its hardware tests exposed an intermittent GLES-first readiness failure
on Mesa 25.0.7: an EGL server wait must not be assumed to reach native CSD
submission. Existing passing GLES fixtures alone do not establish that guarantee.
The Vulkan comparison runs GLES only after explicit producer completion and
foreign ownership release. Neither experiment is a production backend.

## Ownership and copies

The Rust pool has three slots, at most 1920×1080 each, with fixed 64×64 tile damage
maps. C owns the Xorg/Mesa objects; all display operations remain on Xorg's
single event-loop thread. The consumer has its own EGL context on the same
verified V3D render device. There is no shared mutable EGL context or worker
thread making Xorg calls.

Each acquisition atomically chooses a free slot, updates its accumulated damaged
regions with GPU CopyArea, exports the actual allocator format/modifier/plane
strides/offsets, and inserts an EGL native completion fence. The consumer imports
the DMA-BUF and queues an EGL GPU-side fence wait before reading the texture.
No `glFinish`, CPU map or pixel readback occurs in the handoff adapter.

This is **not zero-copy**. The first use of each slot and each size generation
copies all visible pixels on the GPU. Glamor may additionally make a one-time
GPU copy to turn the allocation into an exportable BO. Subsequent updates copy
only the slot's accumulated damage, rounded outward to 64-pixel tiles and merged
into horizontal runs. A broad/full XDamage report still requires a broad/full
GPU snapshot update. Glamor's internal fallback behavior remains a qualification
concern, not something a V3D renderer string disproves.

Two slots may be held by the tile ACK pipeline; the third supports independent
video cadence. Each slot stays immutable until its explicit release. If all
three are held, acquisition returns BUSY without overwriting any or queuing more
frames. The query reply advertises the slot count in `reserved[0]`, so the new
video worker rejects an older two-slot driver before capture. Damage continues
accumulating per slot, including across skipped acquisitions. Resize increments
the generation and fully invalidates pending contents; already exported old-size
leases remain valid until released. Unsupported capture dimensions return
UNAVAILABLE rather than cropping or breaking the display.

The consumer must finish **all** GPU reads before release. The experimental v1
release is a trusted-consumer assertion, not an enforced consumer-fence transfer.
There is no safe “force reclaim after timeout”: disconnect destroys the server's
references and new consumers get fresh allocations. Existing imported DMA-BUF
references may outlive the disconnected client and are never recycled by this
pool. Consumer import caching and consumer-release fences are follow-up work.

## Local protocol and trust boundary

`BPANE_GPU_LEASE=1` registers the `BPANE-GPU-LEASE` extension only on the
experimental GPU DDX. Normal Compose and the software fixture do not enable it.
There is no new listener: requests use the existing private local X11 connection
and FD passing. See [security boundaries](SECURITY.md#experimental-gpu-dummy-driver).

Version 1 is explicitly native-endian, local-client-only and single-screen. The
16-byte request has X11 major/minor/length followed by three u32 token fields:
slot, lease serial, generation. Minors are Query=0, Acquire=1, Release=2.
Non-release token fields must be zero. Short/long/trailing requests, unknown
minors, stale/double releases and non-owner releases fail. A second client may
query capabilities but cannot acquire while another client owns the session.

Replies are 128 bytes, zero-initialized, with version, status, token, dimensions,
actual DRM fourcc, modifier, up to four plane layouts and copied-pixel count.
Successful Acquire carries one FD per plane followed by one native sync_file FD.
BUSY and UNAVAILABLE replies carry none. Descriptor ownership transfers through
Xtrans; the consumer closes plane FDs after successful EGL import, while EGL owns
the imported native fence FD. Query/Release replies carry no FDs.

The bounded slot count is not a hostile-client GPU-memory quota: a trusted X11
client can retain DMA-BUF references indefinitely, has other X11 allocation APIs,
and may write shared buffers. Lease immutability requires a cooperating reader.
Do not share the display socket outside the intended trust boundary.

## Compute probe and measurement scope

`bpane-lease-probe` draws synthetic X11 content through glamor, imports two real
driver snapshots, and directly samples their GPU textures in an OpenGL ES 3.1
compute shader. It compares RGB exactly, ignoring the unused root alpha channel.
The output is a 512-bit (64-byte) dirty-tile mask. This is a correctness baseline,
not a probabilistic hash, scroll matcher or implementation of tile reuse.

The probe deliberately performs a full CPU pixel oracle **outside** the reported
handoff/comparison timings. It reports acquisition, import, dispatch and metadata
map/wait separately. GPU queue waits are included where observed; these are wall
times, not pure GPU cycle measurements. Shader setup is outside those scopes.
Cold allocation and comparison are separate from 4 warm-ups / 16 measured tiny
updates. Do not sum these numbers into viewer latency or compare them as equivalent
to earlier full-browser or synthetic GPU-content-index benchmarks.

Run the existing finite, owned Pi pilot with `--lease`, using a `gpu-check` image
built from this branch. It enables the extension only in its new network-free
display container. The standard display/EGL lifecycle tests still run, and the
pilot requires clean shutdown and unchanged pre-existing service identities.
No browser tab, profile or frontend connection is opened by this component gate.

### Observed qualification

The isolated Pi 4 V3D gate passed with the actual DMA-BUF/native-fence import,
full pixel oracles, negative protocol/ownership requests, bounded backpressure,
odd-size resize with an old lease retained, and disconnect/reacquisition. The
standard display and native EGL probes passed before and after a clean restart.
The second run additionally passed twelve synthetic scroll-frame transactions:
odd deltas, reversals, a stationary tick and several updates between captures.
Both the current and retained previous frame were checked against exact pixels.
These are rendered X11 scroll-copy fixtures, **not human browser-input tests**.

Second run, 1280×720, 4 warm-ups and 16 measured 24×24 updates:

| Component wall time | Median | p95 |
| --- | ---: | ---: |
| Draw request + snapshot acquisition | 0.909 ms | 2.282 ms |
| DMA-BUF/fence import and texture setup | 0.150 ms | 0.373 ms |
| Compute submission | 1.355 ms | 3.374 ms |
| Metadata map/wait | 14.600 ms | 18.090 ms |
| Compute submission + metadata map/wait | 16.295 ms | 19.174 ms |

Each measured update copied 4096 pixels (16 KiB of logical RGBA data) GPU-to-GPU
and read back a 64-byte dirty mask. Initial snapshot copies and allocation are
not included in those steady-state copy counts. Full CPU pixel oracles remain
outside the timings. Import is recreated each acquisition in this correctness
probe, not cached as a production implementation should be.

The first run's combined comparison median was 15.817 ms. This is architectural
progress, **not an end-to-end speed win**. Mapping 64 bytes waits for preceding
GPU work; its 14–18 ms wall time must not be described as 64-byte transfer cost or
pure shader execution time. GPU memory access, snapshot completion and scheduling
need further attribution. No paired main-branch/browser benchmark was run here.
Existing services were unchanged and the owned test containers were removed.
Raw reports and image/source provenance remain private, outside this repository.

Local gates also passed: 12 Rust unit tests, formatting, Clippy and rustdoc;
13 pilot-boundary/result tests; two existing local-harness boundary tests;
native ARM64 strict C builds and exact wire fixtures; software Xorg lifecycle,
missing-GPU fail-closed and the software C-ABI ASAN fixture. The latter does not
exercise the GPU lease adapter under ASAN. Hardware descriptor exhaustion,
context loss, hostile clients, modifier variants and long-running recovery remain
unqualified. Normal CI builds/tests the software path only; it never contacts a Pi.

The follow-up [comparison-layout diagnostic](GPU_COMPARISON_LAYOUTS.md) separates
pending producer work and compares cached shaders, smaller workgroups and safe
early exits. Its immutable-frame timings must not be pooled with the fresh-frame
measurements above.

## Scroll consistency contract for the next integration

Input ticks are not frame IDs: browsers may coalesce several wheel events into
one frame, animate one input across frames, or scroll without wheel input.
Content matching must consume completed frames identified by display generation
and lease serial. Every movement command and replacement tile must refer to the
same source/cache generation and destination frame. Apply the resulting transaction
atomically in the viewer; on missing references, dropped transactions, resize or
reconnect, request/rebuild a safe baseline rather than guessing the offset.

A lease serial identifies an atomic snapshot of Xorg's ordered drawing stream,
not a Chromium compositor frame ID. If an application paints one logical update
through several separate X requests, capture can occur between those requests.
Browser Present/compositor alignment and viewer transaction ordering therefore
remain separate integration gates, even after the snapshot fence tests pass.

GPU residency permits removal of input-specific position heuristics only after
content-based matching passes wheel bursts, direction reversals, scrollbar drags,
scripted/nested scrolling, animation/fixed overlays, skipped frames and odd tile
edges. Simple same-position comparison alone marks most scroll pixels changed;
it does not replace the cache/reuse algorithm or ensure low wire traffic.

## Research concepts reused, not code copied

- [Xorg 21.1.16](https://www.x.org/releases/individual/xserver/xorg-server-21.1.16.tar.xz):
  public glamor export, context selection, Damage and local X11 FD transfer APIs.
- [xorgxrdp EGL capture](https://github.com/neutrinolabs/xorgxrdp/blob/49bf2dd3546dc48b9d5bae62022762fde11793d0/module/rdpEgl.c):
  GPU-resident analysis and compact tile results. No CRC-only omission rule copied.
- [EGL DMA-BUF import](https://registry.khronos.org/EGL/extensions/EXT/EGL_EXT_image_dma_buf_import.txt)
  and native fence synchronization: allocator metadata and explicit producer
  completion, not an assumption that receiving an FD means rendering has finished.
- Capture-tool lifetime/damage patterns summarized in [capture research](GPU_CAPTURE_RESEARCH.md):
  accumulate damage per reusable buffer and keep ownership separate from presentation.

The driver, consumer probe and policy are independently implemented repository
code. No Chromium build, kernel driver, KMS device access or dependency patch is
introduced by this increment.
