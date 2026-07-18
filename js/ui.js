// ui.js
// Owns all classic page rendering and all in voyage panel rendering from SITE.
// Also wires hero CTAs, the HUD, the dock prompt, island labels, and the toast.
// No third party libraries. No em dashes anywhere.

import { SITE } from "./data.js";

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function attr(s) {
  // Escape a string for safe use inside a double quoted HTML attribute.
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])';

function prefersReducedMotion() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function isCoarsePointer() {
  return window.matchMedia("(pointer: coarse)").matches;
}

/* ------------------------------------------------------------------ */
/* Module state                                                        */
/* ------------------------------------------------------------------ */

let H = {
  onBeginVoyage() {},
  onViewClassic() {},
  onExitVoyage() {},
  onPanelClosed() {},
  onMuteToggle() {},
  onDockConfirm() {},
  onSailTo() {},
  onBeatNext() {},
  onBeatPrev() {},
  onBeatEnd() {},
  onViewAsList() {},
  onEntryStart() {}
};

let opts = { voyageSupported: false, reducedMotion: false, isMobile: false };

const dom = {};
const labelNodes = new Map();
let sailingTargetId = null; // island the visitor clicked to autopilot toward
let sailingTargetTimer = null; // safety release if arrival is never observed

let ctaState = "idle"; // idle | loading | ready
let voyagePct = 0;
let loadingLineTimer = null;
let loadingLineIndex = 0;
let toastTimer = null;
let starfieldCleanup = null;
let activeDialog = null; // { node, scrim, previouslyFocused, keyHandler, onClose }

/* ================================================================== */
/* Content renderers (shared by classic sections and voyage panels)   */
/* ================================================================== */

function socialsHTML(items, extra = "") {
  const links = items
    .map(
      (s) =>
        `<li><a class="social-link" href="${attr(s.url)}" target="_blank" rel="noopener noreferrer">${s.name}</a></li>`
    )
    .join("");
  return `<ul class="social-list">${links}${extra}</ul>`;
}

function originsInnerHTML() {
  const o = SITE.origins;
  const creds = o.credibility
    .map((c) => `<li class="cred-item">${c}</li>`)
    .join("");
  return `
    <div class="origins-grid">
      <div class="origins-copy">
        <p class="lede">${o.body}</p>
      </div>
      <figure class="origins-portrait">
        <img src="${attr(o.portrait)}" alt="${attr(o.portraitAlt)}" loading="lazy" decoding="async" />
        <figcaption class="origins-caption">Harshith Mulakala</figcaption>
      </figure>
    </div>
    <ul class="cred-strip" aria-label="Credentials">${creds}</ul>
  `;
}

function forgeInnerHTML() {
  const groups = SITE.skills.groups
    .map((g) => {
      const chips = g.items.map((it) => `<li class="chip">${it}</li>`).join("");
      return `
        <div class="skill-group">
          <h3 class="skill-group-label">${g.label}</h3>
          <ul class="chips">${chips}</ul>
        </div>`;
    })
    .join("");
  return `<div class="skill-groups">${groups}</div>`;
}

function voyagesInnerHTML() {
  const items = SITE.experience
    .map((e) => {
      const bullets = (e.bullets || [])
        .map((b) => `<li>${b}</li>`)
        .join("");
      const metaParts = [e.location, e.dates].filter(Boolean).join(" · ");
      const featured = e.featured ? " is-featured" : "";
      return `
        <li class="timeline-item${featured}">
          <span class="timeline-marker" aria-hidden="true"></span>
          <article class="exp-card${featured}">
            <header class="exp-head">
              <img class="exp-icon" src="${attr(e.image)}" alt="${attr(e.alt)}" loading="lazy" decoding="async" />
              <div class="exp-headings">
                <h3 class="exp-title">${e.title}</h3>
                <p class="exp-role">${e.role}</p>
              </div>
              ${metaParts ? `<p class="exp-meta">${metaParts}</p>` : ""}
            </header>
            <p class="exp-summary">${e.card}</p>
            ${bullets ? `<ul class="exp-bullets">${bullets}</ul>` : ""}
          </article>
        </li>`;
    })
    .join("");
  return `<ol class="timeline">${items}</ol>`;
}

// The real working contact form. Extracted so the classic Oracle section and the
// Oracle beat card render the exact same formsubmit fields.
function contactFormHTML() {
  const f = SITE.contact.form;
  const hidden = Object.entries(f.hidden)
    .map(([k, v]) => `<input type="hidden" name="${attr(k)}" value="${attr(v)}" />`)
    .join("");
  return `
    <form class="oracle-form" action="${attr(f.action)}" method="${attr(f.method)}" novalidate>
      ${hidden}
      <label class="field">
        <span class="field-label">Your email</span>
        <input class="field-input" type="email" name="email" required autocomplete="email" placeholder="${attr(f.emailPlaceholder)}" />
      </label>
      <label class="field">
        <span class="field-label">Message</span>
        <textarea class="field-textarea" name="message" required rows="5" placeholder="${attr(f.messagePlaceholder)}"></textarea>
      </label>
      <button type="submit" class="btn btn-primary form-submit">
        <span class="cta-label">${f.submit}</span>
      </button>
      <p class="form-status" role="status" aria-live="polite"></p>
    </form>`;
}

function oracleInnerHTML() {
  const c = SITE.contact;
  const socials = socialsHTML(c.socials, `<li><a class="social-link" href="${attr(SITE.hero.resume)}" target="_blank" rel="noopener noreferrer">Resume</a></li>`);
  return `
    <div class="oracle-grid">
      <div class="oracle-copy">
        <h3 class="oracle-heading">${c.heading}</h3>
        <p class="oracle-invite">${c.invite}</p>
        <div class="oracle-socials">
          <p class="eyebrow">Elsewhere</p>
          ${socials}
        </div>
      </div>
      ${contactFormHTML()}
    </div>
  `;
}

// Classic Labors grid: cards open an accessible detail modal.
function laborsGridHTML() {
  const cards = SITE.projects
    .map(
      (p) => `
      <article class="project-card" data-project="${attr(p.id)}" tabindex="0" role="button" aria-haspopup="dialog" aria-label="${attr(p.title)}, open details">
        <div class="project-media">
          <img src="${attr(p.image)}" alt="${attr(p.alt)}" loading="lazy" decoding="async" />
        </div>
        <div class="project-info">
          <h3 class="project-title">${p.title}</h3>
          <p class="project-card-text">${p.card}</p>
          <span class="project-more" aria-hidden="true">Read more</span>
        </div>
      </article>`
    )
    .join("");
  return `<div class="project-grid">${cards}</div>`;
}

// Panel Labors: compact rows with inline expand and a link.
function laborsPanelHTML() {
  const rows = SITE.projects
    .map((p, i) => {
      const link = p.link
        ? `<a class="pr-link" href="${attr(p.link)}" target="_blank" rel="noopener noreferrer">Visit</a>`
        : "";
      return `
        <li class="project-row">
          <div class="pr-head">
            <img class="pr-thumb" src="${attr(p.image)}" alt="${attr(p.alt)}" loading="lazy" decoding="async" />
            <div class="pr-body">
              <h3 class="pr-title">${p.title}</h3>
              <p class="pr-card">${p.card}</p>
              <div class="pr-actions">
                <button class="pr-toggle" type="button" aria-expanded="false" aria-controls="pr-exp-${i}">More</button>
                ${link}
              </div>
            </div>
          </div>
          <div class="pr-expanded" id="pr-exp-${i}" hidden>
            <p>${p.expanded}</p>
          </div>
        </li>`;
    })
    .join("");
  return `<ul class="project-rows">${rows}</ul>`;
}

/* ================================================================== */
/* Classic page assembly                                              */
/* ================================================================== */

function navHTML() {
  const links = SITE.chapters
    .map(
      (ch) =>
        `<li><a class="nav-link" href="#${ch.id}"><span class="nav-name">${ch.name}</span><span class="nav-tag">${ch.tag}</span></a></li>`
    )
    .join("");
  return `
    <nav class="nav" aria-label="Chapters">
      <a class="nav-brand" href="#hero" aria-label="Home">HM</a>
      <ul class="nav-links">${links}</ul>
      <a class="nav-resume" href="${attr(SITE.hero.resume)}" target="_blank" rel="noopener noreferrer">Resume</a>
    </nav>`;
}

function heroHTML() {
  const h = SITE.hero;
  const first = h.epithets[0];
  const s = SITE.contact.socials;
  const socialLinks = s
    .map(
      (x) =>
        `<a class="social-link" href="${attr(x.url)}" target="_blank" rel="noopener noreferrer">${x.name}</a>`
    )
    .join("");
  return `
    <section class="hero" id="hero">
      <div class="hero-stars" aria-hidden="true"></div>
      <div class="hero-glow" aria-hidden="true"></div>
      <div class="hero-inner">
        <h1 class="hero-name">${h.name}</h1>
        <p class="hero-identity">${h.identity}</p>
        <p class="hero-epithet" aria-hidden="true"><span class="typed">${first}</span><span class="caret"></span></p>
        <div class="hero-cta">
          <button class="btn btn-primary hero-primary" id="cta-primary" type="button">
            <span class="cta-fill" aria-hidden="true"></span>
            <span class="cta-label">${h.primaryCta}</span>
          </button>
        </div>
        <p class="hero-classic">
          <span class="hero-classic-prefix">${SITE.micro.classicHint}</span>
          <button class="hero-classic-link" id="cta-secondary" type="button">
            <span class="cta-label">${h.secondaryCta}</span>
          </button>
        </p>
        <div class="hero-meta">
          <div class="hero-socials">
            <span class="eyebrow">Find me</span>
            <span class="social-row">${socialLinks}<a class="social-link" href="${attr(h.resume)}" target="_blank" rel="noopener noreferrer">Resume</a></span>
          </div>
        </div>
      </div>
      <a class="scroll-cue" href="#origins" aria-label="Scroll to the story">
        <span class="scroll-cue-word">Scroll</span>
        <span class="scroll-cue-line" aria-hidden="true"></span>
      </a>
    </section>`;
}

