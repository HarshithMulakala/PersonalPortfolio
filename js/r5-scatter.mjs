import * as THREE from "three";
import { R5_SCATTER_CONFIG, r5Tier } from "./r5-scatter-config.mjs";
import { QUALITY_PROFILES } from "./quality-config.mjs";

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;
const UP = new THREE.Vector3(0, 1, 0);

function clamp(value, low, high) {
  return Math.max(low, Math.min(high, value));
}

function smoothstep(low, high, value) {
  const t = clamp((value - low) / (high - low || 1), 0, 1);
  return t * t * (3 - 2 * t);
}

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function createCanvas(size) {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(size, size);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  return canvas;
}

function frameContext(ctx, frame, grid, cell, painter) {
  const column = frame % grid;
  const row = Math.floor(frame / grid);
  ctx.save();
  ctx.beginPath();
  ctx.rect(column * cell, row * cell, cell, cell);
  ctx.clip();
  ctx.translate(column * cell, row * cell);
  ctx.scale(cell, cell);
  painter(ctx);
  ctx.restore();
}

function stroke(ctx, color, width, x1, y1, x2, y2, bend = 0) {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.quadraticCurveTo((x1 + x2) * 0.5 + bend, (y1 + y2) * 0.5, x2, y2);
  ctx.stroke();
}

function paintCypress(ctx, rng, frame) {
  const lean = (rng() - 0.5) * 0.045;
  // Low-alpha edge underpainting gives the alpha-test mip chain foliage-colored
  // texels instead of black ones, preventing dark billboard halos.
  ctx.fillStyle = `rgba(49,63,36,${0.08 + frame * 0.008})`;
  ctx.beginPath();
  ctx.moveTo(0.5 + lean, 0.055);
  ctx.bezierCurveTo(0.35, 0.25, 0.29, 0.75, 0.43, 0.93);
  ctx.lineTo(0.57, 0.93);
  ctx.bezierCurveTo(0.7, 0.72, 0.66, 0.24, 0.5 + lean, 0.055);
  ctx.fill();

  stroke(ctx, "rgba(78,62,40,0.96)", 0.021, 0.5, 0.94, 0.5 + lean, 0.2, lean * 0.5);
  stroke(ctx, "rgba(122,99,61,0.72)", 0.006, 0.495, 0.93, 0.505 + lean, 0.26, 0);
  for (let i = 0; i < 126; i++) {
    const t = (i + rng() * 0.8) / 126;
    const y = 0.9 - t * 0.79;
    const envelope = Math.pow(Math.sin(Math.PI * Math.pow(t, 0.76)), 0.72);
    const half = (0.035 + envelope * 0.18) * (0.82 + rng() * 0.32);
    const side = rng() < 0.5 ? -1 : 1;
    const x = 0.5 + lean * (1 - t) + side * half * (0.35 + rng() * 0.65);
    const length = 0.035 + rng() * 0.075;
    const hue = 73 + Math.floor(rng() * 16);
    const light = 22 + Math.floor(rng() * 14);
    stroke(ctx, `hsla(${hue},31%,${light}%,${0.56 + rng() * 0.38})`, 0.008 + rng() * 0.012, 0.5 + lean * (1 - t), y, x, y - length, side * 0.012);
  }
  for (let i = 0; i < 22; i++) {
    const y = 0.18 + rng() * 0.67;
    const width = (0.1 + Math.sin((y - 0.12) * Math.PI) * 0.1) * (0.55 + rng() * 0.45);
    ctx.fillStyle = `hsla(${76 + rng() * 12},34%,${24 + rng() * 9}%,${0.55 + rng() * 0.3})`;
    ctx.beginPath();
    ctx.ellipse(0.5 + (rng() - 0.5) * width, y, width * 0.38, 0.035 + rng() * 0.04, (rng() - 0.5) * 0.6, 0, TAU);
    ctx.fill();
  }
}

function paintOlive(ctx, rng, frame) {
  const trunkX = 0.49 + (rng() - 0.5) * 0.035;
  ctx.fillStyle = "rgba(91,74,50,0.08)";
  ctx.beginPath();
  ctx.ellipse(0.5, 0.45, 0.42, 0.29, (frame - 1.5) * 0.04, 0, TAU);
  ctx.fill();
  stroke(ctx, "rgba(93,73,45,0.98)", 0.042, trunkX, 0.95, trunkX + 0.018, 0.54, -0.018);
  stroke(ctx, "rgba(146,118,73,0.7)", 0.009, trunkX - 0.008, 0.94, trunkX + 0.025, 0.56, 0.008);
  const branchTips = [];
  for (let i = 0; i < 9; i++) {
    const angle = -2.72 + i * 0.68 + (rng() - 0.5) * 0.28;
    const length = 0.16 + rng() * 0.16;
    const bx = trunkX + Math.cos(angle) * length;
    const by = 0.61 + Math.sin(angle) * length * 0.72 - rng() * 0.12;
    stroke(ctx, "rgba(82,66,43,0.88)", 0.015 - i * 0.0004, trunkX, 0.64, bx, by, (rng() - 0.5) * 0.06);
    branchTips.push([bx, by]);
  }
  for (let lobe = 0; lobe < 17; lobe++) {
    const source = branchTips[lobe % branchTips.length];
    const cx = clamp(source[0] + (rng() - 0.5) * 0.24, 0.12, 0.88);
    const cy = clamp(source[1] + (rng() - 0.5) * 0.18, 0.14, 0.67);
    const rx = 0.09 + rng() * 0.105;
    const ry = 0.055 + rng() * 0.075;
    ctx.fillStyle = `hsla(${72 + rng() * 23},${20 + rng() * 18}%,${29 + rng() * 15}%,${0.54 + rng() * 0.28})`;
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, (rng() - 0.5) * 0.9, 0, TAU);
    ctx.fill();
    for (let leaf = 0; leaf < 8; leaf++) {
      const a = rng() * TAU;
      const px = cx + Math.cos(a) * rx * rng();
      const py = cy + Math.sin(a) * ry * rng();
      stroke(ctx, `hsla(${80 + rng() * 18},25%,${36 + rng() * 16}%,${0.5 + rng() * 0.38})`, 0.008 + rng() * 0.007, px - 0.014, py + 0.008, px + 0.014, py - 0.008, 0.004);
    }
  }
}

