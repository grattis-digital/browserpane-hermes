import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const path = resolve('native/chromium-damage/chromium-test-launcher.sh');
const args = (mode, values) => execFileSync('bash', ['-c',
  'source "$1"; shift; bpane_custom_chromium_args "$@" || exit $?; printf "%s\\0" "${BPANE_CUSTOM_ARGS[@]}"',
  'test', path, mode, ...values], { encoding: 'utf8' }).split('\0').slice(0, -1);

test('custom Chromium defaults off without modifying unrelated GPU and profile flags', () => {
  const original = ['--ozone-platform=x11', '--use-angle=gles-egl', '--user-data-dir=/data/profile', 'about:blank'];
  assert.deepEqual(args('0', original), [...original, '--disable-features=BrowserPaneSurfaceDamage']);
  assert.deepEqual(args('1', original), [...original, '--enable-features=BrowserPaneSurfaceDamage']);
});

test('merges into existing feature lists without overriding other requested features', () => {
  assert.deepEqual(args('1', ['--enable-features=A,B', '--disable-features=C']),
    ['--enable-features=A,B,BrowserPaneSurfaceDamage', '--disable-features=C']);
  assert.deepEqual(args('0', ['--enable-features=A', '--disable-features=B']),
    ['--enable-features=A', '--disable-features=B,BrowserPaneSurfaceDamage']);
  assert.deepEqual(args('1', ['--enable-features=', '--enable-features=A,']),
    ['--enable-features=BrowserPaneSurfaceDamage', '--enable-features=A,BrowserPaneSurfaceDamage']);
});

test('rejects conflicting feature selection and sandbox downgrades', () => {
  for (const flag of ['--no-sandbox', '--no-sandbox=true', '--disable-gpu-sandbox',
    '--enable-features=BrowserPaneSurfaceDamage', '--disable-features=A,BrowserPaneSurfaceDamage']) {
    assert.throws(() => args('1', [flag]), error => error.status === 64);
  }
  assert.throws(() => args('yes', []), error => error.status === 64);
});

test('entrypoint refuses ordinary deployment and malformed test tokens', () => {
  for (const env of [{ BPANE_PIPELINE_TEST: '0' }, { BPANE_PIPELINE_TEST: '1', BPANE_RENDER_PILOT: 'invalid' }]) {
    assert.throws(() => execFileSync('bash', [path], {
      env: { PATH: process.env.PATH, ...env }, stdio: 'pipe', timeout: 1000,
    }), error => error.status === 64);
  }
});
