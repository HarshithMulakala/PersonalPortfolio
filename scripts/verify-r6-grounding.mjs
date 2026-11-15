import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { generateTerrainField, TERRAIN_DOCKS, TERRAIN_PADS } from "../js/terrain-field.mjs";
import { R6_LANDMARK_CONFIG } from "../js/r6-landmark-config.mjs";
import {
  R6_LANDMARK_GROUNDING,
  flattenLandmarkGrounding,
  footprintY,
} from "../js/r6-landmark-grounding.mjs";

const field = generateTerrainField({ droplets: Number(process.env.TERRAIN_DROPLETS || 18000) });
const pads = new Map(TERRAIN_PADS.map((pad) => [pad.id, pad]));
const specs = flattenLandmarkGrounding();
const results = [];
const regionCounts = new Map();

for (const spec of specs) {
  const region = spec.id.split(".")[0];
  const pad = pads.get(region);
  assert.ok(pad, `unknown landmark region for ${spec.id}`);
  const contact = footprintY(field, pad, spec);
  assert.ok(contact.span <= spec.tolerance + 1e-6, `${spec.id} footprint span ${contact.span} exceeds ${spec.tolerance}`);
  assert.equal(contact.samples.length, 9, `${spec.id} must sample center, four corners, and four edge midpoints`);
  assert.ok(contact.samples.every((sample) => field.sampleSdf(sample.x, sample.z) > 0), `${spec.id} footprint crosses the coast`);
  const clearances = contact.samples.map((sample) => contact.y - sample.y);
  assert.ok(Math.max(...clearances) <= spec.tolerance, `${spec.id} has a floating footprint corner`);
  assert.ok(Math.min(...clearances) >= -spec.sink - 1e-6, `${spec.id} intersects terrain beyond its authored sink`);
  regionCounts.set(region, (regionCounts.get(region) || 0) + 1);
  results.push({
    id: spec.id,
    seatY: +contact.y.toFixed(3),
    minY: +contact.min.toFixed(3),
    maxY: +contact.max.toFixed(3),
    span: +contact.span.toFixed(3),
    tolerance: spec.tolerance,
  });
}

assert.deepEqual([...regionCounts.keys()].sort(), ["forge", "labors", "oracle", "origins", "voyages"]);

const cottageSpec = R6_LANDMARK_GROUNDING.origins.cottage;
const oldCottageContact = footprintY(field, pads.get("origins"), {
  id: "origins.cottage.old",
  lx: 14 * 0.46,
  lz: 14 * 0.3,
  width: 5.3,
  depth: 4.5,
  rotation: Math.atan2(14 * 0.46, 14 * 0.3),
  sink: 0.03,
});
const cottageContact = footprintY(field, pads.get("origins"), cottageSpec);
assert.ok(cottageContact.span < 0.35, "Origins cottage did not return to the graded pad core");
assert.ok(oldCottageContact.span > cottageContact.span * 10, "Origins cottage still sits on the steep inland shoulder");

const [voyageSource, geometrySource] = await Promise.all([
  readFile(new URL("../js/voyage.js", import.meta.url), "utf8"),
  readFile(new URL("../js/r6-landmark-geometry.mjs", import.meta.url), "utf8"),
]);
for (const marker of [
  "makeBeatInland(island, homeAnchor",
  'framing: "sea-to-inland"',
  "makeBeatOutward(island, anvilA",
  "makeBeatOutward(island, anchor",
  "const beat = {",
  "makeBeatOutward(island, ruins",
]) assert.ok(voyageSource.includes(marker), `five-region camera framing marker missing: ${marker}`);
assert.ok(voyageSource.includes("auditR6Materials(island)"), "R6 material audit is not run");
assert.ok(voyageSource.includes("material.isMaterial"), "R6 material audit does not reject missing material assignments");
assert.ok(geometrySource.includes("terrainFoundationGeometry"), "wide landmark foundations do not conform to TerrainField samples");
assert.ok(voyageSource.includes("new THREE.BoxGeometry(0.92, 1.72, 0.12)"), "recessed wooden cottage door is missing");
assert.ok(voyageSource.includes("new THREE.PlaneGeometry(0.38, 0.30)"), "small cottage door window is missing");
assert.ok(!voyageSource.includes("new THREE.PlaneGeometry(1.05, 1.65)"), "full-door emissive rectangle survived the hotfix");

// Spawn chase camera projection: the temple crown must land comfortably inside
// a 1440x900 frame while the vegetation exclusion cone remains spawn->Labors.
const heading = Math.atan2(43, 76);
const spawn = { x: -47 - 43 * 0.7, y: 8.5, z: -28 - 76 * 0.7 };
const camera = {
  x: spawn.x - 14 * Math.sin(heading) + 5.6 * Math.cos(heading),
  y: spawn.y,
  z: spawn.z - 14 * Math.cos(heading) - 5.6 * Math.sin(heading),
};
const templeContact = footprintY(field, pads.get("labors"), R6_LANDMARK_GROUNDING.labors.temple);
const templeHeight = R6_LANDMARK_CONFIG.silhouettes.templeTargetXZ * 0.45 / 0.78
  * R6_LANDMARK_CONFIG.silhouettes.templeHeightScale;
