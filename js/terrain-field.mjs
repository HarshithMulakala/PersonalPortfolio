// Deterministic master terrain dataset for the voyage island. This module has
// no DOM or Three.js dependency so it can run in a Worker and in Node checks.

export const TERRAIN_FIELD_VERSION = 2;
export const TERRAIN_SEED = 0x5eaf2026;
export const TERRAIN_BOUNDS = Object.freeze({
  minX: -96,
  maxX: 96,
  minZ: -40,
  maxZ: 108,
  width: 321,
  height: 249,
});

export const TERRAIN_DOCKS = Object.freeze([
  { id: "origins", x: -47, z: -28 },
  { id: "forge", x: 62, z: 7 },
  { id: "labors", x: -13, z: 99 },
  { id: "voyages", x: -89, z: 50 },
  { id: "oracle", x: 78, z: 75 },
]);

export const TERRAIN_PADS = Object.freeze([
  { id: "labors", x: -4, z: 48, radius: 10.5, blend: 5.0, targetHeight: 29.0 },
  { id: "voyages", x: -49, z: 49, radius: 7.0, blend: 4.0 },
  { id: "oracle", x: 49, z: 66, radius: 6.5, blend: 4.0, targetHeight: 23.0 },
  { id: "origins", x: -34, z: 7, radius: 5.5, blend: 3.5 },
  { id: "forge", x: 36, z: 13, radius: 5.0, blend: 3.5 },
]);

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function mix(a, b, t) { return a + (b - a) * t; }
function smoothstep(a, b, x) {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}
function wrapAngle(a) { return Math.atan2(Math.sin(a), Math.cos(a)); }
function bell(angle, center, halfWidth) {
  const q = Math.abs(wrapAngle(angle - center)) / halfWidth;
  return q >= 1 ? 0 : Math.exp(-3.35 * q * q);
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash2(x, z, seed = TERRAIN_SEED) {
  let h = Math.imul(x | 0, 0x1f123bb5) ^ Math.imul(z | 0, 0x5f356495) ^ seed;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295 * 2 - 1;
}

function valueNoise(x, z, seed = TERRAIN_SEED) {
  const ix = Math.floor(x), iz = Math.floor(z);
  const fx = x - ix, fz = z - iz;
  const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const uz = fz * fz * fz * (fz * (fz * 6 - 15) + 10);
  const a = hash2(ix, iz, seed), b = hash2(ix + 1, iz, seed);
  const c = hash2(ix, iz + 1, seed), d = hash2(ix + 1, iz + 1, seed);
  return mix(mix(a, b, ux), mix(c, d, ux), uz);
}

function fbm(x, z, octaves, frequency, lacunarity, gain, seed = TERRAIN_SEED) {
  let sum = 0, amp = 1, norm = 0, f = frequency;
  for (let o = 0; o < octaves; o++) {
    sum += valueNoise(x * f, z * f, seed + o * 0x9e37) * amp;
    norm += amp;
    amp *= gain;
    f *= lacunarity;
  }
  return sum / norm;
}

function dockWarpFade(x, z) {
  let fade = 1;
  for (const dock of TERRAIN_DOCKS) {
    const d = Math.hypot(x - dock.x, z - dock.z);
    fade = Math.min(fade, mix(0.45, 1, smoothstep(0, 8, d)));
  }
  return fade;
}

// Authored coast first, noise second. Positive is land, negative is water.
function authoredCoastApprox(x, z) {
  const warpFade = dockWarpFade(x, z);
  const wx = fbm(x + 31.4, z - 11.7, 3, 0.011, 2.03, 0.5, TERRAIN_SEED + 17) * 7 * warpFade;
  const wz = fbm(x - 18.2, z + 27.9, 3, 0.011, 2.03, 0.5, TERRAIN_SEED + 91) * 5.5 * warpFade;
  const qx = x + wx;
  const qz = z - 34 + wz;
  const rot = 7 * DEG;
  const cr = Math.cos(rot), sr = Math.sin(rot);
  const rx = qx * cr - qz * sr;
  const rz = qx * sr + qz * cr;
  const angle = Math.atan2(rz / 59, rx / 79);
  const radial = Math.hypot(rx / 79, rz / 59);
  const localScale = 1 / Math.hypot(Math.cos(angle) / 79, Math.sin(angle) / 59);

  // Origins crescent bay on the SW approach, with two guarding headlands.
  const originsBayA = -2.12;
  let feature = -12.2 * bell(angle, originsBayA, 0.34);
  feature += 7.0 * bell(angle, originsBayA - 0.47, 0.20);
  feature += 6.2 * bell(angle, originsBayA + 0.46, 0.20);
  // Smaller authored coves at Forge, Voyages, and Oracle.
  feature -= 3.8 * bell(angle, -0.49, 0.18);
  feature -= 3.3 * bell(angle, 2.91, 0.16);
  feature -= 2.8 * bell(angle, 0.78, 0.17);
  // Labors remains a rocky north landing rather than another sandy bite.
  feature += 2.6 * bell(angle, 1.69, 0.22);
  // Restrained angular irregularity, subordinate to the authored features.
  feature += Math.sin(angle * 3 + 0.45) * 2.2 + Math.sin(angle * 7 - 1.1) * 1.1;

  let signed = (1 - radial) * localScale + feature;

  // Every existing dock gets a 7.5u water basin plus an outward channel. This
  // enforces the interaction contract without smoothing away nearby headlands.
  for (const dock of TERRAIN_DOCKS) {
    const dx = x - dock.x, dz = z - dock.z;
    signed = Math.min(signed, Math.hypot(dx, dz) - 8.2);
    const ol = Math.hypot(dock.x, dock.z - 34) || 1;
    const ox = dock.x / ol, oz = (dock.z - 34) / ol;
    const along = clamp(dx * ox + dz * oz, 0, 20);
    const px = dock.x + ox * along, pz = dock.z + oz * along;
    signed = Math.min(signed, Math.hypot(x - px, z - pz) - 7.8);
  }
  return signed;
}

// Felzenszwalb/Huttenlocher squared Euclidean distance transform.
function edt1d(f, n, d, v, z) {
  let k = 0;
  v[0] = 0;
  z[0] = -Infinity;
  z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let s;
    do {
      const p = v[k];
      s = ((f[q] + q * q) - (f[p] + p * p)) / (2 * q - 2 * p);
      if (s <= z[k]) k--;
    } while (s <= z[k]);
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const p = v[k];
    d[q] = (q - p) * (q - p) + f[p];
  }
}