function sectionHTML(id, name, tag, epigraph, bodyHTML) {
  return `
    <section class="section" id="${id}" aria-labelledby="${id}-title">
      <div class="section-head">
        <p class="eyebrow">${tag}</p>
        <h2 class="section-title" id="${id}-title">${name}</h2>
        <p class="epigraph">${epigraph}</p>
        <span class="rule" aria-hidden="true"></span>
      </div>
      <div class="section-body">${bodyHTML}</div>
    </section>`;
}

function footerHTML() {
  const s = SITE.contact.socials;
  const socialLinks = s
    .map(
      (x) =>
        `<a class="social-link" href="${attr(x.url)}" target="_blank" rel="noopener noreferrer">${x.name}</a>`
    )
    .join("");
  return `
    <div class="footer-inner">
      <div class="footer-brand">
        <p class="footer-name">Harshith Mulakala</p>
        <p class="footer-tag">Founder and full-stack engineer.</p>
      </div>
      <div class="footer-links">
        <p class="eyebrow">Elsewhere</p>
        <div class="footer-socials">${socialLinks}<a class="social-link" href="${attr(SITE.hero.resume)}" target="_blank" rel="noopener noreferrer">Resume</a></div>
      </div>
      <div class="footer-meta">
        <p class="footer-copy">Copyright Harshith Mulakala. All rights reserved.</p>
        <button class="footer-credits-link" type="button" id="open-credits">Colophon &amp; credits</button>
      </div>
    </div>`;
}

// Colophon and credits modal. Keeps CC BY attribution reachable from every page
// state via a quiet footer link, reusing the shared modal system and focus trap.
function openCreditsModal() {
  const attributions = (SITE.attributions || [])
    .map((a) => `<li class="credit-line">${a}</li>`)
    .join("");
  dom.panelRoot.innerHTML = `
    <div class="modal-scrim"></div>
    <div class="modal modal-credits" role="dialog" aria-modal="true" aria-labelledby="credits-title" tabindex="-1">
      <button class="modal-close" type="button" data-autofocus aria-label="Close">
        <span class="modal-close-x" aria-hidden="true"></span>
      </button>
      <div class="modal-content">
        <p class="eyebrow">Colophon</p>
        <h2 class="modal-title" id="credits-title">Colophon</h2>
        <p class="credits-type">Set in Cinzel and Manrope. An odyssey in five chapters.</p>
        <h3 class="credits-subhead">Credits</h3>
        <p class="credits-intro">Voyage 3D assets from open low-poly model libraries.</p>
        <ul class="credits-list">${attributions}</ul>
      </div>
    </div>`;

  const scrim = $(".modal-scrim", dom.panelRoot);
  const modal = $(".modal", dom.panelRoot);
  const closeBtn = $(".modal-close", dom.panelRoot);

  document.body.classList.add("modal-open");
  requestAnimationFrame(() => dom.panelRoot.classList.add("is-open"));

  closeBtn.addEventListener("click", closeProjectModal);
  openDialog(modal, scrim, closeProjectModal);
}

function renderClassic() {
  dom.header.innerHTML = navHTML();

  const sections =
    heroHTML() +
    sectionHTML(
      "origins",
      SITE.origins.name,
      SITE.origins.tag,
      SITE.origins.epigraph,
      originsInnerHTML()
    ) +
    sectionHTML(
      "forge",
      SITE.skills.name,
      SITE.skills.tag,
      SITE.skills.epigraph,
      forgeInnerHTML()
    ) +
    sectionHTML(
      "labors",
      SITE.labors.name,
      SITE.labors.tag,
      SITE.labors.epigraph,
      laborsGridHTML()
    ) +
    sectionHTML(
      "voyages",
      SITE.voyages.name,
      SITE.voyages.tag,
      SITE.voyages.epigraph,
      voyagesInnerHTML()
    ) +
    sectionHTML(
      "oracle",
      SITE.contact.name,
      SITE.contact.tag,
      SITE.contact.epigraph,
      oracleInnerHTML()
    );

  dom.main.innerHTML = sections;
  dom.footer.innerHTML = footerHTML();
}

/* ================================================================== */
/* Hero behaviour: typed epithets, starfield, CTA states              */
/* ================================================================== */

function startEpithets() {
  const typed = $(".typed", dom.main);
  if (!typed) return;
  const list = SITE.hero.epithets;
  if (opts.reducedMotion || prefersReducedMotion()) {
    typed.textContent = list[0];
    const caret = $(".caret", dom.main);
    if (caret) caret.style.display = "none";
    return;
  }

  let idx = 0;
  let char = list[0].length; // start fully typed on the first string
  let deleting = false;

  function tick() {
    const word = list[idx];
    if (!deleting) {
      char++;
      typed.textContent = word.slice(0, char);
      if (char >= word.length) {
        deleting = true;
        return schedule(1900);
      }
      return schedule(58 + Math.random() * 42);
    }
    char--;
    typed.textContent = word.slice(0, char);
    if (char <= 0) {
      deleting = false;
      idx = (idx + 1) % list.length;
      return schedule(320);
    }
    return schedule(30);
  }

  let t = null;
  function schedule(ms) {
    t = window.setTimeout(tick, ms);
  }
  schedule(2100); // let the first epithet rest before it starts cycling
}

function buildStarfield() {
  const host = $(".hero-stars", dom.main);
  if (!host) return;
  host.innerHTML = "";
  starfieldCleanup && starfieldCleanup();

  const reduce = opts.reducedMotion || prefersReducedMotion();
  const w = Math.max(window.innerWidth, 640);
  const hgt = Math.max(window.innerHeight, 640);

  // Three depth layers: far and dim, mid, near and bright.
  const layerDefs = [
    { count: Math.round((w * hgt) / 9000), size: 1, alpha: 0.55, dur: 5.5, depth: 6 },
    { count: Math.round((w * hgt) / 16000), size: 2, alpha: 0.75, dur: 7.5, depth: 14 },
    { count: Math.round((w * hgt) / 42000), size: 2.5, alpha: 0.95, dur: 10, depth: 26 }
  ];

  const layers = [];
  layerDefs.forEach((def, li) => {
    const shadows = [];
    for (let i = 0; i < def.count; i++) {
      const x = Math.floor(Math.random() * w);
      const y = Math.floor(Math.random() * hgt);
      // Warm tinted stars occasionally, mostly cream.
      const warm = Math.random() < 0.16;
      const color = warm ? "#fecb99" : "#ffe9bb";
      shadows.push(`${x}px ${y}px 0 ${color}`);
    }
    const layer = document.createElement("span");
    layer.className = "star-layer";
    layer.style.width = def.size + "px";
    layer.style.height = def.size + "px";
    layer.style.boxShadow = shadows.join(", ");
    layer.style.setProperty("--a", String(def.alpha));
    if (!reduce) {
      layer.style.animationDuration = def.dur + "s";
      layer.style.animationDelay = (li * -1.7).toFixed(2) + "s";
    } else {
      layer.style.animation = "none";
    }
    layer.dataset.depth = String(def.depth);
    host.appendChild(layer);
    layers.push(layer);
  });

  if (reduce || isCoarsePointer()) {
    starfieldCleanup = null;
    return;
  }

  // Subtle parallax on pointer move.
  let raf = 0;
  let tx = 0;
  let ty = 0;
  function onMove(e) {
    const nx = e.clientX / window.innerWidth - 0.5;
    const ny = e.clientY / window.innerHeight - 0.5;
    tx = nx;
    ty = ny;
    if (!raf) raf = requestAnimationFrame(apply);
  }
  function apply() {
    raf = 0;
    layers.forEach((l) => {
      const d = parseFloat(l.dataset.depth) || 8;
      l.style.transform = `translate3d(${(-tx * d).toFixed(2)}px, ${(-ty * d).toFixed(2)}px, 0)`;
    });
  }
  window.addEventListener("pointermove", onMove, { passive: true });
  starfieldCleanup = () => {
    window.removeEventListener("pointermove", onMove);
    if (raf) cancelAnimationFrame(raf);
  };
}

function setPrimaryCtaLabel(text) {
  const label = $("#cta-primary .cta-label", dom.main);
  if (label) label.textContent = text;
}

function startLoadingLines() {
  const lines = SITE.micro.loading;
  const label = $("#cta-primary .cta-label", dom.main);
  if (!label) return;
  loadingLineIndex = 0;
  label.textContent = lines[0];
  clearInterval(loadingLineTimer);
  loadingLineTimer = window.setInterval(() => {
    loadingLineIndex = (loadingLineIndex + 1) % lines.length;
    label.textContent = lines[loadingLineIndex];
  }, 1400);
}

function stopLoadingLines() {
  clearInterval(loadingLineTimer);
  loadingLineTimer = null;
}

function updateProgressFill() {
  // Drive the horizon glow brightness through a 0 to 1 custom property.
  const btn = $("#cta-primary", dom.main);
  if (!btn) return;
  const p = Math.max(0, Math.min(100, voyagePct)) / 100;
  btn.style.setProperty("--progress", p.toFixed(3));
}

