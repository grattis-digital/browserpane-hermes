import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';

// An isolated browser/profile exercises actual WebGL pixels, not mocked calls.
// This is a rendering-correctness check, not a GPU-performance benchmark.
const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const scratch = await mkdtemp(join(tmpdir(), 'bpane-webgl-pixels-'));
let browser;
try {
  const bundlePath = join(scratch, 'fixture.js');
  await build({
    stdin: {
      contents: `
        import { WebGLTileRenderer } from './upstream/code/web/bpane-client/js/webgl-compositor.ts';
        import { SessionSurfaceRuntime } from './upstream/code/web/bpane-client/js/session-surface-runtime.ts';
        import { TileCompositor } from './upstream/code/web/bpane-client/js/tile-compositor.ts';
        Object.assign(globalThis, { WebGLTileRenderer, SessionSurfaceRuntime, TileCompositor });
      `,
      resolveDir: projectRoot,
    },
    bundle: true, format: 'iife', platform: 'browser', outfile: bundlePath,
  });
  browser = await chromium.launch({
    headless: true,
    ...(process.env.BPANE_TEST_BROWSER_PATH
      ? { executablePath: process.env.BPANE_TEST_BROWSER_PATH }
      : { channel: process.env.BPANE_TEST_BROWSER_CHANNEL || 'chrome' }),
  });
  const page = await browser.newPage();
  await page.setContent('<canvas id="screen" width="8" height="8"></canvas>');
  await page.addScriptTag({ path: bundlePath });
  const result = await page.evaluate(async () => {
    const canvas = document.querySelector('canvas');
    const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, preserveDrawingBuffer: true });
    if (!gl) throw new Error('WebGL2 unavailable');
    let uploads = 0;
    const originalUpload = gl.texImage2D.bind(gl);
    gl.texImage2D = (...args) => { uploads++; return originalUpload(...args); };
    const renderer = new globalThis.WebGLTileRenderer(gl);
    const contextInfo = renderer.getContextInfo();

    function blank(width, height) {
      const pixels = new Uint8Array(width * height * 4);
      for (let i = 3; i < pixels.length; i += 4) pixels[i] = 255;
      return pixels;
    }
    function paint(target, stride, x, y, source) {
      for (let sy = 0; sy < source.height; sy++) for (let sx = 0; sx < source.width; sx++) {
        target.set(source.data.subarray((sy * source.width + sx) * 4, (sy * source.width + sx + 1) * 4), ((y + sy) * stride + x + sx) * 4);
      }
    }
    function mismatches(width, height, expected) {
      const raw = new Uint8Array(expected.length);
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, raw);
      let count = 0;
      for (let y = 0; y < height; y++) for (let x = 0; x < width * 4; x++) {
        if (raw[(height - y - 1) * width * 4 + x] !== expected[y * width * 4 + x]) count++;
      }
      return count;
    }

    renderer.resize(8, 8);
    renderer.drawFill(0, 0, 8, 8, 0, 0, 0, 1);
    const expected = blank(8, 8);
    const data = new ImageData(new Uint8ClampedArray([
      255, 0, 0, 255, 0, 255, 0, 255,
      0, 0, 255, 255, 255, 255, 255, 255,
    ]), 2, 2);
    renderer.drawTileImageData(1, 1, 2, 2, data); paint(expected, 8, 1, 1, data);
    renderer.drawTileImageData(4, 4, 2, 2, data); paint(expected, 8, 4, 4, data);
    const cachedTileUploads = uploads;

    const beforeScroll = expected.slice();
    renderer.scrollCopy(0, -2, 1, 7, 7, 8, 8);
    for (let y = 3; y < 7; y++) for (let x = 0; x < 7; x++) {
      expected.set(beforeScroll.subarray(((y - 2) * 8 + x) * 4, ((y - 2) * 8 + x + 1) * 4), (y * 8 + x) * 4);
    }
    renderer.drawFill(1, 3, 1, 1, 255, 255, 0, 1);
    expected.set([255, 255, 0, 255], (3 * 8 + 1) * 4);

    // Mutable canvas/video sources must not accidentally use tile retention.
    const mutable = document.createElement('canvas'); mutable.width = mutable.height = 1;
    const ctx = mutable.getContext('2d');
    ctx.fillStyle = '#00ffff'; ctx.fillRect(0, 0, 1, 1);
    renderer.drawTexImageSource(7, 0, 1, 1, mutable); expected.set([0, 255, 255, 255], 7 * 4);
    ctx.fillStyle = '#ff00ff'; ctx.fillRect(0, 0, 1, 1);
    renderer.drawTexImageSource(7, 1, 1, 1, mutable); expected.set([255, 0, 255, 255], (8 + 7) * 4);
    renderer.drawTileImageData(0, 0, 2, 2, data); paint(expected, 8, 0, 0, data);
    const mismatchedChannels = mismatches(8, 8, expected);

    canvas.width = 10;
    canvas.height = 8;
    renderer.resize(10, 8);
    renderer.clearTileCache();
    renderer.drawFill(0, 0, 10, 8, 0, 0, 0, 1);
    const beforeReupload = uploads;
    renderer.drawTileImageData(8, 6, 2, 2, data);
    const resizedExpected = blank(10, 8);
    paint(resizedExpected, 10, 8, 6, data);
    const resizedMismatchedChannels = mismatches(10, 8, resizedExpected);
    const resetReuploads = uploads - beforeReupload;
    const glError = gl.getError();
    renderer.destroy();

    // Exercise the actual browser context-loss event and session recovery hook.
    const container = document.createElement('div');
    container.style.cssText = 'width:64px;height:64px';
    document.body.appendChild(container);
    let surfaceGl;
    let notifyLoss;
    const lost = new Promise((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error('context-loss callback timeout')), 5000);
      notifyLoss = (error) => { clearTimeout(deadline); resolve(error.message); };
    });
    const surface = new globalThis.SessionSurfaceRuntime({
      container, tileCompositor: new globalThis.TileCompositor(), hiDpi: false,
      onTileCacheMiss: () => {}, sendResizeRequest: () => {}, setRemoteSize: () => {},
      onRenderError: notifyLoss,
      createWebGLRenderer: (target) => {
        surfaceGl = target.getContext('webgl2', { alpha: false, antialias: false, preserveDrawingBuffer: true });
        if (!surfaceGl) throw new Error('second WebGL2 context unavailable');
        const forced = new globalThis.WebGLTileRenderer(surfaceGl);
        // Bypass selection only for deterministic WebGL correctness coverage;
        // renderer selection and software fallback are covered by unit tests.
        return { renderer: forced, diagnostics: { ...forced.getContextInfo(), backend: 'webgl2', reason: 'hardware-accelerated' } };
      },
    });
    const extension = surfaceGl.getExtension('WEBGL_lose_context');
    if (!extension) throw new Error('WEBGL_lose_context test extension unavailable');
    extension.loseContext();
    const contextLoss = await lost;
    surface.destroy();
    container.remove();
    return { contextInfo, cachedTileUploads, mismatchedChannels, resizedMismatchedChannels, resetReuploads, glError, contextLoss };
  });
  assert.equal(result.cachedTileUploads, 1);
  assert.equal(result.mismatchedChannels, 0);
  assert.equal(result.resizedMismatchedChannels, 0);
  assert.equal(result.resetReuploads, 1);
  assert.equal(result.glError, 0);
  assert.equal(result.contextLoss, 'WebGL rendering context lost');
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser?.close();
  await rm(scratch, { recursive: true, force: true });
}
