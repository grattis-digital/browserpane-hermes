# Experimental Chromium surface-damage patch

Source-level follow-up to the [native EGL/XDamage experiment](../../docs/NATIVE_DAMAGE_METADATA.md).
The patch, independent policy and **all six modified Chromium translation units
now compile for ARM64**. The full browser build was stopped at the user's request, and **no
patched browser has run on the Pi**. Full checkout, dependency installation,
hooks and ARM64 GN configuration pass. See [build provenance and gates](BUILD.md).
It is not installed by any product Dockerfile, wrapper or Compose service.
`BrowserPaneSurfaceDamage` is disabled by default, including in normal tests.

## Purpose and scope

On the measured Pi path, Chromium had precise compositor damage but expanded it
before an ordinary full-surface EGL swap. The independent EGL oracle showed that
KHR swap-with-damage can preserve a 24×24 update through X11. This patch connects
those two points; it does not yet establish that the real Chromium path does so.

```text
Viz logical damage → small frame metadata → existing Viz/GPU handoff
                   → checked X11 EGL swap-with-damage → XDamage consumers
```

The complete back buffer is still rendered/repaired as before. Logical surface
damage is not buffer-age repair, and KHR swap-with-damage is not NV partial-buffer
presentation. Neither `SupportsPostSubBuffer()` nor ANGLE's capabilities are
falsified. The [KHR contract](https://registry.khronos.org/EGL/extensions/KHR/EGL_KHR_swap_buffers_with_damage.txt)
requires valid contents outside the submitted rectangles too.

The packet contains only a producer token, monotonically increasing draw number,
surface dimensions and one physical-pixel rectangle. It travels by value in
existing `gfx::FrameData`; it is not a new network/CDP/MCP protocol. Its policy is
bounded, allocation-free C++20, matching the Chromium call sites without a new
language/FFI boundary. It reads no pixel buffer.

This does **not** implement DMA-BUF frame leases, GPU tile comparisons, GPU scroll
verification or GPU encoding. It adds no full-frame capture/transfer path and
does not replace the existing tile, cache, lossless codec or WebTransport stack.
It can only reduce downstream work if the driver preserves the metadata and
the existing damage-aware consumers actually use it; no speedup is claimed yet.

## Patch and safety contract

The 14-file patch and one overlay header target Chromium **152.0.7977.75**, commit
[`4999cc1efed37c4d91dc4ce6ec4b0a50e2a9a8cb`](https://github.com/chromium/chromium/tree/4999cc1efed37c4d91dc4ce6ec4b0a50e2a9a8cb).
`manifest.json` pins SHA-256 digests of 22 original source/audit files, the patch
and overlay. `DEPS` is included in that source lock; a full build still requires
its actual dependencies and toolchain. This is an experiment pin, not a supported
security-update policy or permission to downgrade an installed browser.

- `DirectRenderer` saves logical damage before full-buffer repair expansion,
  including pixel-moving-filter expansion. Unsupported transforms, surface/viewport
  mismatch, clipping, overlays, delegated ink and debug/color effects force full
  damage. Transitions out of unsupported composition also require full damage.
  Reshape/backbuffer invalidation and display-color changes force full damage.
- `SkiaRenderer` counts **draws**, including subsequently skipped swaps. Renderer
  identity and sequence numbers prevent using damage relative to an image that
  never reached the EGL swap path. No unbounded skipped-damage list is retained:
  a sequence gap requests an ordinary full swap and re-establishes the baseline.
- `SkiaOutputDeviceGL` retains driver-workaround behavior and clears metadata on
  partial-buffer or asynchronous swap paths. Only native X11 EGL opts in; the
  KHR extension and bottom-left surface origin must be supported.
- `NativeViewGLSurfaceEGL` validates dimensions/rectangle bounds and converts
  top-left compositor coordinates to bottom-left EGL coordinates. First frames,
  unknown history, empty/full rectangles, new producers and dimension changes
  use ordinary swaps. Missing/invalid metadata, duplicate/reversed sequence or
  failed swaps invalidate history. Destroy/recreate resets even at the same size.
- The existing swap timestamp, presentation callback and error lifecycle wraps
  both paths. A failed swap is not retried or silently reported successful.

This conservative policy is not a substitute for Chromium integration tests.
Asynchronous native resize, queued presentations, context loss, occlusion and
composition transitions still need real-browser pixel qualification.

## Prepare a reviewable source subset

From the repository root (Python 3.9+ and Git; network access only for preparation):

```sh
chromium_damage_dir=$(mktemp -d /tmp/bph-chromium-review.XXXXXXXX)
python3 native/chromium-damage/prepare.py --destination "$chromium_damage_dir/src"
```

The destination must not already exist. The helper fetches only the 22 pinned
files, validates their bytes, checks/applies the patch, installs the overlay and
checks reverse applicability. Each download is capped at 2 MiB with a 30-second
timeout. It never runs fetched build scripts/hooks, overwrites an existing
checkout, or deletes an incomplete failed preparation. Symlink source/artifact
components are rejected; this is not a security boundary against another process
running as the same local user. **The result is not a buildable Chromium tree.**

For an existing, separately prepared full checkout, the following is read-only:

```sh
python3 native/chromium-damage/prepare.py --verify-base /ABSOLUTE/chromium/src
```

It checks the selected original source bytes, not every dependency or build
artifact, and rejects a previously installed overlay. Do not apply this patch
blindly to another release or a Debian-patched tree. Full-build integration must
record the source/DEPS/toolchain provenance and preserve Chromium's sandbox,
X11/ANGLE/GLES configuration, packaging assets and dependency notices.

The future isolated custom-browser test opts in using
`--enable-features=BrowserPaneSurfaceDamage`; the ordinary bundle adds no such
flag. An unpatched browser ignoring an unknown feature is **not** a valid test.
Verify binary provenance and the new trace marker before comparing behavior.

## Tests and evidence

```sh
python3 -m unittest discover -s native/chromium-damage -p 'test_*.py' -v
node --test test/native-damage-summary.test.mjs
chromium_damage_test_dir=$(mktemp -d /tmp/bph-chromium-policy.XXXXXXXX)
c++ -std=c++20 -O2 -Wall -Wextra -Werror -pedantic \
  -Inative/chromium-damage/overlay \
  native/chromium-damage/tests/surface-damage-test.cc \
  -o "$chromium_damage_test_dir/policy-test"
"$chromium_damage_test_dir/policy-test"
```

Local checks passed:

- Fresh immutable-source download, all 22 source hashes, strict patch application,
  overlay installation and reverse check. Seven offline preparation tests cover
  dirty/existing destinations, links, tampering, malformed pins and size bounds.
- The six modified `.cc` files compile to ARM64 objects using the exact generated
  GN commands, pinned Clang, sysroot, libc++ modules and Chromium compiler plugins.
  This caught and fixed an inline virtual-method style rejection and the pinned
  SkM44 API lacking `isIdentity()`; the latter now compares with its identity
  constructor. No safety check, compiler plugin or warning was disabled. Separate
  output objects avoid racing the ongoing full build; linking remains pending.
- The exact policy header compiled and ran with macOS Clang and Linux ARM64 GCC;
  Linux AddressSanitizer and UndefinedBehaviorSanitizer passed. A macOS ASan run
  hung during sanitizer startup before `main` and was stopped; it is not a pass.
- The deterministic 2,000-draw framebuffer model includes skipped draws, resets
  and failed swaps. All **1,740 successful model presentations** matched the
  entire expected image: 1,406 selective and 334 full. These are synthetic model
  outcomes, not Chromium frames or measured performance.
- The ARM64 `Dockerfile.gpu-dummy` build runs this policy with ASan/UBSan and a
  15-second execution deadline in its build stage. The final GPU-check runtime
  image remained unchanged. CI also runs the seven offline preparation tests;
  neither check fetches/builds Chromium, opens a display or enables the feature.
- 302 wrapper/diagnostic Node tests, 12 render-pilot Python tests and 9 display-pilot
  Python tests passed; workflow validation passed. Hosted CI has not run for this
  unpushed branch.

The geometry-only diagnostic recognizes `NativeViewGLSurfaceEGL:SurfaceDamageSwap`
and reports `eglDamageSwaps` separately from ordinary `eglSwaps`, retaining EGL
origin and converted top-left Y. It never exports arbitrary trace arguments.
These markers show call arguments, **not successful presentation, exact GPU work,
causal frame matching or latency savings**. Raw traces remain private.

## Remaining gates and build prerequisite

1. Finish the actual pinned Chromium build with its Clang/libc++ toolchain and
   run relevant Viz/GL unit tests. Build storage and a resource-bounded Linux
   x86-64 cross-builder are now provisioned; checkout and GN configuration pass.
   See [build provenance](BUILD.md). Compilation is not yet a pass; neither a
   working toolchain nor the standalone policy proves full-browser correctness.
2. In an authorized disposable Pi browser, compare the same binary flag-off/on.
   Require real KHR rectangle observations, coherent XDamage and full-image pixel
   truth checks; keep the normal full swap as fallback. Test small changes,
   resize/recreation, skipped draws, occlusion, filters/overlays, animation and
   human wheel/scrollbar reversal. Retain failures and validate V3D plus sandbox.
3. Without tracing, compare input-to-visible p50/p95, damage/readback bytes, wire
   bytes and total browser/display CPU on matched alternating runs. This patch
   does not reduce Chromium's full-buffer rendering work by itself.
4. Only after that proof, implement coherent GPU buffer leases and region-local
   GPU comparison/scroll reuse, following the
   [end-to-end ownership and damage plan](../../docs/NATIVE_DAMAGE_METADATA.md#next-implementation-contract).

No push, production rollout or end-to-end GPU performance qualification is part
of this local source checkpoint.

## Licenses and backporting

Chromium originals and modifications retain Chromium's BSD-style terms and
notices; [LICENSE.chromium](LICENSE.chromium) is copied from the exact pin.
The new policy header and its standalone C++ test are BSD-3-Clause under
[LICENSE.policy](LICENSE.policy). This narrow dependency contribution does not
change the BrowserPane derivative's root AGPL-3.0 license or other dependencies'
licenses. Preserve the full dependency notices when distributing a custom build.

This separate Chromium patch is **not** BrowserPane ordered patch 0027. The 26
existing BrowserPane patches remain unchanged. Backport the metadata producer,
handoff, consumer and sequence/transition tests together; do not take only the
KHR call or fake NV support. Rebase only onto verified source and requalify the
real browser whenever the Chromium/ANGLE/Mesa path changes.