function showCtaLoading() {
  if (ctaState === "loading") return;
  ctaState = "loading";
  const btn = $("#cta-primary", dom.main);
  if (!btn) return;
  btn.classList.add("is-loading");
  btn.setAttribute("aria-busy", "true");
  updateProgressFill();
  startLoadingLines();
}

function resetCta() {
  ctaState = opts.voyageSupported && !usesFallbackPrimary() ? "ready" : "idle";
  const btn = $("#cta-primary", dom.main);
  if (!btn) return;
  btn.classList.remove("is-loading");
  btn.removeAttribute("aria-busy");
  stopLoadingLines();
  setPrimaryCtaLabel(primaryLabel());
  btn.style.setProperty("--progress", "0");
}

/* ------------------------------------------------------------------ */
/* Hero CTA configuration based on capability                          */
/* ------------------------------------------------------------------ */

function usesFallbackPrimary() {
  // Primary becomes a scroll action when the voyage cannot or should not autoplay.
  return !opts.voyageSupported || opts.reducedMotion;
}

function primaryLabel() {
  return usesFallbackPrimary() ? SITE.hero.fallbackPrimaryCta : SITE.hero.primaryCta;
}

function configureHero() {
  const primary = $("#cta-primary", dom.main);
  const secondary = $("#cta-secondary", dom.main);
  if (!primary || !secondary) return;

  setPrimaryCtaLabel(primaryLabel());
  const secLabel = $(".cta-label", secondary);
  const prefix = $(".hero-classic-prefix", dom.main);
  const classicLine = $(".hero-classic", dom.main);

  // The "Prefer a simple page?" lead only makes sense when the secondary link
  // actually goes to the classic view. In reduced motion it launches the voyage.
  let secLaunchesVoyage = false;
  let hideClassicLine = false;

  if (!opts.voyageSupported) {
    // No WebGL2: single strong scroll CTA, secondary quietly scrolls too.
    if (secLabel) secLabel.textContent = SITE.hero.secondaryCta;
  } else if (opts.reducedMotion) {
    // Reduced motion: primary scrolls, secondary can still launch the voyage.
    if (secLabel) secLabel.textContent = SITE.hero.fallbackSecondaryCta;
    secLaunchesVoyage = true;
  } else {
    // Supported and full motion. This hero is only ever seen on the classic page
    // reached through "View as page", and its primary CTA sails straight back to
    // the world, so the quiet classic link underneath is redundant. Hide it.
    if (secLabel) secLabel.textContent = SITE.hero.secondaryCta;
    hideClassicLine = true;
  }

  if (prefix) prefix.hidden = secLaunchesVoyage;
  if (classicLine) classicLine.hidden = hideClassicLine;
}

/* ================================================================== */
/* Reveal on scroll and scrollspy                                     */
/* ================================================================== */

function setupReveals() {
  if (opts.reducedMotion || prefersReducedMotion()) return;
  const targets = $$(".section, .hero-inner", dom.main);
  const io = new IntersectionObserver(
    (entries) => {
      entries.forEach((e) => {
        if (e.isIntersecting) {
          e.target.classList.add("in-view");
          io.unobserve(e.target);
        }
      });
    },
    { threshold: 0.12, rootMargin: "0px 0px -8% 0px" }
  );
  targets.forEach((t) => io.observe(t));
}

function setupScrollspy() {
  const links = $$(".nav-link", dom.header);
  if (!links.length) return;
  const map = new Map(links.map((l) => [l.getAttribute("href").slice(1), l]));
  const io = new IntersectionObserver(
    (entries) => {
      entries.forEach((e) => {
        if (e.isIntersecting) {
          links.forEach((l) => l.classList.remove("is-active"));
          const link = map.get(e.target.id);
          if (link) link.classList.add("is-active");
        }
      });
    },
    { threshold: 0.4, rootMargin: "-30% 0px -55% 0px" }
  );
  ["origins", "forge", "labors", "voyages", "oracle"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) io.observe(el);
  });
}

function setupRelaunchButton() {
  const btn = dom.relaunch;
  if (!btn) return;
  if (!opts.voyageSupported) {
    btn.hidden = true;
    return;
  }
  btn.hidden = false;
  btn.addEventListener("click", () => H.onBeginVoyage());

  const hero = document.getElementById("hero");
  if (!hero || !("IntersectionObserver" in window)) {
    btn.classList.add("is-visible");
    return;
  }
  const io = new IntersectionObserver(
    (entries) => {
      entries.forEach((e) => {
        // Show the floating relaunch button once the hero has scrolled away.
        btn.classList.toggle("is-visible", !e.isIntersecting);
      });
    },
    { threshold: 0.15 }
  );
  io.observe(hero);
}

/* ================================================================== */
/* Forms                                                              */
/* ================================================================== */

function wireForm(form) {
  if (!form || form.dataset.wired) return;
  form.dataset.wired = "1";
  const submit = $(".form-submit", form);
  const status = $(".form-status", form);
  form.addEventListener("submit", () => {
    // Native validation runs because required fields exist; if invalid the
    // browser blocks submission and this never disables the button.
    if (!form.checkValidity()) {
      form.reportValidity();
      return;
    }
    if (submit) {
      submit.setAttribute("disabled", "true");
      submit.classList.add("is-sending");
      const lbl = $(".cta-label", submit);
      if (lbl) lbl.textContent = "Sending";
    }
    if (status) status.textContent = "Sending your message.";
    // The form posts to formsubmit.co and the browser navigates to _next.
  });
}

/* ================================================================== */
/* Dialog: focus trap shared by panel and project modal               */
/* ================================================================== */

function openDialog(node, scrim, onClose) {
  closeActiveDialog(true);
  const previouslyFocused = document.activeElement;
  document.body.classList.add("dialog-open");

  function keyHandler(e) {
    if (e.key === "Escape") {
      e.preventDefault();
      requestClose();
      return;
    }
    if (e.key === "Tab") {
      const focusables = $$(FOCUSABLE, node).filter(
        (el) => el.offsetParent !== null || el === document.activeElement
      );
      if (!focusables.length) {
        e.preventDefault();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  }

  function requestClose() {
    if (typeof onClose === "function") onClose();
  }

  node.addEventListener("keydown", keyHandler);
  if (scrim) scrim.addEventListener("click", requestClose);

  activeDialog = { node, scrim, previouslyFocused, keyHandler, requestClose };

  // Focus the first sensible control after paint.
  requestAnimationFrame(() => {
    const first =
      node.querySelector("[data-autofocus]") ||
      $$(FOCUSABLE, node)[0] ||
      node;
    first.focus({ preventScroll: true });
  });
}

function teardownDialog() {
  if (!activeDialog) return;
  const { node, scrim, previouslyFocused, keyHandler, requestClose } = activeDialog;
  node.removeEventListener("keydown", keyHandler);
  if (scrim) scrim.removeEventListener("click", requestClose);
  document.body.classList.remove("dialog-open");
  activeDialog = null;
  if (previouslyFocused && typeof previouslyFocused.focus === "function") {
    previouslyFocused.focus({ preventScroll: true });
  }
}

function closeActiveDialog() {
  teardownDialog();
}

/* ================================================================== */
/* Voyage chapter panels                                              */
/* ================================================================== */

function panelBodyFor(id) {
  switch (id) {
    case "origins":
      return originsInnerHTML();
    case "forge":
      return forgeInnerHTML();
    case "labors":
      return laborsPanelHTML();
    case "voyages":
      return voyagesInnerHTML();
    case "oracle":
      return oracleInnerHTML();
    default:
      return "";
  }
}

function chapterMeta(id) {
  if (id === "forge") return { name: SITE.skills.name, tag: SITE.skills.tag, epigraph: SITE.skills.epigraph };
  if (id === "oracle") return { name: SITE.contact.name, tag: SITE.contact.tag, epigraph: SITE.contact.epigraph };
  const src = SITE[id];
  return { name: src.name, tag: src.tag, epigraph: src.epigraph };
}

export function openPanel(islandId) {
  const meta = chapterMeta(islandId);
  if (!meta) return;

  dom.panelRoot.innerHTML = `
    <div class="panel-scrim"></div>
    <aside class="panel" role="dialog" aria-modal="true" aria-labelledby="panel-title" tabindex="-1">
      <header class="panel-head">
        <div class="panel-heading-group">
          <p class="eyebrow panel-eyebrow">${meta.tag}</p>
          <h2 class="panel-title" id="panel-title">${meta.name}</h2>
          <p class="epigraph panel-epigraph">${meta.epigraph}</p>
        </div>
        <button class="panel-close" type="button" data-autofocus>
          <span class="panel-close-label">${SITE.micro.panelClose}</span>
          <span class="panel-close-x" aria-hidden="true"></span>
        </button>
      </header>
      <div class="panel-body">${panelBodyFor(islandId)}</div>
    </aside>`;

  const scrim = $(".panel-scrim", dom.panelRoot);
  const panel = $(".panel", dom.panelRoot);
  const closeBtn = $(".panel-close", dom.panelRoot);

  document.body.classList.add("panel-open");
  // Trigger the slide and fade in transition.
  requestAnimationFrame(() => {
    dom.panelRoot.classList.add("is-open");
  });

  closeBtn.addEventListener("click", () => closePanel());
  openDialog(panel, scrim, () => closePanel());

  wirePanelInteractions(islandId, panel);
}

function wirePanelInteractions(islandId, panel) {
  if (islandId === "labors") {
    $$(".pr-toggle", panel).forEach((btn) => {
      btn.addEventListener("click", () => {
        const target = document.getElementById(btn.getAttribute("aria-controls"));
        const expanded = btn.getAttribute("aria-expanded") === "true";
        btn.setAttribute("aria-expanded", String(!expanded));
        btn.textContent = expanded ? "More" : "Less";
        if (target) target.hidden = expanded;
      });
    });
  }
  if (islandId === "oracle") {
    const form = $(".oracle-form", panel);
    wireForm(form);
  }
}

export function closePanel() {
  if (!document.body.classList.contains("panel-open")) return;
  dom.panelRoot.classList.remove("is-open");
  document.body.classList.remove("panel-open");
  teardownDialog();
  const root = dom.panelRoot;
  window.setTimeout(() => {
    // Only clear if another panel has not opened in the meantime.
    if (!document.body.classList.contains("panel-open")) root.innerHTML = "";
  }, 380);
  H.onPanelClosed();
}

/* ================================================================== */
/* Project detail modal (classic view)                                */
/* ================================================================== */

function openProjectModal(id) {
  const p = SITE.projects.find((x) => x.id === id);
  if (!p) return;
  const link = p.link
    ? `<a class="modal-link btn btn-primary" href="${attr(p.link)}" target="_blank" rel="noopener noreferrer"><span class="cta-label">Visit project</span></a>`
    : "";

  dom.panelRoot.innerHTML = `
    <div class="modal-scrim"></div>
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title" tabindex="-1">
      <button class="modal-close" type="button" data-autofocus aria-label="Close">
        <span class="modal-close-x" aria-hidden="true"></span>
      </button>
      <div class="modal-media">
        <img src="${attr(p.image)}" alt="${attr(p.alt)}" decoding="async" />
      </div>
      <div class="modal-content">
        <h2 class="modal-title" id="modal-title">${p.title}</h2>
        <p class="modal-card">${p.card}</p>
        <p class="modal-expanded">${p.expanded}</p>
        ${link}
      </div>
    </div>`;

  const scrim = $(".modal-scrim", dom.panelRoot);
  const modal = $(".modal", dom.panelRoot);
  const closeBtn = $(".modal-close", dom.panelRoot);

  document.body.classList.add("modal-open");
  requestAnimationFrame(() => dom.panelRoot.classList.add("is-open"));

  closeBtn.addEventListener("click", closeProjectModal);
  openDialog(modal, scrim, closeProjectModal);
}

function closeProjectModal() {
  dom.panelRoot.classList.remove("is-open");
  document.body.classList.remove("modal-open");
  teardownDialog();
  const root = dom.panelRoot;
  window.setTimeout(() => {
    if (!document.body.classList.contains("modal-open") && !document.body.classList.contains("panel-open")) {
      root.innerHTML = "";
    }
  }, 340);
}

function wireProjectCards() {
  $$(".project-card", dom.main).forEach((card) => {
    const id = card.getAttribute("data-project");
    const open = () => openProjectModal(id);
    card.addEventListener("click", open);
    card.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        open();
      }
    });
  });
}

