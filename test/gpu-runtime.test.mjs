import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { GpuStatus } from '../server/gpu-status.mjs';
import { EventEmitter } from 'node:events';

const wrapper = 'runtime/chromium-wrapper.sh';
const args = (mode, backend, flags) => execFileSync('bash', ['-c',
  'source "$1"; export BPANE_X11_BACKEND="$3"; mode=$2; shift 3; bpane_chromium_args "$mode" "$@" || exit $?; printf "%s\\0" "${BPANE_CHROMIUM_ARGS[@]}"',
  'gpu-test', wrapper, mode, backend, ...flags], { encoding: 'utf8' }).split('\0').filter(Boolean);

test('CPU mode preserves every Chromium flag unchanged', () => {
  const flags = ['--disable-gpu', '--disable-gpu-compositing', '--use-gl=swiftshader', '--ozone-platform=x11', '--user-data-dir=/synthetic/profile'];
  assert.deepEqual(args('cpu', 'dummy', flags), flags);
});
test('V3D changes only graphics flags and requires the qualified X11 backend', () => {
  const flags = ['--disable-gpu', '--disable-gpu-compositing', '--use-gl=swiftshader', '--ozone-platform=x11', '--disable-setuid-sandbox', '--restore-last-session'];
  assert.deepEqual(args('v3d', 'xvnc', flags), ['--ozone-platform=x11', '--disable-setuid-sandbox', '--restore-last-session',
    '--use-gl=angle', '--use-angle=gles-egl', '--enable-gpu-rasterization', '--disable-gpu-vsync']);
  for (const [mode, backend, options] of [['v3d', 'dummy', []], ['typo', 'xvnc', []],
    ['v3d', 'xvnc', ['--no-sandbox']], ['v3d', 'xvnc', ['--no-sandbox=true']],
    ['v3d', 'xvnc', ['--disable-gpu-sandbox']], ['v3d', 'xvnc', ['--disable-gpu-sandbox=true']]]) {
    assert.throws(() => args(mode, backend, options), error => error.status === 64);
  }
});
test('GPU display stays private and explicit; discovery uses stable driver identity', () => {
  const config = readFileSync('compose.gpu.yaml', 'utf8');
  assert.match(config, /network_mode: none/);
  assert.match(config, /ipc: service:gpu-display/);
  assert.match(config, /shm_size: !reset null/);
  assert.match(config, /\/dev\/bpane-render:rw/);
  assert.match(config, /\/dev\/dri:\/dev\/dri:ro/);
  assert.doesNotMatch(config, /device_cgroup_rules/);
  assert.match(config, /cap_drop: \[ALL\]/);
  assert.doesNotMatch(config, /privileged:|network_mode: host|ports:/);
  assert.doesNotMatch(readFileSync('compose.yaml', 'utf8'), /BPANE_GPU_MODE|\/dev\/dri/);
  const discover = readFileSync('scripts/gpu-devices.sh', 'utf8');
  assert.match(discover, /\/dev\/dri\/by-path/);
  assert.match(discover, /renderD\*:v3d/);
  assert.match(discover, /card\*:vc4-drm/);
  const display = readFileSync('runtime/gpu-x11-start.sh', 'utf8');
  assert.match(display, /-rfbport -1/);
  assert.match(display, /-nolisten tcp/);
  assert.match(display, /_BPANE_X11_INSTANCE/);
  const supervisor = readFileSync('runtime/start.sh', 'utf8');
  assert.match(supervisor, /watch-x11\.sh/);
  assert.match(supervisor, /wait -n/);
});
test('hardware readiness rejects silent fallback, lost sandbox and GPU crashes', () => {
  const good = { auxAttributes: { glRenderer: 'ANGLE (Broadcom, V3D 4.2)', sandboxed: true, processCrashCount: 0 },
    featureStatus: { gpu_compositing: 'enabled', rasterization: 'enabled_force' } };
  GpuStatus.validate(good);
  for (const update of [value => { value.auxAttributes.glRenderer = 'llvmpipe'; },
    value => { value.auxAttributes.sandboxed = false; }, value => { value.auxAttributes.processCrashCount = 1; },
    value => { value.featureStatus.gpu_compositing = 'disabled_software'; },
    value => { value.featureStatus.rasterization = 'disabled_software'; }]) {
    const invalid = structuredClone(good); update(invalid); assert.throws(() => GpuStatus.validate(invalid));
  }
  assert.throws(() => GpuStatus.validate(undefined));
});
test('GPU readiness uses only private browser-level SystemInfo and rejects endpoint redirection', async () => {
  const calls = [];
  class Socket extends EventEmitter {
    constructor(url) { super(); calls.push(url); queueMicrotask(() => this.emit('open')); }
    send(raw) {
      calls.push(JSON.parse(raw));
      queueMicrotask(() => this.emit('message', JSON.stringify({ id: 1, result: { gpu: {
        auxAttributes: { glRenderer: 'V3D', sandboxed: true, processCrashCount: 0 },
        featureStatus: { gpu_compositing: 'enabled', rasterization: 'enabled_force' },
      } } })));
    }
    close() { this.emit('close'); }
    terminate() { this.emit('close'); }
  }
  const response = endpoint => async () => ({ ok: true, json: async () => ({ webSocketDebuggerUrl: endpoint }) });
  await new GpuStatus(response('ws://127.0.0.1:9222/devtools/browser/test'), Socket).check();
  assert.deepEqual(calls[1], { id: 1, method: 'SystemInfo.getInfo' });
  for (const endpoint of ['ws://example.org:9222/devtools/browser/test', 'ws://127.0.0.1:9222/devtools/page/test',
    'ws://user:pass@127.0.0.1:9222/devtools/browser/test', 'ws://127.0.0.1:9222/devtools/browser/test?token=x']) {
    await assert.rejects(new GpuStatus(response(endpoint), Socket).check(), { code: 'GPU_CDP_ENDPOINT_NOT_PRIVATE' });
  }
  assert.equal(calls.length, 2);
});
test('display readiness drains large xdpyinfo output under pipefail', () => {
  const source = readFileSync('runtime/gpu-x11-start.sh', 'utf8');
  const condition = source.match(/if (timeout 2 xdpyinfo[^;]+); then ready=1;/)?.[1];
  assert(condition, 'Test must exercise the actual display-readiness command');
  const fixture = marker => `set -o pipefail
    timeout() { shift; "$@"; }
    xdpyinfo() { awk 'BEGIN { print "${marker}"; for(i=0;i<100000;i++) print "screen visual depth 24"; }'; }
    ${condition}`;
  execFileSync('bash', ['-c', fixture('DRI3')], { timeout: 5000 });
  assert.throws(() => execFileSync('bash', ['-c', fixture('DRI2')], { timeout: 5000 }), error => error.status === 1);
  // Prove the old early-exit pipeline reproduces the same readiness failure.
  assert.throws(() => execFileSync('bash', ['-c', fixture('DRI3').replace('grep DRI3 >/dev/null', 'grep -q DRI3')],
    { timeout: 5000 }), error => error.status !== 0);
});