function paintScrub(ctx, rng) {
  ctx.fillStyle = "rgba(77,75,42,0.07)";
  ctx.beginPath();
  ctx.ellipse(0.5, 0.7, 0.43, 0.23, 0, 0, TAU);
  ctx.fill();
  for (let i = 0; i < 88; i++) {
    const rootX = 0.28 + rng() * 0.44;
    const rootY = 0.94 - rng() * 0.05;
    const tipX = clamp(rootX + (rng() - 0.5) * 0.38, 0.08, 0.92);
    const tipY = 0.35 + rng() * 0.42;
    stroke(ctx, `hsla(${62 + rng() * 30},${22 + rng() * 22}%,${25 + rng() * 17}%,${0.58 + rng() * 0.34})`, 0.007 + rng() * 0.014, rootX, rootY, tipX, tipY, (rng() - 0.5) * 0.08);
    if (i % 3 === 0) {
      ctx.fillStyle = `hsla(${70 + rng() * 26},35%,${30 + rng() * 15}%,${0.62 + rng() * 0.3})`;
      ctx.beginPath();
      ctx.ellipse(tipX, tipY, 0.018 + rng() * 0.024, 0.009 + rng() * 0.014, rng() * TAU, 0, TAU);
      ctx.fill();
    }
  }
}

function paintGrass(ctx, rng, frame) {
  ctx.fillStyle = "rgba(145,118,55,0.055)";
  ctx.beginPath();
  ctx.ellipse(0.5, 0.92, 0.42, 0.07, 0, 0, TAU);
  ctx.fill();
  for (let i = 0; i < 66; i++) {
    const rootX = 0.23 + rng() * 0.54;
    const rootY = 0.96;
    const height = 0.2 + rng() * (0.44 + frame * 0.015);
    const bend = (rng() - 0.5) * 0.22;
    const tipX = clamp(rootX + bend, 0.08, 0.92);
    const tipY = rootY - height;
    stroke(ctx, `hsla(${42 + rng() * 24},${35 + rng() * 24}%,${34 + rng() * 22}%,${0.62 + rng() * 0.34})`, 0.006 + rng() * 0.009, rootX, rootY, tipX, tipY, bend * 0.45);
  }
}

function deriveNormalAtlas(colorCanvas, size) {
  const source = colorCanvas.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, size, size);
  const normalCanvas = createCanvas(size);
  const normalCtx = normalCanvas.getContext("2d");
  const normal = normalCtx.createImageData(size, size);
  const alpha = source.data;
  const stride = size * 4;
  for (let y = 0; y < size; y++) {
    const ym = Math.max(0, y - 1), yp = Math.min(size - 1, y + 1);
    for (let x = 0; x < size; x++) {
      const xm = Math.max(0, x - 1), xp = Math.min(size - 1, x + 1);
      const i = (y * size + x) * 4;
      const tl = alpha[ym * stride + xm * 4 + 3] / 255;
      const tc = alpha[ym * stride + x * 4 + 3] / 255;
      const tr = alpha[ym * stride + xp * 4 + 3] / 255;
      const ml = alpha[y * stride + xm * 4 + 3] / 255;
      const mr = alpha[y * stride + xp * 4 + 3] / 255;
      const bl = alpha[yp * stride + xm * 4 + 3] / 255;
      const bc = alpha[yp * stride + x * 4 + 3] / 255;
      const br = alpha[yp * stride + xp * 4 + 3] / 255;
      const dx = (tr + mr * 2 + br) - (tl + ml * 2 + bl);
      const dy = (bl + bc * 2 + br) - (tl + tc * 2 + tr);
      const nx = -dx * 0.72, ny = dy * 0.72, nz = 1;
      const inverse = 1 / Math.hypot(nx, ny, nz);
      normal.data[i] = (nx * inverse * 0.5 + 0.5) * 255;
      normal.data[i + 1] = (ny * inverse * 0.5 + 0.5) * 255;
      normal.data[i + 2] = (nz * inverse * 0.5 + 0.5) * 255;
      normal.data[i + 3] = 255;
    }
  }
  normalCtx.putImageData(normal, 0, 0);
  return normalCanvas;
}

function bakeVegetationAtlas(size, renderer) {
  const grid = R5_SCATTER_CONFIG.atlas.grid;
  const cell = size / grid;
  const colorCanvas = createCanvas(size);
  const ctx = colorCanvas.getContext("2d", { alpha: true, willReadFrequently: true });
  ctx.clearRect(0, 0, size, size);
  const painters = [paintCypress, paintOlive, paintScrub, paintGrass];
  painters.forEach((painter, type) => {
    for (let frame = 0; frame < 4; frame++) {
      const rng = mulberry32(R5_SCATTER_CONFIG.seed + type * 0x9e3779b9 + frame * 0x85ebca6b);
      frameContext(ctx, type * 4 + frame, grid, cell, (frameCtx) => painter(frameCtx, rng, frame));
    }
  });
  const normalCanvas = deriveNormalAtlas(colorCanvas, size);
  const anisotropy = renderer ? Math.min(8, renderer.capabilities.getMaxAnisotropy()) : 1;
  const color = new THREE.CanvasTexture(colorCanvas);
  color.name = "r5-vegetation-color-atlas";
  color.colorSpace = THREE.SRGBColorSpace;
  color.minFilter = THREE.LinearMipmapLinearFilter;
  color.magFilter = THREE.LinearFilter;
  color.generateMipmaps = true;
  color.anisotropy = anisotropy;
  color.needsUpdate = true;
  const normal = new THREE.CanvasTexture(normalCanvas);
  normal.name = "r5-vegetation-normal-atlas";
  normal.colorSpace = THREE.NoColorSpace;
  normal.minFilter = THREE.LinearMipmapLinearFilter;
  normal.magFilter = THREE.LinearFilter;
  normal.generateMipmaps = true;
  normal.anisotropy = anisotropy;
  normal.needsUpdate = true;
  return { color, normal };
}

