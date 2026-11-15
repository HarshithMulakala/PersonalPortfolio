// R3 shoreline fragment source. This module deliberately has no Three.js or DOM
// dependency so Node can validate the exact production GLSL string.

export const OCEAN_FRAGMENT_TERRAIN_FETCH_BUDGET = 4;

export const WATER_DETAIL_NORMALS = Object.freeze([
  Object.freeze({ x: 0.813, z: 0.582, wx: -0.291, wz: 0.957, frequency: 1.41, speed: 1.73, strength: 0.068, near: 105, far: 270 }),
  Object.freeze({ x: -0.337, z: 0.942, wx: 0.887, wz: 0.462, frequency: 2.73, speed: -2.19, strength: 0.038, near: 58, far: 165 }),
  Object.freeze({ x: 0.961, z: -0.276, wx: -0.643, wz: -0.766, frequency: 5.17, speed: 3.07, strength: 0.018, near: 24, far: 86 }),
]);

export function buildOceanFragmentShader(oceanHeightSource) {
  return `
    precision highp float;
    uniform vec3 uCamPos, uMoonDir, uDeep, uCrest, uShallow, uGlint, uFogColor;
    uniform vec3 uSkyZenith, uSkyHorizon, uShipPos;
    uniform sampler2D uTerrainHeight, uTerrainSdf, uTerrainSplat;
    uniform vec4 uTerrainBounds;
    uniform vec2 uTerrainTextureSize;
    uniform float uFogDensity, uAmp, uTonemap, uTime;
    varying vec3 vWorld;
    varying float vH;
    ${oceanHeightSource}

    vec3 aces(vec3 x){
      float a=2.51, b=0.03, c=2.43, d=0.59, e=0.14;
      return clamp((x*(a*x+b))/(x*(c*x+d)+e), 0.0, 1.0);
    }

    vec2 terrainUnitUv(vec2 p){
      return (p - uTerrainBounds.xy) / (uTerrainBounds.zw - uTerrainBounds.xy);
    }

    vec2 terrainControlUv(vec2 unitUv){
      return (unitUv * (uTerrainTextureSize - 1.0) + 0.5) / uTerrainTextureSize;
    }

    bool terrainContains(vec2 unitUv){
      return !any(lessThan(unitUv, vec2(0.0))) && !any(greaterThan(unitUv, vec2(1.0)));
    }

    float hash21(vec2 p){
      p = fract(p * vec2(123.34, 456.21));
      p += dot(p, p + 45.32);
      return fract(p.x * p.y);
    }

    float valueNoise2(vec2 p){
      vec2 i = floor(p);
      vec2 f = fract(p);
      f = f*f*f*(f*(f*6.0-15.0)+10.0);
      return mix(mix(hash21(i), hash21(i+vec2(1.0,0.0)), f.x),
                 mix(hash21(i+vec2(0.0,1.0)), hash21(i+vec2(1.0,1.0)), f.x), f.y);
    }

    float angularBell(float angle, float center, float halfWidth){
      float delta = atan(sin(angle-center), cos(angle-center));
      float q = abs(delta) / halfWidth;
      return q >= 1.0 ? 0.0 : exp(-3.35*q*q);
    }

    float originsBayShelter(vec2 p){
      float angle = atan((p.y-34.0)/59.0, p.x/79.0);
      return angularBell(angle, -2.12, 0.40);
    }

    float exposedHeadlandSector(vec2 p){
      float angle = atan((p.y-34.0)/59.0, p.x/79.0);
      float west = angularBell(angle, 3.14159265, 0.90);
      float north = angularBell(angle, 1.58, 0.76);
      float bayFlanks = max(
        angularBell(angle, -2.59, 0.20),
        angularBell(angle, -1.66, 0.20)
      );
      return clamp(max(max(west, north), bayFlanks), 0.0, 1.0);
    }

    vec3 reflectedSky(vec3 r){
      float h = smoothstep(-0.04, 0.72, max(r.y, 0.0));
      return mix(uSkyHorizon, uSkyZenith, h);
    }

    void main(){
      vec2 slope = oceanSlope(vWorld.xz, uTime);
      float detailDistance = length(uCamPos.xz - vWorld.xz);
      ${WATER_DETAIL_NORMALS.map((w, i) => `
      float detailLod${i} = 1.0 - smoothstep(${w.near.toFixed(1)}, ${w.far.toFixed(1)}, detailDistance);
      float detailPhase${i} = dot(vWorld.xz, vec2(${w.x.toFixed(3)}, ${w.z.toFixed(3)})) * ${w.frequency.toFixed(2)}
        + sin(dot(vWorld.xz, vec2(${w.wx.toFixed(3)}, ${w.wz.toFixed(3)})) * ${(w.frequency * 0.37).toFixed(3)} - uTime * ${(w.speed * 0.31).toFixed(3)}) * 0.43;
      slope += vec2(${w.x.toFixed(3)}, ${w.z.toFixed(3)})
        * cos(detailPhase${i} + uTime * ${w.speed.toFixed(2)})
        * ${w.strength.toFixed(3)} * detailLod${i};`).join("")}
      vec3 n = normalize(vec3(-slope.x, 1.0, -slope.y));
      vec3 viewDir = normalize(uCamPos - vWorld);
      float hn = clamp(vH / uAmp * 0.5 + 0.5, 0.0, 1.0);

      vec2 baseUnitUv = terrainUnitUv(vWorld.xz);
      bool insideTerrain = terrainContains(baseUnitUv);
      vec2 baseControlUv = terrainControlUv(clamp(baseUnitUv, 0.0, 1.0));
      float shore = -64.0;
      float bedHeight = -10.5;
      if(insideTerrain){
        shore = texture2D(uTerrainSdf, baseControlUv).r;
        bedHeight = texture2D(uTerrainHeight, baseControlUv).r;
      }
      float waterDepth = max(0.0, vWorld.y - bedHeight);
      float seaward = 1.0 - smoothstep(-0.25, 0.45, shore);
      float shallow = (1.0 - smoothstep(0.75, 9.2, waterDepth)) * seaward;
      vec3 col = mix(uDeep, uCrest, smoothstep(0.16, 0.88, hn));
      col = mix(col, uShallow, shallow * 0.62);

      float ndv = max(dot(n, viewDir), 0.0);
      float fres = 0.035 + 0.965 * pow(1.0 - ndv, 5.0);

      // Opaque-water seabed reconstruction. The base height above remains the
      // coast-exact depth used by foam; only the bottom lookup refracts. The
      // component-wise UV offset cannot exceed the R3 0.006 limit.
      vec2 refractionUvOffset = clamp(
        n.xz * 0.0048 * (1.0 - smoothstep(0.0, 6.0, waterDepth)),
        vec2(-0.006), vec2(0.006)
      );
      vec2 texelHalf = 0.5 / uTerrainTextureSize;
      vec2 refractedControlUv = clamp(baseControlUv + refractionUvOffset, texelHalf, 1.0-texelHalf);
      float refractedBedHeight = -10.5;
      vec4 bedSplat = vec4(0.0, 1.0, 0.0, 0.0);
      if(insideTerrain){
        refractedBedHeight = texture2D(uTerrainHeight, refractedControlUv).r;
        bedSplat = max(texture2D(uTerrainSplat, refractedControlUv), vec4(0.0));
      }
      float refractedDepth = max(0.0, vWorld.y - refractedBedHeight);
      float screeWeight = max(0.0, 1.0-dot(bedSplat, vec4(1.0)));
      float bayShelter = originsBayShelter(vWorld.xz) * smoothstep(-10.0, -1.0, shore);
      float headlandSector = exposedHeadlandSector(vWorld.xz) * smoothstep(-3.4, -0.15, shore);
      float rockWeight = clamp(bedSplat.a + screeWeight * 0.82 + headlandSector * 0.62, 0.0, 1.0);
      float sandWeight = clamp(bedSplat.r * 1.35 + bayShelter * 0.68 + (1.0-rockWeight) * 0.12, 0.0, 1.0);
      vec3 seabedSand = vec3(0.49, 0.385, 0.225);
      vec3 seabedRock = vec3(0.255, 0.275, 0.245);
      vec3 seabedScree = vec3(0.19, 0.205, 0.19);
      vec3 seabedColor = mix(seabedRock, seabedSand, sandWeight);
      seabedColor = mix(seabedColor, seabedScree, screeWeight * 0.55);

      float causticA = sin(dot(vWorld.xz, vec2(1.73, -1.11)) * 2.4 + uTime * 0.72);
      float causticB = sin(dot(vWorld.xz, vec2(-0.87, 1.94)) * 2.9 - uTime * 0.61);
      float causticShimmer = pow(max(0.0, 0.5 + 0.25*causticA + 0.25*causticB), 4.0);
      float causticMask = 1.0 - smoothstep(1.7, 2.5, refractedDepth);
      seabedColor *= 1.0 + causticShimmer * causticMask * 0.055;

      vec3 absorption = vec3(0.26, 0.095, 0.045);
      vec3 transmission = exp(-refractedDepth * absorption);
      vec3 bottomThroughWater = seabedColor * transmission + uShallow * (1.0-transmission) * 0.18;
      float bottomFade = 1.0 - smoothstep(2.5, 6.0, refractedDepth);
      float bottomVisibility = bottomFade * (1.0-fres) * seaward;
      col = mix(col, bottomThroughWater, bottomVisibility * 0.92);

      vec3 reflectionNormal = normalize(vec3(-slope.x * 0.42, 1.0, -slope.y * 0.42));
      vec3 reflected = reflectedSky(reflect(-viewDir, reflectionNormal));
      col = mix(col, reflected, fres * 0.44);

      vec3 hlf = normalize(uMoonDir + viewDir);
      float ndh = max(dot(n, hlf), 0.0);
      float tight = pow(ndh, 420.0);
      float shoulder = pow(ndh, 120.0) * 0.075;
      float sparkleMask = 0.72 + 0.28 * valueNoise2(vWorld.xz * 0.72 + uTime * 0.08);
      col += uGlint * (tight * 1.55 + shoulder) * sparkleMask;

      float flank = pow(max(dot(-n, uMoonDir), 0.0), 2.0) * (1.0-ndv);
      col += vec3(0.20, 0.16, 0.08) * flank * 0.34;

      // SDF/depth shoreline foam. Both noise fields are world-space: the fine
      // 1.1u scale breaks local edges, while the 5.4u scale interrupts long arcs.
      float foamFine = valueNoise2(vWorld.xz / 1.1 + vec2(uTime*0.018, -uTime*0.014));
      float foamCoarse = valueNoise2(vWorld.xz / 5.4 + vec2(-uTime*0.010, uTime*0.008));
      float brokenDepth = waterDepth + (foamFine-0.5)*0.24 + (foamCoarse-0.5)*0.34;
      float brokenShore = shore + (foamFine-0.5)*0.42 + (foamCoarse-0.5)*0.86;
      float edgeBreak = smoothstep(0.20, 0.82, foamFine*0.62 + foamCoarse*0.38);

      float primaryBreaker = smoothstep(0.25, 0.43, brokenDepth)
        * (1.0-smoothstep(1.25, 1.60, brokenDepth)) * seaward;
      float remnantBreaker = smoothstep(1.45, 1.72, brokenDepth)
        * (1.0-smoothstep(2.35, 2.90, brokenDepth)) * seaward;

      float phaseA = fract(uTime/7.5 + foamCoarse*0.035);
      float phaseB = fract(uTime/11.0 + foamFine*0.027 + 0.47);
      float centerA = mix(-5.8, 0.12, phaseA);
      float centerB = mix(-8.0, 0.08, phaseB);
      float frontWidthA = mix(0.26, 0.62, foamFine);
      float frontWidthB = mix(0.34, 0.78, foamCoarse);
      float frontA = (1.0-smoothstep(frontWidthA*0.34, frontWidthA, abs(brokenShore-centerA)))
        * pow(sin(phaseA*3.14159265), 1.35) * (1.0-smoothstep(3.1, 5.6, waterDepth));
      float frontB = (1.0-smoothstep(frontWidthB*0.36, frontWidthB, abs(brokenShore-centerB)))
        * pow(sin(phaseB*3.14159265), 1.45) * (1.0-smoothstep(3.8, 6.0, waterDepth));

      float cliffExposure = clamp(max(
        smoothstep(0.14, 0.46, bedSplat.a + screeWeight*0.35),
        headlandSector
      ), 0.0, 1.0);
      float impactBreak = smoothstep(0.62, 0.84, foamFine*0.70 + foamCoarse*0.30);
      float impactPatch = cliffExposure * impactBreak
        * smoothstep(0.22, 0.38, brokenDepth)
        * (1.0-smoothstep(0.72, 1.02, brokenDepth));
      float nonCliffBreaker = primaryBreaker * mix(1.0, 0.38, cliffExposure);
      float foamRaw = (nonCliffBreaker*0.43 + remnantBreaker*0.14
        + frontA*0.16 + frontB*0.10) * mix(0.42, 1.0, edgeBreak);
      foamRaw += impactPatch * 0.54;
      float exposureScale = mix(1.0, 1.25, cliffExposure);
      float shelterScale = mix(1.0, 0.65, bayShelter);
      float foamOpacity = min(0.55, max(0.0, foamRaw * exposureScale * shelterScale));
      col = mix(col, vec3(0.94, 0.93, 0.86), foamOpacity);

      float dist = length(uCamPos - vWorld);
      float fogFactor = clamp(exp(-pow(uFogDensity * dist, 2.0)), 0.0, 1.0);
      col = mix(uFogColor, col, fogFactor);

      if(uTonemap > 0.5){
        col = aces(col);
        col = pow(col, vec3(1.0/2.2));
      }
      gl_FragColor = vec4(col, 1.0);
    }
  `;
}
