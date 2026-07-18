// app.js
// Orchestrates the page. Renders the classic view through ui.js and, when the
// browser can handle it, lazily loads the Three.js voyage from voyage.js. The
// classic site works perfectly whether or not voyage.js is present, so every
// call into the voyage module is guarded. No em dashes anywhere.

import { SITE } from "./data.js";
import * as ui from "./ui.js";

/* ------------------------------------------------------------------ */
/* Capability detection                                                */
/* ------------------------------------------------------------------ */

function hasWebGL2() {
  try {
    const c = document.createElement("canvas");
    return !!(window.WebGL2RenderingContext && c.getContext("webgl2"));
  } catch (e) {
    return false;
  }
}

function isMobile() {
  return (
    window.matchMedia("(pointer: coarse)").matches ||
    Math.min(window.innerWidth, window.innerHeight) < 600
  );
}

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const webglOk = hasWebGL2();
const mobile = isMobile();

/* ------------------------------------------------------------------ */
/* Voyage lifecycle state                                              */
/* ------------------------------------------------------------------ */

let voyage = null; // the loaded module namespace
let voyageLoadPromise = null; // guards concurrent loads
let inited = false;
let ready = false;
let active = false;
// The auto entry state machine. "classic" is the scrolling page, "scroll" is the
// unrolling scroll map loader, and "voyage" is on the ship with the HUD.
let phase = "classic";
let chartTimer = null; // simulated chart draw when there is no voyage to load
let dockedIsland = null;
let prevVisited = null; // baseline for the chart-complete toast

// Audio starts muted by default; the visitor's choice persists across sessions.
function readMuted() {
  try {
    const v = localStorage.getItem("hm-muted");
    if (v === null) return true;
    return v === "1" || v === "true";
  } catch (e) {
    return true;
  }
}
function writeMuted(m) {
  try {
    localStorage.setItem("hm-muted", m ? "1" : "0");
  } catch (e) {}
}
let muted = readMuted();

function onceFlag(key) {
  // Returns true the first time only, then records the flag so it never repeats.
  try {
    if (localStorage.getItem(key) === "1") return false;
    localStorage.setItem(key, "1");
    return true;
  } catch (e) {
    return true;
  }
}

/* ------------------------------------------------------------------ */
/* Loading and initialising the voyage module                         */
/* ------------------------------------------------------------------ */

async function loadVoyageModule() {
  if (voyage) return voyage;
  if (voyageLoadPromise) return voyageLoadPromise;
  voyageLoadPromise = import("./voyage.js")
    .then((mod) => {
      // The module must expose isSupported and return true for us to use it.
      if (!mod || typeof mod.isSupported !== "function" || !mod.isSupported()) {
        return null;
      }
      voyage = mod;
      return mod;
    })
    .catch((err) => {
      console.warn("Voyage module unavailable, staying on the classic view.", err);
      return null;
    });
  return voyageLoadPromise;
}

