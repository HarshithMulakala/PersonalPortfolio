// voyage.js
// The playable 3D voyage for "An Odyssey". A ship circles one continuous
// Mediterranean island whose five coastal regions hold the portfolio chapters.
// Owner: Build Agent B. This module owns only itself and the joystick children it
// creates inside #joystick-zone. Everything else belongs to the page.

import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import {
  generateTerrainField,
  hydrateTerrainField,
  TERRAIN_BOUNDS,
  TERRAIN_DOCKS,
  TERRAIN_PADS,
  buildNavigableCoastalRoute,
  verifyDockNavigation,
} from "./terrain-field.mjs";
import {
  createTerrainMaterial,
  setTerrainMaterialQuality,
  loadTerrainMaterialAssets,
  updateTerrainMaterialTime,
} from "./terrain-material.mjs";
import {
  buildOceanFragmentShader,
} from "./ocean-shader.mjs";
import {
  ENV_MAP_INTENSITY,
  PHYSICAL_LIGHTING,
  SHADOW_CONFIG,
  SUN_DIRECTION,
  SUN_ELEVATION_DEGREES,
} from "./lighting-config.mjs";
import { buildR5Scatter } from "./r5-scatter.mjs";
import {
  foundationGeometry,
  mergeGlbLandmark,
  mergeScenePrimitives,
  terrainFoundationGeometry,
} from "./r6-landmark-geometry.mjs";
import { R6_LANDMARK_CONFIG } from "./r6-landmark-config.mjs";
import {
  R6_LANDMARK_GROUNDING,
  footprintY as sampleFootprintY,
  laborsSteleGrounding,
} from "./r6-landmark-grounding.mjs";
import {
  nextQualityTier,
  normalizeQualityTier,
  QUALITY_PROFILES,
  RUNTIME_QUALITY,
} from "./quality-config.mjs";

// ---------------------------------------------------------------------------
// Palette (linear via ColorManagement). These match the site tokens.
// ---------------------------------------------------------------------------
const COL = {
  seaDeep: 0x0b3550,
  seaCrest: 0x17647a,
  seaShallow: 0x2fa8a0,
  amber: 0xe78b34, // warm accent (braziers, hearths, beacons)
  amberDeep: 0xd46d07,
  peach: 0xfecb99,
  cream: 0xffe9bb, // warm white glitter on the sun road
  tan: 0xcab6a4,
  sun: 0xfff3d6, // bright warm sun disc
  skyZenith: 0x4f7698,
  skyHorizon: 0xe7c9a7,
  skyWater: 0xf0d6b6,
  haze: 0xd8c7b1,
  rock: 0xa79d87,
  rockLight: 0xc7bda5,
  sand: 0xe8d3a4,
  foliage: 0x617044,
  marble: 0xefe9dd, // bright daylight marble
  wake: 0xffffff, // bright white foam that reads on blue (F4)
  cloudTop: 0xffe8cf,
  cloudUnder: 0xa79a98,
  flame: 0xffd27a, // golden beacon flame
  mote: 0xffe6b8, // pale warm dust mote tint
};
const TERRAIN_VERTEX_LAYER_COLORS = [
  new THREE.Color(0xd8c28f),
  new THREE.Color(0x8c8050),
  new THREE.Color(0x5f7042),
  new THREE.Color(0xb9b09c),
  new THREE.Color(0x756f64),
];

// ---------------------------------------------------------------------------
// Ocean waves: SINGLE SOURCE OF TRUTH. Used both CPU side (buoyancy) and to
// generate the GLSL height function so the shader and physics never diverge.
// A calm sea: gentle long swell plus a couple of finer directional ripples.
// ---------------------------------------------------------------------------
const WAVES = [
  { dirX: 0.94, dirZ: 0.34, amp: 0.48, len: 46, speed: 0.48 },
  { dirX: -0.58, dirZ: 0.82, amp: 0.28, len: 29, speed: 0.66 },
  { dirX: 0.24, dirZ: -0.97, amp: 0.15, len: 18, speed: 0.88 },
  { dirX: 0.78, dirZ: -0.62, amp: 0.08, len: 10, speed: 1.18 },
  { dirX: -0.92, dirZ: -0.38, amp: 0.04, len: 6.5, speed: 1.46 },
];
const WAVE_C = WAVES.map((w) => {
  const l = Math.hypot(w.dirX, w.dirZ) || 1;
  return {
    nx: w.dirX / l,
    nz: w.dirZ / l,
    amp: w.amp,
    k: (Math.PI * 2) / w.len,
    speed: w.speed,
  };
});
const WAVE_AMP_TOTAL = WAVE_C.reduce((s, w) => s + w.amp, 0);

// Ship hull position for the calm ring. Updated every frame from syncWorld; the
// far default means "no damping" until the voyage initializes.
let _shipWX = 1e9;
let _shipWZ = 1e9;

// Calm ring around the hull: waves ease to 40% within ~2.5u of the ship and are
// untouched beyond 8u, so crests never slice through the deck. The SAME factor
// is applied in the GLSL below so CPU physics and GPU surface stay in lockstep.
function waveDamp(x, z) {
  const dx = x - _shipWX;
  const dz = z - _shipWZ;
  const d = Math.sqrt(dx * dx + dz * dz);
  if (d >= 10) return 1;
  if (d <= 3.5) return 0.25;
  const s = (d - 3.5) / 6.5;
  const sm = s * s * (3 - 2 * s);
  return 0.25 + 0.75 * sm;
}

// CPU wave height. x,z world coords, t seconds. Mirrors the generated GLSL below.
function waveHeight(x, z, t) {
  let h = 0;
  for (let i = 0; i < WAVE_C.length; i++) {
    const w = WAVE_C[i];
    h += w.amp * Math.sin((w.nx * x + w.nz * z) * w.k + t * w.speed);
  }
  return h * waveDamp(x, z);
}
// Build the identical GLSL height function from WAVE_C. p = vec2(x, z).
// Requires uniform vec3 uShipPos to be declared before injection.
function oceanHeightGLSL() {
  let g = "float oceanHeight(vec2 p, float t){\n  float h = 0.0;\n";
  for (const w of WAVE_C) {
    g += `  h += ${w.amp.toFixed(4)} * sin((${w.nx.toFixed(4)} * p.x + ${w.nz.toFixed(4)} * p.y) * ${w.k.toFixed(6)} + t * ${w.speed.toFixed(4)});\n`;
  }
  g += "  float shipD = distance(p, uShipPos.xz);\n";
  g += "  return h * mix(0.25, 1.0, smoothstep(3.5, 10.0, shipD));\n}\n";
  g += "vec2 oceanSlope(vec2 p, float t){\n  vec2 s = vec2(0.0);\n";
  for (const w of WAVE_C) {
    g += `  s += vec2(${w.nx.toFixed(4)}, ${w.nz.toFixed(4)}) * ${(w.amp * w.k).toFixed(6)} * cos((${w.nx.toFixed(4)} * p.x + ${w.nz.toFixed(4)} * p.y) * ${w.k.toFixed(6)} + t * ${w.speed.toFixed(4)});\n`;
  }
  g += "  float shipD = distance(p, uShipPos.xz);\n  return s * mix(0.25, 1.0, smoothstep(3.5, 10.0, shipD));\n}\n";
  return g;
}

// ---------------------------------------------------------------------------
// Layout, physics and tuning constants.
// ---------------------------------------------------------------------------
const PLAY_R = 225;
const MAIN_ISLAND = { x: 0, z: 34, rx: 78, rz: 58, coastRouteR: 94 };
// The opening lane is one deliberate sightline: ship -> Origins dock -> the
// acropolis on the summit. A straight W-hold therefore reaches the first dock
// naturally while the island hero stays composed beyond the bow.
const HERO_POINT = { x: -4, y: 18, z: 48 };
const SPAWN = {
  x: -47 - 43 * 0.7,
  z: -28 - 76 * 0.7,
  heading: Math.atan2(43, 76),
};
// Collision distances are world units in the shared signed-distance field.
// The six-unit hull remains at least seven units outside the rendered coast.
const SHORE_SAFE_DISTANCE = 7;
const SHORE_SOFT_DISTANCE = 13;
// A 45k-droplet cold benchmark measured 327.62ms on the target development
// machine. That exceeds the 200ms main-thread threshold and 250ms erosion budget,
// so Round 1 uses the plan's 18k fallback in a module Worker.
const TERRAIN_MAIN_THREAD_BENCHMARK_MS = 327.62;
const TERRAIN_EROSION_DROPLETS = 18000;
const COURSE_DASH_COUNT = 64;
// Lighter daytime haze than the night fog so islands read from much farther and
// fade into a bright blue-white horizon rather than vanishing into the dark (4).
const FOG_DENSITY = PHYSICAL_LIGHTING.fogDensity;
const OCEAN_SIZE = 520;

const PHYS = {
  accel: 14,
  maxSpeed: 22,
  drag: 1.4, // exp(-drag*dt)
  turnRate: 1.6,
  reverseFrac: 0.4,
};

// Chase camera offsets. Raised, pulled back, and pushed to a gentle three
// quarter angle (lateral offset) with the look target lowered, so the FULL hull
// bow through stern reads instead of the sails occluding the bow from dead
// astern (V2).
const CAM_OFF_X = 5.6;
const CAM_OFF_Y = 8.0;
const CAM_OFF_Z = -14.0;
const CAM_LOOK_Y = 1.2;

const TERRAIN_DOCK_BY_ID = new Map(TERRAIN_DOCKS.map((item) => [item.id, item]));
const TERRAIN_PAD_BY_ID = new Map(TERRAIN_PADS.map((item) => [item.id, item]));
function regionDef(id, name, tag, radius) {
  const pad = TERRAIN_PAD_BY_ID.get(id);
  const dock = TERRAIN_DOCK_BY_ID.get(id);
  return { id, name, tag, radius, kind: id, center: [pad.x, pad.z], dock: [dock.x, dock.z] };
}
const ISLAND_DEFS = [
  regionDef("origins", "Origins", "About", 14),
  regionDef("forge", "The Forge", "Skills", 13),
  regionDef("labors", "The Labors", "Projects", 18),
  regionDef("voyages", "The Voyages", "Experience", 14),
  regionDef("oracle", "The Oracle", "Contact", 13),
];

// Sun low on the horizon, slightly forward and to the right so the sun road on
// the water leads the visitor toward the Origins island they face at spawn. The
// name MOON_DIR is kept only so the many downstream references stay stable; by
// day it is the sun direction that lights the scene and paints the glitter road.
const MOON_DIR = new THREE.Vector3(...SUN_DIRECTION);

// Physical daylight carries the scene. Decorative point lights are removed;
// the only live local lights are the eased dock and beat accents during tours.
const DAY_EMISSIVE = 0.6; // scale for warm emissive glow markers

// ---------------------------------------------------------------------------
// Reusable scratch objects. NO per-frame allocation in the loop.
// ---------------------------------------------------------------------------
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3();
const _q1 = new THREE.Quaternion();
const _e1 = new THREE.Euler(0, 0, 0, "YXZ");
const _proj = new THREE.Vector3();
const _fwd = new THREE.Vector3();
// Extra scratch for the course line, beat cameras and attract/intro dolly.
const _m1 = new THREE.Matrix4();
const _sv = new THREE.Vector3();
const _pv = new THREE.Vector3();
const _cp = new THREE.Vector3();
const _cl = new THREE.Vector3();
const _colr = new THREE.Color();
const _e2 = new THREE.Euler(0, 0, 0, "YXZ");
// Build-time surface sampler: a down-cast ray used to seat every prop on the
// true (jittered) island surface instead of an estimated dome height (TASK A).
const _groundRay = new THREE.Raycaster();
const _groundFrom = new THREE.Vector3();
const _groundDir = new THREE.Vector3(0, -1, 0);
// Scratch camera used once per beat to project the anchor from the beat's FINAL
// pose, so the card side is decided up front and never flips mid-dolly (addendum 3).
const _sideCam = new THREE.PerspectiveCamera();

// ---------------------------------------------------------------------------
// Module state. One voyage per page.
// ---------------------------------------------------------------------------
let V = null;

function freshState() {
  return {
    opts: null,
    canvas: null,
    renderer: null,
    scene: null,
    camera: null,
    composer: null,
    bloom: null,
    sun: null,
    environmentTarget: null,
    environmentSize: 0,
    staticShadowsFrozen: false,
    quality: "high",
    profile: QUALITY_PROFILES.high,
    dprCap: QUALITY_PROFILES.high.dprCap,
    bloomEnabled: true,
    runtimeVegetationDensity: 1,
    runtimeGrassDistanceScale: 1,
    vegetationShadowsEnabled: true,
    perfSamples: [],
    perfWarmupFrames: 0,
    perfOverBudgetMs: 0,
    degradationStep: 0,
    degradationExhausted: false,
    lastProgress: 0,
    reducedMotion: false,
    isTouch: false,
    muted: true, // audio starts silent; the AudioContext is not created until the first unmute (V5)
    running: false,
    active: true,
    initialized: false,
    rafId: 0,
    time: 0,
    lastT: 0,
    // world groups
    ocean: null,
    oceanMat: null,
    ship: null,
    islands: [],
    wake: null,
    embers: [],
    sunMesh: null,
    sky: null, // day gradient dome that follows the camera (point 1)
    clouds: [], // procedural low-poly cumulus clusters (point 1)
    birds: null,
    terrain: null,
    cliffBand: null,
    terrainField: null,
    terrainTextures: null,
    terrainMaterial: null,
    rockMaterial: null,
    landmarkMaterials: null,
    terrainFallbackMaterial: null,
    terrainMaterialAssets: null,
    terrainWorker: null,
    r5Scatter: null,
    r5Stats: null,
    r6Census: {},
    flames: [], // per-island beacon flame plumes, ignited on visit (point 6)
    voyageComplete: false, // set once all five flames are lit (point 6)
    ruin: null, // colossal half-sunken ruin collidable (N3)
    motes: [], // per-island warm dust systems (N6)
    dockFill: null, // eased warm point light while docked (F3)
    dockFillLevel: 0,
    // Beat highlight: one shared warm light eases to the active exhibit and its
    // emissive materials pulse, so the docked beat frames a lit object (B6).
    beatLight: null,
    beatLightLevel: 0,
    beatIsland: null,
    // Shared loader for the small icon textures on plaques and banners (B1, B2).
    texManager: null,
    texLoader: null,
    lantern: { base: 5.5, emissive: 3.4, walk: 1 }, // stern lantern flicker (N4)
    ground: 0, // grounding scrape shudder amount (F1)
    undockFrom: { pos: new THREE.Vector3(), heading: 0 },
    undockTo: { pos: new THREE.Vector3(), heading: 0 },
    haveUndockTarget: false,
    // ship physics
    pos: new THREE.Vector3(0, 0, 0),
    heading: 0,
    speed: 0,
    bank: 0,
    // camera smoothing
    camLook: new THREE.Vector3(0, 1.5, 30),
    fov: 55,
    // mode: "idle" | "intro" | "sailing" | "docking" | "docked" | "undocking"
    mode: "idle",
    introT: 0,
    dockT: 0,
    dockFrom: { pos: new THREE.Vector3(), look: new THREE.Vector3() },
    dockTo: { pos: new THREE.Vector3(), look: new THREE.Vector3() },
    dockedIsland: null,
    nearIsland: null,
    // input
    keys: new Set(),
    touchThrottle: 0,
    touchTurn: 0,
    joyEls: null,
    // audio
    audio: null,
    // beat tour (docked mode is a scripted camera tour, not a panel)
    tour: null,
    // wayfinding and progression
    visited: new Set(),
    visitedList: [],
    compassAccum: 0,
    courseLine: null,
    courseFrame: 0,
    courseTarget: null,
    vessels: [],
    // autopilot (sailTo). arrived/arriveTimer/dockIsland drive the auto-dock on
    // arrival: once the ship settles in dock range of the sailTo target it docks
    // itself, unless manual input cancelled the autopilot first.
    autopilot: { active: false, island: null, route: [], routeIndex: 0, arrived: false, arriveTimer: 0, dockIsland: null },
    // attract cinematic and the intro dive out of it
    attractT: 0,
    introFrom: { pos: new THREE.Vector3(), look: new THREE.Vector3() },
    introDur: 2.5,
    // docked tour input accumulators
    wheelAccum: 0,
    wheelCooldown: 0,
    swipeStartY: null,
    // disposables
    disposables: [],
    textures: [],
    listeners: [],
    resizeTimer: 0,
    readyFired: false,
  };
}

async function initTerrainField() {
  const options = { droplets: TERRAIN_EROSION_DROPLETS, thermalPasses: 14 };
  let field = null;
  let execution = "main-thread fallback";
  if (typeof Worker !== "undefined" && TERRAIN_MAIN_THREAD_BENCHMARK_MS > 200) {
    try {
      field = await new Promise((resolve, reject) => {
        const worker = new Worker(new URL("./terrain-field-worker.js", import.meta.url), { type: "module" });
        V.terrainWorker = worker;
        worker.onmessage = (event) => resolve(hydrateTerrainField(event.data));
        worker.onerror = (event) => reject(event.error || new Error(event.message || "TerrainField worker failed"));
        worker.postMessage(options);
      });
      execution = "module Worker";
    } catch (error) {
      console.warn("[voyage] TerrainField Worker unavailable; generating on main thread", error);
    } finally {
      if (V.terrainWorker) V.terrainWorker.terminate();
      V.terrainWorker = null;
    }
  }
  if (!field) field = generateTerrainField(options);
  V.terrainField = field;
  V.terrainTextures = createTerrainDataTextures(field);
  console.info(
    `[voyage] TerrainField ${field.bounds.width}x${field.bounds.height}: ${field.generationMs.toFixed(2)}ms in ${execution}; ` +
    `${field.droplets} hydraulic droplets (45k benchmark ${TERRAIN_MAIN_THREAD_BENCHMARK_MS.toFixed(2)}ms)`,
  );
}

function createTerrainDataTextures(field) {
  const { width, height } = field.bounds;
  const configure = (texture) => {
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;
    texture.flipY = false;
    texture.unpackAlignment = 1;
    texture.needsUpdate = true;
    V.textures.push(texture);
    return texture;
  };
  return {
    height: configure(new THREE.DataTexture(field.height, width, height, THREE.RedFormat, THREE.FloatType)),
    sdf: configure(new THREE.DataTexture(field.sdf, width, height, THREE.RedFormat, THREE.FloatType)),
    splat: configure(new THREE.DataTexture(field.splat, width, height, THREE.RGBAFormat, THREE.FloatType)),
  };
}

function sampleTerrainTextureLikeGpu(array, field, x, z) {
  const u = (x - field.bounds.minX) / (field.bounds.maxX - field.bounds.minX);
  const v = (z - field.bounds.minZ) / (field.bounds.maxZ - field.bounds.minZ);
  if (u < 0 || v < 0 || u > 1 || v > 1) return null;
  const width = field.bounds.width, height = field.bounds.height;
  // Shaders remap normalized bounds UVs to texel centers, so GL's linear
  // filtering interpolates the same (width-1)/(height-1) grid as the CPU.
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

function runCoastConsistencyCheck(requestedSamples) {
  if (!V || !V.terrainField) return null;
  const field = V.terrainField;
  const target = Math.max(64, Math.min(8192, requestedSamples | 0));
  let state = 0xc0a57, samples = 0, maxError = 0;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
  for (let attempt = 0; attempt < target * 160 && samples < target; attempt++) {
    const x = field.bounds.minX + random() * (field.bounds.maxX - field.bounds.minX);
    const z = field.bounds.minZ + random() * (field.bounds.maxZ - field.bounds.minZ);
    const collisionSdf = field.sampleSdf(x, z);
    if (collisionSdf == null || Math.abs(collisionSdf) > 1.5) continue;
    const renderSdf = sampleTerrainTextureLikeGpu(field.sdf, field, x, z);
    maxError = Math.max(maxError, Math.abs(renderSdf - collisionSdf));
    samples++;
  }
  const controlTexel = Math.max(field.dx, field.dz);
  const result = { samples, maxError, controlTexel, pass: samples >= 64 && maxError < controlTexel };
  if (!result.pass) console.error("[voyage] TerrainField coast consistency failed", result);
  return result;
}

function terrainShaderFailureDetails(gl, program, vertexShader, fragmentShader) {
  const lines = [
    gl.getProgramInfoLog(program),
    gl.getShaderInfoLog(vertexShader),
    gl.getShaderInfoLog(fragmentShader),
  ].map((line) => (line || "").trim()).filter(Boolean);
  return lines.join("\n") || "WebGL reported an unrunnable terrain program without an info log.";
}

function createTerrainVertexColorMaterial() {
  const material = pbrMaterial({
    color: 0xffffff,
    vertexColors: true,
    roughness: 0.96,
    metalness: 0,
    flatShading: false,
  }, "terrain");
  material.name = "voyage-terrain-vertex-color-fallback";
  return material;
}

async function compileTerrainMaterialOrFallback() {
  const material = V.terrainMaterial;
  if (!material || !V.terrain || !V.renderer || !V.scene || !V.camera) return true;

  const renderer = V.renderer;
  const previousShaderError = renderer.debug.onShaderError;
  let failure = null;
  renderer.debug.checkShaderErrors = true;
  renderer.debug.onShaderError = (gl, program, vertexShader, fragmentShader) => {
    if (!failure) failure = new Error(terrainShaderFailureDetails(gl, program, vertexShader, fragmentShader));
  };

  const compileScene = new THREE.Scene();
  const compileMesh = new THREE.Mesh(V.terrain.geometry, material);
  compileMesh.position.copy(V.terrain.position);
  compileScene.add(compileMesh);
  try {
    await renderer.compileAsync(compileScene, V.camera, V.scene);
    const failedProgram = renderer.info.programs.find((program) =>
      program.name === material.name && program.diagnostics && program.diagnostics.runnable === false
    );
    if (!failure && failedProgram) {
      failure = new Error(failedProgram.diagnostics.programLog || "Terrain shader program is not runnable.");
    }
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error));
  } finally {
    renderer.debug.onShaderError = previousShaderError;
    compileScene.remove(compileMesh);
  }

  if (!failure) return true;

  const fallback = createTerrainVertexColorMaterial();
  V.scene.traverse((object) => {
    if (object.material === material) object.material = fallback;
  });
  V.terrainMaterial = fallback;
  V.terrainFallbackMaterial = fallback;
  material.dispose();
  console.error("[voyage] Terrain PBR shader failed to compile; using vertex-color fallback.", failure);
  return false;
}

// ===========================================================================
// PUBLIC API
// ===========================================================================

export function isSupported() {
  try {
    const c = document.createElement("canvas");
    const gl = c.getContext("webgl2");
    return !!gl;
  } catch (e) {
    return false;
  }
}

export async function initVoyage(opts) {
  if (V && V.initialized) {
    // Already initialized; just re-report ready.
    if (typeof opts.onReady === "function") opts.onReady();
    return;
  }
  V = freshState();
  V.opts = opts || {};
  V.canvas = opts.canvas || document.getElementById("voyage-canvas");
  V.quality = normalizeQualityTier(opts.quality) || "balanced";
  V.profile = QUALITY_PROFILES[V.quality];
  V.dprCap = V.profile.dprCap;
  V.bloomEnabled = V.profile.bloom;
  V.vegetationShadowsEnabled = V.profile.vegetationShadows;
  if (V.canvas) V.canvas.dataset.quality = V.quality;
  if (typeof document !== "undefined") {
    document.documentElement.dataset.voyageQuality = V.quality;
    document.body.classList.toggle("quality-mobile", V.quality === "mobile");
  }
  V.reducedMotion = !!opts.reducedMotion;
  // Audio defaults to muted; only an explicit opts.muted === false unmutes.
  V.muted = opts.muted != null ? !!opts.muted : true;
  V.introDur = V.reducedMotion ? 0.8 : 2.5;
  V.isTouch =
    (typeof window !== "undefined" &&
      window.matchMedia &&
      window.matchMedia("(pointer: coarse)").matches) ||
    V.quality === "mobile" ||
    "ontouchstart" in window;

  // Try to pull real copy from the page data module; fall back if absent.
  await loadSiteCopy();

  await initTerrainField();

  buildRenderer();
  buildScene();
  buildLighting();
  buildSky();
  buildOcean();
  buildBoundary();

  // Terrain maps and models share the visible entry progress. Island meshes are
  // not created until every real PBR map is ready (or a file-specific fallback
  // has been installed), so the entry never flashes an untextured heightfield.
  const loadState = { models: 0, terrain: 0 };
  const updateAssetProgress = () => reportProgress(
    ((loadState.models * 12 + loadState.terrain * 20) / 32) * 0.98,
  );
  const [models, terrainMaterialAssets] = await Promise.all([
    loadModels((progress) => {
      loadState.models = progress;
      updateAssetProgress();
    }),
    loadTerrainMaterialAssets(V.renderer, (progress) => {
      loadState.terrain = progress;
      updateAssetProgress();
    }),
  ]);
  V.terrainMaterialAssets = terrainMaterialAssets;
  V.textures.push(...terrainMaterialAssets.albedo, ...terrainMaterialAssets.nra);
  V.terrainMaterial = createTerrainMaterial(
    terrainMaterialAssets,
    V.terrainTextures,
    TERRAIN_BOUNDS,
    { quality: V.quality },
  );
  V.rockMaterial = createTerrainMaterial(
    terrainMaterialAssets,
    V.terrainTextures,
    TERRAIN_BOUNDS,
    { rockMode: true, quality: V.quality },
  );
  V.landmarkMaterials = {
    weathered: createTerrainMaterial(
      terrainMaterialAssets,
      V.terrainTextures,
      TERRAIN_BOUNDS,
      { landmarkMode: true, tint: 0xb8aa90, variant: "weathered", quality: V.quality },
    ),
    plaster: createTerrainMaterial(
      terrainMaterialAssets,
      V.terrainTextures,
      TERRAIN_BOUNDS,
      { landmarkMode: true, tint: 0xd0c5ae, variant: "plaster", quality: V.quality },
    ),
    hero: createTerrainMaterial(
      terrainMaterialAssets,
      V.terrainTextures,
      TERRAIN_BOUNDS,
      { landmarkMode: true, tint: 0xe0d6c0, variant: "summit-hero", quality: V.quality },
    ),
  };
  // Shared loader for the small icon textures painted onto the Labors plaques and
  // the Voyages banners. Kept separate from the model manager so late texture
  // loads never re-drive the load progress bar; errors fall back to warm plaques.
  V.texManager = new THREE.LoadingManager();
  V.texManager.onError = (url) => console.warn("[voyage] icon texture failed", url);
  V.texLoader = new THREE.TextureLoader(V.texManager);
  buildShip(models);
  buildIslands(models);
  await compileTerrainMaterialOrFallback();
  validateDockSetup();
  setOceanShallows();
  buildBirds();
  buildColossus();
  buildCourseLine();

  // Restore visited chapters from a previous visit before wiring visuals so
  // returning visitors keep their beacons, lit flames and progress dots (C1).
  loadVisited();
  applyVisitedVisuals();

  bindInput();
  handleResize();

  V.initialized = true;
  // Prime the FIRST frame before anything renders: pose the camera at the wide
  // attract shot, place the sea under it, and initialise every ocean uniform.
  // Without this, frame one rendered from the raw default pose with a zeroed
  // uCamPos, which on a real GPU read as a close, unposed ship over a black void.
  V.renderer.setAnimationLoop(null);
  V.time = 0;
  setAttractCamera();
  syncWorld();
  // Force-compile all materials now so any strict-GLSL (ANGLE/D3D) shader error
  // surfaces loudly in the console at load time instead of silently dropping the
  // ocean. three logs the full shader info log via checkShaderErrors (kept on).
  try {
    V.renderer.compile(V.scene, V.camera);
  } catch (e) {
    console.error("[voyage] material compile failed", e);
  }
  reportProgress(1);
  invalidateStaticShadows();
  renderFrame();
  freezeStaticShadowMap();

  // A tiny driver hook so the page (and verification) can reach the exports even
  // before app.js wires the new controls. Guarded and side-effect free until
  // something calls it.
  if (typeof window !== "undefined") {
    window.__voyage = {
      startAttract, startVoyage, requestDock, exitDockedMode,
      nextBeat, prevBeat, endTour, sailTo, setActive, setMuted,
      invalidateShadows: invalidateStaticShadows,
      perf: readPerformanceProbe,
      // Read-only accessors for wiring and verification (inert unless called).
      getState() {
        let progress = null;
        if (V && V.flames) {
          let lit = 0;
          let pulse = 0;
          for (const f of V.flames) {
            if (f.lit > 0.5) lit++;
            if (f.pulse > pulse) pulse = f.pulse;
          }
          progress = { completed: !!V.voyageComplete, lit, pulse: +pulse.toFixed(2) };
        }
        return V
          ? {
              mode: V.mode,
              position: { x: +V.pos.x.toFixed(2), z: +V.pos.z.toFixed(2) },
              heading: +V.heading.toFixed(3),
              speed: +V.speed.toFixed(2),
              nearIsland: V.nearIsland ? V.nearIsland.id : null,
              visited: V.visitedList.slice(),
              autopilot: V.autopilot.active,
              tourIndex: V.tour ? V.tour.index : -1,
              tourTotal: V.tour ? V.tour.total : 0,
              hasAudio: !!V.audio,
              muted: V.muted,
              quality: {
                tier: V.quality,
                dprCap: V.dprCap,
                terrainGrid: V.profile.terrainGrid.slice(),
                terrainShader: V.profile.terrainShader.variant,
                oceanSegments: V.profile.oceanSegments,
                bloom: !!(V.bloom && V.bloom.enabled),
                pmremSize: V.profile.pmremSize,
                joystick: !!V.joyEls,
                loadingProgress: V.lastProgress,
              },
              flames: progress,
              lighting: {
                sunElevation: SUN_ELEVATION_DEGREES,
                shadowMapSize: V.sun ? V.sun.shadow.mapSize.x : 0,
                staticShadowsFrozen: V.staticShadowsFrozen,
                environment: !!V.scene.environment,
                environmentSize: V.environmentSize,
              },
              scatter: V.r5Stats ? { ...V.r5Stats, counts: { ...V.r5Stats.counts } } : null,
              landmarks: { ...V.r6Census },
            }
          : null;
      },
      nearestDock() {
        if (!V || !V.islands.length) return null;
        let nearest = null;
        let distance = Infinity;
        for (const island of V.islands) {
          const d = Math.hypot(V.pos.x - island.dockPoint.x, V.pos.z - island.dockPoint.z);
          if (d < distance) {
            nearest = island;
            distance = d;
          }
        }
        return nearest
          ? { id: nearest.id, distance: +distance.toFixed(2), inRange: !!nearest.inRange }
          : null;
      },
      terrainField() {
        if (!V || !V.terrainField) return null;
        const field = V.terrainField;
        return {
          version: field.version,
          seed: field.seed,
          grid: [field.bounds.width, field.bounds.height],
          bounds: { ...field.bounds },
          generationMs: +field.generationMs.toFixed(2),
          droplets: field.droplets,
          workerRequiredByBenchmark: TERRAIN_MAIN_THREAD_BENCHMARK_MS > 200,
          cliffBandTriangles: V.cliffBand ? V.cliffBand.userData.triangleCount : 0,
          docks: verifyDockNavigation(field, SHORE_SAFE_DISTANCE),
        };
      },
      coastConsistency(samples = 1024) {
        return runCoastConsistencyCheck(samples);
      },
      promptState() {
        const el = document.getElementById("dock-prompt");
        const textEl = el && el.querySelector(".dock-text");
        return {
          visible: !!(el && el.classList.contains("is-visible") && el.getAttribute("aria-hidden") === "false"),
          text: textEl ? textEl.textContent.trim() : "",
        };
      },
      // Wrap the live callbacks to also record payloads for verification.
      debugTap() {
        window.__cb = { beat: [], anchor: [], compass: [], prompt: [], visited: [], tour: [] };
        const wrap = (name, key, pick) => {
          const orig = V.opts[name];
          V.opts[name] = (a) => {
            try { window.__cb[key].push(pick ? pick(a) : a); } catch (e) {}
            if (typeof orig === "function") orig(a);
          };
        };
        wrap("onBeatChange", "beat");
        wrap("onBeatAnchor", "anchor", (a) => ({ x: Math.round(a.x), y: Math.round(a.y), visible: a.visible, side: a.side }));
        wrap("onCompassUpdate", "compass", (a) => ({ heading: +Number(a.heading).toFixed(2), n: a.islands.length, next: (a.islands.find((i) => i.next) || {}).id }));
        wrap("onPromptUpdate", "prompt", (a) => ({ visible: !!a.visible, approach: a.approach || null, islandId: a.islandId || null, regionName: a.regionName || null, label: a.label || "" }));
        wrap("onVisitedChange", "visited");
        wrap("onDockedTour", "tour");
      },
    };
  }

  // Report the current visited set once on init so the UI can paint progress
  // dots and amber compass ticks immediately (C1).
  emitVisited();

  if (!V.readyFired) {
    V.readyFired = true;
    if (typeof V.opts.onReady === "function") V.opts.onReady();
  }
}

