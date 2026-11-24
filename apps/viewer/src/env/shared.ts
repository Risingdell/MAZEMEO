/**
 * Uniforms shared by every environment shader (wind, rain, wetness, time),
 * plus the wind-bend shader patch applied to foliage materials.
 */
import * as THREE from 'three';

export const env = {
  uTime: { value: 0 },
  /** Normalised horizontal wind direction (x, z). */
  uWindDir: { value: new THREE.Vector2(1, 0.3).normalize() },
  /** 0 = calm, 1 = strong, 1.5 = storm. */
  uWindStrength: { value: 0.35 },
  /** Ground wetness 0..1 (rain accumulation). */
  uWetness: { value: 0 },
  /** Current rain intensity 0..1. */
  uRain: { value: 0 },
};

export interface WindOptions {
  /** Metres of lean per metre of height at wind strength 1. */
  bendScale: number;
  /** High-frequency leaf flutter amplitude (m). */
  flutter: number;
  /** Keep authored normals on both faces of double-sided cards (no dark backsides). */
  foliage?: boolean;
}

const WIND_PARS = /* glsl */ `
uniform float uTime;
uniform vec2 uWindDir;
uniform float uWindStrength;
uniform float uBendScale;
uniform float uFlutter;
attribute float aSway;
#ifdef USE_INSTANCING
attribute float aBend;
#endif
`;

// Replaces <project_vertex>: instancing -> wind bend in world space -> view projection.
const WIND_PROJECT = /* glsl */ `
vec4 mvPosition = vec4(transformed, 1.0);
vec3 iPos = vec3(0.0);
float bendH = 1.0;
#ifdef USE_INSTANCING
  mvPosition = instanceMatrix * mvPosition;
  iPos = instanceMatrix[3].xyz;
  bendH = aBend;
#endif
float wPhase = dot(iPos.xz, vec2(0.071, 0.053));
// Gust fronts travel across the map along the wind direction.
float front = dot(iPos.xz, uWindDir) * 0.045 - uTime * (0.6 + uWindStrength * 0.8);
float gust = 0.55 + 0.45 * sin(front) * sin(front * 0.37 + 1.7);
float osc = 0.75 + 0.25 * sin(uTime * (1.2 + 0.6 * uWindStrength) + wPhase);
float fl = sin(uTime * 7.1 + dot(mvPosition.xyz, vec3(1.3, 2.1, 0.9))) * uFlutter * (0.25 + uWindStrength);
vec2 wdisp = uWindDir * (uWindStrength * gust * osc) * uBendScale * bendH * aSway;
wdisp += vec2(fl, fl * 0.7) * aSway;
mvPosition.xz += wdisp;
mvPosition.y -= dot(wdisp, wdisp) * 0.12 / max(bendH, 0.5);
mvPosition = modelViewMatrix * mvPosition;
gl_Position = projectionMatrix * mvPosition;
`;

/** Patch a material (and its shadow depth material) so instances bend in the wind. */
export function applyWind(material: THREE.Material, opts: WindOptions): void {
  const bend = { value: opts.bendScale };
  const flutter = { value: opts.flutter };
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = env.uTime;
    shader.uniforms.uWindDir = env.uWindDir;
    shader.uniforms.uWindStrength = env.uWindStrength;
    shader.uniforms.uBendScale = bend;
    shader.uniforms.uFlutter = flutter;
    shader.vertexShader = shader.vertexShader.replace('#include <common>', `#include <common>\n${WIND_PARS}`).replace('#include <project_vertex>', WIND_PROJECT);
    if (opts.foliage) {
      // Foliage cards use outward "crown" normals; don't flip them on back faces,
      // and let light bleed through leaves a little (cheap translucency).
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <normal_fragment_begin>', THREE.ShaderChunk.normal_fragment_begin.replace(/normal \*= faceDirection;/g, '').replace(/normal = normal \* faceDirection;/g, ''))
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += diffuseColor.rgb * 0.06;');
    }
  };
  material.customProgramCacheKey = () => `wind:${material.type}:${opts.foliage ? 'f' : ''}`;
}

/** Depth material for shadows that bends identically (and alpha-tests cards). */
export function windDepthMaterial(opts: WindOptions, alphaMap?: THREE.Texture): THREE.MeshDepthMaterial {
  const m = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: alphaMap ?? null, alphaTest: alphaMap ? 0.5 : 0 });
  applyWind(m, opts);
  return m;
}

/** Set per-vertex sway weights (0 at the root, 1 at the tip) from local height. */
export function setSwayByHeight(geo: THREE.BufferGeometry, minY: number, maxY: number, power = 1.6): THREE.BufferGeometry {
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const sway = new Float32Array(pos.count);
  for (let i = 0; i < pos.count; i++) sway[i] = Math.max(0, Math.min(1, (pos.getY(i) - minY) / (maxY - minY))) ** power;
  geo.setAttribute('aSway', new THREE.BufferAttribute(sway, 1));
  return geo;
}

export function setSwayConst(geo: THREE.BufferGeometry, value: number): THREE.BufferGeometry {
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  geo.setAttribute('aSway', new THREE.BufferAttribute(new Float32Array(pos.count).fill(value), 1));
  return geo;
}
