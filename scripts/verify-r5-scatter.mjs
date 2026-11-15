import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  R5_SCATTER_CONFIG,
  r5TriangleCount,
} from "../js/r5-scatter-config.mjs";

const { high } = R5_SCATTER_CONFIG.tiers;
const { counts } = high;
const vegetationDraws = Object.values(high.vegetationDraws).reduce((sum, value) => sum + value, 0);
const rockTriangles = R5_SCATTER_CONFIG.rocks.details.map(r5TriangleCount);
const [voyageSource, scatterSource, terrainMaterialSource] = await Promise.all([
  readFile(new URL("../js/voyage.js", import.meta.url), "utf8"),
  readFile(new URL("../js/r5-scatter.mjs", import.meta.url), "utf8"),
  readFile(new URL("../js/terrain-material.mjs", import.meta.url), "utf8"),
]);

assert.ok(counts.cypress >= 55 && counts.cypress <= 90, "High cypress count must stay in the R5 brief range");
assert.ok(counts.olive >= 85 && counts.olive <= 140, "High olive count must stay in the R5 brief range");
assert.equal(counts.scrub, 450, "High scrub count must remain at the R5 floor");
assert.ok(counts.grass >= 700 && counts.grass <= 1200, "High grass count must stay in the R5 brief range");
assert.ok(counts.rocks >= 140 && counts.rocks <= 180, "High rock count must stay in the R5 brief range");
assert.equal(vegetationDraws, R5_SCATTER_CONFIG.draws.vegetation);
assert.ok(vegetationDraws <= R5_SCATTER_CONFIG.limits.vegetationDraws, "Vegetation exceeds its draw budget");
assert.equal(R5_SCATTER_CONFIG.rocks.details.length, R5_SCATTER_CONFIG.draws.rocks);
assert.ok(R5_SCATTER_CONFIG.draws.rocks <= R5_SCATTER_CONFIG.limits.rockDraws, "Rocks exceed their draw budget");
assert.equal(R5_SCATTER_CONFIG.draws.contacts, 1, "Tree and boulder contacts must share one draw");
assert.equal(
  vegetationDraws + R5_SCATTER_CONFIG.draws.rocks + R5_SCATTER_CONFIG.draws.contacts,
  R5_SCATTER_CONFIG.draws.addedColorTotal,
);
assert.ok(
  R5_SCATTER_CONFIG.draws.addedColorTotal <= R5_SCATTER_CONFIG.limits.addedColorDraws,
  "R5 exceeds its added color-draw allowance",
);
for (const triangles of rockTriangles) {
  assert.ok(
    triangles >= R5_SCATTER_CONFIG.limits.rockTriangles[0] && triangles <= R5_SCATTER_CONFIG.limits.rockTriangles[1],
    `Rock variant ${triangles} tris falls outside the 500-1500 budget`,
  );
}
assert.equal(R5_SCATTER_CONFIG.atlas.grid ** 2, 16, "The atlas must expose sixteen frames");
assert.equal(new Set(Object.values(R5_SCATTER_CONFIG.atlas.frames).flat()).size, 16, "Atlas frames must not overlap");
assert.ok(!voyageSource.includes('"rocks-a"') && !voyageSource.includes('"rocks-b"'), "Old Kenney rock GLBs must not load or scatter");
assert.ok(!voyageSource.includes("scatterMediterraneanProps"), "Old low-poly mass scatter must be removed");
assert.ok(!voyageSource.includes('"tree-cypress"'), "R6 must not load the retired low-poly cypress GLB");
assert.ok(voyageSource.includes("heroTrees: V.islands.flatMap"), "R6 Origins hero trees must reuse the R5 impostor batches");
assert.ok(scatterSource.includes("point.heroHeightScale"), "R5 impostors must support taller R6 hero variants");
assert.ok(scatterSource.includes("landmarkDebris"), "R6 landmark scree must reuse the R5 boulder variants");
assert.ok(scatterSource.includes("deriveNormalAtlas"), "Vegetation must derive a Sobel normal atlas");
assert.ok(scatterSource.includes("windWeight"), "Vegetation must carry top-weighted wind vertices");
assert.ok(scatterSource.includes("instanceVariation"), "Vegetation must carry per-instance variation");
assert.ok(terrainMaterialSource.includes("terrainInstancePosition = instanceMatrix"), "Terrain projection must account for rock instance transforms");
assert.ok(terrainMaterialSource.includes("rockMode"), "Rocks must share the terrain triplanar shader factory");

console.log(JSON.stringify({
  counts,
  draws: R5_SCATTER_CONFIG.draws,
  rockTriangles,
  atlasSize: high.atlasSize,
  sceneColorDrawCeiling: R5_SCATTER_CONFIG.limits.totalSceneColorDraws,
}, null, 2));