// Begin the idle cinematic that sits behind the landing hero. Same scene, a
// high wide poster shot of the sunlit sea with a slow drift, no input (V4). The
// AudioContext is intentionally NOT started here; audio waits for the first
// unmute (V5).
export function startAttract() {
  if (!V || !V.initialized) return;
  V.mode = "attract";
  V.attractT = 0;
  V.autopilot.active = false;
  setAttractCamera(0);
  startLoop();
}

export function startVoyage() {
  if (!V || !V.initialized) return;
  // Dive continuously from wherever the camera currently sits (the attract
  // poster, or the default wide pose) down into the chase position (V4).
  V.introFrom.pos.copy(V.camera.position);
  V.introFrom.look.copy(V.camLook);
  V.mode = "intro";
  V.introT = 0;
  V.autopilot.active = false;
  startLoop();
}

// Single owner of the animation loop so attract, intro and sailing never stack
// two RAF chains on top of each other.
function startLoop() {
  if (!V) return;
  V.active = true;
  if (V.running) return;
  V.running = true;
  V.lastT = performance.now();
  loop();
}

// Autopilot toward an island for tap-to-sail navigation (V3). Eases the heading
// onto the target, throttles up, respects collision and the play boundary, then
// slows to a stop inside dock-prompt range and hands control back. Any manual
// input cancels it instantly (handled in updateShipPhysics).
export function sailTo(islandId) {
  if (!V || V.mode !== "sailing") return;
  const isl = V.islands.find((i) => i.id === islandId);
  if (!isl) return;
  V.autopilot.active = true;
  V.autopilot.island = isl;
  V.autopilot.route = makeCoastalRoute(V.pos.x, V.pos.z, isl);
  V.autopilot.routeIndex = 0;
  V.autopilot.arrived = false;
  V.autopilot.dockIsland = null;
}

function makeCoastalRoute(fromX, fromZ, island) {
  return buildNavigableCoastalRoute(
    V.terrainField,
    fromX,
    fromZ,
    island.dockPoint.x,
    island.dockPoint.z,
    7.4,
  ).map((point) => new THREE.Vector3(point.x, 0, point.z));
}

// Advance to the next beat of the docked tour; on the final beat this ends the
// tour (same as Sail on). Exposed for the on-card chevrons (B1).
export function nextBeat() {
  if (!V || !V.tour || V.mode !== "docked") return;
  if (V.tour.index >= V.tour.total - 1) {
    endTour();
    return;
  }
  startBeat(V.tour.index + 1);
}

// Rewind to the previous beat; clamped at the first beat (B1).
export function prevBeat() {
  if (!V || !V.tour || V.mode !== "docked") return;
  if (V.tour.index <= 0) return;
  startBeat(V.tour.index - 1);
}

// End the docked tour: mark the island visited, then ease the camera back to a
// safe afloat chase pose (C1, reuses the undock machinery).
export function endTour() {
  if (!V) return;
  if (V.mode !== "docked" && V.mode !== "docking") return;
  const isl = V.dockedIsland;
  if (isl) markVisited(isl.id);
  if (typeof V.opts.onTourEnd === "function") V.opts.onTourEnd();
  beginUndock();
}

export function requestDock() {
  if (!V || V.mode !== "sailing" || !V.nearIsland) return false;
  return beginDock(V.nearIsland);
}

// Kept for the classic fallback path (View as list closes the old panel). It
// marks the island visited then eases the ship back out to sea (C1).
export function exitDockedMode() {
  if (!V) return;
  if (V.mode !== "docked" && V.mode !== "docking") return;
  const isl = V.dockedIsland;
  if (isl) markVisited(isl.id);
  beginUndock();
}

// Ease the camera back to the chase view and float the ship to a safe pose
// outside the shore facing tangentially away, so undocking never leaves the
// ship beached (F1).
function beginUndock() {
  if (!V) return;
  V.autopilot.active = false;
  V.dockFrom.pos.copy(V.camera.position);
  V.dockFrom.look.copy(V.camLook);

  // Compute a safe afloat pose outside the shore facing tangentially away, so
  // undocking never leaves the ship beached (F1).
  const isl = V.dockedIsland;
  V.undockFrom.pos.copy(V.pos);
  V.undockFrom.heading = V.heading;
  if (isl) {
    _v1.set(isl.outward.x, 0, isl.outward.y).normalize();
    V.undockTo.pos.set(isl.dockPoint.x + _v1.x * 11, 0, isl.dockPoint.z + _v1.z * 11);
    // Tangent to the shore, angled slightly offshore so the bow points to sea.
    _v2.set(-_v1.z, 0, _v1.x).addScaledVector(_v1, 0.5).normalize();
    V.undockTo.heading = Math.atan2(_v2.x, _v2.z);
    V.haveUndockTarget = true;
    // Aim the undock dolly at the chase pose behind the safe afloat position.
    const h = V.undockTo.heading;
    V.dockTo.pos.set(
      V.undockTo.pos.x - Math.sin(h) * 12,
      6,
      V.undockTo.pos.z - Math.cos(h) * 12
    );
    V.dockTo.look.set(
      V.undockTo.pos.x + Math.sin(h) * 2,
      1.5,
      V.undockTo.pos.z + Math.cos(h) * 2
    );
  } else {
    V.haveUndockTarget = false;
  }

  V.mode = "undocking";
  V.dockT = 0;
  playWhoosh();
}

export function setActive(bool) {
  if (!V) return;
  const on = !!bool;
  if (on === V.active && V.running === on) {
    // no-op
  }
  V.active = on;
  if (on) {
    if (V.initialized && !V.running && V.mode !== "idle") {
      V.running = true;
      V.lastT = performance.now();
      loop();
    }
  } else {
    V.running = false;
    if (V.rafId) cancelAnimationFrame(V.rafId);
    V.rafId = 0;
    V.lastT = 0;
  }
}

export function setMuted(bool) {
  if (!V) return;
  V.muted = !!bool;
  if (V.muted) {
    // Total mute: drive the master gain to silence. One-shots are also gated on
    // V.muted so nothing new gets created while muted (V5).
    if (V.audio && V.audio.master) {
      const g = V.audio.master.gain;
      const now = V.audio.ctx.currentTime;
      g.cancelScheduledValues(now);
      g.setTargetAtTime(0.0001, now, 0.08);
    }
    return;
  }
  // First unmute is a user gesture: build the AudioContext now (never before)
  // and ramp the ambience up over about a second (V5).
  ensureAudio();
  if (V.audio && V.audio.master) {
    const g = V.audio.master.gain;
    const now = V.audio.ctx.currentTime;
    g.cancelScheduledValues(now);
    g.setValueAtTime(Math.max(0.0001, g.value), now);
    g.linearRampToValueAtTime(V.audio.baseGain, now + 1.0);
  }
}

export function dispose() {
  if (!V) return;
  V.running = false;
  if (V.rafId) cancelAnimationFrame(V.rafId);
  V.rafId = 0;

  for (const [t, ev, fn, tgt] of V.listeners) {
    (tgt || window).removeEventListener(ev, fn);
  }
  V.listeners.length = 0;

  if (V.resizeTimer) clearTimeout(V.resizeTimer);

  // Tear down joystick DOM we created.
  if (V.joyEls) {
    if (V.joyEls.ring && V.joyEls.ring.parentNode) V.joyEls.ring.parentNode.removeChild(V.joyEls.ring);
    V.joyEls = null;
  }

  // Audio.
  if (V.audio) {
    try {
      V.audio.master.disconnect();
      if (V.audio.ctx.state !== "closed") V.audio.ctx.close();
    } catch (e) {}
    V.audio = null;
  }

  // Dispose scene resources.
  if (V.scene) {
    V.scene.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) {
          if (m.map) m.map.dispose();
          m.dispose();
        }
      }
    });
  }
  for (const t of V.textures) {
    if (t && t.dispose) t.dispose();
  }
  for (const d of V.disposables) {
    if (d && d.dispose) d.dispose();
  }
  if (V.composer) {
    try {
      V.composer.dispose();
    } catch (e) {}
  }
  if (V.renderer) {
    V.renderer.setAnimationLoop(null);
    V.renderer.dispose();
  }
  if (typeof window !== "undefined" && window.__voyage) {
    try { delete window.__voyage; } catch (e) { window.__voyage = null; }
  }
  V = null;
}

// ===========================================================================
// COPY (island names, dock prompt) from data.js with safe fallbacks.
// ===========================================================================
let COPY = {
  names: {
    origins: { name: "Origins", tag: "About" },
    forge: { name: "The Forge", tag: "Skills" },
    labors: { name: "The Labors", tag: "Projects" },
    voyages: { name: "The Voyages", tag: "Experience" },
    oracle: { name: "The Oracle", tag: "Contact" },
  },
  dockDesktop: "Press E to drop anchor at {name}",
  dockMobile: "Tap to drop anchor at {name}",
  // Chapter order fixed to the numerals I..V (A1). Filled from data below.
  order: ["origins", "forge", "labors", "voyages", "oracle"],
  numerals: ["I", "II", "III", "IV", "V"],
  // Counts drive geometry and beat totals; sensible fallbacks if data lags.
  projectCount: 10,
  experienceCount: 6,
  // Local icon paths for the Labors plaques and Voyages banners, filled from
  // data below. Any external (http) image is stored as null so we never hotlink;
  // those exhibits fall back to a plain warm plaque or pennant (B1, B2).
  projectIcons: [],
  experienceIcons: [],
};

// Keep only same-origin local image paths; external URLs become null so nothing
// is ever hotlinked into the scene.
function localIcon(src) {
  return typeof src === "string" && !/^https?:/i.test(src) ? src : null;
}

async function loadSiteCopy() {
  try {
    const mod = await import("./data.js");
    const SITE = mod && mod.SITE;
    if (!SITE) return;
    // Capture counts so the steles (Labors) and vessels (Voyages) and their beat
    // totals track the real content even if it changes.
    if (Array.isArray(SITE.projects) && SITE.projects.length) {
      COPY.projectCount = SITE.projects.length;
      COPY.projectIcons = SITE.projects.map((p) => localIcon(p && p.image));
    }
    if (Array.isArray(SITE.experience) && SITE.experience.length) {
      COPY.experienceCount = SITE.experience.length;
      COPY.experienceIcons = SITE.experience.map((p) => localIcon(p && p.image));
    }
    // Chapters may be an array or a map keyed by id. Try to read name/tag.
    const chapters = SITE.chapters;
    if (Array.isArray(chapters)) {
      for (const c of chapters) {
        if (c && c.id && COPY.names[c.id]) {
          if (c.name) COPY.names[c.id].name = c.name;
          if (c.tag) COPY.names[c.id].tag = c.tag;
        }
      }
    } else if (chapters && typeof chapters === "object") {
      for (const id of Object.keys(COPY.names)) {
        const c = chapters[id];
        if (c) {
          if (c.name) COPY.names[id].name = c.name;
          if (c.tag) COPY.names[id].tag = c.tag;
        }
      }
    }
    const micro = SITE.micro;
    if (micro && typeof micro === "object") {
      const d = micro.dockDesktop || micro.dockPromptDesktop || micro.dockPrompt;
      const m = micro.dockMobile || micro.dockPromptMobile;
      if (typeof d === "string") COPY.dockDesktop = d;
      if (typeof m === "string") COPY.dockMobile = m;
    }
  } catch (e) {
    // data.js not present yet or shape differs; fallbacks already set.
  }
}

// ===========================================================================
// RENDERER / SCENE
// ===========================================================================
function buildRenderer() {
  const renderer = new THREE.WebGLRenderer({
    canvas: V.canvas,
    antialias: V.profile.antialias,
    alpha: false,
    powerPreference: "high-performance",
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, V.dprCap));
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  // Daytime exposure: pulled down from the night value so the bright sky, sunlit
  // sand and marble read as airy and vibrant without clipping to pure white. The
  // sun disc, cloud crowns and flames are the only near-white elements and are
  // kept just under the clip point (point 2).
  renderer.toneMappingExposure = PHYSICAL_LIGHTING.exposure;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  // Keep one frame-wide census across every composer pass for __voyage.perf().
  renderer.info.autoReset = false;
  renderer.shadowMap.enabled = true;
  // PCFShadowMap is the non-deprecated 0.185 WebGL path and is soft by default.
  // Per-tier LightShadow.radius preserves a restrained penumbra at each map size.
  renderer.shadowMap.type = THREE.PCFShadowMap;
  // The first complete scene render bakes the one static island shadow map.
  // freezeStaticShadowMap() disables automatic updates immediately afterward.
  renderer.shadowMap.autoUpdate = true;
  renderer.shadowMap.needsUpdate = true;
  // Keep shader-error checking on so a strict-driver (ANGLE/D3D) GLSL compile
  // failure prints the full info log to the console instead of failing silent.
  renderer.debug.checkShaderErrors = true;
  V.renderer = renderer;

  if (V.profile.bloom) {
    // Composer is created now; its passes are wired in wireComposer() once the
    // scene and camera exist (see buildScene).
    V.composer = new EffectComposer(renderer);
  }
}

// Helpers so buildRenderer can defer; we actually wire composer after scene.
function wireComposer() {
  if (!V.composer) return;
  V.composer.passes.length = 0;
  V.composer.addPass(new RenderPass(V.scene, V.camera));
  // Threshold raised for daylight so the bright azure sky, pale horizon and white
  // cloud crowns stay under the bloom knee and only the sun disc and the golden
  // beacon flames actually glow. Prevents a full-sky glow mush (point 8).
  const bloom = new UnrealBloomPass(
    new THREE.Vector2(window.innerWidth, window.innerHeight),
    PHYSICAL_LIGHTING.bloom.strength,
    PHYSICAL_LIGHTING.bloom.radius,
    PHYSICAL_LIGHTING.bloom.threshold
  );
  V.bloom = bloom;
  bloom.enabled = V.bloomEnabled;
  V.composer.addPass(bloom);
  V.composer.addPass(new OutputPass());
  V.composer.setPixelRatio(V.renderer.getPixelRatio());
  V.composer.setSize(window.innerWidth, window.innerHeight);
}

function buildScene() {
  const scene = new THREE.Scene();
  // Bright blue-white haze so anything the sky dome does not cover reads as day
  // atmosphere, and distant islands melt into the same haze (point 4).
  scene.background = new THREE.Color(COL.haze);
  scene.fog = new THREE.FogExp2(COL.haze, FOG_DENSITY);
  V.scene = scene;

  const camera = new THREE.PerspectiveCamera(
    55,
    window.innerWidth / window.innerHeight,
    0.5,
    2000
  );
  camera.position.set(0, 40, -60);
  camera.lookAt(0, 2, 30);
  V.camera = camera;

  // Now that scene and camera exist, wire the composer for the high path.
  wireComposer();
}

function buildLighting() {
  // One sun, one truth: this vector also places the sky disc and drives ocean
  // specular. Its 20-degree elevation gives the island directional relief.
  const sun = new THREE.DirectionalLight(
    PHYSICAL_LIGHTING.sunColor,
    PHYSICAL_LIGHTING.sunIntensity,
  );
  const shadowMapSize = selectShadowMapSize();
  const snappedCenter = stabilizedShadowCenter(shadowMapSize);
  sun.position.copy(snappedCenter).addScaledVector(MOON_DIR, SHADOW_CONFIG.lightDistance);
  sun.target.position.copy(snappedCenter);
  sun.castShadow = true;
  sun.shadow.mapSize.set(shadowMapSize, shadowMapSize);
  sun.shadow.camera.left = -SHADOW_CONFIG.halfExtent;
  sun.shadow.camera.right = SHADOW_CONFIG.halfExtent;
  sun.shadow.camera.top = SHADOW_CONFIG.halfExtent;
  sun.shadow.camera.bottom = -SHADOW_CONFIG.halfExtent;
  sun.shadow.camera.near = SHADOW_CONFIG.near;
  sun.shadow.camera.far = SHADOW_CONFIG.far;
  sun.shadow.bias = SHADOW_CONFIG.bias;
  sun.shadow.normalBias = SHADOW_CONFIG.normalBias;
  sun.shadow.radius = V.profile.shadowRadius;
  if ("blurSamples" in sun.shadow) {
    sun.shadow.blurSamples = V.profile.shadowBlurSamples;
  }
  sun.shadow.camera.updateProjectionMatrix();
  V.scene.add(sun);
  V.scene.add(sun.target);
  V.sun = sun;

  // Modest sky/ground indirect fill preserves shadow detail without inventing a
  // second direction. There are no standing opposing fill or rim lights.
  const hemi = new THREE.HemisphereLight(
    PHYSICAL_LIGHTING.hemisphereSkyColor,
    PHYSICAL_LIGHTING.hemisphereGroundColor,
    PHYSICAL_LIGHTING.hemisphereIntensity,
  );
  V.scene.add(hemi);

  // Eased warm fill that only breathes in while docked, so the framed island
  // reads while the panel is open (F3). Starts dark; positioned each frame.
  const dockFill = new THREE.PointLight(0xffb877, 0, 90, 2.0);
  dockFill.position.set(0, 30, 0);
  V.scene.add(dockFill);
  V.dockFill = dockFill;

  // One shared warm highlight light that eases to the active beat's exhibit while
  // docked so the framed object visibly glows versus its neighbors, then fades on
  // tour end (B6). Cheap: a single moving PointLight plus per-exhibit emissive.
  const beatLight = new THREE.PointLight(0xffc27a, 0, 34, 2.0);
  beatLight.position.set(0, 40, 0);
  V.scene.add(beatLight);
  V.beatLight = beatLight;
}

function selectShadowMapSize() {
  let size = V.profile.shadowMapSize;
  const maxTextureSize = V.renderer.capabilities.maxTextureSize || size;
  while (size > maxTextureSize && size > QUALITY_PROFILES.mobile.shadowMapSize) size /= 2;
  return size;
}

function stabilizedShadowCenter(mapSize) {
  const center = new THREE.Vector3(...SHADOW_CONFIG.center);
  const forward = _v1.copy(MOON_DIR).multiplyScalar(-1);
  const right = _v2.crossVectors(forward, THREE.Object3D.DEFAULT_UP).normalize();
  const up = _v3.crossVectors(right, forward).normalize();
  const texel = (SHADOW_CONFIG.halfExtent * 2) / mapSize;
  const rightOffset = Math.round(center.dot(right) / texel) * texel - center.dot(right);
  const upOffset = Math.round(center.dot(up) / texel) * texel - center.dot(up);
  return center.addScaledVector(right, rightOffset).addScaledVector(up, upOffset);
}

// ===========================================================================
// SKY: day gradient dome, warm sun disc + glow, low-poly cumulus (point 1).
// ===========================================================================
function buildSky() {
  buildSkyDome();

  // Bright warm sun disc. Kept just off pure white so it blooms softly without
  // clipping, and positioned along MOON_DIR so its glitter road leads to Origins.
  const sunGeo = new THREE.SphereGeometry(30, 32, 24);
  const sunMat = new THREE.MeshBasicMaterial({ color: COL.sun, fog: false });
  sunMat.toneMapped = false;
  const sun = new THREE.Mesh(sunGeo, sunMat);
  sun.position.copy(MOON_DIR).multiplyScalar(900);
  V.scene.add(sun);
  V.sunMesh = sun;

  // Soft sun glow (a billboarded additive sprite), warm and wide.
  const haloTex = makeGlowTexture(0xfff0cc, 0.5);
  const halo = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: haloTex,
      color: 0xffe6b4,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false,
    })
  );
  halo.material.toneMapped = false;
  halo.position.copy(sun.position);
  halo.scale.setScalar(205);
  V.scene.add(halo);

  buildEnvironmentFromSky();
  buildClouds();
}

function buildEnvironmentFromSky() {
  if (V.environmentTarget) {
    V.scene.environment = null;
    V.environmentTarget.dispose();
    V.disposables = V.disposables.filter((item) => item !== V.environmentTarget);
    V.environmentTarget = null;
    V.environmentSize = 0;
  }
  const environmentScene = new THREE.Scene();
  const zenith = new THREE.Color(COL.skyZenith);
  const horizon = new THREE.Color(COL.skyHorizon);
  const water = new THREE.Color(COL.skyWater);
  const skyMaterial = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      uZenith: { value: zenith },
      uHorizon: { value: horizon },
      uWater: { value: water },
    },
    vertexShader: `
      varying vec3 vDirection;
      void main() {
        vDirection = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      varying vec3 vDirection;
      uniform vec3 uZenith;
      uniform vec3 uHorizon;
      uniform vec3 uWater;
      void main() {
        float h = normalize(vDirection).y;
        vec3 upper = mix(uHorizon, uZenith, smoothstep(0.02, 0.82, h));
        vec3 lower = mix(uWater, uHorizon, smoothstep(-0.18, 0.04, h));
        gl_FragColor = vec4(h >= 0.0 ? upper : lower, 1.0);
      }
    `,
  });
  skyMaterial.toneMapped = false;
  const sky = new THREE.Mesh(new THREE.SphereGeometry(10, 32, 20), skyMaterial);
  environmentScene.add(sky);

  const sunMaterial = new THREE.MeshBasicMaterial({
    color: new THREE.Color(PHYSICAL_LIGHTING.sunColor).multiplyScalar(5.5),
  });
  sunMaterial.toneMapped = false;
  const sun = new THREE.Mesh(new THREE.SphereGeometry(0.34, 20, 12), sunMaterial);
  sun.position.copy(MOON_DIR).multiplyScalar(6);
  environmentScene.add(sun);

  const pmrem = new THREE.PMREMGenerator(V.renderer);
  const target = pmrem.fromScene(
    environmentScene,
    0.025,
    0.1,
    20,
    { size: V.profile.pmremSize },
  );
  V.scene.environment = target.texture;
  V.environmentTarget = target;
  V.environmentSize = V.profile.pmremSize;
  V.disposables.push(target);
  pmrem.dispose();
  sky.geometry.dispose();
  skyMaterial.dispose();
  sun.geometry.dispose();
  sunMaterial.dispose();
}