async function ensureVoyageInited() {
  if (inited) return voyage;
  const mod = await loadVoyageModule();
  if (!mod) {
    handleVoyageFailure();
    return null;
  }
  if (inited) return voyage; // another caller finished while we awaited

  try {
    inited = true;
    await mod.initVoyage({
      canvas: document.getElementById("voyage-canvas"),
      quality: mobile ? "low" : "high",
      reducedMotion,
      onReady() {
        ready = true;
        ui.voyageReady();
        // Reflect and apply the persisted (default off) mute state.
        ui.setMuteState(muted);
        if (voyage && typeof voyage.setMuted === "function") voyage.setMuted(muted);
        if (phase === "scroll") {
          // The chart is drawn: complete the route and enable the Start button.
          // For a full-motion session, run the attract behind the covering scroll
          // so the dive has a living scene to plunge into once the scroll lifts.
          ui.completeEntryProgress();
          if (webglOk && !reducedMotion) startAttractBehindScroll();
        } else if (voyage && typeof voyage.setActive === "function") {
          // Background preload for a fallback session: idle until launch.
          voyage.setActive(false);
        }
      },
      onProgress(p01) {
        ui.setVoyageProgress(Math.round((p01 || 0) * 100));
        if (phase === "scroll") ui.setEntryProgress(p01 || 0);
      },
      onPromptUpdate(payload) {
        ui.updatePrompt(payload);
      },
      onLabelsUpdate(list) {
        ui.updateIslandLabels(list);
      },
      onCompassUpdate(payload) {
        ui.updateCompass(payload);
      },
      onVisitedChange(list) {
        const n = Array.isArray(list) ? list.length : 0;
        ui.updateProgress(list);
        // Fire the chart-complete toast only when this session crosses to five.
        if (prevVisited !== null && prevVisited < 5 && n >= 5) {
          ui.showToast(SITE.micro.chartComplete);
        }
        prevVisited = n;
      },
      onDockedTour(payload) {
        const islandId = payload && payload.islandId;
        dockedIsland = islandId;
        ui.beginBeatTour(islandId, payload && payload.beatCount);
        maybeMutedDockHint();
      },
      onBeatChange(payload) {
        if (!payload) return;
        ui.showBeat(payload.islandId, payload.index, payload.total, payload.side);
      },
      onBeatAnchor(payload) {
        ui.positionBeat(payload);
      },
      onDocked(islandId) {
        // Legacy dock path (pre beat-tour voyage builds): open the side panel.
        dockedIsland = islandId;
        maybeMutedDockHint();
        ui.openPanel(islandId);
      },
      onUndocked() {
        dockedIsland = null;
        ui.hideBeat();
      }
    });
  } catch (err) {
    console.warn("Voyage failed to initialise, staying on the classic view.", err);
    handleVoyageFailure();
    return null;
  }
  return voyage;
}

function handleVoyageFailure() {
  inited = false;
  ready = false;
  voyage = null;
  ui.markVoyageUnavailable();
  if (phase === "scroll") {
    // Turn the scroll into the classic fallback: finish the chart and switch the
    // button to View my work so the visitor can still proceed.
    ui.setEntryMode("classic");
    ui.completeEntryProgress();
  } else {
    phase = "classic";
  }
}

/* ------------------------------------------------------------------ */
/* Start, exit, and dock flows                                         */
/* ------------------------------------------------------------------ */

const html = document.documentElement;

// The award style entry point. Show the scroll map loader, preload the world (or
// simulate the chart when there is no voyage to load), and let onReady enable the
// Start button. Reused by the classic hero CTA so re-entry runs the same beats.
function autoEnter() {
  phase = "scroll";
  if (chartTimer) {
    window.clearInterval(chartTimer);
    chartTimer = null;
  }
  html.classList.add("auto-entry", "entry-live");
  document.body.classList.remove("in-voyage", "in-attract", "entry-lift");
  window.scrollTo(0, 0);
  const capable = webglOk && !reducedMotion;
  ui.showEntryScroll(capable ? "voyage" : "classic");

  if (webglOk) {
    if (ready) {
      // Already preloaded (re-entry): draw the chart now, but only enable the Start
      // button once the scroll has finished opening so it is never a moving target.
      ui.setEntryProgress(1);
      if (capable) startAttractBehindScroll();
      const enableDelay = reducedMotion ? 0 : 1650;
      window.setTimeout(() => {
        if (phase === "scroll") ui.completeEntryProgress();
      }, enableDelay);
    } else {
      // Defer the heavy Three.js and WebGL init until the scroll has finished
      // unrolling. Shader compilation and scene build block the main thread for a
      // couple of seconds, so running it during the open would freeze the roll.
      const delay = reducedMotion ? 120 : 1550;
      window.setTimeout(() => {
        if (phase === "scroll") ensureVoyageInited();
      }, delay);
    }
  } else {
    // No voyage to load: draw the chart on a short simulated progress.
    simulateChart();
  }
}

