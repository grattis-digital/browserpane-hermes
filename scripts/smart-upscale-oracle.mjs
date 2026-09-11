/** CPU reference ONLY for synthetic correctness tests; never shipped to viewers. */
export function upscaleReference(rgba, width, height, model) {
  const states = new Map([['input_image', Float32Array.from(rgba, value => value / 255)]]);
  const layers = Object.values(model.layers).filter(layer => layer.type === 'conv');
  for (const [index, layer] of layers.entries()) {
    const current = states.get(layer.inputs[0]);
    const next = new Float32Array(rgba.length);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const result = [...layer.bias];
      if (layer.inputs.length === 7) {
        // Medium's pointwise RGB heads consume all seven retained feature maps.
        for (const [inputIndex, name] of layer.inputs.entries()) {
          const features = states.get(name);
          for (let column = 0; column < 4; column++) for (let row = 0; row < 4; row++) {
            const value = features[(y * width + x) * 4 + column];
            result[row] += layer.weights[inputIndex * 32 + column * 4 + row] * Math.max(value, 0);
            result[row] += layer.weights[inputIndex * 32 + 16 + column * 4 + row] * Math.max(-value, 0);
          }
        }
      } else for (let k = 0; k < 9; k++) {
        const px = Math.max(0, Math.min(width - 1, x + Math.floor(k / 3) - 1));
        const py = Math.max(0, Math.min(height - 1, y + k % 3 - 1));
        for (let column = 0; column < 4; column++) for (let row = 0; row < 4; row++) {
          const value = current[(py * width + px) * 4 + column];
          result[row] += layer.weights[k * 16 + column * 4 + row] * (index ? Math.max(value, 0) : value);
          if (index) result[row] += layer.weights[(k + 9) * 16 + column * 4 + row] * Math.max(-value, 0);
        }
      }
      next.set(result, (y * width + x) * 4);
    }
    states.set(layer.output, next);
  }
  const output = new Uint8ClampedArray(width * height * 16);
  const sample = (x, y, c) => rgba[(Math.max(0, Math.min(height - 1, y)) * width + Math.max(0, Math.min(width - 1, x))) * 4 + c] / 255;
  for (let y = 0; y < height * 2; y++) for (let x = 0; x < width * 2; x++) {
    const px = (x + 0.5) / 2 - 0.5, py = (y + 0.5) / 2 - 0.5;
    const ix = Math.floor(px), iy = Math.floor(py), fx = px - ix, fy = py - iy;
    const shuffle = model.layers.pixel_shuffle.inputs;
    const featureOffset = (Math.floor(y / 2) * width + Math.floor(x / 2)) * 4 + x % 2 + y % 2 * 2;
    const offset = (y * width * 2 + x) * 4;
    for (let c = 0; c < 3; c++) {
      const residual = states.get(shuffle.length === 1 ? shuffle[0] : shuffle[c])[featureOffset];
      const original = (sample(ix, iy, c) * (1 - fx) + sample(ix + 1, iy, c) * fx) * (1 - fy)
        + (sample(ix, iy + 1, c) * (1 - fx) + sample(ix + 1, iy + 1, c) * fx) * fy;
      const neighbors = [sample(ix, iy, c), sample(ix + 1, iy, c), sample(ix, iy + 1, c), sample(ix + 1, iy + 1, c)];
      output[offset + c] = Math.max(Math.min(...neighbors), Math.min(Math.max(...neighbors), original + residual * 0.75)) * 255;
    }
    output[offset + 3] = 255;
  }
  return output;
}