// Day sky dome: a vertical gradient from azure overhead down through a pale blue
// horizon to a whisper of warm cream at the waterline. It follows the camera
// each frame and is drawn first behind everything. Colours are authored in
// linear space and tone mapped the same way as the ocean (ACES via OutputPass on
// high, in-shader on low) so both quality paths read identically (point 1).
function buildSkyDome() {
  const geo = new THREE.SphereGeometry(1300, 32, 20);
  const zenith = new THREE.Color(COL.skyZenith);
  const horizon = new THREE.Color(COL.skyHorizon);
  const water = new THREE.Color(COL.skyWater);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
    fog: false,
    uniforms: {
      uZenith: { value: new THREE.Vector3(zenith.r, zenith.g, zenith.b) },
      uHorizon: { value: new THREE.Vector3(horizon.r, horizon.g, horizon.b) },
      uWater: { value: new THREE.Vector3(water.r, water.g, water.b) },
      uTonemap: { value: V.composer ? 0.0 : 1.0 },
    },
    vertexShader: `
      varying vec3 vDir;
      void main(){
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      precision highp float;
      varying vec3 vDir;
      uniform vec3 uZenith, uHorizon, uWater;
      uniform float uTonemap;
      vec3 aces(vec3 x){
        float a=2.51, b=0.03, c=2.43, d=0.59, e=0.14;
        return clamp((x*(a*x+b))/(x*(c*x+d)+e), 0.0, 1.0);
      }
      void main(){
        vec3 dir = normalize(vDir);
        float elev = clamp(dir.y, -1.0, 1.0);
        // Pale blue horizon rising to azure overhead.
        vec3 col = mix(uHorizon, uZenith, smoothstep(0.0, 0.55, elev));
        // A whisper of warm cream right at and just below the waterline.
        col = mix(col, uWater, 1.0 - smoothstep(-0.03, 0.06, elev));
        if(uTonemap > 0.5){
          col = aces(col);
          col = pow(col, vec3(1.0/2.2));
        }
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
  mat.toneMapped = false;
  const dome = new THREE.Mesh(geo, mat);
  dome.frustumCulled = false;
  dome.renderOrder = -10;
  V.scene.add(dome);
  V.sky = dome;
}

// Procedural low-poly cumulus. Each cluster is several rounded blobs merged into
// ONE non-indexed BufferGeometry so a whole puff is a single draw call. Per-facet
// vertex colours (baked from each flat face's normal.y) give a sun-lit white
// crown fading to a subtle blue-grey underside with zero lighting cost, and stay
// under the bloom knee so the sky never glows. Clusters sway very slowly in place
// with no per-frame allocation (points 1, 8).
function buildClouds() {
  const clusterCount = V.profile.cloudCount;
  const tex = makeCloudTexture();
  for (let ci = 0; ci < clusterCount; ci++) {
    const az = (ci / clusterCount) * Math.PI * 2 + (Math.random() - 0.5) * 0.55;
    const rad = 430 + Math.random() * 360;
    const height = 125 + Math.random() * 120;
    const cx = Math.sin(az) * rad;
    const cz = Math.cos(az) * rad;
    const scale = V.profile.cloudScale * (0.75 + Math.random() * 0.65);
    const mesh = new THREE.Group();
    for (let layer = 0; layer < 3; layer++) {
      const mat = new THREE.SpriteMaterial({
        map: tex,
        color: layer === 0 ? COL.cloudUnder : COL.cloudTop,
        transparent: true,
        opacity: layer === 0 ? 0.38 : 0.5,
        depthWrite: false,
        depthTest: true,
        fog: false,
      });
      const puff = new THREE.Sprite(mat);
      puff.position.set((layer - 1) * scale * 0.34, layer * scale * 0.08, -layer * 1.5);
      puff.scale.set(scale * (1.45 - layer * 0.12), scale * (0.52 + layer * 0.05), 1);
      mesh.add(puff);
    }
    mesh.position.set(cx, height, cz);
    mesh.renderOrder = -8;
    V.scene.add(mesh);
    V.clouds.push({
      mesh,
      baseX: cx,
      baseZ: cz,
      swayA: 9 + Math.random() * 15,
      swayW: 0.02 + Math.random() * 0.03, // period ~120-300s
      phase: Math.random() * Math.PI * 2,
    });
  }
}

function makeCloudTexture() {
  const c = document.createElement("canvas");
  c.width = 512;
  c.height = 256;
  const ctx = c.getContext("2d");
  ctx.clearRect(0, 0, c.width, c.height);
  const puffs = [[120, 150, 92], [225, 112, 116], [340, 143, 104], [430, 164, 72]];
  for (const [x, y, r] of puffs) {
    const g = ctx.createRadialGradient(x, y - r * 0.15, r * 0.08, x, y, r);
    g.addColorStop(0, "rgba(255,255,255,.98)");
    g.addColorStop(0.55, "rgba(255,255,255,.72)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Drift the cumulus clusters with a very slow horizontal sway. No allocation.
function updateClouds() {
  if (!V.clouds.length) return;
  const t = V.time;
  for (const c of V.clouds) {
    c.mesh.position.x = c.baseX + Math.sin(t * c.swayW + c.phase) * c.swayA;
    c.mesh.position.z = c.baseZ + Math.cos(t * c.swayW * 0.6 + c.phase) * c.swayA * 0.4;
  }
}

function buildBirds() {
  const count = V.profile.birdCount;
  const pos = new Float32Array(count * 4 * 3);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  const mat = new THREE.LineBasicMaterial({ color: 0x4c4b46, transparent: true, opacity: 0.72, fog: true });
  const lines = new THREE.LineSegments(geo, mat);
  lines.frustumCulled = false;
  V.scene.add(lines);
  V.birds = { lines, pos, count };
  updateBirds();
}

function updateBirds() {
  if (!V.birds) return;
  const { pos, count, lines } = V.birds;
  for (let i = 0; i < count; i++) {
    const a = V.time * (0.16 + i * 0.008) + (i / count) * Math.PI * 2;
    const r = 18 + (i % 3) * 5;
    const cx = -4 + Math.cos(a) * r;
    const cz = 48 + Math.sin(a) * r * 0.72;
    const cy = 31 + (i % 4) * 1.7 + Math.sin(a * 2.1) * 0.8;
    const tx = -Math.sin(a), tz = Math.cos(a);
    const nx = -tz, nz = tx;
    const wing = Math.sin(V.time * 4.2 + i) * 0.28;
    const o = i * 12;
    pos[o] = cx + nx * 1.15; pos[o + 1] = cy + wing; pos[o + 2] = cz + nz * 1.15;
    pos[o + 3] = cx; pos[o + 4] = cy; pos[o + 5] = cz;
    pos[o + 6] = cx; pos[o + 7] = cy; pos[o + 8] = cz;
    pos[o + 9] = cx - nx * 1.15; pos[o + 10] = cy + wing; pos[o + 11] = cz - nz * 1.15;
  }
  lines.geometry.attributes.position.needsUpdate = true;
}

// ===========================================================================
// OCEAN
// ===========================================================================
function buildOcean() {
  // Geometry carries only the broad silhouette. Every lighting normal below is
  // reconstructed analytically per pixel, so triangle boundaries can never show.
  const geo = buildOceanGeometry();

  const deep = new THREE.Color(COL.seaDeep);
  const crest = new THREE.Color(COL.seaCrest);
  const shallow = new THREE.Color(COL.seaShallow);
  const fog = new THREE.Color(COL.haze);
  const glint = new THREE.Color(0xfff6e0);
  const skyZenith = new THREE.Color(COL.skyZenith);
  const skyHorizon = new THREE.Color(COL.skyHorizon);

  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uCamPos: { value: new THREE.Vector3() },
      uMoonDir: { value: MOON_DIR.clone() },
      uDeep: { value: new THREE.Vector3(deep.r, deep.g, deep.b) },
      uCrest: { value: new THREE.Vector3(crest.r, crest.g, crest.b) },
      uShallow: { value: new THREE.Vector3(shallow.r, shallow.g, shallow.b) },
      uGlint: { value: new THREE.Vector3(glint.r, glint.g, glint.b) },
      uSkyZenith: { value: new THREE.Vector3(skyZenith.r, skyZenith.g, skyZenith.b) },
      uSkyHorizon: { value: new THREE.Vector3(skyHorizon.r, skyHorizon.g, skyHorizon.b) },
      uFogColor: { value: new THREE.Vector3(fog.r, fog.g, fog.b) },
      uFogDensity: { value: FOG_DENSITY },
      uAmp: { value: WAVE_AMP_TOTAL },
      uTonemap: { value: V.composer ? 0.0 : 1.0 },
      uShipPos: { value: new THREE.Vector3() },
      uTerrainHeight: { value: V.terrainTextures.height },
      uTerrainSdf: { value: V.terrainTextures.sdf },
      uTerrainSplat: { value: V.terrainTextures.splat },
      uTerrainBounds: { value: new THREE.Vector4(
        TERRAIN_BOUNDS.minX, TERRAIN_BOUNDS.minZ,
        TERRAIN_BOUNDS.maxX, TERRAIN_BOUNDS.maxZ,
      ) },
      uTerrainTextureSize: { value: new THREE.Vector2(TERRAIN_BOUNDS.width, TERRAIN_BOUNDS.height) },
    },
    vertexShader: `
      precision highp float;
      uniform float uTime;
      uniform vec3 uShipPos;
      varying vec3 vWorld;
      varying float vH;
      ${oceanHeightGLSL()}
      void main(){
        vec4 wp = modelMatrix * vec4(position, 1.0);
        float h = oceanHeight(wp.xz, uTime);
        wp.y += h;
        vWorld = wp.xyz;
        vH = h;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: buildOceanFragmentShader(oceanHeightGLSL()),
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.name = "ocean";
  V.scene.add(mesh);
  V.ocean = mesh;
  V.oceanMat = mat;
}

function buildOceanGeometry() {
  const geometry = new THREE.PlaneGeometry(
    OCEAN_SIZE,
    OCEAN_SIZE,
    V.profile.oceanSegments,
    V.profile.oceanSegments,
  );
  geometry.rotateX(-Math.PI / 2);
  return geometry;
}

// Kept as an initialization hook; the ocean now samples TerrainField directly.
function setOceanShallows() {}

// ===========================================================================
// BOUNDARY: a few distant, fog-softened limestone islets beyond the play area.
// ===========================================================================
function buildBoundary() {
  const count = 8;
  // An indexed sphere keeps shared smooth normals. Gentle low-frequency radial
  // weathering avoids both perfect balls and the old triangular shard silhouette.
  const geo = new THREE.SphereGeometry(1, 16, 10);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const a = Math.atan2(z, x);
    const weathering = 1 + Math.sin(a * 3 + y * 2.1) * 0.055 + Math.sin(a * 5 - y) * 0.025;
    pos.setXYZ(i, x * weathering, y * (0.94 + Math.cos(a * 2) * 0.035), z * weathering);
  }
  pos.needsUpdate = true;
  geo.scale(1, 0.62, 1);
  geo.computeVertexNormals();
  const mat = pbrMaterial({
    color: 0xb9ad91,
    roughness: 0.98,
    metalness: 0.0,
    flatShading: false,
    fog: true,
  }, "stone");
  const inst = new THREE.InstancedMesh(geo, mat, count);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  const p = new THREE.Vector3();
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2 + Math.sin(i * 2.37) * 0.16;
    const r = PLAY_R + 125 + (i % 3) * 17;
    p.set(Math.cos(a) * r, -5.8 - (i % 2) * 0.8, Math.sin(a) * r);
    q.setFromEuler(new THREE.Euler(0, i * 1.91, 0));
    const sc = 8.5 + (i % 4) * 1.35;
    s.set(sc * (1.1 + (i % 2) * 0.12), sc, sc * (0.92 + (i % 3) * 0.08));
    m.compose(p, q, s);
    inst.setMatrixAt(i, m);
  }
  inst.instanceMatrix.needsUpdate = true;
  inst.frustumCulled = false;
  inst.name = "distant-weathered-islets";
  V.scene.add(inst);
}

// ===========================================================================
// MODELS
// ===========================================================================
function loadModels(onProg) {
  const names = [
    "ship",
    "temple",
    "column",
    "ruins-columns",
    "lighthouse",
    "dock",
    "rowboat",
    "boat-sail",
    "amphora",
  ];
  const manager = new THREE.LoadingManager();
  manager.onProgress = (url, loaded, total) => {
    if (total > 0) onProg(loaded / total);
  };
  const loader = new GLTFLoader(manager);
  const out = {};
  const jobs = names.map(
    (n) =>
      new Promise((resolve) => {
        loader.load(
          `./assets/models/${n}.glb`,
          (g) => {
            out[n] = g.scene;
            resolve();
          },
          undefined,
          (err) => {
            console.warn("[voyage] model failed to load:", n, err && err.message ? err.message : err);
            out[n] = null;
            resolve();
          }
        );
      })
  );
  return Promise.all(jobs).then(() => out);
}

function reportProgress(p) {
  if (!V) return;
  V.lastProgress = Math.max(V.lastProgress, Math.max(0, Math.min(1, p)));
  if (typeof V.opts.onProgress === "function") {
    V.opts.onProgress(V.lastProgress);
  }
}

// Scale a model so its largest dimension (or a chosen axis) matches target, then
// recenter horizontally and rest its base on y = 0. The recentered model is
// WRAPPED in a holder group so callers can freely do wrapper.position.set(...)
// without discarding the base-lift (a caller setting position directly on the
// model itself would erase the recenter and drop props whose GLB pivot sits at
// their center straight into the terrain). The wrapper's origin is the model's
// base-center, so wrapper.position.y is exactly the seat height.
function prepModel(src, target, mode, materialRole = "preserve") {
  const obj = src.clone(true);
  const box = new THREE.Box3().setFromObject(obj);
  const size = new THREE.Vector3();
  box.getSize(size);
  let base;
  if (mode === "height") base = size.y;
  else if (mode === "xz") base = Math.max(size.x, size.z);
  else base = Math.max(size.x, size.y, size.z);
  const s = target / (base || 1);
  obj.scale.multiplyScalar(s);
  const box2 = new THREE.Box3().setFromObject(obj);
  const c = new THREE.Vector3();
  box2.getCenter(c);
  obj.position.x -= c.x;
  obj.position.z -= c.z;
  obj.position.y -= box2.min.y;
  dressModel(obj, materialRole);
  const wrap = new THREE.Group();
  wrap.add(obj);
  return wrap;
}

function pbrMaterial(parameters, role = "default") {
  const material = new THREE.MeshStandardMaterial(parameters);
  material.envMapIntensity = ENV_MAP_INTENSITY[role] ?? ENV_MAP_INTENSITY.default;
  material.userData.environmentRole = role;
  return material;
}

function dressModel(root, materialRole) {
  root.traverse((o) => {
    if (o.isMesh) {
      o.castShadow = false;
      o.receiveShadow = true;
      // GLTF clone(true) intentionally shares materials. Clone them here before
      // dressing so a stone landmark cannot recolour a boat/tree instance.
      o.material = Array.isArray(o.material)
        ? o.material.map((m) => m && m.clone())
        : (o.material && o.material.clone());
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) {
        if (!m) continue;
        const role = ENV_MAP_INTENSITY[materialRole] != null ? materialRole : "default";
        if ("roughness" in m) {
          const sourceRoughness = m.roughness == null ? 0.8 : m.roughness;
          m.roughness = materialRole === "ship"
            ? Math.max(0.55, Math.min(0.9, sourceRoughness + 0.06))
            : Math.min(1, sourceRoughness + 0.18);
        }
        if ("metalness" in m && materialRole !== "ship") m.metalness = 0.0;
        if ("envMapIntensity" in m) m.envMapIntensity = ENV_MAP_INTENSITY[role];
        m.userData.environmentRole = role;
        if ((materialRole === "ship" || materialRole === "weathered-boat") && m.emissive) {
          m.emissive.set(0x000000);
          m.emissiveIntensity = 0;
          m.toneMapped = true;
        }
        if (materialRole === "weathered-boat") {
          const isCloth = /sail|cloth|canvas/i.test(m.name || "");
          if ("vertexColors" in m) m.vertexColors = false;
          if ("map" in m) m.map = null;
          if (m.color) m.color.set(isCloth ? 0xb9b3a4 : 0x7d715e);
          if ("roughness" in m) m.roughness = 0.94;
          if ("metalness" in m) m.metalness = 0;
          m.needsUpdate = true;
        }
        if (materialRole === "ceramic") {
          if ("vertexColors" in m) m.vertexColors = false;
          if ("map" in m) m.map = null;
          if (m.color) m.color.set(0x986f52);
          if (m.emissive) {
            m.emissive.set(0x000000);
            m.emissiveIntensity = 0;
          }
          if ("roughness" in m) m.roughness = 0.88;
          m.needsUpdate = true;
        }
        m.fog = true;
      }
    }
  });
}

// ===========================================================================
// SHIP
// ===========================================================================
function buildShip(models) {
  const group = new THREE.Group();
  group.name = "ship";
  V.scene.add(group);

  const hullGroup = new THREE.Group(); // wrapper that orients the model to +Z forward
  group.add(hullGroup);

  let usedModel = false;
  if (models.ship) {
    try {
      const ship = prepModel(models.ship, 6, "max", "ship");
      // Quaternius sail ship native forward is +Z; nudged upright by prep.
      // Lift so the hull waterline sits a touch below the deck origin.
      ship.position.y -= 1.1;
      hullGroup.add(ship);
      usedModel = true;
    } catch (e) {
      console.warn("[voyage] ship prep failed, using procedural fallback", e);
    }
  }
  if (!usedModel) {
    hullGroup.add(buildProceduralShip());
  }

  // Stern lantern mesh is kept, but by day its glow and its light are killed so
  // it never reads as a lit lamp at noon; only a dim warm bead remains (point 5).
  const lantern = new THREE.Mesh(
    new THREE.SphereGeometry(0.16, 12, 10),
    pbrMaterial({
      color: 0x3a2a12,
      emissive: new THREE.Color(0xffcf99),
      emissiveIntensity: 0.4,
    })
  );
  lantern.material.toneMapped = false;
  lantern.position.set(0, 2.0, -2.6);
  hullGroup.add(lantern);

  // The lantern keeps a tiny emissive bead, but no daytime point light. The two
  // tour-only dock/beat lights are the scene's only local lights.
  const lampLight = null;
  V.lantern.base = 0;
  V.lantern.emissive = lantern.material.emissiveIntensity;

  V.ship = { group, hull: hullGroup, lantern, light: lampLight };
  configureDynamicShadowReceiver(group);

  buildWake();
}

function buildProceduralShip() {
  const g = new THREE.Group();
  const woodMat = pbrMaterial({ color: 0x6b4a2c, roughness: 0.85, flatShading: true }, "wood");
  const darkWood = pbrMaterial({ color: 0x3e2a18, roughness: 0.9, flatShading: true }, "wood");
  const sailMat = pbrMaterial({
    color: 0xefe3c4,
    roughness: 0.95,
    side: THREE.DoubleSide,
    flatShading: true,
  }, "ship");

  // Hull from a lathe profile.
  const pts = [];
  for (let i = 0; i <= 6; i++) {
    const t = i / 6;
    pts.push(new THREE.Vector2(0.05 + Math.sin(t * Math.PI) * 0.9, t * 1.2 - 0.2));
  }
  const hullGeo = new THREE.LatheGeometry(pts, 10);
  hullGeo.scale(1.0, 1.0, 2.6);
  const hull = new THREE.Mesh(hullGeo, woodMat);
  hull.rotation.x = Math.PI;
  hull.position.y = 0.2;
  g.add(hull);

  const deck = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.15, 4.4), darkWood);
  deck.position.y = 0.35;
  g.add(deck);

  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.1, 4.2, 8), woodMat);
  mast.position.set(0, 2.2, 0.2);
  g.add(mast);

  const sailGeo = new THREE.PlaneGeometry(2.2, 2.6, 6, 6);
  const pa = sailGeo.attributes.position;
  for (let i = 0; i < pa.count; i++) {
    const x = pa.getX(i);
    pa.setZ(i, Math.cos((x / 2.2) * Math.PI) * 0.35);
  }
  sailGeo.computeVertexNormals();
  const sail = new THREE.Mesh(sailGeo, sailMat);
  sail.position.set(0, 2.4, 0.35);
  g.add(sail);

  return g;
}

function buildWake() {
  // A dense pool lets the two stern rails overlap continuously for their full
  // fade without recycling a still-visible element.
  const max = V.profile.wakeCount;
  // Warm-neutral cream foam rather than cool blue-grey puffs (F4). The texture
  // is deliberately stretched on horizontal planes; camera-facing sprites read
  // as round, detached clouds from the sailing camera.
  const tex = makeGlowTexture(COL.wake, 0.42);
  const geo = new THREE.PlaneGeometry(1, 1);
  geo.rotateX(-Math.PI / 2);
  const sprites = [];
  const container = new THREE.Group();
  container.name = "wake";
  V.scene.add(container);
  for (let i = 0; i < max; i++) {
    const mat = new THREE.MeshBasicMaterial({
      map: tex,
      color: COL.wake,
      transparent: true,
      opacity: 0,
      blending: THREE.NormalBlending,
      depthWrite: false,
      fog: true,
      side: THREE.DoubleSide,
    });
    const sp = new THREE.Mesh(geo, mat);
    sp.scale.set(0.2, 1, 0.95);
    sp.visible = false;
    container.add(sp);
    sprites.push({ sp, life: 0, ttl: 1, width: 0.2, length: 0.95, strength: 1, vx: 0, vz: 0 });
  }
  V.wake = { container, sprites, cursor: 0, timer: 0, activeCount: max };
}

function spawnWake(dt) {
  const w = V.wake;
  if (!w) return;
  const speedFrac = Math.abs(V.speed) / PHYS.maxSpeed;
  if (speedFrac < 0.28) {
    w.timer = 0;
    return;
  }
  w.timer -= dt;
  if (w.timer > 0) return;
  w.timer = V.profile.wakeInterval;
  // Emit two overlapping, heading-aligned strokes at the stern quarters. Their
  // low lateral drift opens the rails into a gentle V over several seconds.
  _fwd.set(Math.sin(V.heading), 0, Math.cos(V.heading));
  const rx = Math.cos(V.heading);
  const rz = -Math.sin(V.heading);
  for (const side of [-1, 1]) {
    const s = w.sprites[w.cursor];
    w.cursor = (w.cursor + 1) % w.activeCount;
    const jitter = (Math.random() - 0.5) * 0.08;
    const px = V.pos.x - _fwd.x * 2.45 + rx * (side * 0.34 + jitter);
    const pz = V.pos.z - _fwd.z * 2.45 + rz * (side * 0.34 + jitter);
    s.sp.position.set(px, waveHeight(px, pz, V.time) + 0.115, pz);
    s.sp.rotation.set(0, V.heading, 0);
    s.sp.visible = true;
    s.life = 0;
    s.ttl = V.profile.wakeLifetime + Math.random() * 0.25;
    s.width = 0.18 + Math.random() * 0.07;
    s.length = 0.9 + Math.random() * 0.22;
    s.strength = Math.min(1, (speedFrac - 0.2) / 0.65);
    s.sp.scale.set(s.width, 1, s.length);
    // World-space foam lingers behind the moving hull and only fans outward.
    s.vx = rx * side * 0.42;
    s.vz = rz * side * 0.42;
  }
}

function updateWake(dt) {
  const w = V.wake;
  if (!w) return;
  for (const s of w.sprites) {
    if (!s.sp.visible) continue;
    s.life += dt;
    const t = s.life / s.ttl;
    if (t >= 1) {
      s.sp.visible = false;
      s.sp.material.opacity = 0;
      continue;
    }
    s.sp.position.x += s.vx * dt;
    s.sp.position.z += s.vz * dt;
    s.sp.position.y = waveHeight(s.sp.position.x, s.sp.position.z, V.time) + 0.115;
    // Quick feather-in, long dissolve. Peak alpha stays below the threshold at
    // which any one stroke becomes readable as an individual foam puff.
    const fadeIn = Math.min(1, t / 0.1);
    const fadeOut = Math.pow(1 - t, 1.45);
    s.sp.material.opacity = fadeIn * fadeOut * 0.105 * s.strength;
    s.sp.scale.set(s.width * (1 + t * 1.15), 1, s.length * (1 + t * 0.42));
  }
}

// ===========================================================================
// ISLANDS
// ===========================================================================
function materialCanCastShadow(material) {
  return !!material
    && !material.transparent
    && (material.isMeshStandardMaterial || material.isMeshPhysicalMaterial);
}

function configureStaticShadowSubtree(root) {
  if (!root) return;
  const visit = (object) => {
    if (object.userData && object.userData.shadowExcludeSubtree) return;
    if (object.isMesh) {
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      if (materials.some(materialCanCastShadow)) {
        object.castShadow = true;
        object.receiveShadow = true;
      }
    }
    for (const child of object.children) visit(child);
  };
  visit(root);
}

function configureDynamicShadowReceiver(root) {
  root.traverse((object) => {
    if (!object.isMesh) return;
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    if (materials.some((material) => material && (material.isMeshStandardMaterial || material.isMeshPhysicalMaterial))) {
      object.castShadow = false;
      object.receiveShadow = true;
    }
  });
}

