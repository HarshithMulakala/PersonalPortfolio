import {
  generateTerrainField,
  TERRAIN_BOUNDS,
  TERRAIN_DOCKS,
  buildNavigableCoastalRoute,
  verifyDockNavigation,
} from "../js/terrain-field.mjs";

const field = generateTerrainField({ droplets: Number(process.env.TERRAIN_DROPLETS || 18000) });
const random = (() => {
  let state = 0xc0a57;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
})();

function sampleLikeGpu(array, x, z) {
  const u = (x - TERRAIN_BOUNDS.minX) / (TERRAIN_BOUNDS.maxX - TERRAIN_BOUNDS.minX);
  const v = (z - TERRAIN_BOUNDS.minZ) / (TERRAIN_BOUNDS.maxZ - TERRAIN_BOUNDS.minZ);
  const width = field.bounds.width, height = field.bounds.height;
  const gx = u * (width - 1), gz = v * (height - 1);
  const x0 = Math.max(0, Math.min(width - 1, Math.floor(gx)));
  const z0 = Math.max(0, Math.min(height - 1, Math.floor(gz)));
  const x1 = Math.max(0, Math.min(width - 1, x0 + 1));
  const z1 = Math.max(0, Math.min(height - 1, z0 + 1));
  const tx = Math.max(0, Math.min(1, gx - Math.floor(gx)));
  const tz = Math.max(0, Math.min(1, gz - Math.floor(gz)));
  const a = array[z0 * width + x0] + (array[z0 * width + x1] - array[z0 * width + x0]) * tx;
  const b = array[z1 * width + x0] + (array[z1 * width + x1] - array[z1 * width + x0]) * tx;
  return a + (b - a) * tz;
}

// Emulate the ocean's texture lookup: same normalized world-to-UV transform and
// bilinear control-grid interpolation, then compare it with the collision sampler.
let maxError = 0;
let coastSamples = 0;
for (let attempt = 0; attempt < 250000 && coastSamples < 2048; attempt++) {
  const x = TERRAIN_BOUNDS.minX + random() * (TERRAIN_BOUNDS.maxX - TERRAIN_BOUNDS.minX);
  const z = TERRAIN_BOUNDS.minZ + random() * (TERRAIN_BOUNDS.maxZ - TERRAIN_BOUNDS.minZ);
  const collisionSdf = field.sampleSdf(x, z);
  if (collisionSdf == null || Math.abs(collisionSdf) > 1.5) continue;
  const renderSdf = sampleLikeGpu(field.sdf, x, z);
  maxError = Math.max(maxError, Math.abs(renderSdf - collisionSdf));
  coastSamples++;
}

const controlTexel = Math.max(field.dx, field.dz);
if (coastSamples < 512) throw new Error(`Only found ${coastSamples} coast samples`);
if (!(maxError < controlTexel)) {
  throw new Error(`Coast mismatch ${maxError.toFixed(6)}u exceeds one control texel ${controlTexel.toFixed(6)}u`);
}

let deepestBed = Infinity;
let shallowToe = -Infinity;
let baySand = 0, baySamples = 0, headlandRock = 0, headlandSamples = 0;
const angleDistance = (a, b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
for (let iz = 0; iz < field.bounds.height; iz++) for (let ix = 0; ix < field.bounds.width; ix++) {
  const i = iz * field.bounds.width + ix;
  if (field.sdf[i] > 0) continue;
  deepestBed = Math.min(deepestBed, field.height[i]);
  if (field.sdf[i] > -1) shallowToe = Math.max(shallowToe, field.height[i]);
  if (field.bathymetry[i] > 6) continue;
  const x = field.bounds.minX + ix * field.dx;
  const z = field.bounds.minZ + iz * field.dz;
  const angle = Math.atan2((z - 34) / 59, x / 79);
  const o = i * 4;
  const remainder = Math.max(0, 1 - field.splat[o] - field.splat[o + 1] - field.splat[o + 2] - field.splat[o + 3]);
  if (angleDistance(angle, -2.12) < 0.28) {
    baySand += field.splat[o];
    baySamples++;
  }
  if (angleDistance(angle, Math.PI) < 0.55 || angleDistance(angle, 1.58) < 0.45) {
    headlandRock += field.splat[o + 3] + remainder;
    headlandSamples++;
  }
}
baySand /= Math.max(1, baySamples);
headlandRock /= Math.max(1, headlandSamples);
if (deepestBed > -10.45) throw new Error(`Underwater terrain skirt only reaches ${deepestBed.toFixed(3)}u`);
if (shallowToe > -0.24) throw new Error(`Underwater terrain overlaps nominal waterline by only ${(-shallowToe).toFixed(3)}u`);
if (baySand < 0.45) throw new Error(`Crescent-bay seabed sand weight too low: ${baySand.toFixed(3)}`);
if (headlandRock < 0.55) throw new Error(`Exposed-headland seabed rock weight too low: ${headlandRock.toFixed(3)}`);

const docks = verifyDockNavigation(field);
const blocked = docks.filter((dock) => !dock.navigable);
if (blocked.length) throw new Error(`Non-navigable docks: ${blocked.map((dock) => dock.id).join(", ")}`);

const routeSources = [{ id: "spawn", x: -77.1, z: -81.2 }, ...TERRAIN_DOCKS];
let routeCount = 0;
let routeMinClearance = Infinity;
for (const source of routeSources) for (const dock of TERRAIN_DOCKS) {
  if (source.id === dock.id) continue;
  const route = buildNavigableCoastalRoute(field, source.x, source.z, dock.x, dock.z, 7.4);
  let previous = { x: source.x, z: source.z };
  for (const point of route) {
    const steps = Math.max(1, Math.ceil(Math.hypot(point.x - previous.x, point.z - previous.z)));
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const sdf = field.sampleSdf(
        previous.x + (point.x - previous.x) * t,
        previous.z + (point.z - previous.z) * t,
      );
      if (sdf != null) {
        routeMinClearance = Math.min(routeMinClearance, -sdf);
        if (sdf > -6.5) throw new Error(`${source.id}->${dock.id} route crosses coast at SDF ${sdf.toFixed(3)}`);
      }
    }
    previous = point;
  }
  routeCount++;
}

console.log(JSON.stringify({
  generationMs: +field.generationMs.toFixed(2),
  droplets: field.droplets,
  grid: `${field.bounds.width}x${field.bounds.height}`,
  coastSamples,
  maxCoastError: +maxError.toFixed(8),
  controlTexel: +controlTexel.toFixed(6),
  routeCount,
  routeMinClearance: +routeMinClearance.toFixed(2),
  deepestBed: +deepestBed.toFixed(2),
  shallowToe: +shallowToe.toFixed(3),
  baySand: +baySand.toFixed(3),
  headlandRock: +headlandRock.toFixed(3),
  docks: docks.map((dock) => ({
    id: dock.id,
    clearance: +dock.clearance.toFixed(2),
    channelMinClearance: +dock.channelMinClearance.toFixed(2),
  })),
}, null, 2));
