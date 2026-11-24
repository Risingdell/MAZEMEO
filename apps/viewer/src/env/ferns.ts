/**
 * GPU bracken ferns around the player (same world-anchored grid approach as grass).
 *
 * Each plant is a rosette of arching fronds (textured, alpha-cut strips) that
 * rise, arch outward and droop at the tip. Density comes from the walk field:
 * forest floor only, never on the trail, thickest along trail edges where the
 * light reaches. Autumn ravine ferns are orange/gold, shrine ferns are green.
 */
import * as THREE from 'three';
import { biomeOfRegion, type BiomeId, type WalkField } from '@mazemeo/maze-core';
import type { Circle, Quality } from './foliage.ts';
import { FIELD_GLSL, fieldUniforms } from './grass.ts';
import { env } from './shared.ts';
import type { EnvTextures } from './textures.ts';

const FRONDS = 7;
const SEGMENTS = 7;

const BIOME_FERNS: Record<BiomeId, { density: number; size: number; a: number; b: number }> = {
  maple: { density: 1.0, size: 1.15, a: 0xc4481a, b: 0xe8862a },
  shrine: { density: 0.55, size: 0.85, a: 0x3a6424, b: 0x6c8c32 },
  bamboo: { density: 0.18, size: 0.7, a: 0x5a7a2c, b: 0x8a9a3e },
  marsh: { density: 0, size: 0, a: 0, b: 0 },
  summit: { density: 0, size: 0, a: 0, b: 0 },
};

