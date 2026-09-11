export type Rect = Readonly<{ x: number; y: number; w: number; h: number }>;
export type DamageKind = 'tile' | 'video' | 'scroll' | 'reset';
export type PatchJob = Readonly<{ index: number; revision: number; output: Rect; input: Rect }>;
export const PATCH_SIZE = 128;
export const HALO = 8; // Quality needs radius 7; also covers presentation's source-sample neighborhood.
export const MAX_PIXELS = 1920 * 1080;

/** One coalesced slot per display patch, never an unbounded frame FIFO. */
export class DamageGrid {
  private readonly columns: number;
  private readonly revisions: Float64Array;
  private readonly readyAt: Float64Array;
  private readonly dirty: Uint8Array;
  private cursor = 0;

  public constructor(private readonly width: number, private readonly height: number) {
    if (![width, height].every(value => Number.isInteger(value) && value > 0 && value <= 4096)
      || width * height > MAX_PIXELS) throw new RangeError('Smart upscale supports captures up to Full HD');
    this.columns = Math.ceil(width / PATCH_SIZE);
    const count = this.columns * Math.ceil(height / PATCH_SIZE);
    this.revisions = new Float64Array(count);
    this.readyAt = new Float64Array(count);
    this.dirty = new Uint8Array(count);
  }

  public invalidate(rect: Rect, kind: DamageKind, now: number): Rect | undefined {
    if (![rect.x, rect.y, rect.w, rect.h, now].every(Number.isFinite) || rect.w <= 0 || rect.h <= 0) return;
    // A neighbour's pixels also feed the convolution. Invalidate its halo consumers.
    const x0 = Math.max(0, Math.floor((rect.x - HALO) / PATCH_SIZE));
    const y0 = Math.max(0, Math.floor((rect.y - HALO) / PATCH_SIZE));
    const x1 = Math.min(this.columns, Math.ceil((rect.x + rect.w + HALO) / PATCH_SIZE));
    const y1 = Math.min(Math.ceil(this.height / PATCH_SIZE), Math.ceil((rect.y + rect.h + HALO) / PATCH_SIZE));
    if (x1 <= x0 || y1 <= y0) return;
    const delay = kind === 'video' ? 750 : kind === 'scroll' ? 120 : 60;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const index = y * this.columns + x;
      this.revisions[index] = this.revisions[index]! + 1;
      this.dirty[index] = 1;
      this.readyAt[index] = Math.max(this.readyAt[index]!, now + delay);
    }
    return { x: x0 * PATCH_SIZE, y: y0 * PATCH_SIZE,
      w: Math.min(this.width, x1 * PATCH_SIZE) - x0 * PATCH_SIZE,
      h: Math.min(this.height, y1 * PATCH_SIZE) - y0 * PATCH_SIZE };
  }

  public next(now: number): PatchJob | undefined {
    for (let offset = 0; offset < this.dirty.length; offset++) {
      const index = (this.cursor + offset) % this.dirty.length;
      if (!this.dirty[index] || this.readyAt[index]! > now) continue;
      this.dirty[index] = 0;
      this.cursor = (index + 1) % this.dirty.length;
      const x = (index % this.columns) * PATCH_SIZE;
      const y = Math.floor(index / this.columns) * PATCH_SIZE;
      const output = { x, y, w: Math.min(PATCH_SIZE, this.width - x), h: Math.min(PATCH_SIZE, this.height - y) };
      const ix = Math.max(0, x - HALO), iy = Math.max(0, y - HALO);
      return { index, revision: this.revisions[index]!, output,
        input: { x: ix, y: iy, w: Math.min(this.width, x + output.w + HALO) - ix,
          h: Math.min(this.height, y + output.h + HALO) - iy } };
    }
    return;
  }

  public isCurrent(job: PatchJob): boolean { return this.revisions[job.index] === job.revision; }

  public pending(): number { return this.dirty.reduce((sum, value) => sum + value, 0); }

  public delay(now: number): number {
    let earliest = Infinity;
    for (let index = 0; index < this.dirty.length; index++) {
      if (this.dirty[index]) earliest = Math.min(earliest, this.readyAt[index]!);
    }
    return Math.max(0, earliest - now);
  }
}