const crown = { x: -4, y: templeContact.max + 0.04 + templeHeight, z: 48 };
const look = { x: -4, y: 18, z: 48 };
const normalize = (v) => {
  const length = Math.hypot(v.x, v.y, v.z) || 1;
  return { x: v.x / length, y: v.y / length, z: v.z / length };
};
const cross = (a, b) => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
const forward = normalize({ x: look.x - camera.x, y: look.y - camera.y, z: look.z - camera.z });
const right = normalize(cross(forward, { x: 0, y: 1, z: 0 }));
const up = cross(right, forward);
const rel = { x: crown.x - camera.x, y: crown.y - camera.y, z: crown.z - camera.z };
const depth = dot(rel, forward);
const tanHalfFov = Math.tan(55 * Math.PI / 360);
const templeNdc = {
  x: dot(rel, right) / (depth * tanHalfFov * (1440 / 900)),
  y: dot(rel, up) / (depth * tanHalfFov),
};
const margin = R6_LANDMARK_CONFIG.spawnFraming.templeMinimumNdcMargin;
assert.ok(depth > 0 && Math.abs(templeNdc.x) < 1 - margin && Math.abs(templeNdc.y) < 1 - margin, "temple crown is not readable in spawn framing");
assert.ok(voyageSource.includes("setSpawnAwareChaseLook"), "spawn camera does not preserve the temple sightline");
assert.ok(voyageSource.includes("temple: TERRAIN_PAD_BY_ID.get(\"labors\")"), "R5 spawn-to-temple vegetation exclusion cone was removed");

const docks = new Map(TERRAIN_DOCKS.map((dock) => [dock.id, dock]));
const outward = (id) => {
  const dock = docks.get(id);
  const length = Math.hypot(dock.x, dock.z - 34) || 1;
  return { x: dock.x / length, z: (dock.z - 34) / length };
};
const representativeFrames = [
  { id: "origins", x: pads.get("origins").x + cottageSpec.lx, z: pads.get("origins").z + cottageSpec.lz, cameraOut: outward("origins"), backdropDistance: 10 },
  { id: "forge", x: pads.get("forge").x + R6_LANDMARK_GROUNDING.forge.anvil.lx, z: pads.get("forge").z + R6_LANDMARK_GROUNDING.forge.anvil.lz, cameraOut: normalize({ x: R6_LANDMARK_GROUNDING.forge.anvil.lx, y: 0, z: R6_LANDMARK_GROUNDING.forge.anvil.lz }), backdropDistance: 10 },
  { id: "labors", x: pads.get("labors").x, z: pads.get("labors").z, cameraOut: outward("labors"), backdropDistance: 18 },
  { id: "voyages", x: pads.get("voyages").x + outward("voyages").x * 29.5, z: pads.get("voyages").z + outward("voyages").z * 29.5, cameraOut: outward("voyages"), backdropDistance: 35 },
  { id: "oracle", x: pads.get("oracle").x, z: pads.get("oracle").z, cameraOut: outward("oracle"), backdropDistance: 10 },
];
const cameraFrames = representativeFrames.map((frame) => {
  const anchorSdf = field.sampleSdf(frame.x, frame.z);
  const backdropSdf = field.sampleSdf(
    frame.x - frame.cameraOut.x * frame.backdropDistance,
    frame.z - frame.cameraOut.z * frame.backdropDistance,
  );
  assert.ok(backdropSdf > 2, `${frame.id} beat camera reveals water/pad edge behind its landmark`);
  return { id: frame.id, anchorSdf: +anchorSdf.toFixed(2), backdropSdf: +backdropSdf.toFixed(2) };
});

console.log(JSON.stringify({
  regions: Object.fromEntries(regionCounts),
  props: results,
  originsCottage: {
    oldShoulderSpan: +oldCottageContact.span.toFixed(3),
    newMinY: +cottageContact.min.toFixed(3),
    newMaxY: +cottageContact.max.toFixed(3),
    fullFootprintSpan: +cottageContact.span.toFixed(3),
  },
  spawnTemple: {
    crownY: +crown.y.toFixed(2),
    ndcX: +templeNdc.x.toFixed(3),
    ndcY: +templeNdc.y.toFixed(3),
  },
  cameraFrames,
  cameraPolicies: "Origins sea-to-inland; Forge/Labors/Voyages/Oracle terrain-backdropped",
  materialAudit: "runtime rejects every R6 mesh without an authored material",
}, null, 2));
