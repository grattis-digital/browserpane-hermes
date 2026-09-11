import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import assert from 'node:assert/strict';

const bundle = await build({ entryPoints: ['client/enhancement/enhancement-controller.ts'], bundle: true,
  write: false, format: 'esm', platform: 'browser' });
const { EnhancementController } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);

export function upscaleFixture(t, options = {}) {
  const dom = new JSDOM(`<select id="enhancement"><option value="original">Original</option><option value="smart">Balanced</option>
    <option value="smart-quality">Quality</option></select>
    <span id="status"></span><div><canvas width="256" height="128"></canvas></div>`,
  { url: 'https://viewer.test/', pretendToBeVisual: true });
  const { window } = dom;
  const source = window.document.querySelector('canvas');
  source.dataset.bpaneRenderer = options.renderer ?? 'webgl2';
  source.getBoundingClientRect = () => ({ width: source.width, height: source.height });
  window.devicePixelRatio = options.dpr ?? 2;
  let now = 0, identifier = 0, hidden = false;
  Object.defineProperty(window.document, 'hidden', { get: () => hidden });
  const frames = new Map(), timers = new Map(), contexts = new Map(), creations = [], renders = [], bitmaps = [], losses = [];
  window.HTMLCanvasElement.prototype.getContext = function () {
    if (!contexts.has(this)) contexts.set(this, { clears: [], draws: [], imageSmoothingEnabled: true,
      clearRect(...args) { this.clears.push(args); }, drawImage(...args) { this.draws.push(args); } });
    return contexts.get(this);
  };
  const observers = [];
  class Observer {
    constructor(callback) { this.callback = callback; observers.push(this); }
    observe() {} disconnect() {}
  }
  const globals = { window, document: window.document, CustomEvent: window.CustomEvent,
    navigator: { gpu: options.gpu === false ? undefined : {} }, isSecureContext: options.secure ?? true,
    localStorage: options.storage ?? window.localStorage, performance: { now: () => now },
    ResizeObserver: Observer, MutationObserver: Observer,
    requestAnimationFrame(callback) { const id = ++identifier; frames.set(id, callback); return id; },
    cancelAnimationFrame(id) { frames.delete(id); },
    setTimeout(callback, delay = 0) { const id = ++identifier; timers.set(id, { callback, due: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
  };
  const originals = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const bitmap = () => { const image = { closed: 0, close() { this.closed++; } }; bitmaps.push(image); return image; };
  const create = async (fail, signal, mode) => {
    const renderer = { destroyCalls: 0, destroy() { this.destroyCalls++; },
      render(canvas, rect) { renders.push({ canvas, rect }); return options.render ? options.render(bitmap) : Promise.resolve(bitmap()); } };
    creations.push({ renderer, signal, mode }); losses.push(fail);
    return options.create ? options.create(renderer, signal) : renderer;
  };
  const select = window.document.querySelector('select');
  const status = window.document.querySelector('#status');
  const controller = new EnhancementController(select, status, create);
  controller.start(); controller.attach(source);
  t.after(() => {
    controller.destroy();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
    }
    dom.window.close();
  });
  return { controller, source, window, creations, renders, bitmaps, losses, timers, frames, contexts, status,
    overlay: () => window.document.querySelector('.smart-upscale-overlay'),
    select(value) { select.value = value; select.dispatchEvent(new window.Event('change')); },
    damage(kind = 'tile', rect = { x: 0, y: 0, w: 256, h: 128 }) {
      source.dispatchEvent(new window.CustomEvent('bpane:presentation-damage', { detail: { ...rect, kind } }));
    },
    hide(value) { hidden = value; window.document.dispatchEvent(new window.Event('visibilitychange')); },
    resize(width, height) { source.width = width; source.height = height; for (const observer of observers) observer.callback(); },
    async step(ms = 0) {
      now += ms;
      for (let rounds = 0; rounds < 30; rounds++) {
        for (const [id, timer] of [...timers]) if (timer.due <= now && timers.delete(id)) timer.callback();
        const callbacks = [...frames.values()]; frames.clear();
        for (const callback of callbacks) callback(now);
        await Promise.resolve();
      }
      assert(![...timers.values()].some(timer => timer.due <= now), 'Runaway scheduling');
    },
  };
}
