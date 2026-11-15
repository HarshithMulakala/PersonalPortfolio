import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { R6_LANDMARK_CONFIG } from "../js/r6-landmark-config.mjs";
import { generateTerrainField, TERRAIN_PADS } from "../js/terrain-field.mjs";

function parseGlbJson(buffer) {
  assert.equal(buffer.readUInt32LE(0), 0x46546c67, "asset is not binary glTF");
  const jsonLength = buffer.readUInt32LE(12);
  return JSON.parse(buffer.subarray(20, 20 + jsonLength).toString().replace(/\0/g, ""));
}

const [voyageSource, geometrySource, materialSource, scatterSource] = await Promise.all([
  readFile(new URL("../js/voyage.js", import.meta.url), "utf8"),
  readFile(new URL("../js/r6-landmark-geometry.mjs", import.meta.url), "utf8"),
  readFile(new URL("../js/terrain-material.mjs", import.meta.url), "utf8"),
  readFile(new URL("../js/r5-scatter.mjs", import.meta.url), "utf8"),
]);
const [templeGlb, lighthouseGlb, ruinsGlb, dockGlb] = await Promise.all([
  readFile(new URL("../assets/models/temple.glb", import.meta.url)),
  readFile(new URL("../assets/models/lighthouse.glb", import.meta.url)),
  readFile(new URL("../assets/models/ruins-columns.glb", import.meta.url)),
  readFile(new URL("../assets/models/dock.glb", import.meta.url)),
]).then((buffers) => buffers.map(parseGlbJson));
const sourcePrimitives = {
  temple: templeGlb.meshes.length,
  lighthouse: lighthouseGlb.meshes.length,
  ruins: ruinsGlb.meshes.length,
  dockTile: dockGlb.meshes.length,
};
assert.deepEqual(sourcePrimitives, { temple: 42, lighthouse: 20, ruins: 14, dockTile: 1 });

function positionBounds(glb) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const mesh of glb.meshes) for (const primitive of mesh.primitives) {
    const accessor = glb.accessors[primitive.attributes.POSITION];
    for (let axis = 0; axis < 3; axis++) {
      min[axis] = Math.min(min[axis], accessor.min[axis]);
      max[axis] = Math.max(max[axis], accessor.max[axis]);
    }
  }
  return { size: max.map((value, axis) => value - min[axis]) };
}
const templeBounds = positionBounds(templeGlb);
const templeScaledHeight = R6_LANDMARK_CONFIG.silhouettes.templeTargetXZ
  * templeBounds.size[1] / Math.max(templeBounds.size[0], templeBounds.size[2])
  * R6_LANDMARK_CONFIG.silhouettes.templeHeightScale;
const silhouetteField = generateTerrainField({ droplets: Number(process.env.TERRAIN_DROPLETS || 18000) });
const padById = new Map(TERRAIN_PADS.map((pad) => [pad.id, pad]));
const padHeight = (id) => {
  const pad = padById.get(id);
  return silhouetteField.sampleHeight(pad.x, pad.z);
};
const templeTop = padHeight("labors") + templeScaledHeight;
const lighthouseTop = padHeight("oracle") + R6_LANDMARK_CONFIG.silhouettes.lighthouseTargetHeight;
assert.ok(templeTop > lighthouseTop + 0.5, "summit temple no longer clears the lighthouse silhouette");

for (const key of ["originsCottage", "temple", "lighthouse", "forge", "dockPier", "ruins"]) {
  assert.ok(Number.isInteger(R6_LANDMARK_CONFIG.draws[key]), `missing static draw count: ${key}`);
  assert.ok(voyageSource.includes(`"${key}"`), `runtime census does not register ${key}`);
}
for (const key of ["temple", "lighthouse", "ruins"]) {
  assert.ok(
    R6_LANDMARK_CONFIG.draws[key] <= R6_LANDMARK_CONFIG.budgets[key],
    `${key} exceeds plan budget`,
  );
}
assert.equal(
  R6_LANDMARK_CONFIG.draws.dockPier,
  R6_LANDMARK_CONFIG.budgets.dockPier,
  "dock must remain one merged pier draw",
);
assert.equal(R6_LANDMARK_CONFIG.material.limestoneTileMeters, 5.2);
assert.ok(R6_LANDMARK_CONFIG.material.hueVariation >= 0.05 && R6_LANDMARK_CONFIG.material.hueVariation <= 0.10);
assert.ok(geometrySource.includes("mergeGeometries(geometries, false)"), "landmarks are not merged through BufferGeometryUtils");
assert.ok(geometrySource.includes('setAttribute("terrainAO"'), "merged geometry lacks baked cavity/grime data");
assert.ok(materialSource.includes("landmarkMode"), "landmarks do not share the terrain triplanar PBR path");
assert.ok(materialSource.includes("weights[3] = mix(0.86, 0.96, landmarkGrime)"), "landmark material is not limestone-led");
assert.ok(!voyageSource.includes("sunlit-stone"), "blanket pale stone override survived R6");
assert.ok(!voyageSource.includes('"tree-cypress"'), "retired cypress model is still loaded");
await assert.rejects(access(new URL("../assets/models/tree-cypress.glb", import.meta.url)), undefined, "retired cypress GLB still exists");
assert.ok(scatterSource.includes("heroTrees = []"), "Origins hero trees do not use the R5 impostor system");
assert.equal(R6_LANDMARK_CONFIG.heroTrees.total, 4);

// Static tour framing contract: a browserless Node process cannot import the
// CDN-mapped Three.js scene or obtain renderer.info. Runtime initialization also
// checks these exact architectural draws; this verifier guards the authored beat
// arrays and finite-count contracts without pretending to own a WebGL context.
for (const marker of [
  "island.beats = [b1, b2, b3]",
  "island.beats = [f1, f2, f3]",
  "island.beats = beats",
  "island.beats = [o1, o2]",
  "applyBeatFraming(island)",
  "finalizeBeats(island)",
  "const expectedTourBeats =",
  ".every(Number.isFinite)",
]) assert.ok(voyageSource.includes(marker), `tour/anchor marker missing: ${marker}`);
for (const marker of ["invalidateStaticShadows();", "renderFrame();", "freezeStaticShadowMap();"]) {
  assert.ok(voyageSource.includes(marker), `static shadow rerender marker missing: ${marker}`);
}
assert.ok(voyageSource.includes("const n = Math.min(5, Math.max(1, COPY.experienceCount))"), "Voyages no longer retains five docked beats");

console.log(JSON.stringify({
  censusApproach: "static config plus matching runtime initialization assertion (headless WebGL unavailable)",
  sourcePrimitives,
  opaqueDraws: R6_LANDMARK_CONFIG.draws,
  budgets: R6_LANDMARK_CONFIG.budgets,
  heroTrees: R6_LANDMARK_CONFIG.heroTrees,
  silhouettes: {
    templeTop: +templeTop.toFixed(2),
    lighthouseTop: +lighthouseTop.toFixed(2),
    hierarchy: "temple hero, lighthouse second",
  },
  tourBeats: R6_LANDMARK_CONFIG.tourBeats,
  oldCypress: "removed repo-wide",
  tourAnchors: "authored arrays and framing/finalization hooks present",
}, null, 2));
