/**
 * Terrain mesh with a 5-layer height-blended soil shader (moss, dirt, rock,
 * leaf litter, mud), rain wetness and puddles, plus bog water in the marsh.
 */
import * as THREE from 'three';
import { DEFAULT_CONFIG, biomeOfRegion, smoothstep, valueNoise, type BiomeId, type WalkField } from '@mazemeo/maze-core';
import { env } from './shared.ts';
import type { EnvTextures } from './textures.ts';

/** Biome tint multiplied over the textures (keeps regions readable). */
const TINT: Record<BiomeId, number> = {
  bamboo: 0xc6d0a4,
  maple: 0xf2c49a, // warm, golden leaf carpet
  shrine: 0xaeb89c,
  marsh: 0xa6ad9c,
  summit: 0xd6d2ca,
};

/** Splat weights per biome for the forest floor away from trails. */
const LITTER: Record<BiomeId, number> = { bamboo: 0.35, maple: 1.0, shrine: 0.45, marsh: 0.05, summit: 0.05 };
const MUD: Record<BiomeId, number> = { bamboo: 0, maple: 0, shrine: 0, marsh: 0.75, summit: 0 };

export const HORIZON_OVERLAP = 22;
const DAMP_TRAIL = new THREE.Color(0x9a7c74);
const GOLD_EDGE = new THREE.Color(0xffd48a);
const DUSTY_TRAIL = new THREE.Color(0xf2dec2);
const MOSS_BANK = new THREE.Color(0x9cb46e);

