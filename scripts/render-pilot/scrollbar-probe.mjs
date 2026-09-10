import assert from 'node:assert/strict';

// Synthetic native light-theme scrollbar only. Inspect one viewer pixel column
// OUTSIDE measurement, rather than guessing platform-dependent arrow/thumb sizes.
export class ScrollbarProbe {
  static column = ({ x, top, height }) => {
    const session = window.browserpaneSession, canvas = document.querySelector('#screen canvas');
    if (!session?.connected || canvas?.width !== 1280 || canvas.height !== 720 ||
      ![x, top, height].every(Number.isInteger) || x < 0 || x >= 1280 || top < 0 || height <= 0 || top + height > 720) {
      throw new Error('Invalid scrollbar observation');
    }
    if (session.getRenderDiagnostics().backend !== 'webgl2') {
      return [...canvas.getContext('2d').getImageData(x, top, 1, height).data];
    }
    const gl = canvas.getContext('webgl2'), raw = new Uint8Array(height * 4), pixels = new Uint8Array(raw.length);
    gl.readPixels(x, 720 - top - height, 1, height, gl.RGBA, gl.UNSIGNED_BYTE, raw);
    for (let y = 0; y < height; y++) pixels.set(raw.subarray((height - 1 - y) * 4, (height - y) * 4), y * 4);
    return [...pixels];
  };

  static locate(pixels, height) {
    assert(Number.isInteger(height) && height > 0 && height <= 720 && pixels.length === height * 4);
    const runs = [];
    let start = -1;
    for (let y = 0; y <= height; y++) {
      const [r, g, b, a] = pixels.slice(y * 4, y * 4 + 4);
      const thumb = y < height && a === 255 && r >= 30 && r <= 220 && Math.abs(r - g) < 3 && Math.abs(r - b) < 3;
      if (thumb && start < 0) start = y;
      if (!thumb && start >= 0) {
        if (y - start >= 12 && y - start <= height / 4) runs.push({ top: start, height: y - start });
        start = -1;
      }
    }
    assert.equal(runs.length, 1, 'Ambiguous/missing native scrollbar thumb');
    return { ...runs[0], center: runs[0].top + runs[0].height / 2 };
  }
}
