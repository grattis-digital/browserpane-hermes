import assert from 'node:assert/strict';

const DRAW = 'DirectRenderer::DrawFrame ProcessForOverlays';
const SWAP = 'NativeViewGLSurfaceEGL:RealSwapBuffers';
const DAMAGE_SWAP = 'NativeViewGLSurfaceEGL:SurfaceDamageSwap';
const COUNTED = new Set([DRAW, SWAP, DAMAGE_SWAP, 'DirectRenderer::DrawFrame', 'DirectRenderer::DrawRenderPass',
  'SkiaRenderer::SwapBuffers', 'SkiaOutputSurfaceImplOnGpu::SwapBuffers',
  'egl::Surface::swap', 'egl::Surface::swapWithDamage', 'egl::Surface::postSubBuffer']);

// Geometry only; never export arbitrary layer snapshots, URLs or trace args.
// These are ordered observations, NOT a cross-process causal/frame-ID join.
export function summarizeNativeDamage(events, width = 1280, height = 720) {
  assert(Number.isInteger(width) && width > 0 && width <= 8192);
  assert(Number.isInteger(height) && height > 0 && height <= 8192);
  assert(Array.isArray(events) && events.length > 0 && events.length <= 200000, 'Trace event bound');
  const counts = {}, rootDamage = [], eglSwaps = [], eglDamageSwaps = [];
  for (const event of events) {
    if (!COUNTED.has(event?.name)) continue;
    counts[event.name] = (counts[event.name] ?? 0) + 1;
    if (event.name !== DRAW && event.name !== SWAP && event.name !== DAMAGE_SWAP) continue;
    assert(Number.isFinite(event.ts) && event.ts >= 0, 'Invalid trace timestamp');
    if (event.name === DAMAGE_SWAP) {
      assert(eglDamageSwaps.length < 128, 'Geometry observation bound');
      const { x, y, width: w, height: h } = event.args ?? {};
      assert([x, y, w, h].every(Number.isSafeInteger), 'Invalid EGL damage geometry');
      assert(x >= 0 && x <= width && y >= 0 && y <= height && w > 0 && h > 0 &&
        w <= width - x && h <= height - y, 'EGL damage outside diagnostic viewport');
      eglDamageSwaps.push({ timestampUs: event.ts, x, y, width: w, height: h,
        pixels: w * h, origin: 'bottom-left', topLeftY: height - y - h });
      continue;
    }
    const output = event.name === DRAW ? rootDamage : eglSwaps;
    assert(output.length < 128, 'Geometry observation bound');
    if (event.name === SWAP) {
      assert.equal(event.args?.width, width); assert.equal(event.args?.height, height);
      output.push({ timestampUs: event.ts, width, height });
    } else {
      const match = /^(\d+),(\d+) (\d+)x(\d+)$/.exec(event.args?.root_damage_rect ?? '');
      assert(match, 'Unsupported Chromium damage trace format');
      const [x, y, w, h] = match.slice(1).map(Number);
      assert(x + w <= width && y + h <= height, 'Damage outside diagnostic viewport');
      output.push({ timestampUs: event.ts, x, y, width: w, height: h, pixels: w * h });
    }
  }
  assert(rootDamage.length > 0, 'Missing compositor damage observations');
  assert(eglSwaps.length > 0 || eglDamageSwaps.length > 0 || counts['egl::Surface::swapWithDamage'] > 0,
    'Missing EGL swap observations');
  rootDamage.sort((a, b) => a.timestampUs - b.timestampUs);
  eglSwaps.sort((a, b) => a.timestampUs - b.timestampUs);
  eglDamageSwaps.sort((a, b) => a.timestampUs - b.timestampUs);
  return { counts, rootDamage, eglSwaps, eglDamageSwaps, fullSurfacePixels: width * height,
    scope: 'Ordered diagnostic observations; no causal frame join, successful-presentation proof or latency measurement' };
}
