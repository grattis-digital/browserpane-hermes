import type { Rect } from './damage-grid.js';
import { SCRATCH_SIZE, UpscaleGpuResources } from './gpu-resources.js';
import type { UpscaleMode } from './upscale-models.js';

export interface PatchUpscaler {
  render(source: HTMLCanvasElement, rect: Rect): Promise<ImageBitmap>;
  destroy(): void;
}

/** GPU arithmetic only. CPU schedules a bounded crop; it never reads pixels. */
export class GpuUpscaler implements PatchUpscaler {
  private destroyed = false;
  private busy = false;

  private constructor(private readonly device: GPUDevice, private readonly resources: UpscaleGpuResources) {}

  public static async create(onFailure: (message: string) => void, signal?: AbortSignal,
    mode: UpscaleMode = 'balanced'): Promise<GpuUpscaler> {
    signal?.throwIfAborted();
    if (!globalThis.isSecureContext || !navigator.gpu) throw new Error('Smart upscale needs HTTPS and WebGPU');
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'low-power' });
    signal?.throwIfAborted();
    if (!adapter || adapter.info.isFallbackAdapter
      || /swiftshader|llvmpipe|software/i.test(`${adapter.info.vendor} ${adapter.info.description}`)) {
      throw new Error('Hardware WebGPU unavailable; using original pixels');
    }
    const device = await adapter.requestDevice();
    const cancel = (): void => { device.destroy(); };
    signal?.addEventListener('abort', cancel, { once: true });
    let resources: UpscaleGpuResources | undefined;
    try {
      signal?.throwIfAborted();
      device.pushErrorScope('validation');
      device.pushErrorScope('out-of-memory');
      resources = new UpscaleGpuResources(device, navigator.gpu.getPreferredCanvasFormat(), mode);
      await resources.initialize();
      const memoryError = await device.popErrorScope();
      const validationError = await device.popErrorScope();
      if (memoryError || validationError) throw new Error('WebGPU initialization failed');
      const renderer = new GpuUpscaler(device, resources);
      void device.lost.then(() => { if (!renderer.destroyed) onFailure('Client GPU was lost; using original pixels'); });
      device.addEventListener('uncapturederror', () => {
        if (!renderer.destroyed) onFailure('Client GPU error; using original pixels');
      });
      return renderer;
    } catch (error) {
      resources?.destroy(); device.destroy(); throw error;
    } finally { signal?.removeEventListener('abort', cancel); }
  }

  public async render(source: HTMLCanvasElement, rect: Rect): Promise<ImageBitmap> {
    if (this.destroyed || this.busy) throw new Error('Upscaler is not available');
    if (![rect.x, rect.y, rect.w, rect.h].every(Number.isInteger)
      || rect.w <= 0 || rect.h <= 0 || rect.w > SCRATCH_SIZE || rect.h > SCRATCH_SIZE
      || rect.x < 0 || rect.y < 0 || rect.x + rect.w > source.width || rect.y + rect.h > source.height) {
      throw new RangeError('Invalid upscale crop');
    }
    this.busy = true;
    try {
      const { queue } = this.device;
      queue.writeBuffer(this.resources.shape, 0, new Uint32Array([rect.w, rect.h, 0, 0]));
      queue.copyExternalImageToTexture({ source, origin: [rect.x, rect.y] },
        { texture: this.resources.texture, premultipliedAlpha: false }, [rect.w, rect.h]);
      const encoder = this.device.createCommandEncoder();
      this.resources.encode(encoder, rect.w, rect.h);
      queue.submit([encoder.finish()]);
      // Asynchronous fence: never block original presentation or input on it.
      await queue.onSubmittedWorkDone();
      if (this.destroyed) throw new Error('Upscaler stopped');
      return this.resources.canvas.transferToImageBitmap();
    } finally { this.busy = false; }
  }

  public destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.resources.destroy(); this.device.destroy();
  }
}
