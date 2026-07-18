// voyage.js
// The playable 3D voyage for "An Odyssey". A low-poly ship sails a dark starlit
// sea between five island chapters. Built on three.js r0.185 via the page import map.
// Owner: Build Agent B. This module owns only itself and the joystick children it
// creates inside #joystick-zone. Everything else belongs to the page.

import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";

// ---------------------------------------------------------------------------
// Palette (linear via ColorManagement). These match the site tokens.
// ---------------------------------------------------------------------------
const COL = {
  seaDeep: 0x13448a, // vivid but deep day blue (deep water)
  seaCrest: 0x2f6cc4, // crest lift
  seaShallow: 0x35c1c8, // turquoise shallows ring near shores
  amber: 0xe78b34, // warm accent (braziers, hearths, beacons)
  amberDeep: 0xd46d07,
  peach: 0xfecb99,
  cream: 0xffe9bb, // warm white glitter on the sun road
  tan: 0xcab6a4,
  sun: 0xfff3d6, // bright warm sun disc
  skyZenith: 0x3f8fe8, // azure overhead
  skyHorizon: 0xbcd6ea, // pale blue toward the horizon
  skyWater: 0xe9dfc9, // whisper of cream right at the waterline
  haze: 0xcfe2f2, // light blue-white atmosphere / fog
  rock: 0x9d9483, // warm light-grey daylight rock
  rockLight: 0xbcb19a,
  sand: 0xe4d2a4, // warm sun-lit sand
  foliage: 0x4f9b45, // saturated Ghibli green
  marble: 0xefe9dd, // bright daylight marble
  wake: 0xffffff, // bright white foam that reads on blue (F4)
  cloudTop: 0xf6f8fb, // sun-lit cloud crown
  cloudUnder: 0x93aac6, // subtle blue-grey cloud underside
  flame: 0xffd27a, // golden beacon flame
  mote: 0xffe6b8, // pale warm dust mote tint
};

// ---------------------------------------------------------------------------
// Ocean waves: SINGLE SOURCE OF TRUTH. Used both CPU side (buoyancy) and to
// generate the GLSL height function so the shader and physics never diverge.
// A calm sea: gentle long swell plus a couple of finer directional ripples.
// ---------------------------------------------------------------------------
const WAVES = [
  { dirX: 0.94, dirZ: 0.34, amp: 0.62, len: 41, speed: 0.55 },
  { dirX: -0.55, dirZ: 0.84, amp: 0.34, len: 24, speed: 0.78 },
  { dirX: 0.22, dirZ: -0.98, amp: 0.16, len: 13, speed: 1.08 },
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
  return g;
}

// ---------------------------------------------------------------------------
// Layout, physics and tuning constants.
// ---------------------------------------------------------------------------
const PLAY_R = 220; // soft circular play boundary radius
const ISLAND_R = 120; // pentagon radius
// Lighter daytime haze than the night fog so islands read from much farther and
// fade into a bright blue-white horizon rather than vanishing into the dark (4).
const FOG_DENSITY = 0.0049;
const OCEAN_SIZE = 480;

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

const ISLAND_DEFS = [
  { id: "origins", name: "Origins", tag: "About", ang: 90, radius: 19, kind: "origins" },
  { id: "forge", name: "The Forge", tag: "Skills", ang: 162, radius: 18, kind: "forge" },
  { id: "labors", name: "The Labors", tag: "Projects", ang: 234, radius: 27, kind: "labors" },
  { id: "voyages", name: "The Voyages", tag: "Experience", ang: 306, radius: 20, kind: "voyages" },
  { id: "oracle", name: "The Oracle", tag: "Contact", ang: 18, radius: 18, kind: "oracle" },
];

// Sun low on the horizon, slightly forward and to the right so the sun road on
// the water leads the visitor toward the Origins island they face at spawn. The
// name MOON_DIR is kept only so the many downstream references stay stable; by
// day it is the sun direction that lights the scene and paints the glitter road.
const MOON_DIR = new THREE.Vector3(0.28, 0.11, 1.0).normalize();

