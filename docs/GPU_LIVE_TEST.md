# Experimental GPU-tail viewer integration

This opt-in replaces the capture backend, not the persistent browser or MCP
session. The default CPU/Xorg deployment is unchanged. Do not start another
browser alongside this test. This is experimental work, not a production or
universal performance claim.

## Paired components

The custom Xorg GPU-dummy driver exports immutable DMA-BUF frame leases. The
display-side Vulkan worker compares GPU images, verifies scroll reuse, identifies
flat tiles and cache hits, QOI-encodes changed tiles, and assembles the existing
BrowserPane tile commands on the GPU. The host forwards only encoded output;
its CPU tile capture thread is not started in this mode. XDamage is a wake-up
hint, not the source of pixel correctness.

The viewer uses the existing lossless tile compositor. A versioned `GpuBegin`
and `GpuAck` pair ties cache advancement to one completely applied viewer batch.
An acknowledgement means ordered draw submission, not physical monitor scanout.
The viewer's QOI decoding and networking still use CPU work. This is not a claim
that every stage, including the viewer, is hardware-only.

There is one acknowledged frame and at most one pending frame. Stale ACKs cannot
advance either cache; cache misses, reconnects and geometry changes request an
independent snapshot. A five-second missing ACK releases leases and parks capture
until refresh. Disconnect closes the worker connection and releases its GPU state.

## Setup and limitations

Build the current paired application from the pinned source plus all patches,
then apply `Dockerfile.gpu` as described in [GPU.md](GPU.md). Set
`BPANE_GPU_BROWSER_IMAGE` to that local image and use:

```sh
docker compose -f compose.yaml -f compose.gpu.yaml build gpu-display
docker compose -f compose.yaml -f compose.gpu.yaml up -d browserpane
```

Keep the exact previous image IDs and Compose configuration for rollback. Stop
the old browser before switching its display. Retain the same profile and shared
folder mounts. Test on disposable synthetic data before using a real profile.

This experiment currently supports one interactive viewer and capture sizes up
to 1920×1080. Hermes/CDP uses the same browser and does not consume a viewer slot.
Load the paired, freshly built viewer; older cached JavaScript cannot acknowledge
GPU leases. Without the optional video layer below, animated content travels as
lossless tiles. No hidden parallel CPU capture loop is used.

## Capture failure recovery

Deploy the application and display health changes together. A failed Vulkan
consumer now exits its listener as well: retaining a Unix socket after losing
capture must not look healthy. The display supervisor restarts Xorg and creates
a new display generation. The browser's existing generation watchdog then closes
Chromium and restarts the shared session against that generation; the saved
profile stays on its original mount. The viewer reconnects automatically.

A separate one-byte-per-second progress pipe watches the consumer loop, not
screen damage or frame rate. Static screens, no viewer and parked ACKs are valid
states. Fifteen seconds without loop progress terminates the consumer, with a
bounded TERM/KILL sequence. A separate runtime monitor detects an unresponsive
listener after three failed five-second health checks. Docker's existing
`restart: unless-stopped` policy handles process exits; an unhealthy flag alone
is not the restart mechanism. Containers deliberately stopped by an operator
remain stopped. Recovery takes additional display/Chromium startup time.

Health uses a private same-UID Unix socket with a fixed eight-byte response,
bounded connection time and no GPU capture, raw-pixel readback or periodic disk
writes. Browser `/healthz` and GPU readiness include this check only when
`BPANE_GPU_TAIL=1`. These changes do not fix the underlying GPU-hang trigger or
guarantee recovery from a wedged kernel/device requiring a host reboot. In-memory
page state can be lost during recovery; persisted browser profile data remains.

Fault regressions cover clean exit, abnormal exit, killed/stopped worker, healthy
idle progress and a socket whose server does not reply. Hardware qualification
must use an isolated display and synthetic content, never a live profile.

## Optional Pi 4 hardware video regions

`compose.gpu-video.yaml` adds video to this experimental GPU pipeline. It is
separate because not every Raspberry Pi has the same codec hardware/driver.
Identify the node whose `/sys/class/video4linux/video*/name` is
`bcm2835-codec-encode` (commonly `/dev/video11`), not a camera or decoder. Set:

```sh
export BPANE_GPU_VIDEO_DEVICE=/dev/video11
export BPANE_GPU_VIDEO_GID=$(stat -c %g "$BPANE_GPU_VIDEO_DEVICE")
docker compose -f compose.yaml -f compose.gpu.yaml \
  -f compose.gpu-video.yaml config --quiet
# After building the paired application and display images:
docker compose -f compose.yaml -f compose.gpu.yaml \
  -f compose.gpu-video.yaml up -d browserpane
```

The extra device is mapped **only into the display service**, as
`/dev/bpane-video-encode`. No DMA heap, extra port, privileged mode or raw-frame
CPU mapping is needed. The display keeps UID 10000 and its DRI supplementary
groups; its primary GID is the encoder's group, avoiding duplicate group entries
when display and encoder already share a group. `BPANE_GPU_VIDEO=1` enables it
there; omit the video layer
to retain tile-only operation. `BPANE_H264_MODE=off` on the browser disables video
hints too. Use a viewer with H.264 WebCodecs support in a secure context (HTTPS,
or localhost); the browser chooses its local decoder implementation.

The existing CDP observer selects one visible playing HTML video in the shared
browser; it does not open another tab. Two fresh stable hints promote a region.
Hidden, moved, paused or removed hints revoke it immediately. A failed CDP probe
gets one bounded retry with a new request ID before reconnecting; GPU hint age
is capped at 1200 ms, covering the two 450 ms attempts plus scheduling jitter.
Re-reading the same observation never renews that age. This distinguishes a
briefly busy renderer from an explicit region exit. Canvas/WebGL animations
remain lossless tiles. Crops use even pixel edges for 4:2:0, independent of the
64-pixel tile grid; uncovered edge pixels remain lossless.

An independent video thread leases its own immutable GPU snapshot, crops and converts RGB to limited-range
BT.709 NV12 directly into a DMA-BUF exported by the V4L2 encoder. The raw buffer is
never CPU-mapped. Explicit Vulkan completion/foreign ownership transfer precedes
queueing; the input is not reused until the codec dequeues it. Only compressed
H.264 bytes are CPU-mapped/copied and forwarded through the existing bounded video
transport, NAL reassembler, WebCodecs decoder and WebGL/Canvas compositor.
This is not a claim of zero CPU work, zero GPU memory bandwidth or universal
hardware decoding on the viewer.

The first video frame retains a lossless background. Once the region is
acknowledged, fully covered tiles stop QOI/fingerprint work and carry no reusable
lossless cache token. Partial edge tiles compare their non-video pixels only;
video-only motion sends no duplicate lossless image. A change outside the crop
still encodes its boundary tile normally. Skipped boundary tiles discard their
cache-source token: the GPU ACK image may have changed where client lossless
pixels did not, so inheriting that token would be incorrect.
Moving/stopping video forces repair of its previous footprint even when the two
GPU images compare equal. Rejected ACKs cannot commit a new exclusion region.
Whole-screen scroll-copy is conservatively disabled while video owns a region
and through its exit repair; lossless tile caching remains active. This trades
some scroll bandwidth for correct ownership, rather than copying lossy video
pixels into static UI.

There is one codec input in flight, at most four bounded compressed buffers, a
1 MiB encoded-access-unit cap and a 500 ms codec completion deadline. Hardware
setup/codec failures restore lossless tiles; there is **no x11grab/libx264
fallback**. A failed unchanged region is not retried every frame. Video submission
is capped at 30 fps without capping unrelated tile updates to 30 fps. Actual
cadence remains bounded by capture, encode, transport and viewer decoding, but no
longer waits for each tile ACK. A complete acknowledged region authorizes video;
individual access units then follow their own 30 Hz deadline. Missed deadlines
do not build a catch-up queue.

The lease driver has three bounded slots: two for acknowledged/pending tile
images and one for video. The video thread owns a separate lightweight Vulkan
context and one hardware encoder; it shares the existing single XCB capture
owner, not Vulkan command buffers. Region change, reset and resize revoke an
internal generation before another tile announcement. An in-flight old encode
is discarded after revocation. Complete tile batches and video access units are
serialized on the private socket, so their bytes cannot interleave. The private
encoded-video header is now version 2; deploy patch 0029's host and the new
display worker together. The viewer/datagram protocol is unchanged, including
its existing same-rectangle re-entry limitation.