function distanceToMask(mask, width, height, targetValue) {
  const inf = 1e20;
  const temp = new Float64Array(width * height);
  const out = new Float64Array(width * height);
  const maxN = Math.max(width, height);
  const f = new Float64Array(maxN), d = new Float64Array(maxN);
  const v = new Int32Array(maxN), z = new Float64Array(maxN + 1);
  for (let row = 0; row < height; row++) {
    const base = row * width;
    for (let x = 0; x < width; x++) f[x] = mask[base + x] === targetValue ? 0 : inf;
    edt1d(f, width, d, v, z);
    for (let x = 0; x < width; x++) temp[base + x] = d[x];
  }
  for (let x = 0; x < width; x++) {
    for (let row = 0; row < height; row++) f[row] = temp[row * width + x];
    edt1d(f, height, d, v, z);
    for (let row = 0; row < height; row++) out[row * width + x] = d[row];
  }
  return out;
}

function buildSdf(landMask, width, height, cellSize) {
  const toLand = distanceToMask(landMask, width, height, 1);
  const toWater = distanceToMask(landMask, width, height, 0);
  const sdf = new Float32Array(width * height);
  for (let i = 0; i < sdf.length; i++) {
    sdf[i] = (landMask[i] ? Math.sqrt(toWater[i]) : -Math.sqrt(toLand[i])) * cellSize;
  }
  return sdf;
}

function padInfluence(x, z, includeBlend = true) {
  let protection = 1;
  for (const pad of TERRAIN_PADS) {
    const d = Math.hypot(x - pad.x, z - pad.z);
    if (d <= pad.radius) return 0;
    if (includeBlend && d < pad.radius + pad.blend) {
      protection = Math.min(protection, mix(0.25, 1, smoothstep(pad.radius, pad.radius + pad.blend, d)));
    }
  }
  return protection;
}