// Draw the route over about a second when there is nothing to actually load.
function simulateChart() {
  if (chartTimer) window.clearInterval(chartTimer);
  const start = performance.now();
  const dur = reducedMotion ? 200 : 1000;
  chartTimer = window.setInterval(() => {
    const p = Math.min(1, (performance.now() - start) / dur);
    ui.setEntryProgress(p);
    if (p >= 1) {
      window.clearInterval(chartTimer);
      chartTimer = null;
      ui.completeEntryProgress();
    }
  }, 40);
}

// Run the attract scene behind the still covering scroll so the dive begins from
// a live poster pose the moment the scroll lifts. Full-motion sessions only.
function startAttractBehindScroll() {
  if (!voyage || typeof voyage.startAttract !== "function") return;
  try {
    if (typeof voyage.setActive === "function") voyage.setActive(true);
    voyage.startAttract();
    document.body.classList.add("in-attract");
  } catch (e) {}
}

// The Start Voyage gate was clicked.
function onEntryStart() {
  if (phase !== "scroll") return;
  // Fallback sessions (reduced motion, no WebGL, load failure) read View my work
  // and go to the classic page.
  if (!(webglOk && !reducedMotion) || !ready || !voyage) {
    liftScrollToClassic();
    return;
  }
  diveFromScroll();
}

// Lift the scroll away and dive the camera into the living scene behind it.
function diveFromScroll() {
  phase = "voyage";
  active = true;
  ui.closeEntryScroll();
  document.body.classList.add("entry-lift");
  if (typeof voyage.setActive === "function") voyage.setActive(true);
  if (typeof voyage.setMuted === "function") voyage.setMuted(muted);
  ui.setMuteState(muted);
  voyage.startVoyage();
  // Land the HUD as the dive settles (the voyage intro runs about 2.5s). The
  // HUD's own fade finishes just after the camera arrives.
  window.setTimeout(() => {
    if (phase !== "voyage") return;
    ui.enterVoyageUI();
    html.classList.remove("auto-entry");
    document.body.classList.remove("in-attract", "entry-lift");
    afterEnter();
  }, 2200);
}

// Lift the scroll away and reveal the classic page (View my work path).
function liftScrollToClassic() {
  phase = "classic";
  ui.closeEntryScroll();
  document.body.classList.add("entry-lift");
  const t = reducedMotion ? 80 : 620;
  window.setTimeout(() => {
    fallbackToClassic(true);
    document.body.classList.remove("entry-lift");
  }, t);
}

// Reveal the classic page at once (no lift animation). Used for load-failure bail
// outs and the classic secondary link.
function fallbackToClassic(scrollTop) {
  phase = "classic";
  if (chartTimer) {
    window.clearInterval(chartTimer);
    chartTimer = null;
  }
  html.classList.remove("auto-entry");
  document.body.classList.remove("in-voyage", "in-attract", "entry-lift");
  if (scrollTop) window.scrollTo({ top: 0, behavior: "auto" });
}

function afterEnter() {
  // Welcome line after the dive settles, then the one-time wayfinding hint 2s on.
  const base = reducedMotion ? 900 : 3600;
  window.setTimeout(() => {
    if (active) ui.showToast(SITE.micro.welcome);
  }, base);
  maybeFirstHint(base + 2000);
}

function maybeFirstHint(delay) {
  if (!onceFlag("hm-hint-seen")) return;
  const coarse = window.matchMedia("(pointer: coarse)").matches;
  // The click or tap to route instruction lives in the persistent HUD hint, so
  // the first-run toast stays a single quiet nudge toward the amber line.
  const hint = coarse ? SITE.micro.firstHintTouch : SITE.micro.firstHint;
  window.setTimeout(() => {
    if (active) ui.showToast(hint);
  }, delay);
}

function maybeMutedDockHint() {
  // The first time a visitor docks while muted, nudge them once toward the sound.
  if (!muted) return;
  if (!onceFlag("hm-muted-hint")) return;
  ui.showToast(SITE.micro.mutedDockHint);
}

