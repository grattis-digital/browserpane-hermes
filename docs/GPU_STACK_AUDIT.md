# Vulkan completion and CPU involvement audit

This default-off component audit tests an attribution problem, not a production
backend or a claim that the Pi has reached a hardware performance limit. The
original `waitMs` measures a blocking fence wait; it combines GPU work, dependency
and scheduler delays, cache maintenance, and host wakeup. Calling-thread CPU time
does not account for driver workers or kernel workers.

## Controlled comparisons

The existing immutable UIF GPU frame leases, exact RGB semantics, 64×64 tiles and
16×16 workgroups are preserved. The new `bare.comp` removes uniform-colour
classification but still checks every valid pixel; it is not an approximate or
early-exit algorithm. Five separately recorded command streams are measured:

| Stage | Work included |
| --- | --- |
| empty | Minimal output-header shader and completion |
| bare | Exact RGB comparison only, GPU-local flags |
| classify | Existing comparison plus uniform-colour classification |
| compact | Classify and stable command/payload compaction |
| full | Classify, compact and raw-tile gathering, **without CPU output copy** |

Every stage runs in three modes: one submission/wait, eight submissions with a
wait after each, and eight GPU-ordered repetitions in one command buffer with
one final wait. Explicit memory/execution barriers protect reused scratch and
output, including dependencies between repetitions. No indirect dispatch,
timestamp queries, per-repetition clock reads, CPU tile decisions or output
copies are inserted into the timed loop.

Single-operation results are completion latency. Dividing an eight-operation
result by eight gives amortized processing time, **not live-frame latency**.
Batching the same immutable pair also has different cache behaviour from live
frame turnover. Do not infer viewer FPS or production end-to-end improvement.

The full matrix retains three dimensions (including partial edge tiles), five
synthetic scenarios, exact flags/command/payload oracles, and source-frame pixel
checks. Each mode/stage has one warmup and six measured samples, with rotating
stage and mode order. Stage oracles run after each timed sample; bare/classify
validation copies scratch through the output buffer **outside** measurement.
The measured stream never reads intermediate flags back to the CPU. A failing
oracle invalidates the run; six samples are not a robust tail-latency estimate.

## Counters and their limitations

Clean runs use wall, calling-thread and whole-process CPU clocks. The whole-
process clock includes userspace driver worker threads, but not external kernel
workers or Xorg. User/system CPU and context-switch counts are also recorded;
their wider sampling boundary includes diagnostic counter reads when enabled.
A 10,000-read calibration estimates each host clock's mean call/loop overhead.
These are ordinary host clocks, not GPU query commands.

Separate `--audit-counters` runs read only the consumer's `/proc/self/fdinfo`.
V3D DRM client IDs deduplicate shared FDs. Six engine active-time and completed-
job counters are required: bin, render, TFU, CSD, cache-clean and CPU. Missing,
incomplete or inconsistent counters fail closed rather than reporting zero GPU
work. CPU jobs are reported even if present; the parser must not reject and hide
evidence of a CPU fallback.

These are **kernel-accounted job intervals**, not hardware shader-cycle timers.
CSD accounting starts near hardware submission and ends at completion handling;
cache cleaning has its own kernel-worker interval. Queueing before job start and
host wakeup after completion are not CSD execution. Subtracting independently
reported medians is not an exact decomposition. Zero CPU-queue jobs does not
mean zero kernel CPU involvement: GPU scheduling and cache maintenance still
require driver work.

The pinned Mesa implementation routes ordinary dispatch to CSD jobs, but timestamp
queries and indirect dispatch through CPU jobs. Neither CPU-backed API is used
here. V3D's kernel also schedules cache cleaning after compute; batching Vulkan
commands does not imply the kernel executes all passes without CPU scheduling.

## Raspberry Pi attribution evidence

V3D 4.2.14.0, Mesa 25.0.7, Linux 7.0 Raspberry Pi kernel, immutable real UIF
leases. One validation run and clean/counters/clean runs all passed the fifteen-
case matrix, with 1,350 measured samples per run. Exact local/Pi consumer and
shader hashes match, and the driver hash remains unchanged. The shared host had
roughly 1.8 GiB available memory, 53–55°C temperatures and non-idle CPU load;
neither GPU clocks nor host scheduling were locked for the test.
The original non-audit Vulkan/GLES component matrix also passes a separate
hardware validation regression. All five owned test containers were removed;
pre-existing service identities, start times and restart counts stayed unchanged.
Local C/SPIR-V builds, software validation (including the real-result parser),
and 29 narrow Python tests pass. No production deployment or push was performed.

Clean per-run median ranges for an **unchanged** frame:

| Size / stage | Single completion ms | Serial8 ms/op | Batch8 ms/op |
| --- | ---: | ---: | ---: |
| 720p bare diff | 5.22–5.51 | 5.40–5.59 | 5.09–5.22 |
| 720p full | 7.27–8.56 | 7.10–7.33 | 6.93–7.29 |
| 1080p bare diff | 12.10–12.40 | 11.46–11.72 | 11.05–11.24 |
| 1080p full | 14.36–15.01 | 14.87–14.99 | 14.12–14.14 |

