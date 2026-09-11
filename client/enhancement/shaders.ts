/** Anime4K CNN math; model provenance/licenses live in ./model/. */
export class UpscaleShaders {
  public static convolution(first: boolean): string {
    return `
struct Shape { size: vec2u, padding: vec2u }
struct Model { kernels: array<mat4x4f, ${first ? 9 : 18}>, bias: vec4f }
@group(0) @binding(0) var<uniform> shape: Shape;
@group(0) @binding(1) var<storage, read> model: Model;
@group(0) @binding(2) ${first ? 'var source: texture_2d<f32>;' : 'var<storage, read> source: array<vec4f>;'}
@group(0) @binding(3) var<storage, read_write> outputFeatures: array<vec4f>;
@compute @workgroup_size(8, 8) fn main(@builtin(global_invocation_id) id: vec3u) {
  if (any(id.xy >= shape.size)) { return; }
  var result = model.bias;
  for (var k = 0u; k < 9u; k++) {
    let delta = vec2i(i32(k / 3u) - 1, i32(k % 3u) - 1);
    let p = vec2u(clamp(vec2i(id.xy) + delta, vec2i(0), vec2i(shape.size) - 1));
    let pixel = ${first ? 'textureLoad(source, vec2i(p), 0)' : 'source[p.y * shape.size.x + p.x]'};
    ${first ? 'result += model.kernels[k] * pixel;' : `result += model.kernels[k] * max(pixel, vec4f(0));
    result += model.kernels[k + 9u] * max(-pixel, vec4f(0));`}
  }
  outputFeatures[id.y * shape.size.x + id.x] = result;
}`;
  }

  public static qualityHeads(): string {
    // Fuse three 1×1 RGB heads. Seven read-only feature buffers plus one output
    // stay within WebGPU's portable eight-storage-buffer limit. Weights are uniform.
    return `
struct Shape { size: vec2u, padding: vec2u }
struct Head { kernels: array<mat4x4f, 14>, bias: vec4f }
struct Heads { values: array<Head, 3> }
struct RgbFeatures { r: vec4f, g: vec4f, b: vec4f }
@group(0) @binding(0) var<uniform> shape: Shape;
@group(0) @binding(1) var<uniform> heads: Heads;
${Array.from({ length: 7 }, (_, index) => `@group(0) @binding(${index + 2}) var<storage, read> feature${index}: array<vec4f>;`).join('\n')}
@group(0) @binding(9) var<storage, read_write> outputFeatures: array<RgbFeatures>;
@compute @workgroup_size(8, 8) fn main(@builtin(global_invocation_id) id: vec3u) {
  if (any(id.xy >= shape.size)) { return; }
  let offset = id.y * shape.size.x + id.x;
  var result: array<vec4f, 3>;
  for (var channel = 0u; channel < 3u; channel++) {
    var value = heads.values[channel].bias;
    ${Array.from({ length: 7 }, (_, index) => `value += heads.values[channel].kernels[${index * 2}] * max(feature${index}[offset], vec4f(0));
    value += heads.values[channel].kernels[${index * 2 + 1}] * max(-feature${index}[offset], vec4f(0));`).join('\n    ')}
    result[channel] = value;
  }
  outputFeatures[offset] = RgbFeatures(result[0], result[1], result[2]);
}`;
  }

  public static presentation(mode: 'balanced' | 'quality' = 'balanced'): string {
    return `
struct Shape { size: vec2u, padding: vec2u }
struct RgbFeatures { r: vec4f, g: vec4f, b: vec4f }
@group(0) @binding(0) var<uniform> shape: Shape;
@group(0) @binding(1) var<storage, read> features: array<${mode === 'quality' ? 'RgbFeatures' : 'vec4f'}>;
@group(0) @binding(2) var source: texture_2d<f32>;
@group(0) @binding(3) var linearSampler: sampler;
fn samplePixel(p: vec2i) -> vec3f {
  return textureLoad(source, clamp(p, vec2i(0), vec2i(shape.size) - 1), 0).rgb;
}
@vertex fn vertex(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  let positions = array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
  return vec4f(positions[index], 0, 1);
}
@fragment fn fragment(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let outPixel = vec2u(position.xy);
  let p = outPixel / 2u;
  let channel = (outPixel.x % 2u) + (outPixel.y % 2u) * 2u;
  let detail = features[p.y * shape.size.x + p.x];
  let residual = ${mode === 'quality' ? 'vec3f(detail.r[channel], detail.g[channel], detail.b[channel])' : 'vec3f(detail[channel])'};
  let uv = clamp(position.xy / 2.0, vec2f(0.5), vec2f(shape.size) - 0.5)
    / vec2f(textureDimensions(source));
  let original = textureSampleLevel(source, linearSampler, uv, 0).rgb;
  // Viewer-specific anti-ringing: flat regions remain exact, with no invented
  // local colour extrema. Keep a conservative 75% of the learned residual.
  let low = vec2i(floor(position.xy / 2.0 - 0.5));
  let a = samplePixel(low);
  let b = samplePixel(low + vec2i(1, 0));
  let c = samplePixel(low + vec2i(0, 1));
  let d = samplePixel(low + vec2i(1, 1));
  return vec4f(clamp(original + vec3f(residual * 0.75), min(min(a, b), min(c, d)), max(max(a, b), max(c, d))), 1);
}`;
  }
}
