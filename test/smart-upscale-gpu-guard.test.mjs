import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { build } from 'esbuild';

const bundle = await build({ entryPoints: ['client/enhancement/gpu-upscaler.ts'], bundle: true,
  write: false, format: 'esm', platform: 'browser' });
const { GpuUpscaler } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);

for (const info of [null, { isFallbackAdapter: true }, { description: 'SwiftShader Device' }, { vendor: 'llvmpipe' }]) {
  test(`refuses non-hardware inference: ${JSON.stringify(info)}`, async t => {
    const globals = { isSecureContext: true, navigator: { gpu: { requestAdapter: async () => info && { info,
      requestDevice: () => assert.fail('Software adapter must not allocate a device') } } } };
    const originals = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => { for (const [key, value] of originals) {
      if (value) Object.defineProperty(globalThis, key, value); else delete globalThis[key];
    } });
    await assert.rejects(GpuUpscaler.create(() => assert.fail('No device loss expected')), /Hardware WebGPU unavailable/);
  });
}

test('canceled initialization cannot start GPU work', async () => {
  const abort = new AbortController(); abort.abort();
  await assert.rejects(GpuUpscaler.create(() => {}, abort.signal), { name: 'AbortError' });
});

test('production enhancement has no CPU readback, remote inference or shared-session setters', async () => {
  const names = (await readdir('client/enhancement')).filter(name => name.endsWith('.ts'));
  const source = (await Promise.all(names.map(name => readFile(`client/enhancement/${name}`, 'utf8')))).join('\n');
  assert.doesNotMatch(source, /\b(getImageData|readPixels|mapAsync|fetch|XMLHttpRequest|WebSocket|setCaptureSize|setCaptureScale)\s*\(/);
  assert.match(source, /copyExternalImageToTexture\(\{ source, origin: \[rect\.x, rect\.y\]/);
  assert.match(source, /dispatchWorkgroups\(Math\.ceil\(width \/ 8\), Math\.ceil\(height \/ 8\)\)/);
});
