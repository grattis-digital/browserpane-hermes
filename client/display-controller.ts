import type { BpaneSession, SessionDisplayState } from '../upstream/code/web/bpane-client/js/bpane.js';
import {
  computeDisplayLayout, readDisplayPreferences, writeDisplayPreferences,
  RESOLUTION_PRESETS, DENSITY_OPTIONS,
} from './display-settings.js';
import type { DisplayPreferences } from './display-settings.js';

const STORAGE_KEY = 'browserpane.display.v1';
type DisplaySession = Pick<BpaneSession, 'setCaptureSize' | 'setCaptureScale' | 'getDisplayState' | 'getRenderDiagnostics'>;

/** Owns viewer layout only. It never changes Chrome's DPI, tabs or profile. */
export class DisplayController {
  private readonly viewport = document.querySelector<HTMLElement>('#viewport')!;
  private readonly screen = document.querySelector<HTMLElement>('#screen')!;
  private readonly resolution = document.querySelector<HTMLSelectElement>('#resolution')!;
  private readonly density = document.querySelector<HTMLSelectElement>('#density')!;
  private readonly summary = document.querySelector<HTMLElement>('#display-summary')!;
  private readonly notice = document.querySelector<HTMLElement>('#display-notice')!;
  private preferences: DisplayPreferences;
  private session: DisplaySession | null = null;
  private state: SessionDisplayState | null = null;
  private appliedSize = '';
  private appliedScale: number | undefined;
  private frame: number | undefined;
  private noticeTimer: ReturnType<typeof setTimeout> | undefined;
  private densityQuery: MediaQueryList | undefined;
  private destroyed = false;
  private readonly observer: ResizeObserver;

  constructor() {
    let saved: string | null = null;
    try { saved = localStorage.getItem(STORAGE_KEY); } catch { /* Private/storage-disabled viewer. */ }
    this.preferences = readDisplayPreferences(saved);
    for (const entry of RESOLUTION_PRESETS) this.resolution.add(new Option(entry.label, entry.value));
    for (const entry of DENSITY_OPTIONS) this.density.add(new Option(entry.label, entry.value));
    this.resolution.value = this.preferences.resolution;
    this.density.value = this.preferences.density;
    this.resolution.addEventListener('change', this.changePreferences);
    this.density.addEventListener('change', this.changePreferences);
    this.observer = new ResizeObserver(this.schedule);
    this.observer.observe(this.viewport);
    window.addEventListener('resize', this.schedule);
    document.addEventListener('fullscreenchange', this.schedule);
    this.watchMonitor();
    this.update();
  }

  /** Fresh at connect time: settings may change while bootstrap is pending. */
  getConnectOptions(): { captureScale: number; captureSize: { width: number; height: number } } {
    const layout = this.layout();
    return { captureScale: layout.captureScale, captureSize: { width: layout.width, height: layout.height } };
  }

  hasDrawableSpace(): boolean {
    const layout = this.layout();
    return layout.cssWidth > 0 && layout.cssHeight > 0;
  }

  attach(session: DisplaySession | null): void {
    if (this.destroyed) return;
    this.session = session;
    this.state = session?.getDisplayState() ?? null;
    this.appliedSize = '';
    this.appliedScale = undefined;
    this.schedule();
  }

  onDisplayStateChange = (state: SessionDisplayState): void => {
    if (this.destroyed) return;
    this.state = state;
    this.schedule();
  };

  showNotice(message: string): void {
    if (this.destroyed) return;
    this.notice.textContent = message;
    clearTimeout(this.noticeTimer);
    this.noticeTimer = setTimeout(() => { this.notice.textContent = ''; }, 6000);
  }

  destroy(): void {
    this.destroyed = true;
    if (this.frame !== undefined) cancelAnimationFrame(this.frame);
    clearTimeout(this.noticeTimer);
    this.observer.disconnect();
    window.removeEventListener('resize', this.schedule);
    document.removeEventListener('fullscreenchange', this.schedule);
    this.densityQuery?.removeEventListener('change', this.monitorChanged);
    this.resolution.removeEventListener('change', this.changePreferences);
    this.density.removeEventListener('change', this.changePreferences);
  }

