import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { transform } from 'esbuild';

// Exercise the actual dependency-free TS module without generated test files.
const source = await readFile(new URL('../client/display-settings.ts', import.meta.url), 'utf8');
const { code } = await transform(source, { loader: 'ts', format: 'esm', target: 'node22' });
const { DEFAULT_DISPLAY_PREFERENCES, RESOLUTION_PRESETS, DENSITY_OPTIONS,
  AUTO_CAPTURE_PIXEL_BUDGET, readDisplayPreferences, writeDisplayPreferences,
  computeDisplayLayout } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);

const layout = (preferences = {}, inputs = {}) => computeDisplayLayout({
  preferences: { ...DEFAULT_DISPLAY_PREFERENCES, ...preferences },
  availableWidth: 1280, availableHeight: 720, devicePixelRatio: 2, ...inputs,
});
const near = (actual, expected, message = '') => assert(Math.abs(actual - expected) <= Math.max(1, Math.abs(expected)) * 1e-10,
  `${message}: ${actual} != ${expected}`);

test('exports the requested resolution and density allowlists', () => {
  assert.deepEqual(RESOLUTION_PRESETS.map(option => option.value), ['auto', '800x600', '1024x768', '1280x720',
    '1280x800', '1360x768', '1440x900', '1600x900', '1920x1080']);
  assert.deepEqual(DENSITY_OPTIONS.map(option => option.value), ['auto', '1', '1.25', '1.5', '2', 'native']);
  assert.deepEqual(DEFAULT_DISPLAY_PREFERENCES, { resolution: 'auto', density: 'auto' });
});

test('versioned preferences round trip every allowlisted combination', () => {
  for (const resolution of RESOLUTION_PRESETS) for (const density of DENSITY_OPTIONS) {
    const preferences = { resolution: resolution.value, density: density.value };
    const raw = writeDisplayPreferences(preferences);
    assert.deepEqual(JSON.parse(raw), { version: 1, ...preferences });
    assert.deepEqual(readDisplayPreferences(raw), preferences);
  }
});

test('invalid storage records fall back as a whole without throwing', () => {
  const cases = [null, undefined, '', '{', 'null', '[]', 'true', '1', '"auto"',
    '{}', '{"version":2,"resolution":"1280x720","density":"2"}',
    '{"version":"1","resolution":"1280x720","density":"2"}',
    '{"version":1,"resolution":"1280x720","density":2}',
    '{"version":1,"resolution":"1280x720","density":"3"}',
    '{"version":1,"resolution":"9999x9999","density":"2"}',
    '{"version":1,"resolution":"2560x1440","density":"1"}',
    '{"version":1,"resolution":"3840x2160","density":"2"}',
    '{"version":1,"resolution":"auto","density":"auto","extra":true}',
    '{"version":1,"resolution":"auto","density":"auto","__proto__":{}}',
    ' '.repeat(4097)];
  for (const raw of cases) assert.deepEqual(readDisplayPreferences(raw), DEFAULT_DISPLAY_PREFERENCES);
  assert.deepEqual(readDisplayPreferences(writeDisplayPreferences({ resolution: 'bad', density: '2' })), DEFAULT_DISPLAY_PREFERENCES);
  const first = readDisplayPreferences(null);
  first.resolution = '800x600';
  assert.deepEqual(readDisplayPreferences(null), DEFAULT_DISPLAY_PREFERENCES, 'fallback objects must not be shared');
});

test('Auto density is an explicit readable 1x policy, not monitor detection or a benchmark', () => {
  for (const devicePixelRatio of [1, 1.25, 1.5, 2, 3, 5, NaN]) {
    const result = layout({}, { devicePixelRatio });
    assert.equal(result.captureScale, 1);
    assert.deepEqual([result.width, result.height, result.cssWidth, result.cssHeight], [1280, 720, 1280, 720]);
    assert.equal(result.autoLimited, false);
    assert.match(result.reason, /DPR 1/);
    assert.match(result.reason, /conservative policy, not a benchmark/);
  }
  const software = layout({}, { softwareRenderer: true });
  assert.equal(software.captureScale, 1);
  assert.match(software.reason, /Software rendering reported/);
});

