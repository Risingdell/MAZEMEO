/**
 * Falling leaves around the camera, coloured by the biome you're standing in.
 *
 * Each leaf is a cupped, slightly folded blade picked from a 4-leaf atlas.
 * Motion follows how real leaves fall: a side-to-side pendulum glide that
 * slows at each turn and tilts into the swing ("falling leaf"), a slow yaw,
 * plus occasional "spinners" that autorotate. Wind drifts them downwind.
 * Fully GPU-driven; leaves wrap in a box around the camera.
 */
import * as THREE from 'three';
import type { BiomeId } from '@mazemeo/maze-core';
import { env } from './shared.ts';
import type { EnvTextures } from './textures.ts';

const MAX = 1400;
const BOX = new THREE.Vector3(56, 30, 56);

/** Leaf density, two colours to vary between, and which atlas variants fall here. */
const BIOME_LEAVES: Record<BiomeId, { density: number; a: number; b: number; variants: [number, number] }> = {
  maple: { density: 1, a: 0xb8321c, b: 0xe0922a, variants: [0, 1] },
  bamboo: { density: 0.35, a: 0x8fa64a, b: 0xc4b86a, variants: [3, 3] },
  shrine: { density: 0.04, a: 0x8a6a34, b: 0xa48a4a, variants: [2, 2] }, // pine forest: very few broadleaves
  marsh: { density: 0.15, a: 0x7d6b3c, b: 0x9a8650, variants: [2, 2] },
  summit: { density: 0.05, a: 0x8a7a5a, b: 0x9a8a6a, variants: [2, 2] },
};

export class Leaves {
  readonly mesh: THREE.Mesh;
  private readonly geo: THREE.InstancedBufferGeometry;
  private readonly uniforms: Record<string, THREE.IUniform>;
  private density = 0;
  private readonly colA = new THREE.Color(BIOME_LEAVES.maple.a);
  private readonly colB = new THREE.Color(BIOME_LEAVES.maple.b);
  private readonly variants = new THREE.Vector2(0, 1);