// Daytime dims the night braziers/lamps so island point-glows read as gentle
// warm accents at noon rather than lanterns in the dark (point 5). Applied
// uniformly in addPointGlow and glowMarker so every accent scales together.
const DAY_ACCENT = 0.32; // scale for warm accent PointLights
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
    quality: "high",
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
    autopilot: { active: false, island: null, arrived: false, arriveTimer: 0, dockIsland: null },
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
  V.quality = opts.quality === "low" ? "low" : "high";
  V.reducedMotion = !!opts.reducedMotion;
  // Audio defaults to muted; only an explicit opts.muted === false unmutes.
  V.muted = opts.muted != null ? !!opts.muted : true;
  V.introDur = V.reducedMotion ? 0.8 : 2.5;
  V.isTouch =
    (typeof window !== "undefined" &&
      window.matchMedia &&
      window.matchMedia("(pointer: coarse)").matches) ||
    "ontouchstart" in window;

  // Try to pull real copy from the page data module; fall back if absent.
  await loadSiteCopy();

  buildRenderer();
  buildScene();
  buildLighting();
  buildSky();
  buildOcean();
  buildBoundary();

  // Load models (drives onProgress), then assemble the ship and islands.
  const models = await loadModels(reportProgress);
  // Shared loader for the small icon textures painted onto the Labors plaques and
  // the Voyages banners. Kept separate from the model manager so late texture
  // loads never re-drive the load progress bar; errors fall back to warm plaques.
  V.texManager = new THREE.LoadingManager();
  V.texManager.onError = (url) => console.warn("[voyage] icon texture failed", url);
  V.texLoader = new THREE.TextureLoader(V.texManager);
  buildShip(models);
  buildIslands(models);
  setOceanShallows();
  buildColossus();
  buildCourseLine();

  // Restore visited chapters from a previous visit before wiring visuals so
  // returning visitors keep their beacons, lit flames and progress dots (C1).
  loadVisited();
  applyVisitedVisuals();

  bindInput();
  handleResize();

  V.initialized = true;
  reportProgress(1);
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
  renderFrame();

  // A tiny driver hook so the page (and verification) can reach the exports even
  // before app.js wires the new controls. Guarded and side-effect free until
  // something calls it.
  if (typeof window !== "undefined") {
    window.__voyage = {
      startAttract, startVoyage, requestDock, exitDockedMode,
      nextBeat, prevBeat, endTour, sailTo, setActive, setMuted,
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
              visited: V.visitedList.slice(),
              autopilot: V.autopilot.active,
              tourIndex: V.tour ? V.tour.index : -1,
              tourTotal: V.tour ? V.tour.total : 0,
              hasAudio: !!V.audio,
              muted: V.muted,
              flames: progress,
            }
          : null;
      },
      // Wrap the live callbacks to also record payloads for verification.
      debugTap() {
        window.__cb = { beat: [], anchor: [], compass: [], visited: [], tour: [] };
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
  V.autopilot.arrived = false;
  V.autopilot.dockIsland = null;
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
  if (!V) return;
  if (V.mode !== "sailing" || !V.nearIsland) return;
  beginDock(V.nearIsland);
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
    _v1.set(V.pos.x - isl.center.x, 0, V.pos.z - isl.center.z);
    if (_v1.lengthSq() < 1e-4) _v1.set(0, 0, 1);
    _v1.normalize(); // outward radial
    const safe = isl.collideR + 10;
    V.undockTo.pos.set(isl.center.x + _v1.x * safe, 0, isl.center.z + _v1.z * safe);
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
  dockDesktop: "Press E to dock",
  dockMobile: "Tap to dock",
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
  const high = V.quality === "high";
  const renderer = new THREE.WebGLRenderer({
    canvas: V.canvas,
    antialias: high,
    alpha: false,
    powerPreference: "high-performance",
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, high ? 2 : 1.5));
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  // Daytime exposure: pulled down from the night value so the bright sky, sunlit
  // sand and marble read as airy and vibrant without clipping to pure white. The
  // sun disc, cloud crowns and flames are the only near-white elements and are
  // kept just under the clip point (point 2).
  renderer.toneMappingExposure = 0.96;
  // No shadow maps anywhere.
  renderer.shadowMap.enabled = false;
  // Keep shader-error checking on so a strict-driver (ANGLE/D3D) GLSL compile
  // failure prints the full info log to the console instead of failing silent.
  renderer.debug.checkShaderErrors = true;
  V.renderer = renderer;

  if (high) {
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
    0.5,
    0.4,
    0.85
  );
  V.bloom = bloom;
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
  // Bright warm key sunlight, lifted well above the night moon so the day image
  // is airy and saturated without harsh contrast (point 2).
  const sun = new THREE.DirectionalLight(0xfff2d6, 2.7);
  sun.position.copy(MOON_DIR).multiplyScalar(400);
  sun.target.position.set(0, 0, 0);
  V.scene.add(sun);
  V.scene.add(sun.target);

  // Sky-blue over sea-blue hemisphere: fills the whole scene with soft daylight
  // so no surface reads as a black shadow and cloud undersides pick up a subtle
  // blue-grey (point 2, point 5).
  const hemi = new THREE.HemisphereLight(0xbcdcf5, 0x6f9ac0, 1.2);
  V.scene.add(hemi);

  // Gentle cool sky fill from the anti-sun side so shaded island flanks stay
  // luminous instead of dropping to hard shadow (point 2: lift fills).
  const fill = new THREE.DirectionalLight(0x9dc0e8, 0.72);
  fill.position.set(-MOON_DIR.x, 0.45, -MOON_DIR.z).multiplyScalar(300);
  V.scene.add(fill);

  // A soft warm bounce from the sun azimuth, low and raking, for a touch of
  // sunlit warmth on seaward faces. Subtle so highlights never clip.
  const rim = new THREE.DirectionalLight(0xffe6c6, 0.35);
  rim.position.set(MOON_DIR.x, 0.2, MOON_DIR.z).multiplyScalar(300);
  V.scene.add(rim);

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

  buildClouds();
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
      uTonemap: { value: V.quality === "high" ? 0.0 : 1.0 },
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
        col = mix(col, uWater, smoothstep(0.06, -0.03, elev));
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
  const high = V.quality === "high";
  const clusterCount = high ? 12 : 6; // fewer on low quality
  // Linear vertex colours. The crown is capped well under the bloom luminance
  // knee (~0.85) so clouds read bright white after tone mapping without blooming.
  const top = [0.7, 0.72, 0.76];
  const under = [0.3, 0.37, 0.47];
  const mat = new THREE.MeshBasicMaterial({ vertexColors: true, fog: false });
  V.disposables.push(mat);
  for (let ci = 0; ci < clusterCount; ci++) {
    // Ring the sky at varied azimuth, depth and mid-to-upper height.
    const az = (ci / clusterCount) * Math.PI * 2 + (Math.random() - 0.5) * 0.55;
    const rad = 380 + Math.random() * 520;
    const height = 150 + Math.random() * 200;
    const cx = Math.sin(az) * rad;
    const cz = Math.cos(az) * rad;
    const scale = (high ? 32 : 40) * (0.7 + Math.random() * 0.85);
    const blobs = high ? 5 + Math.floor(Math.random() * 4) : 4;
    const mesh = buildCloudMesh(blobs, scale, top, under, mat);
    mesh.position.set(cx, height, cz);
    mesh.frustumCulled = false;
    mesh.renderOrder = -8; // after the dome, before scene geometry
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

// Merge a handful of flattened icosahedron blobs into one faceted cumulus lump.
function buildCloudMesh(blobs, scale, top, under, mat) {
  const positions = [];
  for (let b = 0; b < blobs; b++) {
    const r = scale * (0.45 + Math.random() * 0.4);
    const ox = (Math.random() - 0.5) * scale * 1.9;
    const oy = Math.random() * scale * 0.45;
    const oz = (Math.random() - 0.5) * scale * 1.05;
    const geo = new THREE.IcosahedronGeometry(r, 1);
    geo.scale(1.18, 0.8, 1.0); // squat cumulus base
    const p = geo.attributes.position;
    for (let i = 0; i < p.count; i++) {
      positions.push(p.getX(i) + ox, p.getY(i) + oy, p.getZ(i) + oz);
    }
    geo.dispose();
  }
  const merged = new THREE.BufferGeometry();
  merged.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  merged.computeVertexNormals(); // non-indexed => flat per-facet normals
  const nAttr = merged.attributes.normal;
  const cols = new Float32Array(nAttr.count * 3);
  for (let i = 0; i < nAttr.count; i++) {
    const t = smoothstep(-0.35, 0.65, nAttr.getY(i));
    cols[i * 3] = under[0] + (top[0] - under[0]) * t;
    cols[i * 3 + 1] = under[1] + (top[1] - under[1]) * t;
    cols[i * 3 + 2] = under[2] + (top[2] - under[2]) * t;
  }
  merged.setAttribute("color", new THREE.BufferAttribute(cols, 3));
  return new THREE.Mesh(merged, mat);
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

// ===========================================================================
// OCEAN
// ===========================================================================
function buildOcean() {
  const seg = V.quality === "high" ? 128 : 64;
  const geo = new THREE.PlaneGeometry(OCEAN_SIZE, OCEAN_SIZE, seg, seg);
  geo.rotateX(-Math.PI / 2); // lie flat: local x,z horizontal, y up

  const deep = new THREE.Color(COL.seaDeep);
  const crest = new THREE.Color(COL.seaCrest);
  const shallow = new THREE.Color(COL.seaShallow);
  const cream = new THREE.Color(COL.cream);
  const fog = new THREE.Color(COL.haze);
  // White-gold glitter for the sun road on the crests.
  const glint = new THREE.Color(0xfff6e0);
  // Island centres + shore radius packed as vec3(x, z, shoreR) so the shader can
  // paint a turquoise shallows ring around every shore. Filled after the islands
  // are built (setOceanShallows); up to five islands are supported (point 3).
  const islandVecs = [];
  for (let i = 0; i < 5; i++) islandVecs.push(new THREE.Vector3(0, 0, -1));

  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uCamPos: { value: new THREE.Vector3() },
      uMoonDir: { value: MOON_DIR.clone() },
      uDeep: { value: new THREE.Vector3(deep.r, deep.g, deep.b) },
      uCrest: { value: new THREE.Vector3(crest.r, crest.g, crest.b) },
      uShallow: { value: new THREE.Vector3(shallow.r, shallow.g, shallow.b) },
      uGlint: { value: new THREE.Vector3(glint.r, glint.g, glint.b) },
      uCream: { value: new THREE.Vector3(cream.r, cream.g, cream.b) },
      uFogColor: { value: new THREE.Vector3(fog.r, fog.g, fog.b) },
      uFogDensity: { value: FOG_DENSITY },
      uAmp: { value: WAVE_AMP_TOTAL },
      uTonemap: { value: V.quality === "high" ? 0.0 : 1.0 },
      // Ship world position (xz) drives the calm ring in the vertex height fn.
      uShipPos: { value: new THREE.Vector3() },
      // Turquoise shallows: island centres/shore-radii and how many are active.
      uIslands: { value: islandVecs },
      uIslandCount: { value: 0 },
    },
    vertexShader: `
      precision highp float;
      uniform float uTime;
      uniform vec3 uShipPos;
      varying vec3 vWorld;
      varying float vH;
      ${oceanHeightGLSL()}
      void main(){
        // Displace from ABSOLUTE world-space xz. modelMatrix carries the plane's
        // follow offset, so the shader samples the exact same wave function at the
        // exact same coordinates as the CPU buoyancy (waveHeight(x, z, t)). There
        // is no separate offset uniform that could drift out of sync with the
        // plane position, so CPU and GPU never diverge, at any distance.
        vec4 wp = modelMatrix * vec4(position, 1.0);
        float h = oceanHeight(wp.xz, uTime);
        wp.y += h;
        vWorld = wp.xyz;
        vH = h;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: `
      precision highp float;
      uniform vec3 uCamPos, uMoonDir, uDeep, uCrest, uShallow, uGlint, uCream, uFogColor;
      uniform vec3 uIslands[5];
      uniform float uFogDensity, uAmp, uTonemap, uIslandCount;
      varying vec3 vWorld;
      varying float vH;

      vec3 aces(vec3 x){
        float a=2.51, b=0.03, c=2.43, d=0.59, e=0.14;
        return clamp((x*(a*x+b))/(x*(c*x+d)+e), 0.0, 1.0);
      }

      void main(){
        // Faceted flat normal from screen-space derivatives of world position.
        vec3 n = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
        if(n.y < 0.0) n = -n;
        vec3 viewDir = normalize(uCamPos - vWorld);
        float hn = clamp(vH / uAmp * 0.5 + 0.5, 0.0, 1.0);

        // Base water: vivid deep blue rising to a brighter crest blue.
        vec3 col = mix(uDeep, uCrest, smoothstep(0.2, 0.9, hn));

        // Turquoise shallows: tint toward bright turquoise within a band of the
        // nearest island shore (distance to centre minus shore radius) (point 3).
        float ring = 0.0;
        for(int i = 0; i < 5; i++){
          if(float(i) >= uIslandCount) break;
          vec2 ic = uIslands[i].xy;
          float shoreR = uIslands[i].z;
          float dd = distance(vWorld.xz, ic) - shoreR;
          ring = max(ring, smoothstep(16.0, 1.0, dd));
        }
        col = mix(col, uShallow, ring * 0.6);

        // Subtle sun diffuse lift on the crest facets.
        float diff = max(dot(n, uMoonDir), 0.0);
        col += uCrest * diff * 0.10;

        // White-gold sparkle where the surface faces the sun: the sun road.
        vec3 hlf = normalize(uMoonDir + viewDir);
        float spec = pow(max(dot(n, hlf), 0.0), 90.0);
        col += uGlint * spec * 0.85;

        // Brighter white foam on the highest crest tips, capped under the bloom
        // knee so whitecaps sparkle without blooming.
        float foam = smoothstep(0.86, 0.99, hn);
        col = mix(col, vec3(0.82, 0.86, 0.92), foam * 0.24);

        // Subtle blue facet definition so the low-poly surface always reads.
        float up = clamp(n.y, 0.0, 1.0);
        col += uCrest * up * 0.07;

        // Hazy horizon: distant glancing water melts into the bright haze so the
        // sea meets the sky like the reference (point 3, point 4).
        float fres = pow(1.0 - max(dot(n, viewDir), 0.0), 5.0);
        col = mix(col, uFogColor, fres * 0.28);

        // Exponential-squared fog to match scene FogExp2.
        float dist = length(uCamPos - vWorld);
        float f = clamp(exp(-pow(uFogDensity * dist, 2.0)), 0.0, 1.0);
        col = mix(uFogColor, col, f);

        if(uTonemap > 0.5){
          col = aces(col);
          col = pow(col, vec3(1.0/2.2));
        }
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
  mat.extensions = { derivatives: true };
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.name = "ocean";
  V.scene.add(mesh);
  V.ocean = mesh;
  V.oceanMat = mat;
}

// Push each island's centre and shore radius into the ocean shader so it paints
// a turquoise shallows ring hugging every shore (point 3). Called once after the
// islands are built; the shore radius matches the sandy ring so the tint sits on
// the shallows and fades out over open sea.
function setOceanShallows() {
  if (!V.oceanMat) return;
  const arr = V.oceanMat.uniforms.uIslands.value;
  const n = Math.min(5, V.islands.length);
  for (let i = 0; i < n; i++) {
    const isl = V.islands[i];
    arr[i].set(isl.center.x, isl.center.z, isl.radius * 1.2);
  }
  V.oceanMat.uniforms.uIslandCount.value = n;
}

// ===========================================================================
// BOUNDARY: sparse instanced rocks ringing the far edge of the play area.
// ===========================================================================
function buildBoundary() {
  const count = 46;
  const geo = new THREE.IcosahedronGeometry(1, 0);
  jitterGeometry(geo, 0.28);
  geo.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({
    color: COL.rock,
    roughness: 1.0,
    metalness: 0.0,
    flatShading: true,
  });
  const inst = new THREE.InstancedMesh(geo, mat, count);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  const p = new THREE.Vector3();
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2 + Math.random() * 0.3;
    const r = PLAY_R + 6 + Math.random() * 26;
    p.set(Math.cos(a) * r, -1.4 + Math.random() * 1.2, Math.sin(a) * r);
    q.setFromEuler(new THREE.Euler(Math.random(), Math.random() * Math.PI * 2, Math.random()));
    const sc = 3 + Math.random() * 7;
    s.set(sc * (0.7 + Math.random() * 0.6), sc * (0.6 + Math.random() * 0.7), sc * (0.7 + Math.random() * 0.6));
    m.compose(p, q, s);
    inst.setMatrixAt(i, m);
  }
  inst.instanceMatrix.needsUpdate = true;
  inst.frustumCulled = false;
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
    "tree-cypress",
    "lighthouse",
    "dock",
    "rowboat",
    "boat-sail",
    "amphora",
    "rocks-a",
    "rocks-b",
  ];
  const manager = new THREE.LoadingManager();
  manager.onProgress = (url, loaded, total) => {
    if (total > 0) onProg((loaded / total) * 0.98);
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
  if (V && typeof V.opts.onProgress === "function") {
    V.opts.onProgress(Math.max(0, Math.min(1, p)));
  }
}

// Scale a model so its largest dimension (or a chosen axis) matches target, then
// recenter horizontally and rest its base on y = 0. The recentered model is
// WRAPPED in a holder group so callers can freely do wrapper.position.set(...)
// without discarding the base-lift (a caller setting position directly on the
// model itself would erase the recenter and drop props whose GLB pivot sits at
// their center straight into the terrain). The wrapper's origin is the model's
// base-center, so wrapper.position.y is exactly the seat height.
function prepModel(src, target, mode) {
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
  dressModel(obj);
  const wrap = new THREE.Group();
  wrap.add(obj);
  return wrap;
}

function dressModel(root) {
  root.traverse((o) => {
    if (o.isMesh) {
      o.castShadow = false;
      o.receiveShadow = false;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) {
        if (!m) continue;
        if ("roughness" in m) m.roughness = Math.min(1, (m.roughness == null ? 0.8 : m.roughness) + 0.18);
        if ("metalness" in m) m.metalness = 0.0;
        if ("envMapIntensity" in m) m.envMapIntensity = 0;
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
      const ship = prepModel(models.ship, 6, "max");
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
    new THREE.MeshStandardMaterial({
      color: 0x3a2a12,
      emissive: new THREE.Color(0xffcf99),
      emissiveIntensity: 0.4,
    })
  );
  lantern.material.toneMapped = false;
  lantern.position.set(0, 2.0, -2.6);
  hullGroup.add(lantern);

  const lampLight = new THREE.PointLight(0xffcf99, 0.0, 22, 2.0);
  lampLight.position.set(0, 2.2, -2.4);
  hullGroup.add(lampLight);

  // Record the resting intensities so the flicker random walk multiplies from
  // a stable base (N4).
  V.lantern.base = lampLight.intensity;
  V.lantern.emissive = lantern.material.emissiveIntensity;

  V.ship = { group, hull: hullGroup, lantern, light: lampLight };

  buildWake();
}

function buildProceduralShip() {
  const g = new THREE.Group();
  const woodMat = new THREE.MeshStandardMaterial({ color: 0x6b4a2c, roughness: 0.85, flatShading: true });
  const darkWood = new THREE.MeshStandardMaterial({ color: 0x3e2a18, roughness: 0.9, flatShading: true });
  const sailMat = new THREE.MeshStandardMaterial({
    color: 0xefe3c4,
    roughness: 0.95,
    side: THREE.DoubleSide,
    flatShading: true,
  });

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
  const max = 64;
  // Warm-neutral cream foam rather than cool blue-grey puffs (F4).
  const tex = makeGlowTexture(COL.wake, 0.42);
  const sprites = [];
  const container = new THREE.Group();
  container.name = "wake";
  V.scene.add(container);
  for (let i = 0; i < max; i++) {
    const mat = new THREE.SpriteMaterial({
      map: tex,
      color: COL.wake,
      transparent: true,
      opacity: 0,
      blending: THREE.NormalBlending,
      depthWrite: false,
      fog: true,
    });
    const sp = new THREE.Sprite(mat);
    sp.scale.setScalar(0.45);
    sp.visible = false;
    container.add(sp);
    sprites.push({ sp, life: 0, ttl: 1, baseScale: 0.45, vx: 0, vz: 0 });
  }
  V.wake = { container, sprites, cursor: 0, timer: 0 };
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
  w.timer = 0.13;
  // Emit two small foam specks at the stern quarters that drift outward, so the
  // wake reads as a thin opening V rather than a bright cone.
  _fwd.set(Math.sin(V.heading), 0, Math.cos(V.heading));
  const rx = Math.cos(V.heading);
  const rz = -Math.sin(V.heading);
  for (const side of [-1, 1]) {
    const s = w.sprites[w.cursor];
    w.cursor = (w.cursor + 1) % w.sprites.length;
    const px = V.pos.x - _fwd.x * 2.6 + rx * side * 0.6 + (Math.random() - 0.5) * 0.4;
    const pz = V.pos.z - _fwd.z * 2.6 + rz * side * 0.6 + (Math.random() - 0.5) * 0.4;
    s.sp.position.set(px, waveHeight(px, pz, V.time) + 0.1, pz);
    s.sp.visible = true;
    s.life = 0;
    s.ttl = 0.85 + Math.random() * 0.4;
    s.baseScale = 0.34 + Math.random() * 0.24;
    // Drift outward and a touch backward for a spreading tail.
    s.vx = rx * side * 1.3 - _fwd.x * 0.6;
    s.vz = rz * side * 1.3 - _fwd.z * 0.6;
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
    // Brighter white foam so the wake reads clearly on the vivid blue sea (F4).
    s.sp.material.opacity = Math.sin(t * Math.PI) * 0.17;
    const sc = s.baseScale * (1 + t * 1.15);
    s.sp.scale.setScalar(sc);
  }
}

// ===========================================================================
// ISLANDS
// ===========================================================================
function buildIslands(models) {
  // Shared island material palette. Daylight is bright enough that the cool
  // night emissive floor is no longer needed; the warm sun, sky-blue hemisphere
  // and cool fill keep every flank luminous with no black voids (point 5).
  const matRock = new THREE.MeshStandardMaterial({ color: COL.rock, roughness: 1.0, metalness: 0, flatShading: true });
  const matRockL = new THREE.MeshStandardMaterial({ color: COL.rockLight, roughness: 1.0, metalness: 0, flatShading: true });
  const matSand = new THREE.MeshStandardMaterial({ color: COL.sand, roughness: 1.0, metalness: 0, flatShading: true });
  const matFoliage = new THREE.MeshStandardMaterial({ color: COL.foliage, roughness: 1.0, metalness: 0, flatShading: true });
  const shared = { matRock, matRockL, matSand, matFoliage };

  ISLAND_DEFS.forEach((def, idx) => {
    const a = (def.ang * Math.PI) / 180;
    const cx = Math.cos(a) * ISLAND_R;
    const cz = Math.sin(a) * ISLAND_R;
    const group = new THREE.Group();
    group.position.set(cx, 0, cz);
    V.scene.add(group);

    const base = buildIslandBase(def.radius, shared);
    group.add(base.group);

    // Beacon pillar (slim additive amber) at the island center.
    const beacon = buildBeacon(base.topY + 4);
    beacon.position.y = 0;
    group.add(beacon);

    // Surface meshes for the build-time prop grounder (TASK A). Oracle appends
    // its peak cone to this list once it is built.
    group.updateWorldMatrix(true, true);

    const island = {
      def,
      id: def.id,
      order: idx,
      numeral: COPY.numerals[idx] || "",
      group,
      beacon,
      groundTargets: base.targets.slice(),
      // Plausible surface band for seat-Y sanity: from just below the waterline to
      // well above the dome top (headroom covers the Oracle peak added later). A
      // ray that tunnels to the dome underside falls outside this and is rejected.
      surfLoY: -2,
      surfHiY: base.topY + 14,
      center: new THREE.Vector3(cx, 0, cz),
      radius: def.radius,
      // Soft grounding radius: just past the sandy shore so the hull beaches on
      // the sand rather than punching into the rock (F1).
      collideR: def.radius * 1.12 + 3,
      topY: base.topY,
      lookHeight: base.topY + 4,
      inRange: false,
      embers: null,
      // Beat tour: camera poses precomputed from the island props (B2). Each is
      // { pos, look, anchor } in world space.
      beats: [],
    };

    // Island-specific props.
    switch (def.kind) {
      case "origins":
        buildOrigins(group, base.topY, models, shared, island);
        break;
      case "forge":
        buildForge(group, base.topY, models, shared, island);
        break;
      case "labors":
        buildLabors(group, base.topY, models, shared, island);
        break;
      case "voyages":
        buildVoyages(group, base.topY, models, shared, island);
        break;
      case "oracle":
        buildOracle(group, base.topY, models, shared, island);
        break;
    }

    // Frame each beat's anchor off to one side (alternating) so the anchored
    // card has clear space and the leader line reads intentionally (B1).
    applyBeatFraming(island);
    // Precompute each beat's highlight-light position from its exhibit anchor (B6).
    finalizeBeats(island);

    // Sparse warm dust motes drifting near this island (N6). Skipped on low
    // quality to protect the mobile frame budget.
    if (V.quality === "high") buildMotes(island);

    // A golden beacon flame at the pillar top, dark until this chapter is
    // visited (point 6).
    buildFlame(island, group);

    V.islands.push(island);
  });

  // Ship starts facing Origins (which sits in front along +Z).
  V.heading = 0;
  V.pos.set(0, 0, 0);
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

  // Faint heat glow light (off until lit).
  const light = new THREE.PointLight(0xffb257, 0, 40, 2.0);
  light.position.y = 2.4;
  g.add(light);

  group.add(g);
  const flame = { group: g, body, core, halo, light, bodyMat, coreMat, lit: 0, target: 0, pulse: 0, phase: Math.random() * Math.PI * 2 };
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
        f.light.intensity = 0;
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
    f.light.intensity = 3.2 * level * flick;
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

  const stone = new THREE.MeshStandardMaterial({
    color: 0x232830,
    roughness: 1.0,
    metalness: 0.0,
    flatShading: true,
  });

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
  const bowlMat = new THREE.MeshStandardMaterial({ color: 0x2a2018, roughness: 0.85, metalness: 0.2, flatShading: true });
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
    new THREE.MeshStandardMaterial({
      color: 0x201408,
      emissive: new THREE.Color(color),
      // Daytime dims the emissive markers so braziers/lamps read as gentle warm
      // accents at noon rather than glowing night lamps (point 5).
      emissiveIntensity: (intensity == null ? 2.6 : intensity) * DAY_EMISSIVE,
    })
  );
  m.material.toneMapped = false;
  return m;
}

function addPointGlow(group, x, y, z, color, intensity, dist) {
  // Warm accent lights are scaled down by day so they light their prop softly
  // instead of casting a night-lamp pool over the terrain (point 5).
  const l = new THREE.PointLight(color, intensity * DAY_ACCENT, dist || 26, 2.0);
  l.position.set(x, y, z);
  group.add(l);
  return l;
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

// Lowest solid contact under a wide, flat-bottomed prop (lighthouse, temple,
// home): sample the center plus a perimeter ring and keep the LOWEST valid hit so
// the base tucks in and no corner floats over a lower part of the dome. The higher
// centre bump ends up hidden inside the base. Out-of-band hits are ignored.
function footprintY(island, lx, lz, footR, fallbackY) {
  const c = island.center;
  const fb = fallbackY == null ? island.topY : fallbackY;
  let lo = Infinity;
  const consider = (s) => { if (s && inBand(island, s.y) && s.y < lo) lo = s.y; };
  consider(sampleSurface(c.x + lx, c.z + lz, island.groundTargets));
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * Math.PI * 2;
    consider(sampleSurface(c.x + lx + Math.cos(a) * footR, c.z + lz + Math.sin(a) * footR, island.groundTargets));
  }
  if (lo === Infinity) {
    console.warn("[voyage] footprint seat fell back to nominal top", island.id);
    return fb;
  }
  return lo;
}

// Find a seating spot for a small prop near LOCAL (lx, lz): if the surface there is
// steeper than ~25 degrees, sample a ring of nearby offsets and pick the flattest
// so the prop never sinks sideways into a slope. Returns { lx, lz, y }.
function groundSpot(island, lx, lz, searchR) {
  const c = island.center;
  const FLAT = 0.906; // cos(25deg)
  const base = sampleSurface(c.x + lx, c.z + lz, island.groundTargets);
  if (base && inBand(island, base.y) && base.ny >= FLAT) return { lx, lz, y: base.y };
  let best = base && inBand(island, base.y) ? { lx, lz, y: base.y, ny: base.ny } : null;
  const R = searchR || 2.2;
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2;
    const ox = Math.cos(a) * R;
    const oz = Math.sin(a) * R;
    const s = sampleSurface(c.x + lx + ox, c.z + lz + oz, island.groundTargets);
    if (s && inBand(island, s.y) && (!best || s.ny > best.ny)) best = { lx: lx + ox, lz: lz + oz, y: s.y, ny: s.ny };
  }
  if (!best) {
    console.warn("[voyage] small-prop spot fell back to nominal top", island.id);
    return { lx, lz, y: island.topY };
  }
  return { lx: best.lx, lz: best.lz, y: best.y };
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
  const mat = new THREE.MeshStandardMaterial({
    color: 0x6b5236,
    roughness: 1.0,
    metalness: 0.0,
    envMapIntensity: 0,
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
    // Anchor sits on the island center (a tower or peak): there is no outward
    // radial, so approach from the sea side (toward the play center) instead of
    // collapsing the camera onto the anchor.
    ox = -island.center.x;
    oz = -island.center.z;
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

// ---- Origins: lighthouse, cypress trees, a lit home, a credentials tablet ---
function buildOrigins(group, topY, models, shared, island) {
  // Lighthouse seated on the true surface at the island crown. Sampled across its
  // wide footprint (lowest contact) so the plinth tucks in and no corner floats.
  const lhBase = footprintY(island, 0, 0, 2.0, topY) - 0.2;
  if (models.lighthouse) {
    const lh = prepModel(models.lighthouse, 15, "height");
    lh.position.y = lhBase;
    group.add(lh);
  } else {
    const tower = new THREE.Mesh(new THREE.CylinderGeometry(1.4, 2.0, 12, 10), shared.matSand);
    tower.position.y = lhBase + 6;
    group.add(tower);
  }
  // Lantern glow near the lighthouse lamp room. Brightened so Origins reads as a
  // lit landform from spawn (V1); this is also the beat 2 highlight exhibit.
  const lamp = glowMarker(COL.amber, 0.8, 4.0);
  lamp.position.set(0, lhBase + 13, 0);
  group.add(lamp);
  addPointGlow(group, 0, lhBase + 13, 0, 0xffb066, 14, 62);
  island.beaconTopGlow = lamp;

  // A small warm door glow low on the seaward face so the tower reads as a home.
  const lhDoor = glowMarker(0xffb060, 0.32, 1.6);
  const doorOut = Math.atan2(-island.center.x, -island.center.z); // toward the sea
  lhDoor.position.set(Math.sin(doorOut) * 1.7, lhBase + 1.7, Math.cos(doorOut) * 1.7);
  group.add(lhDoor);

  // Precompute the home and tablet placements BEFORE the trees so cypresses can be
  // planted clear of them (no tree growing through the house or the tablet).
  const hx = island.radius * 0.46;
  const hz = island.radius * 0.3;
  const homeGY = footprintY(island, hx, hz, 1.7, topY);
  const tspot = groundSpot(island, island.radius * 0.3, -island.radius * 0.34, 2.0);
  const tabX = tspot.lx;
  const tabZ = tspot.lz;
  const tabGY = tspot.y;

  // Cypress trees around the crown, grounded on the true surface (base contact
  // minus a small sink) and nudged around the ring so none intersects the home,
  // the tablet, or the lighthouse at the centre (TASK A + prop-prop clearance).
  const treeSrc = models["tree-cypress"];
  const n = 6;
  for (let i = 0; i < n; i++) {
    let a = (i / n) * Math.PI * 2 + 0.6;
    const r = island.radius * (0.5 + Math.random() * 0.28);
    let tx = Math.cos(a) * r;
    let tz = Math.sin(a) * r;
    for (let k = 0; k < 8; k++) {
      const clearHome = Math.hypot(tx - hx, tz - hz) > 4.8;
      const clearTablet = Math.hypot(tx - tabX, tz - tabZ) > 3.8;
      if (clearHome && clearTablet) break;
      a += 0.35; // rotate around the ring and retry until clear
      tx = Math.cos(a) * r;
      tz = Math.sin(a) * r;
    }
    let tree;
    if (treeSrc) {
      tree = prepModel(treeSrc, 4 + Math.random() * 2, "height");
    } else {
      tree = buildProceduralCypress(shared);
    }
    tree.position.set(tx, groundY(island, tx, tz, topY) - 0.2, tz);
    tree.rotation.y = Math.random() * Math.PI;
    group.add(tree);
  }

  // A small stone home near the shore whose warm doorway is the hearth (beat 1).
  const homeStone = new THREE.MeshStandardMaterial({ color: 0x746b5c, roughness: 1.0, metalness: 0, flatShading: true });
  const home = new THREE.Group();
  const hbody = new THREE.Mesh(new THREE.BoxGeometry(3.4, 2.6, 3.0), homeStone);
  hbody.position.y = 1.3;
  home.add(hbody);
  const hroof = new THREE.Mesh(new THREE.ConeGeometry(2.8, 1.7, 4), homeStone);
  hroof.rotation.y = Math.PI / 4;
  hroof.position.y = 3.45;
  home.add(hroof);
  const hearthMat = new THREE.MeshStandardMaterial({ color: 0x1a0f06, emissive: new THREE.Color(0xffb060), emissiveIntensity: 0.55 });
  hearthMat.toneMapped = false;
  const hearth = new THREE.Mesh(new THREE.PlaneGeometry(0.95, 1.7), hearthMat);
  hearth.position.set(0, 0.95, 1.51);
  home.add(hearth);
  home.position.set(hx, homeGY - 0.1, hz);
  home.rotation.y = Math.atan2(hx, hz); // doorway faces outward toward the sea
  group.add(home);
  addPointGlow(group, hx + Math.sin(home.rotation.y) * 1.6, homeGY + 1.5, hz + Math.cos(home.rotation.y) * 1.6, 0xffb877, 4.5, 22);

  // A stone credentials tablet on a marble pedestal beside the lighthouse, with
  // thin darker inset carved lines and a warm uplight (beat 3, NEW exhibit).
  const marbleMat = new THREE.MeshStandardMaterial({ color: COL.marble, roughness: 0.92, metalness: 0, flatShading: true });
  const tablet = new THREE.Group();
  tablet.position.set(tabX, tabGY - 0.04, tabZ);
  const tabOut = Math.atan2(tabX, tabZ); // carved face turns outward toward the lens
  tablet.rotation.y = tabOut;
  const ped = new THREE.Mesh(new THREE.CylinderGeometry(0.85, 1.02, 1.4, 8), marbleMat);
  ped.position.y = 0.7; // base rests at ground contact
  tablet.add(ped);
  const slabMat = new THREE.MeshStandardMaterial({ color: COL.marble, roughness: 0.9, metalness: 0, flatShading: true, emissive: new THREE.Color(0x6b5a3a), emissiveIntensity: 0.12 });
  const slab = new THREE.Mesh(new THREE.BoxGeometry(2.2, 3.0, 0.42), slabMat);
  slab.position.y = 2.9; // rests on the pedestal top (~1.4), rising to ~4.4
  tablet.add(slab);
  const carveMat = new THREE.MeshStandardMaterial({ color: 0x8f8878, roughness: 1.0, metalness: 0 });
  for (let i = 0; i < 4; i++) {
    const line = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 0.12), carveMat);
    line.position.set(0, 3.8 - i * 0.52, 0.22);
    tablet.add(line);
  }
  group.add(tablet);
  addPointGlow(group, tabX + Math.sin(tabOut) * 1.9, tabGY + 1.4, tabZ + Math.cos(tabOut) * 1.9, 0xffc890, 3.4, 15);

  // Beat tour poses (B2): the home hearth, the lighthouse door and lamp, the
  // credentials tablet. Each anchor is the exhibit itself so the leader-line dot
  // lands on it, and each frames the object close, not a generic island orbit.
  const homeAnchor = anchorAt(island, hx, homeGY + 1.0, hz);
  const towerAnchor = anchorAt(island, 0, lhBase + 7, 0);
  const tabletAnchor = anchorAt(island, tabX, tabGY + 2.9, tabZ);
  const b1 = makeBeatOutward(island, homeAnchor, 9.5, homeGY + 4.2, 1, 0.4);
  const b2 = makeBeatOutward(island, towerAnchor, 17, lhBase + 8.5, -1, 4.5);
  const b3 = makeBeatOutward(island, tabletAnchor, 6.6, tabGY + 4.2, 1, 0.2);
  b1.emissives = [{ mat: hearthMat, base: 0.55, boost: 1.1 }];
  b2.emissives = [glowEmissive(lamp, 1.7)];
  b3.emissives = [{ mat: slabMat, base: 0.12, boost: 0.5 }];
  island.beats = [b1, b2, b3];
}

function buildProceduralCypress(shared) {
  const g = new THREE.Group();
  for (let i = 0; i < 3; i++) {
    const cone = new THREE.Mesh(
      new THREE.ConeGeometry(1.1 - i * 0.28, 2.0, 7),
      shared.matFoliage
    );
    cone.position.y = 1.2 + i * 1.3;
    g.add(cone);
  }
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.16, 1.2, 6), shared.matSand);
  trunk.position.y = 0.6;
  g.add(trunk);
  g.scale.setScalar(1.2);
  return g;
}

// ---- The Forge: amphora, anvil, brazier, rising embers ---------------------
function buildForge(group, topY, models, shared, island) {
  // Procedural anvil, seated on the true surface and sunk so its foot bites in.
  const anvilMat = new THREE.MeshStandardMaterial({ color: 0x24262b, roughness: 0.7, metalness: 0.2, flatShading: true });
  const anvil = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.9, 1.0), anvilMat);
  body.position.y = 1.4;
  const horn = new THREE.Mesh(new THREE.ConeGeometry(0.45, 1.2, 6), anvilMat);
  horn.rotation.z = Math.PI / 2;
  horn.position.set(1.5, 1.6, 0);
  const wst = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.7, 0.7), anvilMat);
  wst.position.y = 0.8;
  const foot = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.4, 1.2), anvilMat);
  foot.position.y = 0.35;
  anvil.add(body, horn, wst, foot);
  // Slope-aware seat; the foot bites in ~0.05 (foot base sits at local y = 0.15).
  const anvilSpot = groundSpot(island, -2.2, 1.0, 2.0);
  anvil.position.set(anvilSpot.lx, anvilSpot.y - 0.2, anvilSpot.lz);
  group.add(anvil);

  // Procedural brazier (a bowl on legs) with an amber ember glow. Brightened so
  // the Forge reads from spawn (V1); grounded on the true surface.
  const brazier = buildBrazier(shared);
  const brazSpot = groundSpot(island, 1.6, -0.6, 2.0);
  brazier.position.set(brazSpot.lx, brazSpot.y - 0.05, brazSpot.lz);
  group.add(brazier);
  addPointGlow(group, brazSpot.lx, brazSpot.y + 2.3, brazSpot.lz, 0xff9a3c, 13, 44);

  // Amphorae as accents. Small props: rest essentially on the surface (tiny sink)
  // and relocate off any steep slope so none tilt into or sink under the ground.
  const amphAngles = [1.0, 3.1, 5.2];
  const amphSpots = [];
  if (models.amphora) {
    for (let i = 0; i < 3; i++) {
      const amp = prepModel(models.amphora, 1.8 + Math.random() * 0.6, "height");
      const a = amphAngles[i];
      const spot = groundSpot(island, Math.cos(a) * 4.5, Math.sin(a) * 4.5, 2.0);
      amp.position.set(spot.lx, spot.y - 0.04, spot.lz);
      amp.rotation.y = Math.random() * Math.PI;
      group.add(amp);
      amphSpots.push(spot);
    }
  }

  // Rising ember particles above the brazier.
  island.embers = buildEmbers(group, new THREE.Vector3(brazSpot.lx, brazSpot.y + 2.1, brazSpot.lz));
  V.embers.push(island.embers);

  // Beat tour poses (B2): the anvil, the brazier, the amphora cluster, each
  // framed close so the exhibit reads as a distinct object, not island rock.
  const amphMid = amphSpots.length ? amphSpots[1] : groundSpot(island, Math.cos(3.1) * 4.5, Math.sin(3.1) * 4.5, 2.0);
  const anvilA = anchorAt(island, anvilSpot.lx, anvilSpot.y + 1.5, anvilSpot.lz);
  const brazA = anchorAt(island, brazSpot.lx, brazSpot.y + 2.15, brazSpot.lz);
  const amphA = anchorAt(island, amphMid.lx, amphMid.y + 1.0, amphMid.lz);
  const f1 = makeBeatOutward(island, anvilA, 7.5, anvilSpot.y + 4.0, 1, 0.4);
  const f2 = makeBeatOutward(island, brazA, 8.0, brazSpot.y + 4.6, -1, 0.8);
  const f3 = makeBeatOutward(island, amphA, 7.0, amphMid.y + 3.6, 1, 0.4);
  const coal = brazier.userData.coal;
  if (coal) f2.emissives = [glowEmissive(coal, 1.7)];
  island.beats = [f1, f2, f3];
}

