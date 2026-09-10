# Isolated ARM64 build qualification

Status: full source/dependency checkout, build dependencies, hooks and GN
configuration and compilation of all six modified translation units **passed**.
The full browser build was **stopped at the user's request**; there is no completed
Chromium binary or custom-browser Raspberry Pi result at this checkpoint.
The standalone policy tests are separate evidence, not Chromium integration.

The last browser attempt was gracefully interrupted after 76 minutes: Siso
reported 6,548 completed steps, zero failed steps and 108,996 remaining. These
are that attempt's dynamic build-graph counts, not a completed-browser result.
The guard exited and the build container is stopped with automatic restart
disabled. Source, compiled objects and private logs remain available; nothing
was pruned or moved to another host. No build or Pi benchmark is running for
this experiment.

Before resuming, revisit the scheduler memory tuning. Its recorded Go heap was
approximately 2.14 GiB against a 2 GiB soft target, with roughly two GC cycles
per second and around 3.7 CPU cores consumed by Siso. This strongly suggests
excessive GC overhead, not a stalled compiler. A 4 GiB scheduler target was
proposed but **not applied or tested**. Preserve the generator serialization and
separate overall container limit; more powerful hardware alone does not validate
these settings. The prior two OOM attempts remain recorded below.

## Provenance and environment

- Source: Chromium `152.0.7977.75`, commit
  `4999cc1efed37c4d91dc4ce6ec4b0a50e2a9a8cb` (see `manifest.json`).
- DEPS SHA-256:
  `2557b5a638eb7f6d4efc81afee0e94e8ac811e70dfbca32d4214715c1fb3c4c9`.
- depot_tools: `ed9c87f6f12f6b87210e7025d4a36a5a72a2ccd4`, with
  `DEPOT_TOOLS_UPDATE=0` throughout the build.
- Linux x86-64 Ubuntu 24.04 container, translated on an ARM64 Docker host;
  cross-compilation targets Linux ARM64 using the pinned Debian Bullseye sysroot.
  This is not a claim of native ARM64 build-host support. The pinned Clang
  downloader selects `Linux_x64`; arbitrary system GCC is not substituted.
- Pinned Clang/LLD 23 (`llvmorg-23-init-19482-g53d18800-1`), Rust
  `1.98.0-nightly` (`b99844963`, Chromium build), GN `2486` (`641ace93dd95`).
  All three tools executed successfully. A preliminary Clang/LLD check produced
  both an x86-64 object and an ARM64 relocatable object.
- Current patch SHA-256:
  `d1e3709b7d12771a530c5a28634afaaa1bf7c2aacce682fd160980aacafeff19`.
  Exact GN-generated compiler commands produced all six modified ARM64 objects
  in a separate output directory. The normal incremental build remains the final
  dependency/link gate; manually produced objects are not injected into it.
- Fresh labelled source volume, no browser profiles, credentials, Docker socket,
  published listeners or GPU devices in the builder. Initially four CPUs, raised
  to eight during dependency compilation; eight GiB RAM,
  no swap, one linker; an external guard stops this builder if host free space
  falls below 35 GiB or a stage exceeds twelve hours. No automatic data pruning.