function sampleGrid(field, array, x, z) {
  const gx = (x - field.bounds.minX) / field.dx;
  const gz = (z - field.bounds.minZ) / field.dz;
  if (gx < 0 || gz < 0 || gx > field.bounds.width - 1 || gz > field.bounds.height - 1) return null;
  const x0 = Math.floor(gx), z0 = Math.floor(gz);
  const x1 = Math.min(field.bounds.width - 1, x0 + 1);
  const z1 = Math.min(field.bounds.height - 1, z0 + 1);
  const tx = gx - x0, tz = gz - z0;
  const a = array[z0 * field.bounds.width + x0] * (1 - tx) + array[z0 * field.bounds.width + x1] * tx;
  const b = array[z1 * field.bounds.width + x0] * (1 - tx) + array[z1 * field.bounds.width + x1] * tx;
  return a * (1 - tz) + b * tz;
}

function surfaceAt(field, x, z) {
  const y = field.sampleHeight(x, z);
  const sdf = field.sampleSdf(x, z);
  const slope = field.sampleSlope(x, z);
  if (y == null || sdf == null || slope == null) return null;
  const e = Math.max(field.dx, field.dz);
  const hx0 = field.sampleHeight(x - e, z), hx1 = field.sampleHeight(x + e, z);
  const hz0 = field.sampleHeight(x, z - e), hz1 = field.sampleHeight(x, z + e);
  if ([hx0, hx1, hz0, hz1].some((value) => value == null)) return null;
  const normal = new THREE.Vector3(-(hx1 - hx0) / (2 * e), 1, -(hz1 - hz0) / (2 * e)).normalize();
  return {
    x, y, z, sdf, slope, normal,
    curvature: field.sampleCurvature(x, z) || 0,
    exposure: sampleGrid(field, field.exposure, x, z) || 0,
    moisture: sampleGrid(field, field.moisture, x, z) || 0,
  };
}

function distanceToSegment(x, z, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az;
  const lengthSq = dx * dx + dz * dz;
  const t = lengthSq > 0 ? clamp(((x - ax) * dx + (z - az) * dz) / lengthSq, 0, 1) : 0;
  return Math.hypot(x - (ax + dx * t), z - (az + dz * t));
}

function createExclusionTest(exclusions) {
  const clear = R5_SCATTER_CONFIG.placement.clearances;
  const docks = exclusions.docks || [];
  const pads = exclusions.pads || [];
  const beats = exclusions.beats || [];
  const padById = new Map(pads.map((pad) => [pad.id, pad]));
  return (x, z, kind) => {
    const scale = kind === "grass" ? 0.55 : kind === "scrub" ? 0.72 : 1;
    for (const dock of docks) {
      if (Math.hypot(x - dock.x, z - dock.z) < clear.dock * scale) return true;
      const pad = padById.get(dock.id);
      if (pad && distanceToSegment(x, z, dock.x, dock.z, pad.x, pad.z) < 4.5 * scale) return true;
    }
    for (const pad of pads) {
      if (Math.hypot(x - pad.x, z - pad.z) < pad.radius + clear.pad * scale) return true;
    }
    for (const beat of beats) {
      const anchor = beat.anchor;
      const camera = beat.pos;
      if (!anchor || !camera) continue;
      if (Math.hypot(x - anchor.x, z - anchor.z) < clear.beat * scale) return true;
      if (distanceToSegment(x, z, camera.x, camera.z, anchor.x, anchor.z) < clear.sightline * scale) return true;
    }
    if (exclusions.spawn && exclusions.temple) {
      const { spawn, temple } = exclusions;
      if (distanceToSegment(x, z, spawn.x, spawn.z, temple.x, temple.z) < clear.spawnTemple * scale) return true;
    }
    return false;
  };
}

class PoissonSet {
  constructor(radius) {
    this.radius = radius;
    this.cell = radius / Math.SQRT2;
    this.grid = new Map();
    this.points = [];
  }
  key(ix, iz) { return `${ix}:${iz}`; }
  canAdd(x, z) {
    const ix = Math.floor(x / this.cell), iz = Math.floor(z / this.cell);
    for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) {
      const point = this.grid.get(this.key(ix + dx, iz + dz));
      if (point && Math.hypot(x - point.x, z - point.z) < this.radius) return false;
    }
    return true;
  }
  add(point) {
    const ix = Math.floor(point.x / this.cell), iz = Math.floor(point.z / this.cell);
    this.grid.set(this.key(ix, iz), point);
    this.points.push(point);
  }
}

function randomPoint(field, rng) {
  return {
    x: field.bounds.minX + rng() * (field.bounds.maxX - field.bounds.minX),
    z: field.bounds.minZ + rng() * (field.bounds.maxZ - field.bounds.minZ),
  };
}

function weightedPoisson(field, count, radius, rng, accept) {
  const result = new PoissonSet(radius);
  const maxAttempts = Math.max(30000, count * 2400);
  for (let attempt = 0; attempt < maxAttempts && result.points.length < count; attempt++) {
    const candidate = randomPoint(field, rng);
    if (!result.canAdd(candidate.x, candidate.z)) continue;
    const surface = surfaceAt(field, candidate.x, candidate.z);
    const weight = surface ? accept(surface) : 0;
    if (weight <= 0 || rng() > weight) continue;
    result.add(surface);
  }
  if (result.points.length !== count) {
    throw new Error(`R5 scatter placed ${result.points.length}/${count} instances at radius ${radius}`);
  }
  return result.points;
}

