// SPDX-License-Identifier: AGPL-3.0-only
// Receiver-only interoperability gate using the actual viewer parsers. No browser.
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { decodeQoi } from '../upstream/code/web/bpane-client/js/qoi.ts';
import { TileMessageParser } from '../upstream/code/web/bpane-client/js/render/tile-message-parser.ts';
import { resolveScrollCopyRect } from '../upstream/code/web/bpane-client/js/render/scroll-copy-rect.ts';

class Fixture {
  static base(x, y) {
    return y < 48 ? 0x223344 : x % 83 < 11 ? 0x84a2c6 : y % 37 < 17 ? 0x315779 : 0x123456;
  }

  static color(x, y, w, h, scenario) {
    let value = Fixture.base(x, y);
    if (scenario === 1 && x >= 4 && x < 28 && y >= 8 && y < 32) value = 0xabcdef;
    if (scenario === 2) value = 0xfedcba;
    if (scenario === 8) value = 0xfedcba ^ Number(x === w - 1 && y === h - 1);
    if (scenario === 3 && x === w - 1 && y === h - 1) value ^= 1;
    if (scenario === 4 && y >= 48) {
      value = y + 13 < h ? Fixture.base(x, y + 13) : 0x365478;
      if (x >= 100 && x < 132 && y >= 100 && y < 132) value = 0xaccdef;
    }
    if (x >= 128 && x < 192 && y >= 128 && y < 192) {
      if (scenario === 5) value = Fixture.base(x - 64, y);
      if (scenario === 6) {
        let v = x + y * w; v = Math.imul(v ^ (v >>> 16), 0x7feb352d);
        v = Math.imul(v ^ (v >>> 15), 0x846ca68b); value = (v ^ (v >>> 16)) & 0xffffff;
      }
      if (scenario === 7) value = ((x - 128) << 16) | ((y - 128) << 8) | (x + y - 256);
    }
    return (0xff000000 | ((value & 255) << 16) | (value & 0xff00) | (value >>> 16)) >>> 0;
  }
}

class WireOracle {
  #width = 0; #height = 0; #serial = 0; #canvas; #cache = new Map(); #qoi = 0; #frames = 0;

  check(file) {
    assert(file.length > 0 && file.length <= 32 * 1024 * 1024);
    for (let at = 0; at < file.length;) {
      assert(at + 16 <= file.length);
      const n = file.readUInt32LE(at), scenario = file.readUInt32LE(at + 4), serial = file.readUInt32LE(at + 8);
      assert(this.#frames < 57 && scenario <= 8 && serial > this.#serial && serial <= 63);
      assert.equal(file.readUInt32LE(at + 12), 0);
      at += 16; assert(n >= 10 && at + n <= file.length);
      this.#frame(file.subarray(at, at + n), serial); at += n;
      for (let y = 0; y < this.#height; y++) for (let x = 0; x < this.#width; x++) {
        const expected = Fixture.color(x, y, this.#width, this.#height, scenario);
        if (this.#canvas[y * this.#width + x] !== expected) assert.fail(`Pixel mismatch: frame ${serial}, ${x},${y}`);
      }
      this.#frames++;
    }
    assert.equal(this.#frames, 57); assert(this.#qoi > 1000);
    return { frames: this.#frames, qoiTiles: this.#qoi, pixelErrors: 0, actualViewerDecoders: true };
  }

  #frame(bytes, serial) {
    let ended = false;
    for (let at = 0; at < bytes.length;) {
      assert(!ended && at + 5 <= bytes.length && bytes[at] === 11);
      const n = bytes.readUInt32LE(at + 1); at += 5;
      assert(n > 0 && at + n <= bytes.length);
      const command = TileMessageParser.parse(bytes.subarray(at, at + n)); assert(command); at += n;
      if (command.type === 'batch-end') {
        assert.equal(command.frameSeq, serial); ended = true;
      } else this.#apply(command);
    }
    assert(ended); this.#serial = serial;
  }

  #apply(command) {
    if (command.type === 'grid-config') {
      const { tileSize, cols, rows, screenW, screenH } = command.config;
      assert(tileSize === 64 && screenW >= 32 && screenW <= 1920 && screenH >= 32 && screenH <= 1080);
      assert(cols === Math.ceil(screenW / 64) && rows === Math.ceil(screenH / 64));
      this.#width = screenW; this.#height = screenH;
      this.#canvas = new Uint32Array(screenW * screenH); this.#cache.clear(); return;
    }
    assert(this.#canvas);
    if (command.type === 'scroll-copy') {
      assert(command.dx === 0 && command.regionTop === 0 && command.regionBottom === this.#height);
      assert(command.regionRight === this.#width && command.dy && Math.abs(command.dy) <= 64);
      const old = this.#canvas.slice();
      const rect = resolveScrollCopyRect({ dx: command.dx, dy: command.dy,
        regionTop: command.regionTop, regionBottom: command.regionBottom, regionRight: command.regionRight,
        canvasWidth: this.#width, canvasHeight: this.#height, screenW: this.#width, screenH: this.#height });
      assert(rect);
      for (let y = 0; y < rect.height; y++) {
        const source = (rect.sourceY + y) * this.#width + rect.sourceX;
        this.#canvas.set(old.subarray(source, source + rect.width),
          (rect.destinationY + y) * this.#width + rect.destinationX);
      }
      return;
    }
    this.#tile(command);
  }

  #tile(command) {
    const x = command.col * 64, y = command.row * 64;
    assert(x >= 0 && x < this.#width && y >= 0 && y < this.#height);
    const width = Math.min(64, this.#width - x), height = Math.min(64, this.#height - y);
    let tile;
    if (command.type === 'qoi') {
      assert(command.data.length >= 22);
      const header = new DataView(command.data.buffer, command.data.byteOffset, command.data.byteLength);
      assert(header.getUint32(4) === width && header.getUint32(8) === height);
      tile = decodeQoi(command.data); assert(tile && !this.#cache.has(command.hash));
      if (this.#cache.size === 1024) this.#cache.delete(this.#cache.keys().next().value);
      this.#cache.set(command.hash, tile); this.#qoi++;
    } else if (command.type === 'cache-hit') tile = this.#cache.get(command.hash);
    else assert.equal(command.type, 'fill');
    if (command.type !== 'fill') assert(tile && tile.width === width && tile.height === height);
    for (let yy = 0; yy < height; yy++) for (let xx = 0; xx < width; xx++) {
      const at = (yy * width + xx) * 4, p = tile?.pixels;
      this.#canvas[(y + yy) * this.#width + x + xx] = command.type === 'fill' ? command.rgba :
        (p[at] | (p[at + 1] << 8) | (p[at + 2] << 16) | (p[at + 3] << 24)) >>> 0;
    }
  }
}

assert.equal(process.argv.length, 3, 'Usage: node scripts/check-gpu-tail-wire.mjs /private/path/tail-wire.bin');
assert(statSync(process.argv[2]).isFile() && statSync(process.argv[2]).size <= 32 * 1024 * 1024);
console.log(JSON.stringify(new WireOracle().check(readFileSync(process.argv[2]))));