Build storage was provisioned separately before fetching. A minimum-space check
is not a guarantee that source, intermediates and final linking will fit. Follow
the [upstream build prerequisites](https://chromium.googlesource.com/chromium/src/+/main/docs/linux/build_instructions.md)
and retain a host reserve. Never use the Raspberry Pi's live browser directory
as a build or test workspace.

## Reproduction contract

1. Prepare a **fresh** Linux x86-64 builder and owned source directory. Install
   the exact depot_tools pin and checkout the exact Chromium commit above. Record
   toolchain artifacts and resource limits; do not reuse an unidentified tree.
2. Configure gclient with a single unmanaged `src` solution from official
   Chromium Git, `target_os = ['linux']`, `target_cpu = ['arm64']`, and
   `custom_vars = {'checkout_pgo_profiles': False}`. Sync with
   `gclient sync --nohooks --no-history --shallow --jobs=4`.
3. In that builder only, install pinned-tree Linux dependencies with
   `build/install-build-deps.sh --no-prompt --no-chromeos-fonts --no-arm --no-syms`.
   Run `gclient runhooks` as the build user. The qualification retained a warning
   that Ubuntu's Git 2.43 is older than depot_tools' recommended 2.46; sync/hooks
   still completed. No recommendation warning was suppressed.
4. Run `prepare.py --verify-base` against the full source tree. Only after all
   original source hashes pass, strictly check/apply `surface-damage.patch`,
   install the overlay header, and verify reverse patch applicability. This is
   intentionally not an idempotent command for an unknown or already dirty tree.
5. Copy [args.arm64.gn](args.arm64.gn) into a fresh `out/BphArm64/args.gn`. Run
   `gn gen out/BphArm64 --fail-on-unused-args`. This exact configuration passed;
   it preserves X11 and does not disable Chromium's sandbox or enable the feature.
6. Compile the six changed `.cc` objects first (three under `ui/gl` and three
   under `components/viz/service`), then the `chrome` target. The first full-browser
   attempt with four jobs was OOM-killed at the builder's 8 GiB cgroup limit;
   this was not a Raspberry Pi browser failure. A two-job retry also failed.
   Kernel records show Siso was killed, at approximately 4.6/2.4 GiB anonymous RSS
   respectively. The second run still contained 28 Blink generator workers:
   each generator independently starts a Python pool sized to the VM's 14 CPUs.
   Reducing top-level job count alone did not bound that nested parallelism.
   The stopped attempt first ran
   `GOMEMLIMIT=2GiB GOGC=50 GOMAXPROCS=4 autoninja -C out/BphArm64 -local_jobs=1 third_party/blink/renderer/bindings:generate_bindings_all`,
   then ran
   `GOMEMLIMIT=2GiB GOGC=50 GOMAXPROCS=4 autoninja -C out/BphArm64 -local_jobs=2 chrome`.
   These are build-scheduler settings only, not Chromium runtime/compiler flags.
   This separate generation stage passed (49.5 seconds); the full browser target
   then resumed. Prebuilding the generators prevents their pools overlapping and keeps other
   Chrome compilation jobs idle during generation. Siso still loads the build
   graph; this is not a claim that graph storage disappears. It changes
   neither the upstream generator commands nor their expected output.
   The pinned autoninja does translate `-j4` to four local jobs; the original
   scheduler logged an unlimited Go memory target. The new
   [Go runtime memory target](https://pkg.go.dev/runtime#hdr-Environment_Variables)
   is soft and does not cover compiler subprocesses or guarantee no future OOM.
   Keep the unchanged hard container limit and disk reserve guard.
   Record full logs, binary architecture/digest and actual success/failure. Keep
   any configuration or compiler failure; do not equate GN success with a build.

## Remaining gates

Finish compilation and relevant Viz/GL tests. Package the matching resource files,
locales, ICU/snapshot data, EGL/GLES dependencies and complete license notices;
verify runtime dependencies and the strict sandbox. A binary alone is not a
deployable BrowserPane image. Qualify the **same binary**, feature off/on, using a
fresh disposable Pi profile and the unchanged real tile/cache transport.

Require actual feature trace markers, KHR/XDamage geometry and full-image
correctness oracles (validation only, not baseline capture). Then measure latency,
readback/copies, wire bytes and total browser/display CPU with tracing disabled.
See [the patch gates](README.md#remaining-gates-and-build-prerequisite).
Do not replace a live Chromium package or publish a performance claim based only
on this build checkpoint.

The first real translation-unit checks failed on Chromium's prohibition against
inline non-empty virtual methods, then on SkM44 lacking `isIdentity()`. The method
body moved to its `.cc` file and the color check now uses `!= SkM44()` (the pinned
identity constructor). Both failures were preserved; the compiler plugins and
warnings stay enabled. The build was cleanly interrupted for each source update,
the patch regenerated/hash-locked and incremental compilation resumed. A broad
Ninja command-list decoding failure was a helper issue; the successful check uses
only the six final commands, strictly decoded, without changing their flags.

## Test harness preparation

The render pilot now has an explicit same-binary on/off contract. Before each
custom run it checks the running executable's SHA-256 and path, pinned version
and actual feature flags. The separate test launcher rejects normal deployment,
conflicting feature selection and sandbox downgrades while preserving other
flags. The enabled trace must show selective EGL swaps; silently ignoring an
unknown feature is a failure. See [pilot setup](../../scripts/render-pilot/README.md).

A bounded native XDamage observer collects geometry without reading pixels.
It cross-compiles with the pinned Clang/sysroot and passed a disposable local
CPU/X11 check: three marker updates yielded three damage events. This qualifies
the observer only, not the custom Chromium, Raspberry Pi or a performance gain.
It is enabled only for custom diagnostic runs, never clean latency runs.
All 314 repository Node tests and 15 render-pilot Python tests pass locally;
hosted CI has not run. No custom browser has been installed on the live Pi.
The diagnostic also rejects empty XDamage evidence even if feature markers are
present. The private package recipe checks the actual GN target's license
metadata before generating notices and includes matching runtime resources;
packaging and its runtime/dependency checks await the linked binary and are not
claimed as passing yet.
