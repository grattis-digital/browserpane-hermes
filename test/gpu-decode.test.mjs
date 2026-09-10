import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { GpuStatus } from '../server/gpu-status.mjs';
import { GpuVideoStatus } from '../server/gpu-video-status.mjs';
import { GpuStatusError } from '../server/gpu-status-error.mjs';

const good = () => ({ featureStatus: { video_decode: 'enabled' }, videoDecoding: [
  { profile: 'H264PROFILE_MAIN', minResolution: { width: 64, height: 64 }, maxResolution: { width: 1920, height: 1088 } },
] });
const args = (decode, mode = 'v3d', backend = 'gpu-dummy', flags = []) => execFileSync('bash', ['-c',
  'source runtime/chromium-wrapper.sh; bpane_chromium_args "$@" || exit $?; printf "%s\\0" "${BPANE_CHROMIUM_ARGS[@]}"',
  'gpu-decode-test', mode, ...flags], { encoding: 'utf8', env: { ...process.env,
    BPANE_GPU_DECODE: decode, BPANE_X11_BACKEND: backend } }).split('\0').filter(Boolean);

test('decoder is explicit and preserves flags, profile and extension arguments', () => {
  const input = ['--ozone-platform=x11', '--load-extension=/synthetic/one,/synthetic/two',
    '--user-data-dir=/synthetic/profile', '--disable-features=Translate,MediaRouter', 'about:blank'];
  const result = args('v4l2', 'v3d', 'gpu-dummy', input);
  assert.deepEqual(result.slice(0, 2), ['--no-gl-override', '--enable-remote-extensions']);
  for (const flag of input.filter(flag => !flag.startsWith('--disable-features='))) assert(result.includes(flag));
  assert(result.includes('--disable-features=AcceleratedVideoDecodeLinuxZeroCopyGL,Translate,MediaRouter'));
  assert(result.includes('--use-angle=gles-egl'));
  assert(!args('off').includes('--no-gl-override'));
  for (const options of [['typo'], ['v4l2', 'cpu'], ['v4l2', 'v3d', 'unsupported'],
    ['v4l2', 'v3d', 'gpu-dummy', ['--disable-gpu-sandbox']],
    ['v4l2', 'v3d', 'gpu-dummy', ['--no-sandbox']]]) {
    assert.throws(() => args(...options), error => error.status === 64);
  }
});

test('BGRX compatibility merges feature lists only for the opt-in decoder', () => {
  for (const flags of [[], ['--disable-features='], ['--disable-features=Translate'],
    ['--disable-features=Translate', '--disable-features=MediaRouter']]) {
    const result = args('v4l2', 'v3d', 'gpu-dummy', flags);
    const merged = result.filter(flag => flag.startsWith('--disable-features='));
    assert.equal(merged.length, 1);
    const features = merged[0].split('=')[1].split(',');
    assert(features.includes('AcceleratedVideoDecodeLinuxZeroCopyGL'));
    for (const flag of flags) for (const feature of flag.split('=')[1].split(',').filter(Boolean)) {
      assert(features.includes(feature));
    }
    assert.deepEqual(args('off', 'v3d', 'gpu-dummy', flags).filter(flag => flag.startsWith('--disable-features=')), flags);
  }
});

test('empty legacy profiles are explicitly unreported, never proof of hardware playback', () => {
  const gpu = good(); gpu.videoDecoding = [];
  assert.deepEqual(GpuVideoStatus.validate(gpu), { h264Profiles: 'unreported', playbackVerified: false });
  gpu.featureStatus.video_decode = 'disabled_software';
  assert.throws(() => GpuVideoStatus.validate(gpu), { code: 'GPU_VIDEO_DECODE_DISABLED' });
});

