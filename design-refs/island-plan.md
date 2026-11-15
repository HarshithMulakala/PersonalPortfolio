# Hyperrealistic Island — Synthesized Build Plan (canonical)

This is the agreed architecture for the island overhaul, synthesized from two independent
technical plans. Every build round MUST follow this document. Rounds are sequential;
each has a ship gate verified in a live browser by the reviewer.

## Non-negotiable architecture

1. **Single source of truth: `TerrainField`.** One deterministic, seeded object generated
   at init (Web Worker if >200ms main-thread) owning: height grid, signed coast distance
   (SDF, + inland / − offshore), bathymetric depth, slope, curvature, baked horizon AO,
   moisture/exposure, splat weights (RGBA + remainder), world bounds, CPU samplers
   (collision, prop grounding, dock ranges) and GPU `DataTexture`s (height, SDF, splat)
   shared by terrain AND ocean shaders. The ocean's duplicated analytic `islandField()`
   GLSL must be deleted; any coast mismatch > 1 control texel is a release blocker.
   Master grid 321×249 over bounds x −96..96, z −40..108; fixed seed.
2. **Terrain material = `MeshStandardMaterial` + `onBeforeCompile`** (map / normal /
   roughness / ao chunks). Never a standalone ShaderMaterial. Top-TWO splat layer
   selection per fragment; hybrid projection (XZ planar for sand/grass/scrub, full
   triplanar only for cliff/scree); reoriented normal blending; ≤ 12 texture fetches
   high tier, ≤ 8 balanced, ≤ 2-4 mobile.
3. **Lighting: one sun, one truth.** Sun elevation ~18–22°, warm (#ffdfbd, intensity
   ~3.2), hemisphere 0.35–0.5, kill the standing opposing fill + rim lights (≤0.15
   combined residual). PCFSoftShadowMap, single stabilized ortho shadow camera
   (±~120 units, texel-snapped), 4096/2048/1024 by tier, bias ≈ −0.00025,
   normalBias ≈ 0.035–0.05. All key casters are static → render shadow map once,
   `shadowMap.autoUpdate=false`, manual invalidate on prop changes. PMREM (256 cube)
   from procedural sky → `scene.environment` (terrain 0.3–0.4, stone 0.45–0.6,
   wet sand ~0.85 relative); remove envMapIntensity=0 from dressModel. Baked terrain
   horizon AO (8–16 dirs, radii 1..28u, indirect-only, floor at ~62% light). Bloom
   subtle (strength ≤0.16, threshold ≥1.05) high tier only. No SSR/DoF/grain/CA.
4. **Quality tiers: high / balanced / mobile** (not binary). Terrain grid 321×249 /
   257×193 / 193×145; DPR 1.5/1.25/1.0; shadow 4096/2048/1024; runtime downgrade
   ladder: DPR → bloom → vegetation counts/distance → veg shadows → tier. Measure p90
   frame time over 120 frames; downgrade if >20ms sustained; never auto-upgrade.
   `?quality=` override + localStorage persistence. Never regenerate morphology on
   tier change.

## Morphology spec (Round 1)

- Authored coastline first, noise second: rotated ellipse rx≈79 rz≈59 → domain warp
  (3-oct fBm, freq 0.011, lac 2.03, gain 0.5, amp x7/z5.5, warp faded to ~45% within
  8u of each dock) → angular features: main crescent bay at Origins/SW approach
  (half-width ~0.34 rad, inset 11–13u, flanked by two outward headlands 5–8u),
  smaller 2.5–4u coves at Forge/Voyages/Oracle, Labors kept as a rocky north landing.
  Coast mix target ≈ 30% beach / 45% rocky shore / 25% cliff+headland — NO continuous
  sand ring. ≥7u navigable water at every dock.
- Elevation: submerged shelf (outer −10.5, beach toe −0.25), asymmetric base rise
  18·pow(coastDist/55, 0.72) with mass shifted ~6u N / 4u W, directional ridge spine
  (ridged fBm in −18°-rotated coords, 5 oct, freq 0.017, lac 2.08, gain ~0.48,
  ridge = pow(1−|n|, 2.2), masked to an elongated ~105×38u band), secondary 4-oct fBm
  (freq 0.032, amp 3.2) with subtracted drainage channels, micro-relief ≤0.28u
  (finer detail belongs to normal maps). Summit (Labors acropolis) 27–33u; Oracle
  headland 4–7u lower.
- Erosion at init (deterministic, worker): hydraulic ~45k droplets (lifetime 40,
  inertia 0.2, capacity 4.0, deposit 0.30, erode 0.28, evap 0.025, radius 3 cells;
  protect y<0.6, cliff cells, pad cores; fade to 25% in pad blend zones) + thermal
  10–18 passes (talus ~32°, transfer 0.22, stronger 0.32 below cliffs for scree
  aprons; protect beaches). Budget ≤250ms desktop / ≤650ms mobile; else drop to
  18k droplets. Once shape is approved, SERIALIZE the baked field to a committed
  asset and load it (removes runtime cost + cross-browser drift).