Patch `0030-video-stability-and-delivery.patch` adds bounded independent gateway
delivery lanes. Reliable tile/control/codec bytes retain stream order; video
datagrams wait for preceding codec/keyframe writes, not unrelated tile writes.
The queues cap at 512 reliable messages and 256 video fragments, with a shared
16 MiB + 5 byte budget (one maximum protocol frame), including in-flight writes.
Overflow reconnects only the affected viewer for a fresh snapshot; no dependent
tile or arbitrary H.264 delta is silently dropped. Network congestion and the
shared native output socket can still constrain cadence.

The viewer exposes `session.getVideoPresentationStats()` with decoded outputs,
superseded/rejected frames, texture commits, overlay clears and commit gaps.
Use differences over a bounded interval. Texture commits are not physical
scanout, and the legacy `video.decodedFrames` counter counts decode submissions,
not presentation.

Patch `0031-bounded-video-burst-presentation.patch` adds the complementary
keyframe fence: a new reliable keyframe cannot jump over older queued video
datagrams. A delta arriving over the network with a capture timestamp before
the latest IDR is discarded instead of corrupting the new decoder reference
chain. The native decoder queue is capped at eight submissions, tolerating a
brief 4–5 frame delivery burst without an unnecessary reset/keyframe wait.

Presentation retains at most three decoded GPU-backed frames and displays one
per animation frame, without a startup/prebuffering delay. Overflow closes the
oldest frames; after 50 ms, queued old motion is skipped toward the newest
available frame. At 60 Hz the extra two refreshes cost at most about 33 ms under
normal scheduling, not a growing playback backlog. Region exit/reset closes
all queued frames. This adds bounded viewer-side GPU surface retention, not
CPU pixel copies, Pi buffers, extra source tabs or a fixed testing delay.

### Verification boundaries

`Dockerfile.gpu-dummy` runs shader validation, a software-Vulkan NV12 pixel oracle
(crop, row stride, chroma offset, padding and colour conversion), and video-region
warm-up/exit/rejected-ACK tile tests. Host tests cover hint expiry, bounds, Annex-B
framing and matching complete-batch video ownership. Client tests cover late
video after exit and a crop that stays unchanged across screen resize.

`native/gpu-dummy/tests/video-cadence-probe.c` is an opt-in hardware regression
peer, compiled with `cc -D_GNU_SOURCE -std=c11 -O2 -Wall -Wextra -Werror
video-cadence-probe.c -lxcb`. Run only in a disposable 1280×720 display with
`BPANE_GPU_VIDEO_TEST=1` and a 20-second outer timeout, with the normal browser
stopped. It paints synthetic X11 content, delays every tile ACK by 250 ms,
validates independent version-2 video framing, moves the crop and checks exit.
Its FPS describes GPU-capture-to-encoded-output cadence, not client presentation
or Chromium playback. It must not connect to a real session or profile.

The explicitly enabled `bpane-vulkan-probe --video-probe` uses GPU-generated
synthetic images, not X11 capture or a Chromium profile. It requires
`BPANE_GPU_VIDEO_TEST=1` plus narrowly mapped render/encoder nodes and writes a
five-frame fixture to `/tmp/bpane-gpu-video.h264`. Run it in a disposable container
with a finite deadline, never by changing the running browser. The fixture can
then be checked with one disposable local browser:

```sh
node scripts/check-gpu-video-playback.mjs /path/to/synthetic-probe.h264
```

This checks actual WebCodecs decode, crop dimensions, decoded colour tolerance,
unchanged pixels outside the video rectangle and lossless exit repair. Component
hardware and local viewer passes are not a full deployed-browser performance or
soak test; keep those evidence categories separate.

## Security and validation

The new `/tmp/.X11-unix/bpane-gpu-tail.sock` is private to the existing X11 volume.
It is mode 0600, and both ends require peer UID 10000. No new network listener,
CDP exposure, privileged container or Docker-socket mount is needed. The shared
X11 volume remains a trusted browser/display boundary. The worker validates
versioned commands, caps output and geometry, and terminates on malformed input.
Chromium's existing sandbox and V3D runtime checks remain enabled.

Patches `0027` and `0028` must travel with `native/vulkan-lease/`, the GPU-dummy lease driver,
the display entrypoint and both runtime wrappers. Unit/protocol tests and shader
validation are not substitutes for real viewer pixel comparisons on a Pi.
The finite `scripts/render-pilot/` harness accepts `mode: "gpu-tail"`, with a
768 MiB display limit and disposable browser profile. Keep real input latency,
whole-surface pixel correctness, resource use and component timings separate.
