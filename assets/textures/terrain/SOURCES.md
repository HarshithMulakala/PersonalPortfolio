# Terrain PBR texture sources

All sets are CC0 (public domain). Downloaded 2026-07-19, recompressed to JPEG q68.
Each layer folder contains: albedo.jpg (sRGB), normal.jpg (OpenGL-convention tangent
normal, linear), roughness.jpg (linear), ao.jpg (linear).

| Layer | Source asset | Origin | Resolution |
|---|---|---|---|
| sand | Ground055L | https://ambientcg.com/view?id=Ground055L | 1K |
| drygrass | Withered Grass | https://polyhaven.com/a/withered_grass | 1K |
| scrub | Ground037 | https://ambientcg.com/view?id=Ground037 | 1K |
| limestone | Rock026 | https://ambientcg.com/view?id=Rock026 | 2K albedo/normal, 1K rough/ao |
| scree | Gravel023 | https://ambientcg.com/view?id=Gravel023 | 1K |

ambientCG assets: CC0, see https://docs.ambientcg.com/license/
Poly Haven assets: CC0, see https://polyhaven.com/license

Processing applied: JPEG re-encode at quality 68 (sips). No color grading yet — the
terrain shader applies Mediterranean warm tinting per design-refs/island-plan.md
(limestone may be warm-tinted in-shader; scree may be slightly darkened in-shader).
Total payload ~10MB.
