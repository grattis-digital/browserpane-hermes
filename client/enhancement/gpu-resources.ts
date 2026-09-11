import { HALO, PATCH_SIZE } from './damage-grid.js';
import { UpscaleShaders } from './shaders.js';
import { UpscaleModels, type UpscaleMode, type ModelLayer } from './upscale-models.js';

export type ComputeStage = Readonly<{ pipeline: GPUComputePipeline; bindings: GPUBindGroup }>;
export const SCRATCH_SIZE = PATCH_SIZE + HALO * 2;

/** Fixed-size scratch: no allocation scales with capture dimensions. */
export class UpscaleGpuResources {
  public readonly canvas = new OffscreenCanvas(SCRATCH_SIZE * 2, SCRATCH_SIZE * 2);
  public readonly context: GPUCanvasContext;
  public readonly texture: GPUTexture;
  public readonly shape: GPUBuffer;
  private readonly stages: ComputeStage[] = [];
  private readonly buffers: GPUBuffer[] = [];
  private display: Readonly<{ pipeline: GPURenderPipeline; bindings: GPUBindGroup }> | undefined;

  public constructor(private readonly device: GPUDevice, private readonly format: GPUTextureFormat,
    private readonly mode: UpscaleMode = 'balanced') {
    const context = this.canvas.getContext('webgpu');
    if (!context) throw new Error('WebGPU presentation unavailable');
    this.context = context;
    context.configure({ device, format, alphaMode: 'opaque' });
    this.texture = device.createTexture({ size: [SCRATCH_SIZE, SCRATCH_SIZE], format: 'rgba8unorm',
      usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT });
    this.shape = this.buffer(16, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
  }

  public async initialize(): Promise<void> {
    const model = UpscaleModels.get(this.mode);
    // Balanced ping-pongs two buffers; Quality retains all seven skip features.
    const features = Array.from({ length: this.mode === 'quality' ? 7 : 2 },
      () => this.buffer(SCRATCH_SIZE ** 2 * 16, GPUBufferUsage.STORAGE));
    const pipelines = [await this.compute(UpscaleShaders.convolution(true)),
      await this.compute(UpscaleShaders.convolution(false))];
    for (const [index, layer] of model.convolutions.entries()) {
      const values = new Float32Array([...layer.weights, ...layer.bias]);
      const weights = this.buffer(values.byteLength, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
      this.device.queue.writeBuffer(weights, 0, values);
      const pipeline = pipelines[index ? 1 : 0]!;
      const source = index ? { buffer: features[(index - 1) % features.length]! } : this.texture.createView();
      const bindings = this.device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
        { binding: 0, resource: { buffer: this.shape } }, { binding: 1, resource: { buffer: weights } },
        { binding: 2, resource: source }, { binding: 3, resource: { buffer: features[index % features.length]! } },
      ] });
      this.stages.push({ pipeline, bindings });
    }
    const output = this.mode === 'quality' ? await this.qualityHeads(features, model.heads) : features[1]!;
    await this.initializeDisplay(output);
  }

  private async qualityHeads(features: readonly GPUBuffer[], heads: readonly ModelLayer[]): Promise<GPUBuffer> {
    const output = this.buffer(SCRATCH_SIZE ** 2 * 48, GPUBufferUsage.STORAGE);
    const values = new Float32Array(heads.flatMap(head => [...head.weights, ...head.bias]));
    const weights = this.buffer(values.byteLength, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    this.device.queue.writeBuffer(weights, 0, values);
    const pipeline = await this.compute(UpscaleShaders.qualityHeads());
    const bindings = this.device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
      { binding: 0, resource: { buffer: this.shape } }, { binding: 1, resource: { buffer: weights } },
      ...features.map((buffer, index) => ({ binding: index + 2, resource: { buffer } })),
      { binding: 9, resource: { buffer: output } },
    ] });
    this.stages.push({ pipeline, bindings });
    return output;
  }

  private async initializeDisplay(output: GPUBuffer): Promise<void> {
    const module = await this.shader(UpscaleShaders.presentation(this.mode));
    const pipeline = await this.device.createRenderPipelineAsync({ layout: 'auto',
      vertex: { module, entryPoint: 'vertex' }, fragment: { module, entryPoint: 'fragment', targets: [{ format: this.format }] } });
    const bindings = this.device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
      { binding: 0, resource: { buffer: this.shape } }, { binding: 1, resource: { buffer: output } },
      { binding: 2, resource: this.texture.createView() },
      { binding: 3, resource: this.device.createSampler({ minFilter: 'linear', magFilter: 'linear' }) },
    ] });
    this.display = { pipeline, bindings };
  }

  public encode(encoder: GPUCommandEncoder, width: number, height: number): void {
    for (const stage of this.stages) {
      const pass = encoder.beginComputePass();
      pass.setPipeline(stage.pipeline); pass.setBindGroup(0, stage.bindings);
      pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8)); pass.end();
    }
    this.present(encoder, width, height);
  }

  private present(encoder: GPUCommandEncoder, width: number, height: number): void {
    if (!this.display) throw new Error('Upscale pipelines not ready');
    const pass = encoder.beginRenderPass({ colorAttachments: [{ view: this.context.getCurrentTexture().createView(),
      clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: 'clear', storeOp: 'store' }] });
    pass.setViewport(0, 0, width * 2, height * 2, 0, 1);
    pass.setPipeline(this.display.pipeline);
    pass.setBindGroup(0, this.display.bindings);
    pass.draw(3);
    pass.end();
  }

  public destroy(): void {
    this.context.unconfigure();
    this.texture.destroy();
    for (const buffer of this.buffers) buffer.destroy();
    this.stages.length = 0;
    this.canvas.width = this.canvas.height = 1;
  }

  private buffer(size: number, usage: GPUBufferUsageFlags): GPUBuffer {
    const buffer = this.device.createBuffer({ size, usage });
    this.buffers.push(buffer);
    return buffer;
  }

  private async shader(code: string): Promise<GPUShaderModule> {
    const module = this.device.createShaderModule({ code });
    const info = await module.getCompilationInfo();
    const error = info.messages.find(message => message.type === 'error');
    if (error) throw new Error(`Upscale shader: ${error.message}`);
    return module;
  }

  private async compute(code: string): Promise<GPUComputePipeline> {
    const module = await this.shader(code);
    return this.device.createComputePipelineAsync({ layout: 'auto', compute: { module, entryPoint: 'main' } });
  }
}