function initialHeight(x, z, coastDist, cliffOut) {
  if (coastDist <= 0) return mix(-0.25, -10.5, smoothstep(0, 25, -coastDist));
  const inland = smoothstep(0, 4, coastDist);
  const baseRise = 18 * Math.pow(clamp(coastDist / 55, 0, 1.15), 0.72);
  let y = -0.25 + baseRise * smoothstep(0, 3.2, coastDist);

  // Elevation mass is shifted 6u north and 4u west.
  const mx = x + 4, mz = z - 40;
  const rr = -18 * DEG, cr = Math.cos(rr), sr = Math.sin(rr);
  const u = mx * cr - mz * sr, v = mx * sr + mz * cr;
  const ridgeNoise = fbm(u, v, 5, 0.017, 2.08, 0.48, TERRAIN_SEED + 301);
  const ridge = Math.pow(1 - Math.abs(ridgeNoise), 2.2);
  const ridgeMask = Math.exp(-Math.pow(u / 52.5, 6) - Math.pow(v / 19, 4));
  y += ridge * ridgeMask * 10.8 * inland;
  y += fbm(x, z, 4, 0.032, 2.03, 0.5, TERRAIN_SEED + 701) * 3.2 * inland;

  // Shallow, branching drainage incisions that flow away from the ridge spine.
  const channelA = Math.abs(v - (7.5 * Math.sin(u * 0.055) + 0.10 * u));
  const channelB = Math.abs(v - (-9.0 * Math.sin(u * 0.041 + 1.4) - 0.16 * u));
  const channelC = Math.abs(v - (14 * Math.sin(u * 0.026 - 0.8) + 0.28 * u));
  const drainage = Math.max(
    Math.exp(-channelA * channelA / 3.2),
    Math.exp(-channelB * channelB / 4.5),
    Math.exp(-channelC * channelC / 5.8),
  );
  y -= drainage * smoothstep(5, 34, coastDist) * 2.15;
  y += fbm(x, z, 2, 0.19, 2.11, 0.46, TERRAIN_SEED + 1301) * 0.28 * inland;

  // Exposed western/northern headlands receive a logistic limestone step.
  const angle = Math.atan2((z - 34) / 59, x / 79);
  const exposure = clamp(Math.max(bell(angle, Math.PI, 0.90), bell(angle, 1.58, 0.76)), 0, 1);
  const dockProtection = padInfluence(x, z, true) * dockWarpFade(x, z);
  const cliffNoise = 0.82 + 0.18 * fbm(x, z, 2, 0.07, 2.1, 0.5, TERRAIN_SEED + 1701);
  const logistic = 1 / (1 + Math.exp(-(coastDist - 3.6) / 0.72));
  const cliff = exposure * dockProtection * cliffNoise;
  y += logistic * mix(8, 12, 0.5 + 0.5 * valueNoise(angle * 2.1, 4.7, TERRAIN_SEED + 1901)) * cliff;
  // Restrained strata bands on the step face.
  y += Math.sin(y * TAU / 1.6) * 0.16 * cliff * smoothstep(0.5, 6.5, coastDist);

  // Summit/acropolis and lower Oracle shoulder targets.
  y += Math.exp(-((x + 4) ** 2) / 430 - ((z - 48) ** 2) / 300) * 6.7 * inland;
  y += Math.exp(-((x - 49) ** 2) / 520 - ((z - 66) ** 2) / 410) * 16.0 * inland;
  cliffOut.value = cliff;
  return y;
}

function bilinear(field, width, height, x, z) {
  const x0 = clamp(Math.floor(x), 0, width - 1), z0 = clamp(Math.floor(z), 0, height - 1);
  const x1 = Math.min(width - 1, x0 + 1), z1 = Math.min(height - 1, z0 + 1);
  const tx = clamp(x - x0, 0, 1), tz = clamp(z - z0, 0, 1);
  const a = mix(field[z0 * width + x0], field[z0 * width + x1], tx);
  const b = mix(field[z1 * width + x0], field[z1 * width + x1], tx);
  return mix(a, b, tz);
}

function addBilinear(field, width, height, x, z, amount, protection) {
  const x0 = Math.floor(x), z0 = Math.floor(z);
  if (x0 < 0 || z0 < 0 || x0 >= width - 1 || z0 >= height - 1) return;
  const tx = x - x0, tz = z - z0;
  const weights = [(1 - tx) * (1 - tz), tx * (1 - tz), (1 - tx) * tz, tx * tz];
  const ids = [z0 * width + x0, z0 * width + x0 + 1, (z0 + 1) * width + x0, (z0 + 1) * width + x0 + 1];
  for (let k = 0; k < 4; k++) field[ids[k]] += amount * weights[k] * protection[ids[k]];
}