function buildPlacements(field, tier, exclusions) {
  const rng = mulberry32(R5_SCATTER_CONFIG.seed);
  const excluded = createExclusionTest(exclusions);
  const radii = R5_SCATTER_CONFIG.placement.poissonRadius;
  const maxTreeSlope = R5_SCATTER_CONFIG.placement.maxTreeSlopeDegrees * DEG;
  const maxScrubSlope = R5_SCATTER_CONFIG.placement.maxScrubSlopeDegrees * DEG;
  const landBase = (surface, kind, inland = 2.2) => surface.sdf > inland && surface.y > 0.3 && !excluded(surface.x, surface.z, kind);

  const cypress = weightedPoisson(field, tier.counts.cypress, radii.cypress, rng, (surface) => {
    if (!landBase(surface, "cypress", 4.2) || surface.slope > maxTreeSlope) return 0;
    const shelter = 1 - surface.exposure;
    const north = smoothstep(-0.2, 0.65, surface.normal.z);
    return clamp(0.22 + shelter * 0.28 + north * 0.18 + (1 - surface.moisture) * 0.12, 0, 0.84);
  });

  const clusterCenters = weightedPoisson(field, Math.max(14, Math.ceil(tier.counts.olive / 6)), 9.5, rng, (surface) => {
    if (!landBase(surface, "olive", 4.8) || surface.slope > maxTreeSlope * 0.9) return 0;
    const north = smoothstep(-0.25, 0.62, surface.normal.z);
    return clamp(0.16 + (1 - surface.exposure) * 0.38 + surface.moisture * 0.18 + north * 0.17, 0, 0.9);
  });
  const oliveSet = new PoissonSet(radii.olive);
  const clusterRange = R5_SCATTER_CONFIG.placement.oliveClusterSize;
  let clusterIndex = 0;
  for (let guard = 0; guard < tier.counts.olive * 500 && oliveSet.points.length < tier.counts.olive; guard++) {
    const center = clusterCenters[clusterIndex++ % clusterCenters.length];
    const clusterSize = clusterRange[0] + Math.floor(rng() * (clusterRange[1] - clusterRange[0] + 1));
    for (let member = 0; member < clusterSize && oliveSet.points.length < tier.counts.olive; member++) {
      const angle = rng() * TAU;
      const radius = 1.6 + Math.sqrt(rng()) * 7.4;
      const x = center.x + Math.cos(angle) * radius;
      const z = center.z + Math.sin(angle) * radius;
      if (!oliveSet.canAdd(x, z)) continue;
      const surface = surfaceAt(field, x, z);
      if (!surface || !landBase(surface, "olive", 4.0) || surface.slope > maxTreeSlope) continue;
      oliveSet.add(surface);
    }
  }
  if (oliveSet.points.length !== tier.counts.olive) {
    throw new Error(`R5 olive clusters placed ${oliveSet.points.length}/${tier.counts.olive}`);
  }

  const scrub = weightedPoisson(field, tier.counts.scrub, radii.scrub, rng, (surface) => {
    if (!landBase(surface, "scrub", 2.2) || surface.slope > maxScrubSlope) return 0;
    const north = smoothstep(-0.3, 0.55, surface.normal.z);
    return clamp(0.25 + (1 - surface.exposure) * 0.3 + north * 0.16 + surface.moisture * 0.12, 0, 0.9);
  });

  const grass = weightedPoisson(field, tier.counts.grass, radii.grass, rng, (surface) => {
    if (!landBase(surface, "grass", 1.6) || surface.slope > 30 * DEG) return 0;
    const nearPad = (exclusions.pads || []).reduce((distance, pad) => Math.min(distance, Math.hypot(surface.x - pad.x, surface.z - pad.z)), Infinity);
    const nearField = Math.min(surface.sdf, nearPad);
    if (nearField > 27) return 0;
    return clamp(0.28 + surface.moisture * 0.34 + (1 - surface.exposure) * 0.2, 0, 0.92);
  });

  const rocks = weightedPoisson(field, tier.counts.rocks, radii.rocks, rng, (surface) => {
    if (!landBase(surface, "rocks", 0.8) || surface.slope > 62 * DEG) return 0;
    const slope = smoothstep(10 * DEG, 48 * DEG, surface.slope);
    const shore = 1 - smoothstep(5, 26, surface.sdf);
    const curvature = smoothstep(1.5, 22, Math.abs(surface.curvature));
    const headland = surface.exposure;
    return clamp(0.08 + slope * 0.34 + shore * 0.25 + curvature * 0.2 + headland * 0.26, 0, 0.95);
  });

  return { cypress, olive: oliveSet.points, scrub, grass, rocks };
}

// Exported for deterministic Node verification. It performs placement only and
// never touches Canvas, WebGL, or the scene graph.
export function buildR5PlacementPlan(terrainField, quality = "high", exclusions = {}) {
  return buildPlacements(terrainField, r5Tier(quality), exclusions);
}