- Cliffs: logistic 8–12u step over 3–5u on exposed W/N headlands (48–68° faces,
  1.2–2u strata banding) + one extruded cliff-band mesh along >45° coast contours
  (2–4 vertical rows, 8–14k tris, ≤2 draws, shares cliff material, recessed to hide
  seams, no overhang >1.5u).
- Landmark pads (stamped AFTER erosion, 3–5u blend rings, ±0.08u inside footprints,
  keep 1–3° natural grade): Labors 10.5u, Voyages 7u + graded dock path, Oracle 6.5u,
  Origins 5.5u, Forge 5u. All five docks, beat anchors, camera framings preserved.

## Materials spec (Round 2)

Five layers: beach sand / dry grass–soil / scrub / limestone cliff / scree.
Real CC0 textures live in assets/textures/terrain/ (downloaded by the orchestrator;
see SOURCES.md there). Per layer: albedo (sRGB) + packed NRA (normal XY, roughness,
AO). 1K for ground layers, 2K only for cliff. Tile scales: sand 4.5–6m, dry 3–4m,
scrub 4–5m, limestone 5–7m, scree 2–3m. Splat masks from TerrainField (see plans:
slope/height/curvature/shelter rules), boundaries broken by 2-scale fBm (0.035/0.17
freq) + second rotated (33°, 0.47×) sample at 10–18% to kill tiling. Macro variation
restrained: cavity ≤10–18% on indirect only, hue ±3–4°, value ±6%. If a texture set
is missing, procedural worker-generated fallback per the plans (512–1024²).

## Shoreline spec (Round 3)

Ocean samples TerrainField textures (shared world→uv transform). Wet band: −0.15..
+0.55u + ragged 0–0.8u run-up, albedo ×0.62–0.72, roughness →0.38–0.5, animated
wetline ±0.15u. Seabed visibility through opaque ocean: Beer–Lambert
exp(−depth·vec3(≈0.18–0.32, 0.075–0.12, 0.035–0.055)), visible to ~5–6u, scaled by
1−Fresnel, small normal-driven refraction offset (≤0.006 UV), faint caustics <2.5u.
Foam from SDF+depth: breaker at 0.25–1.6u depth, weak second remnant, 2 noise scales
(0.7–2.5u, 3.5–8u), opacity cap 0.55, −35% in sheltered bay, +25% on exposed cliffs,
two slow travelling fronts (~7.5s/11s). Extend seabed terrain to −10.5u (sand in bays,
rock at headlands).

## Vegetation & rocks spec (Round 5)

Mass vegetation = instanced 3-crossed-plane impostors, alphaTest ≈0.42–0.45,
depthWrite on, normal maps, wind sway top 65% only, per-instance hue/height/lean/
frame variation. Textures: bake/paint into atlases (2K high / 1K low). Counts (high):
~55–120 cypress, 85–170 olive, 450–900 scrub, 900–1800 grass tufts (near-field only),
6–9 draws total. Rocks: 4–8 seeded displaced limestone variants (500–1500 tris),
InstancedMesh (≤8 draws), 120–180 high, bury 18–38%, partial normal alignment,
concentrate below cliffs/headlands. Poisson-disc placement from TerrainField masks,
exclusion: 4–8u around docks/paths/beat anchors/camera sightlines (spawn→temple cone
stays clear). 12–24 hero trees (3–8k tris) only near docked-tour cameras.

## Landmarks spec (Round 6)

Keep silhouettes/anchors/docks. Merge primitives: temple 42→≤4 draws, lighthouse
20→≤6, ruins 14→≤2. Shared limestone PBR (triplanar 4–6m), baked grime/cavity, edge
bevels, foundation skirts 0.15–0.3u + debris/contact darkening, remove blanket pale
overrides + stone emissives (keep beacon/flame emissives). Readability via silhouette
and composition, not uniform brightness.

## Budgets (high tier)

≤500k visible tris, ≤90 draws (ceiling 110), terrain shader ≤3.5ms GPU, ≤96MB texture
memory, p95 GPU ≤18ms @1440×900 on M-series; mobile ≥30fps. Asset payload added to
repo ≤15MB preferred, 25MB ceiling.

## Round order & gates

R1 TerrainField + morphology + erosion + cliff band + pads + ocean SDF hookup
   (keep current color material). Gate: island reads as real landform in clay;
   all 5 docks reachable; collision/props/tours intact; coast==foam==collision.
R2 PBR splat material + baked AO. Gate: no tiling at spawn cam, no stretching at
   dock cams, shader ≤ budget, Safari+Chromium compile.
R3 Shoreline integration. Gate: wet band, seabed fade, coast-exact foam, no seams.
R4 Lighting/shadows/PMREM/bloom retune. Gate: readable relief, no acne/peter-pan,
   temple+lighthouse readable from spawn.
R5 Vegetation + rocks. Gate: no halos/repeats, draws in budget, sightlines clear.
R6 Landmark re-dress + merge. Gate: landmarks pass side-by-side vs terrain.
R7 Tiers + degradation + final perf/screenshot matrix.