function erodeHydraulic(heightField, sdf, protection, width, height, dropletCount, seed) {
  const random = mulberry32(seed);
  const radiusKernel = [];
  for (let oz = -3; oz <= 3; oz++) for (let ox = -3; ox <= 3; ox++) {
    const d = Math.hypot(ox, oz);
    if (d <= 3) radiusKernel.push([ox, oz, 1 - d / 3]);
  }
  let kernelNorm = 0;
  for (const item of radiusKernel) kernelNorm += item[2];
  for (let drop = 0; drop < dropletCount; drop++) {
    let x = 2 + random() * (width - 4), z = 2 + random() * (height - 4);
    let ix = Math.floor(x), iz = Math.floor(z);
    if (sdf[iz * width + ix] < 2 || protection[iz * width + ix] <= 0) continue;
    let dx = 0, dz = 0, speed = 1, water = 1, sediment = 0;
    for (let life = 0; life < 40; life++) {
      ix = Math.floor(x); iz = Math.floor(z);
      if (ix < 2 || iz < 2 || ix >= width - 2 || iz >= height - 2) break;
      const oldH = bilinear(heightField, width, height, x, z);
      const gx = (bilinear(heightField, width, height, x + 0.5, z) - bilinear(heightField, width, height, x - 0.5, z));
      const gz = (bilinear(heightField, width, height, x, z + 0.5) - bilinear(heightField, width, height, x, z - 0.5));
      dx = dx * 0.2 - gx * 0.8;
      dz = dz * 0.2 - gz * 0.8;
      const dl = Math.hypot(dx, dz);
      if (dl < 1e-5) {
        const a = random() * TAU;
        dx = Math.cos(a); dz = Math.sin(a);
      } else { dx /= dl; dz /= dl; }
      const nx = x + dx, nz = z + dz;
      if (nx < 1 || nz < 1 || nx >= width - 2 || nz >= height - 2) break;
      const ni = Math.floor(nz) * width + Math.floor(nx);
      if (sdf[ni] < 0.8) break;
      const newH = bilinear(heightField, width, height, nx, nz);
      const deltaH = newH - oldH;
      const capacity = Math.max(-deltaH * speed * water * 4.0, 0.012);
      if (sediment > capacity || deltaH > 0) {
        const amount = deltaH > 0 ? Math.min(deltaH, sediment) : (sediment - capacity) * 0.30;
        sediment -= amount;
        addBilinear(heightField, width, height, x, z, amount, protection);
      } else {
        const amount = Math.min((capacity - sediment) * 0.28, Math.max(0.015, -deltaH + 0.08));
        let removed = 0;
        for (const [ox, oz, weight] of radiusKernel) {
          const ex = ix + ox, ez = iz + oz;
          if (ex < 1 || ez < 1 || ex >= width - 1 || ez >= height - 1) continue;
          const ei = ez * width + ex;
          const take = amount * (weight / kernelNorm) * protection[ei];
          heightField[ei] -= take;
          removed += take;
        }
        sediment += removed;
      }
      speed = Math.sqrt(Math.max(0, speed * speed - deltaH * 0.1));
      water *= 0.975;
      x = nx; z = nz;
      if (water < 0.05) break;
    }
  }
}

function erodeThermal(heightField, sdf, protection, cliffMask, width, height, cellSize, passes = 14) {
  const delta = new Float32Array(width * height);
  const talus = Math.tan(32 * DEG) * cellSize;
  for (let pass = 0; pass < passes; pass++) {
    delta.fill(0);
    for (let z = 1; z < height - 1; z++) for (let x = 1; x < width - 1; x++) {
      const i = z * width + x;
      if (heightField[i] < 0.6 || protection[i] <= 0) continue;
      let target = -1, maxDiff = talus;
      const neighbors = [i - 1, i + 1, i - width, i + width];
      for (const n of neighbors) {
        const diff = heightField[i] - heightField[n];
        if (diff > maxDiff) { maxDiff = diff; target = n; }
      }
      if (target < 0) continue;
      const belowCliff = sdf[i] < 9 && (cliffMask[i] > 0.12 || cliffMask[target] > 0.12);
      const rate = belowCliff ? 0.32 : 0.22;
      const amount = (maxDiff - talus) * rate * 0.5 * protection[i];
      delta[i] -= amount;
      delta[target] += amount * protection[target];
    }
    for (let i = 0; i < heightField.length; i++) heightField[i] += delta[i];
  }
}

