// R4 physical-lighting constants. This module stays dependency-free so the
// shadow-frustum contract can be checked in Node without importing Three.js.

import { QUALITY_PROFILES } from "./quality-config.mjs";

export const SUN_ELEVATION_DEGREES = 20;
export const SUN_AZIMUTH_XZ = Object.freeze([0.36, 0.92]);

const elevation = SUN_ELEVATION_DEGREES * Math.PI / 180;
const azimuthLength = Math.hypot(...SUN_AZIMUTH_XZ);
const horizontal = Math.cos(elevation);

export const SUN_DIRECTION = Object.freeze([
  SUN_AZIMUTH_XZ[0] / azimuthLength * horizontal,
  Math.sin(elevation),
  SUN_AZIMUTH_XZ[1] / azimuthLength * horizontal,
]);

export const PHYSICAL_LIGHTING = Object.freeze({
  sunColor: 0xffdfbd,
  sunIntensity: 3.2,
  hemisphereSkyColor: 0xaec8d8,
  hemisphereGroundColor: 0x786f58,
  hemisphereIntensity: 0.42,
  fogDensity: 0.0041,
  exposure: 0.94,
  bloom: Object.freeze({ strength: 0.14, radius: 0.3, threshold: 1.08 }),
});

export const SHADOW_CONFIG = Object.freeze({
  halfExtent: 120,
  center: Object.freeze([0, 12, 34]),
  lightDistance: 320,
  near: 160,
  far: 480,
  bias: -0.00025,
  normalBias: 0.042,
  mapSizeByTier: Object.freeze(Object.fromEntries(
    Object.entries(QUALITY_PROFILES).map(([tier, profile]) => [tier, profile.shadowMapSize]),
  )),
});

export const ENV_MAP_INTENSITY = Object.freeze({
  terrain: 0.36,
  stone: 0.54,
  wood: 0.66,
  foliage: 0.42,
  metal: 0.58,
  default: 0.5,
  wetTerrain: 0.84,
  ship: 0.66,
});

function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function normalize(v) {
  const length = Math.hypot(...v) || 1;
  return v.map((value) => value / length);
}

export function shadowCameraBasis() {
  const forward = SUN_DIRECTION.map((value) => -value);
  const right = normalize(cross(forward, [0, 1, 0]));
  const up = normalize(cross(right, forward));
  return { forward, right, up };
}

// Verify all eight TerrainField world-bounds corners in the same orthographic
// basis used by the directional-light shadow camera.
export function verifyShadowCoverage(bounds, heightRange = [-10.5, 42]) {
  const { forward, right, up } = shadowCameraBasis();
  const center = SHADOW_CONFIG.center;
  const cameraPosition = center.map((value, index) =>
    value + SUN_DIRECTION[index] * SHADOW_CONFIG.lightDistance
  );
  let maxAbsX = 0;
  let maxAbsY = 0;
  let minDepth = Infinity;
  let maxDepth = -Infinity;

  for (const x of [bounds.minX, bounds.maxX]) {
    for (const y of heightRange) {
      for (const z of [bounds.minZ, bounds.maxZ]) {
        const fromCenter = [x - center[0], y - center[1], z - center[2]];
        const fromCamera = [x - cameraPosition[0], y - cameraPosition[1], z - cameraPosition[2]];
        maxAbsX = Math.max(maxAbsX, Math.abs(dot(fromCenter, right)));
        maxAbsY = Math.max(maxAbsY, Math.abs(dot(fromCenter, up)));
        const depth = dot(fromCamera, forward);
        minDepth = Math.min(minDepth, depth);
        maxDepth = Math.max(maxDepth, depth);
      }
    }
  }

  const pass = maxAbsX <= SHADOW_CONFIG.halfExtent
    && maxAbsY <= SHADOW_CONFIG.halfExtent
    && minDepth >= SHADOW_CONFIG.near
    && maxDepth <= SHADOW_CONFIG.far;
  return { pass, maxAbsX, maxAbsY, minDepth, maxDepth };
}
