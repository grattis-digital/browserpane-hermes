import small from './model/cnn-2x-s.json';
import medium from './model/cnn-2x-m.json';

export type UpscaleMode = 'balanced' | 'quality';
export type EnhancementPreference = 'original' | 'smart' | 'smart-quality';
export type ModelLayer = Readonly<{ weights: readonly number[]; bias: readonly number[] }>;
export type UpscaleModel = Readonly<{ convolutions: readonly ModelLayer[]; heads: readonly ModelLayer[] }>;

/** Pinned models only: no network loader, inferred architecture or filter stacking. */
export class UpscaleModels {
  public static preference(value: unknown): EnhancementPreference {
    return value === 'smart' || value === 'smart-quality' ? value : 'original';
  }

  public static mode(preference: EnhancementPreference): UpscaleMode {
    return preference === 'smart-quality' ? 'quality' : 'balanced';
  }

  public static label(mode: UpscaleMode): string { return mode === 'quality' ? 'Quality' : 'Balanced'; }

  public static get(mode: UpscaleMode): UpscaleModel {
    if (mode !== 'balanced' && mode !== 'quality') throw new Error('Unknown upscale model');
    const s = small.layers, m = medium.layers;
    const convolutions = mode === 'balanced'
      ? [s.conv2d_tf, s.conv2d_1_tf, s.conv2d_2_tf, s.conv2d_last_tf]
      : [m.conv2d_tf, m.conv2d_1_tf, m.conv2d_2_tf, m.conv2d_3_tf, m.conv2d_4_tf, m.conv2d_5_tf, m.conv2d_6_tf];
    const heads = mode === 'balanced' ? [] : [m.conv2d_7_tf, m.conv2d_7_tf1, m.conv2d_7_tf2];
    convolutions.forEach((layer, index) => this.validate(layer, index ? 288 : 144));
    heads.forEach(layer => this.validate(layer, 224));
    return { convolutions, heads };
  }

  private static validate(layer: ModelLayer, weights: number): void {
    if (layer.weights.length !== weights || layer.bias.length !== 4
      || !layer.weights.every(Number.isFinite) || !layer.bias.every(Number.isFinite)) {
      throw new Error('Invalid upscale model');
    }
  }
}