function stampPads(heightField, width, height, bounds, dx, dz) {
  for (const pad of TERRAIN_PADS) {
    const gx = (pad.x - bounds.minX) / dx;
    const gz = (pad.z - bounds.minZ) / dz;
    const centerH = pad.targetHeight == null
      ? bilinear(heightField, width, height, gx, gz)
      : pad.targetHeight;
    let gradX = (bilinear(heightField, width, height, gx + 2, gz) - bilinear(heightField, width, height, gx - 2, gz)) / (4 * dx);
    let gradZ = (bilinear(heightField, width, height, gx, gz + 2) - bilinear(heightField, width, height, gx, gz - 2)) / (4 * dz);
    const grade = Math.hypot(gradX, gradZ);
    // Leave numerical headroom so finite-difference sampling remains <=3°.
    const maxGrade = Math.tan(2.6 * DEG);
    const minGrade = Math.tan(1 * DEG);
    if (grade > maxGrade) { gradX *= maxGrade / grade; gradZ *= maxGrade / grade; }
    else if (grade < minGrade) { gradX = minGrade * 0.72; gradZ = minGrade * 0.28; }
    const x0 = Math.max(0, Math.floor((pad.x - pad.radius - pad.blend - bounds.minX) / dx));
    const x1 = Math.min(width - 1, Math.ceil((pad.x + pad.radius + pad.blend - bounds.minX) / dx));
    const z0 = Math.max(0, Math.floor((pad.z - pad.radius - pad.blend - bounds.minZ) / dz));
    const z1 = Math.min(height - 1, Math.ceil((pad.z + pad.radius + pad.blend - bounds.minZ) / dz));
    for (let iz = z0; iz <= z1; iz++) for (let ix = x0; ix <= x1; ix++) {
      const x = bounds.minX + ix * dx, z = bounds.minZ + iz * dz;
      const px = x - pad.x, pz = z - pad.z, d = Math.hypot(px, pz);
      if (d > pad.radius + pad.blend) continue;
      const plane = centerH + gradX * px + gradZ * pz;
      const micro = valueNoise(x * 0.47, z * 0.47, TERRAIN_SEED + 2301) * 0.008;
      const target = plane + (d <= pad.radius ? micro : 0);
      const w = d <= pad.radius ? 1 : 1 - smoothstep(pad.radius, pad.radius + pad.blend, d);
      const i = iz * width + ix;
      heightField[i] = mix(heightField[i], target, w);
    }
  }
}

