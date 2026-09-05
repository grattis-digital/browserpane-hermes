import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

// This qualification is local and disposable, with no operator browser/profile.
const containerName = 'browserpane-pipeline-viewer';
const viewerUrl = 'http://localhost:18090/browser/';
const outputDir = fileURLToPath(new URL('../test-results', import.meta.url));
const inspect = JSON.parse(execFileSync('docker', ['inspect', containerName], { encoding: 'utf8' }))[0];
assert.equal(inspect.Config.Labels?.['browserpane.test'], 'pipeline', 'Refusing a non-test container');
assert.equal(inspect.State.Running, true);
assert(inspect.Config.Env.includes('BPANE_PIPELINE_TEST=1'), 'Missing disposable runtime guard');
assert.deepEqual(inspect.Mounts, [], 'Persistent/shared mounts are not allowed');
for (const bindings of Object.values(inspect.HostConfig.PortBindings ?? {})) {
  for (const binding of bindings ?? []) assert.equal(binding.HostIp, '127.0.0.1', 'Ports must be loopback-only');
}
assert(inspect.HostConfig.PortBindings?.['8090/tcp']?.some(binding => binding.HostPort === '18090'));
const containerId = inspect.Id; // All subsequent commands pin this exact inspected container.
const token = randomUUID();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
await mkdir(outputDir, { recursive: true });

const remoteSource = `
import assert from 'node:assert/strict';
assert.equal(process.env.BPANE_PIPELINE_TEST, '1');
const task=JSON.parse(process.env.BPANE_DISPLAY_CHECK_TASK);
const endpoint=await fetch('http://127.0.0.1:9222/json/version').then(r=>r.json());
const socket=new WebSocket(endpoint.webSocketDebuggerUrl);
await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
let sequence=0;const pending=new Map();
socket.addEventListener('message',event=>{
 const message=JSON.parse(event.data),request=pending.get(message.id);if(!request)return;
 pending.delete(message.id);clearTimeout(request.timeout);
 if(message.error)request.reject(new Error(JSON.stringify(message.error)));else request.resolve(message.result);
});
function call(method,params={},sessionId){return new Promise((resolve,reject)=>{
 const id=++sequence,timeout=setTimeout(()=>{pending.delete(id);reject(new Error('CDP timeout: '+method));},12000);
 pending.set(id,{resolve,reject,timeout});socket.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}));
});}
let created;
try{
 const targetId=task.op==='create'?(await call('Target.createTarget',{url:'about:blank'})).targetId:task.targetId;
 if(task.op==='create')created=targetId;
 const {sessionId}=await call('Target.attachToTarget',{targetId,flatten:true});
 if(task.op!=='create'){
  const marker=await call('Runtime.evaluate',{expression:'window.__displayFixtureToken',returnByValue:true},sessionId);
  assert.equal(marker.result.value,task.token,'Refusing an unowned CDP tab');
 }
 let output;
 if(task.op==='close')output=await call('Target.closeTarget',{targetId});
 else if(task.op==='metadata'){
  output={bounds:(await call('Browser.getWindowForTarget',{targetId})).bounds,
   browserProcess:(await call('SystemInfo.getProcessInfo')).processInfo.find(p=>p.type==='browser')};
  await call('Target.detachFromTarget',{sessionId});
 }else{
  const result=await call('Runtime.evaluate',{expression:task.expression,returnByValue:true,awaitPromise:true},sessionId);
  if(result.exceptionDetails)throw new Error(JSON.stringify(result.exceptionDetails));
  output=task.op==='create'?{targetId,result:result.result.value}:result.result.value;
  await call('Page.bringToFront',{},sessionId);
 }
 process.stdout.write(JSON.stringify(output));
}catch(error){if(created)await call('Target.closeTarget',{targetId:created}).catch(()=>{});throw error;}
finally{socket.close();}
`;
let targetId, browser, page, secondPage;
function remote(op, fn) {
  const task = { op, targetId, token, expression: fn ? `(${fn.toString()})(${JSON.stringify(token)})` : undefined };
  return JSON.parse(execFileSync('docker', ['exec', '-i', '-e', `BPANE_DISPLAY_CHECK_TASK=${JSON.stringify(task)}`,
    containerId, 'node', '--input-type=module', '-'], {
    input: remoteSource, encoding: 'utf8', timeout: 20000, maxBuffer: 8 * 1024 * 1024,
  }));
}
function x11Size() {
  const output = execFileSync('docker', ['exec', containerId, 'xrandr', '--current'], { encoding: 'utf8', timeout: 10000 });
  const match = output.match(/\bcurrent\s+(\d+)\s+x\s+(\d+)\b/);
  assert(match, 'Missing native X11 dimensions');
  return { width: Number(match[1]), height: Number(match[2]) };
}
function x11Pixels(width, height) {
  assert(Number.isInteger(width) && Number.isInteger(height) && width >= 320 && width <= 3840 && height >= 200 && height <= 2160);
  const pixels = execFileSync('docker', ['exec', containerId, 'ffmpeg', '-hide_banner', '-loglevel', 'error',
    '-f', 'x11grab', '-draw_mouse', '0', '-video_size', `${width}x${height}`, '-i', ':99+0,0',
    '-frames:v', '1', '-threads', '1', '-pix_fmt', 'rgba', '-f', 'rawvideo', 'pipe:1'],
  { timeout: 15000, maxBuffer: 40 * 1024 * 1024 });
  assert.equal(pixels.length, width * height * 4);
  return pixels;
}
const stages = [], pageErrors = [], downloads = [], consoleErrors = [], httpErrors = [];
const report = { containerName, containerId, imageId: inspect.Image, image: inspect.Config.Image,
  viewerUrl, stages, pageErrors, downloads, consoleErrors, httpErrors };
