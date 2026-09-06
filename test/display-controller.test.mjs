import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';

const html = await readFile(new URL('../client/index.html', import.meta.url), 'utf8');
const result = await build({ entryPoints: ['client/display-controller.ts'], bundle: true, write: false,
  format: 'esm', platform: 'browser', target: 'es2022' });
const { DisplayController } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
const STORAGE_KEY = 'browserpane.display.v1';
const saved = (resolution = 'auto', density = 'auto') => JSON.stringify({ version: 1, resolution, density });
const near = (actual, expected) => assert(Math.abs(actual - expected) <= 1e-8, `${actual} != ${expected}`);

function fixture(t, { width = 1280, height = 720, dpr = 2, stored = null,
  readFailure = false, writeFailure = false, noMatchMedia = false } = {}) {
  const dom = new JSDOM(html, { url: 'https://viewer.test/browser/' });
  const { window } = dom;
  let availableWidth = width;
  let availableHeight = height;
  let density = dpr;
  const storage = new Map(stored === null ? [] : [[STORAGE_KEY, stored]]);
  const storageWrites = [];
  const frames = new Map();
  const timers = new Map();
  const observers = [];
  const queries = [];
  let identifier = 0;
  let now = 0;
  const localStorage = {
    getItem(key) { if (readFailure) throw Error('Storage blocked'); return storage.get(key) ?? null; },
    setItem(key, value) {
      if (writeFailure) throw Error('Storage blocked');
      storage.set(key, value); storageWrites.push({ key, value });
    },
  };
  class ResizeObserver {
    observed = new Set();
    constructor(callback) { this.callback = callback; observers.push(this); }
    observe(target) { this.observed.add(target); }
    disconnect() { this.observed.clear(); }
    notify() { if (this.observed.size) this.callback([], this); }
  }
  Object.defineProperty(window, 'devicePixelRatio', { configurable: true, get: () => density });
  if (!noMatchMedia) window.matchMedia = media => {
    const listeners = new Set();
    const query = { media, listeners,
      addEventListener(type, listener) { assert.equal(type, 'change'); listeners.add(listener); },
      removeEventListener(type, listener) { assert.equal(type, 'change'); listeners.delete(listener); },
      emit() { for (const listener of [...listeners]) listener({ matches: false, media }); },
    };
    queries.push(query);
    return query;
  };
  window.document.querySelector('#viewport').getBoundingClientRect = () => new window.DOMRect(0, 0, availableWidth, availableHeight);
  const globals = { window, document: window.document, localStorage, Option: window.Option, ResizeObserver,
    requestAnimationFrame(callback) { const id = ++identifier; frames.set(id, callback); return id; },
    cancelAnimationFrame(id) { frames.delete(id); },
    setTimeout(callback, ms = 0) { const id = ++identifier; timers.set(id, { callback, due: now + ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
  };
  const originals = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  let controller;
  t.after(() => {
    controller?.destroy();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    dom.window.close();
  });
  controller = new DisplayController();
  const element = id => window.document.querySelector(`#${id}`);
  return {
    controller, window, frames, timers, observers, queries, storage, storageWrites, element,
    css() { return { width: parseFloat(element('screen').style.getPropertyValue('--view-width')),
      height: parseFloat(element('screen').style.getPropertyValue('--view-height')) }; },
    select(id, value) { element(id).value = value; element(id).dispatchEvent(new window.Event('change')); },
    resize(nextWidth, nextHeight, notify = true) {
      availableWidth = nextWidth; availableHeight = nextHeight;
      if (notify) for (const observer of observers) observer.notify();
    },
    moveMonitor(nextDpr) { density = nextDpr; queries.at(-1)?.emit(); },
    flush() {
      let rounds = 0;
      while (frames.size) {
        assert(++rounds <= 12, 'Display notifications caused an animation-frame feedback loop');
        const callbacks = [...frames.values()]; frames.clear();
        for (const callback of callbacks) callback(now);
      }
      return rounds;
    },
    advance(ms) {
      now += ms;
      for (const [id, timer] of [...timers]) if (timer.due <= now && timers.delete(id)) timer.callback();
    },
  };
}

/** Minimal SDK contract: setters notify synchronously; locks suppress wire
 * resizes; unlocking restores the SDK's remembered fixed capture exactly once.
 * Actual pixels change only on ack(), so pending-status tests are meaningful. */
function session(f, initial = {}) {
  let state = { width: 640, height: 480, captureScale: 1, resolutionLocked: false, ...initial };
  let requested;
  const sizes = [];
  const scales = [];
  const requests = [];
  const notify = () => f.controller.onDisplayStateChange({ ...state });
  const adapter = {
    getDisplayState: () => ({ ...state }),
    getRenderDiagnostics: () => ({ software: false }),
    setCaptureScale(scale) { scales.push(scale); state.captureScale = scale; notify(); },
    setCaptureSize(size) {
      sizes.push({ ...size });
      const changed = requested?.width !== size.width || requested?.height !== size.height;
      requested = { ...size };
      if (changed && !state.resolutionLocked) requests.push({ ...requested });
      notify();
    },
  };
  return { adapter, sizes, scales, requests,
    attach() { f.controller.attach(adapter); },
    ack(width, height) { state = { ...state, width, height }; notify(); },
    lock(width, height) { state = { ...state, width, height, resolutionLocked: true }; notify(); },
    unlock() {
      if (state.resolutionLocked && requested) requests.push({ ...requested });
      state = { ...state, resolutionLocked: false }; notify();
    },
    notify,
  };
}

test('restores versioned preferences before computing initial connect options', t => {
  const f = fixture(t, { stored: saved('1600x900', '1.25'), width: 1920, height: 1080 });
  assert.equal(f.element('resolution').value, '1600x900');
  assert.equal(f.element('density').value, '1.25');
  assert.deepEqual(f.controller.getConnectOptions(), { captureScale: 1.25, captureSize: { width: 1600, height: 900 } });
  assert.deepEqual(f.css(), { width: 1280, height: 720 });
  assert.equal(f.storageWrites.length, 0, 'Reading preferences must not rewrite storage');
  assert.equal(f.controller.hasDrawableSpace(), true);
});

test('malformed saved preferences select safe Auto defaults', t => {
  const f = fixture(t, { stored: '{"version":999,"resolution":"3840x2160","density":"2"}' });
  assert.equal(f.element('resolution').value, 'auto');
  assert.equal(f.element('density').value, 'auto');
  assert.deepEqual(f.controller.getConnectOptions(), { captureScale: 1, captureSize: { width: 1280, height: 720 } });
});

test('storage read failure does not prevent a drawable default viewer', t => {
  const f = fixture(t, { readFailure: true });
  assert.equal(f.controller.hasDrawableSpace(), true);
  assert.equal(f.element('resolution').value, 'auto');
});

test('control changes persist exact allowlisted preferences and are fresh before RAF/connect', t => {
  const f = fixture(t);
  f.select('resolution', '1920x1080');
  f.select('density', '1.5');
  assert.equal(f.frames.size, 1, 'Rapid settings changes coalesce');
  assert.deepEqual(f.controller.getConnectOptions(), { captureScale: 1.5, captureSize: { width: 1920, height: 1080 } });
  assert.deepEqual(JSON.parse(f.storage.get(STORAGE_KEY)), { version: 1, resolution: '1920x1080', density: '1.5' });
  f.flush();
  assert.deepEqual(f.css(), { width: 1280, height: 720 });
});

test('storage write failure applies preferences and shows one bounded notice timer', t => {
  const f = fixture(t, { writeFailure: true });
  const s = session(f); s.attach(); f.flush();
  f.select('resolution', '1600x900');
  f.select('density', '2');
  f.flush();
  assert.deepEqual(s.requests.at(-1), { width: 1600, height: 900 });
  assert.equal(s.scales.at(-1), 2);
  assert.match(f.element('display-notice').textContent, /cannot save/);
  assert.equal(f.timers.size, 1);
  f.advance(5999);
  assert.notEqual(f.element('display-notice').textContent, '');
  f.advance(1);
  assert.equal(f.element('display-notice').textContent, '');
});

test('fixed capture survives density and viewport-fit changes with no physical resize', t => {
  const f = fixture(t, { stored: saved('1920x1080', '1') });
  const s = session(f); s.attach(); f.flush();
  assert.deepEqual(s.requests, [{ width: 1920, height: 1080 }]);
  for (const density of ['1.25', '1.5', '2', 'native', 'auto']) {
    f.select('density', density); f.flush();
    f.resize(500, 600); f.flush();
    const css = f.css();
    near(css.width / css.height, 16 / 9);
    assert(css.width <= 500 + 1e-9 && css.height <= 600 + 1e-9);
    f.resize(4000, 3000); f.flush();
  }
  assert.deepEqual(s.requests, [{ width: 1920, height: 1080 }]);
  assert.equal(s.sizes.length, 1);
});

test('Auto viewport changes resize only when aligned physical capture actually changes', t => {
  const f = fixture(t);
  const s = session(f); s.attach(); f.flush();
  f.resize(1920, 1080); f.flush();
  assert.equal(s.requests.length, 1, 'Same capped 1280x720 capture should be reused');
  f.resize(800, 600); f.flush();
  assert.deepEqual(s.requests.at(-1), { width: 800, height: 600 });
  f.resize(807, 601); f.flush();
  assert.equal(s.requests.length, 2, 'Sub-alignment CSS changes must not request another capture');
});

test('locked viewer preserves exact shared dimensions, blocks resolution changes and retains saved preference', t => {
  const f = fixture(t, { stored: saved('1600x900', '1.25') });
  const s = session(f, { width: 1366, height: 769, resolutionLocked: true });
  s.attach(); f.flush();
  assert.equal(f.element('resolution').disabled, true);
  assert.equal(f.element('density').disabled, false, 'Density remains a local secondary-viewer setting');
  assert.deepEqual(s.sizes, [{ width: 1600, height: 900 }], 'Only remember our future owner preference, never the locked geometry');
  assert.equal(s.requests.length, 0);
  near(f.css().width / f.css().height, 1366 / 769);
  f.select('resolution', '1920x1080'); f.flush();
  assert.equal(f.element('resolution').value, '1600x900');
  assert.equal(JSON.parse(f.storage.get(STORAGE_KEY)).resolution, '1600x900');
  assert.equal(s.sizes.length, 1);
  assert.equal(s.requests.length, 0);
  assert.match(f.element('display-summary').textContent, /1366 × 769.*locked/);
});

test('locked density is local, persists without changing saved resolution and never resizes capture', t => {
  const f = fixture(t, { stored: saved('1600x900', '1') });
  const s = session(f, { width: 1366, height: 769, resolutionLocked: true });
  s.attach(); f.flush();
  f.select('density', '2'); f.flush();
  assert.deepEqual(JSON.parse(f.storage.get(STORAGE_KEY)), { version: 1, resolution: '1600x900', density: '2' });
  assert.deepEqual(f.css(), { width: 683, height: 384.5 });
  assert.equal(s.scales.at(-1), 2);
  assert.deepEqual(s.sizes, [{ width: 1600, height: 900 }]);
  assert.equal(s.requests.length, 0);
});

test('initially locked viewer applies its saved preferred resolution once after unlock', t => {
  const f = fixture(t, { stored: saved('1600x900', '1.5') });
  const s = session(f, { width: 1366, height: 769, resolutionLocked: true });
  s.attach(); f.flush();
  assert.equal(s.requests.length, 0);
  s.unlock(); f.flush();
  assert.equal(f.element('resolution').disabled, false);
  assert.deepEqual(s.requests, [{ width: 1600, height: 900 }]);
  for (let i = 0; i < 5; i++) s.notify();
  f.flush();
  assert.equal(s.requests.length, 1);
  assert.equal(JSON.parse(f.storage.get(STORAGE_KEY)).resolution, '1600x900');
});

test('owner lock/unlock with unchanged desired size relies on SDK restoration without duplicate requests', t => {
  const f = fixture(t, { stored: saved('1600x900', '1') });
  const s = session(f); s.attach(); f.flush();
  s.ack(1600, 900); f.flush();
  s.requests.length = 0;
  s.lock(1366, 769); f.flush();
  assert.equal(s.requests.length, 0);
  s.unlock(); f.flush();
  assert.deepEqual(s.requests, [{ width: 1600, height: 900 }]);
  assert.equal(s.sizes.length, 1, 'Controller must not repeat the same requested setting');
});

test('Auto viewport changes while locked update only the future preference; unlock sends the latest size once', t => {
  const f = fixture(t);
  const s = session(f, { width: 1366, height: 769, resolutionLocked: true });
  s.attach(); f.flush();
  assert.deepEqual(s.sizes, [{ width: 1280, height: 720 }]);
  f.resize(800, 600); f.flush();
  assert.deepEqual(s.sizes.at(-1), { width: 800, height: 600 });
  assert.equal(s.requests.length, 0, 'Remembered preferences must not resize another owner\'s capture');
  near(f.css().width / f.css().height, 1366 / 769, 'Displayed geometry must remain authoritative');
  s.unlock(); f.flush();
  assert.deepEqual(s.requests, [{ width: 800, height: 600 }], 'Do not request obsolete 1280x720 before the new size');
  assert.equal(s.sizes.length, 2);
});

test('unknown locked dimensions still prevent a resize and preserve controls/preferences', t => {
  const f = fixture(t, { stored: saved('1920x1080', 'native') });
  const s = session(f, { width: 0, height: 0, resolutionLocked: true });
  s.attach(); f.flush();
  assert.equal(f.element('resolution').disabled, true);
  assert.equal(s.requests.length, 0);
  assert.deepEqual(s.sizes, [{ width: 1920, height: 1080 }]);
});

test('Native follows monitor DPR changes without CSS resize and re-arms only one query listener', t => {
  const f = fixture(t, { stored: saved('1280x720', 'native'), dpr: 1 });
  const s = session(f); s.attach(); f.flush();
  assert.deepEqual(f.css(), { width: 1280, height: 720 });
  const originalQuery = f.queries.at(-1);
  f.moveMonitor(2); f.flush();
  assert.deepEqual(f.css(), { width: 640, height: 360 });
  assert.equal(s.scales.at(-1), 2);
  assert.equal(s.requests.length, 1);
  assert.equal(originalQuery.listeners.size, 0);
  assert.equal(f.queries.at(-1).media, '(resolution: 2dppx)');
  assert.equal(f.queries.reduce((count, query) => count + query.listeners.size, 0), 1);
  f.moveMonitor(1.25); f.flush();
  assert.deepEqual(f.css(), { width: 1024, height: 576 });
  assert.equal(s.requests.length, 1);
});

test('Auto density remains readable 1x across monitor moves', t => {
  const f = fixture(t, { stored: saved('1280x720', 'auto'), dpr: 1 });
  const s = session(f); s.attach(); f.flush();
  f.moveMonitor(3); f.flush();
  assert.deepEqual(f.css(), { width: 1280, height: 720 });
  assert.deepEqual(s.scales, [1]);
  assert.equal(s.requests.length, 1);
  assert.match(f.element('display-summary').title, /Monitor density: 3×/);
});

test('resize and fullscreen notifications coalesce and use fresh available geometry', t => {
  const f = fixture(t, { stored: saved('1920x1080', '1') });
  const s = session(f); s.attach(); f.flush();
  f.resize(640, 480, false);
  f.window.dispatchEvent(new f.window.Event('resize'));
  f.window.document.dispatchEvent(new f.window.Event('fullscreenchange'));
  f.observers[0].notify();
  assert.equal(f.frames.size, 1);
  f.flush();
  assert.deepEqual(f.css(), { width: 640, height: 360 });
  assert.equal(s.requests.length, 1);
});

test('lack of matchMedia does not break settings or ordinary window resize', t => {
  const f = fixture(t, { noMatchMedia: true });
  const s = session(f); s.attach(); f.flush();
  f.resize(800, 600, false);
  f.window.dispatchEvent(new f.window.Event('resize')); f.flush();
  assert.deepEqual(s.requests.at(-1), { width: 800, height: 600 });
});

test('synchronous display-state callbacks and later ACKs cannot create a resize loop', t => {
  const f = fixture(t, { stored: saved('1920x1080', '2') });
  const s = session(f); s.attach();
  assert(f.flush() <= 2);
  assert.deepEqual(s.scales, [2]);
  assert.deepEqual(s.requests, [{ width: 1920, height: 1080 }]);
  assert.match(f.element('display-summary').textContent, /640 × 480 → 1920 × 1080/);
  s.ack(1920, 1080); f.flush();
  assert.doesNotMatch(f.element('display-summary').textContent, /→/);
  for (let i = 0; i < 10; i++) s.notify();
  assert(f.flush() <= 1);
  assert.equal(s.sizes.length, 1);
  assert.equal(s.scales.length, 1);
  assert.equal(f.frames.size, 0);
});

test('hidden viewport does not send capture requests and becomes drawable without losing preference', t => {
  const f = fixture(t, { width: 0, height: 0, stored: saved('1600x900', '1.25') });
  const s = session(f); s.attach(); f.flush();
  assert.equal(f.controller.hasDrawableSpace(), false);
  assert.deepEqual(f.css(), { width: 0, height: 0 });
  assert.equal(s.requests.length, 0);
  assert.equal(s.sizes.length, 0);
  f.resize(1280, 720); f.flush();
  assert.equal(f.controller.hasDrawableSpace(), true);
  assert.deepEqual(s.requests, [{ width: 1600, height: 900 }]);
  f.resize(0, 0); f.flush();
  f.select('density', '2'); f.flush();
  assert.equal(s.requests.length, 1);
  assert.equal(JSON.parse(f.storage.get(STORAGE_KEY)).resolution, '1600x900');
});

test('detaching stops updates to the old session; reattachment applies current preferences once', t => {
  const f = fixture(t);
  const first = session(f); first.attach(); f.flush();
  f.controller.attach(null); f.flush();
  f.select('resolution', '1920x1080'); f.flush();
  assert.equal(first.requests.length, 1);
  const second = session(f); second.attach(); f.flush();
  assert.deepEqual(second.requests, [{ width: 1920, height: 1080 }]);
  assert.equal(first.requests.length, 1);
});

test('destroy removes observer/events/media query, cancels RAF and notice timers', t => {
  const f = fixture(t);
  const s = session(f); s.attach(); f.flush();
  f.controller.showNotice('Temporary');
  f.resize(800, 600);
  assert.equal(f.frames.size, 1);
  assert.equal(f.timers.size, 1);
  const writes = f.storageWrites.length;
  const requests = s.requests.length;
  const queryCount = f.queries.length;
  f.controller.destroy();
  assert.equal(f.frames.size, 0);
  assert.equal(f.timers.size, 0);
  assert(f.observers.every(observer => observer.observed.size === 0));
  assert(f.queries.every(query => query.listeners.size === 0));
  f.window.dispatchEvent(new f.window.Event('resize'));
  f.window.document.dispatchEvent(new f.window.Event('fullscreenchange'));
  f.select('resolution', '1920x1080');
  f.moveMonitor(3);
  f.resize(1000, 900);
  s.notify();
  f.flush();
  assert.equal(f.frames.size, 0);
  assert.equal(f.storageWrites.length, writes);
  assert.equal(s.requests.length, requests);
  assert.equal(f.queries.length, queryCount);
});

test('late rejected fullscreen notice after destroy cannot reintroduce timers or UI changes', t => {
  const f = fixture(t);
  f.controller.destroy();
  const before = f.element('display-notice').textContent;
  f.controller.showNotice('Late full screen error');
  assert.equal(f.element('display-notice').textContent, before);
  assert.equal(f.timers.size, 0);
});
