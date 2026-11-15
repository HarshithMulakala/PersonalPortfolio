import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  autoSelectQualityTier,
  nextQualityTier,
  QUALITY_ORDER,
  QUALITY_PROFILES,
  RUNTIME_QUALITY,
  selectQualityTier,
} from "../js/quality-config.mjs";
import { R5_SCATTER_CONFIG } from "../js/r5-scatter-config.mjs";

assert.deepEqual(QUALITY_ORDER, ["high", "balanced", "mobile"]);
assert.equal(nextQualityTier("high"), "balanced");
assert.equal(nextQualityTier("balanced"), "mobile");
assert.equal(nextQualityTier("mobile"), null);

const expected = {
  high: {
    grid: [321, 249], dpr: 1.5, shadow: 4096,
    shadowRadius: 1.75, shadowBlurSamples: 8,
    layers: 5, activeLayers: 2, axes: 3, rotated: true,
    name: "5-layer-full", variant: "five-layer-full", fetches: 12,
    ocean: 144, clouds: 7, cloudScale: 115, birds: 8,
    wake: 160, wakeInterval: 0.04, wakeLifetime: 2.55, motes: true,
    vegetation: 1,
    counts: { cypress: 72, olive: 112, scrub: 450, grass: 960, rocks: 160 },
    vegetationShadows: true, grassDistance: 132, atlas: 2048,
    bloom: true, pmrem: 256, antialias: true,
  },
  balanced: {
    grid: [257, 193], dpr: 1.25, shadow: 2048,
    shadowRadius: 1.5, shadowBlurSamples: 8,
    layers: 5, activeLayers: 2, axes: 1, rotated: true,
    name: "5-layer-simplified", variant: "five-layer-simplified", fetches: 8,
    ocean: 112, clouds: 5, cloudScale: 115, birds: 6,
    wake: 136, wakeInterval: 0.048, wakeLifetime: 2.4, motes: true,
    vegetation: 0.6,
    counts: { cypress: 43, olive: 67, scrub: 270, grass: 576, rocks: 96 },
    vegetationShadows: true, grassDistance: 96, atlas: 1024,
    bloom: false, pmrem: 128, antialias: true,
  },
  mobile: {
    grid: [193, 145], dpr: 1, shadow: 1024,
    shadowRadius: 1.25, shadowBlurSamples: 8,
    layers: 3, activeLayers: 1, axes: 1, rotated: false,
    name: "3-layer-merged", variant: "three-layer-merged", fetches: 4,
    ocean: 80, clouds: 4, cloudScale: 135, birds: 5,
    wake: 112, wakeInterval: 0.055, wakeLifetime: 2.25, motes: false,
    vegetation: 0.28,
    counts: { cypress: 20, olive: 31, scrub: 126, grass: 269, rocks: 45 },
    vegetationShadows: false, grassDistance: 64, atlas: 1024,
    bloom: false, pmrem: 64, antialias: false,
  },
};

