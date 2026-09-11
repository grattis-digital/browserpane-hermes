import { DamageGrid, type DamageKind, type Rect } from './damage-grid.js';
import type { PatchUpscaler } from './gpu-upscaler.js';

export type EnhancementStats = Readonly<{
  completed: number; stale: number; copiedPixels: number; pending: number; lastPatchMs: number;
}>;

/** An optional presentation cache, never a source for transport/scroll-copy. */
export class EnhancementRun {
  private stopped = false;
  private busy = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private frame: number | undefined;
  private watchdog: ReturnType<typeof setTimeout> | undefined;
  private completed = 0;
  private stale = 0;
  private copiedPixels = 0;
  private lastPatchMs = 0;
  private slowPatches = 0;
  private samples = 0;

  public constructor(private readonly source: HTMLCanvasElement, private readonly overlay: HTMLCanvasElement,
    private readonly context: CanvasRenderingContext2D, private readonly grid: DamageGrid,
    private readonly renderer: PatchUpscaler, private readonly onFailure: (message: string) => void,
    private readonly width: number, private readonly height: number) {}

  public start(): void {
    if (this.stopped) return;
    this.overlay.className = 'smart-upscale-overlay';
    this.overlay.setAttribute('aria-hidden', 'true');
    this.overlay.width = this.width * 2; this.overlay.height = this.height * 2;
    this.context.imageSmoothingEnabled = false;
    this.source.parentElement!.appendChild(this.overlay);
    this.source.dataset.bpaneEnhancement = 'on';
    this.source.addEventListener('bpane:presentation-damage', this.onDamage);
    this.source.addEventListener('webglcontextlost', this.onContextLost);
    this.layout();
    this.invalidate({ x: 0, y: 0, w: this.width, h: this.height }, 'reset');
  }

  public matches(source: HTMLCanvasElement): boolean {
    return source === this.source && source.width === this.width && source.height === this.height;
  }

  public layout(): void {
    const rect = this.source.getBoundingClientRect();
    this.overlay.style.width = `${rect.width}px`; this.overlay.style.height = `${rect.height}px`;
    this.overlay.style.left = `${this.source.offsetLeft}px`; this.overlay.style.top = `${this.source.offsetTop}px`;
  }

  public diagnostics(): EnhancementStats {
    return { completed: this.completed, stale: this.stale, copiedPixels: this.copiedPixels,
      pending: this.grid.pending(), lastPatchMs: this.lastPatchMs };
  }

  public destroy(): void {
    if (this.stopped) return;
    this.stopped = true;
    delete this.source.dataset.bpaneEnhancement;
    this.source.removeEventListener('bpane:presentation-damage', this.onDamage);
    this.source.removeEventListener('webglcontextlost', this.onContextLost);
    clearTimeout(this.timer); clearTimeout(this.watchdog);
    if (this.frame !== undefined) cancelAnimationFrame(this.frame);
    this.overlay.remove(); this.overlay.width = this.overlay.height = 1;
    this.renderer.destroy();
  }

  private readonly onContextLost = (): void => { this.fail('Source GPU was lost; using original pixels'); };

  private readonly onDamage = (event: Event): void => {
    if (!(event instanceof CustomEvent) || !event.detail || typeof event.detail !== 'object') return;
    const { x, y, w, h, kind } = event.detail as Record<string, unknown>;
    if (![x, y, w, h].every(value => typeof value === 'number' && Number.isFinite(value))
      || !['tile', 'video', 'scroll', 'reset'].includes(String(kind))) return;
    // Synchronous clearing is critical: stale enhancement must never cover new raw pixels.
    this.invalidate({ x: x as number, y: y as number, w: w as number, h: h as number }, kind as DamageKind);
  };

  private invalidate(rect: Rect, kind: DamageKind): void {
    const cleared = this.grid.invalidate(rect, kind, performance.now());
    if (cleared) this.context.clearRect(cleared.x * 2, cleared.y * 2, cleared.w * 2, cleared.h * 2);
    this.schedule();
  }

  private schedule(): void {
    if (this.stopped || this.busy || this.frame !== undefined || this.timer !== undefined) return;
    const delay = this.grid.delay(performance.now());
    if (!Number.isFinite(delay)) return; // No idle full-frame loop.
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.frame = requestAnimationFrame(() => {
        this.frame = undefined;
        void this.process().catch(() => { this.fail('Upscale processing failed; using original pixels'); });
      });
    }, delay);
  }

  private async process(): Promise<void> {
    if (this.stopped || this.busy || !this.matches(this.source)) return;
    this.busy = true;
    const batchStart = performance.now();
    try {
      // At most four asynchronous patches / 8 ms per turn; always one in flight.
      for (let count = 0; count < 4 && !this.stopped; count++) {
        const job = this.grid.next(performance.now());
        if (!job) break;
        const started = performance.now();
        this.watchdog = setTimeout(() => { this.fail('Client GPU timed out; using original pixels'); }, 1500);
        this.copiedPixels += job.input.w * job.input.h;
        const bitmap = await this.renderer.render(this.source, job.input);
        clearTimeout(this.watchdog);
        try {
          if (this.stopped) break;
          this.lastPatchMs = performance.now() - started;
          if (++this.samples > 2) this.slowPatches = this.lastPatchMs > 20 ? this.slowPatches + 1 : 0;
          if (this.slowPatches >= 4) { this.fail('Client GPU budget exceeded; using original pixels'); break; }
          if (!this.matches(this.source) || !this.grid.isCurrent(job)) { this.stale++; continue; }
          const { input, output } = job;
          this.context.drawImage(bitmap, (output.x - input.x) * 2, (output.y - input.y) * 2,
            output.w * 2, output.h * 2, output.x * 2, output.y * 2, output.w * 2, output.h * 2);
          this.completed++;
        } finally { bitmap.close(); }
        if (performance.now() - batchStart >= 8) break;
      }
    } finally { clearTimeout(this.watchdog); this.busy = false; this.schedule(); }
  }

  private fail(message: string): void {
    if (this.stopped) return;
    this.destroy(); this.onFailure(message);
  }
}
