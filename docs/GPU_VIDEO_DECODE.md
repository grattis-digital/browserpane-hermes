# Pi 4 hardware-decoding candidate

**Experimental; isolated Pi H.264 playback tested, full-stack qualification pending.** The GPU video-region encoder does
not accelerate the source video that Chromium plays. These are independent
codecs. A browser can use V3D for compositing and still spend ARM CPU on AV1.

The target pixel path is:

```text
H.264 source → bcm2835 decoder → DMA-BUF / X11 GPU composition
             → immutable GPU frame lease
             → GPU crop + NV12 → bcm2835 encoder → compressed network bytes
```

Surrounding UI stays on the lossless GPU damage/tile/cache path. This is **not**
a full-screen video stream. Browser JavaScript, audio, demuxing, driver submission
and transport still use CPU. DMA-BUF sharing is not proof that every driver
stage is copy-free; that requires hardware traces. The Pi's fixed-function
video engines are distinct from its programmable V3D GPU.

## What this adds

- `Dockerfile.gpu-decode` extends a current paired GPU-tail browser image with
  Raspberry Pi's prebuilt **Bookworm arm64 Chromium 152.0.7977.82** packages.
  Their small `zenoty` dialog dependency is pinned as well.
  It neither builds Chromium nor upgrades the host or changes Mesa deliberately.
- `compose.gpu-decode.yaml` gives only Chromium one explicitly selected
  `bcm2835-codec-decode` device. The outgoing encoder stays in the display
  sidecar. No camera, all-device mount, network listener or sandbox exception.
- `BPANE_GPU_DECODE=v4l2` requires V3D + GPU-dummy X11, the pinned Pi package
  and the right readable/writable device. Readiness and the existing watchdog
  additionally require the video-decode feature enabled. Nonempty advertised
  profiles must include H.264 at 1280×720; an empty legacy CDP list is explicitly
  **unreported**, not proof of either unsupported or working decoding.
- The decoder option disables `AcceleratedVideoDecodeLinuxZeroCopyGL` while
  preserving all other disabled features. This selects the hardware decoder's
  BGR4-compatible output path: the default NV12 native-pixmap import fails on
  the tested X11/ANGLE stack. It does not disable hardware decoding or the
  sandbox, but is **not a proven zero-copy path**.
- A **pinned, bundled h264ify 2.0.1** is loaded through the existing additive
  extension mechanism. Its purpose is to request H.264 on YouTube instead of
  AV1/VP8/VP9. Its MIT license and complete source remain in the image under
  `/opt/browserpane/h264ify`. AdBlock and the BrowserPane extension remain.

The capability gate does **not** prove that an individual video is hardware
decoded. h264ify changes site-facing codec negotiation; it is not a decoder,
not a browser-wide prohibition on software decoding and not a security gate.
Its settings are user-changeable. It may need a subsequent page load after
first extension installation; it does not replace an already playing stream.
YouTube can change its negotiation APIs. Verify actual player metadata.

