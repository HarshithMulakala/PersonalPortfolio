// Deterministic Round 6 landmark seating. This module deliberately has no DOM
// or Three.js dependency: the live scene and Node verification use the same
// full-footprint samples from TerrainField.

const SAMPLE_UV = Object.freeze([
  Object.freeze([0, 0]),
  Object.freeze([-0.5, -0.5]),
  Object.freeze([0.5, -0.5]),
  Object.freeze([0.5, 0.5]),
  Object.freeze([-0.5, 0.5]),
  Object.freeze([0, -0.5]),
  Object.freeze([0.5, 0]),
  Object.freeze([0, 0.5]),
  Object.freeze([-0.5, 0]),
]);

function prop(id, lx, lz, width, depth, options = {}) {
  return Object.freeze({
    id, lx, lz, width, depth,
    rotation: options.rotation || 0,
    sink: options.sink == null ? 0.03 : options.sink,
    tolerance: options.tolerance == null ? 0.18 : options.tolerance,
  });
}

// Local offsets are relative to the five TerrainField pads. Origins was moved
// back onto the authored pad core; its previous cottage/amphora positions were
// on the steep shoulder beyond the stamp.
export const R6_LANDMARK_GROUNDING = Object.freeze({
  origins: Object.freeze({
    ruins: prop("origins.ruins", -1.0, -2.0, 5.3, 1.4, { rotation: 3.01069, tolerance: 0.16 }),
    cottage: prop("origins.cottage", 2.0, 1.0, 5.3, 4.5, { rotation: -2.49364, tolerance: 0.34 }),
    amphorae: Object.freeze([
      prop("origins.amphora.1", -3.5, 0.0, 0.72, 0.72, { sink: 0.05, tolerance: 0.05 }),
      prop("origins.amphora.2", -3.0, 0.65, 0.64, 0.64, { sink: 0.05, tolerance: 0.05 }),
    ]),
    tablet: prop("origins.tablet", 0.0, 4.0, 2.1, 2.1, { tolerance: 0.14 }),
  }),
  forge: Object.freeze({
    anvil: prop("forge.anvil", -2.2, 1.0, 2.25, 1.7, { sink: 0.20, tolerance: 0.16 }),
    brazier: prop("forge.brazier", 1.6, -0.6, 1.15, 1.15, { sink: 0.05, tolerance: 0.10 }),
    amphorae: Object.freeze([
      prop("forge.amphora.1", 2.43, 3.79, 0.72, 0.72, { tolerance: 0.08 }),
      prop("forge.amphora.2", -4.50, 0.19, 0.72, 0.72, { tolerance: 0.08 }),
      prop("forge.amphora.3", 2.11, -3.97, 0.72, 0.72, { tolerance: 0.08 }),
    ]),
  }),
  labors: Object.freeze({
    // The imported temple is wider than the stamped terrace. Its textured,
    // terrain-conforming foundation consumes this complete footprint.
    temple: prop("labors.temple", 0, 0, 18.0, 14.54, { rotation: 2.975, sink: 0.08, tolerance: 1.5 }),
  }),
  voyages: Object.freeze({
    crates: Object.freeze([
      prop("voyages.crate.1", -2.4, -1.8, 1.3, 1.3, { tolerance: 0.12 }),
      prop("voyages.crate.2", -0.8, 1.6, 1.3, 1.3, { tolerance: 0.12 }),
      prop("voyages.crate.3", 1.2, -1.4, 1.3, 1.3, { tolerance: 0.12 }),
      prop("voyages.crate.4", 2.6, 1.8, 1.3, 1.3, { tolerance: 0.12 }),
    ]),
  }),
  oracle: Object.freeze({
    lighthouse: prop("oracle.lighthouse", 0, 0, 5.6, 5.6, { sink: 0.08, tolerance: 0.36 }),
    brazier: prop("oracle.brazier", -5.5, -2.5, 1.25, 1.25, { sink: 0.05, tolerance: 0.10 }),
  }),
});

export function landmarkFootprintSamples(field, pad, spec) {
  const cos = Math.cos(spec.rotation || 0);
  const sin = Math.sin(spec.rotation || 0);
  return SAMPLE_UV.map(([u, v], index) => {
    const px = u * spec.width;
    const pz = v * spec.depth;
    const x = pad.x + spec.lx + px * cos + pz * sin;
    const z = pad.z + spec.lz - px * sin + pz * cos;
    const y = field.sampleHeight(x, z);
    return { index, x, y, z };
  });
}

// Seat point props at the highest footprint sample, with a tiny authored sink.
// No corner can intersect at a knife angle, and the remaining corner clearance
// is bounded by the statically verified footprint span.
export function footprintY(field, pad, spec) {
  const samples = landmarkFootprintSamples(field, pad, spec);
  if (samples.some((sample) => sample.y == null || !Number.isFinite(sample.y))) {
    throw new Error(`TerrainField has no complete footprint for ${spec.id}`);
  }
  const heights = samples.map((sample) => sample.y);
  const min = Math.min(...heights);
  const max = Math.max(...heights);
  return {
    y: max - spec.sink,
    min,
    max,
    span: max - min,
    samples,
  };
}

export function laborsSteleGrounding(index, count, radius, outwardX, outwardZ) {
  const n = Math.max(1, count);
  const t = n > 1 ? index / (n - 1) : 0.5;
  const midA = Math.atan2(outwardZ, outwardX);
  const angle = midA - 2.5 + t * 5.0;
  const lx = Math.cos(angle) * radius;
  const lz = Math.sin(angle) * radius;
  return prop(`labors.stele.${index + 1}`, lx, lz, 1.9, 1.5, {
    rotation: Math.atan2(lx, lz),
    sink: 0.06,
    tolerance: 0.14,
  });
}

export function flattenLandmarkGrounding(projectCount = 10, laborsRadius = 9.5, laborsOutward = [-13, 65]) {
  const g = R6_LANDMARK_GROUNDING;
  const entries = [
    ...Object.values(g.origins).flat(),
    ...Object.values(g.forge).flat(),
    g.labors.temple,
    ...g.voyages.crates,
    ...Object.values(g.oracle),
  ];
  for (let i = 0; i < projectCount; i++) {
    entries.push(laborsSteleGrounding(i, projectCount, laborsRadius, laborsOutward[0], laborsOutward[1]));
  }
  return entries;
}