for (const [tier, budget] of Object.entries(expected)) {
  const profile = QUALITY_PROFILES[tier];
  assert.deepEqual(profile.terrainGrid, budget.grid, `${tier} terrain grid drifted`);
  assert.deepEqual(profile.terrainSegments, budget.grid.map((value) => value - 1));
  assert.equal(profile.dprCap, budget.dpr, `${tier} DPR cap drifted`);
  assert.equal(profile.shadowMapSize, budget.shadow, `${tier} shadow map drifted`);
  assert.equal(profile.shadowRadius, budget.shadowRadius, `${tier} shadow radius drifted`);
  assert.equal(profile.shadowBlurSamples, budget.shadowBlurSamples, `${tier} shadow blur samples drifted`);
  assert.equal(profile.terrainShader.layerCount, budget.layers, `${tier} material layer count drifted`);
  assert.equal(profile.terrainShader.activeLayers, budget.activeLayers, `${tier} active material layers drifted`);
  assert.equal(profile.terrainShader.triplanarAxes, budget.axes, `${tier} triplanar policy drifted`);
  assert.equal(profile.terrainShader.rotatedSample, budget.rotated, `${tier} rotated sample policy drifted`);
  assert.equal(profile.terrainShader.name, budget.name, `${tier} shader name drifted`);
  assert.equal(profile.terrainShader.variant, budget.variant, `${tier} shader variant drifted`);
  assert.equal(profile.terrainShader.fetchBudget, budget.fetches, `${tier} fetch budget drifted`);
  assert.equal(profile.oceanSegments, budget.ocean, `${tier} ocean segments drifted`);
  assert.equal(profile.cloudCount, budget.clouds, `${tier} cloud count drifted`);
  assert.equal(profile.cloudScale, budget.cloudScale, `${tier} cloud scale drifted`);
  assert.equal(profile.birdCount, budget.birds, `${tier} bird count drifted`);
  assert.equal(profile.wakeCount, budget.wake, `${tier} wake count drifted`);
  assert.equal(profile.wakeInterval, budget.wakeInterval, `${tier} wake interval drifted`);
  assert.equal(profile.wakeLifetime, budget.wakeLifetime, `${tier} wake lifetime drifted`);
  assert.equal(profile.motes, budget.motes, `${tier} mote policy drifted`);
  assert.equal(profile.vegetationScale, budget.vegetation, `${tier} vegetation scale drifted`);
  assert.deepEqual(profile.vegetationCounts, budget.counts, `${tier} vegetation counts drifted`);
  assert.equal(profile.vegetationShadows, budget.vegetationShadows, `${tier} vegetation shadow policy drifted`);
  assert.equal(profile.grassDistance, budget.grassDistance, `${tier} grass cull distance drifted`);
  assert.equal(profile.vegetationAtlasSize, budget.atlas, `${tier} vegetation atlas drifted`);
  assert.equal(profile.bloom, budget.bloom, `${tier} bloom policy drifted`);
  assert.equal(profile.pmremSize, budget.pmrem, `${tier} PMREM size drifted`);
  assert.equal(profile.antialias, budget.antialias, `${tier} antialias policy drifted`);
  assert.deepEqual(R5_SCATTER_CONFIG.tiers[tier].counts, profile.vegetationCounts);
}

assert.ok(QUALITY_PROFILES.mobile.vegetationScale >= 0.25 && QUALITY_PROFILES.mobile.vegetationScale <= 0.3);
assert.ok(QUALITY_PROFILES.high.oceanSegments > QUALITY_PROFILES.balanced.oceanSegments);
assert.ok(QUALITY_PROFILES.balanced.oceanSegments > QUALITY_PROFILES.mobile.oceanSegments);
assert.equal(RUNTIME_QUALITY.warmupFrames, 120);
assert.equal(RUNTIME_QUALITY.rollingFrames, 120);
assert.equal(RUNTIME_QUALITY.frameTimeP90LimitMs, 20);
assert.equal(RUNTIME_QUALITY.sustainedMs, 3000);
assert.equal(RUNTIME_QUALITY.dprScale, 0.82);
assert.equal(RUNTIME_QUALITY.minimumDpr, 0.75);
assert.equal(RUNTIME_QUALITY.vegetationScale, 0.62);
assert.equal(RUNTIME_QUALITY.grassDistanceScale, 0.68);
assert.deepEqual(RUNTIME_QUALITY.steps, ["dpr", "bloom", "vegetation", "shadows", "tier"]);

assert.equal(autoSelectQualityTier({
  viewportWidth: 390, viewportHeight: 844, devicePixelRatio: 3,
  deviceMemory: 4, hardwareConcurrency: 4, maxTextureSize: 4096, coarsePointer: true,
}), "mobile");
assert.equal(autoSelectQualityTier({
  viewportWidth: 1440, viewportHeight: 900, devicePixelRatio: 1,
  deviceMemory: 16, hardwareConcurrency: 10, maxTextureSize: 16384, coarsePointer: false,
}), "high");
const persisted = new Map();
const storage = {
  getItem(key) { return persisted.get(key) || null; },
  setItem(key, value) { persisted.set(key, value); },
};
assert.equal(selectQualityTier({
  viewportWidth: 1440, viewportHeight: 900, devicePixelRatio: 1,
  deviceMemory: 16, hardwareConcurrency: 10, maxTextureSize: 16384, coarsePointer: false,
}, storage), "high");
assert.equal(selectQualityTier({ override: "mobile" }, storage), "mobile");
assert.equal(selectQualityTier({}, storage), "mobile");

