// Procedural terrain texture fallback. This worker is never started while the
// CC0 files load normally; it only runs for a specific failed source image.
const LAYER_FALLBACKS = {
  sand: [0xd8c28f, 0.92],
  drygrass: [0x8c8050, 0.94],
  scrub: [0x5f7042, 0.96],
  limestone: [0xb9b09c, 0.9],
  scree: [0x756f64, 0.96],
};

self.onmessage = (event) => {
  const { kind, layerName, layerIndex, size = 512 } = event.data || {};
  const fallback = LAYER_FALLBACKS[layerName] || LAYER_FALLBACKS.limestone;
  const color = fallback[0];
  const baseR = (color >> 16) & 255;
  const baseG = (color >> 8) & 255;
  const baseB = color & 255;
  const data = new Uint8ClampedArray(size * size * 4);
  let state = 0x6d2b79f5 ^ ((layerIndex || 0) * 0x9e3779b9);
  const random = () => {
    state = Math.imul(state ^ (state >>> 15), state | 1);
    state ^= state + Math.imul(state ^ (state >>> 7), state | 61);
    return ((state ^ (state >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = 0; i < data.length; i += 4) {
    const grain = random() - 0.5;
    if (kind === "albedo") {
      data[i] = baseR + grain * 22;
      data[i + 1] = baseG + grain * 18;
      data[i + 2] = baseB + grain * 14;
    } else if (kind === "normal") {
      data[i] = 128 + grain * 8;
      data[i + 1] = 128 + (random() - 0.5) * 8;
      data[i + 2] = 255;
    } else {
      const scalar = kind === "ao" ? 244 + grain * 10 : fallback[1] * 255 + grain * 12;
      data[i] = data[i + 1] = data[i + 2] = scalar;
    }
    data[i + 3] = 255;
  }
  self.postMessage({ width: size, height: size, data }, [data.buffer]);
};