export function buildTerrain(field: WalkField, tex: EnvTextures): THREE.Mesh {
  const { size, cellSize, originX, originZ } = field;
  const count = size * size;
  const positions = new Float32Array(count * 3);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const k = j * size + i;
      positions[k * 3] = originX + i * cellSize;
      positions[k * 3 + 1] = field.height[k]!;
      positions[k * 3 + 2] = originZ + j * cellSize;
    }
  }
  const cutR = DEFAULT_CONFIG.mapRadius + HORIZON_OVERLAP;
  const index: number[] = [];
  for (let j = 0; j < size - 1; j++) {
    for (let i = 0; i < size - 1; i++) {
      const cx = originX + (i + 0.5) * cellSize;
      const cz = originZ + (j + 0.5) * cellSize;
      if (cx * cx + cz * cz > cutR * cutR) continue;
      const a = j * size + i;
      index.push(a, a + size, a + 1, a + 1, a + size, a + size + 1);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setIndex(index);
  geo.computeVertexNormals();

  const normals = geo.getAttribute('normal') as THREE.BufferAttribute;
  const colors = new Float32Array(count * 3);
  const splat = new Float32Array(count * 4); // trail, rock, litter, mud
  const tint = new THREE.Color();
  for (let k = 0; k < count; k++) {
    const biome = biomeOfRegion(field.region[k]!);
    const x = positions[k * 3]!;
    const z = positions[k * 3 + 2]!;
    const c = field.clearance[k]!;
    const trail = 1 - smoothstep(-1.4, 1.0, c);
    tint.set(TINT[biome]).offsetHSL(0, 0, valueNoise(377, x / 37, z / 37) * 0.06);
    if (biome === 'maple') {
      // Autumn ravine: the trail is a darker, damp, purplish-brown strip; the
      // leaf carpet either side glows golden where it meets the path.
      tint.lerp(DAMP_TRAIL, trail * 0.6);
      const edge = smoothstep(-0.8, 0.6, c) * (1 - smoothstep(1.0, 4.5, c));
      tint.lerp(GOLD_EDGE, edge * 0.45);
    } else if (biome === 'shrine') {
      // Mountain pine forest: dusty pale trail between mossy green banks.
      tint.lerp(DUSTY_TRAIL, trail * 0.55);
      tint.lerp(MOSS_BANK, (1 - trail) * 0.35);
    }
    colors[k * 3] = tint.r;
    colors[k * 3 + 1] = tint.g;
    colors[k * 3 + 2] = tint.b;
    const steep = 1 - smoothstep(0.6, 0.8, normals.getY(k));
    const summitRock = biome === 'summit' ? 0.45 + 0.4 * smoothstep(0, 4, c) : 0;
    const variation = valueNoise(919, x / 13, z / 13) * 0.5 + 0.5;
    splat[k * 4] = trail;
    splat[k * 4 + 1] = Math.min(1, (biome === 'marsh' ? 0 : steep) + summitRock);
    // Fallen leaves: thick carpet off-trail, and scattered across the trail in the ravine.
    splat[k * 4 + 2] = (1 - trail) * LITTER[biome] * (0.55 + 0.6 * variation) * smoothstep(-0.5, 2.5, c) + (biome === 'maple' ? trail * (0.3 + 0.35 * variation) : 0);
    splat[k * 4 + 3] = MUD[biome] * (1 - trail * 0.6);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.setAttribute('aSplat', new THREE.BufferAttribute(splat, 4));

  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uAlbedo = { value: tex.groundAlbedo };
    shader.uniforms.uNormal = { value: tex.groundNormal };
    shader.uniforms.uWetness = env.uWetness;
    shader.uniforms.uRain = env.uRain;
    shader.uniforms.uTime = env.uTime;
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        attribute vec4 aSplat;
        varying vec4 vSplat;
        varying vec3 vWPos;
        varying vec3 vWNormal;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vSplat = aSplat;
        vWPos = (modelMatrix * vec4(position, 1.0)).xyz;
        vWNormal = normalize(mat3(modelMatrix) * normal);`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        precision highp sampler2DArray;
        uniform sampler2DArray uAlbedo;
        uniform sampler2DArray uNormal;
        uniform float uWetness;
        uniform float uRain;
        uniform float uTime;
        varying vec4 vSplat;
        varying vec3 vWPos;
        varying vec3 vWNormal;
        float tHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float tNoise(vec2 p) {
          vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
          return mix(mix(tHash(i), tHash(i + vec2(1, 0)), f.x), mix(tHash(i + vec2(0, 1)), tHash(i + vec2(1, 1)), f.x), f.y);
        }
        // Two scales + rotation to hide tiling.
        vec4 sampleLayer(sampler2DArray t, float layer, vec2 uv) {
          vec2 uv2 = mat2(0.8, -0.6, 0.6, 0.8) * uv * 0.37 + 0.31;
          return mix(texture(t, vec3(uv, layer)), texture(t, vec3(uv2, layer)), 0.35);
        }
        vec4 gWeights;
        float gMossW;
        float gPuddle;
        vec3 gNormalT;`,
      )
      .replace(
        '#include <map_fragment>',
        `{
          vec2 uv = vWPos.xz * 0.22;
          float macro = tNoise(vWPos.xz * 0.02) * 0.6 + tNoise(vWPos.xz * 0.07) * 0.4;
          vec4 moss = sampleLayer(uAlbedo, 0.0, uv);
          vec4 dirt = sampleLayer(uAlbedo, 1.0, uv);
          // Rock is triplanar so cliff faces aren't stretched.
          vec3 tw = pow(abs(normalize(vWNormal)), vec3(4.0));
          tw /= (tw.x + tw.y + tw.z);
          vec2 ruvX = vWPos.zy * 0.13;
          vec2 ruvY = vWPos.xz * 0.13;
          vec2 ruvZ = vWPos.xy * 0.13;
          vec4 rock = sampleLayer(uAlbedo, 2.0, ruvX) * tw.x + sampleLayer(uAlbedo, 2.0, ruvY) * tw.y + sampleLayer(uAlbedo, 2.0, ruvZ) * tw.z;
          vec4 litter = sampleLayer(uAlbedo, 3.0, uv * 1.2);
          vec4 mud = sampleLayer(uAlbedo, 4.0, uv);
          // Height-based blending: the taller material wins at the boundary.
          float wMoss = max(0.0, 1.0 - vSplat.x - vSplat.y - vSplat.z - vSplat.w) + 0.05;
          vec4 w = vec4(vSplat.x, vSplat.y, vSplat.z, vSplat.w);
          vec4 hgt = vec4(dirt.a, rock.a, litter.a, mud.a);
          float hm = moss.a;
          vec4 hw = max(w * (1.0 + hgt * 2.0) - 0.0, 0.0);
          float hmw = wMoss * (1.0 + hm * 2.0);
          float mx = max(max(max(hw.x, hw.y), max(hw.z, hw.w)), hmw) - 0.35;
          hw = max(hw - mx, 0.0);
          hmw = max(hmw - mx, 0.0);
          float sum = hw.x + hw.y + hw.z + hw.w + hmw + 1e-4;
          hw /= sum; hmw /= sum;
          gWeights = hw; gMossW = hmw;
          vec3 albedo = moss.rgb * hmw + dirt.rgb * hw.x + rock.rgb * hw.y + litter.rgb * hw.z + mud.rgb * hw.w;
          albedo *= 0.85 + macro * 0.3;
          // Puddles collect in low spots of trails and mud when wet.
          float pn = tNoise(vWPos.xz * 0.09) * 0.7 + tNoise(vWPos.xz * 0.31) * 0.3;
          float low = 1.0 - (dirt.a * hw.x + mud.a * hw.w + 0.5 * (1.0 - hw.x - hw.w));
          gPuddle = smoothstep(0.62, 0.7, pn * 0.75 + low * 0.35) * (hw.x + hw.w) * smoothstep(0.35, 0.9, uWetness);
          // Wet surfaces darken.
          float wetDark = uWetness * (0.45 + 0.2 * (hw.x + hw.w));
          albedo *= 1.0 - wetDark * 0.45;
          albedo = mix(albedo, albedo * 0.55, gPuddle);
          diffuseColor.rgb *= albedo;
          vec3 n0 = sampleLayer(uNormal, 0.0, uv).xyz;
          vec3 n1 = sampleLayer(uNormal, 1.0, uv).xyz;
          vec3 n2 = (sampleLayer(uNormal, 2.0, ruvX) * tw.x + sampleLayer(uNormal, 2.0, ruvY) * tw.y + sampleLayer(uNormal, 2.0, ruvZ) * tw.z).xyz;
          vec3 n3 = sampleLayer(uNormal, 3.0, uv * 1.2).xyz;
          vec3 n4 = sampleLayer(uNormal, 4.0, uv).xyz;
          gNormalT = normalize((n0 * hmw + n1 * hw.x + n2 * hw.y + n3 * hw.z + n4 * hw.w) * 2.0 - 1.0);
          gNormalT = normalize(mix(gNormalT, vec3(0.0, 0.0, 1.0), gPuddle));
        }`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `float roughnessFactor = roughness;
        roughnessFactor = mix(roughnessFactor, 0.35, uWetness * 0.8);
        roughnessFactor = mix(roughnessFactor, 0.04, gPuddle);`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `{
          vec3 N = normalize(vWNormal);
          vec3 T = normalize(vec3(1.0, 0.0, 0.0) - N * N.x);
          vec3 B = normalize(cross(N, T));
          vec3 tn = gNormalT;
          // Rain ripples in puddles.
          if (gPuddle > 0.01 && uRain > 0.01) {
            vec2 rp = vWPos.xz * 3.0;
            float rip = sin(length(fract(rp) - 0.5) * 40.0 - uTime * 12.0 + tHash(floor(rp)) * 6.28);
            tn.xy += rip * 0.08 * uRain * gPuddle;
          }
          vec3 nW = normalize(T * tn.x + B * tn.y + N * tn.z);
          normal = normalize((viewMatrix * vec4(nW, 0.0)).xyz);
        }`,
      );
  };
  mat.customProgramCacheKey = () => 'terrain-splat';

  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  mesh.name = 'terrain';
  return mesh;
}

