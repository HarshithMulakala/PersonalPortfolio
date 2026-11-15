import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

const IDENTITY = new THREE.Matrix4();

// Normalize only after the source hierarchy has been baked into one mesh. A
// scale applied to the cloned GLTF scene root is cancelled by inverseRoot in
// mergeScenePrimitives(), which was the R6.6 double-transform regression.
// Measuring the merged geometry makes the factor deterministic for every GLB:
// target / actual, applied exactly once.
function normalizeMergedLandmark(mesh, target, mode) {
  const geometry = mesh.geometry;
  geometry.computeBoundingBox();
  const box = geometry.boundingBox;
  const size = new THREE.Vector3();
  box.getSize(size);
  const measured = mode === "height"
    ? size.y
    : mode === "xz"
      ? Math.max(size.x, size.z)
      : Math.max(size.x, size.y, size.z);
  const scale = Number.isFinite(measured) && measured > 0 ? target / measured : 1;
  geometry.scale(scale, scale, scale);
  geometry.computeBoundingBox();
  const normalizedBox = geometry.boundingBox;
  const center = new THREE.Vector3();
  normalizedBox.getCenter(center);
  geometry.translate(-center.x, -normalizedBox.min.y, -center.z);
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  mesh.userData.r6Normalization = { measured, mode, scale, target };
  return mesh;
}

function prepareGeometry(sourceGeometry, matrix, sourceIndex, sourceCount, hueVariation) {
  let geometry = sourceGeometry.index ? sourceGeometry.toNonIndexed() : sourceGeometry.clone();
  geometry.applyMatrix4(matrix || IDENTITY);
  if (!geometry.attributes.normal) geometry.computeVertexNormals();
  for (const key of Object.keys(geometry.attributes)) {
    if (key !== "position" && key !== "normal" && key !== "uv") geometry.deleteAttribute(key);
  }
  const position = geometry.attributes.position;
  const normal = geometry.attributes.normal;
  if (!geometry.attributes.uv) {
    geometry.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(position.count * 2), 2));
  }
  geometry.computeBoundingBox();
  const box = geometry.boundingBox;
  const spanY = Math.max(0.001, box.max.y - box.min.y);
  const colors = new Float32Array(position.count * 3);
  const cavity = new Float32Array(position.count);
  const sourceT = sourceCount > 1 ? sourceIndex / (sourceCount - 1) : 0.5;
  const sourceShift = (sourceT * 2 - 1) * hueVariation;
  for (let i = 0; i < position.count; i++) {
    const height = (position.getY(i) - box.min.y) / spanY;
    const upward = Math.max(0, normal.getY(i));
    const grime = 1 - (1 - height) * 0.12 - (1 - upward) * 0.035;
    colors[i * 3] = grime * (1 + sourceShift * 0.52);
    colors[i * 3 + 1] = grime * (1 + sourceShift * 0.12);
    colors[i * 3 + 2] = grime * (1 - sourceShift * 0.42);
    cavity[i] = Math.max(0.68, Math.min(0.98, 0.76 + height * 0.13 + upward * 0.07));
  }
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geometry.setAttribute("terrainAO", new THREE.BufferAttribute(cavity, 1));
  return geometry;
}

export function mergeScenePrimitives(root, material, name, options = {}) {
  root.updateMatrixWorld(true);
  const inverseRoot = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const meshes = [];
  root.traverse((object) => {
    if (object.isMesh && object.geometry && object.visible !== false) meshes.push(object);
  });
  if (!meshes.length) return null;
  const geometries = meshes.map((mesh, index) => {
    const localMatrix = new THREE.Matrix4().multiplyMatrices(inverseRoot, mesh.matrixWorld);
    return prepareGeometry(
      mesh.geometry,
      localMatrix,
      index,
      meshes.length,
      options.hueVariation == null ? 0.08 : options.hueVariation,
    );
  });
  const merged = mergeGeometries(geometries, false);
  for (const geometry of geometries) geometry.dispose();
  if (!merged) throw new Error(`Unable to merge Round 6 landmark geometry: ${name}`);
  merged.computeBoundingBox();
  merged.computeBoundingSphere();
  const mesh = new THREE.Mesh(merged, material);
  mesh.name = name;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.userData.r6MergedPrimitiveCount = meshes.length;
  return mesh;
}

export function mergeGlbLandmark(source, target, mode, material, name, options = {}) {
  const root = source.clone(true);
  const merged = mergeScenePrimitives(root, material, name, options);
  return normalizeMergedLandmark(merged, target, mode);
}

export function foundationGeometry(width, depth, height = 0.24, segments = 4) {
  if (segments > 4) return new THREE.CylinderGeometry(width * 0.5, width * 0.54, height, segments);
  return new THREE.BoxGeometry(width, height, depth);
}

// A wide landmark can cross a naturally graded pad even when its center is
// correct. Build a limestone foundation whose bottom follows the four sampled
// TerrainField corners and whose top remains level under the architecture.
export function terrainFoundationGeometry(width, depth, topY, samples, sink = 0.08) {
  if (!samples || samples.length < 5) throw new Error("terrain foundation requires center and four corners");
  const corners = [samples[1], samples[2], samples[3], samples[4]];
  const x = [-width * 0.5, width * 0.5, width * 0.5, -width * 0.5];
  const z = [-depth * 0.5, -depth * 0.5, depth * 0.5, depth * 0.5];
  const positions = [];
  for (let i = 0; i < 4; i++) positions.push(x[i], topY, z[i]);
  for (let i = 0; i < 4; i++) positions.push(x[i], corners[i].y - sink, z[i]);
  const indices = [
    0, 1, 2, 0, 2, 3,
    0, 4, 5, 0, 5, 1,
    1, 5, 6, 1, 6, 2,
    2, 6, 7, 2, 7, 3,
    3, 7, 4, 3, 4, 0,
    4, 7, 6, 4, 6, 5,
  ];
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}
