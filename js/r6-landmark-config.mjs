// Round 6 landmark budgets and tour contracts. This file intentionally has no
// DOM or Three.js dependency so the repository can census the static scene
// architecture in Node without installing a headless WebGL stack.

const silhouettes = Object.freeze({
  templeTargetXZ: 18,
  templeTargetHeight: 10.5,
  templeHeightScale: 1,
  lighthouseTargetHeight: 15,
  cottageTargetHeight: 4.5,
});

// Imported-model scale is a release contract, not a camera-composition knob.
// These authored heights are evaluated as soon as either R6 verifier imports
// this module, while the live scene independently checks the resulting Box3.
const landmarkBounds = Object.freeze({
  originsCottage: Object.freeze({ height: silhouettes.cottageTargetHeight, minHeight: 3, maxHeight: 6 }),
  ruins: Object.freeze({ height: 5.2, minHeight: 3, maxHeight: 7 }),
  forge: Object.freeze({ height: 2.05, minHeight: 1.5, maxHeight: 4 }),
  temple: Object.freeze({
    height: silhouettes.templeTargetHeight,
    minHeight: 6,
    maxHeight: 16,
  }),
  dockPier: Object.freeze({ height: 1.5, minHeight: 0.25, maxHeight: 3 }),
  lighthouse: Object.freeze({ height: silhouettes.lighthouseTargetHeight, minHeight: 8, maxHeight: 18 }),
});

for (const [name, bounds] of Object.entries(landmarkBounds)) {
  if (!Number.isFinite(bounds.height) || bounds.height < bounds.minHeight || bounds.height > bounds.maxHeight) {
    throw new Error(
      `R6 landmark scale regression: ${name} height ${bounds.height.toFixed(2)}u is outside ` +
      `${bounds.minHeight}-${bounds.maxHeight}u`,
    );
  }
}

export const R6_LANDMARK_CONFIG = Object.freeze({
  material: Object.freeze({
    limestoneTileMeters: 5.2,
    hueVariation: 0.08,
    foundationSkirt: Object.freeze([0.15, 0.30]),
  }),
  draws: Object.freeze({
    // Opaque merged architecture only. Navigation flames, plaque/icon quads,
    // and the shared contact-darkening pass are intentionally reported apart.
    originsCottage: 2,
    temple: 1,
    lighthouse: 1,
    forge: 2,
    dockPier: 1,
    ruins: 1,
  }),
  budgets: Object.freeze({
    temple: 4,
    lighthouse: 6,
    ruins: 2,
    dockPier: 1,
  }),
  accents: Object.freeze({
    originsCottage: 1,
    temple: 1,
    lighthouse: 1,
    forge: 1,
    dockPier: 1,
    ruins: 0,
  }),
  heroTrees: Object.freeze({ cypress: 2, olive: 2, total: 4 }),
  silhouettes,
  landmarkBounds,
  materialAudit: Object.freeze({ rejectMissing: true, rejectThreeDefault: true }),
  spawnFraming: Object.freeze({ heroBlendRadius: 44, templeMinimumNdcMargin: 0.08 }),
  tourBeats: Object.freeze({ origins: 3, forge: 3, laborsMin: 1, voyages: 5, oracle: 2 }),
});
