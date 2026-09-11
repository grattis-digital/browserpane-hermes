import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';

// Exactly one disposable browser/page; no Pi, shared session or user profile.
const bundle = await build({ stdin: { contents: `
  import { GpuUpscaler } from './client/enhancement/gpu-upscaler.ts';
  import { DamageGrid } from './client/enhancement/damage-grid.ts';
  import { EnhancementController } from './client/enhancement/enhancement-controller.ts';
  import { WebGLTileRenderer } from './upstream/code/web/bpane-client/js/webgl-compositor.ts';
  import { upscaleReference } from './scripts/smart-upscale-oracle.mjs';
  import balanced from './client/enhancement/model/cnn-2x-s.json';
  import quality from './client/enhancement/model/cnn-2x-m.json';
  Object.assign(globalThis, { GpuUpscaler, DamageGrid, EnhancementController, WebGLTileRenderer, upscaleReference,
    models: { balanced, quality } });
`, resolveDir: process.cwd() }, bundle: true, write: false, platform: 'browser', format: 'iife' });
const style = await readFile('client/style.css', 'utf8');
const server = createServer((request, response) => {
  response.setHeader('Content-Type', request.url === '/fixture.js' ? 'text/javascript' : 'text/html');
  response.end(request.url === '/fixture.js' ? bundle.outputFiles[0].text : `<!doctype html>
    <style>${style} #screen {width:720px;height:400px} canvas {width:100%;height:100%}</style>
    <select id="enhancement"><option value="original">Original</option><option value="smart">Balanced</option>
      <option value="smart-quality">Quality</option></select>
    <span id="enhancement-status"></span><div id="screen"><canvas width="129" height="131"></canvas></div>
    <script src="/fixture.js"></script>`);
});
let browser;
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  browser = await chromium.launch({ headless: true, ...(process.env.BPANE_TEST_BROWSER_PATH
    ? { executablePath: process.env.BPANE_TEST_BROWSER_PATH } : { channel: 'chrome' }) });
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 }, deviceScaleFactor: 2 });
  const pageErrors = []; page.on('pageerror', error => pageErrors.push(error.message));
  const requests = []; page.on('request', request => requests.push(new URL(request.url()).hostname));
  const results = [], proofs = [];
  for (const mode of ['balanced', 'quality']) {
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const result = await page.evaluate(async mode => {
    const model = models[mode];
    const failures = [];
    const source = document.querySelector('canvas');
    const gl = source.getContext('webgl2', { alpha: false, antialias: false, preserveDrawingBuffer: true });
    if (!gl) throw Error('WebGL2 unavailable');
    const renderer = new WebGLTileRenderer(gl);
    renderer.resize(source.width, source.height);
    const fixture = document.createElement('canvas'); fixture.width = source.width; fixture.height = source.height;
    const paint = fixture.getContext('2d');
    paint.fillStyle = '#faf8f2'; paint.fillRect(0, 0, source.width, source.height);
    paint.font = '14px sans-serif'; paint.fillStyle = '#193358'; paint.fillText('Browser 123', 5, 23);
    paint.fillStyle = '#f03058'; paint.fillRect(65, 40, 63, 32);
    paint.fillStyle = '#35c788'; paint.fillRect(2, 70, 64, 59);
    paint.fillStyle = '#193358'; paint.font = '10px sans-serif'; paint.fillText('Il1 O0 fi 8B', 5, 110);
    paint.strokeStyle = '#2757a3'; paint.lineWidth = 1;
    paint.beginPath(); paint.moveTo(90, 72); paint.lineTo(129, 131); paint.stroke();
    paint.font = '11px sans-serif'; paint.fillText('edge', 107, 128);
    const input = paint.getImageData(0, 0, source.width, source.height);
    renderer.drawTileImageData(0, 0, source.width, source.height, input);
    const raw = () => { const bytes = new Uint8Array(source.width * source.height * 4);
      gl.readPixels(0, 0, source.width, source.height, gl.RGBA, gl.UNSIGNED_BYTE, bytes); return bytes; };
    const before = raw();
    const setupStart = performance.now();
    const gpu = await GpuUpscaler.create(message => failures.push(message), undefined, mode);
    const setupMs = performance.now() - setupStart;
    const output = document.createElement('canvas'); output.width = source.width * 2; output.height = source.height * 2;
    const context = output.getContext('2d');
    const bitmap = await gpu.render(source, { x: 0, y: 0, w: source.width, h: source.height });
    context.drawImage(bitmap, 0, 0); bitmap.close();
    const whole = context.getImageData(0, 0, output.width, output.height).data;
    const reference = upscaleReference(input.data, source.width, source.height, model);
    let maxReferenceDifference = 0, transparent = 0;
    for (let i = 0; i < whole.length; i++) {
      maxReferenceDifference = Math.max(maxReferenceDifference, Math.abs(whole[i] - reference[i]));
      if (i % 4 === 3 && whole[i] !== 255) transparent++;
    }
    // Repeated same crop: warm patch latency, including browser scheduling/fence.
    const warmPatchMs = [];
    for (let index = 0; index < 44; index++) {
      const start = performance.now();
      const bitmap = await gpu.render(source, { x: 0, y: 0, w: source.width, h: source.height });
      const elapsed = performance.now() - start; bitmap.close();
      if (index >= 4) warmPatchMs.push(elapsed);
    }
    warmPatchMs.sort((a, b) => a - b);
    context.clearRect(0, 0, output.width, output.height);
    const grid = new DamageGrid(source.width, source.height);
    grid.invalidate({ x: 0, y: 0, w: source.width, h: source.height }, 'tile', 0);
    const times = [];
    for (let job; (job = grid.next(100));) {
      const start = performance.now();
      const tile = await gpu.render(source, job.input);
      times.push(performance.now() - start);
      const { input, output: rect } = job;
      context.drawImage(tile, (rect.x - input.x) * 2, (rect.y - input.y) * 2, rect.w * 2, rect.h * 2,
        rect.x * 2, rect.y * 2, rect.w * 2, rect.h * 2);
      tile.close();
    }
    const tiled = context.getImageData(0, 0, output.width, output.height).data;
    let maxSeamDifference = 0;
    for (let i = 0; i < whole.length; i++) maxSeamDifference = Math.max(maxSeamDifference, Math.abs(whole[i] - tiled[i]));
    const after = raw();
    const unchanged = before.every((value, index) => value === after[index]);
    gpu.destroy();
    // Real controller path: no initialization off, coalescing, local overlay, raw video bypass.
    const controller = EnhancementController.mount(); controller.attach(source);
    await new Promise(resolve => requestAnimationFrame(resolve));
    const offHadOverlay = Boolean(document.querySelector('.smart-upscale-overlay'));
    const select = document.querySelector('#enhancement');
    select.value = mode === 'quality' ? 'smart-quality' : 'smart'; select.dispatchEvent(new Event('change'));
    const waitFor = async predicate => { const start = performance.now();
      while (!predicate()) { if (performance.now() - start > 12000) throw Error(`Controller timeout: ${JSON.stringify(controller.diagnostics())}`);
        await new Promise(resolve => setTimeout(resolve, 20)); } };
    await waitFor(() => controller.diagnostics().stats?.completed >= 4);
    const overlay = document.querySelector('.smart-upscale-overlay');
    const overlayContext = overlay.getContext('2d');
    const sourceRect = source.getBoundingClientRect();
    const inputPassThrough = getComputedStyle(overlay).pointerEvents === 'none'
      && document.elementFromPoint(sourceRect.x + sourceRect.width / 2, sourceRect.y + sourceRect.height / 2) === source;
    const beforeVideo = overlayContext.getImageData(2, 2, 1, 1).data[3];
    renderer.drawTexImageSource(0, 0, source.width, source.height, fixture);
    const afterVideo = overlayContext.getImageData(2, 2, 1, 1).data[3];
    // Qualify a realistic 720p viewer separately from the small pixel oracle.
    const large = document.createElement('canvas'); large.width = 1280; large.height = 720;
    const text = large.getContext('2d');
    text.fillStyle = '#f7f9fc'; text.fillRect(0, 0, 1280, 720);
    text.fillStyle = '#183451'; text.font = '18px sans-serif';
    for (let row = 0; row < 25; row++) text.fillText(`Synthetic browser row ${row} · Text, 123456789 and line art`, 24, 30 + row * 27);
    source.width = 1280; source.height = 720;
    source.parentElement.style.width = '1280px'; source.parentElement.style.height = '720px';
    renderer.resize(1280, 720); renderer.drawTileImageData(0, 0, 1280, 720, text.getImageData(0, 0, 1280, 720));
    const settleStart = performance.now();
    await waitFor(() => controller.diagnostics().stats?.completed >= 60 && controller.diagnostics().stats?.pending === 0);
    const settle720pMs = performance.now() - settleStart;
    const diagnostics = controller.diagnostics();
    select.value = 'original'; select.dispatchEvent(new Event('change'));
    const offRemovedOverlay = !document.querySelector('.smart-upscale-overlay');
    controller.destroy(); renderer.destroy();
    return { mode, setupMs, patchMs: times, warmPatchP50Ms: (warmPatchMs[19] + warmPatchMs[20]) / 2, warmPatchP95Ms: warmPatchMs[37],
      maxReferenceDifference, maxSeamDifference, transparent, unchanged,
      offHadOverlay, beforeVideo, afterVideo, offRemovedOverlay, failures, diagnostics, settle720pMs,
      webgl: renderer.getContextInfo(), inputPassThrough,
      proof: { original: fixture.toDataURL(), enhanced: output.toDataURL() } };
  }, mode);
  assert(result.maxReferenceDifference <= 2, JSON.stringify(result));
  assert.equal(result.maxSeamDifference, 0); assert.equal(result.transparent, 0); assert(result.unchanged);
  assert(!result.offHadOverlay); assert.equal(result.beforeVideo, 255); assert.equal(result.afterVideo, 0);
  assert(result.offRemovedOverlay); assert.deepEqual(result.failures, []); assert.deepEqual(pageErrors, []);
  assert(result.inputPassThrough, 'Enhancement intercepted viewer input');
  const { proof, ...metrics } = result; proofs.push(proof); results.push(metrics);
  }
  assert(requests.every(host => host === '127.0.0.1'), 'Enhancement made an external request');
  assert.notEqual(proofs[0].enhanced, proofs[1].enhanced, 'Quality must run a distinct model');
  await page.evaluate(async proofs => {
    const proof = document.createElement('div'); proof.id = 'upscale-proof';
    proof.style.cssText = 'display:flex;gap:20px;padding:20px;background:#202b3c;width:max-content;flex:none';
    for (const [label, url] of [['Original · bilinear 2×', proofs[0].original],
      ['Smart 2× · Balanced', proofs[0].enhanced], ['Smart 2× · Quality', proofs[1].enhanced]]) {
      const image = new Image(); image.src = url; await image.decode();
      const box = document.createElement('div'); const title = document.createElement('p'); title.textContent = label;
      const canvas = document.createElement('canvas'); canvas.width = 258; canvas.height = 262;
      canvas.style.cssText = `display:block;width:${canvas.width}px;height:${canvas.height}px`;
      canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
      box.append(title, canvas); proof.append(box);
    }
    document.body.replaceChildren(proof);
  }, proofs);
  if (process.env.BPANE_UPSCALE_PROOF_PATH) await page.locator('#upscale-proof').screenshot({ path: process.env.BPANE_UPSCALE_PROOF_PATH });
  console.log(JSON.stringify({ qualification: 'local synthetic GPU, not Raspberry Pi capture or universal quality', results }, null, 2));
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