/** Bog water sheet over the sunken marsh channels. */
export function buildWater(field: WalkField): THREE.Mesh | null {
  const { size, cellSize, originX, originZ } = field;
  const pos: number[] = [];
  const idx: number[] = [];
  const vmap = new Int32Array(size * size).fill(-1);
  const isWet = (k: number): boolean => biomeOfRegion(field.region[k]!) === 'marsh' && field.clearance[k]! > 0.4;
  const vertex = (i: number, j: number): number => {
    const k = j * size + i;
    if (vmap[k]! >= 0) return vmap[k]!;
    // Water sits ~1.5 m above the sunken channel floor, just below trail level.
    const depth = Math.min(1.6, 1.6 * smoothstep(0.4, 5, field.clearance[k]!));
    vmap[k] = pos.length / 3;
    pos.push(originX + i * cellSize, field.height[k]! + depth, originZ + j * cellSize);
    return vmap[k]!;
  };
  for (let j = 0; j < size - 1; j++) {
    for (let i = 0; i < size - 1; i++) {
      const k = j * size + i;
      if (!isWet(k) || !isWet(k + 1) || !isWet(k + size) || !isWet(k + size + 1)) continue;
      const a = vertex(i, j);
      const b = vertex(i + 1, j);
      const c = vertex(i, j + 1);
      const d = vertex(i + 1, j + 1);
      idx.push(a, c, b, b, c, d);
    }
  }
  if (idx.length === 0) return null;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({ color: 0x1d2a24, roughness: 0.06, metalness: 0.0, transparent: true, opacity: 0.88 });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = env.uTime;
    shader.uniforms.uRain = env.uRain;
    shader.uniforms.uWindStrength = env.uWindStrength;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWPos = position;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;\nuniform float uTime;\nuniform float uRain;\nuniform float uWindStrength;')
      .replace(
        '#include <normal_fragment_maps>',
        `{
          vec2 p = vWPos.xz;
          float a = uWindStrength * 0.6 + 0.1;
          vec2 d = vec2(
            sin(p.x * 0.9 + uTime * 1.3) * 0.5 + sin(p.y * 1.7 - uTime * 1.1) * 0.3 + sin((p.x + p.y) * 3.1 + uTime * 2.3) * 0.2,
            cos(p.y * 0.8 + uTime * 1.2) * 0.5 + cos(p.x * 1.9 - uTime * 0.9) * 0.3 + cos((p.x - p.y) * 2.9 + uTime * 2.0) * 0.2) * a * 0.12;
          vec2 rp = p * 2.5;
          float rip = sin(length(fract(rp) - 0.5) * 38.0 - uTime * 11.0 + fract(sin(dot(floor(rp), vec2(12.9, 78.2))) * 43758.5) * 6.28);
          d += rip * 0.1 * uRain;
          vec3 nW = normalize(vec3(d.x, 1.0, d.y));
          normal = normalize((viewMatrix * vec4(nW, 0.0)).xyz);
        }`,
      );
  };
  mat.customProgramCacheKey = () => 'bog-water';
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  mesh.name = 'water';
  return mesh;
}