test('native density clamps valid monitor DPR while invalid values safely use 1x', () => {
  for (const [devicePixelRatio, expected] of [[0.75, 1], [1, 1], [1.25, 1.25], [1.5, 1.5], [2, 2], [3, 3], [5, 3],
    [0, 1], [-1, 1], [NaN, 1], [Infinity, 1], [-Infinity, 1]]) {
    const result = layout({ resolution: '1280x720', density: 'native' }, { devicePixelRatio });
    assert.equal(result.captureScale, expected);
    near(result.cssWidth, 1280 / expected);
    near(result.cssHeight, 720 / expected);
    near(result.effectiveScale, expected);
  }
});

test('manual density remains an explicit choice even with a software renderer', () => {
  for (const density of ['1', '1.25', '1.5', '2']) {
    const result = layout({ resolution: '1280x720', density }, { softwareRenderer: true });
    assert.equal(result.captureScale, Number(density));
    near(result.cssWidth, 1280 / Number(density));
    near(result.effectiveScale, Number(density));
  }
});

test('fixed physical presets never change across density choices or viewport fits', () => {
  for (const preset of RESOLUTION_PRESETS.filter(option => option.width)) {
    for (const density of DENSITY_OPTIONS) for (const [availableWidth, availableHeight] of [[1920, 1080], [300, 150], [2000, 200], [100, 1500], [10000, 10000]]) {
      const result = layout({ resolution: preset.value, density: density.value }, { availableWidth, availableHeight });
      assert.deepEqual([result.width, result.height], [preset.width, preset.height]);
      assert.equal(result.autoLimited, false);
      assert(result.cssWidth <= availableWidth + 1e-9);
      assert(result.cssHeight <= availableHeight + 1e-9);
      assert(result.cssWidth <= result.width / result.captureScale + 1e-9);
      assert(result.cssHeight <= result.height / result.captureScale + 1e-9);
      near(result.cssWidth / result.cssHeight, result.width / result.height);
      near(result.width / result.cssWidth, result.height / result.cssHeight);
      near(result.effectiveScale, result.width / result.cssWidth);
    }
  }
});

test('fixed captures fit uniformly and never upscale above their natural density size', () => {
  const large = layout({ resolution: '1280x720' }, { availableWidth: 3840, availableHeight: 2160 });
  assert.deepEqual([large.cssWidth, large.cssHeight], [1280, 720]);
  const fitted = layout({ resolution: '1920x1080', density: '1.5' }, { availableWidth: 800, availableHeight: 1000 });
  assert.deepEqual([fitted.width, fitted.height, fitted.cssWidth, fitted.cssHeight], [1920, 1080, 800, 450]);
  assert.equal(fitted.captureScale, 1.5);
  assert.equal(fitted.effectiveScale, 2.4);
});

test('Auto resolution limits capture area, follows available aspect and aligns after scaling', () => {
  const wide = layout({}, { availableWidth: 1920, availableHeight: 1080 });
  assert.deepEqual([wide.width, wide.height, wide.cssWidth, wide.cssHeight], [1280, 720, 1280, 720]);
  assert.equal(wide.autoLimited, true);
  const square = layout({}, { availableWidth: 2000, availableHeight: 2000 });
  assert.deepEqual([square.width, square.height], [960, 960]);
  const fractional = layout({}, { availableWidth: 1366.9, availableHeight: 769.9 });
  assert(fractional.width * fractional.height <= AUTO_CAPTURE_PIXEL_BUDGET);
  // Apart from host minima, down-alignment loses less than one quantum/axis.
  const factor = Math.sqrt(AUTO_CAPTURE_PIXEL_BUDGET / (1366.9 * 769.9));
  assert(1366.9 * factor - fractional.width >= 0 && 1366.9 * factor - fractional.width < 8);
  assert(769.9 * factor - fractional.height >= 0 && 769.9 * factor - fractional.height < 2);
  const dense = layout({ density: '2' }, { availableWidth: 640, availableHeight: 360 });
  assert.deepEqual([dense.width, dense.height, dense.cssWidth, dense.cssHeight], [1280, 720, 640, 360]);
});