function observe(viewer, label) {
  viewer.on('pageerror', error => pageErrors.push(`${label}: ${error.message}`));
  viewer.on('console', message => {
    if (message.type() === 'error') consoleErrors.push(`${label}: ${message.text().replace(/([?&](?:session_ticket|access_token|token)=)[^&\s]+/g, '$1[redacted]')}`);
  });
  viewer.on('download', download => { downloads.push(download.suggestedFilename()); void download.cancel().catch(() => {}); });
  viewer.on('response', response => {
    if (response.status() < 400) return;
    const url = new URL(response.url());
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return;
    // All query values are omitted, not merely known token parameter names.
    httpErrors.push({ viewer: label, status: response.status(),
      url: url.origin + url.pathname + (url.search ? '?[redacted]' : '') });
  });
}
async function newViewer(viewport = { width: 1440, height: 1000 }) {
  const viewer = await browser.newPage({ viewport, deviceScaleFactor: 2 });
  await viewer.addInitScript(() => {
    window.__displayTransportCount = 0;
    const NativeTransport = window.WebTransport;
    window.WebTransport = class extends NativeTransport {
      constructor(...args) { super(...args); window.__displayTransportCount++; }
    };
  });
  observe(viewer, page ? 'secondary' : 'primary');
  return viewer;
}
async function ready(viewer = page) {
  await viewer.waitForFunction(() => {
    const session = window.browserpaneSession, stats = session?.getTileCacheStats();
    return session && document.querySelector('#status')?.textContent.startsWith('Connected')
      && stats.qoiDecodes + stats.zstdDecodes > 0;
  }, undefined, { timeout: 45000 });
}
async function instrument(viewer = page) {
  await viewer.evaluate(() => {
    const session = window.browserpaneSession;
    window.__displayOriginalSession = session;
    window.__displayOriginalTransportCount = window.__displayTransportCount;
    window.__displayResizeRequests = [];
    const original = session.sendResizeRequest;
    session.sendResizeRequest = function (width, height) {
      window.__displayResizeRequests.push({ width, height });
      return original.call(this, width, height);
    };
  });
}
async function state(viewer = page) {
  return viewer.evaluate(() => {
    const canvas = document.querySelector('#screen canvas'), cursor = document.querySelectorAll('#screen canvas')[1];
    const box = element => { const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
    const session = window.browserpaneSession;
    if (!canvas || !cursor || !session) return { hasSurface: false, status: document.querySelector('#status')?.textContent,
      transportCount: window.__displayTransportCount, resizeRequests: window.__displayResizeRequests };
    return { display: session.getDisplayState(), physical: { width: canvas.width, height: canvas.height },
      preferred: session.surfaceRuntime.getContainerResizeDims(), canvas: box(canvas), cursor: box(cursor),
      viewport: box(document.querySelector('#viewport')), screen: box(document.querySelector('#screen')),
      resolution: document.querySelector('#resolution').value, density: document.querySelector('#density').value,
      resolutionDisabled: document.querySelector('#resolution').disabled, densityDisabled: document.querySelector('#density').disabled,
      summary: document.querySelector('#display-summary').textContent, renderer: session.getRenderDiagnostics(),
      fullscreen: Boolean(document.fullscreenElement), fullscreenPressed: document.querySelector('#fullscreen').getAttribute('aria-pressed'),
      sameSession: session === window.__displayOriginalSession,
      sameTransport: window.__displayTransportCount === window.__displayOriginalTransportCount,
      resizeRequests: window.__displayResizeRequests, dpr: devicePixelRatio };
  });
}
function assertLayout(result) {
  const { canvas: c, viewport: v, cursor, screen, physical: p } = result;
  assert(c.width > 0 && c.height > 0, 'Canvas is hidden');
  assert(Math.abs(c.width * p.height / p.width - c.height) < 0.06, 'Capture is stretched');
  assert(c.x >= v.x - 0.05 && c.y >= v.y - 0.05 && c.x + c.width <= v.x + v.width + 0.05
    && c.y + c.height <= v.y + v.height + 0.05, 'Viewport crops part of the capture');
  assert(Math.abs(c.x + c.width / 2 - v.x - v.width / 2) < 0.05, 'Capture is not horizontally centered');
  assert(Math.abs(c.y + c.height / 2 - v.y - v.height / 2) < 0.05, 'Capture is not vertically centered');
  for (const key of ['x', 'y', 'width', 'height']) {
    assert(Math.abs(c[key] - cursor[key]) < 0.05, `Cursor ${key} disagrees with canvas`);
    assert(Math.abs(c[key] - screen[key]) < 0.05, `Screen ${key} disagrees with canvas`);
  }
}
async function geometry(width, height, viewer = page) {
  let latest;
  for (let i = 0; i < 60; i++) {
    latest = await state(viewer);
    assert.notEqual(latest.hasSurface, false, `Viewer lost its rendering session during resize: ${JSON.stringify(latest)}`);
    const physical = x11Size();
    if (latest.physical.width === width && latest.physical.height === height
      && latest.display.width === width && latest.display.height === height
      && physical.width === width && physical.height === height) {
      const metadata = remote('metadata');
      if (metadata.bounds.width === width && metadata.bounds.height === height) {
        assertLayout(latest); return { ...latest, native: physical, chrome: metadata };
      }
    }
    await delay(150);
  }
  assert.fail(`Physical/canvas geometry did not settle at ${width}×${height}: ${JSON.stringify(latest)}`);
}
async function viewerPixels(viewer = page) {
  return viewer.evaluate(async () => {
    await window.browserpaneSession.tileCompositor.tileBatchSequencer.flush();
    const canvas = document.querySelector('#screen canvas'), { width, height } = canvas;
    const gl = canvas.getContext('webgl2');
    let pixels;
    if (gl) {
      const bottomUp = new Uint8Array(width * height * 4); pixels = new Uint8Array(bottomUp.length);
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, bottomUp);
      for (let y = 0; y < height; y++) pixels.set(bottomUp.subarray((height - y - 1) * width * 4, (height - y) * width * 4), y * width * 4);
    } else pixels = canvas.getContext('2d').getImageData(0, 0, width, height).data;
    const markerRows = [];
    for (let y = 0; y < height; y++) {
      const i = (y * width + 8) * 4;
      if (pixels[i] === 207 && pixels[i + 1] === 22 && pixels[i + 2] === 206) markerRows.push(y);
    }
    let binary = '';
    for (let i = 0; i < pixels.length; i += 32768) binary += String.fromCharCode(...pixels.subarray(i, i + 32768));
    return { width, height, data: btoa(binary), markerTop: markerRows[0], markerHeight: markerRows.length };
  });
}
async function pixelCheckpoint(name, viewer = page, saveRaw = false) {
  remote('eval', () => { document.activeElement?.blur(); return true; });
  await delay(450);
  let result;
  for (let attempt = 0; attempt < 8; attempt++) {
    const before = await viewerPixels(viewer), size = x11Size();
    assert.deepEqual({ width: before.width, height: before.height }, size, 'Pixel oracle cannot compare a cropped subrectangle');
    const reference = x11Pixels(size.width, size.height);
    const after = await viewerPixels(viewer), referenceAfter = x11Pixels(size.width, size.height);
    if (after.width !== size.width || after.height !== size.height || !reference.equals(referenceAfter)) { await delay(200); continue; }
    const actual = Buffer.from(after.data, 'base64');
    assert.equal(actual.length, reference.length, 'Truncated viewer framebuffer');
    let mismatches = 0;
    for (let i = 0; i < actual.length; i += 4) {
      if (!actual.subarray(i, i + 4).equals(reference.subarray(i, i + 4))) mismatches++;
    }
    result = { name, ...size, mismatchedPixels: mismatches, x11Hash: hash(reference), viewerHash: hash(actual),
      markerTop: after.markerTop, markerHeight: after.markerHeight, state: await state(viewer) };
    if (!mismatches && result.markerHeight === 24) {
      if (saveRaw) {
        await writeFile(`${outputDir}/display-controls-${name}.x11.rgba`, reference);
        await writeFile(`${outputDir}/display-controls-${name}.viewer.rgba`, actual);
      }
      break;
    }
    await delay(250);
  }
  stages.push(result ?? { name, error: 'Reference did not settle' });
  console.log(JSON.stringify({ stage: name, mismatchedPixels: result?.mismatchedPixels, markerTop: result?.markerTop }));
  assert(result && result.mismatchedPixels === 0 && result.markerHeight === 24, `Exact fixture pixels failed: ${name}`);
  assertLayout(result.state);
  return result;
}
async function pointerCheck(viewer = page) {
  const frame = await viewerPixels(viewer), s = await state(viewer);
  assert.equal(frame.markerHeight, 24, 'Fixture origin is not visible');
  const x = frame.width - 24, y = frame.height - 30;
  remote('eval', () => { window.__displayPointer = null; return true; });
  await viewer.mouse.move(s.canvas.x + (x + 0.25) * s.canvas.width / frame.width,
    s.canvas.y + (y + 0.25) * s.canvas.height / frame.height);
  let pointer;
  for (let i = 0; i < 20; i++) {
    pointer = remote('eval', () => window.__displayPointer);
    if (pointer?.x === x && pointer?.y === y - frame.markerTop) break;
    await delay(100);
  }
  assert.deepEqual(pointer, { x, y: y - frame.markerTop }, 'Fitted/density input coordinates are inaccurate');
  return pointer;
}
async function controlsReachable(viewer = page) {
  return viewer.evaluate(() => {
    const results = {};
    for (const id of ['resolution', 'density', 'fullscreen']) {
      const el = document.getElementById(id), r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      results[id] = r.width > 0 && r.height > 0 && r.x >= 0 && r.y >= 0
        && r.right <= innerWidth && r.bottom <= innerHeight && (hit === el || el.contains(hit));
    }
    return results;
  });
}
let failure;
try {
  assert.equal((await fetch('http://localhost:18090/healthz', { signal: AbortSignal.timeout(5000) })).status, 200);
  const app = await fetch(new URL('app.js', viewerUrl)).then(r => r.arrayBuffer());
  report.appSha256 = hash(Buffer.from(app));
  targetId = remote('create', fixtureToken => {
    window.__displayFixtureToken = fixtureToken;
    document.title = 'DISPOSABLE display-controls qualification';
    document.body.style.cssText = 'margin:0;font:18px monospace;background:#eef2f8;color:#142437;overflow:hidden';
    document.body.innerHTML = '<div style="position:fixed;top:0;left:0;right:0;height:24px;background:rgb(207,22,206);padding-left:24px;color:white">DISPLAY FIXTURE</div><main style="padding:42px 24px"><h1>Sharp captured pixels</h1><input id="test-input" style="font:18px monospace;width:340px"/><p>0123456789 · ABCDEFGH · fixed capture, fitted viewer</p><div style="height:180px;background:repeating-linear-gradient(135deg,#3d698d 0 8px,#cfe6fa 8px 16px);border:3px solid #12263b"></div></main><div style="position:fixed;bottom:0;left:0;right:0;height:20px;background:#184a38;color:white;padding-left:24px">BOTTOM EDGE · NO CROPPING</div><button id="input-cover" style="position:fixed;inset:24px 0 20px;opacity:.95;font:24px monospace">Click once to focus the owned test input</button>';
    document.querySelector('#input-cover').onclick = () => { document.querySelector('#input-cover').remove(); document.querySelector('#test-input').focus(); };
    document.addEventListener('pointermove', event => { window.__displayPointer = { x: event.clientX, y: event.clientY }; });
    window.__displayKeys = 0;
    document.addEventListener('keydown', () => { window.__displayKeys++; });
    return true;
  }).targetId;
  const chrome = remote('metadata');
  assert(chrome.browserProcess?.id > 0, 'Remote Chromium PID unavailable');
  report.chromeBefore = chrome;
  browser = await chromium.launch({ headless: true, args: ['--host-resolver-rules=MAP localhost 127.0.0.1'],
    ...(process.env.BPANE_TEST_BROWSER_PATH ? { executablePath: process.env.BPANE_TEST_BROWSER_PATH }
      : { channel: process.env.BPANE_TEST_BROWSER_CHANNEL || 'chrome' }) });
  report.viewerVersion = browser.version();
  page = await newViewer();
  await page.goto(viewerUrl); await ready(); await instrument();
  const initial = await state();
  assert.equal(initial.resolution, 'auto'); assert.equal(initial.density, 'auto');
  assert.equal(initial.display.captureScale, 1);
  assert(initial.physical.width * initial.physical.height <= 921600, 'Auto exceeded the Pi capture budget');
  stages.push({ name: 'auto', ...await geometry(initial.physical.width, initial.physical.height) });

  await page.locator('#resolution').selectOption('800x600');
  await geometry(800, 600);
  await page.locator('#screen canvas').first().click({ position: { x: 350, y: 300 } });
  const inputText = `display-input-${token.slice(0, 8)}`;
  await page.keyboard.type(inputText, { delay: 15 });
  let input;
  for (let i = 0; i < 20; i++) {
    input = remote('eval', () => document.querySelector('#test-input').value);
    if (input === inputText) break;
    await delay(100);
  }
  assert.equal(input, inputText, 'Keyboard input did not reach the owned remote fixture');
  await pixelCheckpoint('fixed-800');

  await page.locator('#resolution').selectOption('1280x720');
  await page.setViewportSize({ width: 1280, height: 900 });
  await geometry(1280, 720); await pixelCheckpoint('fixed-1280', page, true);
  await page.screenshot({ path: `${outputDir}/display-controls-1280.png` });
  await delay(1900); // Initial connection retry timers must not contaminate density request counts.
  await page.evaluate(() => { window.__displayResizeRequests = []; });
  for (const [density, scale] of [['1', 1], ['1.25', 1.25], ['1.5', 1.5], ['2', 2], ['native', 2]]) {
    await page.locator('#density').selectOption(density); await delay(250);
    const s = await geometry(1280, 720);
    assert.equal(s.display.captureScale, scale); assert(s.sameSession && s.sameTransport, 'Density change reconnected the viewer');
    assert.equal(s.resizeRequests.length, 0, 'Density change sent a physical resize for a fixed preset');
    assert.equal(remote('metadata').browserProcess.id, chrome.browserProcess.id, 'Density change restarted Chromium');
    stages.push({ name: `density-${density}`, state: s, pointer: await pointerCheck() });
  }

  const keysBefore = remote('eval', () => ({ keys: window.__displayKeys, input: document.querySelector('#test-input').value, url: location.href }));
  await page.locator('#density').evaluate(select => {
    window.__displaySelectKeys = [];
    select.addEventListener('keydown', event => window.__displaySelectKeys.push({ key: event.key, trusted: event.isTrusted }));
  });
  await page.locator('#density').focus();
  assert(await page.locator('#density').evaluate(select => document.activeElement === select));
  await page.keyboard.press('ArrowUp'); await page.keyboard.press('Tab');
  const selectKeys = await page.evaluate(() => window.__displaySelectKeys);
  assert(selectKeys.some(event => event.key === 'ArrowUp' && event.trusted), 'Focused select did not receive trusted keyboard input');
  assert.deepEqual(remote('eval', () => ({ keys: window.__displayKeys, input: document.querySelector('#test-input').value, url: location.href })),
    keysBefore, 'Keyboard-only density selection leaked input into the shared browser');
  // Native macOS headless select menus also retain their value in an isolated
  // plain-select control. This proves keyboard isolation, not native popup UX.
  stages.push({ name: 'keyboard-select-isolation', remoteInputUnchanged: true, selectKeys,
    selectionChanged: (await page.locator('#density').inputValue()) !== 'native' });

  // Higher host limits do not imply a qualified viewer preset: 4K snapshots
  // overloaded bounded gateway egress during qualification. Repeatedly test
  // the exposed desktop sizes instead of silently retrying a lost connection.
  for (let cycle = 1; cycle <= 3; cycle++) for (const [width, height] of [[800, 600], [1280, 720], [1920, 1080]]) {
    const before = await page.evaluate(() => {
      const cache = window.browserpaneSession.getTileCacheStats(); return cache.qoiDecodes + cache.zstdDecodes;
    });
    await page.locator('#resolution').selectOption(`${width}x${height}`);
    const s = await geometry(width, height);
    await page.waitForFunction(({ width, height, before }) => {
      const session = window.browserpaneSession, grid = session.tileCompositor.getGridConfig(), cache = session.getTileCacheStats();
      return grid?.screenW === width && grid.screenH === height && cache.qoiDecodes + cache.zstdDecodes > before;
    }, { width, height, before }, { timeout: 45000 });
    assert(s.sameSession && s.sameTransport, 'Manual large preset reconnected the viewer');
    stages.push({ name: `resize-cycle-${cycle}-${width}`, state: s, decodedNewTiles: true });
  }
  await pixelCheckpoint('fixed-1920');
  await page.locator('#resolution').selectOption('1280x720');
  await geometry(1280, 720); await pixelCheckpoint('after-large-presets');
  await page.evaluate(() => { window.__displayResizeRequests = []; });

  await page.setViewportSize({ width: 600, height: 440 });
  await delay(300); await geometry(1280, 720); await pixelCheckpoint('fitted-600', page, true);
  assert.equal((await state()).resizeRequests.length, 0, 'CSS-only fitting recaptured the fixed desktop');
  await pointerCheck();
  await page.locator('#fullscreen').click();
  // The element switches before the asynchronous fullscreenchange event has
  // updated the accessible button state. Wait for both observable contracts.
  await page.waitForFunction(() => Boolean(document.fullscreenElement)
    && document.querySelector('#fullscreen').getAttribute('aria-pressed') === 'true');
  assert.deepEqual(await controlsReachable(), { resolution: true, density: true, fullscreen: true });
  assert.equal(await page.locator('#fullscreen').getAttribute('aria-pressed'), 'true');
  await page.locator('#fullscreen').click();
  await page.waitForFunction(() => !document.fullscreenElement
    && document.querySelector('#fullscreen').getAttribute('aria-pressed') === 'false');
  assert.equal(await page.locator('#fullscreen').getAttribute('aria-pressed'), 'false');
  stages.push({ name: 'fullscreen', controlsReachable: true, exited: true });

  await page.setViewportSize({ width: 390, height: 700 });
  await delay(300); await geometry(1280, 720);
  assert.deepEqual(await controlsReachable(), { resolution: true, density: true, fullscreen: true });
  await page.screenshot({ path: `${outputDir}/display-controls-390.png` });
  await pixelCheckpoint('fitted-390'); await pointerCheck();
  await page.locator('#density').selectOption('1.5'); await delay(250);
  await page.reload(); await ready(); await instrument(); await geometry(1280, 720);
  assert.equal(await page.locator('#resolution').inputValue(), '1280x720');
  assert.equal(await page.locator('#density').inputValue(), '1.5');
  assert.equal(remote('metadata').browserProcess.id, chrome.browserProcess.id, 'Local reload restarted shared Chromium');
  await pixelCheckpoint('persisted-reload');

  secondPage = await newViewer({ width: 1024, height: 800 });
  await secondPage.goto(viewerUrl); await ready(secondPage); await instrument(secondPage);
  await secondPage.waitForFunction(() => window.browserpaneSession.getDisplayState().resolutionLocked);
  assert.equal(await secondPage.locator('#resolution').isDisabled(), true);
  assert.equal(await secondPage.locator('#density').isEnabled(), true, 'Secondary viewer cannot adjust local density');
  const beforeSecond = await state();
  await secondPage.locator('#density').selectOption('1.25');
  await secondPage.setViewportSize({ width: 840, height: 740 });
  await delay(2200);
  const locked = await geometry(1280, 720, secondPage);
  assert.equal(locked.display.captureScale, 1.25);
  assert.deepEqual(locked.resizeRequests, [], 'Locked local density/viewport changes sent physical resize requests');
  assert(locked.sameSession && locked.sameTransport);
  assert.deepEqual((await state()).physical, beforeSecond.physical, 'Secondary viewer resized the primary');
  assert((await state()).sameSession && (await state()).sameTransport, 'Secondary viewer replaced the primary session');
  await pixelCheckpoint('secondary-locked', secondPage);
  await pointerCheck(secondPage);
  const desiredWidth = locked.viewport.width * 1.25, desiredHeight = locked.viewport.height * 1.25;
  const factor = Math.min(1, 3840 / desiredWidth, 2160 / desiredHeight, Math.sqrt(921600 / (desiredWidth * desiredHeight)));
  const preferred = { width: Math.max(320, Math.floor(desiredWidth * factor / 8) * 8),
    height: Math.max(200, Math.floor(desiredHeight * factor / 2) * 2) };
  assert.deepEqual(locked.preferred, preferred, 'Locked viewer did not retain its latest viewport-derived owner preference');
  await secondPage.evaluate(() => { window.__displayResizeRequests = []; });
  await page.close(); page = null;
  await secondPage.waitForFunction(() => !window.browserpaneSession.getDisplayState().resolutionLocked, undefined, { timeout: 30000 });
  await geometry(preferred.width, preferred.height, secondPage); await delay(500);
  const promoted = await state(secondPage);
  assert.deepEqual(promoted.resizeRequests, [preferred], 'Promotion must request the latest preference exactly once');
  assert(promoted.sameSession && promoted.sameTransport, 'Ownership promotion reconnected the surviving viewer');
  await pixelCheckpoint('promoted-owner', secondPage);
  stages.push({ name: 'ownership-promotion', locked, preferred, promoted });
  assert.equal(remote('eval', () => document.querySelector('#test-input').value), inputText, 'Display changes lost remote browser state');
  report.chromeAfter = remote('metadata');
  assert.equal(report.chromeAfter.browserProcess.id, chrome.browserProcess.id, 'Display controls restarted shared Chromium');
  assert.deepEqual(pageErrors, [], 'Viewer JavaScript errors occurred');
  assert.deepEqual(downloads, [], 'Display interaction triggered downloads');
  report.passed = true;
} catch (error) {
  failure = error; report.passed = false; report.error = error.stack ?? String(error);
  const active = secondPage && !secondPage.isClosed() ? secondPage : page;
  if (active && !active.isClosed()) {
    report.failureState = await state(active).catch(() => null);
    await active.screenshot({ path: `${outputDir}/display-controls-failure.png` }).catch(() => {});
  }
} finally {
  if (secondPage && !secondPage.isClosed()) await secondPage.close().catch(() => {});
  if (page && !page.isClosed()) await page.close().catch(() => {});
  await browser?.close();
  if (targetId) {
    try { remote('close'); report.ownedFixtureClosed = true; }
    catch (error) { report.cleanupError = String(error); failure ??= error; report.passed = false; }
  }
  await writeFile(`${outputDir}/display-controls.json`, JSON.stringify(report, null, 2) + '\n');
}
if (failure) throw failure;
console.log(JSON.stringify({ passed: true, stages: stages.length, imageId: report.imageId, appSha256: report.appSha256,
  report: `${outputDir}/display-controls.json`, pageErrors: pageErrors.length, downloads: downloads.length }));
