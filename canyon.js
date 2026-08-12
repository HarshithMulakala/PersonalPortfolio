/* ==========================================================================
   harshithm.com
   "Canyon dusk" v2: a generative halftone landscape for the page header,
   rendered as a single WebGL fragment shader.

   Architecture
   - One fullscreen quad, one hand written GLSL ES 1.00 fragment shader.
     No libraries, no imports, no network. Everything below is original.
   - The landforms are screen space heightfields, not ray marched geometry.
     Every layer evaluates one silhouette height per column and shades the
     interior analytically: a crest to base gradient, a slope term from the
     screen space derivative of that silhouette, a rim on the edges that
     face the sun, and aerial perspective mixing toward the local sky. That
     is what makes them read as lit landforms rather than paper cut-outs,
     and it costs one noise evaluation per layer per pixel.
   - The composition is a pinch. The two foreground canyon walls are a
     signed distance field whose channel is narrowest exactly at the sun
     and opens both toward the viewer and up into the sky, so the whole
     frame funnels to the light.
   - Nothing is halftoned wholesale. The sky, sun and landforms are smooth.
     Only two materials get the dot pass: the cloud deck (with the birds)
     and the canyon floor. Each dot samples its field once at the cell
     centre, so a dot is always one solid disc, and dot RADIUS carries the
     luminance while colour is a separate ramp on top.
   - The image is built in linear light, allowed to go above 1.0 around the
     sun, then run through a filmic curve, a vignette and a static
     triangular dither. That is where the tonal range comes from.

   If WebGL is unavailable the v1 canvas-2D renderer takes over unchanged,
   so the page never breaks.
   ========================================================================== */