/* ================================================================== */
/* Voyage HUD, prompt, labels, toast                                  */
/* ================================================================== */

export function enterVoyageUI() {
  resetCta();
  document.body.classList.add("in-voyage");
  document.body.classList.remove("panel-open", "modal-open");

  // Controls hint text for the current input method.
  if (dom.controlsHint) {
    dom.controlsHint.textContent = opts.isMobile || isCoarsePointer()
      ? SITE.micro.controlsHintMobile
      : SITE.micro.controlsHintDesktop;
  }

  // Accessibility: hide the page from the reader, expose the HUD.
  dom.page.setAttribute("aria-hidden", "true");
  dom.page.setAttribute("inert", "");
  measureCompass();
  ["hud", "canvas", "labels", "joystick", "dockPrompt", "toast", "compass", "progress", "beatRoot"].forEach((k) => {
    if (dom[k]) dom[k].setAttribute("aria-hidden", "false");
  });

  const exit = document.getElementById("btn-exit-voyage");
  if (exit) requestAnimationFrame(() => exit.focus({ preventScroll: true }));
}

export function exitVoyageUI() {
  clearSailingTarget();
  document.body.classList.remove("in-voyage", "in-attract", "voyage-launching", "docked-tour", "in-beat");
  closePanel();
  hidePrompt();
  hideBeat();

  dom.page.removeAttribute("aria-hidden");
  dom.page.removeAttribute("inert");
  ["hud", "canvas", "labels", "joystick", "dockPrompt", "toast", "compass", "progress", "beatRoot"].forEach((k) => {
    if (dom[k]) dom[k].setAttribute("aria-hidden", "true");
  });

  window.scrollTo({ top: 0, behavior: "auto" });
  const brand = $(".nav-brand", dom.header);
  if (brand) requestAnimationFrame(() => brand.focus({ preventScroll: true }));
}

function defaultDockLabel() {
  return opts.isMobile || isCoarsePointer()
    ? SITE.micro.dockMobile
    : SITE.micro.dockDesktop;
}

export function updatePrompt(payload) {
  const el = dom.dockPrompt;
  if (!el) return;
  if (!payload || !payload.visible) {
    hidePrompt();
    return;
  }
  // A dock prompt means we reached an island in range: the sail has arrived.
  clearSailingTarget();
  const key = $(".dock-key", el);
  const txt = $(".dock-text", el);
  const label = payload.label || defaultDockLabel();
  const m = /^Press\s+(\S+)\s+to\s+(.*)$/i.exec(label);
  if (m) {
    if (key) {
      key.textContent = m[1];
      key.hidden = false;
    }
    if (txt) txt.textContent = "to " + m[2];
  } else {
    if (key) key.hidden = true;
    if (txt) txt.textContent = label;
  }
  // Clamp the island-anchored point so the pill is never clipped off an edge or
  // shoved under the top button row. On touch a CSS rule pins the prompt to a
  // thumb-reachable bottom slot instead (transform is overridden there), so this
  // keeps the desktop and fallback anchoring tidy.
  const w = el.offsetWidth || 160;
  const h = el.offsetHeight || 40;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const padX = 12;
  const topSafe = 64; // clear the top button row
  const padBottom = 16;
  let x = payload.x || 0;
  let y = payload.y || 0;
  x = Math.max(padX + w / 2, Math.min(vw - padX - w / 2, x));
  // The pill sits above the anchor: its box spans [y - 1.3h, y - 0.3h].
  const yMin = topSafe + 1.3 * h;
  const yMax = Math.max(yMin, vh - padBottom + 0.3 * h);
  y = Math.max(yMin, Math.min(yMax, y));
  el.style.transform = `translate(calc(${x}px - 50%), calc(${y}px - 130%))`;
  el.classList.add("is-visible");
}

function hidePrompt() {
  if (dom.dockPrompt) dom.dockPrompt.classList.remove("is-visible");
}

function numeralFor(id) {
  return (SITE.numerals && SITE.numerals[id]) || "";
}

// Distance or explicit opacity resolves to a subtle fade with a legible floor.
function labelOpacity(item) {
  if (typeof item.opacity === "number") {
    return Math.max(0.55, Math.min(1, item.opacity));
  }
  if (typeof item.dist === "number") {
    // Full strength near, easing down to the 0.55 floor by roughly 260 units.
    const t = Math.max(0, Math.min(1, (item.dist - 40) / 220));
    return 1 - t * 0.45;
  }
  return 1;
}

export function updateIslandLabels(list) {
  const host = dom.labels;
  if (!host) return;
  const seen = new Set();
  (list || []).forEach((item) => {
    seen.add(item.id);
    let node = labelNodes.get(item.id);
    if (!node) {
      node = document.createElement("button");
      node.type = "button";
      node.className = "island-label";
      node.dataset.id = item.id;
      node.innerHTML =
        '<span class="il-pill">' +
          '<span class="il-num"><span class="il-num-text"></span><span class="il-dot" aria-hidden="true"></span></span>' +
          '<span class="il-name"></span>' +
          '<span class="il-tag"></span>' +
        '</span>';
      node.addEventListener("click", () => H.onSailTo(item.id));
      host.appendChild(node);
      labelNodes.set(item.id, node);
    }
    if (item.visible) {
      const numText = $(".il-num-text", node);
      const nameEl = $(".il-name", node);
      const tagEl = $(".il-tag", node);
      const numeral = item.numeral || numeralFor(item.id);
      const numStr = numeral ? "Chapter " + numeral : "";
      if (numText.textContent !== numStr) numText.textContent = numStr;
      if (nameEl.textContent !== item.name) nameEl.textContent = item.name || "";
      if (tagEl.textContent !== item.tag) tagEl.textContent = item.tag || "";
      node.classList.toggle("is-next", !!item.next);
      node.classList.toggle("is-visited", !!item.visited);
      // Keep the target label lit while autopilot carries us there, so the click
      // visibly registered until we arrive.
      node.classList.toggle("is-sailing", item.id === sailingTargetId && !item.visited);
      node.setAttribute("aria-label", "Sail to " + (item.name || numeral || item.id));
      // Position directly through transform so per-frame moves never jitter.
      node.style.transform = `translate(calc(${item.x || 0}px - 50%), calc(${item.y || 0}px - 50%))`;
      node.style.opacity = String(labelOpacity(item));
      node.classList.add("is-visible");
    } else {
      node.classList.remove("is-visible");
      node.style.opacity = "0";
    }
  });
  labelNodes.forEach((node, id) => {
    if (!seen.has(id)) {
      node.classList.remove("is-visible");
      node.style.opacity = "0";
    }
  });
}