function buildBrazier(shared) {
  const g = new THREE.Group();
  const metal = new THREE.MeshStandardMaterial({ color: 0x2a2622, roughness: 0.8, metalness: 0.15, flatShading: true });
  const bowl = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 0.5, 0.7, 8), metal);
  bowl.position.y = 2.0;
  g.add(bowl);
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 2.0, 5), metal);
    leg.position.set(Math.cos(a) * 0.5, 1.0, Math.sin(a) * 0.5);
    leg.rotation.z = Math.cos(a) * 0.14;
    leg.rotation.x = -Math.sin(a) * 0.14;
    g.add(leg);
  }
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
  const templeGY = footprintY(island, 0, 0, 4.0, topY);
  if (models.temple) {
    const temple = prepModel(models.temple, 22, "xz");
    temple.position.y = templeGY - 0.3;
    group.add(temple);
  } else {
    group.add(buildProceduralTemple(shared, templeGY));
  }

  // Warm glow inside the temple, brightened so the Labors reads from spawn (V1).
  const glow = glowMarker(0xffbf7a, 0.65, 2.8);
  glow.position.set(0, templeGY + 2.5, 0);
  group.add(glow);
  addPointGlow(group, 0, templeGY + 3, 0, 0xffb877, 12, 50);

  // The colonnade: one marble stele per project (Speakl first), arcing around
  // the plateau, largest first, tapering with index. Cheap: two InstancedMeshes
  // (plinths + slabs) sharing the marble family, plus one shared Points for the
  // amber sigils, so ten markers add three draw calls and zero new lights (B2).
  const n = Math.max(1, COPY.projectCount);
  const R = island.radius;
  const r0 = R * 0.62;

  // Center the arc so the colonnade opens toward the sea approach.
  const midA = Math.atan2(-island.center.z, -island.center.x);
  const span = 2.5; // radians to each side (a broad arc around the plateau)

  const marble = new THREE.MeshStandardMaterial({ color: COL.marble, roughness: 0.92, metalness: 0, flatShading: true });
  const marbleDim = new THREE.MeshStandardMaterial({ color: 0xb9b2a4, roughness: 0.95, metalness: 0, flatShading: true });
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
    const t = n > 1 ? i / (n - 1) : 0.5;
    const a = midA - span + t * (span * 2);
    const lx = Math.cos(a) * r0;
    const lz = Math.sin(a) * r0;
    const s = 1.0 - i * 0.04; // largest first, tapering with index
    const jitter = (Math.random() - 0.5) * 0.18;
    // Outward radial in local space so a flat stele face turns toward the sea.
    const outAng = Math.atan2(lx, lz);
    const nx = lx / r0;
    const nz = lz / r0;

    // Each stele is seated on the TRUE surface sampled straight down, then sunk
    // slightly, so none float above or sink below the jittered plateau (TASK A).
    const ground = groundY(island, lx, lz, topY) - 0.12;

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
}

