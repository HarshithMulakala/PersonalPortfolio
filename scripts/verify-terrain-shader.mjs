import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  TERRAIN_FRAGMENT_CHUNK_INJECTIONS,
  patchTerrainFragmentChunks,
} from "../js/terrain-shader-patches.mjs";

// Exact Three.js 0.185.1 sources copied from the version pinned by index.html.
// Keeping the relevant stock chunks here makes this guard deterministic and
// runnable without a browser, a package install, or network access.
export const STOCK_THREE_0_185_1_CHUNKS = {
  map_fragment: `#ifdef USE_MAP

	vec4 sampledDiffuseColor = texture2D( map, vMapUv );

	#ifdef DECODE_VIDEO_TEXTURE

		// use inline sRGB decode until browsers properly support SRGB8_ALPHA8 with video textures (#26516)

		sampledDiffuseColor = sRGBTransferEOTF( sampledDiffuseColor );

	#endif

	diffuseColor *= sampledDiffuseColor;

#endif`,
  roughnessmap_fragment: `float roughnessFactor = roughness;

#ifdef USE_ROUGHNESSMAP

	vec4 texelRoughness = texture2D( roughnessMap, vRoughnessMapUv );

	// reads channel G, compatible with a combined OcclusionRoughnessMetallic (RGB) texture
	roughnessFactor *= texelRoughness.g;

#endif`,
  metalnessmap_fragment: `float metalnessFactor = metalness;

#ifdef USE_METALNESSMAP

	vec4 texelMetalness = texture2D( metalnessMap, vMetalnessMapUv );

	// reads channel B, compatible with a combined OcclusionRoughnessMetallic (RGB) texture
	metalnessFactor *= texelMetalness.b;

#endif`,
  normal_fragment_begin: `float faceDirection = gl_FrontFacing ? 1.0 : - 1.0;

#ifdef FLAT_SHADED

	vec3 fdx = dFdx( vViewPosition );
	vec3 fdy = dFdy( vViewPosition );
	vec3 normal = normalize( cross( fdx, fdy ) );

#else

	vec3 normal = normalize( vNormal );

	#ifdef DOUBLE_SIDED

		normal *= faceDirection;

	#endif

#endif

#if defined( USE_NORMALMAP_TANGENTSPACE ) || defined( USE_CLEARCOAT_NORMALMAP ) || defined( USE_ANISOTROPY )

	#ifdef USE_TANGENT

		mat3 tbn = mat3( normalize( vTangent ), normalize( vBitangent ), normal );

	#else

		mat3 tbn = getTangentFrame( - vViewPosition, normal,
		#if defined( USE_NORMALMAP )
			vNormalMapUv
		#elif defined( USE_CLEARCOAT_NORMALMAP )
			vClearcoatNormalMapUv
		#else
			vUv
		#endif
		);

	#endif

	#ifdef DOUBLE_SIDED

		tbn[0] *= faceDirection;
		tbn[1] *= faceDirection;

	#endif

#endif

#ifdef USE_CLEARCOAT_NORMALMAP

	#ifdef USE_TANGENT

		mat3 tbn2 = mat3( normalize( vTangent ), normalize( vBitangent ), normal );

	#else

		mat3 tbn2 = getTangentFrame( - vViewPosition, normal, vClearcoatNormalMapUv );

	#endif

	#ifdef DOUBLE_SIDED

		tbn2[0] *= faceDirection;
		tbn2[1] *= faceDirection;

	#endif

#endif

// non perturbed normal for clearcoat among others

vec3 nonPerturbedNormal = normal;
`,
  normal_fragment_maps: `#ifdef USE_NORMALMAP_OBJECTSPACE

	normal = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0; // overrides both flatShading and attribute normals

	#ifdef FLIP_SIDED

		normal = - normal;

	#endif

	#ifdef DOUBLE_SIDED

		normal = normal * faceDirection;

	#endif

	normal = normalize( normalMatrix * normal );

#elif defined( USE_NORMALMAP_TANGENTSPACE )

	vec3 mapN = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;

	#if defined( USE_PACKED_NORMALMAP )

		mapN = vec3( mapN.xy, sqrt( saturate( 1.0 - dot( mapN.xy, mapN.xy ) ) ) );

	#endif

	mapN.xy *= normalScale;

	normal = normalize( tbn * mapN );

#elif defined( USE_BUMPMAP )

	normal = perturbNormalArb( - vViewPosition, normal, dHdxy_fwd(), faceDirection );

	#endif`,
  lights_fragment_maps: `#if defined( RE_IndirectDiffuse )

	#ifdef USE_LIGHTMAP

		vec4 lightMapTexel = texture2D( lightMap, vLightMapUv );
		vec3 lightMapIrradiance = lightMapTexel.rgb * lightMapIntensity;

		irradiance += lightMapIrradiance;

	#endif

	#if defined( USE_ENVMAP ) && defined( ENVMAP_TYPE_CUBE_UV )

		#if defined( STANDARD ) || defined( LAMBERT ) || defined( PHONG )

			iblIrradiance += getIBLIrradiance( geometryNormal );

		#endif

	#endif

#endif

#if defined( USE_ENVMAP ) && defined( RE_IndirectSpecular )

	#ifdef USE_ANISOTROPY

		radiance += getIBLAnisotropyRadiance( geometryViewDir, geometryNormal, material.roughness, material.anisotropyB, material.anisotropy );

	#else

		radiance += getIBLRadiance( geometryViewDir, geometryNormal, material.roughness );

	#endif

	#ifdef USE_CLEARCOAT
		clearcoatRadiance += getIBLRadiance( geometryViewDir, geometryClearcoatNormal, material.clearcoatRoughness );
	#endif

#endif`,
  lights_fragment_end: `#if defined( RE_IndirectDiffuse )

	#if defined( LAMBERT ) || defined( PHONG )

		irradiance += iblIrradiance;

	#endif

	RE_IndirectDiffuse( irradiance, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );

#endif

#if defined( RE_IndirectSpecular )

	RE_IndirectSpecular( radiance, iblIrradiance, clearcoatRadiance, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );

#endif`,
  aomap_fragment: `#ifdef USE_AOMAP

	// reads channel R, compatible with a combined OcclusionRoughnessMetallic (RGB) texture
	float ambientOcclusion = ( texture2D( aoMap, vAoMapUv ).r - 1.0 ) * aoMapIntensity + 1.0;

	reflectedLight.indirectDiffuse *= ambientOcclusion;

	#if defined( USE_CLEARCOAT ) 
		clearcoatSpecularIndirect *= ambientOcclusion;
	#endif

	#if defined( USE_SHEEN ) 
		sheenSpecularIndirect *= ambientOcclusion;
	#endif

	#if defined( USE_ENVMAP ) && defined( STANDARD )

		float dotNV = saturate( dot( geometryNormal, geometryViewDir ) );

		reflectedLight.indirectSpecular *= computeSpecularOcclusion( dotNV, ambientOcclusion, material.roughness );

	#endif

#endif`,
};
const STOCK = STOCK_THREE_0_185_1_CHUNKS;