// Light up the clicked island's label while autopilot carries the ship there.
export function setSailingTarget(id) {
  sailingTargetId = id || null;
  if (sailingTargetTimer) window.clearTimeout(sailingTargetTimer);
  if (sailingTargetId) {
    // Release the highlight even if arrival is never signalled (manual override).
    sailingTargetTimer = window.setTimeout(clearSailingTarget, 15000);
  }
}

function clearSailingTarget() {
  sailingTargetId = null;
  if (sailingTargetTimer) {
    window.clearTimeout(sailingTargetTimer);
    sailingTargetTimer = null;
  }
  labelNodes.forEach((node) => node.classList.remove("is-sailing"));
}

/* ------------------------------------------------------------------ */
/* Compass ribbon (A3)                                                 */
/* ------------------------------------------------------------------ */

const compassNodes = new Map();
let compassWidth = 0;
const COMPASS_FOV = 150; // degrees of bearing visible across the ribbon

function measureCompass() {
  if (!dom.compass) return;
  compassWidth = dom.compass.clientWidth || window.innerWidth;
  // Space the etched degree marks so 15 degrees equals one tick gap.
  const pxPerDeg = compassWidth / COMPASS_FOV;
  dom.compass.style.setProperty("--tick-px", (pxPerDeg * 15).toFixed(2) + "px");
}

function normDeg(d) {
  // Wrap to the range (-180, 180].
  let x = d % 360;
  if (x > 180) x -= 360;
  if (x <= -180) x += 360;
  return x;
}

// heading and bearing are radians (Three.js convention). Ticks sit at their true
// bearing relative to the ship heading; the scale scrolls under them.
export function updateCompass(payload) {
  const host = dom.compass;
  if (!host || !payload) return;
  const ticksHost = $(".compass-ticks", host);
  const scale = $(".compass-scale", host);
  if (!compassWidth) measureCompass();
  const pxPerDeg = compassWidth / COMPASS_FOV;
  const headingDeg = (payload.heading || 0) * 180 / Math.PI;

  // Scroll the etched degree scale under the ticks.
  if (scale) scale.style.backgroundPositionX = `${(-headingDeg * pxPerDeg).toFixed(1)}px`;

  const seen = new Set();
  const half = COMPASS_FOV / 2;
  const edgeLeft = [];
  const edgeRight = [];

  (payload.islands || []).forEach((isl) => {
    seen.add(isl.id);
    let node = compassNodes.get(isl.id);
    if (!node) {
      node = document.createElement("button");
      node.type = "button";
      node.className = "compass-tick";
      node.dataset.id = isl.id;
      node.dataset.island = isl.id;
      node.innerHTML =
        '<span class="ct-mark" aria-hidden="true"></span>' +
        '<span class="ct-label"><span class="ct-num"></span><span class="ct-name"></span></span>';
      node.addEventListener("click", () => H.onSailTo(node.dataset.island));
      ticksHost.appendChild(node);
      compassNodes.set(isl.id, node);
    }
    const bearingDeg = (isl.bearing || 0) * 180 / Math.PI;
    const delta = normDeg(bearingDeg - headingDeg);
    const numeral = isl.numeral || numeralFor(isl.id);
    const numEl = $(".ct-num", node);
    const nameEl = $(".ct-name", node);
    if (numEl.textContent !== numeral) numEl.textContent = numeral;
    if (nameEl.textContent !== (isl.name || "")) nameEl.textContent = isl.name || "";
    node.classList.toggle("is-next", !!isl.next);
    node.classList.toggle("is-visited", !!isl.visited);
    node.setAttribute("aria-label", "Sail to " + (isl.name || numeral || isl.id));

    if (Math.abs(delta) > half) {
      // Bearing is outside the visible arc: collect it for its edge so several
      // off-arc chapters on the same side can be laid out as a tight stack that
      // never overlaps, rather than piling on one pixel (defect 2).
      (delta > 0 ? edgeRight : edgeLeft).push({ node, delta });
      node.classList.add("is-edge");
      node.classList.add("is-visible");
    } else {
      // In-arc tick: sits at its true bearing, unchanged.
      node.classList.remove("is-edge");
      node.classList.remove("is-stacked");
      const x = compassWidth / 2 + delta * pxPerDeg;
      const f = 1 - Math.max(0, (Math.abs(delta) - half * 0.6) / (half * 0.55));
      const opacity = Math.max(0.42, Math.min(1, f));
      node.style.opacity = String(opacity);
      node.style.transform = `translateX(${x.toFixed(1)}px) translateX(-50%)`;
      node.classList.add("is-visible");
    }
  });

  // Lay out the edge-clamped chapters. A lone clamp keeps the classic single
  // faded marker; two or more on the same side become a tight numeral-only chip
  // stack (~6px gaps) so their full names can never overlap (defect 2).
  layoutCompassEdge(edgeRight, compassWidth * 0.85, 1);
  layoutCompassEdge(edgeLeft, compassWidth * 0.15, -1);

  compassNodes.forEach((node, id) => {
    if (!seen.has(id)) node.classList.remove("is-visible");
  });
}

// Position chapters whose bearing is behind the visible arc, clamped to one
// ribbon edge. dir = +1 for the right edge, -1 for the left. A single clamp keeps
// the original faint single marker with its name; multiple clamps become
// numeral-only chips in a tight stack (nearest-to-arc toward centre, the rest
// marching to the edge) with the full name available on hover/focus.
function layoutCompassEdge(list, baseX, dir) {
  if (!list.length) return;
  list.sort((a, b) => Math.abs(a.delta) - Math.abs(b.delta));
  if (list.length === 1) {
    const node = list[0].node;
    node.classList.remove("is-stacked");
    node.style.opacity = "0.35";
    node.style.transform = `translateX(${baseX.toFixed(1)}px) translateX(-50%)`;
    return;
  }
  const STEP = 22; // chip centre-to-centre, ~6px gap between numeral chips
  const mid = (list.length - 1) / 2;
  list.forEach((item, i) => {
    let x = baseX + dir * (i - mid) * STEP;
    x = Math.max(12, Math.min(compassWidth - 12, x));
    item.node.classList.add("is-stacked");
    item.node.style.opacity = "0.62";
    item.node.style.transform = `translateX(${x.toFixed(1)}px) translateX(-50%)`;
  });
}

/* ------------------------------------------------------------------ */
/* Progress HUD (A5)                                                   */
/* ------------------------------------------------------------------ */

const ROMAN = ["0", "I", "II", "III", "IV", "V"];

export function updateProgress(list) {
  const host = dom.progress;
  if (!host) return;
  const visited = Array.isArray(list) ? list.length : 0;
  const n = Math.max(0, Math.min(5, visited));
  const label = $(".progress-label", host);
  if (label) label.textContent = `CHARTED ${ROMAN[n]} / V`;
  $$(".progress-dot", host).forEach((dot, i) => {
    dot.classList.toggle("is-lit", i < n);
  });
}

/* ------------------------------------------------------------------ */
/* Beat cards (B1 / B2): the diegetic docked tour                      */
/* ------------------------------------------------------------------ */

let beatState = null; // { islandId, index, total }
let lastAnchor = null;
let currentBeatSide = null; // the side the beat card is currently shown on
let declaredBeatSide = null; // side from onBeatChange (trusted over anchor jitter)
let beatSwapTimer = null; // pending content swap during a side-switch crossfade

function chapterFor(id) {
  return (SITE.chapters || []).find((c) => c.id === id) || null;
}

// Split the About paragraph on sentence boundaries so beat 1 shows the first
// three sentences and beat 2 the rest, without duplicating or altering the copy.
function aboutSentences() {
  return SITE.origins.body.split(/(?<=\.)\s+/);
}

function beatTitle(islandId, beat) {
  if (beat.title) return beat.title;
  if (beat.kind === "project") return (SITE.projects[beat.index] || {}).title || "";
  if (beat.kind === "experience") return (SITE.experience[beat.index] || {}).title || "";
  const ch = chapterFor(islandId);
  return ch ? ch.name : "";
}

function beatContentHTML(islandId, beat) {
  switch (beat.kind) {
    case "about": {
      const s = aboutSentences();
      const text = beat.part === 1 ? s.slice(0, 3).join(" ") : s.slice(3).join(" ");
      return `<p class="beat-para">${text}</p>`;
    }
    case "credibility": {
      const items = SITE.origins.credibility
        .map((c) => `<li class="beat-cred">${c}</li>`)
        .join("");
      return `<ul class="beat-creds">${items}</ul>`;
    }
    case "skills": {
      const groups = (beat.groups || [])
        .map((gi) => {
          const g = SITE.skills.groups[gi];
          if (!g) return "";
          const chips = g.items.map((it) => `<li class="chip">${it}</li>`).join("");
          return `<div class="beat-skillgroup"><h4 class="skill-group-label">${g.label}</h4><ul class="chips">${chips}</ul></div>`;
        })
        .join("");
      return `<div class="beat-skills">${groups}</div>`;
    }
    case "project": {
      const p = SITE.projects[beat.index];
      if (!p) return "";
      const link = p.link
        ? `<a class="beat-visit" href="${attr(p.link)}" target="_blank" rel="noopener noreferrer">${SITE.micro.beatVisit}</a>`
        : "";
      return `
        <div class="beat-project">
          <img class="beat-thumb" src="${attr(p.image)}" alt="${attr(p.alt)}" loading="lazy" decoding="async" />
          <p class="beat-card-text">${p.card}</p>
          <div class="beat-expand" hidden><p>${p.expanded}</p></div>
          <div class="beat-project-actions">
            <button class="beat-more" type="button" aria-expanded="false">${SITE.micro.beatMore}</button>
            ${link}
          </div>
        </div>`;
    }
    case "experience": {
      const e = SITE.experience[beat.index];
      if (!e) return "";
      const meta = [e.location, e.dates].filter(Boolean).join(" · ");
      const bullets = (e.bullets || []).map((b) => `<li>${b}</li>`).join("");
      return `
        <div class="beat-exp">
          <p class="beat-exp-role">${e.role}</p>
          ${meta ? `<p class="beat-exp-meta">${meta}</p>` : ""}
          <p class="beat-card-text">${e.card}</p>
          ${bullets ? `<ul class="beat-bullets">${bullets}</ul>` : ""}
        </div>`;
    }
    case "invite": {
      const c = SITE.contact;
      const socials = socialsHTML(
        c.socials,
        `<li><a class="social-link" href="${attr(SITE.hero.resume)}" target="_blank" rel="noopener noreferrer">Resume</a></li>`
      );
      return `<p class="beat-para">${c.invite}</p><div class="beat-socials"><p class="eyebrow">Elsewhere</p>${socials}</div>`;
    }
    case "form":
      return contactFormHTML();
    default:
      return "";
  }
}

