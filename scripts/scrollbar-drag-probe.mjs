import assert from 'node:assert/strict';

// Real native scrollbar control in a disposable page, not JS scrollTo as input.
export class ScrollbarDragProbe {
  #mouse; #geometry; #barrier; #checkpoint; #inspect; #sleep;

  constructor({ mouse, geometry, barrier, checkpoint, inspect, sleep }) {
    this.#mouse = mouse; this.#geometry = geometry; this.#barrier = barrier;
    this.#checkpoint = checkpoint; this.#inspect = inspect; this.#sleep = sleep;
  }

  static thumb(geometry) {
    const { box, width, height, innerWidth, innerHeight, clientWidth, clientHeight, scrollHeight, scrollY } = geometry;
    assert([box.x, box.y, box.width, box.height, width, height, innerWidth, innerHeight,
      clientWidth, clientHeight, scrollHeight, scrollY].every(Number.isFinite));
    assert(width === innerWidth && height >= innerHeight && clientWidth < innerWidth);
    assert(box.width > 0 && box.height > 0 && box.y > 12 && scrollHeight > clientHeight && clientHeight > 0,
      'Unsupported native scrollbar geometry: ' + JSON.stringify(geometry));
    assert(scrollY >= 0 && scrollY <= scrollHeight - clientHeight);
    // The fixture styles native scrollbars without arrow buttons; no fake thumb.
    const thumbHeight = clientHeight * clientHeight / scrollHeight;
    assert(thumbHeight >= 20, 'Fixture must not depend on platform minimum thumb sizing');
    const localY = y => box.y + (height - innerHeight + y) / height * box.height;
    return { x: box.x + (clientWidth + innerWidth) / 2 / width * box.width,
      y: localY(thumbHeight / 2 + scrollY / (scrollHeight - clientHeight) * (clientHeight - thumbHeight)),
      top: localY(0), travel: (clientHeight - thumbHeight) / height * box.height,
      halfThumb: thumbHeight / 2 / height * box.height,
      outside: { x: box.x + box.width / 2, y: box.y - 8 },
      content: { x: box.x + box.width / 3, y: box.y + box.height * .7 } };
  }

  async run() {
    const geometry = await this.#geometry();
    const thumb = ScrollbarDragProbe.thumb(geometry);
    const before = await this.#inspect();
    const result = { path: 'native-scrollbar-pointer-drag', checkpoints: [] };
    let pressed = false;
    try {
      await this.#mouse.move(thumb.x, thumb.y); await this.#mouse.down(); pressed = true;
      for (const [name, fractions] of [['scrollbar-held-jump', [.73]],
        ['scrollbar-held-reversal', [.21, .82, .37]]]) {
        for (const fraction of fractions) {
          await this.#mouse.move(thumb.x, thumb.top + thumb.halfThumb + thumb.travel * fraction);
          await this.#sleep(13);
        }
        await this.#barrier();
        const checkpoint = await this.#checkpoint(name);
        result.checkpoints.push({ name, pixels: checkpoint.pixels, y: checkpoint.document.y });
        assert.equal(checkpoint.pixels, 0, name + ': wrong pixels while button held');
      }
      assert(Math.abs(result.checkpoints[0].y - before.y) > 500, 'Scrollbar thumb was not dragged');
      assert(result.checkpoints[1].y < result.checkpoints[0].y, 'Held drag did not reverse');
      // Release on the viewer toolbar, outside its canvas but inside the window.
      await this.#mouse.move(thumb.outside.x, thumb.outside.y); await this.#mouse.up(); pressed = false;
      await this.#barrier();
      await this.#checkpoint('scrollbar-outside-release');
      const release = await this.#inspect();
      await this.#mouse.move(thumb.content.x, thumb.content.y);
      await this.#sleep(40); await this.#mouse.move(thumb.content.x + 25, thumb.content.y + 20);
      await this.#barrier();
      await this.#checkpoint('scrollbar-after-release-move');
      const after = await this.#inspect();
      assert(after.moves > release.moves && after.buttons === 0, 'Remote pointer remains held after outside release');
      assert.equal(after.y, release.y, 'Moving after release continued dragging the scrollbar');
      assert.equal(after.wheels, before.wheels, 'Scrollbar coverage must not use wheel input');
      return { ...result, releaseVerified: true, before, after };
    } finally {
      if (pressed) await this.#mouse.up();
    }
  }
}