function contactPatchMaterial(opacity = 0.14) {
  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
    uniforms: {
      uColor: { value: new THREE.Color(0x2a241a) },
      uOpacity: { value: opacity },
    },
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        vec4 localPosition = vec4(position, 1.0);
        #ifdef USE_INSTANCING
          localPosition = instanceMatrix * localPosition;
        #endif
        gl_Position = projectionMatrix * modelViewMatrix * localPosition;
      }
    `,
    fragmentShader: `
      varying vec2 vUv;
      uniform vec3 uColor;
      uniform float uOpacity;
      void main() {
        float radius = length(vUv - 0.5) * 2.0;
        float alpha = (1.0 - smoothstep(0.12, 1.0, radius)) * uOpacity;
        gl_FragColor = vec4(uColor, alpha);
      }
    `,
  });
  material.name = "terrain-contact-darkening";
  return material;
}

function addLandmarkContactPatch(island, topY) {
  const radii = { origins: 9.6, forge: 6.0, labors: 10.8, voyages: 7.2, oracle: 5.2 };
  const radius = radii[island.id] || 4.5;
  const geometry = new THREE.CircleGeometry(radius, 40);
  geometry.rotateX(-Math.PI / 2);
  const patch = new THREE.Mesh(geometry, contactPatchMaterial(island.id === "labors" ? 0.16 : 0.13));
  patch.position.set(0, groundY(island, 0, 0, topY) + 0.035, 0);
  patch.renderOrder = 1;
  patch.userData.shadowExcludeSubtree = true;
  patch.name = `${island.id}-foundation-contact-ao`;
  island.group.add(patch);
}

function registerR6Draw(mesh, key) {
  if (!mesh) return mesh;
  mesh.userData.r6Landmark = key;
  V.r6Census[key] = (V.r6Census[key] || 0) + 1;
  return mesh;
}

function buildMergedGlbFoundation(source, target, mode, material, key, width, depth, skirtHeight = 0.24, contact = null, geometryOptions = {}) {
  const raw = mergeGlbLandmark(source, target, mode, material, `${key}-raw-merged`, geometryOptions);
  const assembly = new THREE.Group();
  const foundationTop = contact ? contact.max + 0.04 : skirtHeight;
  raw.position.y = foundationTop;
  assembly.add(raw);
  const skirtGeometry = contact
    ? terrainFoundationGeometry(width, depth, foundationTop, contact.samples, contact.spec.sink)
    : foundationGeometry(width, depth, skirtHeight, key === "lighthouse" ? 18 : 4);
  const skirt = new THREE.Mesh(skirtGeometry, material);
  if (!contact) skirt.position.y = skirtHeight * 0.5;
  assembly.add(skirt);
  const merged = mergeScenePrimitives(assembly, material, `${key}-merged-with-foundation`);
  raw.geometry.dispose();
  return registerR6Draw(merged, key);
}

function landmarkFootprint(island, spec) {
  const pad = TERRAIN_PAD_BY_ID.get(island.id);
  const contact = sampleFootprintY(V.terrainField, pad, spec);
  contact.spec = spec;
  if (contact.span > spec.tolerance + 1e-6) {
    throw new Error(`R6 footprint exceeds tolerance for ${spec.id}: ${contact.span.toFixed(3)}/${spec.tolerance}`);
  }
  return contact;
}

function auditR6Materials(island) {
  const invalid = [];
  island.group.traverse((object) => {
    if (!object.isMesh) return;
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    const bad = !materials.length || materials.some((material) => {
      if (!material || !material.isMaterial) return true;
      // THREE.Mesh silently installs a white MeshBasicMaterial when its second
      // constructor argument is omitted. That is a valid Material object, so an
      // isMaterial-only audit misses exactly the beige/white backdrop failure.
      const dataKeys = Object.keys(material.userData || {});
      const isThreeDefault = material.isMeshBasicMaterial
        && !material.name
        && dataKeys.length === 0
        && material.color && material.color.getHex() === 0xffffff
        && material.opacity === 1
        && !material.transparent
        && !material.map;
      return isThreeDefault;
    });
    if (bad) invalid.push(object.name || object.uuid);
  });
  if (invalid.length) {
    throw new Error(`R6 landmark mesh has missing/default material in ${island.id}: ${invalid.join(", ")}`);
  }
}

function measureR6LandmarkHeight(object) {
  object.updateWorldMatrix(true, true);
  const box = new THREE.Box3().setFromObject(object);
  return { box, height: box.max.y - box.min.y };
}

function normalizeR6LandmarkHeight(object, targetHeight, seatY = null) {
  let measured = measureR6LandmarkHeight(object);
  if (!Number.isFinite(measured.height) || measured.height <= 0 || !Number.isFinite(targetHeight)) return measured;
  const scale = targetHeight / measured.height;
  object.scale.multiplyScalar(scale);
  measured = measureR6LandmarkHeight(object);
  if (Number.isFinite(seatY) && Number.isFinite(measured.box.min.y)) {
    object.position.y += seatY - measured.box.min.y;
    measured = measureR6LandmarkHeight(object);
  }
  return measured;
}

function assertR6LandmarkHeight(object, key, seatY = null) {
  const contract = R6_LANDMARK_CONFIG.landmarkBounds[key];
  if (!object || !contract) return;
  let { height } = measureR6LandmarkHeight(object);
  if (Number.isFinite(height) && height >= contract.minHeight && height <= contract.maxHeight) return;

  // A runtime scale miss is cosmetic, not fatal. Try one deterministic repair
  // against the authored target, then keep the voyage alive even if malformed
  // source geometry still cannot satisfy the release bounds.
  if (Number.isFinite(height) && height > 0 && Number.isFinite(contract.height)) {
    ({ height } = normalizeR6LandmarkHeight(object, contract.height, seatY));
  }
  if (!Number.isFinite(height) || height < contract.minHeight || height > contract.maxHeight) {
    const label = Number.isFinite(height) ? height.toFixed(2) : String(height);
    console.error(
      `[voyage] R6 landmark scale regression after auto-correction: ${key} Box3 height ${label}u is outside ` +
      `${contract.minHeight}-${contract.maxHeight}u; continuing with the landmark as loaded`,
    );
  }
}

function terrainNormalAt(x, z) {
  const field = V.terrainField;
  const e = Math.max(field.dx, field.dz);
  const hx0 = field.sampleHeight(x - e, z), hx1 = field.sampleHeight(x + e, z);
  const hz0 = field.sampleHeight(x, z - e), hz1 = field.sampleHeight(x, z + e);
  return new THREE.Vector3(-(hx1 - hx0) / (2 * e), 1, -(hz1 - hz0) / (2 * e)).normalize();
}

function registerLandmarkDebris(island, radius, count, phase = 0) {
  if (!island.landmarkDebris) island.landmarkDebris = [];
  for (let i = 0; i < count; i++) {
    const angle = phase + i * 2.399963229728653;
    const distance = radius * (0.78 + ((i * 37) % 17) / 42);
    const x = island.center.x + Math.cos(angle) * distance;
    const z = island.center.z + Math.sin(angle) * distance;
    const y = V.terrainField.sampleHeight(x, z);
    if (y == null) continue;
    island.landmarkDebris.push({
      x, y, z,
      normal: terrainNormalAt(x, z),
      debrisScale: [0.16, 0.68],
    });
  }
}

function originsHeroTrees(island) {
  const specs = [
    ["cypress", -6.5, 4.8, 1.38, 1.16],
    ["cypress", 5.8, -5.8, 1.26, 1.12],
    ["olive", -5.2, -5.4, 1.18, 1.12],
    ["olive", 8.0, -2.0, 1.14, 1.18],
  ];
  return specs.map(([type, lx, lz, heroHeightScale, heroWidthScale]) => {
    const x = island.center.x + lx;
    const z = island.center.z + lz;
    return {
      type, x, z,
      y: V.terrainField.sampleHeight(x, z),
      normal: terrainNormalAt(x, z),
      heroHeightScale,
      heroWidthScale,
    };
  });
}

function buildIslands(models) {
  const matRock = pbrMaterial({ color: COL.rock, roughness: 0.96, metalness: 0, flatShading: false }, "stone");
  const matRockL = pbrMaterial({ color: COL.rockLight, roughness: 0.94, metalness: 0, flatShading: false }, "stone");
  const matSand = pbrMaterial({ color: COL.sand, roughness: 0.98, metalness: 0, flatShading: false }, "wetTerrain");
  const matFoliage = pbrMaterial({ color: COL.foliage, roughness: 1.0, metalness: 0, flatShading: false }, "foliage");
  const shared = { matRock, matRockL, matSand, matFoliage };
  const terrain = buildUnifiedIslandTerrain();
  V.scene.add(terrain);
  terrain.updateMatrixWorld(true);
  V.terrain = terrain;
  terrain.castShadow = true;
  terrain.receiveShadow = true;
  const cliffBand = buildCliffBand();
  if (cliffBand) {
    V.scene.add(cliffBand);
    V.cliffBand = cliffBand;
    cliffBand.castShadow = true;
    cliffBand.receiveShadow = true;
  }

  ISLAND_DEFS.forEach((def, idx) => {
    const cx = def.center[0];
    const cz = def.center[1];
    const group = new THREE.Group();
    group.position.set(cx, 0, cz);
    V.scene.add(group);
    group.updateMatrixWorld(true);
    const sampledTop = surfaceYAt(cx, cz, [terrain]);
    const topY = sampledTop == null ? islandHeightLocal(cx - MAIN_ISLAND.x, cz - MAIN_ISLAND.z) : sampledTop;
    const beacon = buildBeacon(8);
    beacon.position.y = topY;
    group.add(beacon);
    const dockPoint = new THREE.Vector3(def.dock[0], 0, def.dock[1]);
    const outward = new THREE.Vector2(dockPoint.x - MAIN_ISLAND.x, dockPoint.z - MAIN_ISLAND.z).normalize();

    const island = {
      def,
      id: def.id,
      order: idx,
      numeral: COPY.numerals[idx] || "",
      group,
      beacon,
      groundTargets: [terrain],
      surfLoY: -2,
      surfHiY: 42,
      center: new THREE.Vector3(cx, 0, cz),
      dockPoint,
      outward,
      radius: def.radius,
      collideR: 0,
      topY,
      lookHeight: topY + 5,
      inRange: false,
      embers: null,
      // Beat tour: camera poses precomputed from the island props (B2). Each is
      // { pos, look, anchor } in world space.
      beats: [],
    };

    // Island-specific props.
    switch (def.kind) {
      case "origins":
        buildOrigins(group, topY, models, shared, island);
        break;
      case "forge":
        buildForge(group, topY, models, shared, island);
        break;
      case "labors":
        buildLabors(group, topY, models, shared, island);
        break;
      case "voyages":
        buildVoyages(group, topY, models, shared, island);
        break;
      case "oracle":
        buildOracle(group, topY, models, shared, island);
        break;
    }

    addLandmarkContactPatch(island, topY);
    configureStaticShadowSubtree(group);

    // Frame each beat's anchor off to one side (alternating) so the anchored
    // card has clear space and the leader line reads intentionally (B1).
    applyBeatFraming(island);
    // Precompute each beat's highlight-light position from its exhibit anchor (B6).
    finalizeBeats(island);

    // Sparse warm dust motes drift on desktop tiers and are omitted on mobile.
    if (V.profile.motes) buildMotes(island);

    // A golden beacon flame at the pillar top, dark until this chapter is
    // visited (point 6).
    buildFlame(island, group);
    // Run after every architectural/contact/flame mesh has been attached so a
    // late default material cannot sit outside the initialization audit.
    auditR6Materials(island);

    V.islands.push(island);
  });

  for (const [key, expected] of Object.entries(R6_LANDMARK_CONFIG.draws)) {
    const actual = V.r6Census[key] || 0;
    if (actual !== expected) throw new Error(`R6 draw census drifted for ${key}: ${actual}/${expected}`);
  }

  const beats = V.islands.flatMap((island) => island.beats || []);
  V.r5Scatter = buildR5Scatter({
    renderer: V.renderer,
    terrainField: V.terrainField,
    rockMaterial: V.rockMaterial,
    quality: V.quality,
    exclusions: {
      docks: TERRAIN_DOCKS,
      pads: TERRAIN_PADS,
      beats,
      spawn: SPAWN,
      temple: TERRAIN_PAD_BY_ID.get("labors"),
    },
    heroTrees: V.islands.flatMap((island) => island.heroTrees || []),
    landmarkDebris: V.islands.flatMap((island) => island.landmarkDebris || []),
  });
  V.r5Stats = V.r5Scatter.stats;
  V.r5Scatter.setBudget({
    targetCounts: V.profile.vegetationCounts,
    density: V.runtimeVegetationDensity,
    grassCullDistance: V.profile.grassDistance,
  });
  V.r5Scatter.setShadowCasting(V.vegetationShadowsEnabled);
  V.scene.add(V.r5Scatter.root);
  V.textures.push(...V.r5Scatter.textures);
  V.disposables.push(...V.r5Scatter.depthMaterials);

  // The ship begins offshore on the Origins approach, with the dock and summit
  // aligned beyond its bow so the first W press advances the hero composition.
  V.heading = SPAWN.heading;
  V.pos.set(SPAWN.x, 0, SPAWN.z);
}

// Fail loudly during initialization if a region refactor leaves a dock without
// a world target or a tour. startTour still has a safe fallback beat, but this
// invariant keeps the prompt -> E/tap -> docking -> beat flow complete for all
// five named regions.
function validateDockSetup() {
  const errors = [];
  const expectedTourBeats = {
    origins: 3,
    forge: 3,
    labors: Math.max(1, COPY.projectCount),
    voyages: Math.min(5, Math.max(1, COPY.experienceCount)),
    oracle: 2,
  };
  const navigation = verifyDockNavigation(V.terrainField, SHORE_SAFE_DISTANCE);
  const navigationById = new Map(navigation.map((item) => [item.id, item]));
  for (const def of ISLAND_DEFS) {
    const island = V.islands.find((item) => item.id === def.id);
    if (!island) errors.push(`${def.id}: missing island`);
    else {
      if (!island.dockPoint || !Number.isFinite(island.dockPoint.x) || !Number.isFinite(island.dockPoint.z)) {
        errors.push(`${def.id}: invalid dock point`);
      }
      if (!Array.isArray(island.beats) || island.beats.length === 0) {
        island.beats = [defaultBeat(island)];
        console.warn(`[voyage] ${def.id} had no beats; installed the safe chapter beat`);
      }
      if (island.beats.length !== expectedTourBeats[def.id]) {
        errors.push(`${def.id}: ${island.beats.length}/${expectedTourBeats[def.id]} tour beats`);
      }
      island.beats.forEach((beat, index) => {
        for (const key of ["pos", "look", "anchor"]) {
          const vector = beat[key];
          if (!vector || ![vector.x, vector.y, vector.z].every(Number.isFinite)) {
            errors.push(`${def.id}: beat ${index + 1} has invalid ${key}`);
          }
        }
      });
      const water = navigationById.get(def.id);
      if (!water || !water.navigable) errors.push(`${def.id}: less than 7u navigable water`);
      else island.dockClearance = water.clearance;
    }
  }
  if (errors.length) throw new Error(`Invalid dock setup: ${errors.join(", ")}`);
  console.info("[voyage] dock navigation", navigation.map((item) => ({
    id: item.id,
    clearance: +item.clearance.toFixed(2),
    channelMinClearance: +item.channelMinClearance.toFixed(2),
  })));
}

function islandShapeFieldWorld(x, z) {
  return V && V.terrainField ? V.terrainField.sampleSdf(x, z) : null;
}

function islandHeightLocal(x, z) {
  const y = V && V.terrainField && V.terrainField.sampleHeight(x + MAIN_ISLAND.x, z + MAIN_ISLAND.z);
  return y == null ? -10.5 : y;
}

function sampleTerrainLayerWeights(x, z) {
  const field = V.terrainField;
  const gx = (x - field.bounds.minX) / field.dx;
  const gz = (z - field.bounds.minZ) / field.dz;
  if (gx < 0 || gz < 0 || gx > field.bounds.width - 1 || gz > field.bounds.height - 1) {
    return [0, 1, 0, 0, 0];
  }
  const x0 = Math.floor(gx), z0 = Math.floor(gz);
  const x1 = Math.min(field.bounds.width - 1, x0 + 1);
  const z1 = Math.min(field.bounds.height - 1, z0 + 1);
  const tx = gx - x0, tz = gz - z0;
  const sample = (array, stride, channel) => {
    const at = (ix, iz) => array[(iz * field.bounds.width + ix) * stride + channel];
    const a = at(x0, z0) + (at(x1, z0) - at(x0, z0)) * tx;
    const b = at(x0, z1) + (at(x1, z1) - at(x0, z1)) * tx;
    return a + (b - a) * tz;
  };
  return [
    sample(field.splat, 4, 0),
    sample(field.splat, 4, 1),
    sample(field.splat, 4, 2),
    sample(field.splat, 4, 3),
    sample(field.splatRemainder, 1, 0),
  ];
}

function attachTerrainMaterialAttributes(geometry, offsetX = 0, offsetZ = 0) {
  const position = geometry.attributes.position;
  const ao = new Float32Array(position.count);
  const colors = new Float32Array(position.count * 3);
  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i) + offsetX;
    const z = position.getZ(i) + offsetZ;
    ao[i] = Math.max(0.62, V.terrainField.sampleAO(x, z) || 0.62);
    const weights = sampleTerrainLayerWeights(x, z);
    const shade = 0.76 + ao[i] * 0.24;
    for (let layer = 0; layer < TERRAIN_VERTEX_LAYER_COLORS.length; layer++) {
      const color = TERRAIN_VERTEX_LAYER_COLORS[layer];
      colors[i * 3] += color.r * weights[layer] * shade;
      colors[i * 3 + 1] += color.g * weights[layer] * shade;
      colors[i * 3 + 2] += color.b * weights[layer] * shade;
    }
  }
  geometry.setAttribute("terrainAO", new THREE.BufferAttribute(ao, 1));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
}

function buildUnifiedIslandTerrain() {
  const [sx, sz] = V.profile.terrainSegments;
  const geo = new THREE.PlaneGeometry(
    TERRAIN_BOUNDS.maxX - TERRAIN_BOUNDS.minX,
    TERRAIN_BOUNDS.maxZ - TERRAIN_BOUNDS.minZ,
    sx,
    sz,
  );
  geo.rotateX(-Math.PI / 2);
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const y = V.terrainField.sampleHeight(p.getX(i), p.getZ(i) + MAIN_ISLAND.z);
    p.setY(i, y == null ? -10.5 : y);
  }
  p.needsUpdate = true;
  geo.computeVertexNormals();
  attachTerrainMaterialAttributes(geo, MAIN_ISLAND.x, MAIN_ISLAND.z);
  const terrain = new THREE.Mesh(geo, V.terrainMaterial);
  terrain.position.set(MAIN_ISLAND.x, 0, MAIN_ISLAND.z);
  terrain.name = "single-mediterranean-island";
  return terrain;
}

function buildCliffBand() {
  const field = V.terrainField;
  const angularSamples = 3500;
  const rows = 4;
  const coast = new Array(angularSamples);
  for (let i = 0; i < angularSamples; i++) {
    const angle = i / angularSamples * Math.PI * 2;
    const ux = Math.cos(angle), uz = Math.sin(angle);
    let prevR = 0, prevSdf = field.sampleSdf(MAIN_ISLAND.x, MAIN_ISLAND.z);
    let hit = null;
    for (let r = 1; r <= 132; r += 1) {
      const x = MAIN_ISLAND.x + ux * r, z = MAIN_ISLAND.z + uz * r;
      const sdf = field.sampleSdf(x, z);
      if (sdf == null) break;
      if (prevSdf > 0 && sdf <= 0) {
        const t = prevSdf / (prevSdf - sdf || 1);
        const cr = prevR + (r - prevR) * t;
        const cx = MAIN_ISLAND.x + ux * cr, cz = MAIN_ISLAND.z + uz * cr;
        const e = Math.max(field.dx, field.dz);
        let gx = field.sampleSdf(cx + e, cz) - field.sampleSdf(cx - e, cz);
        let gz = field.sampleSdf(cx, cz + e) - field.sampleSdf(cx, cz - e);
        const gl = Math.hypot(gx, gz) || 1;
        gx /= gl; gz /= gl; // SDF gradient points inland.
        const tx = cx + gx * 4.2, tz = cz + gz * 4.2;
        const slope = field.sampleSlope(tx, tz) || 0;
        const bottomY = (field.sampleHeight(cx, cz) || -0.25) - 0.12;
        const topY = (field.sampleHeight(tx, tz) || bottomY) - 0.08;
        if (slope > Math.PI * 0.25 && topY - bottomY > 2.5) {
          hit = { cx: cx + gx * 0.12, cz: cz + gz * 0.12, tx, tz, bottomY, topY };
        }
        break;
      }
      prevR = r;
      prevSdf = sdf;
    }
    coast[i] = hit;
  }

  const positions = [];
  const indices = [];
  for (let i = 0; i < angularSamples; i++) {
    const a = coast[i], b = coast[(i + 1) % angularSamples];
    if (!a || !b || Math.hypot(a.cx - b.cx, a.cz - b.cz) > 1.2) continue;
    const base = positions.length / 3;
    for (const point of [a, b]) for (let row = 0; row <= rows; row++) {
      const t = row / rows;
      positions.push(
        point.cx + (point.tx - point.cx) * t,
        point.bottomY + (point.topY - point.bottomY) * t,
        point.cz + (point.tz - point.cz) * t,
      );
    }
    for (let row = 0; row < rows; row++) {
      const a0 = base + row, a1 = a0 + 1;
      const b0 = base + rows + 1 + row, b1 = b0 + 1;
      indices.push(a0, b0, a1, a1, b0, b1);
    }
  }
  if (!indices.length) return null;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  attachTerrainMaterialAttributes(geo);
  const mesh = new THREE.Mesh(geo, V.terrainMaterial);
  mesh.name = "terrain-extruded-cliff-band";
  mesh.userData.triangleCount = indices.length / 3;
  return mesh;
}

// Tiny drifting warm dust motes that hang around an island and catch the key
// light. Preallocated buffers, animated in place, no per-frame allocation (N6).
function buildMotes(island) {
  const count = 34;
  const pos = new Float32Array(count * 3);
  const home = new Float32Array(count * 3);
  const drift = new Float32Array(count * 3);
  const phase = new Float32Array(count);
  const spread = island.radius * 1.5;
  for (let i = 0; i < count; i++) {
    const a = Math.random() * Math.PI * 2;
    const r = spread * (0.35 + Math.random() * 0.65);
    const x = island.center.x + Math.cos(a) * r;
    const z = island.center.z + Math.sin(a) * r;
    const y = 2 + Math.random() * (island.lookHeight + 6);
    home[i * 3] = x;
    home[i * 3 + 1] = y;
    home[i * 3 + 2] = z;
    pos[i * 3] = x;
    pos[i * 3 + 1] = y;
    pos[i * 3 + 2] = z;
    drift[i * 3] = 0.15 + Math.random() * 0.25;
    drift[i * 3 + 1] = 0.1 + Math.random() * 0.2;
    drift[i * 3 + 2] = 0.15 + Math.random() * 0.25;
    phase[i] = Math.random() * Math.PI * 2;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  const mat = new THREE.PointsMaterial({
    color: COL.mote,
    size: 0.32,
    sizeAttenuation: true,
    transparent: true,
    opacity: 0.5,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: true,
  });
  mat.toneMapped = false;
  const pts = new THREE.Points(geo, mat);
  pts.frustumCulled = false;
  V.scene.add(pts);
  V.motes.push({ pts, pos, home, drift, phase, count, center: island.center });
}

// ===========================================================================
// BEACON FLAME (point 6): the progression reward. Each island's beacon pillar
// carries a golden flame plume at its crown that stays dark until the chapter is
// visited, then ignites and burns across the water by day. On the fifth visit
// all five pulse once together (see igniteFlame). Additive cones + a soft glow
// sprite give the plume; a warm point light is the faint heat glow. Preallocated
// and animated in place, no per-frame allocation.
// ===========================================================================
function buildFlame(island, group) {
  const topY = island.topY + 4; // beacon crown height
  const g = new THREE.Group();
  g.position.set(0, topY, 0);
  g.visible = false;

  // Wide amber body cone.
  const bodyMat = new THREE.MeshBasicMaterial({ color: 0xff9d3a, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, fog: false });
  bodyMat.toneMapped = false;
  const body = new THREE.Mesh(new THREE.ConeGeometry(1.5, 5.2, 9), bodyMat);
  body.position.y = 2.6;
  g.add(body);

  // Brighter gold core cone.
  const coreMat = new THREE.MeshBasicMaterial({ color: 0xfff0b0, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, fog: false });
  coreMat.toneMapped = false;
  const core = new THREE.Mesh(new THREE.ConeGeometry(0.8, 3.6, 8), coreMat);
  core.position.y = 2.0;
  g.add(core);

  // Soft heat-glow halo sprite.
  const haloTex = makeGlowTexture(COL.flame, 0.5);
  const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: haloTex, color: COL.flame, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }));
  halo.material.toneMapped = false;
  halo.position.y = 2.4;
  halo.scale.setScalar(7);
  g.add(halo);

  group.add(g);
  const flame = { group: g, body, core, halo, bodyMat, coreMat, lit: 0, target: 0, pulse: 0, phase: Math.random() * Math.PI * 2 };
  island.flame = flame;
  V.flames.push(flame);
}

// Ease each flame toward its lit target and animate the shimmer, heat glow and
// completion pulse. Fully dark flames are hidden and skip all maths (point 6).
function updateFlames(dt) {
  if (!V.flames.length) return;
  const k = 1 - Math.exp(-2.6 * dt);
  const t = V.time;
  for (const f of V.flames) {
    f.lit += (f.target - f.lit) * k;
    f.pulse = f.pulse > 0.001 ? f.pulse * Math.exp(-1.4 * dt) : 0;
    if (f.lit < 0.002 && f.pulse < 0.002) {
      if (f.group.visible) {
        f.group.visible = false;
        f.bodyMat.opacity = 0;
        f.coreMat.opacity = 0;
        f.halo.material.opacity = 0;
      }
      continue;
    }
    f.group.visible = true;
    const level = Math.min(1.7, f.lit + f.pulse * 0.9);
    const flick = 0.82 + 0.18 * Math.sin(t * 11.0 + f.phase);
    const flick2 = 0.85 + 0.15 * Math.sin(t * 17.0 + f.phase * 1.7);
    f.bodyMat.opacity = 0.7 * level * flick;
    f.coreMat.opacity = 0.85 * level * flick2;
    f.halo.material.opacity = 0.5 * level * (0.85 + 0.15 * Math.sin(t * 6.0 + f.phase));
    f.body.scale.set(1, flick * (0.9 + 0.25 * level), 1);
    f.core.scale.set(1, flick2 * (0.9 + 0.2 * level), 1);
    f.halo.scale.setScalar(7 * (0.9 + 0.2 * level) + Math.sin(t * 5.0 + f.phase) * 0.4);
  }
}

// ===========================================================================
// COLOSSAL RUIN: one half-sunken statue fragment at the far edge (N3).
// ===========================================================================
function buildColossus() {
  // Sit it opposite the moon azimuth, near the play boundary, so the ship can
  // sail out to it and feel tiny.
  const az = new THREE.Vector3(-MOON_DIR.x, 0, -MOON_DIR.z).normalize();
  const dist = PLAY_R - 24;
  const cx = az.x * dist;
  const cz = az.z * dist;

  const group = new THREE.Group();
  group.position.set(cx, 0, cz);
  // Face the group roughly back toward the play area.
  group.rotation.y = Math.atan2(-cx, -cz);
  V.scene.add(group);

  const stone = pbrMaterial({
    color: 0x232830,
    roughness: 1.0,
    metalness: 0.0,
    flatShading: true,
  }, "stone");

  // Massive half-sunken head, tilted, breaking the surface.
  const headGeo = new THREE.IcosahedronGeometry(15, 1);
  jitterGeometry(headGeo, 1.6);
  headGeo.scale(1.0, 1.28, 1.05);
  headGeo.computeVertexNormals();
  const head = new THREE.Mesh(headGeo, stone);
  head.position.set(-9, 6, 0);
  head.rotation.set(0.32, 0.4, 0.24);
  group.add(head);

  // A blunt brow / crown ridge to read as a face silhouette.
  const brow = new THREE.Mesh(new THREE.BoxGeometry(16, 4, 12), stone);
  brow.position.set(-9, 15, 1.5);
  brow.rotation.set(0.32, 0.4, 0.18);
  group.add(brow);

  // A broad sunken shoulder mass beside the head.
  const shoulderGeo = new THREE.IcosahedronGeometry(18, 1);
  jitterGeometry(shoulderGeo, 1.8);
  shoulderGeo.scale(1.4, 0.7, 1.0);
  shoulderGeo.computeVertexNormals();
  const shoulder = new THREE.Mesh(shoulderGeo, stone);
  shoulder.position.set(14, 2.5, -3);
  shoulder.rotation.y = 0.5;
  group.add(shoulder);

  // A colossal forearm rising from the water at an angle, holding a fire bowl.
  const arm = new THREE.Mesh(new THREE.CylinderGeometry(3.4, 4.6, 46, 10), stone);
  arm.position.set(18, 18, 4);
  arm.rotation.set(-0.34, 0, 0.28);
  group.add(arm);

  const wrist = new THREE.Mesh(new THREE.BoxGeometry(7, 6, 7), stone);
  wrist.position.set(11, 38, 11);
  wrist.rotation.set(0.2, 0.3, 0.1);
  group.add(wrist);

  // Fingers cupping the bowl, a few blocky primitives.
  for (let i = 0; i < 4; i++) {
    const f = new THREE.Mesh(new THREE.BoxGeometry(1.6, 5.5, 1.6), stone);
    const a = (i / 4) * Math.PI * 2;
    f.position.set(11 + Math.cos(a) * 4, 41, 11 + Math.sin(a) * 4);
    f.rotation.set(Math.sin(a) * 0.5, 0, Math.cos(a) * 0.5);
    group.add(f);
  }

  // The bronze fire bowl with an ember glow that feeds bloom.
  const bowlMat = pbrMaterial({ color: 0x2a2018, roughness: 0.85, metalness: 0.2, flatShading: true }, "metal");
  const bowl = new THREE.Mesh(new THREE.CylinderGeometry(6, 3.2, 4.4, 12), bowlMat);
  bowl.position.set(11, 45, 11);
  group.add(bowl);
  const coal = glowMarker(0xff7a1e, 3.4, 3.0);
  coal.position.set(11, 46.4, 11);
  coal.scale.set(1.3, 0.6, 1.3);
  group.add(coal);
  addPointGlow(group, 11, 48, 11, 0xff8a34, 16, 120);

  // Rising embers from the bowl, in the group's local frame.
  const embers = buildEmbers(group, new THREE.Vector3(11, 47, 11));
  V.embers.push(embers);

  const collideR = 34;
  V.ruin = { center: new THREE.Vector3(cx, 0, cz), collideR, group };
}

function buildIslandBase(radius, shared) {
  const g = new THREE.Group();
  const targets = [];

  // Sandy shore ring at the waterline. The capped cylinder also acts as a solid
  // ground floor across the whole footprint so grounded props never fall through.
  const shore = new THREE.Mesh(
    new THREE.CylinderGeometry(radius * 1.18, radius * 1.28, 1.6, 22, 1),
    shared.matSand
  );
  shore.position.y = 0.2;
  g.add(shore);
  targets.push(shore);

  // Rocky landmass: a squashed, jittered icosahedron for an organic low-poly look.
  const landGeo = new THREE.IcosahedronGeometry(radius, 1);
  jitterGeometry(landGeo, 0.18);
  landGeo.scale(1, 0.62, 1);
  landGeo.computeVertexNormals();
  const land = new THREE.Mesh(landGeo, shared.matRock);
  const topY = radius * 0.62 * 0.7; // approx height of the land dome top
  land.position.y = topY - radius * 0.62 + 0.9;
  g.add(land);
  targets.push(land);

  // A few darker boulders around the rim for silhouette. Grounded onto the land
  // surface and sunk to read as half-buried rock rather than floating stones.
  const bcount = 5;
  land.updateMatrixWorld(true);
  for (let i = 0; i < bcount; i++) {
    const ba = (i / bcount) * Math.PI * 2 + 0.4;
    const br = radius * (0.82 + Math.random() * 0.2);
    const rock = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 0), shared.matRockL);
    jitterGeometry(rock.geometry, 0.3);
    const sc = 1.6 + Math.random() * 2.2;
    rock.scale.set(sc, sc * 0.8, sc);
    const bx = Math.cos(ba) * br;
    const bz = Math.sin(ba) * br;
    // Sample the land surface directly (base group sits at the origin here, so
    // local xz equals world xz for this cast).
    const surf = surfaceYAt(bx, bz, [land]);
    const restY = surf == null ? 1.4 : surf;
    rock.position.set(bx, restY - sc * 0.42, bz); // sunk ~40% for a half-buried look
    rock.rotation.y = Math.random() * Math.PI;
    g.add(rock);
    targets.push(rock);
  }

  return { group: g, topY: topY + 0.9, targets };
}

function buildBeacon(height) {
  const geo = new THREE.CylinderGeometry(0.62, 1.25, height, 10, 1, true);
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(COL.amber) },
      uH: { value: height },
      // Identity brightness: lifted so every island carries a warm marker at
      // distance from spawn (V1); bumped again when the chapter is visited (C2).
      uBoost: { value: 1.0 },
    },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    fog: false,
    vertexShader: `
      varying float vY;
      uniform float uH;
      void main(){
        vY = (position.y + uH * 0.5) / uH;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      varying float vY;
      uniform vec3 uColor;
      uniform float uBoost;
      void main(){
        float a = (1.0 - vY);
        a = pow(clamp(a, 0.0, 1.0), 1.5) * 0.46 * uBoost;
        gl_FragColor = vec4(uColor, a);
      }
    `,
  });
  mat.toneMapped = false;
  const m = new THREE.Mesh(geo, mat);
  m.position.y = height * 0.5;
  m.frustumCulled = false;
  return m;
}

// Small emissive glow marker used for windows, braziers, etc.
function glowMarker(color, size, intensity) {
  const m = new THREE.Mesh(
    new THREE.SphereGeometry(size, 8, 8),
    pbrMaterial({
      color: 0x201408,
      emissive: new THREE.Color(color),
      // Daytime dims the emissive markers so braziers/lamps read as gentle warm
      // accents at noon rather than glowing night lamps (point 5).
      emissiveIntensity: (intensity == null ? 2.6 : intensity) * DAY_EMISSIVE,
    })
  );
  m.material.toneMapped = false;
  m.userData.shadowExcludeSubtree = true;
  return m;
}

function addPointGlow() {
  // R4 removes standing decorative point lights entirely. Existing call sites
  // remain as semantic markers for a later night mode, but add zero GPU lights.
  return null;
}

// ---------------------------------------------------------------------------
// PROP GROUNDING (TASK A). Cast a ray straight down from high above a world xz
// against the island's rock/base/peak meshes and return the highest surface Y,
// so every prop can be seated on the true jittered surface rather than an
// estimated dome height. Build-time only, so raycasting cost is irrelevant.
// ---------------------------------------------------------------------------
// Raw down-cast: return the highest hit Y against the whitelisted terrain meshes,
// or null. Ray starts well above any island peak so it never begins inside a prop.
function surfaceYAt(wx, wz, targets) {
  if (!targets || !targets.length) return null;
  if (V && V.terrainField && V.terrain && targets.includes(V.terrain)) {
    return V.terrainField.sampleHeight(wx, wz);
  }
  _groundFrom.set(wx, 800, wz);
  _groundRay.set(_groundFrom, _groundDir);
  _groundRay.far = 1600;
  const hits = _groundRay.intersectObjects(targets, true);
  return hits.length ? hits[0].point.y : null;
}

// Down-cast that also returns the surface up-ness (world normal.y, 1 = flat) so
// callers can avoid seating small props on steep slopes. Terrain-only whitelist.
function sampleSurface(wx, wz, targets) {
  if (!targets || !targets.length) return null;
  if (V && V.terrainField && V.terrain && targets.includes(V.terrain)) {
    return V.terrainField.sampleSurface(wx, wz);
  }
  _groundFrom.set(wx, 800, wz);
  _groundRay.set(_groundFrom, _groundDir);
  _groundRay.far = 1600;
  const hits = _groundRay.intersectObjects(targets, true);
  if (!hits.length) return null;
  const h = hits[0];
  let ny = 1;
  if (h.face && h.object) {
    _v4.copy(h.face.normal).transformDirection(h.object.matrixWorld);
    ny = Math.abs(_v4.y);
  }
  return { y: h.point.y, ny };
}

// True when a sampled Y sits inside the island's plausible surface band, so a ray
// that tunnels to the underside of the dome (garbage) is rejected as out of band.
function inBand(island, y) {
  return y >= island.surfLoY && y <= island.surfHiY;
}

// Island groups are translated only (never rotated) and sit at world y = 0, so a
// prop's local Y equals its world Y. Sample the surface under a LOCAL (lx, lz) for
// a point prop (thin footprint) and return the world/local seat Y, falling back
// (and warning) when the hit is missing or implausible so nothing is ever placed
// obviously floating or submerged.
function groundY(island, lx, lz, fallbackY) {
  const s = sampleSurface(island.center.x + lx, island.center.z + lz, island.groundTargets);
  const fb = fallbackY == null ? island.topY : fallbackY;
  if (!s || !inBand(island, s.y)) {
    console.warn("[voyage] prop seat fell back to nominal top", island.id, lx.toFixed(1), lz.toFixed(1));
    return fb;
  }
  return s.y;
}

// ---------------------------------------------------------------------------
// ICON QUAD (TASK B1, B2). A small square plaque/banner textured with a real
// project or employer icon. Loaded through the shared TextureLoader/manager and
// rasterized onto a fixed square canvas so both raster icons and viewBox-only
// SVGs become clean sRGB textures with no zero-size or NPOT surprises. On any
// failure (or an external URL we refuse to hotlink) it keeps a warm fallback.
// Returns { mesh, emissive } where emissive feeds the beat highlight pulse (B6).
// ---------------------------------------------------------------------------
function buildIconQuad(iconPath, size, base, boost) {
  const geo = new THREE.PlaneGeometry(size, size);
  // Fully matte so bright daylight never throws a specular hotspot on the cloth;
  // the icon reads from its own emissive, like the stele plaques (addendum 1).
  const mat = pbrMaterial({
    color: 0x6b5236,
    roughness: 1.0,
    metalness: 0.0,
    emissive: new THREE.Color(0xffb877),
    emissiveIntensity: base,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  const emissive = { mat, base, boost };
  if (iconPath && V.texLoader) {
    V.texLoader.load(
      iconPath,
      (tex) => {
        const img = tex.image;
        let iw = (img && (img.naturalWidth || img.width)) || 0;
        let ih = (img && (img.naturalHeight || img.height)) || 0;
        const S = 256;
        const cv = document.createElement("canvas");
        cv.width = cv.height = S;
        const cx = cv.getContext("2d");
        if (!iw || !ih) {
          iw = ih = S; // viewBox-only SVG: rasterize to fill the square
        }
        const a = iw / ih;
        let dw = S;
        let dh = S;
        if (a > 1) dh = S / a;
        else dw = S * a;
        try {
          cx.drawImage(img, (S - dw) / 2, (S - dh) / 2, dw, dh);
        } catch (e) {
          tex.dispose();
          return; // keep the warm fallback if the draw fails
        }
        const ctex = new THREE.CanvasTexture(cv);
        ctex.colorSpace = THREE.SRGBColorSpace;
        ctex.anisotropy = 4;
        mat.map = ctex;
        mat.emissiveMap = ctex;
        // Slightly muted diffuse so a large bright icon never clips to white under
        // full daylight (addendum 1).
        mat.color.set(0xbcbcbc);
        mat.emissive.set(0xffffff);
        mat.needsUpdate = true;
        V.textures.push(ctex);
        tex.dispose();
      },
      undefined,
      () => {
        // Load error: warm fallback plaque stays in place (already applied).
      }
    );
  }
  return { mesh, emissive };
}

// Collect the emissive-pulse descriptors for a glow marker so a beat can brighten
// it while active and relax it otherwise (B6).
function glowEmissive(marker, boostFactor) {
  const base = marker.material.emissiveIntensity;
  return { mat: marker.material, base, boost: base * (boostFactor || 1.7) };
}

// ---------------------------------------------------------------------------
// Beat camera helpers. Every beat is { pos, look, anchor } in WORLD space, so
// the leader-line anchor projects correctly and the camera framing is stable.
// azimuth uses the same atan2(x, z) convention as ship heading. (B2)
// ---------------------------------------------------------------------------
function makeBeat(anchorWorld, azimuth, dist, height, lookUp) {
  const pos = new THREE.Vector3(
    anchorWorld.x + Math.sin(azimuth) * dist,
    height,
    anchorWorld.z + Math.cos(azimuth) * dist
  );
  const look = new THREE.Vector3(anchorWorld.x, anchorWorld.y + (lookUp || 0), anchorWorld.z);
  return { pos, look, anchor: anchorWorld.clone() };
}

// Three-quarter low beat that keeps the island interior (temple, peak) behind
// the anchor: the camera sits on the OUTWARD radial from the island center
// through the anchor, dropped low, with a tangential kick for the three-quarter
// angle. Used by the Labors steles and Voyages vessels (B2).
function makeBeatOutward(island, anchorWorld, dist, height, side, lookUp) {
  let ox = anchorWorld.x - island.center.x;
  let oz = anchorWorld.z - island.center.z;
  let l = Math.hypot(ox, oz);
  if (l < 0.5) {
    // A landmark at the region center inherits that coast's open-water bearing.
    ox = island.outward.x;
    oz = island.outward.y;
    l = Math.hypot(ox, oz) || 1;
  }
  const nx = ox / l;
  const nz = oz / l; // outward radial
  const tx = -nz;
  const tz = nx; // tangent
  const s = side || 1;
  const pos = new THREE.Vector3(
    anchorWorld.x + nx * dist + tx * dist * 0.6 * s,
    height,
    anchorWorld.z + nz * dist + tz * dist * 0.6 * s
  );
  const look = new THREE.Vector3(anchorWorld.x, anchorWorld.y + (lookUp || 0), anchorWorld.z);
  return { pos, look, anchor: anchorWorld.clone() };
}

// Origins sits in a crescent bay, so deriving a camera radial from each prop can
// put the lens inland and leave open water behind the cottage. Keep the camera
// on the authored seaward bearing and look inland across the exhibit instead.
function makeBeatInland(island, anchorWorld, dist, height, side, lookUp) {
  const nx = island.outward.x;
  const nz = island.outward.y;
  const tx = -nz;
  const tz = nx;
  const s = side || 1;
  const pos = new THREE.Vector3(
    anchorWorld.x + nx * dist + tx * dist * 0.34 * s,
    height,
    anchorWorld.z + nz * dist + tz * dist * 0.34 * s,
  );
  const look = new THREE.Vector3(
    anchorWorld.x - nx * 1.4,
    anchorWorld.y + (lookUp || 0),
    anchorWorld.z - nz * 1.4,
  );
  return { pos, look, anchor: anchorWorld.clone(), framing: "sea-to-inland" };
}

// Frame an upright marker (a Labors stele) so its LIT, moon-facing side turns
// toward the lens at a three-quarter angle, pulled back and lifted so the slab
// sits in the lower third and never blocks the colonnade backdrop (P4). The
// camera direction is the bisector of the stele's outward radial and the moon
// azimuth: where the outward side faces the moon this yields a temple-behind lit
// shot; where it faces away it swings the camera tangentially so the lens looks
// ALONG the lit colonnade instead of straight into the columns.
function makeBeatLit(island, anchorWorld, dist, height, side, lookUp) {
  let ox = anchorWorld.x - island.center.x;
  let oz = anchorWorld.z - island.center.z;
  let ol = Math.hypot(ox, oz) || 1;
  ox /= ol;
  oz /= ol; // outward radial
  const ml = Math.hypot(MOON_DIR.x, MOON_DIR.z) || 1;
  // Weight the moon azimuth a little over the outward radial so even the steles
  // whose outward side faces away from the moon still catch a lit three-quarter
  // face, without swinging the camera far enough inland to hit the columns.
  const moonBias = 1.25;
  const mx = (MOON_DIR.x / ml) * moonBias;
  const mz = (MOON_DIR.z / ml) * moonBias;
  let dx = ox + mx;
  let dz = oz + mz;
  let dl = Math.hypot(dx, dz);
  if (dl < 0.2) {
    // Outward is almost dead opposite the moon: fall back to the pure tangent so
    // the shot never collapses onto the anchor.
    dx = -oz;
    dz = ox;
    dl = Math.hypot(dx, dz) || 1;
  }
  dx /= dl;
  dz /= dl; // camera direction (moon-biased three-quarter)
  const tx = -dz;
  const tz = dx; // tangent for the three-quarter side kick
  const s = side || 1;
  const pos = new THREE.Vector3(
    anchorWorld.x + dx * dist + tx * dist * 0.45 * s,
    height,
    anchorWorld.z + dz * dist + tz * dist * 0.45 * s
  );
  const look = new THREE.Vector3(anchorWorld.x, anchorWorld.y + (lookUp || 0), anchorWorld.z);
  return { pos, look, anchor: anchorWorld.clone() };
}

// Local island offset to a world anchor point (island groups are translated
// only, never rotated, so world = center + local).
function anchorAt(island, lx, ly, lz) {
  return new THREE.Vector3(island.center.x + lx, ly, island.center.z + lz);
}

// Pan each beat's look target sideways so the anchor lands off-center rather
// than dead-center, alternating sides so successive cards do not stack on the
// same edge. The pan is perpendicular to the camera-to-anchor direction (B1).
function applyBeatFraming(island) {
  const beats = island.beats || [];
  for (let i = 0; i < beats.length; i++) {
    const b = beats[i];
    const dx = b.anchor.x - b.pos.x;
    const dz = b.anchor.z - b.pos.z;
    const len = Math.hypot(dx, dz) || 1;
    const px = -dz / len;
    const pz = dx / len; // perpendicular in the xz plane
    const dir = i % 2 === 0 ? 1 : -1;
    const bias = len * 0.22 * dir;
    b.look.x += px * bias;
    b.look.z += pz * bias;
  }
}

// Precompute the highlight-light target for each beat: a point just in front of
// and above the exhibit anchor (toward the beat camera) so the shared warm light
// rakes the object's lit face rather than sitting inside it (B6).
function finalizeBeats(island) {
  const beats = island.beats || [];
  for (const b of beats) {
    const dx = b.pos.x - b.anchor.x;
    const dz = b.pos.z - b.anchor.z;
    const len = Math.hypot(dx, dz) || 1;
    b.hlPos = new THREE.Vector3(
      b.anchor.x + (dx / len) * 3.2,
      b.anchor.y + 3.4,
      b.anchor.z + (dz / len) * 3.2
    );
    if (!b.emissives) b.emissives = [];
  }
}

// ---- Origins: weathered cottage, hero grove, garden ruin, and tablet ----------
function buildOrigins(group, topY, models, shared, island) {
  const grounding = R6_LANDMARK_GROUNDING.origins;
  const ruinSpec = grounding.ruins;
  const ruinContact = landmarkFootprint(island, ruinSpec);
  const ruinX = ruinSpec.lx;
  const ruinZ = ruinSpec.lz;
  const ruinBase = ruinContact.y;
  if (models["ruins-columns"]) {
    const ruins = buildMergedGlbFoundation(
      models["ruins-columns"], 5.2, "height", V.landmarkMaterials.weathered,
      "ruins", ruinSpec.width, ruinSpec.depth, 0.22, ruinContact,
    );
    ruins.position.set(ruinX, 0, ruinZ);
    ruins.rotation.y = ruinSpec.rotation;
    group.add(ruins);
  } else {
    const fallback = new THREE.Group();
    const wall = new THREE.Mesh(new THREE.BoxGeometry(4.6, 3.4, 0.65), V.landmarkMaterials.weathered);
    wall.position.y = 1.8;
    const returnWall = new THREE.Mesh(new THREE.BoxGeometry(0.65, 2.3, 2.8), V.landmarkMaterials.weathered);
    returnWall.position.set(-2.0, 1.25, 1.1);
    fallback.add(wall, returnWall);
    const ruins = registerR6Draw(mergeScenePrimitives(fallback, V.landmarkMaterials.weathered, "ruins-merged-fallback"), "ruins");
    ruins.position.set(ruinX, ruinBase, ruinZ);
    ruins.rotation.y = ruinSpec.rotation;
    group.add(ruins);
  }

  // The cottage is deliberately modest: merged limestone massing plus one
  // weathered-wood roof/beam/door draw and a footprint-sized buried skirt.
  const homeSpec = grounding.cottage;
  const homeContact = landmarkFootprint(island, homeSpec);
  const hx = homeSpec.lx;
  const hz = homeSpec.lz;
  // The wall begins at local y=.21. Put it just above the highest sample and
  // extend the textured skirt below every lower corner of the graded pad.
  const home = new THREE.Group();
  const stoneParts = new THREE.Group();
  const skirtH = homeContact.span + 0.12;
  const skirt = new THREE.Mesh(new THREE.BoxGeometry(5.3, skirtH, 4.5), V.landmarkMaterials.weathered);
  skirt.position.y = 0.23 - skirtH * 0.5;
  // Four wall runs leave a real doorway opening instead of drawing an emissive
  // rectangle on top of a solid wall.
  // A real rear window replaces the single 4.8x2.9 beige slab that read as an
  // untextured backdrop from the Origins approach.
  const rearLeft = new THREE.Mesh(new THREE.BoxGeometry(1.7, 2.9, 0.35), V.landmarkMaterials.weathered);
  rearLeft.position.set(-1.55, 1.66, -1.775);
  const rearRight = new THREE.Mesh(new THREE.BoxGeometry(1.7, 2.9, 0.35), V.landmarkMaterials.weathered);
  rearRight.position.set(1.55, 1.66, -1.775);
  const rearHeader = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.72, 0.35), V.landmarkMaterials.weathered);
  rearHeader.position.set(0, 2.75, -1.775);
  const rearSill = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.62, 0.35), V.landmarkMaterials.weathered);
  rearSill.position.set(0, 0.52, -1.775);
  stoneParts.add(rearLeft, rearRight, rearHeader, rearSill);
  for (const side of [-1, 1]) {
    const sideWall = new THREE.Mesh(new THREE.BoxGeometry(0.35, 2.9, 3.2), V.landmarkMaterials.weathered);
    sideWall.position.set(side * 2.225, 1.66, 0);
    stoneParts.add(sideWall);
  }
  const frontLeft = new THREE.Mesh(new THREE.BoxGeometry(2.205, 2.9, 0.35), V.landmarkMaterials.weathered);
  frontLeft.position.set(-1.1025, 1.66, 1.775);
  const frontRight = new THREE.Mesh(new THREE.BoxGeometry(1.155, 2.9, 0.35), V.landmarkMaterials.weathered);
  frontRight.position.set(1.8225, 1.66, 1.775);
  const frontHeader = new THREE.Mesh(new THREE.BoxGeometry(1.05, 1.05, 0.35), V.landmarkMaterials.weathered);
  frontHeader.position.set(0.72, 2.585, 1.775);
  const chimney = new THREE.Mesh(new THREE.BoxGeometry(0.62, 2.2, 0.68), V.landmarkMaterials.weathered);
  chimney.position.set(-1.45, 3.55, -0.65);
  const buttress = new THREE.Mesh(new THREE.BoxGeometry(0.5, 1.8, 1.05), V.landmarkMaterials.weathered);
  buttress.position.set(2.45, 1.0, -0.9);
  stoneParts.add(skirt, frontLeft, frontRight, frontHeader, chimney, buttress);
  const cottageStone = registerR6Draw(
    mergeScenePrimitives(stoneParts, V.landmarkMaterials.weathered, "origins-cottage-merged-stone"),
    "originsCottage",
  );
  home.add(cottageStone);

  const agedWood = pbrMaterial({ color: 0x655846, roughness: 0.96, metalness: 0 }, "wood");
  const timberParts = new THREE.Group();
  for (const side of [-1, 1]) {
    const roof = new THREE.Mesh(new THREE.BoxGeometry(5.35, 0.22, 2.55), agedWood);
    roof.position.set(0, 3.35, side * 0.92);
    roof.rotation.x = side * 0.48;
    timberParts.add(roof);
  }
  for (const x of [-1.9, 0, 1.9]) {
    const beam = new THREE.Mesh(new THREE.BoxGeometry(0.17, 2.55, 0.18), agedWood);
    beam.position.set(x, 1.66, 2.0);
    timberParts.add(beam);
  }
  const lintel = new THREE.Mesh(new THREE.BoxGeometry(4.65, 0.18, 0.2), agedWood);
  lintel.position.set(0, 2.8, 2.0);
  timberParts.add(lintel);
  const door = new THREE.Mesh(new THREE.BoxGeometry(0.92, 1.72, 0.12), agedWood);
  door.position.set(0.72, 1.08, 1.70);
  timberParts.add(door);
  for (const side of [-1, 1]) {
    const jamb = new THREE.Mesh(new THREE.BoxGeometry(0.09, 1.9, 0.10), agedWood);
    jamb.position.set(0.72 + side * 0.57, 1.16, 1.99);
    timberParts.add(jamb);
  }
  const doorLintel = new THREE.Mesh(new THREE.BoxGeometry(1.23, 0.10, 0.10), agedWood);
  doorLintel.position.set(0.72, 2.105, 1.99);
  timberParts.add(doorLintel);
  const cottageTimber = registerR6Draw(
    mergeScenePrimitives(timberParts, agedWood, "origins-cottage-merged-timber"),
    "originsCottage",
  );
  home.add(cottageTimber);

  const windowMat = pbrMaterial({
    color: 0x3b2414,
    emissive: new THREE.Color(0xffa24e),
    emissiveIntensity: 0.72,
    roughness: 0.84,
  });
  windowMat.toneMapped = false;
  const doorWindow = new THREE.Mesh(new THREE.PlaneGeometry(0.38, 0.30), windowMat);
  doorWindow.position.set(0.72, 1.55, 1.765);
  home.add(doorWindow);
  home.rotation.y = homeSpec.rotation;
  normalizeR6LandmarkHeight(home, R6_LANDMARK_CONFIG.silhouettes.cottageTargetHeight, homeContact.y);
  home.position.x = hx;
  home.position.z = hz;
  group.add(home);
  assertR6LandmarkHeight(home, "originsCottage", homeContact.y);
  addPointGlow(group, hx + Math.sin(home.rotation.y) * 2.2, home.position.y + 1.5, hz + Math.cos(home.rotation.y) * 2.2, 0xffad62, 4.2, 20);

  // Domestic props share the harbor/forge palette instead of keeping saturated
  // GLB colors. They stay outside the architectural census because each is a
  // small authored tour prop rather than part of the merged cottage shell.
  if (models.amphora) {
    for (let i = 0; i < grounding.amphorae.length; i++) {
      const spec = grounding.amphorae[i];
      const contact = landmarkFootprint(island, spec);
      const h = i === 0 ? 1.45 : 1.15;
      const amphora = prepModel(models.amphora, h, "height", "ceramic");
      amphora.position.set(spec.lx, contact.y, spec.lz);
      amphora.rotation.y = 0.55 + i * 1.1;
      group.add(amphora);
    }
  }

  const tabletSpec = grounding.tablet;
  const tabletContact = landmarkFootprint(island, tabletSpec);
  const tabX = tabletSpec.lx;
  const tabZ = tabletSpec.lz;
  const tabGY = tabletContact.y;

  // A stone credentials tablet on a marble pedestal beside the lighthouse, with
  // thin darker inset carved lines and a warm uplight (beat 3, NEW exhibit).
  const marbleMat = pbrMaterial({ color: COL.marble, roughness: 0.92, metalness: 0, flatShading: true }, "stone");
  const tablet = new THREE.Group();
  tablet.position.set(tabX, tabGY, tabZ);
  const tabOut = Math.atan2(tabX, tabZ); // carved face turns outward toward the lens
  tablet.rotation.y = tabOut;
  const ped = new THREE.Mesh(new THREE.CylinderGeometry(0.85, 1.02, 1.4, 8), marbleMat);
  ped.position.y = 0.7; // base rests at ground contact
  tablet.add(ped);
  const slabMat = pbrMaterial({ color: 0xbdb39f, roughness: 0.94, metalness: 0, flatShading: false }, "stone");
  const slab = new THREE.Mesh(new THREE.BoxGeometry(2.2, 3.0, 0.42), slabMat);
  slab.position.y = 2.9; // rests on the pedestal top (~1.4), rising to ~4.4
  tablet.add(slab);
  const carveMat = pbrMaterial({ color: 0x8f8878, roughness: 1.0, metalness: 0 }, "stone");
  for (let i = 0; i < 4; i++) {
    const line = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 0.12), carveMat);
    line.position.set(0, 3.8 - i * 0.52, 0.22);
    tablet.add(line);
  }
  group.add(tablet);
  addPointGlow(group, tabX + Math.sin(tabOut) * 1.9, tabGY + 1.4, tabZ + Math.cos(tabOut) * 1.9, 0xffc890, 3.4, 15);

  // Beat tour poses: cottage hearth, garden ruin, and credentials tablet.
  // credentials tablet. Each anchor is the exhibit itself so the leader-line dot
  // lands on it, and each frames the object close, not a generic island orbit.
  const homeAnchor = anchorAt(island, hx, homeContact.y + 1.0, hz);
  const towerAnchor = anchorAt(island, ruinX, ruinBase + 3.5, ruinZ);
  const tabletAnchor = anchorAt(island, tabX, tabGY + 2.9, tabZ);
  const b1 = makeBeatInland(island, homeAnchor, 10.5, homeContact.y + 5.4, 1, 0.4);
  const b2 = makeBeatInland(island, towerAnchor, 12.0, ruinBase + 7.4, -1, 1.5);
  const b3 = makeBeatInland(island, tabletAnchor, 8.0, tabGY + 5.0, 1, 0.2);
  b1.emissives = [{ mat: windowMat, base: 0.72, boost: 0.96 }];
  b2.emissives = [];
  b3.emissives = [];
  island.beats = [b1, b2, b3];
  island.heroTrees = originsHeroTrees(island);
  registerLandmarkDebris(island, 6.8, 16, 0.4);
}

// ---- The Forge: amphora, anvil, brazier, rising embers ---------------------
function buildForge(group, topY, models, shared, island) {
  const grounding = R6_LANDMARK_GROUNDING.forge;
  // One merged ironwork draw with a shallow buried plinth replaces the old four
  // independent primitive draws and gives the forge a single grounded mass.
  const anvilMat = pbrMaterial({ color: 0x24262b, roughness: 0.7, metalness: 0.2, flatShading: true }, "metal");
  const anvilParts = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.9, 1.0), anvilMat);
  body.position.y = 1.4;
  const horn = new THREE.Mesh(new THREE.ConeGeometry(0.45, 1.2, 6), anvilMat);
  horn.rotation.z = Math.PI / 2;
  horn.position.set(1.5, 1.6, 0);
  const wst = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.7, 0.7), anvilMat);
  wst.position.y = 0.8;
  const foot = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.4, 1.2), anvilMat);
  foot.position.y = 0.35;
  const buriedPlinth = new THREE.Mesh(new THREE.BoxGeometry(2.25, 0.22, 1.7), anvilMat);
  buriedPlinth.position.y = 0.11;
  anvilParts.add(body, horn, wst, foot, buriedPlinth);
  const anvil = registerR6Draw(mergeScenePrimitives(anvilParts, anvilMat, "forge-merged-anvil"), "forge");
  // Slope-aware seat; the foot bites in ~0.05 (foot base sits at local y = 0.15).
  const anvilSpec = grounding.anvil;
  const anvilContact = landmarkFootprint(island, anvilSpec);
  const anvilSpot = { lx: anvilSpec.lx, lz: anvilSpec.lz, y: anvilContact.y };
  anvil.position.set(anvilSpot.lx, anvilSpot.y, anvilSpot.lz);
  group.add(anvil);

  // Procedural brazier (a bowl on legs) with an amber ember glow. Brightened so
  // the Forge reads from spawn (V1); grounded on the true surface.
  const brazier = buildBrazier(shared, "forge");
  const brazSpec = grounding.brazier;
  const brazContact = landmarkFootprint(island, brazSpec);
  const brazSpot = { lx: brazSpec.lx, lz: brazSpec.lz, y: brazContact.y };
  brazier.position.set(brazSpot.lx, brazSpot.y, brazSpot.lz);
  group.add(brazier);
  addPointGlow(group, brazSpot.lx, brazSpot.y + 2.3, brazSpot.lz, 0xff9a3c, 13, 44);

  // Amphorae as accents. Small props: rest essentially on the surface (tiny sink)
  // and relocate off any steep slope so none tilt into or sink under the ground.
  const amphSpots = [];
  if (models.amphora) {
    for (let i = 0; i < 3; i++) {
      const amp = prepModel(models.amphora, 1.8 + i * 0.24, "height", "ceramic");
      const spec = grounding.amphorae[i];
      const contact = landmarkFootprint(island, spec);
      const spot = { lx: spec.lx, lz: spec.lz, y: contact.y };
      amp.position.set(spot.lx, spot.y, spot.lz);
      amp.rotation.y = 0.7 + i * 1.37;
      group.add(amp);
      amphSpots.push(spot);
    }
  }

  // Rising ember particles above the brazier.
  island.embers = buildEmbers(group, new THREE.Vector3(brazSpot.lx, brazSpot.y + 2.1, brazSpot.lz));
  V.embers.push(island.embers);

  // Beat tour poses (B2): the anvil, the brazier, the amphora cluster, each
  // framed close so the exhibit reads as a distinct object, not island rock.
  const amphMid = amphSpots.length ? amphSpots[1] : {
    lx: grounding.amphorae[1].lx,
    lz: grounding.amphorae[1].lz,
    y: landmarkFootprint(island, grounding.amphorae[1]).y,
  };
  const anvilA = anchorAt(island, anvilSpot.lx, anvilSpot.y + 1.5, anvilSpot.lz);
  const brazA = anchorAt(island, brazSpot.lx, brazSpot.y + 2.15, brazSpot.lz);
  const amphA = anchorAt(island, amphMid.lx, amphMid.y + 1.0, amphMid.lz);
  const f1 = makeBeatOutward(island, anvilA, 7.5, anvilSpot.y + 4.0, 1, 0.4);
  const f2 = makeBeatOutward(island, brazA, 8.0, brazSpot.y + 4.6, -1, 0.8);
  const f3 = makeBeatOutward(island, amphA, 7.0, amphMid.y + 3.6, 1, 0.4);
  const coal = brazier.userData.coal;
  if (coal) f2.emissives = [glowEmissive(coal, 1.7)];
  island.beats = [f1, f2, f3];
  registerLandmarkDebris(island, 4.8, 14, 1.2);
}

function buildBrazier(shared, landmarkKey = null) {
  const g = new THREE.Group();
  const metal = pbrMaterial({ color: 0x2a2622, roughness: 0.8, metalness: 0.15, flatShading: true }, "metal");
  const metalParts = new THREE.Group();
  const bowl = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 0.5, 0.7, 8), metal);
  bowl.position.y = 2.0;
  metalParts.add(bowl);
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 2.0, 5), metal);
    leg.position.set(Math.cos(a) * 0.5, 1.0, Math.sin(a) * 0.5);
    leg.rotation.z = Math.cos(a) * 0.14;
    leg.rotation.x = -Math.sin(a) * 0.14;
    metalParts.add(leg);
  }
  const mergedMetal = mergeScenePrimitives(metalParts, metal, `${landmarkKey || "oracle"}-merged-brazier`);
  if (landmarkKey) registerR6Draw(mergedMetal, landmarkKey);
  g.add(mergedMetal);
  const coal = glowMarker(0xff7a1e, 0.6, 3.4);
  coal.position.y = 2.15;
  coal.scale.set(1.2, 0.6, 1.2);
  g.add(coal);
  g.userData.coal = coal; // exposed so a beat can pulse the ember glow (B6)
  return g;
}

function buildEmbers(group, origin) {
  const count = 80;
  const pos = new Float32Array(count * 3);
  const vel = new Float32Array(count);
  const life = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    pos[i * 3] = origin.x + (Math.random() - 0.5) * 0.8;
    pos[i * 3 + 1] = origin.y + Math.random() * 3;
    pos[i * 3 + 2] = origin.z + (Math.random() - 0.5) * 0.8;
    vel[i] = 1.2 + Math.random() * 1.8;
    life[i] = Math.random();
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  const mat = new THREE.PointsMaterial({
    color: 0xffb055,
    size: 0.28,
    sizeAttenuation: true,
    transparent: true,
    opacity: 0.9,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: true,
  });
  mat.toneMapped = false;
  const pts = new THREE.Points(geo, mat);
  pts.frustumCulled = false;
  group.add(pts);
  return { pts, pos, vel, life, origin: origin.clone(), count };
}

// Stern lantern flicker: a smoothed random walk on intensity kept inside a
// narrow band, applied to both the point light and the emissive bulb (N4).
function updateLantern(dt) {
  if (!V.ship || !V.ship.light) return;
  const target = 0.85 + Math.random() * 0.3;
  V.lantern.walk += (target - V.lantern.walk) * (1 - Math.exp(-6 * dt));
  V.ship.light.intensity = V.lantern.base * V.lantern.walk;
  if (V.ship.lantern) V.ship.lantern.material.emissiveIntensity = V.lantern.emissive * V.lantern.walk;
}

// Eased warm fill that only breathes in while docked so the framed island reads
// behind the panel, then fades out on undock (F3).
function updateDockFill(dt) {
  if (!V.dockFill) return;
  const wantOn = V.mode === "docked" || V.mode === "docking";
  const target = wantOn ? 1 : 0;
  V.dockFillLevel += (target - V.dockFillLevel) * (1 - Math.exp(-3.2 * dt));
  if (V.dockFillLevel < 0.002) {
    V.dockFill.intensity = 0;
    return;
  }
  const isl = V.dockedIsland;
  if (isl) {
    // Sit the fill between the camera and the island, lifted, lighting the near
    // face the visitor is looking at.
    _v1.set(V.camera.position.x - isl.center.x, 0, V.camera.position.z - isl.center.z);
    if (_v1.lengthSq() < 1e-4) _v1.set(0, 0, 1);
    _v1.normalize();
    V.dockFill.position.set(
      isl.center.x + _v1.x * (isl.radius + 10),
      isl.lookHeight + 12,
      isl.center.z + _v1.z * (isl.radius + 10)
    );
  }
  // Gentler by day: the island already reads in sunlight, so this is only a
  // soft warm lift on the framed face while docked (F3, retuned for point 5).
  V.dockFill.intensity = V.dockFillLevel * 12;
}

// Beat highlight (B6): ease one shared warm light onto the active beat's exhibit
// and pulse that exhibit's emissive materials up while relaxing its neighbors, so
// the docked beat frames a distinctly lit object. On tour end the light fades and
// every emissive returns to its resting level. Cheap: one moving light, a handful
// of eased emissive scalars, no per-frame allocation.
function updateBeatHighlight(dt) {
  const L = V.beatLight;
  if (!L) return;
  const docked = V.mode === "docked" && V.tour;
  if (docked) V.beatIsland = V.tour.island;
  const isl = V.beatIsland;
  const level = docked ? 1 : 0;
  V.beatLightLevel += (level - V.beatLightLevel) * (1 - Math.exp(-3 * dt));
  // Gentler beat highlight for daylight so the framed exhibit lifts without a
  // hot spotlight (B6, retuned for point 5).
  L.intensity = V.beatLightLevel * 14;
  if (!isl) return;

  const beats = isl.beats || [];
  const activeIdx = docked ? V.tour.index : -1;
  if (docked && beats[activeIdx] && beats[activeIdx].hlPos) {
    L.position.lerp(beats[activeIdx].hlPos, 1 - Math.exp(-4 * dt));
  }
  const ek = 1 - Math.exp(-5 * dt);
  for (let bi = 0; bi < beats.length; bi++) {
    const em = beats[bi].emissives;
    if (!em || !em.length) continue;
    const on = bi === activeIdx;
    for (const e of em) {
      const tgt = on ? e.boost : e.base;
      e.mat.emissiveIntensity += (tgt - e.mat.emissiveIntensity) * ek;
    }
  }
  // Once fully faded after a tour, drop the island reference so idle costs nothing.
  if (!docked && V.beatLightLevel < 0.02) V.beatIsland = null;
}

// Drift the sparse warm dust motes near islands. Cheap oscillation around each
// mote's home point, updated in place, and culled when the ship is far (N6).
function updateMotes(dt) {
  if (!V.motes.length) return;
  const t = V.time;
  for (const m of V.motes) {
    const ddx = V.pos.x - m.center.x;
    const ddz = V.pos.z - m.center.z;
    if (ddx * ddx + ddz * ddz > 160 * 160) continue;
    const { pos, home, drift, phase, count } = m;
    for (let i = 0; i < count; i++) {
      const j = i * 3;
      pos[j] = home[j] + Math.sin(t * drift[j] + phase[i]) * 2.4;
      pos[j + 1] = home[j + 1] + Math.sin(t * drift[j + 1] + phase[i] * 1.7) * 1.2;
      pos[j + 2] = home[j + 2] + Math.cos(t * drift[j + 2] + phase[i]) * 2.4;
    }
    m.pts.geometry.attributes.position.needsUpdate = true;
  }
}

function updateEmbers(dt) {
  for (const e of V.embers) {
    const { pos, vel, life, origin, count, pts } = e;
    for (let i = 0; i < count; i++) {
      life[i] += dt * 0.35;
      pos[i * 3 + 1] += vel[i] * dt;
      pos[i * 3] += Math.sin(V.time * 2 + i) * dt * 0.25;
      if (life[i] >= 1) {
        life[i] = 0;
        pos[i * 3] = origin.x + (Math.random() - 0.5) * 0.8;
        pos[i * 3 + 1] = origin.y;
        pos[i * 3 + 2] = origin.z + (Math.random() - 0.5) * 0.8;
      }
    }
    pts.geometry.attributes.position.needsUpdate = true;
  }
}

// ---- The Labors: the temple plus a colonnade of stele markers --------------
function buildLabors(group, topY, models, shared, island) {
  const templeSpec = R6_LANDMARK_GROUNDING.labors.temple;
  const templeContact = landmarkFootprint(island, templeSpec);
  const templeGY = templeContact.max + 0.04;
  // The acropolis terrace is merged into the imported temple draw. Its pale R6
  // material has the strongest environment/sun response in the landmark family.
  const templeBaseY = templeGY;
  let temple = null;
  if (models.temple) {
    temple = buildMergedGlbFoundation(
      models.temple, R6_LANDMARK_CONFIG.silhouettes.templeTargetHeight, "height", V.landmarkMaterials.hero,
      "temple", templeSpec.width, templeSpec.depth, 0.28, templeContact,
    );
  } else {
    const fallback = buildProceduralTemple(shared, templeGY);
    const terrace = new THREE.Mesh(
      terrainFoundationGeometry(templeSpec.width, templeSpec.depth, templeGY, templeContact.samples, templeSpec.sink),
      V.landmarkMaterials.hero,
    );
    fallback.add(terrace);
    temple = registerR6Draw(
      mergeScenePrimitives(fallback, V.landmarkMaterials.hero, "temple-merged-fallback"),
      "temple",
    );
  }
  temple.position.set(templeSpec.lx, models.temple ? 0 : 0, templeSpec.lz);
  temple.rotation.y = templeSpec.rotation;
  group.add(temple);
  assertR6LandmarkHeight(temple, "temple", templeContact.min - templeSpec.sink);

  // Warm glow inside the temple, brightened so the Labors reads from spawn (V1).
  const glow = glowMarker(0xffbf7a, 0.65, 2.8);
  glow.position.set(0, templeBaseY + 2.8, 0);
  group.add(glow);
  addPointGlow(group, 0, templeBaseY + 3, 0, 0xffb877, 12, 50);

  // The colonnade: one marble stele per project (Speakl first), arcing around
  // the plateau, largest first, tapering with index. Cheap: two InstancedMeshes
  // (plinths + slabs) sharing the marble family, plus one shared Points for the
  // amber sigils, so ten markers add three draw calls and zero new lights (B2).
  const n = Math.max(1, COPY.projectCount);
  const R = island.radius;
  const r0 = Math.min(R * 0.62, 9.5);

  // Center the arc so the colonnade opens toward the sea approach.
  const marble = pbrMaterial({ color: COL.marble, roughness: 0.92, metalness: 0, flatShading: true }, "stone");
  const marbleDim = pbrMaterial({ color: 0xb9b2a4, roughness: 0.95, metalness: 0, flatShading: true }, "stone");
  const plinthGeo = new THREE.BoxGeometry(1.9, 1.4, 1.5);
  const slabGeo = new THREE.CylinderGeometry(0.52, 0.72, 3.4, 4);

  const plinths = new THREE.InstancedMesh(plinthGeo, marbleDim, n);
  const slabs = new THREE.InstancedMesh(slabGeo, marble, n);
  plinths.frustumCulled = false;
  slabs.frustumCulled = false;

  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const p = new THREE.Vector3();
  const sv = new THREE.Vector3();

  const sigilPos = new Float32Array(n * 3);
  const beats = [];
  const icons = COPY.projectIcons || [];

  for (let i = 0; i < n; i++) {
    const steleSpec = laborsSteleGrounding(i, n, r0, island.outward.x, island.outward.y);
    const steleContact = landmarkFootprint(island, steleSpec);
    const lx = steleSpec.lx;
    const lz = steleSpec.lz;
    const s = 1.0 - i * 0.04; // largest first, tapering with index
    const jitter = (Math.random() - 0.5) * 0.18;
    // Outward radial in local space so a flat stele face turns toward the sea.
    const outAng = Math.atan2(lx, lz);
    const nx = lx / r0;
    const nz = lz / r0;

    // Each stele is seated on the TRUE surface sampled straight down, then sunk
    // slightly, so none float above or sink below the jittered plateau (TASK A).
    const ground = steleContact.y;

    // Plinth: base seated on the sloped plateau surface.
    const plinthH = 1.4;
    const plinthCY = ground + (plinthH * s) / 2;
    p.set(lx, plinthCY, lz);
    e.set(0, outAng + jitter, 0);
    q.setFromEuler(e);
    sv.set(s, s, s);
    m.compose(p, q, sv);
    plinths.setMatrixAt(i, m);

    // Slab: rests on the plinth, four-sided so it reads as a rectangular stele.
    const slabH = 3.4 * s;
    const slabBase = ground + plinthH * s;
    const slabCY = slabBase + slabH / 2;
    p.set(lx, slabCY, lz);
    e.set(0, outAng + Math.PI / 4 + jitter, 0);
    q.setFromEuler(e);
    m.compose(p, q, sv);
    slabs.setMatrixAt(i, m);

    const slabTop = slabBase + slabH;
    sigilPos[i * 3] = lx;
    sigilPos[i * 3 + 1] = slabTop + 0.85;
    sigilPos[i * 3 + 2] = lz;

    // PLAQUE: a square quad on the stele's outward flat face carrying the real
    // project icon, sitting just proud of the marble and facing the sea (B1).
    const plaqSize = 1.15 * s;
    const plaqY = slabBase + slabH * 0.6;
    const offset = 0.56 * s + 0.06;
    const iconPath = i < icons.length ? icons[i] : null;
    // Emissive kept under the daylight bloom knee even when the beat highlight
    // boosts it, so the icon never blooms into a hotspot (addendum 1).
    const plaque = buildIconQuad(iconPath, plaqSize, 0.34, 0.58);
    plaque.mesh.position.set(lx + nx * offset, plaqY, lz + nz * offset);
    plaque.mesh.rotation.y = outAng; // face turns outward toward the lens
    group.add(plaque.mesh);

    // Beat camera anchored on the PLAQUE so the leader-line dot lands on the
    // exhibit. The camera sits on the plaque's OUTWARD normal (a three-quarter
    // kick) so every plaque faces the lens and reads, regardless of where the
    // stele sits on the arc relative to the moon (the plaque is emissive, so it
    // does not depend on moon light to be legible).
    const anchor = new THREE.Vector3(island.center.x + lx + nx * offset, plaqY, island.center.z + lz + nz * offset);
    const beat = makeBeatOutward(island, anchor, 9.5, ground + 4.4, i % 2 === 0 ? 1 : -1, 0.1);
    beat.emissives = [plaque.emissive];
    beats.push(beat);
  }
  plinths.instanceMatrix.needsUpdate = true;
  slabs.instanceMatrix.needsUpdate = true;
  group.add(plinths);
  group.add(slabs);

  // Shared amber sigils floating above each stele (one Points, bloom-safe).
  const sigilGeo = new THREE.BufferGeometry();
  sigilGeo.setAttribute("position", new THREE.BufferAttribute(sigilPos, 3));
  const sigilMat = new THREE.PointsMaterial({
    color: 0xffb24a,
    size: 0.7,
    sizeAttenuation: true,
    transparent: true,
    opacity: 0.92,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: true,
  });
  sigilMat.toneMapped = false;
  const sigils = new THREE.Points(sigilGeo, sigilMat);
  sigils.frustumCulled = false;
  group.add(sigils);

  island.beats = beats;
  registerLandmarkDebris(island, 10.4, 24, 0.85);
}

function buildProceduralTemple(shared, topY) {
  const g = new THREE.Group();
  const marble = pbrMaterial({ color: COL.marble, roughness: 0.9, metalness: 0, flatShading: true }, "stone");
  const stepW = 16,
    stepD = 11;
  const steps = new THREE.Mesh(new THREE.BoxGeometry(stepW, 1.6, stepD), marble);
  steps.position.y = topY + 0.8;
  g.add(steps);
  const n = 6;
  for (let i = 0; i < n; i++) {
    for (const side of [-1, 1]) {
      const col = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.55, 6, 10), marble);
      col.position.set(-stepW / 2 + 1.5 + (i * (stepW - 3)) / (n - 1), topY + 4.6, (side * (stepD - 3)) / 2);
      g.add(col);
    }
  }
  const roof = new THREE.Mesh(new THREE.BoxGeometry(stepW, 1.0, stepD), marble);
  roof.position.y = topY + 8.1;
  g.add(roof);
  const pedGeo = new THREE.CylinderGeometry(0, stepD * 0.62, 2.4, 3);
  const ped = new THREE.Mesh(pedGeo, marble);
  ped.rotation.y = Math.PI / 2;
  ped.scale.x = stepW / (stepD * 0.62 * 1.5);
  ped.position.y = topY + 9.8;
  g.add(ped);
  return g;
}

// ---- The Voyages: dock, crates, moored boats -------------------------------
function buildVoyages(group, topY, models, shared, island) {
  const grounding = R6_LANDMARK_GROUNDING.voyages;
  // A pier reaches from the harbor terrace toward this region's open-water dock.
  const dirToCenter = island.outward.clone();
  const pierAngle = Math.atan2(dirToCenter.x, dirToCenter.y);

  // All four imported dock tiles and their support posts collapse into one
  // weathered-wood pier draw. Inner sections follow the pad; outer sections sit
  // at the harbor waterline without repeating saturated GLB material colors.
  const pierWood = pbrMaterial({ color: 0x756b5a, roughness: 0.97, metalness: 0, flatShading: false }, "wood");
  const pierParts = new THREE.Group();
  if (models.dock) {
    for (let i = 0; i < 4; i++) {
      const plank = mergeGlbLandmark(models.dock, 5.5, "xz", pierWood, `dock-tile-${i + 1}-premerge`);
      const d = island.radius * 0.7 + i * 5.0;
      const px = dirToCenter.x * d;
      const pz = dirToCenter.y * d;
      const surf = surfaceYAt(island.center.x + px, island.center.z + pz, island.groundTargets);
      const py = surf != null && surf > 0.5 ? surf + 0.05 : 0.35;
      plank.position.set(px, py, pz);
      plank.rotation.y = pierAngle;
      pierParts.add(plank);
      if (i >= 2) {
        for (const side of [-1, 1]) {
          const post = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.17, 1.5, 7), pierWood);
          const tx = Math.cos(pierAngle) * side * 1.25;
          const tz = -Math.sin(pierAngle) * side * 1.25;
          post.position.set(px + tx, 0.1, pz + tz);
          pierParts.add(post);
        }
      }
    }
  } else {
    const pier = new THREE.Mesh(
      new THREE.BoxGeometry(3, 0.5, 22),
      pierWood,
    );
    pier.position.set(dirToCenter.x * island.radius, 0.4, dirToCenter.y * island.radius);
    pier.rotation.y = pierAngle;
    pierParts.add(pier);
  }
  const mergedPier = registerR6Draw(mergeScenePrimitives(pierParts, pierWood, "voyages-single-merged-pier"), "dockPier");
  group.add(mergedPier);

  // The anchorage: FIVE moored vessels, one for each of the first five experience
  // entries. The sixth entry (Cashonomics) has no vessel and no beat, so the
  // docked tour reports five beats and the sixth card is never requested. Basics
  // is the flagship (ship.glb, larger); Speakl a sailboat; the rest rowboat and
  // sailboat variants. All reuse loaded GLBs, no new models. Each bobs on the
  // live wave field and flies a banner with the employer icon (B2). Vessels sit
  // in per-vessel holder groups so prepModel's recenter is preserved.
  const n = Math.min(5, Math.max(1, COPY.experienceCount));
  const icons = COPY.experienceIcons || [];
  const poleMat = pbrMaterial({ color: 0x3e2a18, roughness: 0.9, flatShading: true }, "wood");
  const beats = [];

  // The vessels float in a spread fan just off the shore, facing the open water.
  // Two design rules keep every banner unobstructed:
  //   1. The fan centre is nudged off the pier radial, so the pier drops into the
  //      gap between Basics and Speakl and never crosses a banner, and so the
  //      player's parked hull (which comes to rest ON the pier radial, well out to
  //      sea) never sits between a beat camera and its banner.
  //   2. The fan is angular, so every vessel sits on its OWN outward radial and
  //      every beat camera looks in along a different bearing. No neighbour hull,
  //      mast or sail can fall between a camera and its banner.
  // All hulls moor beyond the sandy shore ring (waterline edge ~25 from centre),
  // so each rides the waves instead of beaching. Basics moors slightly deeper and
  // leads the fan.
  const baseAz = Math.atan2(dirToCenter.x, dirToCenter.y); // bearing toward open water
  // Per-vessel: azimuth offset from the pier radial, mooring depth, camera pull
  // back along the outward radial, and camera tangential kick. Hand tuned so
  // every banner reads clear and every hull clears the shallows-ring shore.
  const azOff = [0.28, -0.30, 0.72, -0.72, 1.10];
  const depthOf = [29.5, 27.5, 27.5, 27.5, 27.5];
  const camPull = [6.5, 9.0, 9.0, 9.0, 9.0];
  const camKick = [5.0, -4.5, 4.5, -4.5, 4.5];

  for (let i = 0; i < n; i++) {
    const spec = vesselSpec(i);
    let vessel = null;
    if (models[spec.key]) {
      try {
        vessel = prepModel(models[spec.key], spec.target, "max", "weathered-boat");
      } catch (e) {
        vessel = null;
      }
    }
    if (!vessel) vessel = buildProceduralDinghy(spec.target);
    // Sink the hull a touch so the waterline reads at the deck.
    vessel.position.y -= spec.target * 0.14;

    const az = baseAz + azOff[i];
    const depth = depthOf[i];
    const nx = Math.sin(az); // outward radial (island centre -> vessel -> sea)
    const nz = Math.cos(az);
    const tx = Math.cos(az); // tangent, perpendicular to the outward radial
    const tz = -Math.sin(az);
    const lx = nx * depth;
    const lz = nz * depth;

    const holder = new THREE.Group();
    // Bobbing vessels receive the island's baked shadow but never enter its
    // static shadow map, matching the moving player ship strategy.
    holder.userData.shadowExcludeSubtree = true;
    holder.add(vessel);
    holder.position.set(lx, 0, lz);
    // Broadside to the sea so the deck reads in profile; a small jitter keeps the
    // fan from looking mechanical.
    holder.rotation.y = az + Math.PI / 2 + (Math.random() - 0.5) * 0.22;
    group.add(holder);
    configureDynamicShadowReceiver(holder);

    if (spec.flag) {
      // Flagship marker: a small dim emissive bead atop the mast. By day it needs
      // no point light (that pooled a hotspot on the banner), so the light is
      // dropped and only the tiny bead remains (addendum 1).
      const pennant = glowMarker(COL.amber, 0.24, 1.2);
      pennant.position.set(0, spec.target * 1.08, -spec.target * 0.22);
      holder.add(pennant);
    }

    // BANNER: a matte icon pennant on a tall pole that stands on the SEA facing
    // edge of the deck, lifted well above every deck box, mast and sail. From the
    // beat camera (out to sea on the same outward radial) the hull, mast and sail
    // all sit BEHIND the cloth, so nothing can cover the icon (addendum 2). The
    // cloth faces straight out along the radial toward the lens. Cashonomics is
    // gone, so no vessel ever needs to hotlink an external image.
    const localAng = az - holder.rotation.y; // cloth facing in holder space
    const ohx = Math.sin(localAng); // outward (toward sea/camera) in holder space
    const ohz = Math.cos(localAng);
    const thx = Math.cos(localAng); // cloth in-plane tangent in holder space
    const thz = -Math.sin(localAng);

    const bSize = Math.max(2.6, spec.target * 0.55); // readable at beat distance
    const poleH = spec.target * 0.55 + bSize + 0.6; // clears all deck clutter
    const poleOut = spec.target * 0.42; // stand on the sea facing deck edge
    const poleBx = ohx * poleOut;
    const poleBz = ohz * poleOut;
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, poleH, 5), poleMat);
    pole.position.set(poleBx, poleH * 0.5, poleBz);
    holder.add(pole);

    const iconPath = i < icons.length ? icons[i] : null;
    // Emissive kept under the daylight bloom knee even when the beat highlight
    // boosts it, so the banner never blooms into a hotspot (addendum 1).
    const banner = buildIconQuad(iconPath, bSize, 0.34, 0.58);
    const bSide = bSize * 0.42; // hang to one side of the pole
    const fwd = 0.35; // stand proud of the pole toward the sea/camera
    const bxLocal = poleBx + thx * bSide + ohx * fwd;
    const byLocal = poleH - bSize * 0.5 - 0.25;
    const bzLocal = poleBz + thz * bSide + ohz * fwd;
    banner.mesh.position.set(bxLocal, byLocal, bzLocal);
    banner.mesh.rotation.y = localAng; // face outward toward the sea/camera
    holder.add(banner.mesh);

    const wx = island.center.x + lx;
    const wz = island.center.z + lz;
    V.vessels.push({ holder, wx, wz, baseY: 0.0, phase: Math.random() * Math.PI * 2 });

    // Anchor the beat on the banner itself (rotate its holder-local offset into
    // world; the holder is only ever rotated about Y).
    const cosH = Math.cos(holder.rotation.y);
    const sinH = Math.sin(holder.rotation.y);
    const bwx = wx + bxLocal * cosH + bzLocal * sinH;
    const bwz = wz - bxLocal * sinH + bzLocal * cosH;
    const anchor = new THREE.Vector3(bwx, byLocal, bwz);

    // Beat camera: out to sea on the banner's own outward radial, kept nearer the
    // shore than the parked ship, with a tangential kick for a readable three
    // quarter and to hold the centre vessel off the ship's approach line. The
    // island and harbour fall in behind the banner as the backdrop.
    const rd = camPull[i];
    const sk = camKick[i];
    const beat = {
      pos: new THREE.Vector3(bwx + nx * rd + tx * sk, anchor.y + 2.2, bwz + nz * rd + tz * sk),
      look: new THREE.Vector3(bwx, anchor.y - 0.6, bwz),
      anchor: anchor.clone(),
    };
    beat.emissives = [banner.emissive];
    beats.push(beat);
  }

  // A few crates near the shore. Small props: rest essentially on the surface
  // (base contact minus a tiny sink) and relocate off any steep slope.
  const crateMat = pbrMaterial({ color: 0x6d6251, roughness: 0.97, flatShading: false }, "wood");
  for (let i = 0; i < 4; i++) {
    const c = new THREE.Mesh(new THREE.BoxGeometry(1.3, 1.3, 1.3), crateMat);
    const spec = grounding.crates[i];
    const contact = landmarkFootprint(island, spec);
    c.position.set(spec.lx, contact.y + 0.65, spec.lz);
    c.rotation.y = 0.18 + i * 0.73;
    group.add(c);
  }

  // Lantern at the pier head, brightened so the Voyages reads from spawn (V1).
  const endD = island.radius * 0.7 + 3 * 5.0;
  const lamp = glowMarker(0xffbf7a, 0.38, 3.0);
  lamp.position.set(dirToCenter.x * endD, 2.4, dirToCenter.y * endD);
  group.add(lamp);
  addPointGlow(group, dirToCenter.x * endD, 2.6, dirToCenter.y * endD, 0xffb877, 9, 34);

  island.beats = beats;
  registerLandmarkDebris(island, 5.4, 12, 2.2);
}

// Which GLB and scale each moored vessel uses. Basics is the flagship (B2).
function vesselSpec(i) {
  if (i === 0) return { key: "ship", target: 5.2, flag: true };
  if (i === 1) return { key: "boat-sail", target: 4.2, flag: false };
  return i % 2 === 0
    ? { key: "rowboat", target: 3.0, flag: false }
    : { key: "boat-sail", target: 3.6, flag: false };
}

// Minimal fallback hull if a boat GLB is missing, so every vessel beat has
// something to frame.
function buildProceduralDinghy(target) {
  const g = new THREE.Group();
  const wood = pbrMaterial({ color: 0x746957, roughness: 0.95, flatShading: false }, "wood");
  const hull = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.9, target * 0.9, 6, 1), wood);
  hull.rotation.x = Math.PI / 2;
  hull.scale.set(1, 2.4, 1);
  hull.position.y = target * 0.2;
  g.add(hull);
  return g;
}

// ---- The Oracle: ruined temple on a peak, brazier, amber pillar ------------
function buildOracle(group, topY, models, shared, island) {
  const grounding = R6_LANDMARK_GROUNDING.oracle;
  const lighthouseSpec = grounding.lighthouse;
  const lighthouseContact = landmarkFootprint(island, lighthouseSpec);
  const peakTop = lighthouseContact.max + 0.04;
  if (models.lighthouse) {
    const lighthouse = buildMergedGlbFoundation(
      models.lighthouse, R6_LANDMARK_CONFIG.silhouettes.lighthouseTargetHeight, "height", V.landmarkMaterials.weathered,
      "lighthouse", lighthouseSpec.width, lighthouseSpec.depth, 0.26, lighthouseContact,
    );
    lighthouse.position.set(lighthouseSpec.lx, 0, lighthouseSpec.lz);
    group.add(lighthouse);
    assertR6LandmarkHeight(lighthouse, "lighthouse", lighthouseContact.min - lighthouseSpec.sink);
  } else {
    const towerParts = new THREE.Group();
    const fallbackBodyHeight = R6_LANDMARK_CONFIG.silhouettes.lighthouseTargetHeight - 0.4;
    const towerBody = new THREE.Mesh(
      new THREE.CylinderGeometry(1.5, 2.5, fallbackBodyHeight, 16),
      V.landmarkMaterials.weathered,
    );
    towerBody.position.y = fallbackBodyHeight * 0.5 + 0.2;
    const towerSkirt = new THREE.Mesh(new THREE.CylinderGeometry(2.8, 3.0, 0.26, 18), V.landmarkMaterials.weathered);
    towerSkirt.position.y = 0.13;
    towerParts.add(towerBody, towerSkirt);
    const tower = registerR6Draw(
      mergeScenePrimitives(towerParts, V.landmarkMaterials.weathered, "lighthouse-merged-fallback"),
      "lighthouse",
    );
    tower.position.y = peakTop;
    group.add(tower);
    assertR6LandmarkHeight(tower, "lighthouse", lighthouseContact.min - lighthouseSpec.sink);
  }
  const lamp = glowMarker(0xffd094, 0.82, 3.6);
  const lighthouseCrownY = peakTop + R6_LANDMARK_CONFIG.silhouettes.lighthouseTargetHeight - 0.2;
  lamp.position.set(0, lighthouseCrownY, 0);
  group.add(lamp);
  addPointGlow(group, 0, lighthouseCrownY, 0, 0xffb56a, 12, 58);

  // A contact brazier sits on the seaward overlook beneath the lighthouse.
  const brazier = buildBrazier(shared);
  const altarSpec = grounding.brazier;
  const altarContact = landmarkFootprint(island, altarSpec);
  const altarSpot = { lx: altarSpec.lx, lz: altarSpec.lz, y: altarContact.y };
  const altarGY = altarSpot.y;
  brazier.position.set(altarSpot.lx, altarGY, altarSpot.lz);
  brazier.scale.setScalar(1.1);
  group.add(brazier);
  addPointGlow(group, altarSpot.lx, altarGY + 2.4, altarSpot.lz, 0xff9a3c, 10, 38);

  island.lookHeight = lighthouseCrownY - 0.8;
  island.embers = buildEmbers(group, new THREE.Vector3(altarSpot.lx, altarGY + 2.5, altarSpot.lz));
  V.embers.push(island.embers);

  const ruins = anchorAt(island, 0, peakTop + R6_LANDMARK_CONFIG.silhouettes.lighthouseTargetHeight * 0.58, 0);
  const altar = anchorAt(island, altarSpot.lx, altarGY + 2.1, altarSpot.lz);
  const o1 = makeBeatOutward(island, ruins, 22, peakTop + 13, 1, 4.5);
  const o2 = makeBeat(altar, Math.atan2(island.outward.x, island.outward.y), 9, altarGY + 4, 0.3);
  o1.emissives = [glowEmissive(lamp, 1.7)];
  const coal = brazier.userData.coal;
  if (coal) o2.emissives = [glowEmissive(coal, 1.8)];
  island.beats = [o1, o2];
  registerLandmarkDebris(island, 5.2, 16, 1.7);
}

// ===========================================================================
// INPUT
// ===========================================================================
function bindInput() {
  const onKeyDown = (e) => {
    const k = e.key.toLowerCase();
    // While docked the keys drive the beat tour, not the ship (B1).
    if (V.mode === "docked") {
      if (k === "arrowdown" || k === "pagedown") { e.preventDefault(); nextBeat(); return; }
      if (k === "arrowup" || k === "pageup") { e.preventDefault(); prevBeat(); return; }
      if (k === "escape" || k === "e") { e.preventDefault(); endTour(); return; }
      return;
    }
    if (["w", "a", "s", "d", "arrowup", "arrowdown", "arrowleft", "arrowright"].includes(k)) {
      V.keys.add(k);
      // Prevent the page from scrolling with arrows while sailing.
      if (k.startsWith("arrow")) e.preventDefault();
    }
    if (k === "e") {
      // Keyboard and touch share the exact same guarded public transition.
      // Ignoring repeats prevents a held key from racing docking/undocking.
      if (!e.repeat && requestDock()) e.preventDefault();
    }
  };
  const onKeyUp = (e) => {
    V.keys.delete(e.key.toLowerCase());
  };
  addListener(window, "keydown", onKeyDown);
  addListener(window, "keyup", onKeyUp);

  // Wheel advances/rewinds beats while docked; accumulated with a cooldown so
  // one notch is one beat (B1).
  const onWheel = (e) => {
    if (!V || V.mode !== "docked") return;
    e.preventDefault();
    V.wheelAccum += e.deltaY;
    if (V.wheelCooldown > 0) return;
    const TH = 60;
    if (V.wheelAccum > TH) { V.wheelAccum = 0; V.wheelCooldown = 0.3; nextBeat(); }
    else if (V.wheelAccum < -TH) { V.wheelAccum = 0; V.wheelCooldown = 0.3; prevBeat(); }
  };
  addListener(window, "wheel", onWheel);

  // Vertical swipe advances/rewinds beats while docked (B1).
  const onSwipeDown = (e) => {
    if (V.mode !== "docked") return;
    V.swipeStartY = e.touches ? e.touches[0].clientY : e.clientY;
  };
  const onSwipeUp = (e) => {
    if (V.mode !== "docked" || V.swipeStartY == null) return;
    const y = e.changedTouches ? e.changedTouches[0].clientY : e.clientY;
    const dy = y - V.swipeStartY;
    V.swipeStartY = null;
    const TH = 46;
    if (dy < -TH) nextBeat();
    else if (dy > TH) prevBeat();
  };
  addListener(window, "pointerdown", onSwipeDown);
  addListener(window, "pointerup", onSwipeUp);

  const onVis = () => {
    if (document.hidden) setActive(false);
    else if (V && V.mode !== "idle") setActive(true);
  };
  addListener(document, "visibilitychange", onVis);

  const onResize = () => {
    if (V.resizeTimer) clearTimeout(V.resizeTimer);
    V.resizeTimer = setTimeout(handleResize, 150);
  };
  addListener(window, "resize", onResize);

  buildJoystick();
}

function addListener(target, ev, fn) {
  // keydown and wheel need to preventDefault, so they must not be passive.
  const opts = ev === "keydown" || ev === "wheel" ? { passive: false } : undefined;
  target.addEventListener(ev, fn, opts);
  V.listeners.push([target, ev, fn, target]);
}

function buildJoystick() {
  const zone = document.getElementById("joystick-zone");
  if (!zone) return;
  const ring = document.createElement("div");
  ring.className = "joy-ring";
  const thumb = document.createElement("div");
  thumb.className = "joy-thumb";
  ring.appendChild(thumb);
  zone.appendChild(ring);
  V.joyEls = { zone, ring, thumb };

  let active = false;
  let cx = 0,
    cy = 0,
    rad = 60;

  const start = (x, y) => {
    const r = ring.getBoundingClientRect();
    cx = r.left + r.width / 2;
    cy = r.top + r.height / 2;
    rad = r.width / 2;
    active = true;
    move(x, y);
  };
  const move = (x, y) => {
    if (!active) return;
    let dx = x - cx;
    let dy = y - cy;
    const d = Math.hypot(dx, dy);
    const max = rad;
    if (d > max) {
      dx = (dx / d) * max;
      dy = (dy / d) * max;
    }
    thumb.style.transform = `translate(${dx}px, ${dy}px)`;
    V.touchTurn = -(dx / max); // right stick = turn right (heading decrease)
    V.touchThrottle = -(dy / max); // up = forward
  };
  const end = () => {
    active = false;
    thumb.style.transform = "translate(0px, 0px)";
    V.touchTurn = 0;
    V.touchThrottle = 0;
  };

  const onDown = (e) => {
    const t = e.touches ? e.touches[0] : e;
    start(t.clientX, t.clientY);
    e.preventDefault();
  };
  const onMove = (e) => {
    const t = e.touches ? e.touches[0] : e;
    move(t.clientX, t.clientY);
    if (active) e.preventDefault();
  };
  addListener(zone, "pointerdown", onDown);
  addListener(window, "pointermove", onMove);
  addListener(window, "pointerup", end);
  addListener(window, "pointercancel", end);
}

// ===========================================================================
// PROGRESSION: visited chapters, beacons, and beacon-flame ignition (point 6)
// ===========================================================================
function loadVisited() {
  // Visited progression is IN-MEMORY ONLY. Every page load starts with zero
  // visited chapters so the course line (pointing to Origins), the compass ticks,
  // and every progression reward (beacon brightening, flame ignition, completion
  // toast) replay fresh on each visit. Any stale set persisted by an older build
  // is cleared here so it can never suppress the routes again.
  try { localStorage.removeItem("hm-visited"); } catch (e) {}
  V.visited.clear();
  V.visitedList = [];
}

function saveVisited() {
  // Deliberately a no-op: visited state is not persisted (see loadVisited). Other
  // keys (hm-muted, hint flags) are owned elsewhere and left untouched.
}

function emitVisited() {
  V.visitedList = COPY.order.filter((id) => V.visited.has(id));
  if (typeof V.opts.onVisitedChange === "function") V.opts.onVisitedChange(V.visitedList.slice());
}

// Mark a chapter visited on tour end. Idempotent, and only a genuinely new
// visit chimes and can complete the voyage (C1, point 6).
function markVisited(id) {
  if (!id || V.visited.has(id)) return;
  V.visited.add(id);
  V.visitedList = COPY.order.filter((x) => V.visited.has(x));
  saveVisited();
  brightenBeacon(id);
  igniteFlame(id, true);
  emitVisited();
}

function firstUnvisitedId() {
  for (const id of COPY.order) if (!V.visited.has(id)) return id;
  return null;
}

function brightenBeacon(id) {
  const isl = V.islands.find((i) => i.id === id);
  if (isl && isl.beacon && isl.beacon.material && isl.beacon.material.uniforms) {
    isl.beacon.material.uniforms.uBoost.value = 1.7;
  }
}

// Silent restore on init: brighten beacons and ignite flames for already-visited
// chapters with no chime or completion pulse (C1, C2, point 6).
function applyVisitedVisuals() {
  for (const id of V.visited) {
    brightenBeacon(id);
    igniteFlame(id, false);
  }
}

// Ignite a chapter's beacon flame; on the fifth lit flame, pulse all five once
// together and fire the completion callback. The chime plays only for a fresh
// visit and only when unmuted (point 6). The onVoyageComplete/onVisitedChange
// flow (and its toasts) is unchanged.
function igniteFlame(id, chime) {
  const isl = V.islands.find((i) => i.id === id);
  if (isl && isl.flame) isl.flame.target = 1;
  if (chime && !V.muted) playChime(0.08);
  let lit = 0;
  for (const cid of COPY.order) {
    const i = V.islands.find((x) => x.id === cid);
    if (i && i.flame && i.flame.target >= 0.99) lit++;
  }
  if (lit >= COPY.order.length && !V.voyageComplete) {
    V.voyageComplete = true;
    for (const f of V.flames) f.pulse = 1.0;
    if (typeof V.opts.onVoyageComplete === "function") V.opts.onVoyageComplete();
  }
}

// ===========================================================================
// COURSE LINE: fine treasure-map bearing dashes projected onto the sea (A4)
// ===========================================================================
function courseRibbonMaterial(yOffset, opacity) {
  const amber = new THREE.Color(COL.amber);
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uShipPos: { value: new THREE.Vector3() },
      uColor: { value: new THREE.Vector3(amber.r, amber.g, amber.b) },
      uYOffset: { value: yOffset },
      uOpacity: { value: opacity },
    },
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
    vertexShader: `
      precision highp float;
      uniform float uTime, uYOffset;
      uniform vec3 uShipPos;
      varying vec2 vRibbonUv;
      varying float vRibbonAlpha;
      ${oceanHeightGLSL()}
      void main(){
        vec4 local = instanceMatrix * vec4(position, 1.0);
        vec4 world = modelMatrix * local;
        world.y = oceanHeight(world.xz, uTime) + uYOffset;
        vRibbonUv = uv;
        #ifdef USE_INSTANCING_COLOR
          vRibbonAlpha = instanceColor.r;
        #else
          vRibbonAlpha = 1.0;
        #endif
        // Suppress any dash that approaches the chase camera/ship. This keeps
        // perspective from turning nearby ink into a thick additive streak.
        vRibbonAlpha *= smoothstep(18.0, 30.0, distance(world.xz, uShipPos.xz));
        gl_Position = projectionMatrix * viewMatrix * world;
      }
    `,
    fragmentShader: `
      precision highp float;
      uniform vec3 uColor;
      uniform float uOpacity;
      varying vec2 vRibbonUv;
      varying float vRibbonAlpha;
      void main(){
        float sideFeather = smoothstep(0.0, 0.28, vRibbonUv.x)
                          * smoothstep(0.0, 0.28, 1.0-vRibbonUv.x);
        float endFeather = smoothstep(0.0, 0.16, vRibbonUv.y)
                         * smoothstep(0.0, 0.16, 1.0-vRibbonUv.y);
        float alpha = vRibbonAlpha * sideFeather * endFeather * uOpacity;
        if(alpha < 0.003) discard;
        gl_FragColor = vec4(uColor, alpha);
      }
    `,
  });
  mat.toneMapped = false;
  return mat;
}

function buildCourseLine() {
  const count = COURSE_DASH_COUNT;
  // Narrow fixed world dimensions plus the shader's near-ship fade keep the ink
  // thin at every useful distance. Subdivision lets each dash follow the wave.
  const geo = new THREE.PlaneGeometry(0.14, 1.55, 1, 4);
  geo.rotateX(-Math.PI / 2);
  const inst = new THREE.InstancedMesh(geo, courseRibbonMaterial(0.045, 0.68), count);
  const glowGeo = new THREE.PlaneGeometry(0.34, 1.95, 1, 4);
  glowGeo.rotateX(-Math.PI / 2);
  const glow = new THREE.InstancedMesh(glowGeo, courseRibbonMaterial(0.035, 0.07), count);
  inst.frustumCulled = false;
  glow.frustumCulled = false;
  glow.renderOrder = 1;
  inst.renderOrder = 2;
  inst.visible = false;
  glow.visible = false;
  for (let i = 0; i < count; i++) {
    inst.setColorAt(i, _colr.setScalar(1));
    glow.setColorAt(i, _colr.setScalar(1));
  }
  if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
  if (glow.instanceColor) glow.instanceColor.needsUpdate = true;
  V.scene.add(glow, inst);
  V.courseLine = { inst, glow, count };
}

function currentTargetIsland() {
  if (V.autopilot.active && V.autopilot.island) return V.autopilot.island;
  const id = firstUnvisitedId();
  if (!id) return null;
  return V.islands.find((i) => i.id === id) || null;
}

function updateCourseLine() {
  const CL = V.courseLine;
  if (!CL) return;
  // Wave conformance updates every frame even when route matrices are throttled.
  CL.inst.material.uniforms.uTime.value = V.time;
  CL.inst.material.uniforms.uShipPos.value.set(V.pos.x, 0, V.pos.z);
  CL.glow.material.uniforms.uTime.value = V.time;
  CL.glow.material.uniforms.uShipPos.value.set(V.pos.x, 0, V.pos.z);
  const target = currentTargetIsland();
  const show = V.mode === "sailing" && !!target;
  CL.inst.visible = show;
  CL.glow.visible = show;
  const targetChanged = V.courseTarget !== (show ? target : null);
  V.courseTarget = show ? target : null;
  if (!show) return;
  V.courseFrame++;
  if (!targetChanged && V.courseFrame % 3 !== 0) return;

  _fwd.set(Math.sin(V.heading), 0, Math.cos(V.heading));
  const sx = V.pos.x + _fwd.x * 6;
  const sz = V.pos.z + _fwd.z * 6;
  const route = V.autopilot.active && V.autopilot.route.length
    ? V.autopilot.route.slice(V.autopilot.routeIndex)
    : makeCoastalRoute(sx, sz, target);
  const points = [new THREE.Vector3(sx, 0, sz), ...route];
  const lengths = [0];
  let full = 0;
  for (let i = 1; i < points.length; i++) {
    full += points[i].distanceTo(points[i - 1]);
    lengths.push(full);
  }
  const count = CL.count;
  const dashSpacing = 4.15;
  const used = Math.min(count, Math.max(0, Math.floor(full / dashSpacing)));
  for (let i = 0; i < count; i++) {
    if (i >= used) {
      _sv.set(0, 0, 0);
      _pv.set(sx, 0, sz);
      _m1.compose(_pv, _q1.identity(), _sv);
      CL.inst.setMatrixAt(i, _m1);
      CL.glow.setMatrixAt(i, _m1);
      CL.inst.setColorAt(i, _colr.setScalar(0));
      CL.glow.setColorAt(i, _colr.setScalar(0));
      continue;
    }
    const dd = Math.min(full, (i + 1) * dashSpacing);
    let si = 1;
    while (si < lengths.length - 1 && lengths[si] < dd) si++;
    const a = points[si - 1], b = points[si];
    const span = Math.max(0.001, lengths[si] - lengths[si - 1]);
    const lt = (dd - lengths[si - 1]) / span;
    const px = a.x + (b.x - a.x) * lt;
    const pz = a.z + (b.z - a.z) * lt;
    _q1.setFromEuler(_e2.set(0, Math.atan2(b.x - a.x, b.z - a.z), 0));
    _sv.set(1, 1, 1);
    _pv.set(px, 0, pz);
    _m1.compose(_pv, _q1, _sv);
    CL.inst.setMatrixAt(i, _m1);
    CL.glow.setMatrixAt(i, _m1);
    // Ink appears just beyond the bow, dims with world distance, and dissolves
    // again over the final 25u so it never becomes a destination underline.
    const worldDistance = Math.hypot(px - V.pos.x, pz - V.pos.z);
    const cameraDistance = Math.hypot(px - V.camera.position.x, pz - V.camera.position.z);
    const remaining = Math.max(0, full - dd);
    const bowFade = smoothstep(18, 30, worldDistance);
    const cameraFade = smoothstep(12, 22, cameraDistance);
    const distanceFade = 1 - smoothstep(42, 148, worldDistance);
    const destinationFade = smoothstep(2.5, 25, remaining);
    const fade = bowFade * cameraFade * distanceFade * destinationFade;
    CL.inst.setColorAt(i, _colr.setScalar(fade));
    CL.glow.setColorAt(i, _colr.setScalar(fade));
  }
  CL.inst.instanceMatrix.needsUpdate = true;
  CL.glow.instanceMatrix.needsUpdate = true;
  if (CL.inst.instanceColor) CL.inst.instanceColor.needsUpdate = true;
  if (CL.glow.instanceColor) CL.glow.instanceColor.needsUpdate = true;
}

function smoothstep(e0, e1, x) {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

// ===========================================================================
// COMPASS: per-frame bearings to each island, throttled to ~10Hz (A3)
// ===========================================================================
function updateCompass(dt) {
  if (typeof V.opts.onCompassUpdate !== "function") return;
  if (V.mode !== "sailing") return;
  V.compassAccum += dt;
  if (V.compassAccum < 0.1) return;
  V.compassAccum = 0;
  const nextId = firstUnvisitedId();
  const islands = V.islands.map((isl) => {
    const bx = isl.dockPoint.x - V.pos.x;
    const bz = isl.dockPoint.z - V.pos.z;
    const nm = COPY.names[isl.id] || { name: isl.def.name, tag: isl.def.tag };
    return {
      id: isl.id,
      numeral: isl.numeral,
      name: nm.name,
      tag: nm.tag,
      bearing: Math.atan2(bx, bz),
      visited: V.visited.has(isl.id),
      next: isl.id === nextId,
    };
  });
  V.opts.onCompassUpdate({ heading: V.heading, islands });
}

// ===========================================================================
// VESSEL BOB: the five moored Voyages vessels ride the live wave field (B2)
// ===========================================================================
function updateVessels() {
  if (!V.vessels.length) return;
  const t = V.time;
  for (const v of V.vessels) {
    v.holder.position.y = waveHeight(v.wx, v.wz, t) + v.baseY;
    v.holder.rotation.z = Math.sin(t * 0.9 + v.phase) * 0.05;
    v.holder.rotation.x = Math.cos(t * 0.7 + v.phase) * 0.035;
  }
}

// ===========================================================================
// BEAT TOUR: docked mode is a scripted camera tour with anchored cards (B1, B2)
// ===========================================================================
function startTour(island) {
  const beats = island.beats && island.beats.length ? island.beats : [defaultBeat(island)];
  V.tour = {
    island,
    beats,
    index: 0,
    total: beats.length,
    moving: false,
    moveT: 0,
    moveDur: V.reducedMotion ? 0.2 : 1.1,
    from: { pos: new THREE.Vector3(), look: new THREE.Vector3() },
  };
  if (typeof V.opts.onDockedTour === "function") {
    V.opts.onDockedTour({ islandId: island.id, beatCount: beats.length });
  }
  startBeat(0);
}

function defaultBeat(island) {
  const anchor = new THREE.Vector3(island.center.x, island.lookHeight, island.center.z);
  return makeBeat(anchor, 0, island.radius + 20, island.lookHeight + 8, 0);
}

function startBeat(i) {
  const T = V.tour;
  if (!T) return;
  T.index = Math.max(0, Math.min(T.total - 1, i));
  T.from.pos.copy(V.camera.position);
  T.from.look.copy(V.camLook);
  T.moving = true;
  T.moveT = 0;
  // Decide the card side ONCE, from this beat's DESTINATION pose, so it is fixed
  // for the whole beat and never flips as the dolly settles (addendum 3).
  const beat = T.beats[T.index];
  beat.side = computeBeatSide(beat);
  if (typeof V.opts.onBeatChange === "function") {
    V.opts.onBeatChange({ islandId: T.island.id, index: T.index, total: T.total, side: beat.side });
  }
}

// Project a beat's anchor with a scratch camera placed at the beat's final pose,
// so the card goes on the half of the screen the anchor is NOT in and stays there
// for the entire beat regardless of where the dolly is mid-move (addendum 3).
function computeBeatSide(beat) {
  _sideCam.copy(V.camera, false);
  _sideCam.position.copy(beat.pos);
  _sideCam.up.set(0, 1, 0);
  _sideCam.lookAt(beat.look);
  _sideCam.updateMatrixWorld(true);
  _v3.copy(beat.anchor).project(_sideCam);
  // NDC x < 0 means the anchor is in the left half, so the card goes right.
  return _v3.x < 0 ? "right" : "left";
}

function updateTourCamera(dt) {
  const T = V.tour;
  const cam = V.camera;
  if (!T) {
    cam.lookAt(V.camLook);
    return;
  }
  const beat = T.beats[T.index];
  if (T.moving) {
    T.moveT += dt / T.moveDur;
    const tt = easeInOut(Math.min(1, T.moveT));
    cam.position.lerpVectors(T.from.pos, beat.pos, tt);
    V.camLook.lerpVectors(T.from.look, beat.look, tt);
    if (T.moveT >= 1) {
      T.moving = false;
      cam.position.copy(beat.pos);
      V.camLook.copy(beat.look);
    }
  } else {
    cam.position.copy(beat.pos);
    if (!V.reducedMotion) cam.position.y += Math.sin(V.time * 0.6) * 0.08;
    V.camLook.copy(beat.look);
  }
  cam.lookAt(V.camLook);
  emitBeatAnchor(beat);
}

function emitBeatAnchor(beat) {
  if (typeof V.opts.onBeatAnchor !== "function") return;
  _v1.copy(beat.anchor).project(V.camera);
  const visible = _v1.z < 1;
  const W = window.innerWidth;
  const H = window.innerHeight;
  const x = (_v1.x * 0.5 + 0.5) * W;
  const y = (-_v1.y * 0.5 + 0.5) * H;
  // x/y track per frame, but the side is the STABLE value fixed at beat start so
  // the DOM card never snaps across the screen mid-dolly (addendum 3).
  const side = beat.side || (x < W / 2 ? "right" : "left");
  V.opts.onBeatAnchor({ x, y, visible, side });
}

// ===========================================================================
// ATTRACT + INTRO DIVE cameras (V4)
// ===========================================================================
// A composed day film-still: the unified island fills the middle distance, the
// acropolis and lighthouse break its silhouette, and the ship crosses a sun road.
function setAttractCamera() {
  const cam = V.camera;
  // A low aerial sits behind the same ship -> dock -> summit sightline used at
  // spawn, so the scroll reveal and the chase-camera handoff tell one story.
  const lookX = HERO_POINT.x,
    lookY = HERO_POINT.y,
    lookZ = HERO_POINT.z;
  const drift = Math.sin(V.time * ((Math.PI * 2) / 60)) * 0.08;
  const ang = SPAWN.heading + drift;
  const R = 165;
  const H = 52 + Math.sin(V.time * ((Math.PI * 2) / 74)) * 2.2;
  cam.position.set(lookX - Math.sin(ang) * R, H, lookZ - Math.cos(ang) * R);
  V.camLook.set(lookX, lookY, lookZ);
  if (Math.abs(cam.fov - 60) > 0.01) {
    cam.fov = 58;
    cam.updateProjectionMatrix();
  }
  cam.lookAt(V.camLook);
}

function setSpawnAwareChaseLook(out, shipY) {
  const sinH = Math.sin(V.heading);
  const cosH = Math.cos(V.heading);
  out.set(V.pos.x + sinH * 2, shipY + CAM_LOOK_Y, V.pos.z + cosH * 2);
  const distanceFromSpawn = Math.hypot(V.pos.x - SPAWN.x, V.pos.z - SPAWN.z);
  const radius = R6_LANDMARK_CONFIG.spawnFraming.heroBlendRadius;
  const t = Math.max(0, Math.min(1, 1 - distanceFromSpawn / radius));
  const heroBlend = t * t * (3 - 2 * t);
  out.x += (HERO_POINT.x - out.x) * heroBlend;
  out.y += (HERO_POINT.y - out.y) * heroBlend;
  out.z += (HERO_POINT.z - out.z) * heroBlend;
}

// Chase pose behind the ship, used by sailing and the intro dive end.
function computeChasePose(outPos, outLook) {
  const sinH = Math.sin(V.heading);
  const cosH = Math.cos(V.heading);
  const shipY = V.ship ? V.ship.group.position.y : 0;
  outPos.set(
    V.pos.x + CAM_OFF_Z * sinH + CAM_OFF_X * cosH,
    shipY + CAM_OFF_Y,
    V.pos.z + CAM_OFF_Z * cosH - CAM_OFF_X * sinH
  );
  setSpawnAwareChaseLook(outLook, shipY);
}

// Autopilot steering toward the current sailTo target (V3).
function autopilotInput() {
  const isl = V.autopilot.island;
  if (!isl) {
    V.autopilot.active = false;
    return { throttle: 0, turn: 0 };
  }
  const ap = V.autopilot;
  if (!ap.route.length) ap.route = makeCoastalRoute(V.pos.x, V.pos.z, isl);
  let waypoint = ap.route[Math.min(ap.routeIndex, ap.route.length - 1)];
  let dx = waypoint.x - V.pos.x;
  let dz = waypoint.z - V.pos.z;
  let dist = Math.hypot(dx, dz);
  if (dist < 8 && ap.routeIndex < ap.route.length - 1) {
    ap.routeIndex++;
    waypoint = ap.route[ap.routeIndex];
    dx = waypoint.x - V.pos.x;
    dz = waypoint.z - V.pos.z;
    dist = Math.hypot(dx, dz);
  }
  const finalLeg = ap.routeIndex >= ap.route.length - 1;
  const approach = finalLeg ? dist : Math.max(28, dist);
  const desired = Math.atan2(dx, dz);
  const dh = signedAngle(desired - V.heading);
  const turn = Math.max(-1, Math.min(1, dh * 2.4));
  let throttle;
  if (finalLeg && approach <= 11) {
    // Inside dock-prompt range: brake and, once settled, auto-dock the target so
    // a hands-off sailTo flows straight into the beat tour (no E/tap needed).
    throttle = 0;
    if (approach <= 7 || Math.abs(V.speed) < 1.2) {
      V.autopilot.active = false;
      V.autopilot.arrived = true; // arrival, not a manual cancel: schedule auto-dock
      V.autopilot.arriveTimer = 0.5;
      V.autopilot.dockIsland = isl;
    }
  } else {
    // Pivot first, then drive: throttle scales with heading alignment so the
    // ship turns onto the bearing instead of orbiting the target, and eases off
    // as it nears so it does not overshoot. A small floor keeps turn authority.
    const align = Math.max(0, Math.cos(dh));
    const distFactor = Math.min(1, approach / 42);
    throttle = 0.28 + 0.72 * align * distFactor;
  }
  return { throttle, turn };
}

function signedAngle(a) {
  return ((a % (Math.PI * 2)) + Math.PI * 3) % (Math.PI * 2) - Math.PI;
}

// ===========================================================================
// AUDIO (procedural, no files). The context is created lazily on first unmute.
// ===========================================================================
function ensureAudio() {
  if (V.audio) {
    if (V.audio.ctx.state === "suspended") V.audio.ctx.resume();
    return;
  }
  let ctx;
  try {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
  } catch (e) {
    console.warn("[voyage] WebAudio unavailable", e);
    return;
  }
  const baseGain = 0.15;
  const master = ctx.createGain();
  // Always start near-silent; setMuted(false) ramps it up (V5).
  master.gain.value = 0.0001;
  master.connect(ctx.destination);

  // Brown noise buffer for the ocean swell.
  const len = ctx.sampleRate * 4;
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  let last = 0;
  for (let i = 0; i < len; i++) {
    const white = Math.random() * 2 - 1;
    last = (last + 0.02 * white) / 1.02;
    data[i] = last * 3.2;
  }
  const oceanSrc = ctx.createBufferSource();
  oceanSrc.buffer = buf;
  oceanSrc.loop = true;
  const lp = ctx.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = 400;
  const swell = ctx.createGain();
  swell.gain.value = 0.7;
  oceanSrc.connect(lp).connect(swell).connect(master);
  oceanSrc.start();

  // Slow LFO on the swell for the sense of rolling waves.
  const lfo = ctx.createOscillator();
  lfo.frequency.value = 0.08;
  const lfoGain = ctx.createGain();
  lfoGain.gain.value = 0.28;
  lfo.connect(lfoGain).connect(swell.gain);
  lfo.start();

  // Faint high breeze.
  const breezeBuf = ctx.createBuffer(1, len, ctx.sampleRate);
  const bd = breezeBuf.getChannelData(0);
  for (let i = 0; i < len; i++) bd[i] = Math.random() * 2 - 1;
  const breeze = ctx.createBufferSource();
  breeze.buffer = breezeBuf;
  breeze.loop = true;
  const hp = ctx.createBiquadFilter();
  hp.type = "highpass";
  hp.frequency.value = 1600;
  const breezeGain = ctx.createGain();
  breezeGain.gain.value = 0.02;
  breeze.connect(hp).connect(breezeGain).connect(master);
  breeze.start();

  V.audio = { ctx, master, baseGain };
}

function playChime(gain) {
  // Gate one-shots on the mute flag so nothing is even created while muted (V5).
  if (V.muted || !V.audio) return;
  const peak = gain != null ? gain : 0.16;
  const { ctx, master } = V.audio;
  const now = ctx.currentTime;
  const notes = [
    [440.0, 0.0],
    [659.25, 0.16],
  ];
  for (const [f, t] of notes) {
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.value = f;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now + t);
    g.gain.exponentialRampToValueAtTime(peak, now + t + 0.04);
    g.gain.exponentialRampToValueAtTime(0.0001, now + t + 0.9);
    osc.connect(g).connect(master);
    osc.start(now + t);
    osc.stop(now + t + 1.0);
  }
}

function playWhoosh() {
  if (V.muted || !V.audio) return;
  const { ctx, master } = V.audio;
  const now = ctx.currentTime;
  const len = ctx.sampleRate * 0.6;
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const bp = ctx.createBiquadFilter();
  bp.type = "bandpass";
  bp.frequency.setValueAtTime(300, now);
  bp.frequency.exponentialRampToValueAtTime(1200, now + 0.5);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, now);
  g.gain.linearRampToValueAtTime(0.12, now + 0.08);
  g.gain.exponentialRampToValueAtTime(0.0001, now + 0.55);
  src.connect(bp).connect(g).connect(master);
  src.start(now);
  src.stop(now + 0.6);
}

// ===========================================================================
// LOOP
// ===========================================================================
function loop() {
  if (!V || !V.running) return;
  V.rafId = requestAnimationFrame(loop);
  const nowT = performance.now();
  const frameMs = V.lastT ? nowT - V.lastT : 0;
  let dt = frameMs / 1000;
  V.lastT = nowT;
  if (frameMs > 0 && frameMs < 250) recordFramePerformance(frameMs);
  if (dt > 0.05) dt = 0.05; // clamp big gaps (tab switches)
  V.time += dt;
  update(dt);
  renderFrame();
}

function update(dt) {
  V.oceanMat.uniforms.uTime.value = V.time;
  updateTerrainMaterialTime(V.terrainMaterial, V.time);
  updateTerrainMaterialTime(V.rockMaterial, V.time);

  if (V.wheelCooldown > 0) V.wheelCooldown = Math.max(0, V.wheelCooldown - dt);

  updateShipPhysics(dt);
  updateAutoDock(dt);
  updateShipBuoyancy(dt);
  updateCamera(dt);
  updateEmbers(dt);
  updateWake(dt);
  spawnWake(dt);
  updateLantern(dt);
  updateDockFill(dt);
  updateBeatHighlight(dt);
  updateMotes(dt);
  updateVessels();
  updateFlames(dt);
  updateClouds();
  updateBirds();
  updateProximity();
  updateLabels();
  updateCompass(dt);
  updateCourseLine();

  // Push ocean/sky world state into the shader. Also called once at init so the
  // first rendered frame is never missing the sea or reading stale uniforms.
  syncWorld();
}

// Center the ocean plane under the ship, feed the shader the camera position for
// the sun glint and fog, keep the current time in the wave uniform, and pin the
// sky dome to the camera. Idempotent, no per-frame allocation.
function syncWorld() {
  if (!V || !V.oceanMat || !V.ocean) return;
  V.oceanMat.uniforms.uTime.value = V.time;
  updateTerrainMaterialTime(V.terrainMaterial, V.time);
  updateTerrainMaterialTime(V.rockMaterial, V.time);
  if (V.r5Scatter) {
    V.r5Scatter.updateWind(V.time);
    V.r5Scatter.updateForCamera(V.camera);
  }
  V.oceanMat.uniforms.uCamPos.value.copy(V.camera.position);
  // Ship world xz drives the calm ring in the wave height function. Set in place
  // (no allocation); y is the buoyant hull height.
  V.oceanMat.uniforms.uShipPos.value.set(
    V.pos.x,
    V.ship ? V.ship.group.position.y : 0.0,
    V.pos.z
  );
  _shipWX = V.pos.x;
  _shipWZ = V.pos.z;
  V.ocean.position.x = V.pos.x;
  V.ocean.position.z = V.pos.z;
  if (V.sky) V.sky.position.copy(V.camera.position);
}

function readInput() {
  let throttle = 0;
  let turn = 0;
  const k = V.keys;
  if (k.has("w") || k.has("arrowup")) throttle += 1;
  if (k.has("s") || k.has("arrowdown")) throttle -= 1;
  if (k.has("a") || k.has("arrowleft")) turn += 1;
  if (k.has("d") || k.has("arrowright")) turn -= 1;
  throttle += V.touchThrottle;
  turn += V.touchTurn;
  throttle = Math.max(-1, Math.min(1, throttle));
  turn = Math.max(-1, Math.min(1, turn));
  return { throttle, turn };
}

function updateShipPhysics(dt) {
  // While undocking, ease the ship to a safe afloat pose outside the shore so
  // it never resumes control beached (F1). Camera advances V.dockT each frame.
  if (V.mode === "undocking" && V.haveUndockTarget) {
    const tt = easeInOut(Math.min(1, V.dockT));
    V.pos.lerpVectors(V.undockFrom.pos, V.undockTo.pos, tt);
    V.heading = lerpAngle(V.undockFrom.heading, V.undockTo.heading, tt);
    V.speed = 0;
    return;
  }

  const controllable = V.mode === "sailing";
  let throttle = 0;
  let turn = 0;
  if (controllable) {
    const inp = readInput();
    if (V.autopilot.active) {
      // Any real manual input cancels autopilot instantly (V3), and a manual
      // cancel must NOT auto-dock (only a hands-off arrival does).
      if (Math.abs(inp.throttle) > 0.05 || Math.abs(inp.turn) > 0.05) {
        V.autopilot.active = false;
        V.autopilot.arrived = false;
        V.autopilot.dockIsland = null;
        throttle = inp.throttle;
        turn = inp.turn;
      } else {
        const ap = autopilotInput();
        throttle = ap.throttle;
        turn = ap.turn;
      }
    } else {
      // Grabbing the wheel during the brief post-arrival settle cancels auto-dock.
      if (V.autopilot.arrived && (Math.abs(inp.throttle) > 0.05 || Math.abs(inp.turn) > 0.05)) {
        V.autopilot.arrived = false;
        V.autopilot.dockIsland = null;
      }
      throttle = inp.throttle;
      turn = inp.turn;
    }
  }

  // Accelerate and apply drag.
  V.speed += throttle * PHYS.accel * dt;
  V.speed *= Math.exp(-PHYS.drag * dt);
  const minSpeed = -PHYS.maxSpeed * PHYS.reverseFrac;
  if (V.speed > PHYS.maxSpeed) V.speed = PHYS.maxSpeed;
  if (V.speed < minSpeed) V.speed = minSpeed;
  if (!controllable) {
    // Ease to a stop while docking/docked/intro.
    V.speed *= Math.exp(-2.5 * dt);
  }

  // Turn authority scales with speed so a stationary ship barely turns.
  const authority = Math.max(0.15, Math.min(1, Math.abs(V.speed) / (PHYS.maxSpeed * 0.55)));
  V.heading += turn * PHYS.turnRate * authority * dt;

  // Advance position along the heading.
  _fwd.set(Math.sin(V.heading), 0, Math.cos(V.heading));
  V.pos.x += _fwd.x * V.speed * dt;
  V.pos.z += _fwd.z * V.speed * dt;

  // Soft circular play boundary.
  const r = Math.hypot(V.pos.x, V.pos.z);
  if (r > PLAY_R) {
    V.pos.x *= PLAY_R / r;
    V.pos.z *= PLAY_R / r;
    V.speed *= 0.7;
  }

  // Ground the hull against islands and the colossal ruin (F1, N3).
  if (controllable) resolveCollisions(dt);

  // Banking roll toward the turn.
  const targetBank = -turn * 0.32 * authority;
  V.bank += (targetBank - V.bank) * (1 - Math.exp(-6 * dt));
}

// Coast-normal collision with a water-depth margin. Oblique approaches have
// their inward component removed and retain the tangent component, so the ship
// slides along the foam line instead of riding onto the beach or dead-stopping.
function resolveCollisions(dt) {
  _fwd.set(Math.sin(V.heading), 0, Math.cos(V.heading));
  collideIslandShape(dt);
  if (V.ruin) collideCircle(dt, V.ruin.center.x, V.ruin.center.z, V.ruin.collideR);
}

function collideIslandShape(dt) {
  const field = islandShapeFieldWorld(V.pos.x, V.pos.z);
  if (field == null || field < -SHORE_SOFT_DISTANCE) return;
  const e = Math.max(V.terrainField.dx, V.terrainField.dz);
  // Shared SDF increases inland; negate its gradient to get the seaward normal.
  let nx = -(islandShapeFieldWorld(V.pos.x + e, V.pos.z) - islandShapeFieldWorld(V.pos.x - e, V.pos.z));
  let nz = -(islandShapeFieldWorld(V.pos.x, V.pos.z + e) - islandShapeFieldWorld(V.pos.x, V.pos.z - e));
  const nl = Math.hypot(nx, nz) || 1;
  nx /= nl; nz /= nl;
  const travelSign = V.speed < 0 ? -1 : 1;
  const moveX = _fwd.x * travelSign;
  const moveZ = _fwd.z * travelSign;
  const approach = Math.max(0, -(moveX * nx + moveZ * nz));

  if (field > -SHORE_SAFE_DISTANCE) {
    // Push the hull centre back to the seven-unit navigable-water contour.
    const push = (field + SHORE_SAFE_DISTANCE) * (1 - Math.exp(-24 * dt));
    V.pos.x += nx * push;
    V.pos.z += nz * push;

    if (approach > 0.001) {
      // Strip only the into-shore component. Preserve and steer toward the
      // tangent component so glancing collisions become a convincing slide.
      let slideX = moveX + nx * approach;
      let slideZ = moveZ + nz * approach;
      const slideLen = Math.hypot(slideX, slideZ);
      if (slideLen > 0.08) {
        slideX = slideX / slideLen + nx * 0.08;
        slideZ = slideZ / slideLen + nz * 0.08;
        const desiredTravel = Math.atan2(slideX, slideZ);
        const desiredHeading = travelSign > 0 ? desiredTravel : signedAngle(desiredTravel + Math.PI);
        V.heading = lerpAngle(V.heading, desiredHeading, 1 - Math.exp(-9 * dt));
        V.speed *= Math.max(0.38, slideLen);
      } else {
        V.speed *= Math.exp(-(7 + 10 * approach) * dt);
      }
    }
    V.ground = Math.min(1, V.ground + approach * 0.28 + 0.035);
  } else if (approach > 0) {
    const band = (field + SHORE_SOFT_DISTANCE) / (SHORE_SOFT_DISTANCE - SHORE_SAFE_DISTANCE);
    V.speed *= Math.exp(-0.75 * dt * band * approach);
    V.pos.x += nx * band * approach * 3.2 * dt;
    V.pos.z += nz * band * approach * 3.2 * dt;
  }
}

function collideCircle(dt, cx, cz, collideR) {
  const SOFT = 9; // outer band where the hull starts to scrape and slow
  let dx = V.pos.x - cx;
  let dz = V.pos.z - cz;
  let d = Math.hypot(dx, dz);
  if (d > collideR + SOFT) return;
  if (d < 1e-4) {
    dx = 1;
    dz = 0;
    d = 1e-4;
  }
  const nx = dx / d; // outward radial
  const nz = dz / d;
  // How strongly the heading points into the mass (0 when sailing away).
  const approach = Math.max(0, -(_fwd.x * nx + _fwd.z * nz));
  if (d < collideR) {
    // Grounded: bleed speed hard so it scrapes to a halt, then ease the hull
    // back out along the radial. The margin keeps it on sand, never in rock.
    V.speed *= Math.exp(-(5 + 9 * approach) * dt);
    const pen = collideR - d;
    const ease = 1 - Math.exp(-20 * dt);
    V.pos.x += nx * pen * ease;
    V.pos.z += nz * pen * ease;
    V.ground = Math.min(1, V.ground + approach * 0.5 + 0.08);
  } else if (approach > 0) {
    // Soft outer band: shave a little speed and nudge outward before contact.
    const band = (collideR + SOFT - d) / SOFT;
    V.speed *= Math.exp(-1.6 * dt * band * approach);
    V.pos.x += nx * band * approach * 5 * dt;
    V.pos.z += nz * band * approach * 5 * dt;
  }
}

// Auto-dock the sailTo target once the ship has settled in dock range. Only fires
// for a hands-off arrival (V.autopilot.arrived); a manual cancel clears the flag
// so player-driven sailing still needs the E/tap prompt (addendum 2).
function updateAutoDock(dt) {
  const ap = V.autopilot;
  if (!ap.arrived || V.mode !== "sailing") return;
  ap.arriveTimer -= dt;
  if (ap.arriveTimer <= 0) {
    const isl = ap.dockIsland;
    ap.arrived = false;
    ap.dockIsland = null;
    if (isl) beginDock(isl);
  }
}

function updateShipBuoyancy(dt) {
  const sg = V.ship.group;
  sg.position.x = V.pos.x;
  sg.position.z = V.pos.z;

  _fwd.set(Math.sin(V.heading), 0, Math.cos(V.heading));
  const rx = Math.cos(V.heading); // right vector = (cos, 0, -sin)
  const rz = -Math.sin(V.heading);
  const span = 2.2;

  const t = V.time;
  const hc = waveHeight(V.pos.x, V.pos.z, t);
  const hf = waveHeight(V.pos.x + _fwd.x * span, V.pos.z + _fwd.z * span, t);
  const hb = waveHeight(V.pos.x - _fwd.x * span, V.pos.z - _fwd.z * span, t);
  const hr = waveHeight(V.pos.x + rx * span, V.pos.z + rz * span, t);
  const hl = waveHeight(V.pos.x - rx * span, V.pos.z - rz * span, t);

  sg.position.y = hc + 0.5;

  // damped pitch with a slight bow-up trim so the low bow of the model never buries
  const pitch = Math.atan2(hb - hf, span * 2) * 0.65 - 0.055;
  const roll = Math.atan2(hr - hl, span * 2) * 0.8 + V.bank;

  _e1.set(pitch, V.heading, roll, "YXZ");
  _q1.setFromEuler(_e1);
  sg.quaternion.slerp(_q1, 1 - Math.exp(-9 * dt));
}

function updateCamera(dt) {
  const cam = V.camera;

  if (V.mode === "attract") {
    setAttractCamera();
    return;
  }

  if (V.mode === "intro") {
    // One continuous eased dive from the attract (or default) pose into the
    // chase position (V4). The chase end is recomputed each frame so a bobbing
    // ship is tracked smoothly.
    V.introT += dt / V.introDur;
    if (V.introT >= 1) {
      V.introT = 1;
      V.mode = "sailing";
    }
    const tt = easeInOut(V.introT);
    computeChasePose(_cp, _cl);
    cam.position.lerpVectors(V.introFrom.pos, _cp, tt);
    V.camLook.lerpVectors(V.introFrom.look, _cl, tt);
    // Ease the poster lens back to the sailing FOV over the dive.
    const fov = 58 + (55 - 58) * tt;
    if (Math.abs(cam.fov - fov) > 0.01) {
      cam.fov = fov;
      V.fov = fov;
      cam.updateProjectionMatrix();
    }
    cam.lookAt(V.camLook);
    return;
  }

  if (V.mode === "docking" || V.mode === "undocking") {
    V.dockT += dt / (V.mode === "docking" ? 1.2 : 1.0);
    const tt = easeInOut(Math.min(1, V.dockT));
    cam.position.lerpVectors(V.dockFrom.pos, V.dockTo.pos, tt);
    V.camLook.lerpVectors(V.dockFrom.look, V.dockTo.look, tt);
    cam.lookAt(V.camLook);
    if (V.dockT >= 1) {
      if (V.mode === "docking") {
        // Establishing dolly done: begin the scripted beat tour (B1).
        V.mode = "docked";
        startTour(V.dockedIsland);
      } else {
        V.mode = "sailing";
        V.dockedIsland = null;
        V.haveUndockTarget = false;
        V.tour = null;
        if (typeof V.opts.onUndocked === "function") V.opts.onUndocked();
      }
    }
    return;
  }

  if (V.mode === "docked") {
    updateTourCamera(dt);
    return;
  }

  // Sailing chase camera. Offset behind and to the side of the ship using yaw
  // only (no wave shake). The lateral term is the ship's right vector.
  const sinH = Math.sin(V.heading);
  const cosH = Math.cos(V.heading);
  const wantX = V.pos.x + CAM_OFF_Z * sinH + CAM_OFF_X * cosH;
  const wantZ = V.pos.z + CAM_OFF_Z * cosH - CAM_OFF_X * sinH;
  const wantY = V.ship.group.position.y + CAM_OFF_Y;
  _v1.set(wantX, wantY, wantZ);
  const k = 1 - Math.exp(-3.5 * dt);
  cam.position.lerp(_v1, k);

  // Smoothed look target slightly ahead of and above the ship.
  setSpawnAwareChaseLook(_v2, V.ship.group.position.y);
  V.camLook.lerp(_v2, k);
  cam.lookAt(V.camLook);

  // Idle camera breath: a very slow sub-degree sway when nearly still, so the
  // held sea feels alive. Disabled under reduced motion (N5).
  if (!V.reducedMotion) {
    const idle = 1 - Math.min(1, Math.abs(V.speed) / (PHYS.maxSpeed * 0.25));
    if (idle > 0.001) {
      const yaw = Math.sin(V.time * (Math.PI * 2 / 8.0)) * 0.0125 * idle; // ~0.7deg
      const roll = Math.cos(V.time * (Math.PI * 2 / 11.0)) * 0.009 * idle;
      cam.rotateY(yaw);
      cam.rotateZ(roll);
    }
  }

  // Grounding shudder: a brief subtle shake after scraping a shore (F1).
  if (V.ground > 0.001) {
    const sh = V.ground * 0.18;
    cam.position.y += Math.sin(V.time * 43.0) * sh;
    cam.position.x += Math.sin(V.time * 37.0) * sh * 0.5;
    V.ground *= Math.exp(-3.5 * dt);
  } else {
    V.ground = 0;
  }

  // Speed based FOV.
  const targetFov = 55 + 4 * Math.min(1, Math.abs(V.speed) / PHYS.maxSpeed);
  V.fov += (targetFov - V.fov) * (1 - Math.exp(-3 * dt));
  if (Math.abs(cam.fov - V.fov) > 0.01) {
    cam.fov = V.fov;
    cam.updateProjectionMatrix();
  }
}

function easeInOut(t) {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

// Interpolate between two headings along the shortest arc.
function lerpAngle(a, b, t) {
  const d = ((b - a) % (Math.PI * 2) + Math.PI * 3) % (Math.PI * 2) - Math.PI;
  return a + d * t;
}

// ===========================================================================
// PROXIMITY / DOCKING
// ===========================================================================
function dockRangeAccessible(island) {
  if (!V.terrainField) return true;
  for (let i = 0; i <= 10; i++) {
    const t = i / 10;
    const x = V.pos.x + (island.dockPoint.x - V.pos.x) * t;
    const z = V.pos.z + (island.dockPoint.z - V.pos.z) * t;
    const sdf = V.terrainField.sampleSdf(x, z);
    if (sdf != null && sdf > -3.5) return false;
  }
  return true;
}

function updateProximity() {
  if (V.mode === "docked" || V.mode === "docking" || V.mode === "undocking") {
    if (typeof V.opts.onPromptUpdate === "function") V.opts.onPromptUpdate({ visible: false, x: 0, y: 0, label: "" });
    return;
  }

  let nearest = null;
  let nearestD = Infinity;
  for (const isl of V.islands) {
    const dx = V.pos.x - isl.dockPoint.x;
    const dz = V.pos.z - isl.dockPoint.z;
    const d = Math.hypot(dx, dz);
    if (d < nearestD) {
      nearestD = d;
      nearest = isl;
    }
    // Hysteresis for the in-range flag.
    const waterConnected = d < 28 ? dockRangeAccessible(isl) : true;
    if (!isl.inRange && d < 18 && waterConnected) isl.inRange = true;
    else if (isl.inRange && (d > 26 || !waterConnected)) isl.inRange = false;
  }

  const cand = nearest && nearest.inRange ? nearest : null;
  V.nearIsland = cand;

  if (V.mode !== "sailing") {
    if (typeof V.opts.onPromptUpdate === "function") V.opts.onPromptUpdate({ visible: false, x: 0, y: 0, label: "" });
    return;
  }

  if (cand) {
    _proj.set(cand.center.x, cand.lookHeight + 3, cand.center.z);
    // The prompt renders 130% above its anchor, so it needs a taller top pad.
    // The wide side pad keeps the centered pill clear of the edges.
    const sp = projectClamped(_proj, 96, 80, 28);
    const regionName = (COPY.names[cand.id] && COPY.names[cand.id].name) || cand.def.name || cand.id;
    const template = V.isTouch ? COPY.dockMobile : COPY.dockDesktop;
    const label = String(template || "Press E to drop anchor at {name}").replace("{name}", regionName);
    if (typeof V.opts.onPromptUpdate === "function") {
      const approach = V.autopilot.active || V.autopilot.arrived ? "auto" : "manual";
      // Dock range is the interaction contract. The anchor is clamped to the
      // viewport, so an in-range prompt remains actionable even at frame edges.
      V.opts.onPromptUpdate({ visible: true, x: sp.x, y: sp.y, label, islandId: cand.id, regionName, approach });
    }
  } else {
    if (typeof V.opts.onPromptUpdate === "function") V.opts.onPromptUpdate({ visible: false, x: 0, y: 0, label: "" });
  }
}

function updateLabels() {
  if (typeof V.opts.onLabelsUpdate !== "function") return;
  const list = [];
  // Region labels are ranked in screen space; the UI shows only the strongest
  // two or three and resolves their exact DOM rectangles. This payload carries
  // distance/facing priority plus chapter state for that final collision pass.
  const showAll = V.mode === "sailing";
  const courseTarget = currentTargetIsland();
  V.camera.getWorldDirection(_v4);
  for (const isl of V.islands) {
    const nm = COPY.names[isl.id] || { name: isl.def.name, tag: isl.def.tag };
    if (showAll) {
      const dx = V.pos.x - isl.center.x;
      const dz = V.pos.z - isl.center.z;
      const d = Math.hypot(dx, dz);
      _proj.set(isl.center.x, isl.lookHeight + 8, isl.center.z);
      const sp = projectClamped(_proj, 56, 60, 44);
      _v3.copy(_proj).sub(V.camera.position).normalize();
      const facing = Math.max(0, _v4.dot(_v3));
      const centerBias = 1 - Math.min(1, Math.abs(sp.x - window.innerWidth * 0.5) / (window.innerWidth * 0.5));
      const opacity = Math.max(0.55, 1 - Math.min(1, d / 260) * 0.45);
      list.push({
        id: isl.id,
        x: sp.x,
        y: sp.y,
        visible: sp.visible,
        name: nm.name,
        tag: nm.tag,
        numeral: isl.numeral,
        opacity,
        dist: d,
        priority: (isl === courseTarget ? 5000 : 0) + (isl.inRange ? 3000 : 0) + facing * 900 + centerBias * 260 - d * 1.8,
        visited: V.visited.has(isl.id),
      });
    } else {
      list.push({
        id: isl.id,
        x: 0,
        y: 0,
        visible: false,
        name: nm.name,
        tag: nm.tag,
        numeral: isl.numeral,
        opacity: 1,
        visited: V.visited.has(isl.id),
      });
    }
  }
  V.opts.onLabelsUpdate(list);
}

// Project a world point and clamp it inside the viewport with per-edge padding
// so labels and the dock prompt never clip off screen. Since the DOM elements
// are centered on the anchor, we hide (rather than pin) when the anchor leaves
// the frame horizontally or drops far off the bottom, so a centered pill can
// never spill off an edge. Near-top anchors stay visible and clamp down (F5).
function projectClamped(v, padTop, padSide, padBottom) {
  _v1.copy(v).project(V.camera);
  const behind = _v1.z >= 1;
  const offX = _v1.x < -1.02 || _v1.x > 1.02;
  const offYTop = _v1.y > 1.6;
  const offYBot = _v1.y < -1.15;
  const W = window.innerWidth;
  const H = window.innerHeight;
  let x = (_v1.x * 0.5 + 0.5) * W;
  let y = (-_v1.y * 0.5 + 0.5) * H;
  x = Math.max(padSide, Math.min(W - padSide, x));
  y = Math.max(padTop, Math.min(H - padBottom, y));
  return { x, y, visible: !behind && !offX && !offYTop && !offYBot };
}

function beginDock(island) {
  if (!V || V.mode !== "sailing" || !island || !V.islands.includes(island)) return false;
  V.autopilot.active = false; // arriving cancels autopilot (V3)
  V.autopilot.arrived = false;
  V.autopilot.dockIsland = null;
  V.dockedIsland = island;
  V.mode = "docking";
  V.dockT = 0;
  V.dockFrom.pos.copy(V.camera.position);
  V.dockFrom.look.copy(V.camLook);

  // Framed shot: view the island from the side the ship approached, elevated.
  _v1.set(V.pos.x - island.center.x, 0, V.pos.z - island.center.z);
  if (_v1.lengthSq() < 0.001) _v1.set(0, 0, 1);
  _v1.normalize();
  const dist = island.radius + 22;
  const height = island.lookHeight + 10;
  V.dockTo.pos.set(
    island.center.x + _v1.x * dist,
    height,
    island.center.z + _v1.z * dist
  );
  V.dockTo.look.set(island.center.x, island.lookHeight * 0.55, island.center.z);

  playChime();
  // Clear any prompt immediately.
  if (typeof V.opts.onPromptUpdate === "function") V.opts.onPromptUpdate({ visible: false, x: 0, y: 0, label: "" });
  return true;
}

// ===========================================================================
// RENDER / RESIZE
// ===========================================================================
function percentile(values, q) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[index];
}

function resetPerformanceWindow() {
  V.perfSamples.length = 0;
  V.perfWarmupFrames = 0;
  V.perfOverBudgetMs = 0;
}

function recordFramePerformance(frameMs) {
  if (!V || !V.active || document.hidden) return;
  V.perfSamples.push(frameMs);
  if (V.perfSamples.length > RUNTIME_QUALITY.rollingFrames) V.perfSamples.shift();
  if (V.perfWarmupFrames < RUNTIME_QUALITY.warmupFrames) {
    V.perfWarmupFrames++;
    return;
  }
  const frameTimeP90 = percentile(V.perfSamples, 0.9);
  if (frameTimeP90 > RUNTIME_QUALITY.frameTimeP90LimitMs) {
    V.perfOverBudgetMs += frameMs;
  } else {
    V.perfOverBudgetMs = 0;
  }
  if (V.perfOverBudgetMs >= RUNTIME_QUALITY.sustainedMs) {
    applyNextRuntimeDegradation();
    resetPerformanceWindow();
  }
}

function logDegradation(message) {
  console.info(`[voyage] quality step: ${message}`);
}

function applyNextRuntimeDegradation() {
  if (!V || V.degradationExhausted) return;
  while (V.degradationStep <= 4) {
    const step = V.degradationStep++;
    if (step === 0) {
      const previous = V.dprCap;
      const next = Math.max(
        RUNTIME_QUALITY.minimumDpr,
        Math.min(previous, V.profile.dprCap) * RUNTIME_QUALITY.dprScale,
      );
      if (next < previous - 0.01) {
        V.dprCap = next;
        handleResize();
        logDegradation(`DPR ${previous.toFixed(2)} -> ${next.toFixed(2)}`);
        return;
      }
    } else if (step === 1) {
      if (V.bloom && V.bloomEnabled) {
        V.bloomEnabled = false;
        V.bloom.enabled = false;
        logDegradation("bloom off");
        return;
      }
    } else if (step === 2) {
      if (V.r5Scatter) {
        V.runtimeVegetationDensity *= RUNTIME_QUALITY.vegetationScale;
        V.runtimeGrassDistanceScale *= RUNTIME_QUALITY.grassDistanceScale;
        V.r5Scatter.setBudget({
          targetCounts: V.profile.vegetationCounts,
          density: V.runtimeVegetationDensity,
          grassCullDistance: V.profile.grassDistance * V.runtimeGrassDistanceScale,
        });
        logDegradation(`vegetation ${Math.round(V.runtimeVegetationDensity * 100)}%, grass ${Math.round(V.profile.grassDistance * V.runtimeGrassDistanceScale)}u`);
        return;
      }
    } else if (step === 3) {
      if (V.r5Scatter && V.vegetationShadowsEnabled) {
        V.vegetationShadowsEnabled = false;
        V.r5Scatter.setShadowCasting(false);
        invalidateStaticShadows();
        logDegradation("vegetation and rock shadows off");
        return;
      }
    } else {
      const nextTier = nextQualityTier(V.quality);
      if (nextTier) {
        const previousTier = V.quality;
        applyTierProfile(nextTier);
        V.degradationStep = 0;
        logDegradation(`tier ${previousTier} -> ${nextTier}`);
        return;
      }
      V.degradationExhausted = true;
    }
  }
}

function applyTierProfile(tier) {
  const profile = QUALITY_PROFILES[tier];
  if (!profile || !V || tier === V.quality) return;
  V.quality = tier;
  V.profile = profile;
  V.dprCap = Math.min(V.dprCap, profile.dprCap);
  V.bloomEnabled = V.bloomEnabled && profile.bloom;
  if (V.bloom) V.bloom.enabled = V.bloomEnabled;

  document.documentElement.dataset.voyageQuality = tier;
  document.body.classList.toggle("quality-mobile", tier === "mobile");
  if (V.canvas) V.canvas.dataset.quality = tier;

  for (const material of [
    V.terrainMaterial,
    V.rockMaterial,
    ...Object.values(V.landmarkMaterials || {}),
  ]) setTerrainMaterialQuality(material, tier);

  if (V.terrain) {
    const replacement = buildUnifiedIslandTerrain();
    V.terrain.geometry.dispose();
    V.terrain.geometry = replacement.geometry;
  }
  if (V.ocean) {
    V.ocean.geometry.dispose();
    V.ocean.geometry = buildOceanGeometry();
  }

  if (V.r5Scatter) {
    V.r5Scatter.setBudget({
      targetCounts: profile.vegetationCounts,
      density: V.runtimeVegetationDensity,
      grassCullDistance: profile.grassDistance * V.runtimeGrassDistanceScale,
    });
    V.r5Scatter.setShadowCasting(V.vegetationShadowsEnabled && profile.vegetationShadows);
  }
  V.clouds.forEach((cloud, index) => { cloud.mesh.visible = index < profile.cloudCount; });
  V.motes.forEach((mote) => { mote.pts.visible = profile.motes; });
  if (V.birds) {
    V.birds.count = Math.min(V.birds.count, profile.birdCount);
    V.birds.lines.geometry.setDrawRange(0, V.birds.count * 4);
  }
  if (V.wake) {
    V.wake.activeCount = Math.min(V.wake.sprites.length, profile.wakeCount);
    V.wake.cursor %= Math.max(1, V.wake.activeCount);
  }

  if (V.sun) {
    V.sun.shadow.dispose();
    V.sun.shadow.map = null;
    V.sun.shadow.mapPass = null;
    const shadowMapSize = selectShadowMapSize();
    V.sun.shadow.mapSize.set(shadowMapSize, shadowMapSize);
    V.sun.shadow.radius = profile.shadowRadius;
    if ("blurSamples" in V.sun.shadow) {
      V.sun.shadow.blurSamples = profile.shadowBlurSamples;
    }
    const center = stabilizedShadowCenter(shadowMapSize);
    V.sun.position.copy(center).addScaledVector(MOON_DIR, SHADOW_CONFIG.lightDistance);
    V.sun.target.position.copy(center);
  }
  buildEnvironmentFromSky();
  handleResize();
  invalidateStaticShadows();
}

function textureBytesPerPixel(texture) {
  const channels = texture.format === THREE.RedFormat || texture.format === THREE.RedIntegerFormat
    ? 1
    : texture.format === THREE.RGFormat || texture.format === THREE.RGIntegerFormat
      ? 2
      : texture.format === THREE.RGBFormat || texture.format === THREE.RGBIntegerFormat
        ? 3
        : 4;
  const bytes = texture.type === THREE.FloatType || texture.type === THREE.UnsignedIntType || texture.type === THREE.IntType
    ? 4
    : texture.type === THREE.HalfFloatType || texture.type === THREE.UnsignedShortType || texture.type === THREE.ShortType
      ? 2
      : 1;
  return channels * bytes;
}

function estimateTextureBytes() {
  if (!V) return 0;
  const textures = new Set();
  const targets = new Set();
  const addTexture = (texture) => { if (texture && texture.isTexture) textures.add(texture); };
  const addTarget = (target) => {
    if (!target || !target.isWebGLRenderTarget || targets.has(target)) return;
    targets.add(target);
    addTexture(target.texture);
    if (Array.isArray(target.textures)) target.textures.forEach(addTexture);
    addTexture(target.depthTexture);
  };
  V.textures.forEach(addTexture);
  addTexture(V.scene && V.scene.environment);
  if (V.scene) V.scene.traverse((object) => {
    const materials = object.material ? (Array.isArray(object.material) ? object.material : [object.material]) : [];
    for (const material of materials) {
      for (const value of Object.values(material)) addTexture(value);
      const shader = material.userData && material.userData.terrainShader;
      if (shader && shader.uniforms) {
        for (const uniform of Object.values(shader.uniforms)) addTexture(uniform && uniform.value);
      }
    }
  });
  addTarget(V.environmentTarget);
  addTarget(V.sun && V.sun.shadow.map);
  if (V.composer) {
    addTarget(V.composer.readBuffer);
    addTarget(V.composer.writeBuffer);
  }
  if (V.bloom) {
    addTarget(V.bloom.renderTargetBright);
    (V.bloom.renderTargetsHorizontal || []).forEach(addTarget);
    (V.bloom.renderTargetsVertical || []).forEach(addTarget);
  }

  let bytes = 0;
  for (const texture of textures) {
    const images = Array.isArray(texture.image) ? texture.image : [texture.image];
    for (const image of images) {
      const width = Number(image && image.width) || 0;
      const height = Number(image && image.height) || 0;
      const depth = Number(image && image.depth) || 1;
      bytes += width * height * depth * textureBytesPerPixel(texture) * (texture.generateMipmaps ? 4 / 3 : 1);
    }
  }
  return bytes;
}

function readPerformanceProbe() {
  if (!V || !V.renderer) return null;
  const frameP50 = percentile(V.perfSamples, 0.5);
  const frameP90 = percentile(V.perfSamples, 0.9);
  return {
    tier: V.quality,
    dpr: +V.renderer.getPixelRatio().toFixed(2),
    drawCalls: V.renderer.info.render.calls,
    triangles: V.renderer.info.render.triangles,
    textureMB: +(estimateTextureBytes() / (1024 * 1024)).toFixed(2),
    // FPS percentiles are derived from the matching frame-time percentiles so
    // fpsP90 represents the slow tail used by the downgrade policy.
    fpsP50: frameP50 > 0 ? +(1000 / frameP50).toFixed(1) : 0,
    fpsP90: frameP90 > 0 ? +(1000 / frameP90).toFixed(1) : 0,
  };
}

function invalidateStaticShadows() {
  if (!V || !V.renderer || !V.renderer.shadowMap.enabled) return;
  V.renderer.shadowMap.needsUpdate = true;
}

function freezeStaticShadowMap() {
  if (!V || !V.renderer) return;
  V.renderer.shadowMap.autoUpdate = false;
  V.renderer.shadowMap.needsUpdate = false;
  V.staticShadowsFrozen = true;
}

function renderFrame() {
  if (!V || !V.renderer) return;
  V.renderer.info.reset();
  if (V.composer) {
    V.composer.render();
  } else {
    V.renderer.render(V.scene, V.camera);
  }
}

function handleResize() {
  if (!V || !V.renderer) return;
  const w = window.innerWidth;
  const h = window.innerHeight;
  V.camera.aspect = w / h;
  V.camera.updateProjectionMatrix();
  V.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, V.dprCap));
  V.renderer.setSize(w, h, false);
  if (V.composer) {
    V.composer.setPixelRatio(V.renderer.getPixelRatio());
    V.composer.setSize(w, h);
  }
  if (V.bloom) V.bloom.setSize(w, h);
}

// ===========================================================================
// GEOMETRY / TEXTURE HELPERS
// ===========================================================================
function jitterGeometry(geo, amount) {
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    pos.setXYZ(
      i,
      pos.getX(i) + (Math.random() - 0.5) * amount,
      pos.getY(i) + (Math.random() - 0.5) * amount,
      pos.getZ(i) + (Math.random() - 0.5) * amount
    );
  }
  pos.needsUpdate = true;
}

function makeGlowTexture(hexColor, softness) {
  const size = 128;
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const ctx = c.getContext("2d");
  const col = new THREE.Color(hexColor);
  const r = Math.round(col.r * 255),
    g = Math.round(col.g * 255),
    b = Math.round(col.b * 255);
  const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, `rgba(${r},${g},${b},1)`);
  grad.addColorStop(softness || 0.4, `rgba(${r},${g},${b},0.5)`);
  grad.addColorStop(1, `rgba(${r},${g},${b},0)`);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  V.textures.push(tex);
  return tex;
}