function beatCardHTML(islandId, index, total) {
  const beats = (SITE.beats && SITE.beats[islandId]) || [];
  const count = total || beats.length;
  const beat = beats[index] || {};
  const numeral = numeralFor(islandId);
  const ch = chapterFor(islandId);
  const tag = ch ? ch.tag : "";
  const eyebrow = `Chapter ${numeral}${tag ? " · " + tag : ""}`;
  const title = beatTitle(islandId, beat);
  const dots = Array.from(
    { length: count },
    (_, i) => `<span class="beat-dot${i === index ? " is-current" : ""}"></span>`
  ).join("");
  return `
    <div class="beat-card-inner">
      <header class="beat-head">
        <p class="beat-eyebrow">${eyebrow}</p>
        ${title ? `<h3 class="beat-title">${title}</h3>` : ""}
      </header>
      <div class="beat-content">${beatContentHTML(islandId, beat)}</div>
      <footer class="beat-foot">
        <div class="beat-dots" aria-hidden="true">${dots}</div>
        <div class="beat-nav">
          <button class="beat-chevron beat-prev" type="button" aria-label="${SITE.micro.beatPrev}"${index === 0 ? " disabled" : ""}>&lsaquo;</button>
          <span class="beat-count">${index + 1} / ${count}</span>
          <button class="beat-chevron beat-next" type="button" aria-label="${SITE.micro.beatNext}">&rsaquo;</button>
        </div>
        <div class="beat-links">
          <button class="beat-list" type="button">${SITE.micro.viewAsList}</button>
          <button class="beat-sail" type="button">${SITE.micro.panelClose}</button>
        </div>
      </footer>
    </div>`;
}

function wireBeatCard(card, islandId) {
  const more = $(".beat-more", card);
  if (more) {
    more.addEventListener("click", () => {
      const exp = $(".beat-expand", card);
      const open = more.getAttribute("aria-expanded") === "true";
      more.setAttribute("aria-expanded", String(!open));
      more.textContent = open ? SITE.micro.beatMore : SITE.micro.beatLess;
      if (exp) exp.hidden = open;
      drawBeatLine();
    });
  }
  const form = $(".oracle-form", card);
  if (form) wireForm(form);
  const prev = $(".beat-prev", card);
  const next = $(".beat-next", card);
  const list = $(".beat-list", card);
  const sail = $(".beat-sail", card);
  if (prev) prev.addEventListener("click", () => H.onBeatPrev());
  if (next) next.addEventListener("click", () => H.onBeatNext());
  if (list) list.addEventListener("click", () => H.onViewAsList(islandId));
  if (sail) sail.addEventListener("click", () => H.onBeatEnd());
}

function ensureBeatCard() {
  if (!dom.beatRoot) return null;
  let card = $(".beat-card", dom.beatRoot);
  if (!card) {
    card = document.createElement("div");
    card.className = "beat-card";
    dom.beatRoot.appendChild(card);
  }
  return card;
}

function beatIsSheet() {
  return isCoarsePointer() || window.innerWidth < 720;
}

export function beginBeatTour(islandId, beatCount) {
  clearSailingTarget();
  document.body.classList.add("docked-tour");
  beatState = {
    islandId,
    index: 0,
    total: beatCount || ((SITE.beats[islandId] || []).length)
  };
}

export function showBeat(islandId, index, total, side) {
  const card = ensureBeatCard();
  if (!card) return;
  const beats = (SITE.beats && SITE.beats[islandId]) || [];
  const count = total || (beatState && beatState.total) || beats.length;

  const reduce = opts.reducedMotion || prefersReducedMotion();
  const sheet = beatIsSheet();
  const declared = side === "left" ? "left" : side === "right" ? "right" : null;
  // Resolve the side to land on. Trust the declared side; otherwise fall back to
  // the last anchor's side (older voyage builds), otherwise keep the current one.
  const nextSide =
    declared ||
    (lastAnchor && lastAnchor.side === "left" ? "left" : lastAnchor && lastAnchor.side === "right" ? "right" : null) ||
    currentBeatSide ||
    "right";
  const hasCard = !!card.firstChild;
  const sideChanged = !sheet && !reduce && hasCard && currentBeatSide && nextSide !== currentBeatSide;

  beatState = { islandId, index, total: count, side: nextSide };

  if (beatSwapTimer) {
    window.clearTimeout(beatSwapTimer);
    beatSwapTimer = null;
  }

  const render = () => {
    card.classList.remove("beat-exit-left", "beat-exit-right", "beat-enter-left", "beat-enter-right", "is-enter");
    card.innerHTML = beatCardHTML(islandId, index, count);
    wireBeatCard(card, islandId);
    card.classList.toggle("is-sheet", beatIsSheet());
    currentBeatSide = nextSide;
    declaredBeatSide = declared;
    if (lastAnchor) positionBeat(lastAnchor);
    if (!reduce) {
      void card.offsetWidth;
      if (sideChanged) {
        card.classList.add(nextSide === "left" ? "beat-enter-left" : "beat-enter-right");
      } else {
        card.classList.add("is-enter");
      }
    }
    document.body.classList.add("in-beat", "docked-tour");
    if (dom.beatRoot) dom.beatRoot.classList.add("is-visible");
  };

  if (sideChanged) {
    // Phase 1: slide the current card out toward its own edge and drop the leader
    // line, then swap and slide the new card in from the opposite edge.
    hideBeatLine();
    card.classList.remove("is-enter", "beat-enter-left", "beat-enter-right");
    void card.offsetWidth;
    card.classList.add(currentBeatSide === "left" ? "beat-exit-left" : "beat-exit-right");
    beatSwapTimer = window.setTimeout(() => {
      beatSwapTimer = null;
      render();
    }, 160);
  } else {
    declaredBeatSide = declared;
    render();
  }
}

export function positionBeat(anchor) {
  lastAnchor = anchor || null;
  const card = $(".beat-card", dom.beatRoot);
  if (!card) return;
  if (beatIsSheet()) {
    card.classList.add("is-sheet");
    card.classList.remove("side-left", "side-right");
    card.style.left = "";
    card.style.top = "";
    hideBeatLine();
    return;
  }
  card.classList.remove("is-sheet");
  // Trust the declared side from onBeatChange over any transient anchor side, so a
  // side value flipping mid-dolly never drags the card across the screen.
  const side =
    declaredBeatSide ||
    currentBeatSide ||
    (anchor && anchor.side === "left" ? "left" : "right");
  card.classList.toggle("side-left", side === "left");
  card.classList.toggle("side-right", side === "right");
  const margin = 28;
  // Leave room at the bottom right so a tall card never overlaps the progress HUD.
  const marginBottom = 76;
  const cw = card.offsetWidth || 380;
  const chh = card.offsetHeight || 260;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const left = side === "left" ? margin : vw - cw - margin;
  let top = (anchor && typeof anchor.y === "number" ? anchor.y : vh / 2) - chh / 2;
  top = Math.max(margin, Math.min(vh - chh - marginBottom, top));
  card.style.left = `${left}px`;
  card.style.top = `${top}px`;
  drawBeatLine();
}

const SVGNS = "http://www.w3.org/2000/svg";

// Build the gradient (so the line fades out along its length) and the glowing
// anchor dot once, reusing them across redraws (P3).
function ensureBeatLineParts(svg) {
  if (svg.__parts) return svg.__parts;
  let defs = svg.querySelector("defs");
  if (!defs) {
    defs = document.createElementNS(SVGNS, "defs");
    svg.insertBefore(defs, svg.firstChild);
  }
  const grad = document.createElementNS(SVGNS, "linearGradient");
  grad.setAttribute("id", "bl-grad");
  grad.setAttribute("gradientUnits", "userSpaceOnUse");
  // Full at the card edge, gone by 40% of the way to the anchor.
  const stops = [
    ["0%", "0.6"],
    ["40%", "0"],
    ["100%", "0"]
  ];
  stops.forEach(([off, op]) => {
    const s = document.createElementNS(SVGNS, "stop");
    s.setAttribute("offset", off);
    s.setAttribute("stop-color", "#bc9b7e");
    s.setAttribute("stop-opacity", op);
    grad.appendChild(s);
  });
  defs.appendChild(grad);

  const glow = document.createElementNS(SVGNS, "circle");
  glow.setAttribute("class", "bl-dot-glow");
  glow.setAttribute("r", "5.5");
  const core = document.createElementNS(SVGNS, "circle");
  core.setAttribute("class", "bl-dot-core");
  core.setAttribute("r", "2.6");
  svg.appendChild(glow);
  svg.appendChild(core);

  svg.__parts = { grad, glow, core };
  return svg.__parts;
}