function frondGeometry(): THREE.InstancedBufferGeometry {
  const pos: number[] = [];
  const uv: number[] = [];
  const frond: number[] = [];
  const idx: number[] = [];
  let seed = 4242;
  const rnd = (): number => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  for (let f = 0; f < FRONDS; f++) {
    const start = pos.length / 3;
    const data = [(f + rnd() * 0.6) / FRONDS, rnd(), rnd(), rnd()]; // angle, length, roll, droop
    for (let s = 0; s <= SEGMENTS; s++) {
      const t = s / SEGMENTS;
      for (const side of [-0.5, 0.5]) {
        pos.push(side, t, 0);
        uv.push(side + 0.5, t);
        frond.push(...data);
      }
    }
    for (let s = 0; s < SEGMENTS; s++) {
      const a = start + s * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('aFrond', new THREE.Float32BufferAttribute(frond, 4));
  g.setIndex(idx);
  return g;
}

const VERT_PARS = /* glsl */ `
${FIELD_GLSL}
uniform vec2 uCenter;
uniform float uCell;
uniform int uGridW;
uniform float uRadius;
uniform float uTime;
uniform vec2 uWindDir;
uniform float uWindStrength;
uniform vec3 uPlayer;
uniform vec4 uFern[5];   // density, size, -, -
uniform vec3 uColA[5];
uniform vec3 uColB[5];
attribute vec4 aFrond;
varying vec3 vFernCol;
`;

const VERT_MAIN = /* glsl */ `
  int gid = gl_InstanceID;
  vec2 gidx = vec2(float(gid % uGridW), float(gid / uGridW));
  vec2 cellPos = floor(uCenter / uCell) * uCell + (gidx - float(uGridW) * 0.5) * uCell;
  vec2 key = floor(cellPos / uCell + 0.5);
  float r1 = gHash(key + 3.1), r2 = gHash(key + 11.7), r3 = gHash(key + 23.3), r4 = gHash(key + 37.9);
  vec2 plant = cellPos + (vec2(r1, r2) - 0.5) * uCell * 0.9;
  vec4 fc = fieldAt(plant);
  int reg = regionAt(plant);
  vec4 bio = uFern[reg];
  float clr = fc.g;
  // Forest floor only; most lush just off the trail edge, thinning deep in the wall.
  float dens = bio.x * smoothstep(0.2, 1.6, clr) * (1.0 - 0.45 * smoothstep(5.0, 14.0, clr));
  float patchN = gNoise(plant * 0.11 + 5.0);
  dens *= smoothstep(0.15, 0.5, patchN) * (1.0 - fc.a);
  float slope = length(vec2(fieldAt(plant + vec2(1.0, 0.0)).r - fc.r, fieldAt(plant + vec2(0.0, 1.0)).r - fc.r));
  dens *= 1.0 - smoothstep(0.8, 1.3, slope);
  float dist = length(plant - uCenter);
  float lod = 1.0 - smoothstep(uRadius * 0.6, uRadius * 0.97, dist);
  float keep = step(r3, dens) * smoothstep(0.0, 0.3, lod);

  float L = bio.y * (0.6 + 0.6 * aFrond.y) * (0.7 + 0.6 * r4) * keep;
  float ang = (aFrond.x + r4) * 6.2831;
  vec3 dir = vec3(cos(ang), 0.0, sin(ang));
  vec3 side = vec3(-dir.z, 0.0, dir.x);
  float roll = (aFrond.z - 0.5) * 0.9;
  vec3 widthAxis = normalize(side * cos(roll) + vec3(0.0, sin(roll), 0.0));
  float t = position.y;
  // Arch: rise steeply, bend outward, droop at the tip.
  float droop = 0.25 + aFrond.w * 0.35;
  float outward = t * L * 0.85;
  float up = L * (0.62 * sin(t * 2.2)) - t * t * t * L * droop;
  // Wind sway + player brushing
  float front = dot(plant, uWindDir) * 0.07 - uTime * (0.9 + uWindStrength * 1.3);
  float gust = 0.5 + 0.5 * sin(front) * sin(front * 0.41 + 2.0);
  vec2 sway = uWindDir * uWindStrength * (0.15 + 0.35 * gust) * t * t * L + vec2(sin(uTime * 1.7 + r1 * 6.28), cos(uTime * 1.3 + r2 * 6.28)) * 0.03 * t * L;
  vec2 away = plant - uPlayer.xz;
  float pd = length(away);
  vec2 push = (pd > 1e-3 ? away / pd : vec2(0.0)) * (1.0 - smoothstep(0.3, 1.3, pd)) * t * t * L * 0.9;
  float rootY = fc.r - 0.03;
  vec3 fernPos = vec3(plant.x, rootY, plant.y) + dir * outward + vec3(0.0, up, 0.0) + widthAxis * position.x * L * 0.42;
  fernPos.xz += sway + push;
  vec3 objectNormal = normalize(vec3(0.0, 1.0, 0.0) + dir * 0.25 - widthAxis * 0.15);
  vFernCol = mix(uColA[reg], uColB[reg], fract(r3 * 5.3 + aFrond.y * 0.6)) * mix(0.55, 1.0, smoothstep(0.0, 0.35, t));
`;

export class Ferns {
  readonly mesh: THREE.Mesh;
  private readonly uniforms: Record<string, THREE.IUniform>;
  private readonly geo: THREE.InstancedBufferGeometry;
  private fieldTex: THREE.Texture | null = null;

  constructor(tex: EnvTextures, quality: Quality) {
    this.geo = frondGeometry();
    this.uniforms = {
      uField: { value: null },
      uFieldOrigin: { value: new THREE.Vector2() },
      uFieldCell: { value: 2 },
      uFieldSize: { value: 2 },
      uCenter: { value: new THREE.Vector2() },
      uCell: { value: 1.3 },
      uGridW: { value: 64 },
      uRadius: { value: 40 },
      uTime: env.uTime,
      uWindDir: env.uWindDir,
      uWindStrength: env.uWindStrength,
      uPlayer: { value: new THREE.Vector3(1e6, 0, 1e6) },
      uFern: { value: Array.from({ length: 5 }, () => new THREE.Vector4()) },
      uColA: { value: Array.from({ length: 5 }, () => new THREE.Color()) },
      uColB: { value: Array.from({ length: 5 }, () => new THREE.Color()) },
    };
    this.setQuality(quality);
    const mat = new THREE.MeshStandardMaterial({ map: tex.fernCard, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.8 });
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\n${VERT_PARS}`)
        .replace('#include <beginnormal_vertex>', VERT_MAIN)
        .replace('#include <begin_vertex>', 'vec3 transformed = fernPos;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vFernCol;')
        .replace('#include <normal_fragment_begin>', THREE.ShaderChunk.normal_fragment_begin.replace(/normal \*= faceDirection;/g, ''))
        .replace('#include <map_fragment>', '#include <map_fragment>\ndiffuseColor.rgb *= vFernCol;')
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += diffuseColor.rgb * 0.1;');
    };
    mat.customProgramCacheKey = () => 'gpu-ferns';
    this.mesh = new THREE.Mesh(this.geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.receiveShadow = true;
    this.mesh.name = 'ferns';
  }

  setQuality(quality: Quality): void {
    const gridW = quality === 'high' ? 64 : 40;
    const cell = quality === 'high' ? 1.3 : 1.6;
    this.uniforms.uGridW!.value = gridW;
    this.uniforms.uCell!.value = cell;
    this.uniforms.uRadius!.value = gridW * cell * 0.5;
    this.geo.instanceCount = gridW * gridW;
  }

  setField(field: WalkField, exclude: Circle[] = []): void {
    this.fieldTex?.dispose();
    const fu = fieldUniforms(field, exclude);
    this.fieldTex = fu.uField!.value as THREE.Texture;
    for (const key of ['uField', 'uFieldOrigin', 'uFieldCell', 'uFieldSize']) this.uniforms[key]!.value = fu[key]!.value;
    for (let r = 0; r < 5; r++) {
      const b = BIOME_FERNS[biomeOfRegion(r)];
      (this.uniforms.uFern!.value as THREE.Vector4[])[r]!.set(b.density, b.size, 0, 0);
      (this.uniforms.uColA!.value as THREE.Color[])[r]!.set(b.a);
      (this.uniforms.uColB!.value as THREE.Color[])[r]!.set(b.b);
    }
  }

  update(camera: THREE.Camera, player: THREE.Vector3 | null, visible: boolean): void {
    this.mesh.visible = visible;
    (this.uniforms.uCenter!.value as THREE.Vector2).set(camera.position.x, camera.position.z);
    (this.uniforms.uPlayer!.value as THREE.Vector3).copy(player ?? new THREE.Vector3(1e6, 0, 1e6));
  }
}
