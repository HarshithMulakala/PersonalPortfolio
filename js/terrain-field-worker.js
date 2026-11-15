import { generateTerrainField, terrainFieldTransferables } from "./terrain-field.mjs";

self.onmessage = (event) => {
  const field = generateTerrainField(event.data || {});
  const payload = { ...field };
  delete payload.sampleHeight;
  delete payload.sampleSdf;
  delete payload.sampleSlope;
  delete payload.sampleCurvature;
  delete payload.sampleAO;
  delete payload.sampleSurface;
  delete payload.worldToUv;
  self.postMessage(payload, terrainFieldTransferables(field));
};