  constructor(tex: EnvTextures) {
    // Cupped + folded blade: subdivided quad bent in object space.
    const base = new THREE.PlaneGeometry(0.15, 0.15, 6, 6);
    const pos = base.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i) / 0.075;
      const y = pos.getY(i) / 0.075;
      pos.setZ(i, (x * x * 0.55 + y * y * 0.25) * 0.012 + Math.abs(x) * 0.006);
    }
    base.computeVertexNormals();
    this.geo = new THREE.InstancedBufferGeometry();
    this.geo.index = base.index;
    this.geo.setAttribute('position', base.getAttribute('position'));
    this.geo.setAttribute('normal', base.getAttribute('normal'));
    this.geo.setAttribute('uv', base.getAttribute('uv'));
    const seeds = new Float32Array(MAX * 4);
    for (let i = 0; i < MAX * 4; i++) seeds[i] = Math.random();
    this.geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 4));
    this.geo.instanceCount = 0;

    this.uniforms = {
      uTime: env.uTime,
      uWindDir: env.uWindDir,
      uWindStrength: env.uWindStrength,
      uCam: { value: new THREE.Vector3() },
      uBox: { value: BOX },
      uColA: { value: this.colA },
      uColB: { value: this.colB },
      uVariants: { value: this.variants },
    };
    const mat = new THREE.MeshStandardMaterial({ map: tex.leafAtlas, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.7 });
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.uniforms);
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
          attribute vec4 aSeed;
          uniform float uTime; uniform vec2 uWindDir; uniform float uWindStrength;
          uniform vec3 uCam; uniform vec3 uBox; uniform vec3 uColA; uniform vec3 uColB; uniform vec2 uVariants;
          varying vec3 vLeafCol;
          mat3 rotY(float a) { float s = sin(a), c = cos(a); return mat3(c, 0., -s, 0., 1., 0., s, 0., c); }
          mat3 rotX(float a) { float s = sin(a), c = cos(a); return mat3(1., 0., 0., 0., c, s, 0., -s, c); }
          mat3 rotZ(float a) { float s = sin(a), c = cos(a); return mat3(c, s, 0., -s, c, 0., 0., 0., 1.); }`,
        )
        .replace(
          '#include <beginnormal_vertex>',
          `float omega = 1.3 + aSeed.x * 1.2;              // swing frequency
          float phase = uTime * omega + aSeed.y * 6.2831;
          float swing = sin(phase);
          bool spinner = aSeed.w > 0.85;
          // Lie roughly flat (face up), tilt into the swing, yaw slowly.
          float yaw = aSeed.z * 6.2831 + uTime * (0.25 + aSeed.x * 0.4) * (aSeed.y > 0.5 ? 1.0 : -1.0);
          float roll = cos(phase) * 0.85;
          float pitch = -1.5708 + sin(phase * 0.5 + aSeed.x * 3.0) * 0.25;
          if (spinner) { roll = uTime * (6.0 + aSeed.x * 6.0); pitch = -0.9; }
          mat3 leafRot = rotY(yaw) * rotZ(roll) * rotX(pitch);
          vec3 objectNormal = leafRot * normal;`,
        )
        .replace(
          '#include <begin_vertex>',
          `// Pendulum glide: lateral offset along a per-leaf heading; falls slower at the turns.
          vec3 heading = vec3(cos(aSeed.z * 6.2831), 0.0, sin(aSeed.z * 6.2831));
          float amp = 0.35 + aSeed.y * 0.55;
          float fallSpeed = spinner ? 1.6 + aSeed.w : 0.55 + aSeed.w * 0.6;
          float fall = fallSpeed * uTime + (spinner ? 0.0 : 0.12 * cos(2.0 * phase) / omega);
          vec3 drift = vec3(uWindDir.x, 0.0, uWindDir.y) * uWindStrength * (1.6 + aSeed.x * 1.8) * uTime;
          vec3 p = aSeed.xyz * uBox + drift - vec3(0.0, fall, 0.0) + heading * swing * amp;
          p = mod(p - uCam + uBox * 0.5, uBox) - uBox * 0.5 + uCam;
          float scale = 0.8 + fract(aSeed.w * 7.31) * 0.6;
          vec3 transformed = p + leafRot * position * scale;
          vLeafCol = mix(uColA, uColB, fract(aSeed.y * 13.7));`,
        )
        .replace(
          '#include <uv_vertex>',
          `#include <uv_vertex>
          float variant = fract(aSeed.x * 9.13) < 0.5 ? uVariants.x : uVariants.y;
          vMapUv = vMapUv * 0.5 + vec2(mod(variant, 2.0), 1.0 - floor(variant / 2.0)) * 0.5;`,
        );
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vLeafCol;')
        .replace('#include <normal_fragment_begin>', THREE.ShaderChunk.normal_fragment_begin.replace(/normal \*= faceDirection;/g, ''))
        .replace('#include <map_fragment>', '#include <map_fragment>\ndiffuseColor.rgb *= vLeafCol;')
        // Light passing through thin leaves.
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += diffuseColor.rgb * 0.12;');
    };
    mat.customProgramCacheKey = () => 'falling-leaves-v2';
    this.mesh = new THREE.Mesh(this.geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
  }

  /** @param biome biome around the camera; leaf colour and kind blend when it changes. */
  update(dt: number, camera: THREE.Camera, biome: BiomeId, onGround: boolean): void {
    const cfg = BIOME_LEAVES[biome];
    const target = onGround ? cfg.density * (0.35 + env.uWindStrength.value * 0.7) : 0;
    this.density += (target - this.density) * Math.min(1, dt * 0.8);
    this.geo.instanceCount = Math.floor(MAX * Math.min(1, this.density));
    this.colA.lerp(new THREE.Color(cfg.a), Math.min(1, dt));
    this.colB.lerp(new THREE.Color(cfg.b), Math.min(1, dt));
    this.variants.set(cfg.variants[0], cfg.variants[1]);
    (this.uniforms.uCam!.value as THREE.Vector3).copy(camera.position);
  }
}