  private changePreferences = (): void => {
    // Capture ownership is shared, but display density is local. A synthetic
    // change to the disabled resolution control cannot replace saved intent.
    if (this.state?.resolutionLocked) {
      this.resolution.value = this.preferences.resolution;
    }
    this.preferences = readDisplayPreferences(JSON.stringify({
      version: 1, resolution: this.resolution.value, density: this.density.value,
    }));
    try { localStorage.setItem(STORAGE_KEY, writeDisplayPreferences(this.preferences)); }
    catch { this.showNotice('Display settings apply now, but this browser cannot save them.'); }
    this.schedule();
  };

  private schedule = (): void => {
    if (this.destroyed || this.frame !== undefined) return;
    this.frame = requestAnimationFrame(() => { this.frame = undefined; this.update(); });
  };

  private monitorChanged = (): void => {
    if (this.destroyed) return;
    this.watchMonitor();
    this.schedule();
  };

  private watchMonitor(): void {
    this.densityQuery?.removeEventListener('change', this.monitorChanged);
    if (typeof window.matchMedia !== 'function') return;
    this.densityQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
    this.densityQuery.addEventListener('change', this.monitorChanged);
  }

  private layout(useAuthority = true) {
    const rect = this.viewport.getBoundingClientRect();
    const locked = useAuthority && this.state?.resolutionLocked && this.state.width > 0 && this.state.height > 0;
    return computeDisplayLayout({
      preferences: this.preferences, availableWidth: rect.width, availableHeight: rect.height,
      devicePixelRatio: window.devicePixelRatio || 1,
      softwareRenderer: this.session?.getRenderDiagnostics().software,
      ...(locked ? { authoritativeSize: { width: this.state!.width, height: this.state!.height } } : {}),
    });
  }

  private update(): void {
    const layout = this.layout();
    this.screen.style.setProperty('--view-width', `${layout.cssWidth}px`);
    this.screen.style.setProperty('--view-height', `${layout.cssHeight}px`);
    const locked = this.state?.resolutionLocked ?? false;
    this.resolution.disabled = locked;
    const ownership = locked ? 'Another viewer controls the shared capture resolution.' : '';
    this.resolution.title = ownership || 'Capture resolution in pixels. Larger captures require more Pi CPU.';
    this.density.title = 'Local display density, not Chrome zoom. Higher values make the same desktop smaller; other viewers are unaffected.';

    if (this.session && layout.cssWidth > 0 && layout.cssHeight > 0) {
      // While locked, keep only future owner preferences current. The SDK
      // stores these without sending a resize or touching the authoritative
      // bitmap. This prevents an obsolete Auto size being sent on promotion.
      const preferred = locked ? this.layout(false) : layout;
      const sizeKey = `${preferred.width}x${preferred.height}`;
      // Update our guard before invoking callbacks; SDK setters may notify
      // synchronously. Both setters share its debounced physical resize path.
      if (this.appliedScale !== preferred.captureScale) {
        this.appliedScale = preferred.captureScale;
        this.session.setCaptureScale(preferred.captureScale);
      }
      if (this.appliedSize !== sizeKey) {
        this.appliedSize = sizeKey;
        this.session.setCaptureSize({ width: preferred.width, height: preferred.height });
      }
    }

    const density = `${Number(layout.captureScale.toFixed(2))}×`;
    const actual = this.state && this.state.width > 0 && this.state.height > 0 ? this.state : layout;
    const pending = this.session && !locked && (actual.width !== layout.width || actual.height !== layout.height);
    const dimensions = pending ? `${actual.width} × ${actual.height} → ${layout.width} × ${layout.height}` : `${actual.width} × ${actual.height}`;
    const fitted = layout.effectiveScale > layout.captureScale + 0.01 ? ' · fit to window' : '';
    const mode = this.preferences.resolution === 'auto' && !locked ? ' · Auto / Pi balanced' : '';
    const shared = locked ? ' · shared resolution locked' : '';
    this.summary.textContent = `${dimensions} px · ${density}${fitted}${mode}${shared}`;
    this.summary.title = `${layout.reason} Monitor density: ${Number((window.devicePixelRatio || 1).toFixed(2))}×. ${ownership}`;
  }
}
