// Round 5 vegetation and rock budgets. This module deliberately has no DOM or
// Three.js dependency so the repository's static verification can import it.

import { QUALITY_PROFILES } from "./quality-config.mjs";

export const R5_SCATTER_CONFIG = Object.freeze({
  seed: 0x725f2026,
  atlas: Object.freeze({
    grid: 4,
    framesPerType: 4,
    alphaTest: Object.freeze({
      cypress: 0.44,
      olive: 0.44,
      scrub: 0.43,
      grass: 0.42,
    }),
    frames: Object.freeze({
      cypress: Object.freeze([0, 1, 2, 3]),
      olive: Object.freeze([4, 5, 6, 7]),
      scrub: Object.freeze([8, 9, 10, 11]),
      grass: Object.freeze([12, 13, 14, 15]),
    }),
  }),
  tiers: Object.freeze({
    high: Object.freeze({
      atlasSize: QUALITY_PROFILES.high.vegetationAtlasSize,
      counts: QUALITY_PROFILES.high.vegetationCounts,
      vegetationDraws: Object.freeze({ cypress: 1, olive: 1, scrub: 2, grass: 2 }),
    }),
    balanced: Object.freeze({
      atlasSize: QUALITY_PROFILES.balanced.vegetationAtlasSize,
      counts: QUALITY_PROFILES.balanced.vegetationCounts,
      vegetationDraws: Object.freeze({ cypress: 1, olive: 1, scrub: 2, grass: 2 }),
    }),
    mobile: Object.freeze({
      atlasSize: QUALITY_PROFILES.mobile.vegetationAtlasSize,
      counts: QUALITY_PROFILES.mobile.vegetationCounts,
      vegetationDraws: Object.freeze({ cypress: 1, olive: 1, scrub: 2, grass: 2 }),
    }),
  }),
  rocks: Object.freeze({
    // Icosahedron detail d has 20 * (d + 1)^2 triangles in Three.js.
    details: Object.freeze([4, 5, 5, 6, 6, 7, 7]),
    scale: Object.freeze([0.45, 2.4]),
    buried: Object.freeze([0.18, 0.38]),
    normalAlignment: Object.freeze([0.35, 0.55]),
  }),
  placement: Object.freeze({
    maxTreeSlopeDegrees: 28,
    maxScrubSlopeDegrees: 35,
    clearances: Object.freeze({ dock: 8, pad: 6, beat: 5, sightline: 4.5, spawnTemple: 7 }),
    poissonRadius: Object.freeze({ cypress: 5.0, olive: 2.25, scrub: 1.35, grass: 0.62, rocks: 1.75 }),
    oliveClusterSize: Object.freeze([3, 9]),
  }),
  draws: Object.freeze({
    vegetation: 6,
    rocks: 7,
    contacts: 1,
    addedColorTotal: 14,
  }),
  limits: Object.freeze({
    vegetationDraws: 9,
    rockDraws: 8,
    addedColorDraws: 18,
    totalSceneColorDraws: 90,
    rockTriangles: Object.freeze([500, 1500]),
  }),
});

export function r5Tier(quality) {
  return R5_SCATTER_CONFIG.tiers[quality] || R5_SCATTER_CONFIG.tiers.balanced;
}

export function r5TriangleCount(detail) {
  return 20 * (detail + 1) * (detail + 1);
}