function makeCrossPlaneGeometry() {
  const positions = [];
  const uvs = [];
  const normals = [];
  const wind = [];
  const indices = [];
  for (let plane = 0; plane < 3; plane++) {
    const angle = plane * Math.PI / 3;
    const dx = Math.cos(angle), dz = Math.sin(angle);
    const nx = -dz, nz = dx;
    const base = positions.length / 3;
    const verts = [[-0.5, 0, 0], [0.5, 0, 0], [0.5, 1, 0], [-0.5, 1, 0]];
    for (const [x, y] of verts) {
      positions.push(dx * x, y, dz * x);
      normals.push(nx, 0, nz);
      wind.push(smoothstep(0.35, 1, y));
    }
    uvs.push(0, 0, 1, 0, 1, 1, 0, 1);
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setAttribute("windWeight", new THREE.Float32BufferAttribute(wind, 1));
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();
  return geometry;
}

function patchVegetationVertex(shader, windUniform, distanceUniform) {
  shader.uniforms.uVegetationWindTime = windUniform;
  shader.uniforms.uVegetationCullDistance = distanceUniform;
  shader.vertexShader = shader.vertexShader.replace("#include <common>", `#include <common>
    attribute vec4 instanceVariation;
    attribute float windWeight;
    varying vec2 vVegetationAtlasUv;
    varying float vVegetationHue;
    varying float vVegetationDistanceFade;
    uniform float uVegetationWindTime;
    uniform float uVegetationCullDistance;`);
  shader.vertexShader = shader.vertexShader.replace("#include <uv_vertex>", `#include <uv_vertex>
    float vegetationFrame = floor(instanceVariation.z + 0.5);
    // Canvas textures flip on upload, so atlas row zero (painted at the canvas
    // top) lives in texture row three while local billboard UVs stay upright.
    vec2 vegetationCell = vec2(mod(vegetationFrame, 4.0), 3.0 - floor(vegetationFrame / 4.0));
    vVegetationAtlasUv = (uv + vegetationCell) * 0.25;
    vVegetationHue = instanceVariation.x;`);
  shader.vertexShader = shader.vertexShader.replace("#include <begin_vertex>", `#include <begin_vertex>
    vec3 vegetationWorldOrigin = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
    float vegetationDistance = distance(cameraPosition.xz, vegetationWorldOrigin.xz);
    vVegetationDistanceFade = 1.0 - smoothstep(
      max(0.0, uVegetationCullDistance - 8.0),
      uVegetationCullDistance,
      vegetationDistance
    );
    float vegetationWind = sin(uVegetationWindTime * 0.82 + instanceVariation.w + instanceMatrix[3].x * 0.071 + instanceMatrix[3].z * 0.053);
    transformed.x += vegetationWind * windWeight * 0.075;
    transformed.z += cos(uVegetationWindTime * 0.61 + instanceVariation.w) * windWeight * 0.045;`);
}

function createVegetationMaterial(type, atlas, windUniform, distanceUniform) {
  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    map: atlas.color,
    normalMap: atlas.normal,
    normalScale: new THREE.Vector2(0.46, 0.46),
    roughness: type === "grass" ? 0.96 : 0.91,
    metalness: 0,
    alphaTest: R5_SCATTER_CONFIG.atlas.alphaTest[type],
    transparent: false,
    depthWrite: true,
    side: THREE.DoubleSide,
  });
  material.name = `r5-${type}-impostor`;
  material.envMapIntensity = 0.24;
  material.onBeforeCompile = (shader) => {
    patchVegetationVertex(shader, windUniform, distanceUniform);
    shader.uniforms.uVegetationAtlas = { value: atlas.color };
    shader.uniforms.uVegetationNormal = { value: atlas.normal };
    shader.fragmentShader = shader.fragmentShader.replace("#include <common>", `#include <common>
      varying vec2 vVegetationAtlasUv;
      varying float vVegetationHue;
      varying float vVegetationDistanceFade;
      uniform sampler2D uVegetationAtlas;
      uniform sampler2D uVegetationNormal;`);
    shader.fragmentShader = shader.fragmentShader.replace("#include <map_fragment>", `
      if (vVegetationDistanceFade <= 0.001) discard;
      vec4 vegetationTexel = texture2D(uVegetationAtlas, vVegetationAtlasUv);
      vegetationTexel = sRGBTransferEOTF(vegetationTexel);
      vegetationTexel.rgb *= vec3(1.0 + vVegetationHue * 0.18, 1.0 + vVegetationHue * 0.08, 1.0 - vVegetationHue * 0.14);
      vegetationTexel.a *= vVegetationDistanceFade;
      diffuseColor *= vegetationTexel;`);
    shader.fragmentShader = shader.fragmentShader.replace("#include <normal_fragment_maps>", `
      vec3 vegetationMapN = texture2D(uVegetationNormal, vVegetationAtlasUv).xyz * 2.0 - 1.0;
      vegetationMapN.xy *= normalScale;
      normal = normalize(tbn * vegetationMapN);`);
  };
  material.customProgramCacheKey = () => `r5-vegetation-${type}-atlas-v1`;
  return material;
}

function createVegetationDepthMaterial(type, atlas, windUniform, distanceUniform) {
  const material = new THREE.MeshDepthMaterial({
    depthPacking: THREE.RGBADepthPacking,
    map: atlas.color,
    alphaTest: R5_SCATTER_CONFIG.atlas.alphaTest[type],
    side: THREE.DoubleSide,
  });
  material.onBeforeCompile = (shader) => {
    patchVegetationVertex(shader, windUniform, distanceUniform);
    shader.uniforms.uVegetationAtlas = { value: atlas.color };
    shader.fragmentShader = shader.fragmentShader.replace("#include <common>", `#include <common>
      varying vec2 vVegetationAtlasUv;
      varying float vVegetationDistanceFade;
      uniform sampler2D uVegetationAtlas;`);
    shader.fragmentShader = shader.fragmentShader.replace("#include <map_fragment>", `
      if (vVegetationDistanceFade <= 0.001) discard;
      diffuseColor.a *= vVegetationDistanceFade;
      diffuseColor *= texture2D(uVegetationAtlas, vVegetationAtlasUv);`);
  };
  material.customProgramCacheKey = () => `r5-vegetation-depth-${type}-v1`;
  return material;
}

const VEGETATION_SIZE = Object.freeze({
  cypress: [2.2, 8.6],
  olive: [6.5, 5.5],
  scrub: [2.5, 1.65],
  grass: [0.88, 0.92],
});

