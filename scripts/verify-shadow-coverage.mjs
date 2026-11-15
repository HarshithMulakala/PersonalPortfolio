import { TERRAIN_BOUNDS } from "../js/terrain-field.mjs";
import {
  SHADOW_CONFIG,
  SUN_DIRECTION,
  SUN_ELEVATION_DEGREES,
  verifyShadowCoverage,
} from "../js/lighting-config.mjs";
import { QUALITY_PROFILES } from "../js/quality-config.mjs";

const result = verifyShadowCoverage(TERRAIN_BOUNDS);
if (!result.pass) {
  throw new Error(`Shadow camera does not cover TerrainField bounds: ${JSON.stringify(result)}`);
}
if (SHADOW_CONFIG.mapSizeByTier.high !== 4096) throw new Error("High-tier shadow map must be 4096");
if (SHADOW_CONFIG.mapSizeByTier.balanced !== 2048) throw new Error("Balanced shadow tier must be 2048");
if (SHADOW_CONFIG.mapSizeByTier.mobile !== 1024) throw new Error("Mobile shadow tier must be 1024");
if (QUALITY_PROFILES.high.pmremSize !== 256) throw new Error("High procedural-sky PMREM must be 256");
if (QUALITY_PROFILES.balanced.pmremSize !== 128) throw new Error("Balanced procedural-sky PMREM must be 128");
if (QUALITY_PROFILES.mobile.pmremSize !== 64) throw new Error("Mobile procedural-sky PMREM must be 64");
if (Math.abs(SUN_ELEVATION_DEGREES - 20) > 0.001) throw new Error("Sun elevation drifted from 20 degrees");

console.log(JSON.stringify({
  sunDirection: SUN_DIRECTION.map((value) => +value.toFixed(6)),
  shadowHalfExtent: SHADOW_CONFIG.halfExtent,
  mapSizes: SHADOW_CONFIG.mapSizeByTier,
  pmremCubeSizes: Object.fromEntries(Object.entries(QUALITY_PROFILES).map(([tier, profile]) => [tier, profile.pmremSize])),
  maxAbsX: +result.maxAbsX.toFixed(3),
  maxAbsY: +result.maxAbsY.toFixed(3),
  minDepth: +result.minDepth.toFixed(3),
  maxDepth: +result.maxDepth.toFixed(3),
}, null, 2));