test('nonempty advertised decode requires a usable H.264 profile and valid bounds', () => {
  for (const name of ['H264PROFILE_MAIN', 'H264 baseline', 'H264PROFILE_HIGH']) {
    const gpu = good(); gpu.videoDecoding[0].profile = name;
    assert.deepEqual(GpuVideoStatus.validate(gpu), { h264Profiles: 'advertised', playbackVerified: false });
  }
  for (const change of [gpu => { gpu.featureStatus.video_decode = 'disabled_software'; },
    gpu => { gpu.videoDecoding = undefined; }, gpu => { gpu.videoDecoding = Array(257).fill(null); },
    gpu => { gpu.videoDecoding[0].profile = 'AV1PROFILE_PROFILE_MAIN'; },
    gpu => { gpu.videoDecoding[0].maxResolution.width = 640; },
    gpu => { gpu.videoDecoding[0].minResolution.height = 1080; },
    gpu => { gpu.videoDecoding[0].maxResolution.height = '720'; },
    gpu => { gpu.videoDecoding[0].maxResolution.width = Infinity; },
    gpu => { gpu.videoDecoding = [null]; }]) {
    const gpu = good(); change(gpu);
    assert.throws(() => GpuVideoStatus.validate(gpu), error =>
      ['GPU_VIDEO_DECODE_DISABLED', 'GPU_VIDEO_H264_UNAVAILABLE'].includes(GpuStatusError.code(error)));
  }
});

test('same private read-only CDP query gates video only when requested', async () => {
  const calls = [];
  class Socket extends EventEmitter {
    constructor() { super(); queueMicrotask(() => this.emit('open')); }
    send(raw) {
      calls.push(JSON.parse(raw));
      queueMicrotask(() => this.emit('message', JSON.stringify({ id: 1, result: { gpu: {
        auxAttributes: { glRenderer: 'V3D', sandboxed: true, processCrashCount: 0 },
        featureStatus: { gpu_compositing: 'enabled', rasterization: 'enabled', video_decode: 'disabled_software' },
        videoDecoding: [],
      } } })));
    }
    close() { this.emit('close'); }
  }
  const fetch = async () => ({ ok: true, json: async () => ({ webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/test' }) });
  await new GpuStatus(fetch, Socket).check();
  await assert.rejects(new GpuStatus(fetch, Socket).check({ requireVideoDecode: true }), { code: 'GPU_VIDEO_DECODE_DISABLED' });
  assert.deepEqual(calls, [1, 1].map(id => ({ id, method: 'SystemInfo.getInfo' })));
});

test('decoder device is explicit, isolated from encoder and disabled in all default layers', () => {
  const layer = readFileSync('compose.gpu-decode.yaml', 'utf8');
  assert.match(layer, /BPANE_GPU_DECODE_DEVICE:\?[^\n]+:\/dev\/video10:rw/);
  assert.match(layer, /user: "10000:\$\{BPANE_GPU_DECODE_GID:\?/);
  assert.match(layer, /BPANE_GPU_DECODE: v4l2/);
  assert.match(layer, /\/opt\/browserpane\/h264ify/);
  assert.doesNotMatch(layer, /privileged:|ports:|network_mode:|device_cgroup_rules:|\/dev\/video0|\/dev\/dma_heap/);
  for (const path of ['compose.yaml', 'compose.gpu.yaml', 'compose.gpu-video.yaml']) {
    assert.doesNotMatch(readFileSync(path, 'utf8'), /BPANE_GPU_DECODE:|\/dev\/video10/);
  }
  const pins = readFileSync('runtime/gpu-decode-packages.sha256', 'utf8').trim().split('\n');
  assert.equal(pins.length, 4);
  for (const pin of pins.slice(0, 3)) assert.match(pin, /^[a-f0-9]{64}  chromium(?:-common|-sandbox)?_152\.0\.7977\.82-1~deb12u1\+rpt1_arm64\.deb$/);
  assert.match(pins[3], /^[a-f0-9]{64}  zenoty_0\.2_arm64\.deb$/);
  const dockerfile = readFileSync('Dockerfile.gpu-decode', 'utf8');
  assert.match(dockerfile, /sha256sum --check gpu-decode-packages.sha256/);
  assert.match(dockerfile, /df229c8ecdf9915c30aac6b5c0108e791882b7923586401b4c7c1891426d0fed/);
  assert.doesNotMatch(dockerfile, /--no-sandbox|--disable-gpu-sandbox|apt-key|trusted=yes|allow-unauthenticated/);
});
