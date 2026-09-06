# Backporting the rendering work

`UPSTREAM_COMMIT` pins the original BrowserPane source. The canonical source is
the tracked wrapper plus `patches/*.patch` in filename order; `upstream/` is an
ignored generated snapshot. Docker prepares it automatically. Original upstream
history, attribution and AGPL terms remain; this guide does not grant an alternate
license.

## Patch map

The [compact MCP experiment](COMPACT_MCP.md) is original wrapper code, not patch
0019. Its observation, replay and transport layers can be reviewed independently
of these rendering patches. The pinned generic Playwright MCP settlement-timer
issue is documented with measurements; this branch bypasses that orchestration,
without modifying or claiming to fix all later upstream releases.

Paths below are relative to upstream `code/`. Host means
`apps/bpane-host/src`, gateway means `apps/bpane-gateway/src`, and client means
`web/bpane-client/js`. Patches include their focused regression tests.

| Patch | Primary files | Change |
| --- | --- | --- |
| 0001 capture scheduling | Host `capture/x11.rs`, `config/`, `tile_loop/{run,dirty_set,classify,mod}.rs` | Damage ordering, idle/capture cadence, buffer reuse |
| 0002 tile cache/transport | Host `tiles/{emitter,sent_hash_cache}.rs`, `tile_loop/emit.rs`; gateway `session_hub/refresh.rs`, `transport/egress.rs` | Bounded LRU, dimension-aware content identity, reusable Zstd; fresh join/lag recovery |
| 0003 client rendering | Client tile cache/compositor, `render/`, session video/surface runtimes | GPU tile reuse/accounting, reliable video ownership, bounded decoding, context-loss recovery |
| 0004 capture diagnostics | Host `tile_loop/run.rs` | Opt-in `BPANE_CAPTURE_TIMINGS=1` phase logging |
| 0005 scroll memory locality | Host `scroll/detect.rs` | Exact contiguous-column search and differential/benchmark tests |
| 0006 video exit repair | Host `tile_loop/{run,h264_region,emit}.rs`, `tiles/emitter.rs` | Fresh lossless repair after relinquishing video ownership |
| 0007 scroll integrity | Host `scroll/residual.rs`, `tile_loop/scroll_*.rs`, `dirty_set.rs`, `integrity_tests.rs`, `tiles/emitter.rs` | Exact regional repair, cross-grid position validity, coalesced full recovery |
| 0008 client scroll integrity | Client `render/` scroll-copy/command/draw runtimes and `tile-compositor.ts` | Exact clipping and failed-batch recovery barrier |
| 0009 gateway integrity | Gateway `session_hub/`, `transport/{egress,bootstrap,negotiation}.rs` | Fail closed on unusable deltas, bounded/retired H264 bootstrap state |
| 0010 exact sub-tile reuse | Host `scroll/`, `config/`, `tile_loop/{scroll_send,scroll_residual,integrity_tests}.rs`, `tiles/emitter.rs` | Exact 32-pixel copy policy and fractional-row position invalidation |
| 0011 capture alignment | Client resize/surface/session runtimes and public types | Opt-in physical 8×2 alignment and matching fractional CSS |
| 0012 static position repair | Host `tiles/emitter.rs`, `tile_loop/integrity_tests.rs` | Invalidate static positions throughout whole-row copy region, including partial bottom rows |
| 0013 exact dummy modes | Host `capture/ffmpeg.rs` | Validate and apply exact DUMMY0 geometry; acknowledge only verified applied size |
| 0014 display control API | Client public/session/resize/surface APIs and option validators | Live explicit physical capture size and local density, locked-viewer authority, listener cleanup |
| 0015 internal listener isolation | Gateway `app/builders/runtime.rs`, `config/gateway.rs`; upstream `deploy/start-host.sh` | Separate optional admin bind from transport bind; optional CDP proxy disable for colocated MCP |
| 0016 failed-resize state restoration | Host `cdp_video.rs`, `cdp_video/resize_tests.rs` | Attempt restoration of the prior window state even when the intermediate numeric-bounds request fails |
| 0017 browser-owned window resize | Host `cdp_video.rs`, `cdp_video/{resize_tests,browser_resize_tests}.rs` | Keep top-level window commands on a browser-level CDP connection that survives the identifying tab closing |
| 0018 drawable renderer fallback | Client `session-surface-runtime.ts`, `render/session-canvas-factory.ts` | Finalize renderer/context before mounting; replace rejected WebGL canvases with drawable Canvas2D, fail explicitly if neither exists |

Patch names are descriptive; use the actual ordered filenames, not this table,
as the application manifest. The bundle sets the 0015 gateway API bind to loopback
and disables the unused CDP proxy; defaults stay compatible for other upstream
consumers. See [SECURITY.md](SECURITY.md) for the wrapper's trust boundaries.

## Contracts that must travel together

