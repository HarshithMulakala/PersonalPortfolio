// Round 7 quality budgets and selection policy. Keep this module free of DOM and
// Three.js imports so production and scripts/verify-tiers.mjs consume the exact
// same constants.

export const QUALITY_STORAGE_KEY = "voyage-quality";
export const QUALITY_TIER_ORDER = Object.freeze(["high", "balanced", "mobile"]);
export const QUALITY_ORDER = QUALITY_TIER_ORDER;

const shader = (name, layerCount, activeLayers, triplanarAxes, rotatedSample, fetchBudget) =>
  Object.freeze({
    name,
    variant: name.replace(/^5-layer-/, "five-layer-").replace(/^3-layer-/, "three-layer-"),
    layerCount,
    activeLayers,
    blendLayers: activeLayers,
    triplanarAxes,
    rotatedSample,
    rotatedSamples: rotatedSample,
    fetchBudget,
  });

export const QUALITY_PROFILES = Object.freeze({
  high: Object.freeze({
    terrainGrid: Object.freeze([321, 249]),
    terrainSegments: Object.freeze([320, 248]),
    dprCap: 1.5,
    shadowMapSize: 4096,
    shadowRadius: 1.75,
    shadowBlurSamples: 8,
    terrainShader: shader("5-layer-full", 5, 2, 3, true, 12),
    oceanSegments: 144,
    cloudCount: 7,
    cloudScale: 115,
    birdCount: 8,
    wakeCount: 160,
    wakeInterval: 0.04,
    wakeLifetime: 2.55,
    motes: true,
    vegetationScale: 1,
    vegetationCounts: Object.freeze({ cypress: 72, olive: 112, scrub: 450, grass: 960, rocks: 160 }),
    vegetationShadows: true,
    grassDistance: 132,
    vegetationAtlasSize: 2048,
    bloom: true,
    pmremSize: 256,
    antialias: true,
  }),
  balanced: Object.freeze({
    terrainGrid: Object.freeze([257, 193]),
    terrainSegments: Object.freeze([256, 192]),
    dprCap: 1.25,
    shadowMapSize: 2048,
    shadowRadius: 1.5,
    shadowBlurSamples: 8,
    terrainShader: shader("5-layer-simplified", 5, 2, 1, true, 8),
    oceanSegments: 112,
    cloudCount: 5,
    cloudScale: 115,
    birdCount: 6,
    wakeCount: 136,
    wakeInterval: 0.048,
    wakeLifetime: 2.4,
    motes: true,
    vegetationScale: 0.6,
    vegetationCounts: Object.freeze({ cypress: 43, olive: 67, scrub: 270, grass: 576, rocks: 96 }),
    vegetationShadows: true,
    grassDistance: 96,
    vegetationAtlasSize: 1024,
    bloom: false,
    pmremSize: 128,
    antialias: true,
  }),
  mobile: Object.freeze({
    terrainGrid: Object.freeze([193, 145]),
    terrainSegments: Object.freeze([192, 144]),
    dprCap: 1,
    shadowMapSize: 1024,
    shadowRadius: 1.25,
    shadowBlurSamples: 8,
    terrainShader: shader("3-layer-merged", 3, 1, 1, false, 4),
    oceanSegments: 80,
    cloudCount: 4,
    cloudScale: 135,
    birdCount: 5,
    wakeCount: 112,
    wakeInterval: 0.055,
    wakeLifetime: 2.25,
    motes: false,
    vegetationScale: 0.28,
    vegetationCounts: Object.freeze({ cypress: 20, olive: 31, scrub: 126, grass: 269, rocks: 45 }),
    vegetationShadows: false,
    grassDistance: 64,
    vegetationAtlasSize: 1024,
    bloom: false,
    pmremSize: 64,
    antialias: false,
  }),
});

export const RUNTIME_DEGRADATION = Object.freeze({
  sampleFrames: 120,
  warmupFrames: 120,
  rollingFrames: 120,
  frameTimeP90Ms: 20,
  frameTimeP90LimitMs: 20,
  sustainMs: 3000,
  sustainedMs: 3000,
  recoveryMs: 1500,
  dprScale: 0.82,
  dprFloor: 0.75,
  minimumDpr: 0.75,
  vegetationScale: 0.62,
  grassDistanceScale: 0.68,
  steps: Object.freeze(["dpr", "bloom", "vegetation", "shadows", "tier"]),
});
export const RUNTIME_QUALITY = RUNTIME_DEGRADATION;

export function isQualityTier(value) {
  return QUALITY_TIER_ORDER.includes(value);
}