const stockFragment = `
vec3 terrainLayerColor;
vec3 terrainLayerWorldNormal;
float terrainLayerRoughness;
float terrainLayerAO;
float terrainWetBand;
varying float vTerrainAO;
void terrainEvaluate() {}

void main() {
	vec4 diffuseColor = vec4( diffuse, opacity );
	ReflectedLight reflectedLight = ReflectedLight( vec3( 0.0 ), vec3( 0.0 ), vec3( 0.0 ), vec3( 0.0 ) );
	#include <map_fragment>
	#include <roughnessmap_fragment>
	#include <metalnessmap_fragment>
	#include <normal_fragment_begin>
	#include <normal_fragment_maps>
	#include <lights_fragment_maps>
	#include <lights_fragment_end>
	#include <aomap_fragment>
}`;

function expandChunks(source) {
  let expanded = source;
  for (const [name, chunk] of Object.entries(STOCK)) {
    expanded = expanded.replace(`#include <${name}>`, chunk);
  }
  assert(!expanded.includes("#include <"), "verification fixture left a shader chunk unexpanded");
  return expanded;
}

function assertBefore(source, declaration, use) {
  const declarationIndex = source.indexOf(declaration);
  const useIndex = source.indexOf(use, declarationIndex + declaration.length);
  assert(declarationIndex >= 0, `missing declaration: ${declaration}`);
  assert(useIndex > declarationIndex, `use did not follow declaration: ${use}`);
}