function deriveFields(heightField, sdf, cliffMask, width, height, dx, dz) {
  const count = width * height;
  const slope = new Float32Array(count);
  const curvature = new Float32Array(count);
  const ao = new Float32Array(count);
  const moisture = new Float32Array(count);
  const exposure = new Float32Array(count);
  const splat = new Float32Array(count * 4);
  const splatRemainder = new Float32Array(count);
  const dirs = [[1,0],[-1,0],[0,1],[0,-1],[1,1],[-1,1],[1,-1],[-1,-1]];
  const radii = [2, 5, 10, 18, 28];
  for (let z = 0; z < height; z++) for (let x = 0; x < width; x++) {
    const i = z * width + x;
    const worldX = TERRAIN_BOUNDS.minX + x * dx;
    const worldZ = TERRAIN_BOUNDS.minZ + z * dz;
    const xm = Math.max(0, x - 1), xp = Math.min(width - 1, x + 1);
    const zm = Math.max(0, z - 1), zp = Math.min(height - 1, z + 1);
    const gx = (heightField[z * width + xp] - heightField[z * width + xm]) / ((xp - xm) * dx || 1);
    const gz = (heightField[zp * width + x] - heightField[zm * width + x]) / ((zp - zm) * dz || 1);
    slope[i] = Math.atan(Math.hypot(gx, gz));
    curvature[i] = ((heightField[z * width + xp] - 2 * heightField[i] + heightField[z * width + xm]) / (dx * dx)) +
      ((heightField[zp * width + x] - 2 * heightField[i] + heightField[zm * width + x]) / (dz * dz));

    let horizon = 0;
    for (const [ox, oz] of dirs) {
      let dirH = 0;
      for (const radius of radii) {
        const sx = clamp(Math.round(x + ox * radius / dx), 0, width - 1);
        const sz = clamp(Math.round(z + oz * radius / dz), 0, height - 1);
        const dist = Math.hypot((sx - x) * dx, (sz - z) * dz) || 1;
        dirH = Math.max(dirH, Math.atan2(heightField[sz * width + sx] - heightField[i], dist));
      }
      horizon += Math.max(0, Math.sin(dirH));
    }
    ao[i] = clamp(1 - horizon / dirs.length * 0.72, 0.62, 1);
    const basin = smoothstep(0.25, -0.35, curvature[i]);
    moisture[i] = clamp(0.18 + basin * 0.48 + smoothstep(18, 3, heightField[i]) * 0.18 - cliffMask[i] * 0.22, 0, 1);
    exposure[i] = clamp(cliffMask[i] * 0.72 + smoothstep(9, 28, heightField[i]) * 0.38 + Math.max(0, gx * -0.18 + gz * 0.24), 0, 1);

    const shoreType = 0.5 + 0.5 * valueNoise(x * 0.035, z * 0.035, TERRAIN_SEED + 2701);
    let beach = smoothstep(3.2, 0.2, heightField[i]) * smoothstep(-1.0, 0.6, sdf[i]) * smoothstep(0.68, 0.12, slope[i]);
    beach *= smoothstep(-0.25, 0.18, shoreType) * (1 - smoothstep(0.08, 0.35, cliffMask[i]));
    // Sand belongs to the water's edge. Low inland terraces retain dry cover
    // instead of inheriting a pale beach mask merely because their y is low.
    beach *= (1 - exposure[i] * 0.45) * (1 - smoothstep(5.5, 10.0, sdf[i]));
    // Keep the pale cap on the actual acropolis crown. The old 24.5u onset
    // washed limestone far down the spawn-facing ridge and bleached the island.
    const summitLimestone = smoothstep(27.8, 30.6, heightField[i]) * smoothstep(0.72, 0.2, slope[i]);
    let cliff = Math.max(
      smoothstep(38 * DEG, 58 * DEG, slope[i]) * (0.65 + exposure[i] * 0.35),
      smoothstep(0.16, 0.42, cliffMask[i]) * smoothstep(-1.2, 2.4, sdf[i]),
      summitLimestone,
    );
    const screeSlope = smoothstep(19 * DEG, 25 * DEG, slope[i]) * (1 - smoothstep(42 * DEG, 47 * DEG, slope[i]));
    const belowCliff = clamp(0.3 + exposure[i] * 0.35 + smoothstep(0.04, 0.3, cliffMask[i]) * 0.5, 0, 1);
    let scree = smoothstep(0.05, -0.22, curvature[i]) * screeSlope * belowCliff;
    const concave = smoothstep(0.08, -0.28, curvature[i]);
    const gradientLength = Math.hypot(gx, gz) || 1;
    const northFacing = smoothstep(-0.08, 0.52, -gz / gradientLength);
    const scrubElevation = smoothstep(3, 6, heightField[i]) * (1 - smoothstep(21, 24, heightField[i]));
    const scrubCluster = smoothstep(
      0.38,
      0.72,
      valueNoise(worldX * 0.055, worldZ * 0.055, TERRAIN_SEED + 3109) * 0.62
        + valueNoise(worldX * 0.14, worldZ * 0.14, TERRAIN_SEED + 3251) * 0.38,
    );
    let scrub = smoothstep(0.16, 0.60, moisture[i]) * scrubElevation
      * clamp(concave * 0.74 + northFacing * 0.52, 0, 1) * (1 - cliff)
      * mix(0.94, 1.62, scrubCluster);
    // Golden dry grass is the default Mediterranean cover. Cliff/scree/scrub
    // subtract from it locally, rather than limestone becoming the default.
    let dry = Math.max(0.16, 1 - beach - cliff * 0.62 - scrub * 0.45 - scree * 0.42);

    // R3 underwater skirt/shelf classification. Geometry already reaches the
    // authoritative -10.5u bathymetric floor; these offshore splats make the
    // bottom sandy inside authored bays and rockier below exposed headlands.
    // Heights/SDF remain untouched, so collision, routes, and coast alignment do
    // not change between rounds.
    if (sdf[i] <= 0) {
      const angle = Math.atan2((worldZ - 34) / 59, worldX / 79);
      const bayShelter = Math.max(
        bell(angle, -2.12, 0.42),
        bell(angle, -0.49, 0.20) * 0.72,
        bell(angle, 2.91, 0.18) * 0.68,
        bell(angle, 0.78, 0.19) * 0.64,
      );
      const headlandExposure = Math.max(
        bell(angle, Math.PI, 0.90),
        bell(angle, 1.58, 0.76),
        bell(angle, -2.59, 0.20),
        bell(angle, -1.66, 0.20),
      );
      const shelf = smoothstep(-10.5, -0.25, heightField[i]);
      beach = clamp(shelf * (0.16 + bayShelter * 0.78) * (1 - headlandExposure * 0.78), 0, 0.96);
      cliff = clamp(shelf * headlandExposure * 0.68, 0, 0.82);
      scree = clamp((1 - shelf * 0.62) * (0.28 + headlandExposure * 0.48), 0, 0.82);
      scrub = 0;
      dry = Math.max(0.04, 1 - beach - cliff - scree);
    }
    const total = beach + dry + scrub + cliff + scree || 1;
    const o = i * 4;
    splat[o] = beach / total;
    splat[o + 1] = dry / total;
    splat[o + 2] = scrub / total;
    splat[o + 3] = cliff / total;
    splatRemainder[i] = scree / total;
  }
  return { slope, curvature, ao, moisture, exposure, splat, splatRemainder };
}

