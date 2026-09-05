import assert from 'node:assert/strict';

// Observer-only hooks for disposable pixel oracles. A software viewer must
// perform real Canvas2D copies, not pretend to have issued GPU operations.
export class ScrollCopyDiagnostics {
  static install = () => {
    window.__scrollOracleBlits = 0;
    window.__scrollOracleCanvasCopies = 0;
    const originalBlit = WebGL2RenderingContext.prototype.blitFramebuffer;
    WebGL2RenderingContext.prototype.blitFramebuffer = function (...args) {
      const result = originalBlit.apply(this, args);
      if (args[0] !== args[2] && args[1] !== args[3] && args[4] !== args[6] && args[5] !== args[7]) window.__scrollOracleBlits++;
      return result;
    };
    const originalDraw = CanvasRenderingContext2D.prototype.drawImage;
    CanvasRenderingContext2D.prototype.drawImage = function (...args) {
      const result = originalDraw.apply(this, args);
      const screen = document.querySelector('#screen canvas'), source = args[0];
      if (this.canvas === screen && args.length === 9 && source instanceof HTMLCanvasElement
        && source.width === screen.width && source.height === screen.height
        && args[3] > 0 && args[4] > 0 && args[7] > 0 && args[8] > 0) {
        window.__scrollOracleCanvasCopies++;
      }
      return result;
    };
  };

  static assertRetainedCoverage(before, after) {
    assert(after.cache.scrollCopies - before.cache.scrollCopies >= 8, 'Insufficient retained-scroll stress coverage');
    assert.equal(after.render.backend, before.render.backend, 'Renderer changed during retained-copy measurement');
    if (after.render.backend === 'webgl2') {
      assert(after.blits - before.blits >= 16, 'Retained copies did not issue real nonempty GPU blits');
    } else {
      assert.equal(after.render.backend, 'canvas2d', 'Unknown retained-copy renderer');
      assert(after.canvasCopies - before.canvasCopies >= 8, 'Retained copies did not issue real nonempty Canvas2D copies');
    }
  }
}
