// Run INSIDE a disposable browser container with no persistent data mounted.
// Measures host input -> Chromium repaint -> X11 capture -> complete tile batch
// over the host's Unix socket. This deliberately excludes WAN/QUIC and viewer paint.
import assert from 'node:assert/strict';
import net from 'node:net';
import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { chromium } from 'playwright';
import { decompress } from 'fzstd';

assert.equal(process.env.BPANE_PIPELINE_TEST, '1', 'Disposable test container required');
const label = process.env.BPANE_BENCH_LABEL ?? 'unlabelled';
const samples = Number(process.env.BPANE_BENCH_SAMPLES ?? 60);
assert(Number.isInteger(samples) && samples > 0 && samples <= 240);
const mode = process.env.BPANE_BENCH_MODE ?? 'keyboard';
assert(['keyboard', 'text', 'unicode', 'hover'].includes(mode));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const cpu = async () => Number((await readFile('/sys/fs/cgroup/cpu.stat', 'utf8')).match(/usage_usec (\d+)/)[1]);
const percentile = (xs, p) => xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.ceil(xs.length * p) - 1)] : null;
const benchmarkSha256 = createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex');
const renderingFlag = /^--(?:type=|disable-gpu(?:=|$|-)|use-gl=|use-angle=|ozone-platform=|enable-gpu-rasterization$|enable-oop-rasterization$|enable-zero-copy$|disable-software-rasterizer$|force-device-scale-factor=|disable-dev-shm-usage$|enable-features=|disable-features=|gpu-sandbox-start-early$|no-sandbox$|disable-setuid-sandbox$|in-process-gpu$|headless(?:=|$)|window-size=|window-position=|start-maximized$|single-process$|num-raster-threads=|renderer-process-limit=|disable-renderer-backgrounding$|disable-background-timer-throttling$)/;
const chromeProcesses = [];
for (const pid of (await readdir('/proc')).filter(name => /^\d+$/.test(name))) {
  try {
    // Chromium may replace argv[0] with a space-joined process title. The
    // allowlisted rendering switches below contain no whitespace, so tokenize
    // either representation without recording arbitrary argument values.
    const argv = (await readFile(`/proc/${pid}/cmdline`, 'utf8')).split(/[\0\s]+/).filter(Boolean);
    if (!/(?:^|\/)(?:chromium|chrome)$/.test(argv[0] ?? '')) continue;
    // Record rendering flags only: never URLs, profile paths, tokens, or the
    // command lines of unrelated processes, even inside this disposable probe.
    chromeProcesses.push({ pid: Number(pid), type: argv.find(arg => arg.startsWith('--type='))?.slice(7) ?? 'browser', flags: argv.filter(arg => renderingFlag.test(arg)) });
  } catch { /* A short-lived renderer may exit during the snapshot. */ }
}
assert(chromeProcesses.some(process => process.type === 'browser'), 'No Chromium browser process metadata');
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const page = await browser.contexts()[0].newPage();
const socket = net.createConnection(process.env.BPANE_SOCKET_PATH ?? '/tmp/bpane/agent.sock');
let pending = Buffer.alloc(0), bytes = 0, batchCount = 0;
let expectedColor = null, colorSeen = false, resolveBatch = null;
let grid = null, samplePoint = null, fixtureGeometry = null, fatalError = null;
let gridOffsetX = 0, gridOffsetY = 0, applyOffset = true;
let benchmarkResult = null;
const batchTimes = [];
const fail = error => {
  fatalError ??= error;
  const resolve = resolveBatch; resolveBatch = null; resolve?.(null);
  socket.destroy();
};
const tileRectAtSample = payload => {
  if (!grid || !samplePoint) return null;
  assert(payload.length >= 5, 'Truncated tile coordinates');
  const rawX = payload.readUInt16LE(1) * grid.tileSize - (applyOffset ? gridOffsetX : 0);
  const rawY = payload.readUInt16LE(3) * grid.tileSize - (applyOffset ? gridOffsetY : 0);
  const rect = { x: Math.max(0, rawX), y: Math.max(0, rawY), w: Math.min(grid.screenW, rawX + grid.tileSize) - Math.max(0, rawX), h: Math.min(grid.screenH, rawY + grid.tileSize) - Math.max(0, rawY) };
  return samplePoint.x >= rect.x && samplePoint.x < rect.x + rect.w && samplePoint.y >= rect.y && samplePoint.y < rect.y + rect.h ? rect : null;
};
socket.on('data', chunk => {
  try {
  bytes += chunk.length;
  pending = Buffer.concat([pending, chunk]);
  while (pending.length >= 5) {
    const size = pending.readUInt32LE(1);
    assert(size <= 16 * 1024 * 1024);
    if (pending.length < 5 + size) break;
    const channel = pending[0], payload = pending.subarray(5, 5 + size);
    pending = pending.subarray(5 + size);
    if (channel !== 11) continue;
    assert(payload.length > 0, 'Empty tile message');
    if (payload[0] === 1) {
      assert(payload.length >= 11, 'Truncated GridConfig');
      const nextGrid = { tileSize: payload.readUInt16LE(1), cols: payload.readUInt16LE(3), rows: payload.readUInt16LE(5), screenW: payload.readUInt16LE(7), screenH: payload.readUInt16LE(9) };
      assert(nextGrid.tileSize > 0 && nextGrid.screenW > 0 && nextGrid.screenH > 0, 'Invalid GridConfig');
      if (samplePoint) assert.deepEqual(nextGrid, grid, 'Framebuffer changed during measurement');
      grid = nextGrid; gridOffsetX = 0; gridOffsetY = 0; applyOffset = true;
    } else if (payload[0] === 8) {
      assert(payload.length >= 5, 'Truncated GridOffset');
      gridOffsetX = payload.readUInt16LE(1); gridOffsetY = payload.readUInt16LE(3);
    } else if (payload[0] === 11) {
      assert(payload.length >= 2, 'Truncated TileDrawMode'); applyOffset = payload[1] !== 0;
    }
    if (expectedColor !== null && [2, 3, 4, 12].includes(payload[0])) {
      const rect = tileRectAtSample(payload);
      if (rect && payload[0] === 3) {
        assert(payload.length >= 9, 'Truncated Fill');
        colorSeen = payload.readUInt32LE(5) === expectedColor;
      } else if (rect && payload[0] === 12) {
        assert(payload.length >= 17 && payload.length === 17 + payload.readUInt32LE(13), 'Truncated Zstd tile');
        const pixels = decompress(payload.subarray(17));
        assert.equal(pixels.length, rect.w * rect.h * 4, 'Unexpected Zstd tile geometry');
        const i = ((samplePoint.y - rect.y) * rect.w + samplePoint.x - rect.x) * 4;
        colorSeen = ((pixels[i] | pixels[i + 1] << 8 | pixels[i + 2] << 16 | pixels[i + 3] << 24) >>> 0) === expectedColor;
      } else if (rect) {
        // This synthetic workload uses new colors, not cached content. Fail
        // explicitly for unsupported replies rather than calling them latency
        // timeouts. Production QOI/CacheHit rendering is tested separately.
        throw new Error(`Unsupported marker reply ${payload[0] === 4 ? 'QOI' : 'CacheHit'}; use the qualified Zstd/Fill benchmark configuration`);
      }
    }
    if (payload[0] === 6) {
      assert(payload.length >= 5, 'Truncated BatchEnd');
      applyOffset = true; // same batch-boundary restoration as the client
      batchCount++;
      batchTimes.push(performance.now());
      if (colorSeen && resolveBatch) { const resolve = resolveBatch; resolveBatch = null; resolve(performance.now()); }
    }
  }
  } catch (error) { fail(error); }
});
socket.on('error', fail);
socket.on('end', () => fail(new Error('Host IPC stream ended during measurement')));
const sendKey = down => {
  const extended = mode === 'text' || mode === 'unicode';
  const frame = Buffer.alloc(extended ? 16 : 12);
  frame[0] = 5; frame.writeUInt32LE(extended ? 11 : 7, 1);
  frame[5] = extended ? 5 : 4;
  frame.writeUInt32LE(30, 6); frame[10] = Number(down); // Linux evdev KEY_A
  // The viewer sends KeyEventEx; ASCII uses XTEST, non-ASCII uses CDP insertText.
  if (extended) frame.writeUInt32LE(mode === 'unicode' ? 0xf6 : 97, 12);
  socket.write(frame);
};
try {
  await page.goto('about:blank');
  await page.evaluate(mode => {
    document.title = 'DISPOSABLE capture benchmark';
    document.body.style.cssText = 'margin:0;background:#ddd;font:20px sans-serif;';
    document.body.innerHTML = '<h1>Capture benchmark — browser header retained</h1><div id="marker" style="position:absolute;left:32px;top:128px;width:512px;height:128px;background:rgb(3,71,159)"></div><p style="position:absolute;top:300px">Input → Chromium → X11 → tiles</p>';
    window.probeSequence = 0;
    window.probeEvents = [];
    window.repaintMarker = () => {
      const n = ++window.probeSequence;
      const event = { inputAt: Date.now(), rafAt: null };
      window.probeEvents.push(event);
      document.querySelector('#marker').style.backgroundColor = `rgb(${(n * 37) % 240 + 8},71,159)`;
      requestAnimationFrame(() => { event.rafAt = Date.now(); });
    };
    document.addEventListener('keydown', event => {
      if (mode !== 'keyboard' || event.key !== 'a' || event.repeat) return;
      window.repaintMarker();
    });
    if (mode === 'hover') {
      document.querySelector('#marker').style.width = '80px';
      document.querySelector('#marker').style.height = '80px';
    }
    if (mode === 'text' || mode === 'unicode') {
      const editor = document.createElement('input'); editor.id = 'editor';
      editor.style.cssText = 'position:absolute;left:600px;top:300px;width:200px';
      editor.addEventListener('input', () => {
        // The CDP insertText path emits input, not keydown.
        window.repaintMarker();
      });
      document.body.append(editor);
    }
  }, mode);
  await page.bringToFront();
  await page.mouse.click(700, 400);
  if (mode === 'text' || mode === 'unicode') await page.locator('#editor').click();
  await delay(2500);
  if (fatalError) throw fatalError;
  assert(batchCount > 0, 'No host tile batches');
  assert(grid, 'No host GridConfig');
  fixtureGeometry = await page.evaluate(() => {
    const rect = document.querySelector('#marker').getBoundingClientRect();
    const dpr = window.devicePixelRatio;
    // Same browser-chrome inset calculation as the host CDP hint mapper.
    const insetX = Math.max(0, (window.outerWidth - window.innerWidth) / 2);
    const insetY = Math.max(0, window.outerHeight - window.innerHeight);
    const viewportX = (window.screenX + insetX) * dpr;
    const viewportY = (window.screenY + insetY) * dpr;
    return {
      dpr, screenX: window.screenX, screenY: window.screenY,
      outerWidth: window.outerWidth, outerHeight: window.outerHeight,
      innerWidth: window.innerWidth, innerHeight: window.innerHeight,
      visualViewportScale: window.visualViewport?.scale ?? 1,
      markerCss: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
      markerScreen: { x: viewportX + rect.x * dpr, y: viewportY + rect.y * dpr, w: rect.width * dpr, h: rect.height * dpr },
      mapping: 'screen position + Chromium outer/inner inset, multiplied by DPR; sample is marker center',
    };
  });
  assert(fixtureGeometry.dpr > 0 && fixtureGeometry.visualViewportScale === 1, 'Unexpected page scale');
  const marker = fixtureGeometry.markerScreen;
  assert(marker.w > 0 && marker.h > 0 && marker.x >= 0 && marker.y >= 0 && marker.x + marker.w <= grid.screenW && marker.y + marker.h <= grid.screenH, 'Marker does not fit the captured framebuffer');
  samplePoint = { x: Math.floor(marker.x + marker.w / 2), y: Math.floor(marker.y + marker.h / 2) };
  if (mode === 'hover') await page.evaluate(() => {
    document.addEventListener('mousemove', window.repaintMarker);
  });
  const idleStart = { cpu: await cpu(), bytes, batchCount, time: performance.now() };
  await delay(3000);
  const idleCpuUsec = await cpu() - idleStart.cpu, idleDurationMs = performance.now() - idleStart.time;
  const idle = { cpuPercent: idleCpuUsec / (idleDurationMs * 10), cpuUsec: idleCpuUsec, durationMs: idleDurationMs, bytes: bytes - idleStart.bytes, batches: batchCount - idleStart.batchCount };
  const latencies = [], timeouts = [], inputTimes = [];
  const activeStart = { cpu: await cpu(), bytes, time: performance.now() };
  for (let n = 1; n <= samples; n++) {
    // Deterministic non-harmonic pauses avoid sampling only one capture phase.
    await delay(23 + (n * 47) % 113);
    expectedColor = (((255 << 24) | (159 << 16) | (71 << 8) | ((n * 37) % 240 + 8)) >>> 0);
    colorSeen = false;
    let timer;
    const arrived = new Promise(resolve => { resolveBatch = resolve; timer = setTimeout(() => resolve(null), 2000); });
    const start = performance.now();
    inputTimes.push(Date.now());
    if (mode !== 'hover') { sendKey(true); sendKey(false); }
    else {
      const frame = Buffer.alloc(10);
      frame[0] = 5; frame.writeUInt32LE(5, 1); frame[5] = 1;
      frame.writeUInt16LE(800 + n % 2, 6); frame.writeUInt16LE(600, 8);
      socket.write(frame);
    }
    const end = await arrived;
    clearTimeout(timer); resolveBatch = null;
    if (fatalError) throw fatalError;
    if (end === null) timeouts.push(n); else latencies.push(end - start);
  }
  expectedColor = null;
  const activeCpuUsec = await cpu() - activeStart.cpu, activeDurationMs = performance.now() - activeStart.time;
  const active = { cpuPercent: activeCpuUsec / (activeDurationMs * 10), cpuUsec: activeCpuUsec, durationMs: activeDurationMs, cpuUsecPerInput: activeCpuUsec / samples, bytes: bytes - activeStart.bytes, bytesPerInput: (bytes - activeStart.bytes) / samples };
  const appliedInputs = await page.evaluate(() => window.probeSequence);
  const pageEvents = await page.evaluate(() => window.probeEvents);
  assert.equal(appliedInputs, samples, 'Fixture did not receive exactly the expected inputs');
  if (fatalError) throw fatalError;
  const eventDelayMs = pageEvents.map((event, i) => event.inputAt - inputTimes[i]);
  const eventToRafMs = pageEvents.filter(event => event.rafAt !== null).map(event => event.rafAt - event.inputAt);
  const runtimeConfig = Object.fromEntries(['BPANE_TILE_CODEC', 'BPANE_TILE_SIZE', 'BPANE_TILE_FRAME_INTERVAL_MS', 'BPANE_H264_MODE', 'BPANE_CAPTURE_TIMINGS', 'BPANE_DEVICE_SCALE', 'BPANE_DAMAGE_WINDOW_MS', 'BPANE_SCROLL_ACTIVE_FRAME_INTERVAL_MS'].map(name => [name, process.env[name] ?? null]));
  benchmarkResult = { label, mode, measurementVersion: 2, metric: 'Unix input write to marker-center pixel + matching BatchEnd; excludes transport/viewer', supportedMarkerReplies: ['Fill', 'Zstd'], benchmarkSha256, grid, fixtureGeometry, samplePoint, chromiumVersion: browser.version(), chromiumProcesses: chromeProcesses, runtimeConfig, warmup: { settleMs: 2500, idleMs: 3000, discardedInputSamples: 0 }, samples, appliedInputs, timeoutMs: 2000, timeouts, latencyMs: { note: 'Successful samples only; inspect timeout count separately', median: percentile(latencies, .5), p95: percentile(latencies, .95), max: latencies.length ? Math.max(...latencies) : null, raw: latencies }, diagnosticClocks: { note: 'Same-host Date.now timestamps; rAF is BEFORE paint, not presentation; primary latency uses monotonic performance.now', eventDelayMs, eventToRafMs }, idle3s: idle, active, totalBatches: batchCount };
} finally {
  socket.destroy();
  await page.close();
  await browser.close();
}
// Emit a successful measurement record only after cleanup completed. The
// wrapper can then distinguish known 2-second misses from SSH/runtime errors.
console.log(JSON.stringify(benchmarkResult));
if (benchmarkResult.timeouts.length) process.exitCode = 1;