function drawBeatLine() {
  const svg = dom.beatLine;
  const card = $(".beat-card", dom.beatRoot);
  if (!svg || !card) return;
  const line = $(".bl-line", svg);
  if (!line) return;
  const ax = Number(lastAnchor && lastAnchor.x) || 0;
  const ay = Number(lastAnchor && lastAnchor.y) || 0;
  const onScreen =
    lastAnchor && lastAnchor.visible &&
    ax >= 0 && ax <= window.innerWidth &&
    ay >= 0 && ay <= window.innerHeight;
  if (!onScreen || beatIsSheet()) {
    hideBeatLine();
    return;
  }
  const { grad, glow, core } = ensureBeatLineParts(svg);
  const rect = card.getBoundingClientRect();
  const isLeft = card.classList.contains("side-left");
  // Start from the card edge that faces the anchor.
  const startX = isLeft ? rect.right : rect.left;
  const startY = rect.top + rect.height / 2;
  line.setAttribute("x1", startX.toFixed(1));
  line.setAttribute("y1", startY.toFixed(1));
  line.setAttribute("x2", ax.toFixed(1));
  line.setAttribute("y2", ay.toFixed(1));
  line.setAttribute("stroke", "url(#bl-grad)");
  // Point the fade gradient down the line so it dies out before the anchor.
  grad.setAttribute("x1", startX.toFixed(1));
  grad.setAttribute("y1", startY.toFixed(1));
  grad.setAttribute("x2", ax.toFixed(1));
  grad.setAttribute("y2", ay.toFixed(1));
  // Soft glowing amber dot sits on the anchor itself.
  glow.setAttribute("cx", ax.toFixed(1));
  glow.setAttribute("cy", ay.toFixed(1));
  core.setAttribute("cx", ax.toFixed(1));
  core.setAttribute("cy", ay.toFixed(1));
  svg.classList.add("is-visible");
}

function hideBeatLine() {
  if (dom.beatLine) dom.beatLine.classList.remove("is-visible");
}

export function hideBeat() {
  if (beatSwapTimer) {
    window.clearTimeout(beatSwapTimer);
    beatSwapTimer = null;
  }
  const card = $(".beat-card", dom.beatRoot);
  if (card) card.innerHTML = "";
  if (dom.beatRoot) dom.beatRoot.classList.remove("is-visible");
  hideBeatLine();
  document.body.classList.remove("in-beat", "docked-tour");
  beatState = null;
  lastAnchor = null;
  currentBeatSide = null;
  declaredBeatSide = null;
}

// The chapter nav scrolls horizontally on narrow screens. Fade whichever edge
// still hides chapters so the scroll is discoverable, and drop the fade at each
// extreme so the end links never look clipped.
function setupNavScroll() {
  const nav = document.querySelector(".nav-links");
  if (!nav) return;
  const update = () => {
    const maxScroll = nav.scrollWidth - nav.clientWidth;
    const l = nav.scrollLeft > 4 ? 22 : 0;
    const r = maxScroll > 4 && nav.scrollLeft < maxScroll - 4 ? 22 : 0;
    nav.style.setProperty("--nav-fade-l", l + "px");
    nav.style.setProperty("--nav-fade-r", r + "px");
  };
  nav.addEventListener("scroll", update, { passive: true });
  window.addEventListener("resize", update);
  update();
}

// Track the on-screen keyboard via the visual viewport so the beat bottom sheet
// can ride above it (see --kb-inset in the stylesheet). Keeps the Oracle form and
// its Send button reachable while typing on touch devices.
function initKeyboardInset() {
  const vv = window.visualViewport;
  if (!vv) return;
  const update = () => {
    const inset = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    document.documentElement.style.setProperty("--kb-inset", inset + "px");
    document.body.classList.toggle("kb-open", inset > 80);
  };
  vv.addEventListener("resize", update);
  vv.addEventListener("scroll", update);
  update();
}

export function showToast(text) {
  const el = dom.toast;
  if (!el) return;
  el.textContent = text;
  el.classList.add("is-visible");
  // On touch the toast and the controls hint share one slot below the compass;
  // flag the body so the hint fades out of the way while the toast is up.
  document.body.classList.add("toast-showing");
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    el.classList.remove("is-visible");
    document.body.classList.remove("toast-showing");
  }, 4200);
}

export function setMuteState(muted) {
  const btn = document.getElementById("btn-mute");
  if (!btn) return;
  // aria-pressed tracks the audio-on state, so muted (sound off) reads pressed=true
  // meaning the mute is engaged; the label states plainly whether sound is off or on.
  btn.setAttribute("aria-pressed", String(muted));
  btn.classList.toggle("is-muted", muted);
  btn.setAttribute("aria-label", muted ? "Turn ambient sound on" : "Turn ambient sound off");
  const lbl = $(".hud-btn-label", btn);
  if (lbl) lbl.textContent = muted ? SITE.micro.soundOff : SITE.micro.soundOn;
}

/* ================================================================== */
/* Auto entry scroll map loader                                       */
/* ================================================================== */

let entryRouteLen = 0;

// Smoothed route drawing state. The real load progress feeds a target, and a
// displayed value eases toward it every frame so the chart draws as one flowing
// stroke rather than jumping in the discrete steps the loader reports. A minimum
// draw time keeps instant local loads from snapping to full in a single frame.
const ENTRY_MIN_DRAW_MS = 1400;
let entryTargetP = 0;
let entryDisplayedP = 0;
let entryRaf = 0;
let entryDrawStart = 0;
let entryWantComplete = false;
let entryFinished = false;

function entryEaseOut(t) {
  return 1 - Math.pow(1 - Math.max(0, Math.min(1, t)), 3);
}

function applyEntryRoute(p) {
  const path = dom.entryRoute;
  if (path && entryRouteLen) {
    path.style.strokeDashoffset = (entryRouteLen * (1 - p)).toFixed(2);
  }
  positionEntryShip(p);
}

function ensureEntryLoop() {
  if (entryRaf || entryFinished) return;
  entryRaf = window.requestAnimationFrame(entryTick);
}

function entryTick(now) {
  entryRaf = 0;
  const reduce = opts.reducedMotion || prefersReducedMotion();
  if (!entryDrawStart) entryDrawStart = now;
  // Time envelope so the route always takes at least ENTRY_MIN_DRAW_MS to fill,
  // even when the world is already cached and progress leaps straight to 1.
  const ceiling = reduce ? 1 : entryEaseOut((now - entryDrawStart) / ENTRY_MIN_DRAW_MS);
  const aim = Math.min(entryWantComplete ? 1 : entryTargetP, ceiling);
  const lerp = reduce ? 1 : 0.14;
  entryDisplayedP += (aim - entryDisplayedP) * lerp;
  if (Math.abs(aim - entryDisplayedP) < 0.0015) entryDisplayedP = aim;
  applyEntryRoute(entryDisplayedP);

  if (entryWantComplete && entryDisplayedP >= 0.999 && ceiling >= 0.999) {
    entryDisplayedP = 1;
    applyEntryRoute(1);
    finishEntryDraw();
    return;
  }
  // Idle the loop once the drawn stroke has caught up to the real target and the
  // time envelope is no longer the limiter. It resumes on the next progress tick.
  const caughtUp =
    !entryWantComplete &&
    entryDisplayedP >= entryTargetP - 0.001 &&
    ceiling >= entryTargetP - 0.001;
  if (caughtUp) return;
  entryRaf = window.requestAnimationFrame(entryTick);
}

// The chart has finished drawing: settle the ship at the final island, give the
// route one subtle brightness pulse, then arm the Start button with a soft fade.
function finishEntryDraw() {
  if (entryFinished) return;
  entryFinished = true;
  entryDisplayedP = 1;
  applyEntryRoute(1);
  const reduce = opts.reducedMotion || prefersReducedMotion();
  const path = dom.entryRoute;
  const arm = () => {
    if (!dom.scrollStart) return;
    dom.scrollStart.disabled = false;
    dom.scrollStart.classList.add("is-armed");
  };
  if (reduce || !path) {
    arm();
    return;
  }
  path.classList.remove("is-pulse");
  void path.getBoundingClientRect();
  path.classList.add("is-pulse");
  // Enable the button as the pulse crests so readiness reads as a designed beat.
  window.setTimeout(arm, 300);
}

function renderScrollBullets() {
  if (!dom.scrollBullets) return;
  dom.scrollBullets.innerHTML = (SITE.scrollBullets || [])
    .map((b) => `<li class="scroll-bullet">${b}</li>`)
    .join("");
}

function positionEntryShip(p) {
  const ship = dom.entryShip;
  const path = dom.entryRoute;
  if (!ship || !path || !entryRouteLen || typeof path.getPointAtLength !== "function") return;
  const t = Math.max(0, Math.min(1, p));
  const pt = path.getPointAtLength(t * entryRouteLen);
  ship.setAttribute("transform", `translate(${pt.x.toFixed(1)},${pt.y.toFixed(1)})`);
}