For bare 720p, process CPU falls from 0.303–0.314 ms/op in serial8 to
0.055–0.068 ms/op in batch8, while elapsed time improves only modestly. This
is evidence of reduced CPU submission/wakeup cost, not an order-of-magnitude
compute improvement. Host clock mean read costs are 60–65 ns (monotonic),
1.75–1.76 µs (thread CPU) and approximately 1.83 µs (process CPU); the calibration
includes loop overhead. No per-operation clocks are used inside serial8.

Scrolling still gathers raw pixels: clean full-stage single completion is
13.88–14.72 ms at 720p and 28.68–30.28 ms at 1080p **before** any CPU raw-output
copy. This does not implement scrolled-content cache reuse or compression.

The separately labelled counter run passed all fifteen cases and 1,350
measured stage/mode samples. Across these samples:

- CPU-queue jobs: **zero**. TFU jobs: **zero**.
- CSD jobs match the actual dispatch count exactly: one per empty/bare/classify
  operation, two per compact operation, three per full operation.
- Every CSD job has one cache-clean job, including batched repetitions.
- Each submission has one bin and one render job, consistent with Mesa's no-op
  completion-signalling path. An eight-operation batch amortizes this pair to
  one eighth per operation; it does not remove per-dispatch cache maintenance.

Diagnostic medians for an **unchanged** frame, one operation and final wait,
with no timed CPU output copy:

| Size / stage | Wall ms | CSD active ms | Cache-clean ms | Whole-process CPU ms |
| --- | ---: | ---: | ---: | ---: |
| 720p bare diff | 5.319 | 4.670 | 0.043 | 0.360 |
| 720p classify | 6.416 | 5.734 | 0.033 | 0.344 |
| 720p compact | 6.538 | 5.791 | 0.102 | 0.381 |
| 720p full | 6.669 | 6.163 | 0.087 | 0.324 |
| 1080p bare diff | 12.351 | 11.853 | 0.034 | 0.409 |
| 1080p classify | 14.501 | 13.074 | 0.036 | 0.483 |
| 1080p full | 14.331 | 13.273 | 0.095 | 0.399 |

Columns overlap and their medians are not additive. This instrumented run is not
a replacement for clean timings. The apparent compact/full ordering differences
at 1080p show why independently measured medians should not be subtracted as exact
stage durations on an active shared host.

The attribution **does not support a CPU pixel-comparison fallback or millisecond
clock-reading overhead**. Most time is inside the kernel-accounted compute-job
interval. It still does not establish pure shader duration: hardware performance
counters/disassembly and completion/IRQ effects remain the next investigation.
Zero CPU-queue jobs does not exclude ordinary kernel scheduling CPU work.

There is real, measurable control-path inefficiency: extra completion jobs,
per-dispatch cache maintenance and per-operation host waits. However, their
observed costs do not explain away the multi-millisecond bare comparison. The
next priority is shader/image-access efficiency and hardware stall/occupancy
evidence, not an unsupported assertion that removing CPU fences will remove most
of the observed latency. Classification also consumes time on unchanged frames;
a future candidate should test avoiding that work without making changed frames
slower or weakening exact pixel semantics.

## Reproduction and safety

Run the existing Vulkan build and parser tests plus:

```sh
python3 scripts/test-vulkan-audit-results.py
docker build -f Dockerfile.gpu-dummy --target vulkan-build -t browserpane-vulkan:audit .
```

The build runs software Vulkan with Khronos validation as a correctness gate,
never as a Pi performance claim. Use the existing private hardware-pilot options
with `--audit`, `--audit --validate`, or `--audit-counters`. Validation and counter
runs remain labelled separately from clean timings. Unsupported hardware counters
are an explicit diagnostic limitation, not grounds to relax device selection.

The pilot still uses a fresh labelled, network-disabled UID10000 container, one
explicit render device, read-only root filesystem, no added capabilities, and
bounded memory/PIDs/CPU shares. The audit workload has a 180-second deadline;
individual fence waits remain capped at two seconds. Existing services, profiles,
tabs, host scheduler settings, clocks, packages and global tracing are untouched.
Raw reports, service identities and host-specific data stay private. No commit,
push, merge or production deployment follows from running this audit.

Primary sources: [Vulkan fence wait](https://docs.vulkan.org/refpages/latest/refpages/source/vkWaitForFences.html),
[DRM client usage stats](https://docs.kernel.org/gpu/drm-usage-stats.html),
[V3D scheduling](https://www.kernel.org/doc/html/next/gpu/v3d.html),
[Linux V3D job accounting](https://github.com/torvalds/linux/blob/v7.0/drivers/gpu/drm/v3d/v3d_sched.c),
[cache maintenance](https://github.com/torvalds/linux/blob/v7.0/drivers/gpu/drm/v3d/v3d_gem.c),
[Mesa queue implementation](https://gitlab.freedesktop.org/mesa/mesa/-/blob/mesa-25.0.7/src/broadcom/vulkan/v3dv_queue.c).