test('Auto minima and extreme aspect ratios letterbox within the pixel and host limits', () => {
  for (const [availableWidth, availableHeight] of [[100, 100], [10, 10000], [10000, 10], [1, 1], [0.5, 0.25], [999999, 1], [1, 999999]]) {
    const result = layout({}, { availableWidth, availableHeight });
    assert(result.width >= 320 && result.width <= 3840);
    assert(result.height >= 200 && result.height <= 2160);
    assert.equal(result.width % 8, 0);
    assert.equal(result.height % 2, 0);
    assert(result.width * result.height <= AUTO_CAPTURE_PIXEL_BUDGET);
    assert(result.cssWidth <= availableWidth + 1e-9);
    assert(result.cssHeight <= availableHeight + 1e-9);
    near(result.cssWidth / result.cssHeight, result.width / result.height);
  }
});

test('invalid runtime preferences and non-finite dimensions cannot generate invalid layouts', () => {
  for (const availableWidth of [0, -1, NaN, Infinity, -Infinity, Number.MIN_VALUE, Number.MAX_VALUE]) {
    for (const availableHeight of [0, 720, NaN, Infinity, Number.MIN_VALUE, Number.MAX_VALUE]) {
      const result = layout({}, { availableWidth, availableHeight, preferences: { resolution: 'bad', density: 'not-a-number' } });
      for (const key of ['width', 'height', 'cssWidth', 'cssHeight', 'captureScale', 'effectiveScale']) {
        assert(Number.isFinite(result[key]), `${key} must be finite`);
        assert(result[key] >= 0);
      }
      assert(result.width * result.height <= AUTO_CAPTURE_PIXEL_BUDGET);
      if (result.cssWidth === 0 || result.cssHeight === 0) {
        assert.deepEqual([result.cssWidth, result.cssHeight, result.effectiveScale], [0, 0, 0]);
        assert.match(result.reason, /defer capture changes/);
      }
    }
  }
});

test('authoritative capture is exact, unrounded and independent of local presets or density', () => {
  for (const authoritativeSize of [{ width: 1366, height: 769 }, { width: 123, height: 99 }, { width: 65535, height: 65535 }]) {
    for (const density of DENSITY_OPTIONS) {
      const result = layout({ resolution: '1920x1080', density: density.value }, { authoritativeSize });
      assert.deepEqual([result.width, result.height], [authoritativeSize.width, authoritativeSize.height]);
      assert.equal(result.autoLimited, false);
      assert.match(result.reason, /authoritative/);
      near(result.cssWidth / result.cssHeight, result.width / result.height);
      near(result.effectiveScale, result.width / result.cssWidth);
    }
  }
});

test('invalid authoritative geometry cannot inject non-finite or out-of-protocol sizes', () => {
  for (const authoritativeSize of [{ width: NaN, height: 720 }, { width: 0, height: 720 }, { width: 1280, height: Infinity },
    { width: 1280.5, height: 720 }, { width: 65536, height: 720 }, { width: -1, height: 720 }]) {
    const result = layout({ resolution: '1280x720' }, { authoritativeSize });
    assert.deepEqual([result.width, result.height], [1280, 720]);
    assert.doesNotMatch(result.reason, /authoritative/);
  }
});

test('randomized Auto layouts preserve geometry, bounded capture and finite effective density', () => {
  let state = 0x89132;
  const random = () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 0x100000000);
  for (let index = 0; index < 3000; index++) {
    const availableWidth = 0.1 + random() * 15000;
    const availableHeight = 0.1 + random() * 15000;
    const density = DENSITY_OPTIONS[Math.floor(random() * DENSITY_OPTIONS.length)].value;
    const result = layout({ density }, { availableWidth, availableHeight, devicePixelRatio: random() * 5 });
    assert(result.width >= 320 && result.width <= 3840);
    assert(result.height >= 200 && result.height <= 2160);
    assert.equal(result.width % 8, 0);
    assert.equal(result.height % 2, 0);
    assert(result.width * result.height <= AUTO_CAPTURE_PIXEL_BUDGET);
    assert(result.cssWidth <= availableWidth + 1e-9);
    assert(result.cssHeight <= availableHeight + 1e-9);
    assert(result.cssWidth <= result.width / result.captureScale + 1e-9);
    assert(result.cssHeight <= result.height / result.captureScale + 1e-9);
    near(result.cssWidth / result.cssHeight, result.width / result.height);
    near(result.effectiveScale, result.width / result.cssWidth);
    assert(Number.isFinite(result.effectiveScale));
  }
});