export function nextLowerTier(tier) {
  const index = QUALITY_TIER_ORDER.indexOf(tier);
  return index >= 0 && index < QUALITY_TIER_ORDER.length - 1
    ? QUALITY_TIER_ORDER[index + 1]
    : null;
}

export const nextQualityTier = nextLowerTier;

export function normalizeQualityTier(value) {
  return isQualityTier(value) ? value : null;
}

export function selectAutomaticQuality(inputs = {}) {
  const width = Math.max(1, Number(inputs.width) || 1);
  const height = Math.max(1, Number(inputs.height) || 1);
  const viewportPixels = width * height;
  const dpr = Math.max(1, Number(inputs.devicePixelRatio) || 1);
  const memory = Number(inputs.deviceMemory) || 0;
  const cores = Number(inputs.hardwareConcurrency) || 0;
  const maxTextureSize = Number(inputs.maxTextureSize) || 0;
  const coarse = inputs.coarsePointer === true;
  let pressure = 0;

  if (viewportPixels > 4_000_000) pressure += 1;
  else if (viewportPixels > 2_800_000) pressure += 0.5;
  if (dpr >= 2.75) pressure += 0.75;
  else if (dpr >= 2.25) pressure += 0.35;
  if (memory && memory <= 4) pressure += 1.5;
  else if (memory && memory <= 6) pressure += 0.75;
  if (cores && cores <= 4) pressure += 1.5;
  else if (cores && cores <= 6) pressure += 0.75;
  if (maxTextureSize && maxTextureSize < 4096) return "mobile";
  if (maxTextureSize && maxTextureSize < 8192) pressure += 1.25;
  // Pointer type is deliberately weak by itself; narrow layout is the stronger
  // mobile signal so touch-capable laptops do not get demoted automatically.
  if (coarse) pressure += 0.4;
  if (Math.min(width, height) < 600) pressure += 1.4;
  else if (Math.min(width, height) < 760) pressure += 0.55;

  if (pressure >= 3) return "mobile";
  if (pressure >= 1.25) return "balanced";
  return "high";
}

export function autoSelectQualityTier(inputs = {}) {
  return selectAutomaticQuality({
    width: inputs.viewportWidth,
    height: inputs.viewportHeight,
    devicePixelRatio: inputs.devicePixelRatio,
    deviceMemory: inputs.deviceMemory,
    hardwareConcurrency: inputs.hardwareConcurrency,
    maxTextureSize: inputs.maxTextureSize,
    coarsePointer: inputs.coarsePointer,
  });
}

export function resolveQualityTier({ search = "", storage = null, inputs = {} } = {}) {
  const requested = new URLSearchParams(search).get("quality");
  if (isQualityTier(requested)) {
    try { storage && storage.setItem(QUALITY_STORAGE_KEY, requested); } catch (error) {}
    return { tier: requested, source: "query" };
  }
  let persisted = null;
  try { persisted = storage && storage.getItem(QUALITY_STORAGE_KEY); } catch (error) {}
  if (isQualityTier(persisted)) return { tier: persisted, source: "storage" };
  const tier = selectAutomaticQuality(inputs);
  try { storage && storage.setItem(QUALITY_STORAGE_KEY, tier); } catch (error) {}
  return { tier, source: "automatic" };
}

export function qualityOverride(search = "") {
  const value = new URLSearchParams(search).get("quality");
  return isQualityTier(value) ? value : null;
}

// Browser-facing adapter retained as a small wrapper so app.js does not need to
// know the storage key or the pure selector's input names.
export function selectQualityTier(inputs = {}, storage = null) {
  const override = normalizeQualityTier(inputs.override);
  if (override) {
    try { storage && storage.setItem(QUALITY_STORAGE_KEY, override); } catch (error) {}
    return override;
  }
  let persisted = null;
  try { persisted = storage && storage.getItem(QUALITY_STORAGE_KEY); } catch (error) {}
  if (isQualityTier(persisted)) return persisted;
  const selected = selectAutomaticQuality({
    width: inputs.viewportWidth,
    height: inputs.viewportHeight,
    devicePixelRatio: inputs.devicePixelRatio,
    deviceMemory: inputs.deviceMemory,
    hardwareConcurrency: inputs.hardwareConcurrency,
    maxTextureSize: inputs.maxTextureSize,
    coarsePointer: inputs.coarsePointer,
  });
  try { storage && storage.setItem(QUALITY_STORAGE_KEY, selected); } catch (error) {}
  return selected;
}