const patchedTemplate = patchTerrainFragmentChunks(stockFragment);
const generated = expandChunks(patchedTemplate);

for (const [name, injection] of Object.entries(TERRAIN_FRAGMENT_CHUNK_INJECTIONS)) {
  const stockIndex = generated.indexOf(STOCK[name]);
  const injectionIndex = generated.indexOf(injection);
  assert(stockIndex >= 0, `${name}: stock Three.js 0.185.1 chunk was removed or changed`);
  assert(injectionIndex > stockIndex + STOCK[name].length, `${name}: terrain code was not appended after the stock chunk`);
}

assertBefore(generated, "void terrainEvaluate()", "terrainEvaluate();");
assertBefore(generated, "vec4 diffuseColor", "diffuseColor.rgb *= terrainLayerColor;");
assertBefore(generated, "vec3 terrainLayerColor;", "diffuseColor.rgb *= terrainLayerColor;");
assertBefore(generated, "vec3 normal =", "normal = normalize(mat3(viewMatrix) * terrainLayerWorldNormal);");
assertBefore(generated, "vec3 terrainLayerWorldNormal;", "normal = normalize(mat3(viewMatrix) * terrainLayerWorldNormal);");
assertBefore(generated, "float roughnessFactor = roughness;", "roughnessFactor *= terrainLayerRoughness;");
assertBefore(generated, "float terrainLayerRoughness;", "roughnessFactor *= terrainLayerRoughness;");
assertBefore(generated, "float metalnessFactor = metalness;", "vec3 normal =");
assertBefore(generated, "float terrainWetBand;", "mix(1.0, 2.333333, terrainWetBand)");
assertBefore(generated, "ReflectedLight reflectedLight", "reflectedLight.indirectSpecular *= mix(1.0, 2.333333, terrainWetBand);");
assertBefore(generated, "ReflectedLight reflectedLight", "reflectedLight.indirectDiffuse *= terrainIndirectAO;");
assertBefore(generated, "float terrainLayerAO;", "float terrainCavity =");
assertBefore(generated, "varying float vTerrainAO;", "clamp(vTerrainAO");
assertBefore(generated, "float terrainCavity =", "terrainIndirectAO =");
assertBefore(generated, "float terrainIndirectAO =", "reflectedLight.indirectDiffuse *= terrainIndirectAO;");

const [indexHtml, terrainMaterial] = await Promise.all([
  readFile(new URL("../index.html", import.meta.url), "utf8"),
  readFile(new URL("../js/terrain-material.mjs", import.meta.url), "utf8"),
]);
assert(indexHtml.includes("three@0.185.1/build/three.module.js"), "index.html no longer pins Three.js 0.185.1");
assert(terrainMaterial.includes("patchTerrainFragmentChunks(shader.fragmentShader)"), "production material bypasses the verified patch path");
for (const declaration of [
  "vec3 terrainLayerColor;",
  "vec3 terrainLayerWorldNormal;",
  "float terrainLayerRoughness;",
  "float terrainLayerAO;",
  "float terrainWetBand;",
  "varying float vTerrainAO;",
  "uniform float uTerrainTime;",
  "void terrainEvaluate()",
]) {
  assert(terrainMaterial.includes(declaration), `production shader is missing ${declaration}`);
}
for (const wetSandContract of [
  "vTerrainWorldPos.xz / 0.6",
  "vTerrainWorldPos.xz / 2.4",
  "* 0.15",
  "* 0.8",
  "mix(0.62, 0.72",
  "mix(0.38, 0.50",
  "1.0 - wetBand * 0.20",
  "terrainWetBand = wetBand;",
  "export function updateTerrainMaterialTime",
]) {
  assert(terrainMaterial.includes(wetSandContract), `production wet-sand shader is missing ${wetSandContract}`);
}

console.log(JSON.stringify({
  three: "0.185.1",
  preservedChunks: Object.keys(TERRAIN_FRAGMENT_CHUNK_INJECTIONS),
  declarationOrder: "pass",
}, null, 2));