function buildVegetationDraw(type, placements, atlas, windUniform, distanceUniform, rng, castShadow) {
  const geometry = makeCrossPlaneGeometry();
  const variations = new Float32Array(placements.length * 4);
  geometry.setAttribute("instanceVariation", new THREE.InstancedBufferAttribute(variations, 4));
  const material = createVegetationMaterial(type, atlas, windUniform, distanceUniform);
  const mesh = new THREE.InstancedMesh(geometry, material, placements.length);
  const depthMaterial = createVegetationDepthMaterial(type, atlas, windUniform, distanceUniform);
  mesh.customDepthMaterial = depthMaterial;
  mesh.castShadow = castShadow;
  mesh.receiveShadow = true;
  mesh.frustumCulled = false;
  mesh.name = `r5-${type}-impostors`;
  mesh.userData.scatterType = type;
  mesh.userData.maximumInstanceCount = placements.length;
  const frames = R5_SCATTER_CONFIG.atlas.frames[type];
  const baseSize = VEGETATION_SIZE[type];
  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const yaw = new THREE.Quaternion();
  const lean = new THREE.Quaternion();
  const leanAxis = new THREE.Vector3();
  const scale = new THREE.Vector3();
  for (let i = 0; i < placements.length; i++) {
    const point = placements[i];
    const heightVariation = (type === "cypress" ? 0.78 + rng() * 0.5 : 0.82 + rng() * 0.36)
      * (point.heroHeightScale || 1);
    const widthVariation = (0.78 + rng() * 0.42) * (point.heroWidthScale || 1);
    const leanAmount = (type === "grass" ? 0.15 : type === "scrub" ? 0.09 : 0.045) * rng();
    yaw.setFromAxisAngle(UP, rng() * TAU);
    leanAxis.set(Math.cos(rng() * TAU), 0, Math.sin(rng() * TAU));
    lean.setFromAxisAngle(leanAxis, leanAmount);
    quaternion.copy(yaw).multiply(lean);
    position.set(point.x, point.y - (type === "grass" ? 0.035 : 0.08), point.z);
    scale.set(baseSize[0] * widthVariation, baseSize[1] * heightVariation, baseSize[0] * widthVariation);
    matrix.compose(position, quaternion, scale);
    mesh.setMatrixAt(i, matrix);
    variations[i * 4] = (rng() - 0.5) * 0.28;
    variations[i * 4 + 1] = leanAmount;
    variations[i * 4 + 2] = frames[Math.floor(rng() * frames.length)];
    variations[i * 4 + 3] = rng() * TAU;
    point.contactRadius = baseSize[0] * widthVariation * (type === "cypress" ? 0.38 : 0.34);
  }
  mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
  mesh.instanceMatrix.needsUpdate = true;
  geometry.attributes.instanceVariation.needsUpdate = true;
  return { mesh, material, depthMaterial };
}

function splitPlacements(points, parts) {
  const result = [];
  for (let part = 0; part < parts; part++) {
    const start = Math.floor(points.length * part / parts);
    const end = Math.floor(points.length * (part + 1) / parts);
    result.push(points.slice(start, end));
  }
  return result;
}

function hash3(x, y, z, seed) {
  const value = Math.sin(x * 127.1 + y * 311.7 + z * 74.7 + seed * 0.0137) * 43758.5453123;
  return value - Math.floor(value);
}

function valueNoise3(x, y, z, seed) {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const fx = smoothstep(0, 1, x - ix), fy = smoothstep(0, 1, y - iy), fz = smoothstep(0, 1, z - iz);
  const h = (dx, dy, dz) => hash3(ix + dx, iy + dy, iz + dz, seed);
  const x00 = h(0, 0, 0) * (1 - fx) + h(1, 0, 0) * fx;
  const x10 = h(0, 1, 0) * (1 - fx) + h(1, 1, 0) * fx;
  const x01 = h(0, 0, 1) * (1 - fx) + h(1, 0, 1) * fx;
  const x11 = h(0, 1, 1) * (1 - fx) + h(1, 1, 1) * fx;
  const y0 = x00 * (1 - fy) + x10 * fy;
  const y1 = x01 * (1 - fy) + x11 * fy;
  return y0 * (1 - fz) + y1 * fz;
}

function rockFbm(x, y, z, seed) {
  let total = 0, amplitude = 0.58, frequency = 1.45, normalizer = 0;
  for (let octave = 0; octave < 4; octave++) {
    total += (valueNoise3(x * frequency, y * frequency, z * frequency, seed + octave * 97) * 2 - 1) * amplitude;
    normalizer += amplitude;
    amplitude *= 0.5;
    frequency *= 2.07;
  }
  return total / normalizer;
}

function computeWeldedSmoothNormals(geometry) {
  const position = geometry.attributes.position;
  const accumulated = new Map();
  const keyAt = (index) => `${Math.round(position.getX(index) * 100000)}:${Math.round(position.getY(index) * 100000)}:${Math.round(position.getZ(index) * 100000)}`;
  for (let i = 0; i < position.count; i += 3) {
    const ax = position.getX(i), ay = position.getY(i), az = position.getZ(i);
    const abx = position.getX(i + 1) - ax, aby = position.getY(i + 1) - ay, abz = position.getZ(i + 1) - az;
    const acx = position.getX(i + 2) - ax, acy = position.getY(i + 2) - ay, acz = position.getZ(i + 2) - az;
    const nx = aby * acz - abz * acy;
    const ny = abz * acx - abx * acz;
    const nz = abx * acy - aby * acx;
    for (let corner = 0; corner < 3; corner++) {
      const key = keyAt(i + corner);
      const value = accumulated.get(key) || [0, 0, 0];
      value[0] += nx;
      value[1] += ny;
      value[2] += nz;
      accumulated.set(key, value);
    }
  }
  const normals = new Float32Array(position.count * 3);
  for (let i = 0; i < position.count; i++) {
    const value = accumulated.get(keyAt(i));
    const inverse = 1 / (Math.hypot(value[0], value[1], value[2]) || 1);
    normals[i * 3] = value[0] * inverse;
    normals[i * 3 + 1] = value[1] * inverse;
    normals[i * 3 + 2] = value[2] * inverse;
  }
  geometry.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
}