function now() { return typeof performance !== "undefined" ? performance.now() : Date.now(); }

export function generateTerrainField(options = {}) {
  const started = now();
  const bounds = { ...TERRAIN_BOUNDS };
  const width = bounds.width, height = bounds.height, count = width * height;
  const dx = (bounds.maxX - bounds.minX) / (width - 1);
  const dz = (bounds.maxZ - bounds.minZ) / (height - 1);
  const cellSize = (dx + dz) * 0.5;
  const landMask = new Uint8Array(count);
  for (let iz = 0; iz < height; iz++) for (let ix = 0; ix < width; ix++) {
    const x = bounds.minX + ix * dx, z = bounds.minZ + iz * dz;
    landMask[iz * width + ix] = authoredCoastApprox(x, z) >= 0 ? 1 : 0;
  }
  const sdf = buildSdf(landMask, width, height, cellSize);
  const heightField = new Float32Array(count);
  const bathymetry = new Float32Array(count);
  const cliffMask = new Float32Array(count);
  const protection = new Float32Array(count);
  const cliffOut = { value: 0 };
  for (let iz = 0; iz < height; iz++) for (let ix = 0; ix < width; ix++) {
    const i = iz * width + ix;
    const x = bounds.minX + ix * dx, z = bounds.minZ + iz * dz;
    cliffOut.value = 0;
    heightField[i] = initialHeight(x, z, sdf[i], cliffOut);
    // Positive water-column depth; terrain height carries the corresponding bed Y.
    bathymetry[i] = mix(0.25, 10.5, smoothstep(0, 25, -sdf[i]));
    cliffMask[i] = cliffOut.value;
    protection[i] = heightField[i] < 0.6 || cliffMask[i] > 0.3 ? 0 : padInfluence(x, z, true);
  }

  const requestedDroplets = options.droplets == null ? 45000 : options.droplets;
  erodeHydraulic(heightField, sdf, protection, width, height, requestedDroplets, TERRAIN_SEED + 3101);
  erodeThermal(heightField, sdf, protection, cliffMask, width, height, cellSize, options.thermalPasses || 14);
  // Keep the Labors acropolis as the dominant 27-33u summit without flattening
  // the ridge below it; only the extreme tail is compressed.
  for (let i = 0; i < count; i++) if (heightField[i] > 29) heightField[i] = 29 + (heightField[i] - 29) * 0.52;
  stampPads(heightField, width, height, bounds, dx, dz);
  // Offshore height is the authoritative underwater terrain skirt, descending
  // continuously from the -0.25u beach toe to the -10.5u outer seabed. It cannot
  // drift through erosion, which guarantees overlap beneath the opaque ocean at
  // every coast angle instead of a separate seam-prone shoreline mesh.
  for (let i = 0; i < count; i++) if (sdf[i] <= 0) heightField[i] = -bathymetry[i];
  const derived = deriveFields(heightField, sdf, cliffMask, width, height, dx, dz);
  const generationMs = now() - started;
  return hydrateTerrainField({
    version: TERRAIN_FIELD_VERSION,
    seed: TERRAIN_SEED,
    bounds,
    dx,
    dz,
    generationMs,
    droplets: requestedDroplets,
    height: heightField,
    sdf,
    bathymetry,
    ...derived,
  });
}

function sampleArray(field, array, x, z) {
  const { bounds } = field;
  const gx = (x - bounds.minX) / field.dx;
  const gz = (z - bounds.minZ) / field.dz;
  if (gx < 0 || gz < 0 || gx > bounds.width - 1 || gz > bounds.height - 1) return null;
  return bilinear(array, bounds.width, bounds.height, gx, gz);
}

