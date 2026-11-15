import * as THREE from "three";
import {
  appendAfterShaderChunk,
  patchTerrainFragmentChunks,
} from "./terrain-shader-patches.mjs";
import {
  normalizeQualityTier,
  QUALITY_PROFILES,
} from "./quality-config.mjs";

const TERRAIN_TEXTURE_ROOT = "./assets/textures/terrain";
const ROTATED_SAMPLE_RADIANS = 33 * Math.PI / 180;
const ROTATED_SAMPLE_SCALE = 0.47;
const ROTATED_SAMPLE_MIX = 0.14;
const BOUNDARY_FBM_LOW = 0.035;
const BOUNDARY_FBM_HIGH = 0.17;

const LAYERS = [
  { name: "sand", tile: 5.2, fallback: [0xd8c28f, 0.92] },
  { name: "drygrass", tile: 3.5, fallback: [0x8c8050, 0.94] },
  { name: "scrub", tile: 4.5, fallback: [0x5f7042, 0.96] },
  { name: "limestone", tile: 6.0, fallback: [0xb9b09c, 0.9] },
  { name: "scree", tile: 2.5, fallback: [0x756f64, 0.96] },
];

function makeCanvas(size = 512) {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  return canvas;
}

function fallbackCanvas(kind, layer) {
  const canvas = makeCanvas();
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const image = ctx.createImageData(canvas.width, canvas.height);
  const color = layer.fallback[0];
  const baseR = (color >> 16) & 255;
  const baseG = (color >> 8) & 255;
  const baseB = color & 255;
  let state = 0x6d2b79f5 ^ (LAYERS.indexOf(layer) * 0x9e3779b9);
  const random = () => {
    state = Math.imul(state ^ (state >>> 15), state | 1);
    state ^= state + Math.imul(state ^ (state >>> 7), state | 61);
    return ((state ^ (state >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = 0; i < image.data.length; i += 4) {
    const grain = random() - 0.5;
    if (kind === "albedo") {
      image.data[i] = Math.max(0, Math.min(255, baseR + grain * 22));
      image.data[i + 1] = Math.max(0, Math.min(255, baseG + grain * 18));
      image.data[i + 2] = Math.max(0, Math.min(255, baseB + grain * 14));
    } else if (kind === "normal") {
      image.data[i] = 128 + grain * 8;
      image.data[i + 1] = 128 + (random() - 0.5) * 8;
      image.data[i + 2] = 255;
    } else {
      const scalar = kind === "ao" ? 244 + grain * 10 : layer.fallback[1] * 255 + grain * 12;
      image.data[i] = image.data[i + 1] = image.data[i + 2] = Math.max(0, Math.min(255, scalar));
    }
    image.data[i + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

function fallbackCanvasFromWorker(kind, layer) {
  if (typeof Worker === "undefined") return Promise.resolve(fallbackCanvas(kind, layer));
  return new Promise((resolve) => {
    const worker = new Worker(new URL("./terrain-texture-fallback-worker.js", import.meta.url));
    let settled = false;
    const finishWithMainThreadFallback = () => {
      if (settled) return;
      settled = true;
      worker.terminate();
      resolve(fallbackCanvas(kind, layer));
    };
    worker.onerror = finishWithMainThreadFallback;
    worker.onmessage = (event) => {
      try {
        const { width, height, data } = event.data;
        const canvas = makeCanvas();
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        ctx.putImageData(new ImageData(data, width, height), 0, 0);
        settled = true;
        worker.terminate();
        resolve(canvas);
      } catch (error) {
        finishWithMainThreadFallback();
      }
    };
    worker.postMessage({
      kind,
      layerName: layer.name,
      layerIndex: LAYERS.indexOf(layer),
      size: 512,
    });
  });
}

function loadImage(loader, url, kind, layer) {
  return new Promise((resolve) => {
    loader.load(
      url,
      resolve,
      undefined,
      (error) => {
        console.warn(`[voyage] terrain ${layer.name}/${kind}.jpg failed; using deterministic fallback`, error);
        fallbackCanvasFromWorker(kind, layer).catch(() => fallbackCanvas(kind, layer)).then(resolve);
      },
    );
  });
}

function imageDimension(image, key) {
  return image[key] || image[key === "width" ? "naturalWidth" : "naturalHeight"] || 512;
}

function drawPixels(image, width, height) {
  const canvas = makeCanvas();
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(image, 0, 0, width, height);
  return ctx.getImageData(0, 0, width, height).data;
}

// Source normal maps are OpenGL convention. Preserve XY, place roughness in B
// and AO in A; Z is reconstructed in the shader. This turns three source images
// into the packed NRA map required by the canonical material architecture.
function packNra(normalImage, roughnessImage, aoImage) {
  const width = imageDimension(normalImage, "width");
  const height = imageDimension(normalImage, "height");
  const normal = drawPixels(normalImage, width, height);
  const roughness = drawPixels(roughnessImage, width, height);
  const ao = drawPixels(aoImage, width, height);
  const canvas = makeCanvas();
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const packed = ctx.createImageData(width, height);
  for (let i = 0; i < packed.data.length; i += 4) {
    packed.data[i] = normal[i];
    packed.data[i + 1] = normal[i + 1];
    packed.data[i + 2] = roughness[i];
    packed.data[i + 3] = ao[i];
  }
  ctx.putImageData(packed, 0, 0);
  return canvas;
}

function configureTexture(texture, renderer, isAlbedo) {
  texture.colorSpace = isAlbedo ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  texture.needsUpdate = true;
  return texture;
}

export async function loadTerrainMaterialAssets(renderer, onProgress = () => {}) {
  const manager = new THREE.LoadingManager();
  manager.onStart = () => onProgress(0);
  manager.onProgress = (url, loaded, total) => onProgress(total > 0 ? loaded / total : 0);
  manager.onLoad = () => onProgress(1);
  const loader = new THREE.ImageLoader(manager);

  const results = await Promise.all(LAYERS.map(async (layer) => {
    const root = `${TERRAIN_TEXTURE_ROOT}/${layer.name}`;
    const [albedoImage, normalImage, roughnessImage, aoImage] = await Promise.all([
      loadImage(loader, `${root}/albedo.jpg`, "albedo", layer),
      loadImage(loader, `${root}/normal.jpg`, "normal", layer),
      loadImage(loader, `${root}/roughness.jpg`, "roughness", layer),
      loadImage(loader, `${root}/ao.jpg`, "ao", layer),
    ]);
    return {
      albedo: configureTexture(new THREE.Texture(albedoImage), renderer, true),
      nra: configureTexture(new THREE.CanvasTexture(packNra(normalImage, roughnessImage, aoImage)), renderer, false),
    };
  }));

  return {
    albedo: results.map((result) => result.albedo),
    nra: results.map((result) => result.nra),
    tileScales: LAYERS.map((layer) => layer.tile),
  };
}

function samplerUniforms(prefix, textures) {
  const uniforms = {};
  textures.forEach((texture, index) => {
    uniforms[`${prefix}${index}`] = { value: texture };
  });
  return uniforms;
}

export function createTerrainMaterial(assets, terrainFieldTextures, terrainBounds, options = {}) {
  const rockMode = options.rockMode === true;
  const landmarkMode = options.landmarkMode === true;
  const landmarkTileMeters = options.tileMeters || 5.2;
  let quality = normalizeQualityTier(options.quality) || "high";
  let qualityProfile = QUALITY_PROFILES[quality].terrainShader;
  const material = new THREE.MeshStandardMaterial({
    color: landmarkMode ? (options.tint || 0xc6bca7) : 0xffffff,
    vertexColors: landmarkMode,
    roughness: 1,
    metalness: 0,
    flatShading: false,
  });
  material.envMapIntensity = landmarkMode ? 0.58 : (rockMode ? 0.52 : 0.36);
  material.name = landmarkMode
    ? `voyage-landmark-limestone-pbr-r6-${options.variant || "weathered"}`
    : (rockMode ? "voyage-rock-triplanar-pbr-r5" : "voyage-terrain-pbr-r3");
  material.userData.terrainTime = 0;
  material.userData.quality = quality;
  material.userData.terrainShaderVariant = qualityProfile.variant;
  material.userData.setQuality = (nextQuality) => {
    const normalized = normalizeQualityTier(nextQuality);
    if (!normalized || normalized === quality) return;
    quality = normalized;
    qualityProfile = QUALITY_PROFILES[quality].terrainShader;
    material.userData.quality = quality;
    material.userData.terrainShaderVariant = qualityProfile.variant;
    material.userData.terrainShader = null;
    material.needsUpdate = true;
  };

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, samplerUniforms("uTerrainAlbedo", assets.albedo));
    Object.assign(shader.uniforms, samplerUniforms("uTerrainNra", assets.nra));
    shader.uniforms.uTerrainTileScales = {
      value: landmarkMode
        ? assets.tileScales.map((value, index) => index === 3 ? landmarkTileMeters : value)
        : assets.tileScales,
    };
    shader.uniforms.uTerrainSplat = { value: terrainFieldTextures.splat };
    shader.uniforms.uTerrainBounds = { value: new THREE.Vector4(
      terrainBounds.minX, terrainBounds.minZ, terrainBounds.maxX, terrainBounds.maxZ,
    ) };
    shader.uniforms.uTerrainControlSize = { value: new THREE.Vector2(terrainBounds.width, terrainBounds.height) };
    shader.uniforms.uTerrainTime = { value: material.userData.terrainTime };
    material.userData.terrainShader = shader;

    shader.vertexShader = appendAfterShaderChunk(shader.vertexShader, "common", `
        attribute float terrainAO;
        varying vec3 vTerrainWorldPos;
        varying vec3 vTerrainWorldNormal;
        varying float vTerrainAO;`);
    shader.vertexShader = appendAfterShaderChunk(shader.vertexShader, "begin_vertex", `
        vec4 terrainInstancePosition = vec4(transformed, 1.0);
        vec3 terrainInstanceNormal = normal;
        #ifdef USE_INSTANCING
          terrainInstancePosition = instanceMatrix * terrainInstancePosition;
          mat3 terrainInstanceMatrix = mat3(instanceMatrix);
          terrainInstanceNormal /= vec3(
            dot(terrainInstanceMatrix[0], terrainInstanceMatrix[0]),
            dot(terrainInstanceMatrix[1], terrainInstanceMatrix[1]),
            dot(terrainInstanceMatrix[2], terrainInstanceMatrix[2])
          );
          terrainInstanceNormal = terrainInstanceMatrix * terrainInstanceNormal;
        #endif
        vTerrainWorldPos = (modelMatrix * terrainInstancePosition).xyz;
        vTerrainWorldNormal = normalize(mat3(modelMatrix) * terrainInstanceNormal);
        vTerrainAO = terrainAO;`);

    shader.fragmentShader = appendAfterShaderChunk(shader.fragmentShader, "common", `
        #define TERRAIN_LAYER_COUNT ${qualityProfile.layerCount}
        #define TERRAIN_ACTIVE_LAYERS ${qualityProfile.blendLayers}
        #define TERRAIN_TRIPLANAR_AXES ${qualityProfile.triplanarAxes}
        #define TERRAIN_ROTATED_SAMPLES ${qualityProfile.rotatedSamples ? 1 : 0}
        #define TERRAIN_MERGED_LAYERS ${qualityProfile.layerCount === 3 ? 1 : 0}
        varying vec3 vTerrainWorldPos;
        varying vec3 vTerrainWorldNormal;
        varying float vTerrainAO;
        uniform sampler2D uTerrainAlbedo0;
        uniform sampler2D uTerrainAlbedo1;
        uniform sampler2D uTerrainAlbedo2;
        uniform sampler2D uTerrainAlbedo3;
        uniform sampler2D uTerrainAlbedo4;
        uniform sampler2D uTerrainNra0;
        uniform sampler2D uTerrainNra1;
        uniform sampler2D uTerrainNra2;
        uniform sampler2D uTerrainNra3;
        uniform sampler2D uTerrainNra4;
        uniform sampler2D uTerrainSplat;
        uniform vec4 uTerrainBounds;
        uniform vec2 uTerrainControlSize;
        uniform float uTerrainTime;
        uniform float uTerrainTileScales[5];
        vec3 terrainLayerColor;
        vec3 terrainLayerWorldNormal;
        float terrainLayerRoughness;
        float terrainLayerAO;
        float terrainWetBand;

        float terrainHash(vec2 p) {
          p = fract(p * vec2(123.34, 345.45));
          p += dot(p, p + 34.345);
          return fract(p.x * p.y);
        }
        float terrainNoise(vec2 p) {
          vec2 i = floor(p), f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          return mix(mix(terrainHash(i), terrainHash(i + vec2(1.0, 0.0)), f.x),
                     mix(terrainHash(i + vec2(0.0, 1.0)), terrainHash(i + vec2(1.0)), f.x), f.y);
        }
        float terrainBoundaryFbm(vec2 p, float seed) {
          float low = terrainNoise(p * ${BOUNDARY_FBM_LOW.toFixed(3)} + seed);
          float high = terrainNoise(p * ${BOUNDARY_FBM_HIGH.toFixed(2)} + seed * 2.71);
          return low * 0.64 + high * 0.36;
        }
        vec3 terrainAlbedo(int layer, vec2 uv) {
          if (layer == 0) return texture2D(uTerrainAlbedo0, uv).rgb;
          if (layer == 1) return texture2D(uTerrainAlbedo1, uv).rgb;
          if (layer == 2) return texture2D(uTerrainAlbedo2, uv).rgb;
          if (layer == 3) return texture2D(uTerrainAlbedo3, uv).rgb;
          return texture2D(uTerrainAlbedo4, uv).rgb;
        }
        vec4 terrainNra(int layer, vec2 uv) {
          if (layer == 0) return texture2D(uTerrainNra0, uv);
          if (layer == 1) return texture2D(uTerrainNra1, uv);
          if (layer == 2) return texture2D(uTerrainNra2, uv);
          if (layer == 3) return texture2D(uTerrainNra3, uv);
          return texture2D(uTerrainNra4, uv);
        }
        vec3 terrainDecodeNormal(vec2 xy) {
          vec2 nxy = xy * 2.0 - 1.0;
          return normalize(vec3(nxy, sqrt(max(1.0 - dot(nxy, nxy), 0.0))));
        }
        void terrainProjection(int axis, vec3 p, vec3 surfaceN,
                               out vec2 uv, out vec3 tangent, out vec3 bitangent, out vec3 axisN) {
          if (axis == 0) {
            float s = surfaceN.x < 0.0 ? -1.0 : 1.0;
            uv = vec2(-s * p.z, p.y);
            tangent = vec3(0.0, 0.0, -s);
            bitangent = vec3(0.0, 1.0, 0.0);
            axisN = vec3(s, 0.0, 0.0);
          } else if (axis == 1) {
            float s = surfaceN.y < 0.0 ? -1.0 : 1.0;
            uv = vec2(p.x, -s * p.z);
            tangent = vec3(1.0, 0.0, 0.0);
            bitangent = vec3(0.0, 0.0, -s);
            axisN = vec3(0.0, s, 0.0);
          } else {
            float s = surfaceN.z < 0.0 ? -1.0 : 1.0;
            uv = vec2(s * p.x, p.y);
            tangent = vec3(s, 0.0, 0.0);
            bitangent = vec3(0.0, 1.0, 0.0);
            axisN = vec3(0.0, 0.0, s);
          }
        }
        vec3 terrainRotateBetween(vec3 value, vec3 fromN, vec3 toN) {
          float c = clamp(dot(fromN, toN), -0.9999, 1.0);
          vec3 v = cross(fromN, toN);
          return normalize(value * c + cross(v, value) + v * (dot(v, value) / (1.0 + c)));
        }
        mat3 terrainSurfaceBasis(vec3 n) {
          vec3 t = normalize(abs(n.y) < 0.999 ? cross(vec3(0.0, 1.0, 0.0), n) : cross(vec3(1.0, 0.0, 0.0), n));
          return mat3(t, cross(n, t), n);
        }
        vec3 terrainRnm(vec3 base, vec3 detail) {
          vec3 t = base + vec3(0.0, 0.0, 1.0);
          vec3 u = detail * vec3(-1.0, -1.0, 1.0);
          return normalize(t * dot(t, u) / max(t.z, 0.0001) - u);
        }
        vec3 terrainBlendWorldNormals(vec3 baseWorld, vec3 detailWorld, vec3 surfaceN, float strength) {
          mat3 basis = terrainSurfaceBasis(surfaceN);
          vec3 base = normalize(vec3(dot(baseWorld, basis[0]), dot(baseWorld, basis[1]), dot(baseWorld, basis[2])));
          vec3 detail = normalize(vec3(dot(detailWorld, basis[0]), dot(detailWorld, basis[1]), dot(detailWorld, basis[2])));
          detail = normalize(vec3(detail.xy * strength, mix(1.0, detail.z, strength)));
          return normalize(basis * terrainRnm(base, detail));
        }
        void terrainAxisSample(int layer, int axis, vec3 surfaceN, bool secondary,
                               out vec3 color, out vec3 worldN, out float roughnessValue, out float aoValue) {
          int textureLayer = TERRAIN_MERGED_LAYERS == 1 && layer == 2 ? 3 : layer;
          vec2 uv;
          vec3 tangent, bitangent, axisN;
          terrainProjection(axis, vTerrainWorldPos, surfaceN, uv, tangent, bitangent, axisN);
          uv /= uTerrainTileScales[textureLayer];
          if (secondary) {
            float c = ${Math.cos(ROTATED_SAMPLE_RADIANS).toFixed(8)};
            float s = ${Math.sin(ROTATED_SAMPLE_RADIANS).toFixed(8)};
            uv = mat2(c, s, -s, c) * uv * ${ROTATED_SAMPLE_SCALE.toFixed(2)};
            vec3 oldTangent = tangent;
            tangent = c * oldTangent - s * bitangent;
            bitangent = s * oldTangent + c * bitangent;
          }
          color = terrainAlbedo(textureLayer, uv);
          vec4 nra = terrainNra(textureLayer, uv);
          vec3 tangentN = terrainDecodeNormal(nra.rg);
          worldN = normalize(tangent * tangentN.x + bitangent * tangentN.y + axisN * tangentN.z);
          worldN = terrainRotateBetween(worldN, axisN, surfaceN);
          roughnessValue = nra.b;
          aoValue = nra.a;
        }
        int terrainDominantAxis(vec3 weights) {
          return weights.x > weights.y ? (weights.x > weights.z ? 0 : 2) : (weights.y > weights.z ? 1 : 2);
        }
        void terrainSampleLayer(int layer, vec3 surfaceN, bool primary,
                                out vec3 color, out vec3 worldN, out float roughnessValue, out float aoValue) {
          int textureLayer = TERRAIN_MERGED_LAYERS == 1 && layer == 2 ? 3 : layer;
          bool triplanar = textureLayer >= 3;
          vec3 axisWeights = pow(abs(surfaceN), vec3(5.0));
          axisWeights /= max(dot(axisWeights, vec3(1.0)), 0.0001);
          int dominant = terrainDominantAxis(axisWeights);
          vec3 c0, c1, c2, n0, n1, n2;
          float r0, r1, r2, a0, a1, a2;
          if (triplanar && primary && TERRAIN_TRIPLANAR_AXES == 3) {
            terrainAxisSample(layer, 0, surfaceN, false, c0, n0, r0, a0);
            terrainAxisSample(layer, 1, surfaceN, false, c1, n1, r1, a1);
            terrainAxisSample(layer, 2, surfaceN, false, c2, n2, r2, a2);
            color = c0 * axisWeights.x + c1 * axisWeights.y + c2 * axisWeights.z;
            worldN = normalize(n0 * axisWeights.x + n1 * axisWeights.y + n2 * axisWeights.z);
            roughnessValue = dot(vec3(r0, r1, r2), axisWeights);
            aoValue = dot(vec3(a0, a1, a2), axisWeights);
          } else {
            int axis = triplanar ? dominant : 1;
            terrainAxisSample(layer, axis, surfaceN, false, color, worldN, roughnessValue, aoValue);
          }
          int secondaryAxis = triplanar ? dominant : 1;
          if (TERRAIN_ROTATED_SAMPLES == 1) {
            if (primary) {
              vec3 secondaryColor, secondaryN;
              float secondaryRoughness, secondaryAO;
              terrainAxisSample(layer, secondaryAxis, surfaceN, true,
                                secondaryColor, secondaryN, secondaryRoughness, secondaryAO);
              color = mix(color, secondaryColor, ${ROTATED_SAMPLE_MIX.toFixed(2)});
              worldN = terrainBlendWorldNormals(worldN, secondaryN, surfaceN, ${ROTATED_SAMPLE_MIX.toFixed(2)});
              roughnessValue = mix(roughnessValue, secondaryRoughness, ${ROTATED_SAMPLE_MIX.toFixed(2)});
              aoValue = mix(aoValue, secondaryAO, ${ROTATED_SAMPLE_MIX.toFixed(2)});
            } else {
              vec2 secondaryUv;
              vec3 secondaryTangent, secondaryBitangent, secondaryAxisN;
              terrainProjection(secondaryAxis, vTerrainWorldPos, surfaceN,
                                secondaryUv, secondaryTangent, secondaryBitangent, secondaryAxisN);
              secondaryUv /= uTerrainTileScales[textureLayer];
              float c = ${Math.cos(ROTATED_SAMPLE_RADIANS).toFixed(8)};
              float s = ${Math.sin(ROTATED_SAMPLE_RADIANS).toFixed(8)};
              secondaryUv = mat2(c, s, -s, c) * secondaryUv * ${ROTATED_SAMPLE_SCALE.toFixed(2)};
              color = mix(color, terrainAlbedo(textureLayer, secondaryUv), ${ROTATED_SAMPLE_MIX.toFixed(2)});
            }
          }
        }
        vec3 terrainHueRotate(vec3 color, float angle) {
          vec3 axis = normalize(vec3(1.0));
          return color * cos(angle) + cross(axis, color) * sin(angle) + axis * dot(axis, color) * (1.0 - cos(angle));
        }
        void terrainEvaluate() {
          vec3 surfaceN = normalize(vTerrainWorldNormal);
          vec2 controlUnitUv = (vTerrainWorldPos.xz - uTerrainBounds.xy) / (uTerrainBounds.zw - uTerrainBounds.xy);
          vec2 controlUv = (controlUnitUv * (uTerrainControlSize - 1.0) + 0.5) / uTerrainControlSize;
          vec4 weights4 = max(texture2D(uTerrainSplat, clamp(controlUv, 0.0, 1.0)), vec4(0.0));
          float weights[TERRAIN_LAYER_COUNT];
          ${qualityProfile.layerCount === 3 ? `
          // Mobile preserves the master splat morphology while merging adjacent
          // material families: sand / vegetation / exposed limestone+scree.
          weights[0] = weights4.r;
          weights[1] = weights4.g + weights4.b;
          weights[2] = weights4.a + max(0.0, 1.0 - dot(weights4, vec4(1.0)));` : `
          weights[0] = weights4.r;
          weights[1] = weights4.g;
          weights[2] = weights4.b;
          weights[3] = weights4.a;
          weights[4] = max(0.0, 1.0 - dot(weights4, vec4(1.0)));`}
          ${rockMode && qualityProfile.layerCount === 3 ? `
          weights[0] = 0.0;
          weights[1] = 0.0;
          weights[2] = 1.0;` : rockMode ? `
          // R5 boulders use this exact terrain projection and texture path but
          // deliberately restrict selection to limestone and scree. World-space
          // breakup keeps adjacent instances from reading as cloned material.
          float rockLayerNoise = terrainBoundaryFbm(vTerrainWorldPos.xz * 0.44 + vTerrainWorldPos.y * 0.09, 73.1);
          weights[0] = 0.0;
          weights[1] = 0.0;
          weights[2] = 0.0;
          weights[3] = mix(0.58, 0.86, rockLayerNoise);
          weights[4] = 1.0 - weights[3];` : ""}
          ${landmarkMode && qualityProfile.layerCount === 3 ? `
          weights[0] = 0.0;
          weights[1] = 0.0;
          weights[2] = 1.0;` : landmarkMode ? `
          // R6 architecture stays on the same world-space limestone/scree path
          // as terrain rocks. Vertex color carries per-source hue variation and
          // the terrainAO attribute carries the baked low-edge/cavity grime.
          float landmarkGrime = terrainBoundaryFbm(vTerrainWorldPos.xz * 0.31 + vTerrainWorldPos.y * 0.07, 119.4);
          weights[0] = 0.0;
          weights[1] = 0.0;
          weights[2] = 0.0;
          weights[3] = mix(0.86, 0.96, landmarkGrime);
          weights[4] = 1.0 - weights[3];` : ""}
          for (int i = 0; i < TERRAIN_LAYER_COUNT; i++) {
            float breakup = terrainBoundaryFbm(vTerrainWorldPos.xz, float(i) * 11.73 + 3.1) - 0.5;
            weights[i] = max(0.0, weights[i] + breakup * 0.24 * weights[i] * (1.0 - weights[i]));
          }
          int first = 0;
          float firstWeight = weights[0];
          for (int i = 1; i < TERRAIN_LAYER_COUNT; i++) {
            if (weights[i] > firstWeight) { first = i; firstWeight = weights[i]; }
          }
          int second = first == 0 ? 1 : 0;
          float secondWeight = weights[second];
          for (int i = 0; i < TERRAIN_LAYER_COUNT; i++) {
            if (i != first && weights[i] > secondWeight) { second = i; secondWeight = weights[i]; }
          }
          float pairTotal = max(firstWeight + secondWeight, 0.0001);
          float layerMix = TERRAIN_ACTIVE_LAYERS > 1 ? secondWeight / pairTotal : 0.0;
          vec3 colorA, colorB, normalA, normalB;
          float roughA, roughB, aoA, aoB;
          terrainSampleLayer(first, surfaceN, true, colorA, normalA, roughA, aoA);
          if (TERRAIN_ACTIVE_LAYERS > 1) {
            terrainSampleLayer(second, surfaceN, false, colorB, normalB, roughB, aoB);
          } else {
            colorB = colorA;
            normalB = normalA;
            roughB = roughA;
            aoB = aoA;
          }
          // The downloaded drygrass/scrub albedos are neutral tan in aggregate;
          // restore the plan's golden and olive read before daylight tonemapping.
          ${qualityProfile.layerCount === 3 ? `
          if (first == 1) colorA *= vec3(0.92, 0.90, 0.68);
          if (second == 1) colorB *= vec3(0.92, 0.90, 0.68);
          if (first == 2) colorA *= vec3(1.02, 0.99, 0.93);
          if (second == 2) colorB *= vec3(1.02, 0.99, 0.93);` : `
          if (first == 1) colorA *= vec3(1.03, 0.88, 0.65);
          if (second == 1) colorB *= vec3(1.03, 0.88, 0.65);
          if (first == 2) colorA *= vec3(0.72, 0.88, 0.64);
          if (second == 2) colorB *= vec3(0.72, 0.88, 0.64);
          if (first == 3) colorA *= vec3(1.02, 0.99, 0.93);
          if (second == 3) colorB *= vec3(1.02, 0.99, 0.93);
          if (first == 4) colorA *= 0.82;
          if (second == 4) colorB *= 0.82;`}
          terrainLayerColor = mix(colorA, colorB, layerMix);
          terrainLayerWorldNormal = terrainBlendWorldNormals(normalA, normalB, surfaceN, layerMix);
          terrainLayerRoughness = clamp(mix(roughA, roughB, layerMix), 0.34, 1.0);
          terrainLayerAO = mix(aoA, aoB, layerMix);
          float macro = terrainBoundaryFbm(vTerrainWorldPos.xz * 0.31, 41.7) * 2.0 - 1.0;
          terrainLayerColor = terrainHueRotate(terrainLayerColor, macro * radians(3.5));
          terrainLayerColor *= 1.0 + macro * 0.06;

          // R3 wet sand: a deliberately narrow, irregular tidal stain. Fine
          // 0.6u breakup cuts the edge while the 2.4u scale controls the extra
          // 0..0.8u run-up. Only the beach splat participates, preventing a
          // graphic dark outline from wrapping cliffs and rocky headlands.
          float wetFine = terrainNoise(vTerrainWorldPos.xz / 0.6 + vec2(17.3, -8.1));
          float wetCoarse = terrainNoise(vTerrainWorldPos.xz / 2.4 + vec2(-3.7, 12.9));
          float slowShore = terrainNoise(vTerrainWorldPos.xz / 5.8
            + vec2(uTerrainTime * 0.018, -uTerrainTime * 0.013));
          float wetlineDrift = (slowShore * 2.0 - 1.0) * 0.15;
          float raggedRunup = clamp(wetCoarse * 0.68 + wetFine * 0.32, 0.0, 1.0) * 0.8;
          float wetTop = 0.55 + raggedRunup + wetlineDrift;
          float wetHeightBand = smoothstep(-0.23, -0.15, vTerrainWorldPos.y)
            * (1.0 - smoothstep(wetTop - 0.09, wetTop + 0.07, vTerrainWorldPos.y));
          float wetBeachMask = ${rockMode || landmarkMode ? "0.0" : "smoothstep(0.18, 0.58, weights4.r)"};
          float wetBand = clamp(wetHeightBand * wetBeachMask, 0.0, 1.0);
          terrainWetBand = wetBand;
          float wetDarken = mix(0.62, 0.72, wetFine * 0.42 + wetCoarse * 0.58);
          float wetLuma = dot(terrainLayerColor, vec3(0.2126, 0.7152, 0.0722));
          vec3 wetSaturated = mix(vec3(wetLuma), terrainLayerColor, 1.05) * wetDarken;
          terrainLayerColor = mix(terrainLayerColor, wetSaturated, wetBand);
          terrainLayerRoughness = mix(terrainLayerRoughness, mix(0.38, 0.50, wetCoarse), wetBand);
          terrainLayerWorldNormal = normalize(mix(
            surfaceN,
            terrainLayerWorldNormal,
            1.0 - wetBand * 0.20
          ));
        }`);
    shader.fragmentShader = patchTerrainFragmentChunks(shader.fragmentShader);
  };

  // Fetch accounting at high tier: TerrainField splat control = 1; primary
  // cliff/scree 3 axes x 2 maps + rotated dominant axis x 2 maps = 8;
  // secondary top-two layer base PBR (2) + rotated albedo (1) = 3. Total = 12.
  material.customProgramCacheKey = () => [
    "terrain-pbr-r5",
    landmarkMode ? `landmark-${options.variant || "weathered"}` : (rockMode ? "rocks" : "ground"),
    landmarkMode ? landmarkTileMeters : 0,
    qualityProfile.variant,
    qualityProfile.blendLayers,
    qualityProfile.triplanarAxes,
    qualityProfile.fetchBudget,
  ].join("-");
  return material;
}

export function setTerrainMaterialQuality(material, quality) {
  if (material && material.userData && typeof material.userData.setQuality === "function") {
    material.userData.setQuality(quality);
  }
}

export function updateTerrainMaterialTime(material, time) {
  if (!material || !material.userData) return;
  material.userData.terrainTime = time;
  const shader = material.userData.terrainShader;
  if (shader && shader.uniforms && shader.uniforms.uTerrainTime) {
    shader.uniforms.uTerrainTime.value = time;
  }
}