function createRockGeometry(detail, variant) {
  const geometry = new THREE.IcosahedronGeometry(1, detail);
  const position = geometry.attributes.position;
  const stretchX = 0.9 + hash3(variant, 1, 2, 11) * 0.36;
  const stretchY = 0.72 + hash3(variant, 2, 3, 17) * 0.24;
  const stretchZ = 0.88 + hash3(variant, 3, 4, 23) * 0.4;
  for (let i = 0; i < position.count; i++) {
    let x = position.getX(i), y = position.getY(i), z = position.getZ(i);
    const inverse = 1 / Math.hypot(x, y, z);
    const nx = x * inverse, ny = y * inverse, nz = z * inverse;
    const displacement = 1 + rockFbm(nx + variant * 0.17, ny - variant * 0.11, nz + variant * 0.23, R5_SCATTER_CONFIG.seed + variant * 131) * 0.2;
    x = nx * displacement * stretchX;
    y = ny * displacement * stretchY;
    z = nz * displacement * stretchZ;
    if (y < -0.38) {
      const baseBlend = smoothstep(-0.78, -0.38, y);
      y = -0.48 + baseBlend * 0.1;
      x *= 1.04;
      z *= 1.04;
    }
    position.setXYZ(i, x, y, z);
  }
  position.needsUpdate = true;
  computeWeldedSmoothNormals(geometry);
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  geometry.setAttribute("terrainAO", new THREE.BufferAttribute(new Float32Array(position.count).fill(0.92), 1));
  geometry.userData.triangleCount = position.count / 3;
  return geometry;
}

function buildRockDraws(placements, rockMaterial, rng, contacts) {
  const details = R5_SCATTER_CONFIG.rocks.details;
  const buckets = details.map(() => []);
  placements.forEach((point, index) => buckets[index % buckets.length].push(point));
  const root = new THREE.Group();
  root.name = "r5-displaced-limestone-boulders";
  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const fullTilt = new THREE.Quaternion();
  const yaw = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  buckets.forEach((points, variant) => {
    const geometry = createRockGeometry(details[variant], variant);
    const mesh = new THREE.InstancedMesh(geometry, rockMaterial, points.length);
    mesh.name = `r5-limestone-variant-${variant + 1}`;
    mesh.userData.scatterType = "rocks";
    mesh.userData.maximumInstanceCount = points.length;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    for (let i = 0; i < points.length; i++) {
      const point = points[i];
      const scaleRange = point.debrisScale || R5_SCATTER_CONFIG.rocks.scale;
      const size = scaleRange[0] + Math.pow(rng(), 1.8) * (scaleRange[1] - scaleRange[0]);
      const bury = R5_SCATTER_CONFIG.rocks.buried[0] + rng() * (R5_SCATTER_CONFIG.rocks.buried[1] - R5_SCATTER_CONFIG.rocks.buried[0]);
      const align = R5_SCATTER_CONFIG.rocks.normalAlignment[0] + rng() * (R5_SCATTER_CONFIG.rocks.normalAlignment[1] - R5_SCATTER_CONFIG.rocks.normalAlignment[0]);
      fullTilt.setFromUnitVectors(UP, point.normal);
      quaternion.identity().slerp(fullTilt, align);
      yaw.setFromAxisAngle(UP, rng() * TAU);
      quaternion.multiply(yaw);
      const sx = size * (0.78 + rng() * 0.55);
      const sy = size * (0.7 + rng() * 0.42);
      const sz = size * (0.8 + rng() * 0.52);
      position.set(point.x, point.y - sy * bury, point.z);
      scale.set(sx, sy, sz);
      matrix.compose(position, quaternion, scale);
      mesh.setMatrixAt(i, matrix);
      contacts.push({ point, radius: Math.max(sx, sz) * 0.72, opacity: 0.12 + rng() * 0.08 });
    }
    mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    mesh.instanceMatrix.needsUpdate = true;
    root.add(mesh);
  });
  return root;
}

function contactMaterial() {
  return new THREE.ShaderMaterial({
    name: "r5-instanced-contact-shadows",
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
    uniforms: { uContactColor: { value: new THREE.Color(0x29261d) } },
    vertexShader: `
      attribute float instanceContactOpacity;
      varying vec2 vContactUv;
      varying float vContactOpacity;
      void main() {
        vContactUv = uv;
        vContactOpacity = instanceContactOpacity;
        vec4 localPosition = instanceMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * modelViewMatrix * localPosition;
      }
    `,
    fragmentShader: `
      uniform vec3 uContactColor;
      varying vec2 vContactUv;
      varying float vContactOpacity;
      void main() {
        vec2 p = (vContactUv - 0.5) * vec2(2.0, 2.35);
        float radius = length(p);
        float alpha = (1.0 - smoothstep(0.08, 1.0, radius)) * vContactOpacity;
        gl_FragColor = vec4(uContactColor, alpha);
      }
    `,
  });
}