export function hydrateTerrainField(payload) {
  const field = payload;
  field.sampleHeight = (x, z) => sampleArray(field, field.height, x, z);
  field.sampleSdf = (x, z) => sampleArray(field, field.sdf, x, z);
  field.sampleSlope = (x, z) => sampleArray(field, field.slope, x, z);
  field.sampleCurvature = (x, z) => sampleArray(field, field.curvature, x, z);
  field.sampleAO = (x, z) => sampleArray(field, field.ao, x, z);
  field.sampleSurface = (x, z) => {
    const y = field.sampleHeight(x, z);
    const slope = field.sampleSlope(x, z);
    return y == null || slope == null ? null : { y, ny: Math.cos(slope), slope };
  };
  field.worldToUv = (x, z) => ({
    u: (x - field.bounds.minX) / (field.bounds.maxX - field.bounds.minX),
    v: (z - field.bounds.minZ) / (field.bounds.maxZ - field.bounds.minZ),
  });
  return field;
}

export function terrainFieldTransferables(field) {
  return [
    field.height.buffer,
    field.sdf.buffer,
    field.bathymetry.buffer,
    field.slope.buffer,
    field.curvature.buffer,
    field.ao.buffer,
    field.moisture.buffer,
    field.exposure.buffer,
    field.splat.buffer,
    field.splatRemainder.buffer,
  ];
}

function signedAngle(a) {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

function projectRoutePointToWater(field, point, clearance) {
  const e = Math.max(field.dx, field.dz);
  for (let iteration = 0; iteration < 8; iteration++) {
    const sdf = field.sampleSdf(point.x, point.z);
    if (sdf == null || sdf <= -clearance) break;
    const sx1 = field.sampleSdf(point.x + e, point.z);
    const sx0 = field.sampleSdf(point.x - e, point.z);
    const sz1 = field.sampleSdf(point.x, point.z + e);
    const sz0 = field.sampleSdf(point.x, point.z - e);
    if ([sx1, sx0, sz1, sz0].some((value) => value == null)) break;
    let gx = sx1 - sx0, gz = sz1 - sz0;
    const gl = Math.hypot(gx, gz) || 1;
    gx /= gl; gz /= gl;
    const push = sdf + clearance + 0.4;
    point.x -= gx * push;
    point.z -= gz * push;
  }
  return point;
}

export function buildNavigableCoastalRoute(field, fromX, fromZ, dockX, dockZ, clearance = 7.4) {
  const cx = 0, cz = 34;
  const startA = Math.atan2(fromZ - cz, fromX - cx);
  const targetA = Math.atan2(dockZ - cz, dockX - cx);
  const delta = signedAngle(targetA - startA);
  const steps = Math.max(2, Math.ceil(Math.abs(delta) / 0.24));
  const skeleton = [{ x: fromX, z: fromZ }];
  for (let i = 0; i <= steps; i++) {
    const angle = startA + delta * (i / steps);
    skeleton.push({ x: cx + Math.cos(angle) * 106, z: cz + Math.sin(angle) * 86 });
  }
  skeleton.push({ x: dockX, z: dockZ });
  const route = [];
  for (let leg = 1; leg < skeleton.length; leg++) {
    const a = skeleton[leg - 1], b = skeleton[leg];
    const distance = Math.hypot(b.x - a.x, b.z - a.z);
    const subdivisions = Math.max(1, Math.ceil(distance / 4));
    for (let i = 1; i <= subdivisions; i++) {
      const t = i / subdivisions;
      route.push(projectRoutePointToWater(field, {
        x: mix(a.x, b.x, t),
        z: mix(a.z, b.z, t),
      }, clearance));
    }
  }
  return route;
}

export function verifyDockNavigation(field, clearance = 7) {
  return TERRAIN_DOCKS.map((dock) => {
    const sdf = field.sampleSdf(dock.x, dock.z);
    const radial = Math.atan2(dock.z - 34, dock.x);
    let channelMinClearance = Infinity;
    for (let d = 0; d <= 20; d += 1) {
      const sample = field.sampleSdf(dock.x + Math.cos(radial) * d, dock.z + Math.sin(radial) * d);
      // Reaching the edge of the bounded island dataset means this channel has
      // already opened into the unbounded ocean; only in-bounds samples constrain it.
      if (sample != null) channelMinClearance = Math.min(channelMinClearance, -sample);
    }
    return { id: dock.id, sdf, clearance: -sdf, channelMinClearance, navigable: sdf <= -clearance && channelMinClearance >= clearance };
  });
}