function buildProceduralTemple(shared, topY) {
  const g = new THREE.Group();
  const marble = new THREE.MeshStandardMaterial({ color: COL.marble, roughness: 0.9, metalness: 0, flatShading: true });
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
  // A pier reaching out over the water toward the play area center.
  const dirToCenter = new THREE.Vector2(-island.center.x, -island.center.z).normalize();
  const pierAngle = Math.atan2(dirToCenter.x, dirToCenter.y);

  // Plank grounding: the inner planks meet the shore surface, the outer planks
  // ride just above the water where there is nothing to hit (TASK A).
  if (models.dock) {
    for (let i = 0; i < 4; i++) {
      const plank = prepModel(models.dock, 5.5, "xz");
      const d = island.radius * 0.7 + i * 5.0;
      const px = dirToCenter.x * d;
      const pz = dirToCenter.y * d;
      const surf = surfaceYAt(island.center.x + px, island.center.z + pz, island.groundTargets);
      const py = surf != null && surf > 0.5 ? surf + 0.05 : 0.35;
      plank.position.set(px, py, pz);
      plank.rotation.y = pierAngle;
      group.add(plank);
    }
  } else {
    const pier = new THREE.Mesh(
      new THREE.BoxGeometry(3, 0.5, 22),
      new THREE.MeshStandardMaterial({ color: 0x4a3a26, roughness: 0.9, flatShading: true })
    );
    pier.position.set(dirToCenter.x * island.radius, 0.4, dirToCenter.y * island.radius);
    pier.rotation.y = pierAngle;
    group.add(pier);
  }

  // The anchorage: FIVE moored vessels, one for each of the first five experience
  // entries. The sixth entry (Cashonomics) has no vessel and no beat, so the
  // docked tour reports five beats and the sixth card is never requested. Basics
  // is the flagship (ship.glb, larger); Speakl a sailboat; the rest rowboat and
  // sailboat variants. All reuse loaded GLBs, no new models. Each bobs on the
  // live wave field and flies a banner with the employer icon (B2). Vessels sit
  // in per-vessel holder groups so prepModel's recenter is preserved.
  const n = Math.min(5, Math.max(1, COPY.experienceCount));
  const icons = COPY.experienceIcons || [];
  const poleMat = new THREE.MeshStandardMaterial({ color: 0x3e2a18, roughness: 0.9, flatShading: true });
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
        vessel = prepModel(models[spec.key], spec.target, "max");
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
    holder.add(vessel);
    holder.position.set(lx, 0, lz);
    // Broadside to the sea so the deck reads in profile; a small jitter keeps the
    // fan from looking mechanical.
    holder.rotation.y = az + Math.PI / 2 + (Math.random() - 0.5) * 0.22;
    group.add(holder);

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
  const crateMat = new THREE.MeshStandardMaterial({ color: 0x5a4126, roughness: 0.95, flatShading: true });
  for (let i = 0; i < 4; i++) {
    const c = new THREE.Mesh(new THREE.BoxGeometry(1.3, 1.3, 1.3), crateMat);
    const spot = groundSpot(island, (Math.random() - 0.5) * 6, (Math.random() - 0.5) * 6, 2.0);
    c.position.set(spot.lx, spot.y + 0.65 - 0.04, spot.lz);
    c.rotation.y = Math.random();
    group.add(c);
  }

  // Lantern at the pier head, brightened so the Voyages reads from spawn (V1).
  const endD = island.radius * 0.7 + 3 * 5.0;
  const lamp = glowMarker(0xffbf7a, 0.38, 3.0);
  lamp.position.set(dirToCenter.x * endD, 2.4, dirToCenter.y * endD);
  group.add(lamp);
  addPointGlow(group, dirToCenter.x * endD, 2.6, dirToCenter.y * endD, 0xffb877, 9, 34);

  island.beats = beats;
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
  const wood = new THREE.MeshStandardMaterial({ color: 0x6b4a2c, roughness: 0.9, flatShading: true });
  const hull = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.9, target * 0.9, 6, 1), wood);
  hull.rotation.x = Math.PI / 2;
  hull.scale.set(1, 2.4, 1);
  hull.position.y = target * 0.2;
  g.add(hull);
  return g;
}

