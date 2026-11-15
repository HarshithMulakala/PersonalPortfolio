// Keep terrain edits additive: Three.js shader chunks own their declarations and
// feature guards, while the terrain material only appends its overrides after
// those chunks have run. This module stays dependency-free so the exact browser
// patch path can also be exercised by the Node verification script.

export const TERRAIN_FRAGMENT_CHUNK_INJECTIONS = Object.freeze({
  map_fragment: `terrainEvaluate();
        diffuseColor.rgb *= terrainLayerColor;`,
  normal_fragment_maps: `normal = normalize(mat3(viewMatrix) * terrainLayerWorldNormal);`,
  roughnessmap_fragment: `roughnessFactor *= terrainLayerRoughness;`,
  lights_fragment_end: `reflectedLight.indirectSpecular *= mix(1.0, 2.333333, terrainWetBand);`,
  aomap_fragment: `float terrainCavity = mix(1.0, terrainLayerAO, 0.18);
        float terrainIndirectAO = max(0.62, clamp(vTerrainAO, 0.62, 1.0) * terrainCavity);
        reflectedLight.indirectDiffuse *= terrainIndirectAO;`,
});

export function appendAfterShaderChunk(shaderSource, chunkName, injection) {
  const anchor = `#include <${chunkName}>`;
  const first = shaderSource.indexOf(anchor);
  const last = shaderSource.lastIndexOf(anchor);
  if (first < 0) throw new Error(`[voyage] missing Three.js shader chunk: ${chunkName}`);
  if (first !== last) throw new Error(`[voyage] duplicate Three.js shader chunk: ${chunkName}`);
  return shaderSource.replace(anchor, `${anchor}\n        ${injection}`);
}

export function patchTerrainFragmentChunks(shaderSource) {
  let patched = shaderSource;
  for (const [chunkName, injection] of Object.entries(TERRAIN_FRAGMENT_CHUNK_INJECTIONS)) {
    patched = appendAfterShaderChunk(patched, chunkName, injection);
  }
  return patched;
}
