import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { ScrollCopyDiagnostics } from '../scripts/scroll-copy-diagnostics.mjs';

test('retained-copy qualification requires actual operations from the selected backend', () => {
  const before = backend => ({ cache: { scrollCopies: 0 }, render: { backend }, blits: 0, canvasCopies: 0 });
  const after = (backend, blits, canvasCopies) => ({ cache: { scrollCopies: 8 }, render: { backend }, blits, canvasCopies });
  assert.doesNotThrow(() => ScrollCopyDiagnostics.assertRetainedCoverage(before('webgl2'), after('webgl2', 16, 0)));
  assert.doesNotThrow(() => ScrollCopyDiagnostics.assertRetainedCoverage(before('canvas2d'), after('canvas2d', 0, 8)));
  assert.throws(() => ScrollCopyDiagnostics.assertRetainedCoverage(before('webgl2'), after('webgl2', 0, 80)), /GPU blits/);
  assert.throws(() => ScrollCopyDiagnostics.assertRetainedCoverage(before('canvas2d'), after('canvas2d', 160, 0)), /Canvas2D copies/);
  assert.throws(() => ScrollCopyDiagnostics.assertRetainedCoverage(before('canvas2d'), after('webgl2', 16, 8)), /Renderer changed/);
});

test('Canvas2D probe counts only successful nonempty screen-sized source copies onto the main canvas', () => {
  class Canvas { constructor(width = 8, height = 8) { this.width = width; this.height = height; } }
  class Context {
    constructor(canvas) { this.canvas = canvas; }
    drawImage(...args) { if (args[0] === null) throw new Error('Invalid source'); return 'native'; }
  }
  class Gl { blitFramebuffer() {} }
  const screen = new Canvas(), scratch = new Canvas(), cursor = new Canvas();
  const window = {};
  runInNewContext(`(${ScrollCopyDiagnostics.install.toString()})()`, { window,
    document: { querySelector: () => screen }, HTMLCanvasElement: Canvas,
    CanvasRenderingContext2D: Context, WebGL2RenderingContext: Gl });
  const main = new Context(screen);
  assert.equal(main.drawImage(scratch, 0, 0, 8, 6, 0, 2, 8, 6), 'native');
  main.drawImage(screen, 0, 2, 8, 6, 0, 0, 8, 6);
  new Context(cursor).drawImage(scratch, 0, 0, 8, 6, 0, 2, 8, 6);
  main.drawImage(new Canvas(1, 1), 0, 0, 1, 1, 0, 0, 1, 1);
  main.drawImage(scratch, 0, 0, 8, 0, 0, 2, 8, 0);
  main.drawImage(scratch, 0, 0);
  assert.throws(() => main.drawImage(null, 0, 0, 8, 6, 0, 2, 8, 6), /Invalid source/);
  assert.equal(window.__scrollOracleCanvasCopies, 2);
});
