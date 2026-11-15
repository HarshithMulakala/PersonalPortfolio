import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  buildOceanFragmentShader,
  OCEAN_FRAGMENT_TERRAIN_FETCH_BUDGET,
  WATER_DETAIL_NORMALS,
} from "../js/ocean-shader.mjs";

const oceanHeightFixture = `
float oceanHeight(vec2 p, float t){ return sin(p.x+t)*0.1; }
vec2 oceanSlope(vec2 p, float t){ return vec2(cos(p.x+t)*0.1, 0.0); }
`;
const generated = buildOceanFragmentShader(oceanHeightFixture);

function assertBefore(source, declaration, use) {
  const declarationIndex = source.indexOf(declaration);
  const useIndex = source.indexOf(use, declarationIndex + declaration.length);
  assert(declarationIndex >= 0, `missing declaration: ${declaration}`);
  assert(useIndex > declarationIndex, `use did not follow declaration: ${use}`);
}

for (const [declaration, use] of [
  ["uniform sampler2D uTerrainHeight, uTerrainSdf, uTerrainSplat;", "texture2D(uTerrainSdf"],
  ["uniform sampler2D uTerrainHeight, uTerrainSdf, uTerrainSplat;", "texture2D(uTerrainHeight"],
  ["uniform sampler2D uTerrainHeight, uTerrainSdf, uTerrainSplat;", "texture2D(uTerrainSplat"],
  ["vec2 oceanSlope(vec2 p, float t)", "oceanSlope(vWorld.xz, uTime)"],
  ["float hash21(vec2 p)", "hash21(i)"],
  ["float valueNoise2(vec2 p)", "valueNoise2(vWorld.xz"],
  ["float originsBayShelter(vec2 p)", "originsBayShelter(vWorld.xz)"],
  ["float exposedHeadlandSector(vec2 p)", "exposedHeadlandSector(vWorld.xz)"],
  ["vec3 reflectedSky(vec3 r)", "reflectedSky(reflect"],
  ["vec2 slope = oceanSlope", "slope +="],
  ["vec2 baseUnitUv =", "terrainContains(baseUnitUv)"],
  ["bool insideTerrain =", "if(insideTerrain)"],
  ["vec2 baseControlUv =", "texture2D(uTerrainSdf, baseControlUv)"],
  ["float shore =", "shore = texture2D"],
  ["float bedHeight =", "bedHeight = texture2D"],
  ["float waterDepth =", "smoothstep(0.0, 6.0, waterDepth)"],
  ["float fres =", "(1.0-fres)"],
  ["vec2 refractedControlUv =", "texture2D(uTerrainHeight, refractedControlUv)"],
  ["vec4 bedSplat =", "bedSplat = max(texture2D"],
  ["float refractedDepth =", "exp(-refractedDepth * absorption)"],
  ["float bayShelter =", "mix(1.0, 0.65, bayShelter)"],
  ["float headlandSector =", "headlandSector * 0.62"],
  ["float cliffExposure =", "mix(1.0, 1.25, cliffExposure)"],
  ["float phaseA =", "centerA = mix"],
  ["float phaseB =", "centerB = mix"],
  ["float foamOpacity =", "vec3(0.94, 0.93, 0.86), foamOpacity"],
]) {
  assertBefore(generated, declaration, use);
}

for (let i = 0; i < WATER_DETAIL_NORMALS.length; i++) {
  assertBefore(generated, `float detailLod${i} =`, `detailLod${i};`);
  assertBefore(generated, `float detailPhase${i} =`, `detailPhase${i} + uTime`);
}

const terrainFetches = generated.match(/texture2D\(uTerrain(?:Height|Sdf|Splat)\b/g) || [];
assert.equal(
  terrainFetches.length,
  OCEAN_FRAGMENT_TERRAIN_FETCH_BUDGET,
  `ocean TerrainField fetch count drifted: ${terrainFetches.length}`,
);
assert(generated.includes("vec3 absorption = vec3(0.26, 0.095, 0.045);"), "Beer-Lambert coefficients drifted outside the R3 range");
assert(generated.includes("float bottomFade = 1.0 - smoothstep(2.5, 6.0, refractedDepth);"), "seabed fade no longer reaches zero by 6u");
assert(generated.includes("vec2(-0.006), vec2(0.006)"), "refraction is no longer capped at 0.006 UV");
assert(generated.includes("float causticMask = 1.0 - smoothstep(1.7, 2.5, refractedDepth);"), "caustics are not limited to <2.5u");
assert(generated.includes("float primaryBreaker = smoothstep(0.25, 0.43, brokenDepth)"), "primary breaker no longer begins at 0.25u depth");
assert(generated.includes("1.60, brokenDepth"), "primary breaker no longer ends at 1.6u depth");
assert(generated.includes("float foamOpacity = min(0.55"), "foam opacity cap exceeds 0.55");
assert(generated.includes("mix(1.0, 0.65, bayShelter)"), "crescent-bay foam reduction is not 35%");
assert(generated.includes("mix(1.0, 1.25, cliffExposure)"), "exposed-cliff foam boost is not 25%");
assert(generated.includes("gl_FragColor = vec4(col, 1.0);"), "ocean is no longer opaque");

const [voyageSource, indexHtml] = await Promise.all([
  readFile(new URL("../js/voyage.js", import.meta.url), "utf8"),
  readFile(new URL("../index.html", import.meta.url), "utf8"),
]);
assert(indexHtml.includes("three@0.185.1/build/three.module.js"), "index.html no longer pins Three.js 0.185.1");
assert(voyageSource.includes("fragmentShader: buildOceanFragmentShader(oceanHeightGLSL())"), "production ocean bypasses the verified GLSL builder");
assert(voyageSource.includes("uTerrainSplat: { value: V.terrainTextures.splat }"), "production ocean does not reuse the shared splat DataTexture");

console.log(JSON.stringify({
  three: "0.185.1",
  terrainTextureFetches: terrainFetches.length,
  terrainTextureFetchBudget: OCEAN_FRAGMENT_TERRAIN_FETCH_BUDGET,
  waterDetailOctaves: WATER_DETAIL_NORMALS.length,
  declarationOrder: "pass",
  shorelineSpec: "pass",
}, null, 2));