function buildContacts(treePlacements, rockContacts, rng) {
  const treeContacts = [...treePlacements.cypress, ...treePlacements.olive].map((point) => ({
    point,
    radius: point.contactRadius,
    opacity: 0.1 + rng() * 0.07,
  }));
  const contacts = [...treeContacts, ...rockContacts];
  const geometry = new THREE.CircleGeometry(1, 18);
  geometry.rotateX(-Math.PI / 2);
  geometry.setAttribute("instanceContactOpacity", new THREE.InstancedBufferAttribute(new Float32Array(contacts.length), 1));
  const mesh = new THREE.InstancedMesh(geometry, contactMaterial(), contacts.length);
  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  for (let i = 0; i < contacts.length; i++) {
    const contact = contacts[i];
    quaternion.setFromUnitVectors(UP, contact.point.normal);
    position.set(contact.point.x, contact.point.y + 0.035, contact.point.z);
    scale.set(contact.radius, contact.radius, contact.radius);
    matrix.compose(position, quaternion, scale);
    mesh.setMatrixAt(i, matrix);
    geometry.attributes.instanceContactOpacity.setX(i, clamp(contact.opacity, 0.1, 0.22));
  }
  mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
  mesh.instanceMatrix.needsUpdate = true;
  geometry.attributes.instanceContactOpacity.needsUpdate = true;
  mesh.frustumCulled = false;
  mesh.renderOrder = 1;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.userData.shadowExcludeSubtree = true;
  return mesh;
}

export function buildR5Scatter({
  renderer,
  terrainField,
  rockMaterial,
  quality = "high",
  exclusions = {},
  heroTrees = [],
  landmarkDebris = [],
}) {
  const started = performance.now();
  const tier = r5Tier(quality);
  const atlasStarted = performance.now();
  const atlas = bakeVegetationAtlas(tier.atlasSize, renderer);
  const atlasMs = performance.now() - atlasStarted;
  const placementStarted = performance.now();
  const placements = buildPlacements(terrainField, tier, exclusions);
  for (const hero of heroTrees) {
    if (hero && (hero.type === "cypress" || hero.type === "olive")) placements[hero.type].unshift(hero);
  }
  placements.rocks.push(...landmarkDebris);
  const placementMs = performance.now() - placementStarted;
  const root = new THREE.Group();
  root.name = "r5-vegetation-rock-scatter";
  const windUniform = { value: 0 };
  const grassDistanceUniform = { value: QUALITY_PROFILES[quality].grassDistance };
  const uncullDistanceUniform = { value: 1e6 };
  const rng = mulberry32(R5_SCATTER_CONFIG.seed ^ 0x51ed270b);
  const materials = [];
  const depthMaterials = [];
  const vegetationMeshes = [];
  for (const type of ["cypress", "olive", "scrub", "grass"]) {
    const chunks = splitPlacements(placements[type], tier.vegetationDraws[type]);
    for (const chunk of chunks) {
      const draw = buildVegetationDraw(
        type,
        chunk,
        atlas,
        windUniform,
        type === "grass" ? grassDistanceUniform : uncullDistanceUniform,
        rng,
        QUALITY_PROFILES[quality].vegetationShadows && (type === "cypress" || type === "olive"),
      );
      root.add(draw.mesh);
      vegetationMeshes.push(draw.mesh);
      materials.push(draw.material);
      depthMaterials.push(draw.depthMaterial);
    }
  }
  const rockContacts = [];
  const rockRoot = buildRockDraws(placements.rocks, rockMaterial, rng, rockContacts);
  const rockMeshes = rockRoot.children.filter((child) => child.isInstancedMesh);
  root.add(rockRoot);
  root.add(buildContacts(placements, rockContacts, rng));
  const initMs = performance.now() - started;
  const stats = {
    quality,
    atlasSize: tier.atlasSize,
    atlasMs: +atlasMs.toFixed(2),
    placementMs: +placementMs.toFixed(2),
    initMs: +initMs.toFixed(2),
    counts: { ...tier.counts },
    heroTrees: {
      cypress: heroTrees.filter((item) => item.type === "cypress").length,
      olive: heroTrees.filter((item) => item.type === "olive").length,
    },
    landmarkDebris: landmarkDebris.length,
    draws: { ...R5_SCATTER_CONFIG.draws },
    rockVariantTriangles: R5_SCATTER_CONFIG.rocks.details.map((detail) => 20 * (detail + 1) * (detail + 1)),
  };
  console.info("[voyage] R5 scatter", stats);
  const initialCounts = Object.fromEntries(
    Object.entries(tier.counts).map(([name, count]) => [name, count]),
  );
  let runtimeDensity = 1;
  let grassDistance = Infinity;
  let shadowCasting = true;

  const applyCounts = (targetCounts = initialCounts) => {
    for (const mesh of [...vegetationMeshes, ...rockMeshes]) {
      const type = mesh.userData.scatterType;
      const initial = Math.max(1, initialCounts[type] || mesh.userData.maximumInstanceCount);
      const target = Math.max(0, targetCounts[type] == null ? initial : targetCounts[type]);
      const tierRatio = Math.min(1, target / initial);
      mesh.count = Math.max(0, Math.floor(mesh.userData.maximumInstanceCount * tierRatio * runtimeDensity));
    }
  };

  return {
    root,
    textures: [atlas.color, atlas.normal],
    materials,
    depthMaterials,
    stats,
    updateWind(time) { windUniform.value = time; },
    updateForCamera() {},
    setBudget({ targetCounts = initialCounts, density = runtimeDensity, grassCullDistance = grassDistance } = {}) {
      runtimeDensity = Math.max(0, Math.min(1, density));
      grassDistance = Math.max(0, grassCullDistance);
      grassDistanceUniform.value = grassDistance;
      applyCounts(targetCounts);
    },
    setShadowCasting(enabled) {
      shadowCasting = !!enabled;
      for (const mesh of vegetationMeshes) {
        mesh.castShadow = shadowCasting && (mesh.userData.scatterType === "cypress" || mesh.userData.scatterType === "olive");
      }
      for (const mesh of rockMeshes) mesh.castShadow = shadowCasting;
    },
    runtimeState() {
      return { density: runtimeDensity, grassDistance, shadowCasting };
    },
  };
}