function exitVoyage() {
  active = false;
  phase = "classic";
  dockedIsland = null;
  if (chartTimer) {
    window.clearInterval(chartTimer);
    chartTimer = null;
  }
  html.classList.remove("auto-entry");
  document.body.classList.remove("in-attract", "entry-lift");
  if (voyage && typeof voyage.setActive === "function") voyage.setActive(false);
  ui.exitVoyageUI();
}

function viewClassic() {
  // Fallback path for the classic secondary link and no WebGL sessions: make sure
  // the classic page is showing, then rest at the story.
  fallbackToClassic(false);
  const target = document.getElementById("origins");
  if (target) {
    target.scrollIntoView({
      behavior: reducedMotion ? "auto" : "smooth",
      block: "start"
    });
  }
}

/* ------------------------------------------------------------------ */
/* Handlers passed to the UI                                           */
/* ------------------------------------------------------------------ */

const handlers = {
  onBeginVoyage() {
    autoEnter();
  },
  onEntryStart() {
    onEntryStart();
  },
  onViewClassic() {
    viewClassic();
  },
  onExitVoyage() {
    exitVoyage();
  },
  onPanelClosed() {
    // A chapter panel closed. If we are sailing and were docked, return to ship.
    if (active && voyage && dockedIsland && typeof voyage.exitDockedMode === "function") {
      voyage.exitDockedMode();
    }
    dockedIsland = null;
  },
  onMuteToggle(next) {
    muted = next;
    writeMuted(muted);
    if (voyage && typeof voyage.setMuted === "function") voyage.setMuted(muted);
  },
  onDockConfirm() {
    // Mobile prompt tap. Ask the voyage to dock at the island in range.
    if (active && voyage && typeof voyage.requestDock === "function") {
      voyage.requestDock();
    }
  },
  onSailTo(islandId) {
    // Tap-to-sail: primary mobile navigation. Autopilot toward the island.
    if (!active || !voyage || typeof voyage.sailTo !== "function") return;
    try {
      voyage.sailTo(islandId);
    } catch (e) {
      return;
    }
    // Keep the clicked island's label lit until we arrive, so the click "took".
    if (typeof ui.setSailingTarget === "function") ui.setSailingTarget(islandId);
    const ch = SITE.chapters.find((c) => c.id === islandId);
    const name = ch ? ch.name : islandId;
    ui.showToast(SITE.micro.sailingTo.replace("{name}", name));
  },
  onBeatNext() {
    if (voyage && typeof voyage.nextBeat === "function") voyage.nextBeat();
  },
  onBeatPrev() {
    if (voyage && typeof voyage.prevBeat === "function") voyage.prevBeat();
  },
  onBeatEnd() {
    if (voyage && typeof voyage.endTour === "function") voyage.endTour();
    else if (voyage && typeof voyage.exitDockedMode === "function") voyage.exitDockedMode();
  },
  onViewAsList(islandId) {
    // End the tour, then open the old side panel as the list view fallback.
    if (voyage && typeof voyage.endTour === "function") {
      try {
        voyage.endTour();
      } catch (e) {}
    }
    dockedIsland = null;
    ui.hideBeat();
    ui.openPanel(islandId);
  }
};

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

function boot() {
  ui.initUI(handlers, {
    voyageSupported: webglOk,
    reducedMotion,
    isMobile: mobile
  });

  // Pause and resume the render loop with tab visibility.
  document.addEventListener("visibilitychange", () => {
    if (voyage && active && typeof voyage.setActive === "function") {
      voyage.setActive(!document.hidden);
    }
  });

  // Every session opens on the scroll map loader. The inline gate already held the
  // page behind it, so there is no flash of the classic hero before this runs. The
  // scroll waits for the Start button; nothing auto advances.
  autoEnter();

  // Clean up the voyage on unload.
  window.addEventListener("pagehide", () => {
    if (voyage && typeof voyage.dispose === "function") {
      try {
        voyage.dispose();
      } catch (e) {}
    }
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