const [appSource, voyageSource, terrainSource, scatterSource, cssSource, uiSource] = await Promise.all([
  readFile(new URL("../js/app.js", import.meta.url), "utf8"),
  readFile(new URL("../js/voyage.js", import.meta.url), "utf8"),
  readFile(new URL("../js/terrain-material.mjs", import.meta.url), "utf8"),
  readFile(new URL("../js/r5-scatter.mjs", import.meta.url), "utf8"),
  readFile(new URL("../css/main.css", import.meta.url), "utf8"),
  readFile(new URL("../js/ui.js", import.meta.url), "utf8"),
]);

for (const signal of [
  "viewportWidth", "viewportHeight", "devicePixelRatio", "deviceMemory",
  "hardwareConcurrency", "maxTextureSize", "coarsePointer", "qualityOverride",
]) assert.ok(appSource.includes(signal), `selection input missing: ${signal}`);
assert.ok(voyageSource.includes("RUNTIME_QUALITY.frameTimeP90LimitMs"));
assert.ok(voyageSource.includes("applyNextRuntimeDegradation"));
assert.ok(voyageSource.includes("nextQualityTier(V.quality)"));
assert.ok(voyageSource.includes("buildUnifiedIslandTerrain()"));
assert.ok(!voyageSource.includes("PCFSoftShadowMap"));
assert.ok(voyageSource.includes("THREE.PCFShadowMap"));
assert.ok(voyageSource.includes('"blurSamples" in sun.shadow'));
assert.ok(voyageSource.includes('"blurSamples" in V.sun.shadow'));
assert.ok(voyageSource.includes("perf: readPerformanceProbe"));
assert.ok(voyageSource.includes("const frameP90 = percentile(V.perfSamples, 0.9)"));
assert.ok(voyageSource.includes("1000 / frameP90"));
assert.ok(voyageSource.includes("reportProgress(1)"));
assert.ok(voyageSource.includes("V.lastProgress = Math.max"));
assert.ok(voyageSource.includes("{ size: V.profile.pmremSize }") || voyageSource.includes("V.profile.pmremSize"));
const tierProfileSource = voyageSource.slice(
  voyageSource.indexOf("function applyTierProfile"),
  voyageSource.indexOf("function textureBytesPerPixel"),
);
assert.ok(tierProfileSource.includes("buildUnifiedIslandTerrain()"));
assert.ok(!tierProfileSource.includes("generateTerrainField("), "tier drop regenerates morphology");
assert.ok(!tierProfileSource.includes("initTerrainField("), "tier drop reinitializes TerrainField");
assert.ok(terrainSource.includes("TERRAIN_MERGED_LAYERS"));
assert.ok(terrainSource.includes("setTerrainMaterialQuality"));
assert.ok(scatterSource.includes("uVegetationCullDistance"));
assert.ok(scatterSource.includes("vVegetationDistanceFade"));
assert.ok(scatterSource.includes("grassDistanceUniform.value = grassDistance"));
assert.ok(cssSource.includes("body:not(.quality-mobile) #joystick-zone"));
const closeEntrySource = uiSource.slice(
  uiSource.indexOf("export function closeEntryScroll"),
  uiSource.indexOf("export function setEntryProgress"),
);
assert.ok(closeEntrySource.indexOf("document.body.focus") < closeEntrySource.indexOf('dom.entry.setAttribute("aria-hidden", "true")'));
assert.ok(closeEntrySource.indexOf('dom.entry.setAttribute("inert", "")') < closeEntrySource.indexOf('dom.entry.setAttribute("aria-hidden", "true")'));

console.log(JSON.stringify({
  tiers: Object.fromEntries(Object.entries(QUALITY_PROFILES).map(([tier, profile]) => [tier, {
    grid: profile.terrainGrid,
    dpr: profile.dprCap,
    shadow: profile.shadowMapSize,
    shader: profile.terrainShader.variant,
    oceanSegments: profile.oceanSegments,
    vegetationScale: profile.vegetationScale,
    bloom: profile.bloom,
    pmrem: profile.pmremSize,
  }])),
  runtime: RUNTIME_QUALITY,
}, null, 2));