(function () {
  "use strict";

  var header = document.querySelector(".scene");
  if (!header) return;

  /* Genuine reduce-motion only. No coarse-pointer or width test rides
     along with it: a phone is not a request for a still picture. */
  var reduceQ = window.matchMedia("(prefers-reduced-motion: reduce)");
  var TAU = Math.PI * 2;

  /* ------------------------------------------------------------------ *
   * Render scale
   *
   * The canvas backing store is sized in PHYSICAL pixels. Sizing it in
   * CSS pixels, which is what this did, hands a 1x drawing to a 3x
   * display and lets the compositor upscale it: every dot in the two
   * halftone fields, every silhouette edge and the sun's own limb arrive
   * bilinearly smeared across three device pixels. That is the whole of
   * "blurry on a real phone".
   *
   * It is capped rather than uncapped because this shader is not cheap
   * and a 3x phone at full scale is three megapixels of fbm per frame.
   * The governor in the frame loop walks the scale down a step at a time
   * if the device cannot hold the budget, so a weak GPU degrades in
   * resolution instead of in frame rate.
   * ------------------------------------------------------------------ */

  var SCALE_STEPS = [2.5, 2, 1.5, 1.25, 1];

  function scaleCeiling() {
    var dpr = window.devicePixelRatio || 1;
    var narrow = Math.round(header.clientWidth) <= 809;
    return Math.min(dpr, narrow ? 2.5 : 2);
  }

  var renderScale = scaleCeiling();

  /* The typed text belongs to the document, not to the renderer. It is
     armed here, before anything can decide there is no scene to draw, so
     the header always reads even when the picture is only the poster. */
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", startTyping);
  } else {
    startTyping();
  }

  var canvas = header.querySelector(".scene-canvas");
  if (!canvas || !canvas.getContext) return;

  /* ------------------------------------------------------------------ *
   * Shared maths
   * ------------------------------------------------------------------ */

  function mulberry32(a) {
    return function () {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

  /* One line, on purpose. Which renderer won is the first thing anyone
     debugging this header from someone else's phone needs to know, and
     the difference between "the scene is broken" and "the scene never
     started" is not visible from the picture alone. */
  function note(msg) {
    if (window.console && window.console.info) window.console.info("canyon: " + msg);
  }

  function smoothstep(e0, e1, x) {
    var t = clamp01((x - e0) / (e1 - e0));
    return t * t * (3 - 2 * t);
  }

  var DAY = 90;                    /* one rise, linger and set */

  /* The sun travels a CLOSED ellipse centred on the horizon line, at a
     warped but strictly periodic rate. Closing the path is what removes
     the seam: at the end of a cycle every term returns to its own start
     value and its own start slope, so the loop never steps.

     TWO warps ride on the phase, and both are closed.

     DWELL, at twice the cycle rate, lingers at the horizon crossings and
     rushes the top and the bottom. That is what holds the scene at
     golden hour instead of passing through a midday. It used to be 0.60,
     which slowed the sun to 0.4x at exactly the moment it sat on the
     horizon line, and since the clock also STARTED there the sun spent
     the opening of every visit parked in the ground. It is now light
     enough that the travel never stops being legible.

     ABOVE, at the cycle rate, is the new one. Without it the path spends
     half of every cycle under the horizon: 45 seconds of a 90 second day
     with nothing in the sky. It slows the arc while the sun is up and
     rushes it while the sun is down, which buys 59 of the 90 seconds
     above the horizon without breaking the loop. */
  var DWELL = 0.18;
  var ABOVE = 0.55;

  function sunPhase(t) {
    var p = (t / DAY) % 1;
    if (p < 0) p += 1;
    var pw = p
      - (DWELL / (4 * Math.PI)) * Math.sin(4 * Math.PI * p)
      + (ABOVE / (2 * Math.PI)) * (Math.cos(2 * Math.PI * p) - 1);
    return Math.PI * (1 - 2 * pw);
  }

  /* ================================================================== *
   * RENDERER A: WebGL
   * ================================================================== */

  var VERT = [
    "attribute vec2 a_pos;",
    "void main(){ gl_Position = vec4(a_pos, 0.0, 1.0); }"
  ].join("\n");

  /* NBIRDS is a token, not a number. WebGL 1 only guarantees 16 fragment
     uniform vectors, and the bird array is the one part of this shader
     whose size is negotiable, so the real count is substituted at build
     time against what the device actually reports. Everything else here
     is fixed; on a GPU at the spec floor the flock is what gives way.

     highp is NOT guaranteed in a GLES2 fragment shader. Asking for it
     unconditionally is the classic way a shader that runs everywhere in
     the lab refuses to compile on a phone. The hashes lose a little
     entropy at mediump and the picture survives; a blank header would
     not. */
  var FRAG = [
    "#extension GL_OES_standard_derivatives : enable",
    "#ifdef GL_FRAGMENT_PRECISION_HIGH",
    "precision highp float;",
    "#else",
    "precision mediump float;",
    "#endif",

    "uniform vec2  u_res;",
    "uniform float u_time;",
    "uniform vec2  u_sun;",       /* uv */
    "uniform float u_sunR;",      /* uv radius */
    "uniform float u_warm;",      /* 0..1, sun height */
    "uniform float u_elev;",      /* -1..1 */
    "uniform float u_hor;",       /* horizon, uv y */
    "uniform float u_gap;",       /* gap centre, uv x */
    "uniform float u_cellF;",     /* floor dot cell, PHYSICAL px */
    "uniform float u_cellC;",     /* cloud dot cell, PHYSICAL px */
    /* Dot edge softness, in cell units, one per field. It is a uniform
       rather than a constant because the cells grow with the render
       scale: to hold the edge at a fixed number of PHYSICAL pixels, and
       so keep a dot on a 3x phone as crisp as a dot on a 1x monitor
       instead of three times blurrier, this has to shrink as they grow. */
    "uniform vec2  u_aa;",
    /* 0 landscape, 1 portrait. The frame is recomposed against this, not
       switched: every use is a mix between the two framings. */
    "uniform float u_port;",
    "uniform vec4  u_birds[NBIRDS];", /* xy uv, z flap, w alive */

    "const mat2 M2 = mat2(0.80,-0.60,0.60,0.80);",

    /* ---- palette, linear light, authored from the site tokens ------- */
    "const vec3 SKY_ZEN   = vec3(0.00700,0.00651,0.01096);",  /* #14131b */
    "const vec3 SKY_HI    = vec3(0.01229,0.00857,0.01444);",  /* #1d1720 */
    "const vec3 SKY_MID   = vec3(0.03310,0.01444,0.02315);",  /* #33202a */
    "const vec3 SKY_LOW   = vec3(0.11193,0.02843,0.01600);",  /* #5e2f22 */
    "const vec3 SKY_WARM  = vec3(0.33245,0.06848,0.01370);",  /* #9c4a1f */
    "const vec3 SKY_HOR   = vec3(0.58408,0.14413,0.01938);",  /* #c96a26 */
    "const vec3 VIOLET    = vec3(0.04231,0.03310,0.08022);",  /* #3a3350 */
    "const vec3 ROSE      = vec3(0.17670,0.08020,0.10620);",  /* #74515c */

    "const vec3 SUN_CORE  = vec3(1.00000,0.92158,0.76052);",  /* #fff6e2 */
    "const vec3 SUN_HALO  = vec3(1.00000,0.43415,0.16203);",  /* #ffb070 */
    "const vec3 SUN_WIDE  = vec3(0.68669,0.13287,0.06848);",  /* #d8664a */
    "const vec3 SUN_DISK  = vec3(1.00000,0.98225,0.90466);",  /* #fffdf4 */
    /* Disc radiance. The filmic curve puts 1.0 at roughly 0.6 of the way
       up its own S, so anything meant to survive as WHITE has to arrive
       several times over the bloom around it. This is the number that
       makes the interior the hottest thing in the frame. */
    "const float SUN_HOT  = 10.0;",

    "const vec3 ACCENT    = vec3(0.79910,0.25818,0.03434);",  /* #e78b34 */
    "const vec3 SAND      = vec3(0.99110,0.59720,0.31855);",  /* #fecb99 */
    "const vec3 LIGHT     = vec3(1.00000,0.81485,0.49693);",  /* #ffe9bb */
    "const vec3 GLOW_LO   = vec3(0.14413,0.03820,0.00972);",  /* #6a3719 */
    "const vec3 GLOW_MID  = vec3(0.57112,0.14413,0.01850);",  /* #c76a25 */

    "const vec3 GRND      = vec3(0.01033,0.00605,0.00518);",  /* #1a1210 */
    "const vec3 GRND_LO   = vec3(0.00402,0.00304,0.00273);",  /* #0d0a09 */

    "const vec3 W3_BASE   = vec3(0.00518,0.00368,0.00304);",  /* #100c0a */
    "const vec3 W3_CREST  = vec3(0.01298,0.00750,0.00605);",  /* #1e1512 */
    "const vec3 W2_BASE   = vec3(0.00802,0.00518,0.00402);",  /* #16100d */
    "const vec3 W2_CREST  = vec3(0.02732,0.01298,0.00750);",  /* #2e1e15 */
    "const vec3 W2_LIT    = vec3(0.10224,0.03190,0.00913);",  /* #5a3218 */
    "const vec3 W1_BASE   = vec3(0.01229,0.00700,0.00518);",  /* #1d1410 */
    "const vec3 W1_CREST  = vec3(0.04231,0.01764,0.00857);",  /* #3a2417 */
    "const vec3 W0_BASE   = vec3(0.02315,0.01229,0.00750);",  /* #2a1d15 */
    "const vec3 W0_CREST  = vec3(0.06301,0.02956,0.01229);",  /* #47301d */

    "const vec3 RIM       = vec3(1.00000,0.69387,0.35153);",  /* #ffd9a0 */
    "const vec3 RIMHOT    = vec3(1.00000,0.88792,0.68669);",  /* #fff2d8 */

    /* ---- noise ------------------------------------------------------ */

    "float hash21(vec2 p){",
    "  vec3 q = fract(vec3(p.xyx)*0.1031);",
    "  q += dot(q, q.yzx + 33.33);",
    "  return fract((q.x+q.y)*q.z);",
    "}",

    "float vnoise(vec2 p){",
    "  vec2 i = floor(p), f = fract(p);",
    "  vec2 u = f*f*f*(f*(f*6.0-15.0)+10.0);",
    "  float a = hash21(i);",
    "  float b = hash21(i+vec2(1.0,0.0));",
    "  float c = hash21(i+vec2(0.0,1.0));",
    "  float d = hash21(i+vec2(1.0,1.0));",
    "  return mix(mix(a,b,u.x), mix(c,d,u.x), u.y);",
    "}",

    "float fbm2(vec2 p){",
    "  return 0.62*vnoise(p) + 0.38*vnoise(M2*p*2.07);",
    "}",

    "float fbm3(vec2 p){",
    "  float v = 0.5*vnoise(p); p = M2*p*2.03;",
    "  v += 0.25*vnoise(p);     p = M2*p*2.01;",
    "  v += 0.125*vnoise(p);",
    "  return v/0.875;",
    "}",

    "float fbm4(vec2 p){",
    "  float v = 0.5*vnoise(p);  p = M2*p*2.03;",
    "  v += 0.25*vnoise(p);      p = M2*p*2.01;",
    "  v += 0.125*vnoise(p);     p = M2*p*2.05;",
    "  v += 0.0625*vnoise(p);",
    "  return v/0.9375;",
    "}",

    /* ---- terrain shaping -------------------------------------------- */

    /* Push a height toward flat-topped mesa steps. The tread stays level
       across most of a step and the riser turns over fast, which is what
       makes a butte read as a butte instead of a dune. */
    "float plateau(float h, float steps, float sharp, float amt){",
    "  float s = h*steps;",
    "  float i = floor(s);",
    "  float f = fract(s);",
    "  float r = smoothstep(0.60, 0.60 + 0.36/sharp, f);",
    "  return mix(h, (i + r)/steps, amt);",
    "}",

    /* Silhouette height for one mesa layer, in uv units above the horizon.
       The V is built in here: heights collapse into the gap and the buttes
       flanking it stand tallest, so the skyline itself funnels the eye. */
    "float ridgeH(float x, float seed, float freq, float drift, float amp,",
    "             float steps, float sharp, float terr, float gapW){",
    "  float h = fbm4(vec2(x*freq + drift, seed));",
    "  h = clamp(h*1.46 - 0.20, 0.0, 1.0);",
    "  h = plateau(h, steps, sharp, terr);",
    /* A second, finer terrace rides on the first. That is the caprock
       step: the narrow shelf that sits just under the rim of a butte and
       is what tells the eye "mesa" rather than "dune". */
    "  float cap = fbm3(vec2(x*freq*2.6 + drift*1.7 + 19.0, seed + 4.0));",
    "  h += (plateau(clamp(cap*1.3 - 0.15, 0.0, 1.0), steps*2.2, sharp*1.3, 0.95) - 0.5)",
    "       * 0.16 * terr;",
    "  h = clamp(h, 0.0, 1.15);",
    /* The notch has to be measured against the frame, not against the
       world. On a phone the same gap width lands its shoulder INSIDE the
       visible valley, so a butte stands up in the middle of the opening
       and the composition stops being a canyon. Portrait widens the taper
       and drives it harder toward the centre, which also pushes the two
       flanking buttes out to the frame edges where they belong. */
    "  float d = abs(x - u_gap)/(gapW*mix(1.0, 1.70, u_port));",
    "  float g = smoothstep(0.0, 1.0, min(d, 1.0));",
    "  g = pow(g, mix(1.0, 1.50, u_port));",
    "  float frame = 1.0 + 0.62*exp(-pow((d-1.16)*2.1, 2.0));",
    "  float y = h*amp*mix(0.02, 1.0, g)*frame;",
    /* Roughening applied AFTER the gap taper. Before it, the taper scales
       the detail away and the silhouette either side of the notch comes
       out as a drawing-board straight ramp. */
    "  y += (fbm2(vec2(x*freq*6.2 + 31.0, seed + 9.0)) - 0.5)*amp*0.13*mix(0.20, 1.0, g);",
    "  return y;",
    "}",

    /* ---- sky and light ---------------------------------------------- */

    "vec3 skyGrad(vec2 uv){",
    "  float y = clamp((uv.y - u_hor)/max(1.0-u_hor, 0.001), 0.0, 1.0);",
    /* A phone shows this gradient over twice the height it was drawn for,
       so stops that read as one sweep across a landscape frame read as
       stacked bands up a portrait one. Every transition is widened and
       pulled apart on portrait, and the low band walks toward a dusty
       rose, so the sky stays a single move from horizon to zenith. */
    "  float p = u_port;",
    "  vec3 LOW = mix(SKY_LOW, ROSE, 0.50*p);",
    "  vec3 MID = mix(SKY_MID, ROSE, 0.26*p);",
    "  vec3 c = SKY_HOR;",
    "  c = mix(c, SKY_WARM, smoothstep(0.00, mix(0.11, 0.21, p), y));",
    "  c = mix(c, LOW,      smoothstep(mix(0.07,0.11,p), mix(0.26,0.42,p), y));",
    "  c = mix(c, MID,      smoothstep(mix(0.21,0.34,p), mix(0.50,0.68,p), y));",
    "  c = mix(c, SKY_HI,   smoothstep(mix(0.44,0.58,p), mix(0.74,0.88,p), y));",
    "  c = mix(c, SKY_ZEN,  smoothstep(mix(0.68,0.80,p), 1.00, y));",
    /* A faint cool violet lift up top. Nothing makes the warm horizon
       read as warm like putting something cool above it. */
    "  c += VIOLET*0.30*smoothstep(0.30, 1.00, y);",
    "  return c;",
    "}",

    /* Three scales of bloom. The widest one is flattened onto the horizon
       line, because that is how a real sunset spreads: wide across the
       sky, shallow up it. */
    "vec3 sunLight(vec2 uv, float asp){",
    "  vec2 d = (uv - u_sun)*vec2(asp, 1.0);",
    "  float r = length(d);",
    /* The widest lobe is flattened ONTO the horizon. A phone frame is
       more than twice as tall for its width, so the same flattening that
       keeps this lobe low across a monitor lets it climb the whole way
       up a portrait sky and lay a red wash over the zenith. It has to be
       squashed harder the taller the frame gets. */
    "  vec2 dw = (uv - vec2(u_sun.x, u_hor))*vec2(asp*0.40, mix(1.62, 3.20, u_port));",
    "  float rw = length(dw);",
    "  float lift = 0.34 + 0.66*smoothstep(-0.70, 0.30, u_elev);",
    "  vec3 c = vec3(0.0);",
    "  c += SUN_WIDE * exp(-rw*2.30) * 0.86 * lift;",
    /* Portrait TIGHTENS the halo and pays for it in brightness. These
       two lobes fall off with distance measured in frame heights, and a
       phone compresses horizontal distance to 0.46 of that, so the same
       falloff that reaches a landscape frame's corners lays a flat wash
       over an entire portrait sky and takes the dusk out of it. Steeper
       and hotter keeps a blazing disc against a sky that still has a
       dark end to it. */
    "  c += SUN_HALO * exp(-r*mix(7.60, 9.60, u_port)) * mix(1.70, 1.95, u_port) * lift;",
    /* The near-white lobe is deliberately small. It used to run at 1.48,
       which painted a SECOND soft white disc over the same few degrees of
       sky as the real one, and a filmic curve cannot separate two whites.
       That is what left the disc with nowhere to be brighter than its own
       bloom and reduced the sun to whatever outline still survived at the
       limb. The same energy now lives in the orange lobe above and in the
       disc itself, so the air around the sun is GOLD and the ball is the
       only white thing in the frame. */
    "  c += SUN_CORE * exp(-r*mix(24.0, 22.0, u_port)) * mix(0.42, 0.48, u_port) * lift;",
    "  return c;",
    "}",

    /* Banded backlit deck. Three bands at different heights drifting at
       different rates, noise stretched flat so the deck lies down. */
    "float cloudLevel(vec2 uv, float asp){",
    "  float a = 0.0;",
    "  float span = 1.0 - u_hor;",
    "  for (int i = 0; i < 3; i++){",
    "    float fi = float(i);",
    "    float by = u_hor + (0.12 + fi*0.150)*span;",
    "    by += sin(u_time*(0.0455 + fi*0.0212) + fi*2.1)*0.013;",
    "    float sg = (0.070 - fi*0.010)*span;",
    "    float e = exp(-pow((uv.y-by)/sg, 2.0));",
    "    float dx = u_time*(0.0078 + fi*0.0062);",
    /* uv.x*asp is the isotropic choice, and on a phone it is the wrong
       one: the frame is only 0.46 of a height wide, so the deck shows a
       narrow slice of the noise and every feature comes out smeared
       three times too wide. That is where the pale triangular wisps
       above the notch come from. Portrait raises the x frequency back
       until the deck carries a comparable number of features ACROSS the
       frame, which is what the composition actually reads. */
    "    vec2 q = vec2(uv.x*mix(asp, 1.15, u_port)*1.95 - dx, (uv.y-by)*6.9 + fi*13.7);",
    "    float n = 0.58*fbm3(q) + 0.42*fbm2(q*2.35 + 41.0);",
    "    a = max(a, smoothstep(0.455, 0.830, n)*e);",
    "  }",
    /* never let the deck touch the horizon band, the sun owns that */
    "  return a*smoothstep(0.0, 0.055*span, uv.y - u_hor);",
    "}",

    /* Birds ride the same lattice as the cloud deck, so they come out of
       the same medium instead of sitting on top of it as line art. */
    "float birdInk(vec2 uv, float asp){",
    "  float s = 0.0;",
    "  for (int i = 0; i < NBIRDS; i++){",
    "    vec4 b = u_birds[i];",
    "    vec2 d = (uv - b.xy)*vec2(asp, 1.0);",
    "    float y = d.y - abs(d.x)*b.z*0.70;",
    "    float m = exp(-pow(y/0.0037, 2.0))",
    "            * smoothstep(0.0165, 0.0105, abs(d.x)) * b.w;",
    "    s = max(s, m);",
    "  }",
    "  return s;",
    "}",

    /* Canyon floor. One fixed lattice, three scrolling octaves pushing
       brightness through it, funnelled into the channel. */
    "float floorLevel(vec2 uv, float asp){",
    /* The field's leading edge is pushed around by noise. Without this the
       dots begin on a dead straight horizontal rule, which no amount of
       grading afterwards will disguise. */
    "  float wob = (fbm2(vec2(uv.x*4.2 + 3.0, 7.0)) - 0.5)*0.058;",
    "  float t = min((u_hor - uv.y + wob)/max(u_hor, 0.001), 1.0);",
    "  float tp = max(t, 0.0);",
    /* Portrait opens the channel wider and softens its falloff. On a
       phone this field IS the picture below the ridge, so it has to
       reach the frame edges instead of staying a ribbon down the middle. */
    "  float hw = 0.058 + mix(0.64, 0.95, u_port)*pow(tp, 0.90);",
    "  float cx = u_gap - 0.11*tp;",
    "  float across = (uv.x - cx)/hw;",
    "  float chan = exp(-across*across*mix(1.55, 1.12, u_port));",
    /* The field has to arrive out of the horizon light, not switch on at
       it, so it starts a little ABOVE the horizon inside the glow and
       fades in over a long ramp. That is the whole difference between a
       receding floor and a dotted panel someone pasted on. */
    /* Landscape lets the field fall away toward the viewer, because it
       has a wide horizon to carry the eye. Portrait does not: the frame
       below the ridge is HALF the picture, and a field that fades to
       0.16 by the bottom edge is the sparse grey patch under the text
       that a phone actually shows. Portrait keeps a high floor and puts
       the peak a little way into the frame instead, so the field arrives
       out of the notch, blazes across the near ground, and is still
       plainly there at the bottom edge. */
    "  float vmL = 0.16 + 0.84*pow(1.0-t, 1.15);",
    "  float vmP = 0.46 + 0.54*exp(-pow((t - 0.30)/0.46, 2.0));",
    "  float vm = mix(vmL, vmP, u_port)*smoothstep(-0.075, 0.175, t);",
    "  vec2 p = vec2(uv.x*asp, uv.y);",
    "  float I = 0.36*fbm2(p*vec2(7.2, 11.6) + vec2(0.0, -u_time*0.202))",
    "          + 0.32*fbm2(p*vec2(16.2, 26.4) + vec2(u_time*0.063, -u_time*0.371) + 17.0)",
    "          + 0.32*fbm2(p*vec2(4.0, 6.4) + vec2(0.0, -u_time*0.075) + 71.0);",
    "  float l = 0.10 + 0.90*smoothstep(0.200, 0.820, I);",
    /* slow patchiness, so the field is a ground with bright and dull
       reaches rather than one even wash of dots */
    "  l *= 0.72 + 0.52*fbm2(vec2(uv.x*asp*2.6, uv.y*3.4) + 53.0);",
    /* The light lays a path straight down the channel and widens as it
       comes at you. This is where the field gets its whole top end: the
       blazing near-white cores live in here and nowhere else. */
    "  float gw = 0.035 + 0.44*pow(tp, 1.10);",
    "  float gx = (uv.x - (u_sun.x - 0.09*tp))/gw;",
    "  float glint = exp(-gx*gx)*(0.28 + 0.72*pow(1.0-t, 1.45));",
    "  float lvl = l*vm*chan + l*glint*(0.66 + 0.46*u_warm);",
    "  return clamp(lvl*(0.74 + 0.48*u_warm), 0.0, 1.0);",
    "}",

    /* ---- halftone ---------------------------------------------------- */

    /* Dot RADIUS carries the level. The lattice never moves and the jitter
       is applied to the level, not the position, so the grid stays perfectly
       regular while the banding it would otherwise show is broken up. */
    "float dotAt(vec2 px, float cell, float lvl, float K, float aa, float jit){",
    "  vec2 C  = floor(px/cell);",
    "  vec2 Cp = (px - (C+0.5)*cell)/cell;",
    "  float j = (hash21(C + vec2(7.3, 11.9)) - 0.5)*jit;",
    "  float rad = clamp(lvl + j, 0.0, 1.0)*K;",
    "  return smoothstep(rad, rad-aa, length(Cp));",
    "}",

    /* ---- one shaded landform layer ----------------------------------- */

    /* Everything that stops a layer reading as a paper cut-out happens
       here: a lit crest falling to a dark base, a slope term from the
       screen space derivative of the silhouette so faces turned toward
       the sun brighten, a rim wherever the silhouette itself faces the
       sun, and aerial perspective toward the local sky. */
    "vec4 ridgeShade(vec2 uv, float ry, vec3 cB, vec3 cC, vec3 cL,",
    "                float haze, float rimA, float grad, vec3 skyHere){",
    "  float e = ry - uv.y;",
    "  float w = max(fwidth(e), 1e-6);",
    "  float cov = clamp(e/w + 0.5, 0.0, 1.0);",
    "  float dydx = dFdx(ry)*u_res.y;",
    "  vec2 N = normalize(vec2(-dydx, 1.0));",
    "  vec2 L = normalize((u_sun - uv)*u_res);",
    "  float lam = clamp(dot(N, L), 0.0, 1.0);",
    "  float vg = exp(-e*grad);",
    "  vec3 c = mix(cB, cC, vg);",
    "  c = mix(c, cL, lam*lam*0.74*(0.28 + 0.72*u_warm));",
    "  float rim = smoothstep(0.0115, 0.0, e)*pow(lam, 1.30)*rimA",
    "            * smoothstep(0.60, 0.02, u_elev);",
    "  c += mix(RIM, RIMHOT, u_warm)*rim*(0.50 + 1.60*u_warm);",
    "  c = mix(c, skyHere, haze);",
    "  return vec4(c, cov);",
    "}",

    /* ---- grade -------------------------------------------------------- */

    /* Narkowicz's ACES fit. On a linear image with a genuinely hot sun it
       is what turns the core white, rolls the halo through salmon and
       keeps the shadows espresso instead of grey. */
    "vec3 filmic(vec3 x){",
    "  return clamp((x*(2.51*x+0.03))/(x*(2.43*x+0.59)+0.14), 0.0, 1.0);",
    "}",

    /* ================================================================== */

    "void main(){",
    "  vec2 px  = gl_FragCoord.xy;",
    "  vec2 uv  = px/u_res;",
    "  float asp = u_res.x/u_res.y;",

    /* ---- 1. sky ---- */
    "  vec3 sky = skyGrad(uv);",
    "  vec3 col = sky;",

    /* ---- 2. sun ---- */
    "  vec3 glow = sunLight(uv, asp);",
    "  col += glow;",
    "  sky += glow;",           /* landforms haze toward a glow inclusive sky */

    /* ---- 3. stars ---- */
    "  float night = smoothstep(0.30, -0.45, u_elev);",
    "  {",
    "    float sc = 92.0;",
    "    vec2 sp = uv*vec2(asp,1.0)*sc + vec2(u_time*0.020, 0.0);",
    "    vec2 si = floor(sp);",
    "    float hh = hash21(si);",
    "    if (hh > 0.845){",
    "      vec2 sf = fract(sp) - 0.5;",
    "      float h2 = hash21(si + 3.7);",
    "      float tw = 0.58 + 0.42*sin(u_time*2.5 + h2*50.0);",
    "      float m = smoothstep(0.055 + 0.16*h2, 0.0, length(sf));",
    "      float fade = smoothstep(u_hor + 0.02, 1.0, uv.y);",
    "      col += LIGHT*m*tw*(0.30 + 0.70*h2)*night*fade*0.85;",
    "    }",
    "  }",

    /* ---- 4. cloud deck, halftoned, plus the birds ---- */
    "  {",
    "    vec2 C = floor(px/u_cellC);",
    "    vec2 cc = (C + 0.5)*u_cellC/u_res;",
    "    float a = cloudLevel(cc, asp);",
    "    float lvl = pow(smoothstep(0.025, 0.50, a), 0.70);",
    /* cloud nearest the sun catches the most light on its underside */
    "    float dxs = (cc.x - u_sun.x)*asp/0.42;",
    "    float lit = 0.42 + 0.86*exp(-dxs*dxs)",
    "              * (0.35 + 0.65*smoothstep(0.10, -0.05, cc.y - u_sun.y));",
    /* Portrait wants a clean sky. Held this far back the deck survives
       only as the faintest tone near the sun, which is the point: on a
       phone the dot lattice against a bright sky reads as a rectangular
       screen artefact sitting over the glow, not as cloud. The sun and
       the gradient carry the frame instead, the way the reference does. */
    "    lvl *= lit*(0.78 + 0.62*u_warm)*mix(1.0, 0.13, u_port);",
    "    float d = dotAt(px, u_cellC, lvl, 0.395, u_aa.y, 0.065);",
    "    vec3 cc1 = mix(GLOW_MID, SAND, smoothstep(0.10, 0.78, lvl));",
    "    cc1 = mix(cc1, LIGHT, smoothstep(0.58, 1.00, lvl));",
    "    col = mix(col, cc1, d*clamp(lvl*2.9, 0.0, 0.95));",
    "    float ink = birdInk(cc, asp);",
    "    float bd = dotAt(px, u_cellC, ink*0.95, 0.44, u_aa.y, 0.0);",
    "    col = mix(col, GRND_LO, bd*smoothstep(0.15, 0.55, ink));",
    "  }",

    /* ---- 5. landform silhouettes. Three layers, each meandering on its
            own slow period so the skyline never repeats to the eye. ---- */
    "  float drift0 = sin(u_time/58.0*6.2831853)*0.055;",
    "  float drift1 = sin(u_time/46.0*6.2831853 + 1.9)*0.090;",
    "  float drift2 = sin(u_time/38.0*6.2831853 + 3.4)*0.130;",

    "  float h0 = ridgeH(uv.x, 11.3, 3.6, drift0, 0.132, 5.0, 2.2, 0.62, 0.150);",
    "  float h1 = ridgeH(uv.x, 27.9, 2.7, drift1, 0.198, 5.0, 2.6, 0.78, 0.205);",
    "  float h2 = ridgeH(uv.x, 41.7, 2.0, drift2, 0.250, 6.0, 3.0, 0.88, 0.265);",

    /* ---- 6. distant mesas, standing on the horizon. They are full masses
            painted down past their own feet; the canyon floor is laid over
            them next, which is what buries the join instead of leaving a
            straight rule across the frame where they stop. ---- */
    "  vec4 L0 = ridgeShade(uv, u_hor + 0.012 + h0, W0_BASE, W0_CREST, W2_LIT,",
    "                       0.62, 0.40, 13.0, sky);",
    "  vec4 L1 = ridgeShade(uv, u_hor + 0.004 + h1, W1_BASE, W1_CREST, W2_LIT,",
    "                       0.26, 0.55, 12.5, sky);",
    "  col = mix(col, L0.rgb, L0.a);",
    "  col = mix(col, L1.rgb, L1.a);",

    /* ---- 7. a band of lit dust sitting on the horizon, in front of the
            distant mesas' feet. Deserts always have it, and it is what
            stops the far layers looking stacked. ---- */
    "  col += GLOW_MID*0.20*exp(-pow((uv.y - u_hor)/0.052, 2.0))",
    "         *(0.28 + 0.72*u_warm);",

    /* ---- 8. canyon floor: ground base, then the dot field ---- */
    "  {",
    "    float t = clamp((u_hor - uv.y)/max(u_hor, 0.001), 0.0, 1.0);",
    "    float grd = smoothstep(-0.004, 0.014, u_hor - uv.y);",
    "    vec3 gc = mix(mix(SKY_HOR*0.42, GRND, smoothstep(0.0, 0.11, t)),",
    "                  GRND_LO, smoothstep(0.22, 0.90, t));",
    /* the base under the dots carries the channel's own warmth, so the
       smooth ground and the dot field read as one material */
    "    float cw = exp(-pow((uv.x - u_gap + 0.11*t)/(0.10 + 0.70*t), 2.0));",
    "    gc += GLOW_LO*0.60*cw*(0.30 + 0.70*u_warm)*(1.0 - t*0.55);",
    "    col = mix(col, gc, grd);",
    "    vec2 C = floor(px/u_cellF);",
    "    vec2 cc = (C + 0.5)*u_cellF/u_res;",
    "    float lvl = floorLevel(cc, asp);",
    "    float d = dotAt(px, u_cellF, lvl, mix(0.50, 0.545, u_port), u_aa.x, 0.155);",
    "    vec3 fc = mix(GLOW_LO, ACCENT, smoothstep(0.06, 0.52, lvl));",
    "    fc = mix(fc, SAND, smoothstep(0.44, mix(0.80, 0.74, u_port), lvl));",
    /* Portrait reaches the white end sooner. The reference's field runs
       the full way to white and that top end is what makes it read as
       light on ground rather than as a texture swatch. */
    "    fc = mix(fc, LIGHT, smoothstep(mix(0.72, 0.60, u_port), 1.00, lvl));",
    "    float dg = smoothstep(-0.030, 0.030, u_hor - uv.y);",
    "    col = mix(col, fc, d*dg);",
    "  }",

    /* ---- 9. the near canyon. Buttes on the skyline whose masses sweep
            down and inward to form the channel the light comes through.
            The mass is the INTERSECTION of two edges: below its own crest,
            and outside the channel. That is what keeps it a landform
            instead of the giant funnel a bare channel would draw. ---- */
    "  {",
    /* The near mass sweeps up into the frame corners. This one term is
       what puts the camera down on the canyon floor instead of leaving it
       floating above a model of a landscape. */
    /* How far the near mass climbs the frame edges. On a landscape frame
       0.46 is the mass that seats the camera on the canyon floor. Carry
       the same number onto a phone and the two walls become full height
       vertical slabs with a slit of sky between them, which is what the
       header actually looked like on a real device. Portrait lowers the
       climb and lengthens the run into it, so the masses sweep in from
       the lower corners instead of standing up at the edges. */
    "    float edgeLift = pow(clamp(abs(uv.x - u_gap)/mix(0.52, 0.66, u_port), 0.0, 1.0),",
    "                         1.48)*mix(0.46, 0.26, u_port);",
    "    float crest = u_hor - 0.004 + h2 + edgeLift;",
    "    float e = crest - uv.y;",
    "    float we = max(fwidth(e), 1e-6);",
    "    float covTop = clamp(e/we + 0.5, 0.0, 1.0);",

    "    float below  = max(u_hor - uv.y, 0.0)/max(u_hor, 0.001);",
    "    float aboveN = max(uv.y - u_hor, 0.0)/max(1.0-u_hor, 0.001);",
    "    float side = sign(uv.x - u_gap + 1e-5);",
    /* the two walls are deliberately not mirror images: one stands
       closer and steeper, which is what stops the frame reading as a
       symmetrical letter V */
    "    float asym = side > 0.0 ? 0.86 : 1.18;",
    /* Portrait opens the notch and pulls the walls back off the near
       ground, which is what hands the bottom of the frame to the floor
       field instead of to two dark slabs. */
    "    float hw = (0.058 + mix(1.02, 1.18, u_port)*pow(below, 0.72)",
    "                      + mix(0.17, 0.26, u_port)*pow(aboveN, 1.22))*asym;",
    "    float cx = u_gap - 0.085*below;",
    /* The wobble has to vary along the edge whatever direction the edge
       happens to run, or the near-horizontal stretches come out as a
       clean swoosh. Two scales: big lobes, then a finer break-up. */
    "    hw *= 1.0 + 0.20*(fbm3(vec2(uv.x*3.1, uv.y*3.4) + side*9.0) - 0.5)",
    "              + 0.15*(fbm2(vec2(uv.x*1.3, uv.y*1.5) + side*21.0) - 0.5);",
    "    float dw = abs(uv.x - cx) - hw;",
    "    float ww = max(fwidth(dw), 1e-6);",
    "    float covCh = clamp(dw/ww + 0.5, 0.0, 1.0);",
    "    float cov = covTop*covCh;",

    "    float depCh  = clamp(dw/0.22, 0.0, 1.0);",
    "    float depTop = clamp(e/0.17, 0.0, 1.0);",
    "    float dep = max(depCh*0.72, depTop*0.88);",
    /* The nearest mass is the darkest thing in the frame. It is the
       shadow anchor the blazing horizon needs to read as blazing. */
    "    vec3 c = mix(W3_CREST, W3_BASE, smoothstep(0.0, 0.85, dep));",
    "    vec2 N = normalize(vec2(-side, 0.55 + 0.90*depCh));",
    "    vec2 L = normalize((u_sun - uv)*u_res);",
    "    float lam = clamp(dot(N, L), 0.0, 1.0);",
    "    c = mix(c, W2_LIT*0.80, lam*lam*0.52*(0.25 + 0.75*u_warm));",
    /* A slow mottle across the face plus bounce light off the glowing
       floor, so a big dark mass reads as rock in shadow rather than as a
       hole cut in the picture. */
    "    c *= 0.80 + 0.36*fbm3(vec2(uv.x*3.2, uv.y*2.4) + 5.0);",
    "    c += GLOW_LO*0.55*exp(-depCh*2.8)*exp(-max(u_hor - uv.y, 0.0)*3.4)",
    "         *(0.30 + 0.70*u_warm);",
    /* The rim is broken up along its own length and falls away from the
       sun. An unbroken bright edge is the single thing that makes this
       kind of scene read as vector art rather than landscape. */
    "    float rn = 0.22 + 0.78*fbm2(vec2(uv.x*11.0, uv.y*9.0) + side*4.0);",
    "    vec2 sd = (uv - u_sun)*vec2(asp, 1.0);",
    "    float sunFall = exp(-dot(sd, sd)/0.030);",
    "    float rimE = smoothstep(0.0090, 0.0, dw)*covTop;",
    "    float rimT = smoothstep(0.0090, 0.0, e)*covCh;",
    /* A rim is a BACKLIT effect. Once the sun has climbed above the ridge
       the edge is front lit and there is no rim at all, only a lit face.
       Without this gate the crest wears a bright cream pipe all day. */
    "    float backlit = smoothstep(0.60, 0.02, u_elev);",
    "    float rim = max(rimE, rimT)*rn*(0.05 + 0.95*sunFall)*pow(lam, 0.85)*backlit;",
    "    c += mix(RIM, RIMHOT, u_warm)*rim*(0.26 + 0.85*u_warm);",
    "    c = mix(c, sky, 0.05);",
    "    col = mix(col, c, cov);",
    "  }",

    /* ---- 10. sun disk, drawn last so it sits in the notch ---- */

    /* The sun is a BALL OF LIGHT, and the one rule that keeps it one is
       that every term below falls off monotonically from the centre. A
       term that peaks anywhere else is a ring, and a ring is what this
       used to draw: the disc was painted at 2.10 while the bloom it sat
       in already reached 2.5, so the filmic curve landed the interior and
       the halo on the same white and the only thing left with any
       contrast was the burnt band at the limb. A bright outline with
       nothing inside it. A soap bubble.

       So: no collar centred on the limb, no burnt band, no stroked edge.
       Radiance far above the halo, and a temperature ramp that carries
       the disc from white hot, through cream, into exactly the colour of
       the bloom waiting outside it. The edge is then simply where the
       falloff is steepest, which is what an edge is. */
    "  {",
    "    vec2 d = (uv - u_sun)*vec2(asp, 1.0);",
    "    float r = length(d);",
    "    float R0 = max(u_sunR, 1e-5);",
    "    float q = r/R0;",
    "    float vis = smoothstep(-0.010, 0.012, uv.y - u_hor);",
    /* The limb is resolved from the screen space derivative, not from a
       fixed uv width. A fixed width is a fraction of the frame, so it
       gets three times blurrier on a 3x phone; this holds the same few
       pixels of melt wherever it is drawn, which is the whole difference
       between a crisp sun and a soft one. The floor is what stops it
       being a hard chip on a big display, the ceiling is what stops a
       tiny disc dissolving into its own antialiasing. */
    "    float soft = clamp(fwidth(r)*2.0/R0, 0.065, 0.42);",
    "    float edge = 1.0 - smoothstep(1.0 - soft, 1.0 + soft, q);",
    /* Limb darkening, and the reason the ball reads as a sphere rather
       than a sticker: the middle is hotter than the edge. It has to stay
       FLAT across the middle third, though. Rolling from q=0 costs the
       disc its plateau and the sun stops being a body with a size and
       becomes a patch of fog with a bright spot in it. */
    "    float body = edge*(1.0 - 0.40*smoothstep(0.55, 1.06, q));",
    "    vec3 temp = mix(SUN_DISK, LIGHT, smoothstep(0.28, 0.78, q));",
    "    temp = mix(temp, mix(LIGHT, SUN_HALO, 0.85), smoothstep(0.68, 1.06, q));",
    "    col += temp*(SUN_HOT*body)*vis;",
    /* The warm seat that puts the disc IN the air rather than on top of
       it. Centred on the sun, never on its limb, so it is one more
       monotonic falloff and cannot draw an outline. */
    "    col += mix(RIM, SUN_HALO, 0.55)*exp(-q*q*0.42)",
    "           *0.50*vis*(0.40 + 0.60*u_warm);",
    "  }",

    /* ---- 11. grade ---- */
    "  col = filmic(col*1.16);",
    "  col = pow(max(col, 0.0), vec3(1.0/2.2));",
    "  vec2 q = (uv - 0.5)*vec2(1.05, 1.18);",
    "  col *= mix(0.845, 1.0, smoothstep(1.22, 0.10, dot(q,q)*2.1));",
    /* Static triangular dither just under one code value. It is the only
       thing standing between a 5 stop sky gradient and visible banding. */
    "  float n1 = hash21(px);",
    "  float n2 = hash21(px + 19.71);",
    "  col += (n1 + n2 - 1.0)*(0.9/255.0);",
    "  gl_FragColor = vec4(col, 1.0);",
    "}"
  ].join("\n");

  function makeGL() {
    var gl = null;
    try {
      var opts = { antialias: false, alpha: false, depth: false, stencil: false,
                   premultipliedAlpha: false, preserveDrawingBuffer: false,
                   powerPreference: "default", failIfMajorPerformanceCaveat: false };
      gl = canvas.getContext("webgl", opts) || canvas.getContext("experimental-webgl", opts);
    } catch (e) { gl = null; }
    if (!gl) return null;

    /* fwidth and dFdx are load bearing here: every silhouette edge, the
       sun's limb and both halftone fields resolve their antialiasing
       from them. Without the extension the shader cannot compile at all,
       so this hands over to the 2D path deliberately rather than leaving
       a link failure to strand the header on the poster. */
    if (!gl.getExtension("OES_standard_derivatives")) {
      note("no OES_standard_derivatives, falling back");
      return null;
    }
    var timerExt = gl.getExtension("EXT_disjoint_timer_query");

    /* WebGL 1 only promises 16 fragment uniform vectors. The scene needs
       12 of them and each bird costs one more, so on a device sitting at
       the spec floor the flock is what has to give way. Every real GPU
       reports far more than this and gets the whole flock. */
    var maxVec = gl.getParameter(gl.MAX_FRAGMENT_UNIFORM_VECTORS) || 16;
    var NBIRDS = Math.max(1, Math.min(12, maxVec - 14));

    /* Compile and link WITHOUT asking for status. Querying compile or link
       state forces the driver to finish the job on the main thread, which
       is the classic WebGL cold-start stall. Chrome compiles in the
       background if you leave it alone, so the status check and the
       uniform lookups are deferred to the first draw, by which time the
       work has usually already finished off-thread.
       Ref: KHR_parallel_shader_compile best practice notes. */
    function shader(type, src) {
      var s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      return s;
    }

    var vs = shader(gl.VERTEX_SHADER, VERT);
    var fs = shader(gl.FRAGMENT_SHADER, FRAG.replace(/NBIRDS/g, String(NBIRDS)));
    var prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.bindAttribLocation(prog, 0, "a_pos");
    gl.linkProgram(prog);

    var buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);

    var U = null, linkState = 0;   /* 0 unknown, 1 good, -1 failed */

    function ready() {
      if (linkState) return linkState > 0;
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
        if (window.console) {
          console.error("canyon: " +
            (gl.getShaderInfoLog(vs) || "") + (gl.getShaderInfoLog(fs) || "") +
            (gl.getProgramInfoLog(prog) || ""));
        }
        linkState = -1;
        return false;
      }
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      gl.useProgram(prog);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      U = {};
      var names = ["u_res", "u_time", "u_sun", "u_sunR", "u_warm", "u_elev",
        "u_hor", "u_gap", "u_cellF", "u_cellC", "u_aa", "u_port", "u_birds"];
      for (var i = 0; i < names.length; i++) {
        U[names[i]] = gl.getUniformLocation(prog, names[i]);
      }
      linkState = 1;
      note("webgl linked, " + NBIRDS + " birds, " + maxVec +
        " fragment uniform vectors, scale " + renderScale + "x");
      return true;
    }

    var W = 0, H = 0, PW = 0, PH = 0, port = 0;
    var horizon = 0.365, gapX = 0.60;
    var sunRx = 0, sunRxHi = 0, sunRy = 0, sunR = 0;
    var cellF = 4, cellC = 4, aaF = 0.16, aaC = 0.16;
    var birdBuf = new Float32Array(NBIRDS * 4);

    /* --- birds: same cadence as v1, at most two flocks in the air --- */
    var flockRnd = mulberry32(0xb17e42);
    var flocks = [];
    var nextFlock = 6;

    function updateFlocks(t) {
      if (t > nextFlock && flocks.length < 2) {
        nextFlock = t + 9 + flockRnd() * 7;
        var dir = flockRnd() < 0.5 ? 1 : -1;
        var n = 3 + ((flockRnd() * 4) | 0);
        var birds = [];
        for (var i = 0; i < n; i++) {
          birds.push({
            ox: -i * 0.017 * dir - flockRnd() * 0.012 * dir,
            oy: (flockRnd() - 0.5) * 0.035,
            ph: flockRnd() * TAU,
            fr: 3.0 + flockRnd() * 1.8
          });
        }
        flocks.push({
          x: dir > 0 ? -0.10 : 1.10,
          y: 0.62 + flockRnd() * 0.20,
          vx: (0.028 + flockRnd() * 0.034) * dir,
          wob: flockRnd() * TAU,
          birds: birds,
          t0: t
        });
      }
      for (var f = flocks.length - 1; f >= 0; f--) {
        var fl = flocks[f];
        var x = fl.x + fl.vx * (t - fl.t0);
        if (x < -0.22 || x > 1.22) flocks.splice(f, 1);
      }
    }

    function packBirds(t) {
      var k = 0;
      for (var i = 0; i < birdBuf.length; i++) birdBuf[i] = 0;
      if (!reduceQ.matches) {
        for (var f = 0; f < flocks.length && k < NBIRDS; f++) {
          var fl = flocks[f];
          var fx = fl.x + fl.vx * (t - fl.t0);
          var fy = fl.y + Math.sin(t * 0.24 + fl.wob) * 0.012;
          for (var b = 0; b < fl.birds.length && k < NBIRDS; b++) {
            var bd = fl.birds[b];
            birdBuf[k * 4] = fx + bd.ox;
            birdBuf[k * 4 + 1] = fy + bd.oy;
            birdBuf[k * 4 + 2] = Math.sin(t * bd.fr + bd.ph) > 0 ? 1 : -1;
            birdBuf[k * 4 + 3] = 1;
            k++;
          }
        }
      }
    }

    function layout() {
      W = Math.max(320, Math.round(header.clientWidth));
      H = Math.max(360, Math.round(header.clientHeight));
      /* Recomposition keys on the SHAPE of the frame, not on a width
         breakpoint, so a laptop window dragged narrow and a phone held
         upright each get the framing their proportions actually need,
         and every parameter below crossfades rather than switching. */
      port = smoothstep(1.05, 0.62, W / H);

      /* The backing store is PHYSICAL pixels, the CSS box stays CSS
         pixels. This one distinction is what the header was missing. */
      PW = Math.max(1, Math.round(W * renderScale));
      PH = Math.max(1, Math.round(H * renderScale));
      canvas.width = PW;
      canvas.height = PH;
      canvas.style.width = W + "px";
      canvas.style.height = H + "px";
      gl.viewport(0, 0, PW, PH);

      /* Portrait lifts the horizon. The reference sets its valley notch
         at about 0.56 of the frame and hands the whole lower half to the
         lit ground; at 0.635 a phone gets two thirds sky and a strip of
         floor under the text, which is the wrong way round for the one
         element that carries the picture. */
      horizon = 1 - (0.635 - 0.035 * port);
      gapX = 0.60 - 0.02 * port;
      /* The sun's ellipse is deliberately narrow at the horizon: it has
         to stay inside the notch across the whole cycle or the
         composition stops pointing at it. It is allowed to widen as the
         sun CLIMBS, because the channel opens with height too, and that
         width is what keeps the sun visibly travelling across the top of
         the arc instead of hanging at the apex where a plain sinusoid
         has no vertical speed left. */
      sunRx = 0.038;
      sunRxHi = 0.042;
      sunRy = 0.170 + 0.035 * port;
      /* Physical pixels throughout. The floor is a floor on the VISUAL
         size, so it scales with the backing store like everything else.
         0.030 of the height is 50 CSS px across on a phone, which is
         0.13 of the frame width and lands exactly on the reference's
         disc. The disc was never too small: it was half set and flat. */
      sunR = Math.max(15 * renderScale, PH * 0.030) / PH;

      /* Cells are physical pixel sizes taken from the PHYSICAL height,
         so a dot holds its visual size as the scale moves and simply
         gains resolution. Portrait coarsens the floor lattice only
         slightly: measured off the reference, its lattice is height/186
         at a 5.0 CSS px pitch, which is where this already sat. The
         field read as a sparse patch on a phone because it was being
         faded out toward the viewer, not because the dots were small. */
      cellF = Math.max(PH / (186 - 26 * port), 3.4 * renderScale);
      cellC = Math.max(PH / 226, 3.0 * renderScale);
      /* Edge softness held at a fixed number of PHYSICAL pixels. 0.16 of
         a cell was right at 1x, but cells grow with the scale, so left
         alone a 3x dot would come out exactly as soft as a 1x one and
         the extra resolution would buy nothing at all. */
      aaF = 0.16 / renderScale;
      aaC = 0.16 / renderScale;

      flocks.length = 0;
      nextFlock = 6;
    }

    function frame(t) {
      if (!ready()) return false;

      var theta = sunPhase(t);
      var elev = Math.sin(theta);
      var sx = gapX + (sunRx + sunRxHi * Math.max(elev, 0)) * Math.cos(theta);
      /* the dip below the horizon is compressed, so the disk only just
         sets and the horizon never loses its light */
      var sy = horizon + sunRy * (elev >= 0 ? elev : elev * 0.30);
      var warm = clamp01(0.34 + 0.66 * elev);

      updateFlocks(t);
      packBirds(t);

      gl.uniform2f(U.u_res, PW, PH);
      gl.uniform1f(U.u_time, t);
      gl.uniform2f(U.u_sun, sx, sy);
      gl.uniform1f(U.u_sunR, sunR);
      gl.uniform1f(U.u_warm, warm);
      gl.uniform1f(U.u_elev, elev);
      gl.uniform1f(U.u_hor, horizon);
      gl.uniform1f(U.u_gap, gapX);
      gl.uniform1f(U.u_cellF, cellF);
      gl.uniform1f(U.u_cellC, cellC);
      gl.uniform2f(U.u_aa, aaF, aaC);
      gl.uniform1f(U.u_port, port);
      gl.uniform4fv(U.u_birds, birdBuf);

      gl.drawArrays(gl.TRIANGLES, 0, 3);
      return true;
    }

    return {
      kind: "webgl",
      layout: layout,
      frame: frame,
      gl: gl,
      timerExt: timerExt
    };
  }

  /* ================================================================== *
   * RENDERER B: the v1 canvas-2D path, kept verbatim as the fallback
   * ================================================================== */

  function make2D() {
    var ctx = null;
    try { ctx = canvas.getContext("2d", { alpha: false }); } catch (e) { ctx = null; }
    if (!ctx) return null;

    function rgb(c) { return "rgb(" + c[0] + "," + c[1] + "," + c[2] + ")"; }
    function mix(a, b, t) {
      return [
        Math.round(a[0] + (b[0] - a[0]) * t),
        Math.round(a[1] + (b[1] - a[1]) * t),
        Math.round(a[2] + (b[2] - a[2]) * t)
      ];
    }

    var C_ACCENT = [231, 139, 52];
    var C_SAND = [254, 203, 153];
    var C_LIGHT = [255, 233, 187];

    var SKY_TOP = [20, 21, 23], SKY_HIGH = [26, 20, 25], SKY_MID = [46, 26, 27];
    var SKY_LOW_A = [104, 52, 26], SKY_LOW_B = [131, 66, 27];
    var SKY_HOR_A = [163, 84, 30], SKY_HOR_B = [199, 108, 36];
    var GROUND_HI = [30, 21, 18], GROUND_LO = [20, 21, 23];
    var MESA_FAR = [34, 26, 19], MESA_MID = [26, 21, 18], MESA_NEAR = [15, 12, 10];

    var FLOOR_RAMP = [
      rgb([106, 55, 25]), rgb(mix(C_ACCENT, [140, 74, 30], 0.45)), rgb(C_ACCENT),
      rgb(mix(C_ACCENT, C_SAND, 0.55)), rgb(C_SAND), rgb(C_LIGHT)
    ];
    var CLOUD_RAMP = [
      "rgba(196,124,72,0.26)", "rgba(222,152,92,0.32)", "rgba(240,180,122,0.38)",
      "rgba(254,203,153,0.44)", "rgba(255,222,176,0.50)", "rgba(255,236,198,0.56)"
    ];
    var BIRD_COLOR = "rgba(24,17,13,0.92)";

    var NS = 128, NMASK = 127;
    var nlut = new Float32Array(NS * NS);
    (function () {
      var r = mulberry32(0x51ed270b);
      for (var i = 0; i < NS * NS; i++) nlut[i] = r();
    })();

    function noise2(x, y) {
      var xi = Math.floor(x), yi = Math.floor(y);
      var fx = x - xi, fy = y - yi;
      fx = fx * fx * (3 - 2 * fx);
      fy = fy * fy * (3 - 2 * fy);
      var x0 = xi & NMASK, x1 = (xi + 1) & NMASK;
      var y0 = (yi & NMASK) << 7, y1 = ((yi + 1) & NMASK) << 7;
      var a = nlut[y0 + x0], b = nlut[y0 + x1];
      var c = nlut[y1 + x0], d = nlut[y1 + x1];
      var top = a + (b - a) * fx, bot = c + (d - c) * fx;
      return top + (bot - top) * fy;
    }

    var RB = 8;
    var buckets = new Array(RB * 8);
    var bucketRadius = new Float32Array(RB);

    function bucketsReset(cell, k) {
      for (var i = 0; i < RB * 8; i++) buckets[i] = null;
      for (var r = 0; r < RB; r++) bucketRadius[r] = ((r + 0.5) / RB) * cell * k;
    }
    function bucketAdd(level, x, y, nc) {
      var ri = (level * RB) | 0; if (ri > RB - 1) ri = RB - 1;
      var ci = (level * nc) | 0; if (ci > nc - 1) ci = nc - 1;
      var key = ri * 8 + ci;
      var p = buckets[key];
      if (!p) { p = buckets[key] = new Path2D(); }
      var rad = bucketRadius[ri];
      p.moveTo(x + rad, y);
      p.arc(x, y, rad, 0, TAU);
    }
    function bucketsFlush(colors) {
      var nc = colors.length;
      for (var ri = 0; ri < RB; ri++) {
        for (var ci = 0; ci < nc; ci++) {
          var p = buckets[ri * 8 + ci];
          if (!p) continue;
          ctx.fillStyle = colors[ci];
          ctx.fill(p);
        }
      }
    }

    var W = 0, H = 0, mobile = false, s2 = 1;
    var horizonY = 0, floorH = 0, gapX = 0;
    var sunRx = 0, sunRy = 0, sunR = 0;
    var cellA = 4.5, cellC = 5.5, cloudTop = 0;
    var colsA = 0, rowsA = 0, jitA = null;
    var colsC = 0, rowsC = 0, jitC = null, colGlow = null;
    var NBAND = 3;
    var bandY = new Float32Array(3), bandSig = new Float32Array(3);
    var bandWF = new Float32Array(3), bandSp = new Float32Array(3);
    var bandNow = new Float32Array(3), bandDx = new Float32Array(3);
    var BIRD_CELLS = [-2, 1, -1, 0, 0, 0, 1, 0, 2, 1];
    var stars = [];
    var layerFar = null, layerMid = null, layerNear = null;
    var flocks = [], nextFlock = 6;

    function buildSkyline(seed, o) {
      var rnd = mulberry32(seed);
      var blocks = [];
      var x = -0.30 * W, end = 1.30 * W, guard = 0;
      while (x < end && guard++ < 260) {
        var w = (o.wMin + rnd() * (o.wMax - o.wMin)) * W;
        var left = x, right = x + w;
        if (o.gapHalf > 0 && right > gapX - o.gapHalf && left < gapX + o.gapHalf) {
          if (left < gapX - o.gapHalf) {
            right = gapX - o.gapHalf; w = right - left;
            if (w < 0.05 * W) { x = gapX + o.gapHalf; continue; }
          } else { x = gapX + o.gapHalf; continue; }
        }
        var mid = (left + right) * 0.5;
        var near = o.frame ? 1 - Math.min(1, Math.abs(mid - gapX) / (W * 0.42)) : 0;
        var hgt = (o.hMin + rnd() * (o.hMax - o.hMin)) * (1 + near * 0.46);
        blocks.push({
          l: left, r: right, top: o.baseY - hgt * o.hRef,
          foot: (rnd() - 0.5) * o.footJit * H,
          slope: (o.slopeMin + rnd() * o.slopeSpan) * w,
          tierAt: 0.26 + rnd() * 0.46,
          tierDy: (0.008 + rnd() * 0.026) * H,
          tierSide: rnd() < 0.5 ? -1 : 1
        });
        x = left + w * (0.30 + rnd() * 0.44);
      }
      return { blocks: blocks, baseY: o.baseY, amp: o.amp, period: o.period, phase: o.phase };
    }

    function skylinePath(layer, dx, dy) {
      var p = new Path2D();
      var bs = layer.blocks;
      for (var i = 0; i < bs.length; i++) {
        var b = bs[i];
        var l = b.l + dx, r = b.r + dx;
        if (r < -40 || l > W + 40) continue;
        var base = layer.baseY + b.foot + dy;
        var t = b.top + dy, t2 = t + b.tierDy;
        var tx = l + (r - l) * b.tierAt;
        p.moveTo(l - b.slope, base);
        if (b.tierSide < 0) {
          p.lineTo(l, t2); p.lineTo(tx, t2); p.lineTo(tx, t); p.lineTo(r, t);
        } else {
          p.lineTo(l, t); p.lineTo(tx, t); p.lineTo(tx, t2); p.lineTo(r, t2);
        }
        p.lineTo(r + b.slope, base);
        p.closePath();
      }
      return p;
    }

    function layout() {
      W = Math.max(320, Math.round(header.clientWidth));
      H = Math.max(360, Math.round(header.clientHeight));
      mobile = W <= 809;
      /* This path draws in CSS pixels from end to end, so the backing
         store is enlarged and the CONTEXT is scaled, and not one
         coordinate below has to change to gain the resolution. Capped at
         2: it is already the fallback, and it lays its dots down one at
         a time on the CPU rather than in a shader. */
      s2 = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(W * s2); canvas.height = Math.round(H * s2);
      canvas.style.width = W + "px"; canvas.style.height = H + "px";
      ctx.setTransform(s2, 0, 0, s2, 0, 0);
      horizonY = Math.round(H * 0.635);
      floorH = H - horizonY;
      gapX = W * 0.5;
      sunRx = H * 0.115; sunRy = H * 0.190;
      sunR = Math.max(14, H * 0.032);
      cellA = mobile ? 6.0 : 4.8;
      cellC = mobile ? 6.5 : 5.5;
      cloudTop = Math.round(H * 0.06);
      colsA = Math.ceil(W / cellA);
      rowsA = Math.ceil((horizonY - cloudTop) / cellA);
      NBAND = mobile ? 2 : 3;
      for (var bd = 0; bd < NBAND; bd++) {
        bandY[bd] = horizonY * (0.25 + bd * (mobile ? 0.26 : 0.175));
        bandSig[bd] = H * ((mobile ? 0.044 : 0.031) - bd * 0.005);
        bandWF[bd] = 0.045 + bd * 0.021;
        bandSp[bd] = 5.5 + bd * 4.5;
      }
      var rj = mulberry32(0x1f3a55);
      jitA = new Float32Array(colsA * rowsA);
      for (var i = 0; i < jitA.length; i++) jitA[i] = (rj() - 0.5) * 0.066;
      colsC = Math.ceil(W / cellC);
      rowsC = Math.ceil(Math.min(floorH, H * 0.925 - horizonY) / cellC);
      jitC = new Float32Array(colsC * rowsC);
      for (var j = 0; j < jitC.length; j++) jitC[j] = (rj() - 0.5) * 0.16;
      colGlow = new Float32Array(colsC);
      for (var c = 0; c < colsC; c++) {
        var gx = ((c + 0.5) * cellC - gapX) / (W * 0.42);
        colGlow[c] = Math.exp(-gx * gx);
      }
      var rs = mulberry32(0x7ac3e1);
      stars.length = 0;
      var starCount = mobile ? 210 : 420;
      for (var s = 0; s < starCount; s++) {
        var lay = s % 3;
        stars.push({
          x: rs() * W, y: rs() * horizonY * 0.86,
          size: lay === 2 ? 2 : 1, mag: 0.40 + rs() * 0.60,
          sp: [1.1, 2.0, 3.4][lay], ph: rs() * TAU
        });
      }
      var hRef = Math.min(H, W * 1.25);
      layerFar = buildSkyline(0x3311a7, {
        hRef: hRef, baseY: horizonY + H * 0.010, wMin: 0.07, wMax: 0.17,
        hMin: 0.016, hMax: 0.120, footJit: 0.028, frame: true,
        slopeMin: 0.020, slopeSpan: 0.090, gapHalf: W * 0.125,
        amp: W * 0.028, period: 58, phase: 0.0
      });
      layerMid = buildSkyline(0x9c47b2, {
        hRef: hRef, baseY: horizonY + H * 0.030, wMin: 0.11, wMax: 0.25,
        hMin: 0.010, hMax: 0.155, footJit: 0.048, frame: true,
        slopeMin: 0.018, slopeSpan: 0.085, gapHalf: W * 0.170,
        amp: W * 0.055, period: 46, phase: 1.9
      });
      layerNear = buildSkyline(0x64f0d3, {
        hRef: H, baseY: H + H * 0.10, wMin: 0.22, wMax: 0.46,
        hMin: 0.185, hMax: 0.225, footJit: 0, frame: false,
        slopeMin: 0.240, slopeSpan: 0.300, gapHalf: 0,
        amp: W * 0.085, period: 38, phase: 3.4
      });
      layerNear.rimY = H * 0.925;
      flocks.length = 0; nextFlock = 6;
    }

    var flockRnd = mulberry32(0xb17e42);

    function updateFlocks(t) {
      if (t > nextFlock && flocks.length < 2) {
        nextFlock = t + 9 + flockRnd() * 7;
        var dir = flockRnd() < 0.5 ? 1 : -1;
        var n = 3 + ((flockRnd() * 5) | 0);
        var y0 = H * (0.26 + flockRnd() * 0.22);
        var speed = W * (0.028 + flockRnd() * 0.034) * dir;
        var birds = [];
        for (var i = 0; i < n; i++) {
          birds.push({
            ox: -i * (W * 0.017) * dir - flockRnd() * W * 0.012 * dir,
            oy: (flockRnd() - 0.5) * H * 0.035,
            ph: flockRnd() * TAU, fr: 3.0 + flockRnd() * 1.8
          });
        }
        flocks.push({
          x: dir > 0 ? -W * 0.10 : W * 1.10, y: y0, vx: speed,
          wob: flockRnd() * TAU, birds: birds, t0: t
        });
      }
      for (var f = flocks.length - 1; f >= 0; f--) {
        var fl = flocks[f];
        var x = fl.x + fl.vx * (t - fl.t0);
        if (x < -W * 0.22 || x > W * 1.22) flocks.splice(f, 1);
      }
    }

    function drawSky(w) {
      var g = ctx.createLinearGradient(0, 0, 0, horizonY);
      g.addColorStop(0.00, rgb(SKY_TOP));
      g.addColorStop(0.40, rgb(SKY_HIGH));
      g.addColorStop(0.66, rgb(mix(SKY_MID, [54, 30, 28], w)));
      g.addColorStop(0.86, rgb(mix(SKY_LOW_A, SKY_LOW_B, w)));
      g.addColorStop(1.00, rgb(mix(SKY_HOR_A, SKY_HOR_B, w)));
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, horizonY);
      var hor = mix(SKY_HOR_A, SKY_HOR_B, w);
      var gg = ctx.createLinearGradient(0, horizonY, 0, H);
      gg.addColorStop(0.00, rgb(mix(hor, GROUND_HI, 0.52)));
      gg.addColorStop(0.13, rgb(mix(hor, GROUND_HI, 0.88)));
      gg.addColorStop(0.55, rgb(mix(GROUND_HI, GROUND_LO, 0.7)));
      gg.addColorStop(1.00, rgb(GROUND_LO));
      ctx.fillStyle = gg;
      ctx.fillRect(0, horizonY, W, floorH);
    }

    function drawSun(sunX, sunY, w, reveal) {
      var lift = 0.55 + 0.45 * w;
      ctx.globalCompositeOperation = "lighter";
      var bloomR = H * 0.62;
      var b = ctx.createRadialGradient(sunX, horizonY, 0, sunX, horizonY, bloomR);
      b.addColorStop(0.00, "rgba(255,168,80," + (0.34 * lift * reveal).toFixed(3) + ")");
      b.addColorStop(0.30, "rgba(231,139,52," + (0.15 * lift * reveal).toFixed(3) + ")");
      b.addColorStop(0.66, "rgba(196,104,40," + (0.05 * lift * reveal).toFixed(3) + ")");
      b.addColorStop(1.00, "rgba(196,104,40,0)");
      ctx.fillStyle = b;
      ctx.fillRect(0, Math.max(0, horizonY - bloomR), W, Math.min(H, bloomR * 2));
      var haloR = sunR * 5.2;
      var h = ctx.createRadialGradient(sunX, sunY, 0, sunX, sunY, haloR);
      h.addColorStop(0.00, "rgba(255,224,160," + (0.42 * reveal).toFixed(3) + ")");
      h.addColorStop(0.28, "rgba(255,190,110," + (0.20 * reveal).toFixed(3) + ")");
      h.addColorStop(1.00, "rgba(231,139,52,0)");
      ctx.fillStyle = h;
      ctx.fillRect(sunX - haloR, sunY - haloR, haloR * 2, haloR * 2);
      ctx.save();
      ctx.beginPath(); ctx.rect(0, 0, W, horizonY); ctx.clip();
      var d = ctx.createRadialGradient(sunX, sunY, 0, sunX, sunY, sunR * 1.7);
      d.addColorStop(0.00, "rgba(255,240,208," + reveal.toFixed(3) + ")");
      d.addColorStop(0.46, "rgba(255,226,170," + (0.92 * reveal).toFixed(3) + ")");
      d.addColorStop(0.66, "rgba(255,186,104," + (0.55 * reveal).toFixed(3) + ")");
      d.addColorStop(1.00, "rgba(231,139,52,0)");
      ctx.fillStyle = d;
      ctx.beginPath(); ctx.arc(sunX, sunY, sunR * 1.7, 0, TAU); ctx.fill();
      ctx.restore();
      ctx.globalCompositeOperation = "source-over";
    }

    function drawStars(t, elev, reveal) {
      var global = (0.42 + 0.58 * (1 - clamp01(elev))) * reveal;
      if (global < 0.02) return;
      ctx.globalCompositeOperation = "lighter";
      var pathsW = [null, null, null, null], pathsC = [null, null, null, null];
      for (var i = 0; i < stars.length; i++) {
        var s = stars[i];
        var x = s.x + t * s.sp; x = x % W; if (x < 0) x += W;
        var y = s.y;
        var fade = smoothstep(horizonY * 0.90, horizonY * 0.10, y);
        var tw = 0.62 + 0.38 * Math.sin(t * 2.5 + s.ph);
        var a = s.mag * fade * tw * global;
        if (a < 0.05) continue;
        var bi = (a * 4) | 0; if (bi > 3) bi = 3;
        var arr = (i % 4) === 0 ? pathsW : pathsC;
        var p = arr[bi]; if (!p) p = arr[bi] = new Path2D();
        p.rect(x, y, s.size, s.size);
      }
      for (var b = 0; b < 4; b++) {
        var al = ((b + 0.5) / 4).toFixed(2);
        if (pathsC[b]) { ctx.fillStyle = "rgba(255,255,255," + al + ")"; ctx.fill(pathsC[b]); }
        if (pathsW[b]) { ctx.fillStyle = "rgba(255,233,187," + al + ")"; ctx.fill(pathsW[b]); }
      }
      ctx.globalCompositeOperation = "source-over";
    }

    function drawCloudField(t, sunX, warm, reveal) {
      bucketsReset(cellA, 0.395);
      var half = cellA * 0.5;
      var sunNear = 1 / (W * 0.34);
      var A1 = 1 / Math.max(W * 0.096, 116);
      var A2 = 1 / Math.max(W * 0.040, 50);
      var CUT = mobile ? 0.500 : 0.545;
      var VY = 3.4, b, i;
      for (b = 0; b < NBAND; b++) {
        bandNow[b] = bandY[b] + Math.sin(t * bandWF[b] + b * 2.1) * H * 0.010;
        bandDx[b] = t * bandSp[b];
      }
      for (var cy = 0; cy < rowsA; cy++) {
        var py = cloudTop + cy * cellA + half;
        var bm = 0, bi = 0;
        for (b = 0; b < NBAND; b++) {
          var q = (py - bandNow[b]) / bandSig[b];
          var e = Math.exp(-q * q);
          if (e > bm) { bm = e; bi = b; }
        }
        bm *= smoothstep(horizonY, horizonY - H * 0.055, py);
        if (bm < 0.07) continue;
        var dx1 = bandDx[bi] * A1, dx2 = bandDx[bi] * A2 * 0.72;
        var y1 = py * A1 * VY + bi * 13.7, y2 = py * A2 * VY + bi * 29.3 + 41;
        var row = cy * colsA;
        for (var cx = 0; cx < colsA; cx++) {
          var px = cx * cellA + half;
          var n = 0.56 * noise2(px * A1 - dx1, y1) + 0.44 * noise2(px * A2 - dx2 + 57, y2);
          if (n < CUT) continue;
          var a = smoothstep(CUT, 0.90, n) * bm;
          if (a < 0.025) continue;
          var lvl = Math.pow(smoothstep(0.025, 0.50, a), 0.70);
          if (lvl <= 0) continue;
          var d = (px - sunX) * sunNear;
          lvl *= 0.58 + 0.56 * Math.exp(-d * d) + 0.16 * warm;
          lvl += jitA[row + cx] * lvl;
          lvl *= reveal;
          if (lvl < 0.055) continue;
          if (lvl > 1) lvl = 1;
          bucketAdd(lvl, px, py, 6);
        }
      }
      bucketsFlush(CLOUD_RAMP);
      if (reduceQ.matches || !flocks.length) return;
      var birdPath = null, birdR = cellA * 0.40;
      for (i = 0; i < flocks.length; i++) {
        var fl = flocks[i];
        var fx = fl.x + fl.vx * (t - fl.t0);
        var fy = fl.y + Math.sin(t * 0.24 + fl.wob) * H * 0.012;
        for (var k = 0; k < fl.birds.length; k++) {
          var bd = fl.birds[k];
          var ci = Math.round((fx + bd.ox - half) / cellA);
          var ri = Math.round((fy + bd.oy - cloudTop - half) / cellA);
          if (ci < -3 || ci > colsA + 3 || ri < 1 || ri > rowsA - 2) continue;
          var up = Math.sin(t * bd.fr + bd.ph) > 0 ? -1 : 1;
          for (var s = 0; s < 5; s++) {
            var ox = BIRD_CELLS[s * 2], oy = BIRD_CELLS[s * 2 + 1] * up;
            var bx = (ci + ox) * cellA + half;
            var by = cloudTop + (ri + oy) * cellA + half;
            if (!birdPath) birdPath = new Path2D();
            birdPath.moveTo(bx + birdR, by);
            birdPath.arc(bx, by, birdR, 0, TAU);
          }
        }
      }
      if (birdPath) { ctx.fillStyle = BIRD_COLOR; ctx.fill(birdPath); }
    }

    function drawFloorField(t, warm, reveal) {
      bucketsReset(cellC, 0.50);
      var A = 1 / 30, FLAT = 1.62;
      var sunLightF = 0.64 + 0.40 * warm;
      var half = cellC * 0.5, invFloor = 1 / floorH;
      var A2 = A * 2.25, A3 = A * 0.55;
      var t1 = t * 1.25, t2 = t * 2.30, t3 = t * 0.46, tx2 = t * 0.38;
      for (var cy = 0; cy < rowsC; cy++) {
        var py = horizonY + cy * cellC + half;
        var v = (py - horizonY) * invFloor; if (v > 1) v = 1;
        var vmask = (0.32 + 0.68 * Math.pow(1 - v, 1.25)) * smoothstep(0, 0.016, v);
        var y1 = py * A * FLAT - t1, y2 = py * A2 * FLAT - t2 + 17, y3 = py * A3 * FLAT - t3 + 71;
        var row = cy * colsC;
        for (var cx = 0; cx < colsC; cx++) {
          var px = cx * cellC + half;
          var I = 0.36 * noise2(px * A, y1) + 0.30 * noise2(px * A2 + tx2 + 37, y2) +
            0.34 * noise2(px * A3 + 91, y3);
          var lvl = (I - 0.22) * 1.58;
          if (lvl < 0) lvl = 0; else if (lvl > 1) lvl = 1;
          lvl = lvl * lvl * (3 - 2 * lvl);
          lvl = (0.24 + 0.76 * lvl) * vmask * (0.13 + 0.87 * colGlow[cx]) * sunLightF;
          lvl += jitC[row + cx] * lvl;
          lvl *= reveal;
          if (lvl < 0.055) continue;
          if (lvl > 1) lvl = 1;
          bucketAdd(lvl, px, py, 6);
        }
      }
      bucketsFlush(FLOOR_RAMP);
    }

    function meander(layer, t) {
      return Math.sin((t / layer.period) * TAU + layer.phase) * layer.amp;
    }

    function drawMesas(t, sunX, w, reveal) {
      var rise = (1 - reveal) * H * 0.03;
      var far = skylinePath(layerFar, meander(layerFar, t), rise * 0.4);
      ctx.fillStyle = rgb(mix(MESA_FAR, mix(SKY_HOR_A, SKY_HOR_B, w), 0.13));
      ctx.fill(far);
      var mid = skylinePath(layerMid, meander(layerMid, t), rise * 0.7);
      if (w > 0.02) {
        var rg = ctx.createLinearGradient(sunX - W * 0.42, 0, sunX + W * 0.42, 0);
        var ra = (0.18 * w * reveal).toFixed(3);
        rg.addColorStop(0.00, "rgba(255,196,132,0)");
        rg.addColorStop(0.50, "rgba(255,208,150," + ra + ")");
        rg.addColorStop(1.00, "rgba(255,196,132,0)");
        ctx.save(); ctx.translate(0, -1.2);
        ctx.fillStyle = rg; ctx.fill(mid); ctx.restore();
      }
      ctx.fillStyle = rgb(mix(MESA_MID, mix(SKY_LOW_A, SKY_LOW_B, w), 0.05));
      ctx.fill(mid);
      var bob = Math.sin(t * 0.232) * H * 0.004;
      var ndx = meander(layerNear, t);
      ctx.fillStyle = rgb(MESA_NEAR);
      ctx.fillRect(0, layerNear.rimY + bob + rise, W, H - layerNear.rimY + H * 0.1);
      var near = skylinePath(layerNear, ndx, bob + rise);
      ctx.fill(near);
    }

    /* The poster holds the frame until the canvas is lit, so this path
       also draws the finished scene from its very first frame. */
    function frame(t) {
      var theta = sunPhase(t);
      var elev = Math.sin(theta);
      var sunX = W * 0.5 + sunRx * Math.cos(theta);
      var sunY = horizonY - sunRy * (elev >= 0 ? elev : elev * 0.30);
      var warm = clamp01(0.34 + 0.66 * elev);
      updateFlocks(t);
      drawSky(warm);
      drawSun(sunX, sunY, warm, 1);
      drawStars(t, elev, 1);
      drawCloudField(t, sunX, warm, 1);
      drawFloorField(t, warm, 1);
      drawMesas(t, sunX, warm, 1);
      return true;
    }

    return { kind: "2d", layout: layout, frame: frame };
  }

  /* ================================================================== *
   * Pick a renderer. WebGL first, the v1 2D path if it is unavailable.
   * ================================================================== */

  /* A canvas element carries ONE kind of context for its whole life.
     Once webgl has been taken on it, asking the same element for 2d
     returns null for ever, so a webgl path that gives up has to hand the
     fallback a FRESH element. Without this the chain silently ends at
     the poster on any device where webgl is present but unusable, which
     is the single hardest failure to diagnose from a phone: the page
     looks alive, and shows one still frame for ever. */
  function freshCanvas() {
    var n = canvas.cloneNode(false);
    n.classList.remove("is-lit");
    canvas.parentNode.replaceChild(n, canvas);
    canvas = n;
  }

  var R = null;
  try { R = makeGL(); } catch (e) { R = null; note("webgl threw: " + e); }
  if (!R) {
    freshCanvas();
    try { R = make2D(); } catch (e2) { R = null; }
    if (R) note("2d fallback selected");
  }
  if (!R) { note("no renderer available, poster holds the header"); return; }

  /* ------------------------------------------------------------------ *
   * Frame loop. 30fps accumulator with the 4ms slack, paused offscreen.
   * ------------------------------------------------------------------ */

  var stats = {
    frames: 0, sum: 0, last: 0, avg: 0, maxMs: 0,
    gapMax: 0, longFrames: 0, running: false,
    renderer: R.kind, gpuMs: 0, firstFrameMs: 0,
    scale: renderScale, dpr: window.devicePixelRatio || 1
  };
  window.__canyon = stats;
  window.__canyonStats = stats;

  /* ------------------------------------------------------------------ *
   * Adaptive render scale
   *
   * Resolution is the right thing to give up first here. This picture is
   * gradients, a dot lattice and one bright disc, none of which lives or
   * dies on the last device pixel, whereas a header running at 18fps is
   * obvious to anybody. So the scale comes down and the cadence holds.
   *
   * It only ever comes DOWN, and only on a sustained overrun: one slow
   * frame is a garbage collection or a scroll, not a verdict on the GPU.
   * ------------------------------------------------------------------ */

  /* Two measures, because on this workload neither one alone is honest.
     The CPU number is the time to SUBMIT a frame, and submitting one
     fullscreen triangle is nearly free however hard the shader is
     working, so a GPU bound device shows a flattering 1ms. The paint gap
     is what the eye actually gets. A healthy scene paints every other
     vsync at 60Hz, so about 33ms; sustained gaps past 46ms mean the
     device is not making the cadence and the scale has to come down. */
  var GOV_BUDGET = 22;               /* ms of draw against a 33ms cadence */
  var GOV_GAP = 46;                  /* ms between paints, ~21fps */
  var govN = 0, govSum = 0, govGap = 0, govStrikes = 0, govLocked = false;

  function govern(dt, gap) {
    if (govLocked || stats.frames < 20) return;
    govN++; govSum += dt; govGap += gap;
    if (govN < 30) return;
    var avg = govSum / govN;
    var avgGap = govGap / govN;
    govN = 0; govSum = 0; govGap = 0;
    if (avg <= GOV_BUDGET && avgGap <= GOV_GAP) { govStrikes = 0; return; }
    if (++govStrikes < 2) return;
    govStrikes = 0;
    var i = 0;
    while (i < SCALE_STEPS.length - 1 && SCALE_STEPS[i] >= renderScale) i++;
    if (SCALE_STEPS[i] >= renderScale) return;    /* already at the floor */
    renderScale = SCALE_STEPS[i];
    stats.scale = renderScale;
    note("draw " + avg.toFixed(1) + "ms, paint gap " + avgGap.toFixed(1) +
      "ms, render scale -> " + renderScale + "x");
    R.layout();
  }

  /* Debug affordance, same spirit as __canyonSeek: pin the scale so a
     measurement is not chasing the governor while it is being taken. */
  window.__canyonSetScale = function (s) {
    renderScale = s;
    govLocked = true;
    stats.scale = s;
    R.layout();
  };

  /* Debug affordance, same spirit as __canyonStats: jump the scene clock
     so a given moment of the cycle can be reproduced exactly. */
  window.__canyonSeek = function (t) {
    clockBase = performance.now() - t * 1000;
    pausedAt = 0;
  };

  /* Optional GPU timing probe. One query in flight, read when ready, so
     the cost of measuring never shows up in the thing being measured. */
  var tq = null, tqActive = null, tqSum = 0, tqN = 0;
  if (R.kind === "webgl" && R.timerExt) {
    tq = R.timerExt;
  }

  function gpuBegin() {
    if (!tq || tqActive) return null;
    var q = tq.createQueryEXT();
    tq.beginQueryEXT(tq.TIME_ELAPSED_EXT, q);
    return q;
  }
  function gpuEnd(q) {
    if (!tq || !q) return;
    tq.endQueryEXT(tq.TIME_ELAPSED_EXT);
    tqActive = q;
  }
  function gpuPoll() {
    if (!tq || !tqActive) return;
    var avail = tq.getQueryObjectEXT(tqActive, tq.QUERY_RESULT_AVAILABLE_EXT);
    var dis = R.gl.getParameter(tq.GPU_DISJOINT_EXT);
    if (avail && !dis) {
      var ns = tq.getQueryObjectEXT(tqActive, tq.QUERY_RESULT_EXT);
      tqSum += ns / 1e6; tqN++;
      stats.gpuMs = tqSum / tqN;
    }
    if (avail || dis) { tq.deleteQueryEXT(tqActive); tqActive = null; }
  }

  var STEP = 1000 / 30 - 4;
  var raf = 0, lastPaint = 0, clockBase = 0, pausedAt = 0;
  var visible = true, dead = false;

  function tick(now) {
    raf = window.requestAnimationFrame(tick);
    if (now - lastPaint < STEP) return;
    var gap = lastPaint ? now - lastPaint : 0;
    lastPaint = now;
    if (gap > 0) {
      if (gap > stats.gapMax) stats.gapMax = gap;
      if (gap > 53) stats.longFrames++;
    }

    var t = (now - clockBase) / 1000;

    gpuPoll();
    var q = gpuBegin();
    var m0 = performance.now();
    var drew = R.frame(t);
    var dt = performance.now() - m0;
    gpuEnd(q);

    /* The program never linked. This is only discovered here, on the
       first frame, because asking for link status any earlier forces the
       driver to finish compiling on the main thread and costs the cold
       start the stall this file goes out of its way to avoid.

       Stopping at this point is the worst outcome on the menu: the
       header keeps the poster for ever, and a still of this scene is
       indistinguishable from a live one that has frozen. So the 2D path
       takes over instead, on a fresh canvas. */
    if (drew === false) { stop(); recover(); return; }

    stats.frames++;
    stats.sum += dt;
    stats.last = dt;
    stats.avg = stats.sum / stats.frames;
    if (dt > stats.maxMs) stats.maxMs = dt;
    govern(dt, gap);
    if (stats.frames === 1) {
      stats.firstFrameMs = now;
      lit();
    }
  }

  function start() {
    if (raf || dead) return;
    stats.running = true;
    lastPaint = 0;
    raf = window.requestAnimationFrame(tick);
  }

  function stop() {
    if (!raf) return;
    window.cancelAnimationFrame(raf);
    raf = 0;
    stats.running = false;
  }

  /* Second chance, and only ever one. If the 2D path cannot start either
     then the poster genuinely is the best the device can do, and the
     header says so in the log rather than pretending. */
  var recovered = false;

  function recover() {
    if (recovered) { dead = true; return; }
    recovered = true;
    note("webgl program did not link, recovering on the 2d path");
    freshCanvas();
    var R2 = null;
    try { R2 = make2D(); } catch (e) { R2 = null; }
    if (!R2) {
      dead = true;
      note("no renderer available, poster holds the header");
      return;
    }
    R = R2;
    stats.renderer = R.kind;
    stats.scale = 1;
    R.layout();
    if (reduceQ.matches) {
      if (R.frame(POSTER_T) !== false) lit();
      return;
    }
    lastPaint = 0;
    start();
  }

  /* ------------------------------------------------------------------ *
   * Poster handover. The header paints a still of this exact scene from
   * CSS, with no JavaScript involved at all, so the first paint is the
   * finished picture. The canvas sits on top at opacity 0 and is faded
   * up only once a real frame has been presented, which is why the still
   * appears to come alive rather than being replaced.
   *
   * The scene clock starts at POSTER_T, the moment the still was taken,
   * so the first live frame lands on the same sun and the cross-fade has
   * nothing to jump between.
   * ------------------------------------------------------------------ */

  /* 11.0s puts the sun at elevation 0.50 and still CLIMBING: a whole
     disc with open sky under it, and low enough that the scene is still
     at golden hour rather than at a hazy midday. The old
     value of 60 landed, on the old 120s cycle, at exactly elevation 0:
     the sun sat half buried in the ground line at the one point in the
     cycle where the dwell warp also ran slowest, so every visit opened
     on a pale half dome that then sank for the next half minute. That is
     what "the sun sits in the ground not doing anything" was. Both
     posters are captured at this moment, so the handover still has
     nothing to jump between. */
  var POSTER_T = 11.0;
  var slowTimer = 0, slowEl = null;

  function lit() {
    if (canvas.classList.contains("is-lit")) return;
    /* one more frame, so the draw is actually on screen before the
       cross-fade starts */
    window.requestAnimationFrame(function () {
      canvas.classList.add("is-lit");
      header.classList.add("scene-live");
    });
    window.clearTimeout(slowTimer);
    if (slowEl && slowEl.parentNode) slowEl.parentNode.removeChild(slowEl);
    slowEl = null;
  }

  /* Only if the scene is genuinely late. Built here rather than in the
     markup so the normal path never pays for it, in bytes or in layout.

     Two gates, and both matter. The 1200ms one is measured from
     navigation, so a quick load never sees it. The 400ms floor is
     measured from now: if the script itself arrived late, the scene is
     usually a few frames behind it, and flashing a loading label for
     200ms would be worse than saying nothing. */
  function armSlowHint() {
    if (reduceQ.matches) return;
    var wait = Math.max(400, 1200 - (performance.now() - navStart()));
    slowTimer = window.setTimeout(function () {
      if (canvas.classList.contains("is-lit")) return;
      slowEl = document.createElement("div");
      slowEl.className = "scene-loading";
      slowEl.setAttribute("aria-hidden", "true");
      slowEl.innerHTML = "<i></i><span>LOADING SCENE</span>";
      header.appendChild(slowEl);
    }, wait);
  }

  function navStart() {
    try {
      var n = performance.getEntriesByType("navigation")[0];
      if (n) return n.startTime;
    } catch (e) { }
    return 0;
  }

  /* ------------------------------------------------------------------ *
   * Typed header text
   * ------------------------------------------------------------------ */

  /* If typing ever throws, drop the class the CSS uses to hold the text
     back, so the header still reads rather than staying blank. */
  function startTyping() {
    try {
      typing();
    } catch (e) {
      if (window.console) console.error(e);
      document.documentElement.classList.remove("js");
    }
  }

  function typing() {
    var nameEl = header.querySelector(".scene-name .tw");
    var tagEl = header.querySelector(".scene-tag .tw");
    var cueEl = header.querySelector(".scene-cue .tw");
    if (!nameEl || !tagEl) return;

    var nameText = nameEl.textContent;
    var tagText = tagEl.textContent;
    var cueText = cueEl ? cueEl.textContent : "";

    function caret(sel) {
      var lit = header.querySelectorAll(".has-caret");
      for (var i = 0; i < lit.length; i++) lit[i].classList.remove("has-caret");
      if (sel) sel.classList.add("has-caret");
    }

    if (reduceQ.matches) {
      header.classList.add("is-typed");
      caret(tagEl.parentNode);
      header.classList.add("no-blink");
      if (cueEl) cueEl.parentNode.parentNode.classList.add("is-in");
      return;
    }

    nameEl.textContent = "";
    tagEl.textContent = "";
    if (cueEl) cueEl.textContent = "";
    header.classList.add("is-typed");

    function type(el, text, speed, done) {
      caret(el.parentNode);
      var i = 0;
      (function step() {
        el.textContent = text.slice(0, ++i);
        if (i < text.length) window.setTimeout(step, speed);
        else if (done) window.setTimeout(done, 0);
      })();
    }

    window.setTimeout(function () {
      type(nameEl, nameText, 36, function () {
        window.setTimeout(function () {
          type(tagEl, tagText, 30, function () {
            caret(tagEl.parentNode);
            if (!cueEl) return;
            window.setTimeout(function () {
              cueEl.parentNode.parentNode.classList.add("is-in");
              type(cueEl, cueText, 58, function () { caret(tagEl.parentNode); });
            }, 420);
          });
        }, 300);
      });
    }, 400);
  }

  /* ------------------------------------------------------------------ *
   * Boot
   * ------------------------------------------------------------------ */

  var W0 = 0, H0 = 0;
  var resizeTimer = 0;
  window.addEventListener("resize", function () {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(function () {
      var w = Math.round(header.clientWidth);
      var h = Math.round(header.clientHeight);
      if (w === W0 && h === H0) return;
      W0 = w; H0 = h;
      /* A rotation can lower the cap, so never come out of a resize
         above it. It is not raised back: if the governor has already
         judged this device, that judgement stands. */
      if (!govLocked && renderScale > scaleCeiling()) {
        renderScale = scaleCeiling();
        stats.scale = renderScale;
      }
      R.layout();
      if (reduceQ.matches && R.frame(POSTER_T) !== false) lit();
    }, 140);
  });

  try {
    W0 = Math.round(header.clientWidth);
    H0 = Math.round(header.clientHeight);
    armSlowHint();

    if (reduceQ.matches) {
      /* Reduced motion gets one still, at the poster's own moment, so the
         handover is invisible and nothing ever moves. */
      R.layout();
      if (R.frame(POSTER_T) !== false) lit();
    } else {
      R.layout();
      clockBase = performance.now() - POSTER_T * 1000;

      if ("IntersectionObserver" in window) {
        var io = new IntersectionObserver(function (entries) {
          var on = entries[entries.length - 1].isIntersecting;
          if (on === visible) return;
          visible = on;
          if (on) {
            if (pausedAt) { clockBase += performance.now() - pausedAt; pausedAt = 0; }
            start();
          } else {
            pausedAt = performance.now();
            stop();
          }
        }, { rootMargin: "200px" });
        io.observe(header);
      }

      document.addEventListener("visibilitychange", function () {
        if (document.hidden) {
          if (!pausedAt) pausedAt = performance.now();
          stop();
        } else if (visible) {
          if (pausedAt) { clockBase += performance.now() - pausedAt; pausedAt = 0; }
          start();
        }
      });

      start();
    }
  } catch (err) {
    if (window.console) console.error(err);
    /* The poster still holds the header, so there is nothing to undo
       there. Only the text needs releasing. */
    window.clearTimeout(slowTimer);
    header.classList.add("is-typed");
  }
})();