Do not arbitrarily cherry-pick cumulative patches because their concepts look
independent. Later patches refine earlier behavior and depend on its context.

- Host, gateway and client recovery are one contract. The gateway's full-snapshot
  request reuses `CacheMiss { frame_seq: 0, col: 65535, row: 65535, hash: 0 }`.
  An old host does not acquire these semantics just because the wire schema is
  unchanged. Ordinary zero hashes are also valid uncacheable repair metadata.
- A full refresh captures fresh pixels, discards pending pre-snapshot scroll
  copies and sends the grid/draw mode/offset plus every visible row, including
  offset edge coverage. Ordinary cache misses are coalesced into this recovery
  path. The client aborts the failed batch and dependent deltas until a complete
  new snapshot batch, with reconnect as a bounded fallback.
- Lost stateful broadcast commands cannot be safely skipped. Gateway lag closes
  that stream so reconnect requests a new snapshot; it must not silently resume
  later scroll/cache commands.
- Client video ownership from 0003 and backend retirement/repair from 0006 must
  agree. Clearing only a dirty bit is insufficient if a position hash suppresses
  an unchanged tile that still needs to replace a video overlay.
- 0010 keeps content-addressed L2 entries but invalidates both physically moved
  position tables for fractional-row copies. Use it with the residual and client
  integrity fixes, and 0012's later whole-row/static correction. The copy quantum
  defaults to 32; the browser wheel-step default was not changed to 32.
- 0011 aligns requested capture dimensions; 0013 separately checks actual X11
  geometry. Neither alone fixes every mismatch. In particular, libxcvt can name
  a 1360×768 mode while producing 1366 active pixels. The exact-mode helper is
  limited to the virtual DUMMY0 display, not a physical monitor timing override.
  The special case is present in the [libxcvt 0.1.2 source](https://www.x.org/releases/individual/lib/libxcvt-0.1.2.tar.xz),
  `lib/libxcvt.c`, lines 294–299.
- 0014 is backward-compatible opt-in client configuration, not a new remote
  Chromium DPR protocol. Fixed capture sizes remain fixed when local CSS density
  changes. The wrapper controls and their tests are separate tracked files.
- 0016 fixes cleanup after a CDP resize error, independently of the X11-mode
  verification in 0013. It restores only the state this operation temporarily
  changed; normal/minimized windows are not forced maximized. A failed bounds
  request or failed restoration still returns failure. This is not a retry,
  persistent window-state policy, or guarantee that a disconnected CDP peer can
  be restored. The protocol and native resolution acknowledgement are unchanged.
- 0017 resolves the visible page's window ID and prior state before mutation,
  then opens the browser-level `/json/version` WebSocket for window commands.
  Page hints and device emulation remain page-scoped. Browser connection failure
  aborts before normalization; a vanished window returns failure without
  retargeting another window. Keep 0016's restoration-on-error behavior. This
  protects tab closure during resize, not a Chromium-process crash or every
  asynchronous window-manager transition.
- 0018 preserves automatic hardware selection and the Canvas2D software policy.
  A canvas cannot change context type after WebGL creation, even after losing
  that context; all cursor/recording/video/resize consumers must receive the
  final drawable canvas. Real-browser failure injection validates context
  ownership and exact Fill/QOI/Zstd/cache/scroll pixels; it is not a GPU
  performance claim.

The video wire format still has no ownership generation identifier. Immediate
re-entry into the same rectangle can admit an older in-flight frame within that
newly authorized region; the bounded retirement checks are not a new wire-level
ordering guarantee.

## Rebuild and verify from the pin

```sh
npm ci
sh scripts/fetch-upstream.sh
node scripts/audit-upstream.mjs
npm test
npm run test:client
npm run test:linux
```

The fetch refuses to replace an existing nonempty snapshot. Move your generated
tree aside deliberately before regenerating it; never discard local work to make
a test pass. The audit independently extracts the pinned commit into an owned
temporary directory, checks/applies every patch with strict whitespace checking,
and compares all generated source bytes. It does not trust a reverse-only patch
roundtrip. Set `BPANE_UPSTREAM_REPO=/absolute/path/to/a/local/git/checkout` to use
an existing object store read-only instead of fetching the public source again.

For a new patch, save exact pre-edit originals outside the worktree, change only
the selected source/tests, and create a new ordered patch with `a/`/`b/` paths.
New/deleted files require their Git mode metadata; `/dev/null` must never become
an actual path. Run the pristine audit, affected unit/native tests and real pixel
regressions. Update this map and explain dependencies. Do not hand-edit old
patches to hide a newer correction or commit generated `upstream/`.

See [OPTIMIZATIONS.md](OPTIMIZATIONS.md) for bounded historical measurements and
[CONTRIBUTING.md](../CONTRIBUTING.md) for current test commands. Performance
benchmarks are opt-in diagnostics; CI correctness must not rely on Pi-specific
timing thresholds or credentials.
