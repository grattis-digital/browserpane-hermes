// One disposable local browser. Input MUST be the synthetic --video-probe
// fixture (642x362 crop at 14,22), never an operator recording or profile.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const input = process.argv[2];
assert(input, 'Usage: node scripts/check-gpu-video-playback.mjs synthetic-probe.h264');
assert((await stat(input)).size <= 1024 * 1024, 'Fixture exceeds 1 MiB');
const bytes = await readFile(input);
const scratch = await mkdtemp(join(tmpdir(), 'bph-video-playback-'));
let browser;
const server = createServer((_request, response) => {
  response.setHeader('Content-Type', 'text/html');
  response.end('<canvas width="1280" height="720"></canvas>');
});
try {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0,'127.0.0.1',resolve); });
  const bundle = join(scratch, 'fixture.js');
  await build({ stdin: { contents: `
    import { SessionVideoDecoderRuntime } from './upstream/code/web/bpane-client/js/session-video-decoder-runtime.ts';
    import { SessionVideoDisplayRuntime } from './upstream/code/web/bpane-client/js/session-video-display-runtime.ts';
    import { WebGLTileRenderer } from './upstream/code/web/bpane-client/js/webgl-compositor.ts';
    Object.assign(globalThis, { SessionVideoDecoderRuntime, SessionVideoDisplayRuntime, WebGLTileRenderer });
  `, resolveDir: fileURLToPath(new URL('../', import.meta.url)) }, bundle: true, format: 'iife', outfile: bundle });
  browser = await chromium.launch({ headless: true,
    ...(process.env.BPANE_TEST_BROWSER_PATH ? { executablePath: process.env.BPANE_TEST_BROWSER_PATH }
      : { channel: process.env.BPANE_TEST_BROWSER_CHANNEL || 'chrome' }) });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.addScriptTag({ path: bundle });
  const result = await page.evaluate(async (data) => {
    const encoded = Uint8Array.from(data);
    const starts = [];
    for (let i = 0; i + 4 < encoded.length;) {
      const n = encoded[i] === 0 && encoded[i+1] === 0
        ? (encoded[i+2] === 1 ? 3 : encoded[i+2] === 0 && encoded[i+3] === 1 ? 4 : 0) : 0;
      if (n) { starts.push({ at:i, prefix:n }); i += n; } else i++;
    }
    const canvas = document.querySelector('canvas');
    const gl = canvas.getContext('webgl2', { alpha:false, antialias:false, preserveDrawingBuffer:true });
    if (!gl) throw new Error('WebGL2 unavailable');
    const renderer = new globalThis.WebGLTileRenderer(gl);
    renderer.resize(1280,720); renderer.drawFill(0,0,1280,720,31,47,63,1);
    let region = { x:14, y:22, w:642, h:362 }, raf;
    const display = new globalThis.SessionVideoDisplayRuntime({ canvas, ctx:null, glRenderer:renderer,
      getGridConfig:() => ({ tileSize:64, cols:20, rows:12, screenW:1280, screenH:720 }),
      getVideoRegion:() => region, requestAnimationFrameFn:(fn) => { raf=fn; return 1; } });
    display.start();
    let frames=0, dropped=0, failure;
    const decoder = new globalThis.SessionVideoDecoderRuntime({
      onDecodedFrame:(frame,tile) => {
        if (frame.displayWidth !== 642 || frame.displayHeight !== 362) failure='wrong decoded dimensions';
        display.handleDecodedFrame(frame,tile); raf(0); frames++;
      }, incrementFrameCount:() => {}, incrementDroppedFrame:() => { dropped++; },
      onDecoderError:(error) => { failure=error.message; },
    });
    const tile = { tileX:14,tileY:22,tileW:642,tileH:362,screenW:1280,screenH:720 };
    for (let i=0;i<starts.length;i++) {
      const start=starts[i], end=starts[i+1]?.at ?? encoded.length;
      const type=encoded[start.at+start.prefix]&31;
      const before=frames;
      decoder.decodeNal(encoded.slice(start.at,end),tile);
      if (type === 1 || type === 5) {
        const deadline=performance.now()+3000;
        while (frames === before && !failure && performance.now()<deadline) await new Promise(r => setTimeout(r,5));
        if (frames === before || failure) throw new Error(failure || 'video decode timeout');
      }
    }
    const pixels = new Uint8Array(1280*720*4);
    gl.readPixels(0,0,1280,720,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
    let error=0, channels=0, outsideErrors=0;
    for (let y=0;y<720;y++) for (let x=0;x<1280;x++) {
      const at=((719-y)*1280+x)*4;
      if (x>=14 && x<656 && y>=22 && y<384) {
        let color=0x123456;
        if (y%37<17) color=0x315779;
        if (x%83<11) color=0x84a2c6;
        if (y<48) color=0x223344;
        for (let c=0;c<3;c++) { error+=Math.abs(pixels[at+c]-((color>>(8*(2-c)))&255)); channels++; }
      } else if (pixels[at]!==31 || pixels[at+1]!==47 || pixels[at+2]!==63) outsideErrors++;
    }
    // Reliable region exit + repair must not be repainted by cached video.
    region=null; display.clearVideoOverlay(); renderer.drawFill(0,0,1280,720,31,47,63,1);
    display.markDirty(); raf(0);
    gl.readPixels(0,0,1280,720,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
    let repairErrors=0;
    for (let i=0;i<pixels.length;i+=4) if (pixels[i]!==31 || pixels[i+1]!==47 || pixels[i+2]!==63) repairErrors++;
    decoder.destroy(); display.destroy(); renderer.destroy();
    return { frames,dropped,meanAbsoluteRgbError:error/channels,outsideErrors,repairErrors };
  }, [...bytes]);
  assert.equal(result.frames,5); assert.equal(result.dropped,0);
  assert(result.meanAbsoluteRgbError<8, 'Colour/layout error too large for the synthetic hardware fixture');
  assert.equal(result.outsideErrors,0); assert.equal(result.repairErrors,0);
  console.log(JSON.stringify({ scope:'synthetic hardware output -> local real WebCodecs/WebGL viewer', ...result }));
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await rm(scratch, { recursive:true, force:true });
}
