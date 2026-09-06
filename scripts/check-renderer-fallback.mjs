// Real canvas context ownership and pixels; only failure/renderer metadata is
// injected. No network, production profile, GPU policy flag or performance claim.
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const source = resolve(process.env.BPANE_TEST_CLIENT_SOURCE ?? 'upstream/code/web/bpane-client/js');
const bundle = await build({ stdin: { contents: `
  export { SessionSurfaceRuntime } from ${JSON.stringify(source + '/session-surface-runtime.ts')};
  export { TileCompositor } from ${JSON.stringify(source + '/tile-compositor.ts')};
`, resolveDir: process.cwd() }, bundle: true, write: false, format: 'iife', globalName: 'Fixture', platform: 'browser' });
const browser = await chromium.launch({ headless: true,
  ...(process.env.BPANE_TEST_BROWSER_PATH ? { executablePath: process.env.BPANE_TEST_BROWSER_PATH }
    : { channel: process.env.BPANE_TEST_BROWSER_CHANNEL || 'chrome' }) });
try {
  const results = [];
  for (const failure of ['software', 'metadata-error', 'initialization-error', 'no-2d']) {
    const page = await browser.newPage();
    try {
      await page.setContent('<div id="screen" style="width:64px;height:64px"><span>Keep</span></div>');
      await page.addScriptTag({ content: bundle.outputFiles[0].text });
      const result = await page.evaluate(async failure => {
        const originalContext = HTMLCanvasElement.prototype.getContext;
        const originalParameter = WebGL2RenderingContext.prototype.getParameter;
        const container = document.querySelector('#screen'), before = container.innerHTML;
        let realContexts = 0, observes = 0, surface;
        HTMLCanvasElement.prototype.getContext = function (type, attrs) {
          if (failure === 'no-2d' && type === '2d') return null;
          // Keep native context ownership. Make the branch deterministic even
          // if this test machine correctly rejects software at the caveat gate.
          const context = originalContext.call(this, type, type === 'webgl2'
            ? { ...attrs, failIfMajorPerformanceCaveat: false } : attrs);
          if (type === 'webgl2' && context) realContexts++;
          return context;
        };
        WebGL2RenderingContext.prototype.getParameter = function (parameter) {
          if (parameter === this.RENDERER && failure === 'metadata-error') throw new Error('Synthetic metadata failure');
          if (parameter === this.RENDERER || parameter === 0x9246) return 'ANGLE (synthetic SwiftShader renderer)';
          if (parameter === this.VENDOR || parameter === 0x9245) return 'Google Inc.';
          return originalParameter.call(this, parameter);
        };
        try {
          const compositor = new Fixture.TileCompositor();
          const input = { container, tileCompositor: compositor, hiDpi: false,
            onTileCacheMiss() { throw new Error('Unexpected missing test tile'); },
            sendResizeRequest() {}, setRemoteSize() {},
            createResizeObserver: () => ({ observe() { observes++; }, disconnect() {} }) };
          if (failure === 'initialization-error') input.createWebGLRenderer = canvas => {
            if (!canvas.getContext('webgl2')) throw new Error('Real WebGL unavailable');
            throw new Error('Synthetic shader initialization failure');
          };
          try { surface = new Fixture.SessionSurfaceRuntime(input); }
          catch (error) {
            return { failure, error: error.message, realContexts, observes, unchanged: container.innerHTML === before };
          }
          const canvas = surface.getCanvas(), ctx = canvas.getContext('2d');
          if (!ctx) return { failure, realContexts, drawable: false, diagnostics: surface.getRenderDiagnostics() };
          canvas.width = canvas.height = 8;
          compositor.processCommand({ type: 'grid-config', config: { tileSize: 1, cols: 8, rows: 8, screenW: 8, screenH: 8 } });
          const expected = new Uint8Array(8 * 8 * 4);
          const paint = (x, y, pixel) => expected.set(pixel, (y * 8 + x) * 4);
          for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
            const pixel = [x * 24, y * 24, 80, 255]; paint(x, y, pixel);
            compositor.processCommand({ type: 'fill', col: x, row: y, rgba: (255 << 24) | (80 << 16) | (pixel[1] << 8) | pixel[0] });
          }
          const pixel = [17, 34, 51, 255];
          const qoi = new Uint8Array([113, 111, 105, 102, 0, 0, 0, 1, 0, 0, 0, 1, 4, 0, 255, ...pixel, 0, 0, 0, 0, 0, 0, 0, 1]);
          // A one-pixel, single-segment Zstd frame with one final raw block.
          const zstd = new Uint8Array([0x28, 0xb5, 0x2f, 0xfd, 0x20, 4, 0x21, 0, 0, ...pixel]);
          compositor.processCommand({ type: 'qoi', col: 1, row: 1, hash: 1n, data: qoi }); paint(1, 1, pixel);
          compositor.processCommand({ type: 'zstd', col: 2, row: 1, hash: 2n, data: zstd }); paint(2, 1, pixel);
          compositor.processCommand({ type: 'cache-hit', col: 3, row: 1, hash: 1n }); paint(3, 1, pixel);
          compositor.processCommand({ type: 'batch-end', frameSeq: 1 });
          await compositor.tileBatchSequencer.flush();
          const beforeCopy = expected.slice();
          for (let y = 2; y < 8; y++) for (let x = 0; x < 8; x++) paint(x, y, beforeCopy.subarray(((y - 2) * 8 + x) * 4, ((y - 2) * 8 + x + 1) * 4));
          compositor.processCommand({ type: 'scroll-copy', dx: 0, dy: -2, regionTop: 0, regionBottom: 8, regionRight: 8 });
          compositor.processCommand({ type: 'batch-end', frameSeq: 2 });
          await compositor.tileBatchSequencer.flush();
          const actual = ctx.getImageData(0, 0, 8, 8).data;
          return { failure, drawable: true, realContexts, diagnostics: surface.getRenderDiagnostics(),
            mismatchedChannels: actual.reduce((count, value, index) => count + Number(value !== expected[index]), 0),
            counts: { qoi: compositor.stats.qoiDecodes, zstd: compositor.stats.zstdDecodes,
              fills: compositor.stats.fills, cacheHits: compositor.stats.cacheHits, copies: compositor.stats.scrollCopies } };
        } finally {
          surface?.destroy();
          HTMLCanvasElement.prototype.getContext = originalContext;
          WebGL2RenderingContext.prototype.getParameter = originalParameter;
        }
      }, failure);
      results.push(result);
      assert(result.realContexts > 0, 'Regression requires a real browser WebGL context');
      if (failure === 'no-2d') {
        assert.equal(result.error, 'Canvas2D rendering context unavailable');
        assert.equal(result.unchanged, true); assert.equal(result.observes, 0);
      } else {
        assert.equal(result.drawable, true, JSON.stringify(result));
        assert.equal(result.diagnostics.backend, 'canvas2d');
        assert.equal(result.diagnostics.reason, failure === 'software' ? 'software-renderer' : 'initialization-failed');
        assert.equal(result.mismatchedChannels, 0);
        assert.deepEqual(result.counts, { qoi: 1, zstd: 1, fills: 64, cacheHits: 1, copies: 1 });
      }
    } finally { await page.close(); }
  }
  console.log(JSON.stringify({ browser: browser.version(), results }, null, 2));
} finally { await browser.close(); }