Pi 4 has H.264 decode/encode and HEVC decode hardware, but no AV1 hardware
decoder. This candidate deliberately targets **H.264**, not HEVC: Pi Chromium's
current Linux path is stateful V4L2, and the package excludes unsupported
stateless devices from its advertised codecs. Codec availability can constrain
site quality choices (including YouTube's higher-resolution formats).

## Build and configure — do not roll out before qualification

Build the current paired application as described in [GPU live tests](GPU_LIVE_TEST.md).
Do not use an older application image merely because it has V3D enabled.

```sh
docker build -f Dockerfile.gpu-decode \
  --build-arg BPANE_GPU_DECODE_BASE=browserpane-hermes-browser:gpu-local \
  -t browserpane-hermes-browser:gpu-decode-candidate .
```

The base must be Bookworm arm64 and contain the GPU scheduler shim and the
paired current host/gateway/viewer. Default CPU and render-only images remain
unchanged. Updating Chromium requires reviewing the version, all package SHA256
pins, wrapper identity check, packaging patches, sandbox and runtime evidence
together. The package is pinned, not self-updating: monitor security updates.
No additional apt repository or automatic extension-update source is installed.
The image replaces `/app/source.tar.gz` with the current wrapper and a freshly
replayed pinned upstream snapshot; the h264ify source/license is bundled separately.

A hardware-free package smoke check can run locally or on an arm64 CI runner:

```sh
docker run --rm -i --label io.browserpane.test=decode-package-check \
  --network none --read-only --cap-drop ALL --security-opt no-new-privileges:true \
  --pids-limit 32 --memory 192m --entrypoint node \
  browserpane-hermes-browser:gpu-decode-candidate --input-type=module \
  < scripts/check-gpu-decode-package.mjs
```

It checks installed package versions, dynamic libraries, source inclusion and
the pinned extension's codec checks in an isolated synthetic JavaScript realm.
It does not launch a browser, access devices or prove real site negotiation.

Identify the decoder **by driver identity**, not by assuming all video nodes
are equivalent:

```sh
for device in /sys/class/video4linux/video*; do
  printf '%s: ' "$device"
  cat "$device/name"
done
stat -Lc '%g' /dev/video10
```

Use the matching device and its actual GID in private configuration:

```dotenv
BPANE_GPU_DECODE_IMAGE=browserpane-hermes-browser:gpu-decode-candidate
BPANE_GPU_DECODE_DEVICE=/dev/video10
BPANE_GPU_DECODE_GID=44
```

Those device/GID values are examples, not discovery results. Chromium expects
canonical `/dev/videoN` names, so Compose maps the selected decoder to
`/dev/video10` inside the container; startup verifies its actual major/minor
sysfs identity. Primary GID changes but UID remains 10000 and existing DRI
supplemental groups remain. If adding other unpacked extensions, set
`BPANE_GPU_EXTENSION_DIRS` to a comma-separated list **including**
`/opt/browserpane/h264ify`; this override replaces that list, not managed policy.

Layer in this order and inspect the merged configuration privately:

```sh
docker compose -f compose.yaml -f compose.gpu.yaml \
  -f compose.gpu-video.yaml -f compose.gpu-decode.yaml config --quiet
```

No startup command is given here: qualification requires an explicitly approved
test window, a fresh labelled profile, a single Pi Chromium and rollback to the
exact original containers. Do not start a competing browser beside live use.
Never benchmark the persistent profile or use its logins in a synthetic test.

## Acceptance gates, not just an image build

1. Default-off, wrapper, Compose, package hash and readiness tests pass locally.
   Check the Chromium launcher preserves X11/ANGLE, sandboxing, managed extension
   networking, profile paths and the one-browser topology.
2. On the Pi, `SystemInfo.getInfo` reports sandboxed V3D, no GPU-process crashes
   and enabled video decoding. Pi Chromium's modern V4L2 pipeline can leave
   its legacy `videoDecoding` array empty even during hardware playback. Record
   that as unreported and require the next playback gate, never infer support.
   No `--disable-gpu-sandbox`,
   `--no-sandbox`, `--ignore-gpu-blocklist` or fake GPU flags are acceptable.
3. In one disposable test tab, play a locally generated 720p30 H.264 fixture.
   Group `Media.playerPropertiesChanged` by **player ID**, never merge historic
   players. Require `kIsPlatformVideoDecoder=true` and the V4L2 decoder backend;
   reject Dav1d, FFmpeg or VPX software playback even if generic GPU status passes.
4. Verify decoder DMA-BUF → EGL/DRI3 import and no CPU pixel readback/conversion
   in the active path. Record hardware codec queues, GPU waits, CPU consumption,
   source decoded/dropped frames and **actual viewer output**, not just calls to
   WebCodecs `decode()`. Test complex moving content, not only solid colours.
5. Verify YouTube codec negotiation on fresh synthetic/disposable state and
   explicitly observe the selected decoder. Check controls, resize, scroll,
   video exit repair, reconnect and audio sync without adding a second Pi tab.

Outgoing video cadence is independent of tile ACKs in the paired GPU worker;
source-decoder qualification alone still does not establish viewer FPS.

An isolated Pi 4 diagnostic with one disposable tab selected `V4L2VideoDecoder`
and `kIsPlatformVideoDecoder=true` for a synthetic 1280×720 H.264 clip. The
default NV12 path failed after a few frames with a SharedImage import error;
the alternative output path sustained playback without that failure. This is
source-decoder evidence, not a viewer FPS benchmark, proof of copy-free driver
internals, or validation of every site's codec negotiation. Repeat the gates
on the exact image and paired display stack before deployment.

## Provenance and primary sources

- [Pi 4 specifications](https://www.raspberrypi.com/products/raspberry-pi-4-model-b/specifications/).
- [Chromium's GL zero-copy feature rationale](https://chromium.googlesource.com/chromium/src/+/fb42a91ffae45f6a7c1639ebf0f1622b7c346d1d)
  and [Linux decoder format selection](https://github.com/chromium/chromium/blob/152.0.7977.82/media/mojo/services/gpu_mojo_media_client_linux.cc).
- [Pi Chromium packaging](https://github.com/RPi-Distro/chromium/tree/4d53fbc65790635e85719396282493ba55c5c511),
  Bookworm version `1:152.0.7977.82-1~deb12u1+rpt1`. SHA256 pins are from the
  [official arm64 package index](https://archive.raspberrypi.com/debian/dists/bookworm/main/binary-arm64/Packages.gz),
  verified against downloaded artifacts during build; the base's Debian apt
  configuration verifies dependency packages. No unverified apt source is added.
- That package includes stateful capture-format selection, bounded decoder
  instances, sandbox broker/GBM access, opaque BGRX X11 import and stateless-codec
  advertisement fixes. See its `debian/patches/rpi/` and `debian/patches/series`.
  We consume these maintained fixes rather than claiming them as our code.
- [h264ify source and MIT license](https://github.com/erkserkserks/h264ify/tree/f894cef9d704dfb5fcf3aecddc25d734c3934af2).
  Commit and archive digest are fixed in the Dockerfile. It modifies YouTube
  page codec APIs, has `scripting`/`storage` permissions and site-scoped access
  to YouTube, youtube-nocookie and youtu.be. It is an explicit third-party
  compatibility boundary, not application-domain prototype patching.

This document records an implementation candidate and its qualification plan,
not a claim of GPU-only playback, a throughput result or a completed rollout.