// ---- The Oracle: ruined temple on a peak, brazier, amber pillar ------------
function buildOracle(group, topY, models, shared, island) {
  // Raise a small peak so the oracle sits high.
  const peakGeo = new THREE.ConeGeometry(island.radius * 0.7, 8, 7);
  jitterGeometry(peakGeo, 0.12);
  peakGeo.computeVertexNormals();
  const peak = new THREE.Mesh(peakGeo, shared.matRock);
  peak.position.y = topY + 3.5;
  group.add(peak);
  // The peak now becomes part of the grounding surface so summit props seat on
  // it rather than on the lower dome (TASK A).
  group.updateWorldMatrix(true, true);
  island.groundTargets.push(peak);
  const peakTop = groundY(island, 0, 0, topY + 7);

  if (models["ruins-columns"]) {
    const ruin = prepModel(models["ruins-columns"], 9, "max");
    ruin.position.y = peakTop - 0.2;
    group.add(ruin);
  } else if (models.column) {
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2;
      const col = prepModel(models.column, 5, "height");
      const cx = Math.cos(a) * 2.2;
      const cz = Math.sin(a) * 2.2;
      col.position.set(cx, groundY(island, cx, cz, peakTop) - 0.2, cz);
      col.rotation.z = (Math.random() - 0.5) * 0.2;
      group.add(col);
    }
  }

  // Glowing brazier altar at the summit and a strong amber light pillar.
  // Brightened so the Oracle reads from spawn (V1); grounded on the peak.
  const brazier = buildBrazier(shared);
  const altarGY = groundY(island, 0, 0, peakTop);
  brazier.position.set(0, altarGY - 0.05, 0);
  brazier.scale.setScalar(1.1);
  group.add(brazier);
  addPointGlow(group, 0, altarGY + 2.4, 0, 0xff9a3c, 14, 44);

  // A brighter, taller amber light pillar unique to the Oracle.
  const pillar = buildBeacon(peakTop + 20);
  pillar.material.uniforms.uColor.value.set(0xffab52);
  pillar.position.y = peakTop;
  pillar.scale.set(0.7, 1, 0.7);
  group.add(pillar);

  island.lookHeight = peakTop + 4;
  island.embers = buildEmbers(group, new THREE.Vector3(0, altarGY + 2.5, 0));
  V.embers.push(island.embers);

  // Beat tour poses (B2): the ruined arch and columns, then the brazier altar
  // close-up (where the UI renders the working contact form).
  const ruins = anchorAt(island, 0, peakTop + 3, 0);
  const altar = anchorAt(island, 0, altarGY + 2.1, 0);
  const o1 = makeBeatOutward(island, ruins, 16, topY + 4, 1, 2.5);
  const o2 = makeBeat(altar, Math.atan2(island.center.x, island.center.z), 9, altarGY + 4, 0.3);
  const coal = brazier.userData.coal;
  if (coal) o2.emissives = [glowEmissive(coal, 1.8)];
  island.beats = [o1, o2];
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
      // Dock only when a prompt is visible and we are actually sailing.
      if (V.mode === "sailing" && V.nearIsland) {
        beginDock(V.nearIsland);
      }
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
// COURSE LINE: dotted amber guide toward the current target island (A4)
// ===========================================================================
function buildCourseLine() {
  const count = 40;
  const geo = new THREE.PlaneGeometry(0.5, 1.6);
  geo.rotateX(-Math.PI / 2); // lie flat, long axis along +Z (heading convention)
  const mat = new THREE.MeshBasicMaterial({
    color: COL.amber,
    transparent: true,
    opacity: 0.35,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    fog: true,
  });
  mat.toneMapped = false;
  const inst = new THREE.InstancedMesh(geo, mat, count);
  inst.frustumCulled = false;
  inst.visible = false;
  for (let i = 0; i < count; i++) inst.setColorAt(i, _colr.setScalar(1));
  if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
  V.scene.add(inst);
  V.courseLine = { inst, count };
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
  const target = currentTargetIsland();
  const show = V.mode === "sailing" && !!target;
  CL.inst.visible = show;
  V.courseTarget = show ? target : null;
  if (!show) return;
  V.courseFrame++;
  if (V.courseFrame % 3 !== 0) return;

  _fwd.set(Math.sin(V.heading), 0, Math.cos(V.heading));
  const sx = V.pos.x + _fwd.x * 6;
  const sz = V.pos.z + _fwd.z * 6;
  const dx = target.center.x - sx;
  const dz = target.center.z - sz;
  const full = Math.hypot(dx, dz) || 1;
  const ux = dx / full;
  const uz = dz / full;
  const stop = Math.max(0.001, full - (target.radius + 6));
  const dirAng = Math.atan2(ux, uz);
  _q1.setFromEuler(_e2.set(0, dirAng, 0));
  _sv.set(1, 1, 1);
  const count = CL.count;
  for (let i = 0; i < count; i++) {
    const t = count > 1 ? i / (count - 1) : 0;
    const dd = t * stop;
    const px = sx + ux * dd;
    const pz = sz + uz * dd;
    _pv.set(px, waveHeight(px, pz, V.time) + 0.16, pz);
    _m1.compose(_pv, _q1, _sv);
    CL.inst.setMatrixAt(i, _m1);
    const fade = Math.min(smoothstep(0.0, 0.1, t), smoothstep(1.0, 0.86, t));
    CL.inst.setColorAt(i, _colr.setScalar(fade));
  }
  CL.inst.instanceMatrix.needsUpdate = true;
  if (CL.inst.instanceColor) CL.inst.instanceColor.needsUpdate = true;
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
    const bx = isl.center.x - V.pos.x;
    const bz = isl.center.z - V.pos.z;
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
// A composed day film-still: the sun and Origins toward the far +Z with a
// sparkling sun road, cumulus overhead, the ship a small speck on the bright
// sea, and the flanking islands framed left and right, with a slow drift (7).
function setAttractCamera() {
  const cam = V.camera;
  // A high wide aerial from the south, looking north over the ship toward the
  // sun and Origins, with the flanking islands framed left and right. The drift
  // is a slow, almost imperceptible orbit (60s period).
  const lookX = 0,
    lookY = 24,
    lookZ = 22;
  const drift = Math.sin(V.time * ((Math.PI * 2) / 60)) * 0.08;
  const ang = Math.PI + drift; // straight south, looking north over the ship
  const R = 168;
  // A lower, closer altitude than the night poster so the frame reads more vivid
  // near-sea and less distant haze, while the sun, horizon and cumulus still
  // settle into the upper third below the nav (point 7).
  const H = 56 + Math.sin(V.time * ((Math.PI * 2) / 74)) * 2.4;
  cam.position.set(lookX + Math.sin(ang) * R, H, lookZ + Math.cos(ang) * R);
  V.camLook.set(lookX, lookY, lookZ);
  if (Math.abs(cam.fov - 60) > 0.01) {
    cam.fov = 60; // wide enough to frame the flanking islands and the moon
    cam.updateProjectionMatrix();
  }
  cam.lookAt(V.camLook);
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
  outLook.set(V.pos.x + sinH * 2, shipY + CAM_LOOK_Y, V.pos.z + cosH * 2);
}

// Autopilot steering toward the current sailTo target (V3).
function autopilotInput() {
  const isl = V.autopilot.island;
  if (!isl) {
    V.autopilot.active = false;
    return { throttle: 0, turn: 0 };
  }
  const dx = isl.center.x - V.pos.x;
  const dz = isl.center.z - V.pos.z;
  const dist = Math.hypot(dx, dz);
  const approach = dist - isl.radius;
  const desired = Math.atan2(dx, dz);
  const dh = signedAngle(desired - V.heading);
  const turn = Math.max(-1, Math.min(1, dh * 2.4));
  let throttle;
  if (approach <= 22) {
    // Inside dock-prompt range: brake and, once settled, auto-dock the target so
    // a hands-off sailTo flows straight into the beat tour (no E/tap needed).
    throttle = 0;
    if (approach <= 18 || Math.abs(V.speed) < 1.4) {
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
    const distFactor = Math.min(1, approach / 40);
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
  let dt = V.lastT ? (nowT - V.lastT) / 1000 : 0;
  V.lastT = nowT;
  if (dt > 0.05) dt = 0.05; // clamp big gaps (tab switches)
  V.time += dt;
  update(dt);
  renderFrame();
}

function update(dt) {
  V.oceanMat.uniforms.uTime.value = V.time;

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

// Soft radial repulsion so the ship grounds gently on shores instead of sailing
// through the rock. Runs against every island and the colossal ruin (F1, N3).
function resolveCollisions(dt) {
  _fwd.set(Math.sin(V.heading), 0, Math.cos(V.heading));
  for (const isl of V.islands) {
    collideCircle(dt, isl.center.x, isl.center.z, isl.collideR);
  }
  if (V.ruin) collideCircle(dt, V.ruin.center.x, V.ruin.center.z, V.ruin.collideR);
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
    const fov = 60 + (55 - 60) * tt;
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
  _v2.set(V.pos.x + sinH * 2.0, V.ship.group.position.y + CAM_LOOK_Y, V.pos.z + cosH * 2.0);
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
function updateProximity() {
  if (V.mode === "docked" || V.mode === "docking" || V.mode === "undocking") {
    if (typeof V.opts.onPromptUpdate === "function") V.opts.onPromptUpdate({ visible: false, x: 0, y: 0, label: "" });
    return;
  }

  let nearest = null;
  let nearestD = Infinity;
  for (const isl of V.islands) {
    const dx = V.pos.x - isl.center.x;
    const dz = V.pos.z - isl.center.z;
    const d = Math.hypot(dx, dz) - isl.radius;
    if (d < nearestD) {
      nearestD = d;
      nearest = isl;
    }
    // Hysteresis for the in-range flag.
    if (!isl.inRange && d < 26) isl.inRange = true;
    else if (isl.inRange && d > 34) isl.inRange = false;
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
    const label = V.isTouch ? COPY.dockMobile : COPY.dockDesktop;
    if (typeof V.opts.onPromptUpdate === "function") {
      V.opts.onPromptUpdate({ visible: sp.visible, x: sp.x, y: sp.y, label });
    }
  } else {
    if (typeof V.opts.onPromptUpdate === "function") V.opts.onPromptUpdate({ visible: false, x: 0, y: 0, label: "" });
  }
}

function updateLabels() {
  if (typeof V.opts.onLabelsUpdate !== "function") return;
  const list = [];
  // Beacon labels are visible from ANY distance while sailing, never otherwise
  // (docked, docking, intro, attract). Distance only fades opacity, never
  // legibility (A2). Payload carries the chapter numeral and visited flag so the
  // UI can render CHAPTER I over the name and add the visited amber dot (A2, C2).
  const showAll = V.mode === "sailing";
  for (const isl of V.islands) {
    const nm = COPY.names[isl.id] || { name: isl.def.name, tag: isl.def.tag };
    if (showAll) {
      const dx = V.pos.x - isl.center.x;
      const dz = V.pos.z - isl.center.z;
      const d = Math.hypot(dx, dz);
      _proj.set(isl.center.x, isl.lookHeight + 8, isl.center.z);
      const sp = projectClamped(_proj, 56, 60, 44);
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
}

// ===========================================================================
// RENDER / RESIZE
// ===========================================================================
function renderFrame() {
  if (!V || !V.renderer) return;
  if (V.composer && V.quality === "high") {
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
  V.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, V.quality === "high" ? 2 : 1.5));
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
