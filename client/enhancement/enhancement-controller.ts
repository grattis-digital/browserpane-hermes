import { DamageGrid, MAX_PIXELS } from './damage-grid.js';
import { EnhancementRun, type EnhancementStats } from './enhancement-run.js';
import { GpuUpscaler, type PatchUpscaler } from './gpu-upscaler.js';
import { UpscaleModels, type UpscaleMode } from './upscale-models.js';

const STORAGE_KEY = 'browserpane.enhancement.v1';
type UpscalerFactory = (onFailure: (message: string) => void, signal: AbortSignal, mode: UpscaleMode) => Promise<PatchUpscaler>;

/** Viewer-local preference/capabilities. No session setters or server requests. */
export class EnhancementController {
  private source: HTMLCanvasElement | null = null;
  private run: EnhancementRun | undefined;
  private pending: AbortController | undefined;
  private loadingSize = '';
  private generation = 0;
  private failure = '';
  private destroyed = false;
  private frame: number | undefined;
  private monitor: MediaQueryList | undefined;
  private observer: ResizeObserver | undefined;
  private mutations: MutationObserver | undefined;
  private lastStats: EnhancementStats | undefined;

  public constructor(private readonly select: HTMLSelectElement, private readonly status: HTMLElement,
    private readonly createUpscaler: UpscalerFactory) {}

  public static mount(): EnhancementController {
    const controller = new EnhancementController(document.querySelector<HTMLSelectElement>('#enhancement')!,
      document.querySelector<HTMLElement>('#enhancement-status')!, GpuUpscaler.create);
    controller.start();
    return controller;
  }

  public start(): void {
    try { this.select.value = UpscaleModels.preference(localStorage.getItem(STORAGE_KEY)); }
    catch { this.select.value = 'original'; /* Local preference is optional. */ }
    this.select.addEventListener('change', this.change);
    document.addEventListener('visibilitychange', this.visibility);
    window.addEventListener('resize', this.refresh);
    this.observer = new ResizeObserver(this.refresh);
    this.mutations = new MutationObserver(this.refresh);
    this.watchMonitor(); this.refresh();
  }

  public attach(source: HTMLCanvasElement | null): void {
    if (this.destroyed || source === this.source) return;
    this.stop(); this.failure = ''; this.source = source;
    this.observer?.disconnect(); this.mutations?.disconnect();
    if (source) {
      this.observer?.observe(source);
      this.mutations?.observe(source, { attributes: true, attributeFilter: ['width', 'height', 'style'] });
    }
    this.refresh();
  }

  public diagnostics(): Readonly<{ mode: UpscaleMode | 'original'; status: string; stats: EnhancementStats | undefined }> {
    const preference = UpscaleModels.preference(this.select.value);
    return { mode: preference === 'original' ? 'original' : UpscaleModels.mode(preference),
      status: this.status.textContent ?? '', stats: this.run?.diagnostics() ?? this.lastStats };
  }

  public readonly refresh = (): void => {
    if (this.destroyed || this.frame !== undefined) return;
    this.frame = requestAnimationFrame(() => { this.frame = undefined; this.update(); });
  };

  public destroy(): void {
    this.destroyed = true; this.stop();
    if (this.frame !== undefined) cancelAnimationFrame(this.frame);
    this.observer?.disconnect(); this.mutations?.disconnect();
    this.monitor?.removeEventListener('change', this.monitorChanged);
    this.select.removeEventListener('change', this.change);
    document.removeEventListener('visibilitychange', this.visibility);
    window.removeEventListener('resize', this.refresh);
  }

  private readonly change = (): void => {
    this.select.value = UpscaleModels.preference(this.select.value);
    this.failure = ''; this.stop(); this.lastStats = undefined;
    try { localStorage.setItem(STORAGE_KEY, this.select.value); }
    catch { /* Enhancement still works when preference storage is disabled. */ }
    this.refresh();
  };

  private readonly visibility = (): void => {
    if (document.hidden) this.stop();
    this.refresh();
  };

  private readonly monitorChanged = (): void => { this.watchMonitor(); this.refresh(); };

  private watchMonitor(): void {
    this.monitor?.removeEventListener('change', this.monitorChanged);
    this.monitor = window.matchMedia?.(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
    this.monitor?.addEventListener('change', this.monitorChanged);
  }

  private update(): void {
    const reason = this.ineligible();
    if (reason) { this.stop(); this.status.textContent = reason; return; }
    const source = this.source!;
    if (this.run?.matches(source)) { this.run.layout(); return; }
    const size = `${source.width}x${source.height}`;
    if (this.pending && this.loadingSize === size) return;
    this.stop();
    this.loadingSize = size;
    const generation = this.generation;
    const abort = new AbortController(); this.pending = abort;
    this.status.textContent = 'Loading local GPU model…';
    void this.initialize(source, abort, generation, UpscaleModels.mode(UpscaleModels.preference(this.select.value)));
  }

  private ineligible(): string {
    if (UpscaleModels.preference(this.select.value) === 'original') return 'Original pixels';
    if (this.failure) return this.failure;
    if (document.hidden) return 'Smart upscale paused · viewer hidden';
    if (!this.source?.isConnected) return 'Smart upscale waiting for browser';
    if (!globalThis.isSecureContext || !navigator.gpu) return 'Original · Smart upscale needs HTTPS and WebGPU';
    if (this.source.dataset.bpaneRenderer !== 'webgl2') return 'Original · Smart upscale needs the WebGL viewer';
    const { width, height } = this.source;
    if (!width || !height || width * height > MAX_PIXELS || width > 4096 || height > 4096) return 'Original · upscale limit is Full HD';
    const rect = this.source.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return 'Smart upscale waiting for display space';
    if (rect.width * window.devicePixelRatio <= width * 1.05
      && rect.height * window.devicePixelRatio <= height * 1.05) return 'Original · already at native pixel density';
    return '';
  }

  private async initialize(source: HTMLCanvasElement, abort: AbortController, generation: number,
    mode: UpscaleMode): Promise<void> {
    let renderer: PatchUpscaler | undefined;
    const fail = (message: string): void => {
      if (generation !== this.generation) return;
      this.failure = message; this.stop(); this.status.textContent = message;
    };
    const deadline = setTimeout(() => fail('GPU initialization timed out; using original pixels'), 10000);
    try {
      renderer = await this.createUpscaler(fail, abort.signal, mode);
      if (abort.signal.aborted || generation !== this.generation) { renderer.destroy(); return; }
      const overlay = document.createElement('canvas');
      const context = overlay.getContext('2d', { alpha: true });
      if (!context) throw new Error('Upscale presentation unavailable');
      this.run = new EnhancementRun(source, overlay, context, new DamageGrid(source.width, source.height),
        renderer, fail, source.width, source.height);
      this.run.start(); this.pending = undefined;
      this.status.textContent = `Smart 2× ${UpscaleModels.label(mode)} · local GPU · stable tiles`;
    } catch (error) {
      renderer?.destroy();
      fail(error instanceof Error ? error.message : 'Smart upscale unavailable; using original pixels');
    } finally { clearTimeout(deadline); }
  }

  private stop(): void {
    ++this.generation;
    this.pending?.abort(); this.pending = undefined;
    if (this.run) this.lastStats = this.run.diagnostics();
    this.run?.destroy(); this.run = undefined;
  }
}