// Reset the scroll for a fresh load: undrawn route, ship at the first island, the
// Start button labelled for this session and disabled until the chart completes.
export function showEntryScroll(mode) {
  setEntryMode(mode);
  const path = dom.entryRoute;
  if (path && typeof path.getTotalLength === "function") {
    entryRouteLen = path.getTotalLength();
    path.style.strokeDasharray = String(entryRouteLen);
    path.style.strokeDashoffset = String(entryRouteLen);
    path.classList.remove("is-pulse");
  }
  // Reset the smoothing loop for a fresh draw.
  if (entryRaf) {
    window.cancelAnimationFrame(entryRaf);
    entryRaf = 0;
  }
  entryTargetP = 0;
  entryDisplayedP = 0;
  entryDrawStart = 0;
  entryWantComplete = false;
  entryFinished = false;
  positionEntryShip(0);
  if (dom.scrollStart) {
    dom.scrollStart.disabled = true;
    dom.scrollStart.classList.remove("is-armed");
  }
  openEntryScroll();
}

// Roll the scroll open by sliding the dark shade off the parchment. Pure transform
// so it runs on the compositor: smooth and immune to any main-thread work.
function openEntryScroll() {
  const shade = dom.scrollShade;
  if (!shade) return;
  if (shade.__anim) {
    shade.__anim.cancel();
    shade.__anim = null;
  }
  if (opts.reducedMotion || prefersReducedMotion()) {
    shade.style.transform = "translateY(100%)";
    return;
  }
  shade.style.transform = "translateY(0%)";
  if (typeof shade.animate === "function") {
    shade.__anim = shade.animate(
      [{ transform: "translateY(0%)" }, { transform: "translateY(100%)" }],
      { duration: 1700, easing: "cubic-bezier(0.62, 0, 0.2, 1)", fill: "forwards" }
    );
  } else {
    shade.style.transform = "translateY(100%)";
  }
}

// Roll the scroll back up (shade slides back over the parchment) as they leave it.
export function closeEntryScroll() {
  const shade = dom.scrollShade;
  if (!shade) return;
  if (shade.__anim) {
    shade.__anim.cancel();
    shade.__anim = null;
  }
  if (opts.reducedMotion || prefersReducedMotion() || typeof shade.animate !== "function") {
    shade.style.transform = "translateY(0%)";
    return;
  }
  shade.__anim = shade.animate(
    [{ transform: "translateY(100%)" }, { transform: "translateY(0%)" }],
    { duration: 620, easing: "cubic-bezier(0.7, 0, 0.84, 0)", fill: "forwards" }
  );
}

// Feed the real load progress in. The displayed stroke eases toward it every
// frame (see entryTick), so the route draws as one continuous flowing line and
// the ship glyph glides along it instead of stepping in discrete jumps.
export function setEntryProgress(p01) {
  entryTargetP = Math.max(entryTargetP, Math.max(0, Math.min(1, p01 || 0)));
  ensureEntryLoop();
}

// The chart is done loading: let the stroke finish its eased draw, then arm the
// Start button on the designed completion beat (handled in finishEntryDraw).
export function completeEntryProgress() {
  entryTargetP = 1;
  entryWantComplete = true;
  if (entryFinished) {
    // Already settled (re-entry after a prior finish): arm straight away.
    if (dom.scrollStart) {
      dom.scrollStart.disabled = false;
      dom.scrollStart.classList.add("is-armed");
    }
    return;
  }
  ensureEntryLoop();
}

// Voyage mode reads Start Voyage; every fallback reads View my work.
export function setEntryMode(mode) {
  if (!dom.scrollStart) return;
  const label = $(".scroll-start-label", dom.scrollStart);
  if (label) {
    label.textContent = mode === "classic" ? SITE.micro.entryClassic : SITE.micro.entryStart;
  }
}

/* ================================================================== */
/* Voyage progress and readiness (called by app.js)                   */
/* ================================================================== */

export function setVoyageProgress(pct) {
  voyagePct = pct;
  if (ctaState === "loading") updateProgressFill();
}

export function voyageReady() {
  if (ctaState === "loading") {
    stopLoadingLines();
    voyagePct = 100;
    updateProgressFill();
  }
  if (ctaState !== "loading") ctaState = "ready";
}

// Called by app.js if the voyage module fails to load or is unsupported late.
export function markVoyageUnavailable() {
  opts.voyageSupported = false;
  resetCta();
  configureHero();
  if (dom.relaunch) dom.relaunch.hidden = true;
}

// Query helpers app.js may want.
export function isLoadingCta() {
  return ctaState === "loading";
}

/* ================================================================== */
/* Init                                                               */
/* ================================================================== */

export function initUI(handlers, options = {}) {
  H = Object.assign({}, H, handlers || {});
  opts = Object.assign(opts, options || {});

  // Cache overlay DOM.
  dom.page = document.getElementById("page");
  dom.header = document.getElementById("site-header");
  dom.main = document.getElementById("classic-main");
  dom.footer = document.getElementById("site-footer");
  dom.panelRoot = document.getElementById("panel-root");
  dom.hud = document.getElementById("hud");
  dom.canvas = document.getElementById("voyage-canvas");
  dom.labels = document.getElementById("island-labels");
  dom.joystick = document.getElementById("joystick-zone");
  dom.dockPrompt = document.getElementById("dock-prompt");
  dom.toast = document.getElementById("toast");
  dom.controlsHint = document.querySelector("#hud .hud-controls-hint");
  dom.relaunch = document.getElementById("voyage-relaunch");
  dom.compass = document.getElementById("compass");
  dom.progress = document.getElementById("progress");
  dom.beatRoot = document.getElementById("beat-root");
  dom.beatLine = document.getElementById("beat-line");
  dom.entry = document.getElementById("entry");
  dom.scrollStart = document.getElementById("scroll-start");
  dom.entryRoute = document.getElementById("entry-route");
  dom.entryShip = document.getElementById("entry-ship");
  dom.scrollBullets = document.querySelector(".scroll-bullets");
  dom.scrollShade = document.querySelector(".scroll-shade");

  if (!opts.voyageSupported) document.body.classList.add("no-voyage");
  if (opts.reducedMotion) document.body.classList.add("reduced");

  // Fill the scroll map chart annotations from site content.
  renderScrollBullets();

  // Render the classic page.
  renderClassic();

  // Hero behaviour.
  configureHero();
  startEpithets();
  buildStarfield();

  // Wire hero CTAs.
  const primary = document.getElementById("cta-primary");
  const secondary = document.getElementById("cta-secondary");

  if (primary) {
    primary.addEventListener("click", () => {
      if (usesFallbackPrimary()) {
        H.onViewClassic();
        return;
      }
      if (ctaState !== "ready") showCtaLoading();
      H.onBeginVoyage();
    });
  }
  if (secondary) {
    secondary.addEventListener("click", () => {
      if (opts.voyageSupported && opts.reducedMotion) {
        // "Launch the voyage anyway" for reduced motion users.
        if (ctaState !== "ready") showCtaLoading();
        H.onBeginVoyage();
      } else {
        H.onViewClassic();
      }
    });
  }

  // Classic project cards, contact form.
  wireProjectCards();
  wireForm($(".oracle-form", dom.main));

  // HUD buttons.
  const btnExit = document.getElementById("btn-exit-voyage");
  const btnMute = document.getElementById("btn-mute");
  if (btnExit) btnExit.addEventListener("click", () => H.onExitVoyage());
  if (btnMute) {
    btnMute.addEventListener("click", () => {
      const muted = btnMute.getAttribute("aria-pressed") !== "true";
      setMuteState(muted);
      H.onMuteToggle(muted);
    });
  }

  // Dock prompt tap (mobile docking).
  if (dom.dockPrompt) {
    dom.dockPrompt.addEventListener("click", () => H.onDockConfirm());
  }

  // Scroll map loader: the Start Voyage gate.
  if (dom.scrollStart) {
    dom.scrollStart.addEventListener("click", () => {
      if (dom.scrollStart.disabled) return;
      H.onEntryStart();
    });
  }

  // Footer colophon and credits modal.
  const creditsBtn = document.getElementById("open-credits");
  if (creditsBtn) creditsBtn.addEventListener("click", openCreditsModal);

  // Relaunch button and scroll niceties.
  setupRelaunchButton();
  setupReveals();
  setupScrollspy();
  setupNavScroll();
  measureCompass();
  initKeyboardInset();

  // Rebuild the starfield on resize (debounced) and re-measure the compass.
  let rT = null;
  window.addEventListener("resize", () => {
    clearTimeout(rT);
    measureCompass();
    if (lastAnchor) positionBeat(lastAnchor);
    rT = window.setTimeout(buildStarfield, 220);
  });

  // Test hook: lets verification drive the render functions with simulated
  // payloads before voyage.js emits the new callbacks. Harmless in production.
  window.__uiTest = {
    updateCompass,
    updateIslandLabels,
    updateProgress,
    beginBeatTour,
    showBeat,
    positionBeat,
    hideBeat,
    openPanel,
    openCreditsModal,
    setMuteState,
    showToast,
    enterVoyageUI
  };

  // Reveal the page (kills any first paint flash).
  document.body.classList.add("ui-ready");
}

export default {
  initUI,
  setVoyageProgress,
  voyageReady,
  enterVoyageUI,
  exitVoyageUI,
  openPanel,
  closePanel,
  updatePrompt,
  updateIslandLabels,
  updateCompass,
  updateProgress,
  beginBeatTour,
  showBeat,
  positionBeat,
  hideBeat,
  showToast,
  setMuteState,
  setSailingTarget,
  showEntryScroll,
  setEntryProgress,
  completeEntryProgress,
  setEntryMode,
  closeEntryScroll,
  markVoyageUnavailable
};
