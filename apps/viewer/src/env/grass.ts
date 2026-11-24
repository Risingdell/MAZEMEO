/**
 * GPU grass field around the player.
 *
 * Real blade geometry (tapered, curved strips; no alpha cards) instanced over a
 * world-anchored grid centred on the camera. Every clump reads the walk field
 * from a float texture, so grass follows the terrain exactly and its density
 * comes from the map: none on trail centres, short and sparse at trail edges,
 * dense on the forest floor, reeds on marsh banks, natural patchiness, nothing
 * on cliffs. Blades root in the ground colour and lighten to the tip, bend in
 * gusts and part around the player. Density/height fade out with distance so
 * the edge of the field blends into the textured ground.
 */
import * as THREE from 'three';
import { biomeOfRegion, type BiomeId, type WalkField } from '@mazemeo/maze-core';
import type { Circle, Quality } from './foliage.ts';
import { env } from './shared.ts';

const BLADES = 10;
const SEGMENTS = 4; // enough segments for blades to arch, not stand like spikes

interface BiomeGrass {
  density: number;
  height: number;
  width: number;
  reed: boolean;
  root: number;
  tip: number;
}

const BIOME_GRASS: Record<BiomeId, BiomeGrass> = {
  // Root ≈ ground colour, tip only moderately lighter, so the carpet blends into the soil.
  bamboo: { density: 0.97, height: 0.3, width: 0.045, reed: false, root: 0x34421c, tip: 0x6c8538 },
  maple: { density: 0.08, height: 0.2, width: 0.045, reed: false, root: 0x4a3a1e, tip: 0x9a8a44 },
  shrine: { density: 0.9, height: 0.24, width: 0.042, reed: false, root: 0x28361c, tip: 0x546e30 },
  marsh: { density: 0.95, height: 1.4, width: 0.04, reed: true, root: 0x3a3a20, tip: 0xa89c5e },
  summit: { density: 0.45, height: 0.16, width: 0.035, reed: false, root: 0x4a4630, tip: 0x7e7a52 },
};

function bladeClump(): THREE.InstancedBufferGeometry {
  const pos: number[] = [];
  const blade: number[] = [];
  const idx: number[] = [];
  let rand = 12345;
  const rnd = (): number => {
    rand = (rand * 16807) % 2147483647;
    return rand / 2147483647;
  };
  for (let b = 0; b < BLADES; b++) {
    const start = pos.length / 3;
    const data = [rnd(), rnd() * 2 - 1, rnd() * 2 - 1, rnd()]; // facing, offX, offZ, height scale
    for (let s = 0; s < SEGMENTS; s++) {
      const t = s / SEGMENTS;
      pos.push(-0.5, t, 0, 0.5, t, 0);
      blade.push(...data, ...data);
    }
    pos.push(0, 1, 0); // pointed tip
    blade.push(...data);
    for (let s = 0; s < SEGMENTS - 1; s++) {
      const a = start + s * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    const last = start + (SEGMENTS - 1) * 2;
    idx.push(last, last + 1, last + 2);
  }
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aBlade', new THREE.Float32BufferAttribute(blade, 4));
  g.setIndex(idx);
  return g;
}

/**
 * Shared GLSL for GPU ground cover (grass, ferns): reading the walk field
 * texture (R height, G clearance, B region) plus hash/noise helpers.
 */
export const FIELD_GLSL = /* glsl */ `
uniform sampler2D uField;
uniform vec2 uFieldOrigin;
uniform float uFieldCell;
uniform float uFieldSize;
float gHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float gNoise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(gHash(i), gHash(i + vec2(1, 0)), f.x), mix(gHash(i + vec2(0, 1)), gHash(i + vec2(1, 1)), f.x), f.y);
}
vec4 fieldAt(vec2 xz) {
  vec2 g = (xz - uFieldOrigin) / uFieldCell;
  ivec2 i = clamp(ivec2(floor(g)), ivec2(0), ivec2(int(uFieldSize) - 2));
  vec2 f = clamp(g - vec2(i), 0.0, 1.0);
  vec4 a = texelFetch(uField, i, 0);
  vec4 b = texelFetch(uField, i + ivec2(1, 0), 0);
  vec4 c = texelFetch(uField, i + ivec2(0, 1), 0);
  vec4 d = texelFetch(uField, i + ivec2(1, 1), 0);
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
int regionAt(vec2 xz) {
  vec2 g = (xz - uFieldOrigin) / uFieldCell + 0.5;
  ivec2 i = clamp(ivec2(floor(g)), ivec2(0), ivec2(int(uFieldSize) - 1));
  return int(texelFetch(uField, i, 0).b + 0.5);
}
`;

/** Float texture of the walk field for FIELD_GLSL, plus its uniforms. */
export function fieldUniforms(field: WalkField, exclude: Circle[] = []): Record<string, THREE.IUniform> {
  const n = field.size;
  const data = new Float32Array(n * n * 4);
  for (let k = 0; k < n * n; k++) {
    data[k * 4] = field.height[k]!;
    data[k * 4 + 1] = field.clearance[k]!;
    data[k * 4 + 2] = field.region[k]!;
    if (exclude.length) {
      const x = field.originX + (k % n) * field.cellSize;
      const z = field.originZ + Math.floor(k / n) * field.cellSize;
      // A = 1 keeps ground cover off (e.g. the waterfall ledges and pool).
      data[k * 4 + 3] = exclude.some((c) => (x - c.x) ** 2 + (z - c.z) ** 2 < c.r ** 2) ? 1 : 0;
    }
  }
  const tex = new THREE.DataTexture(data, n, n, THREE.RGBAFormat, THREE.FloatType);
  tex.minFilter = tex.magFilter = THREE.NearestFilter;
  tex.needsUpdate = true;
  return {
    uField: { value: tex },
    uFieldOrigin: { value: new THREE.Vector2(field.originX, field.originZ) },
    uFieldCell: { value: field.cellSize },
    uFieldSize: { value: n },
  };
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
uniform vec4 uBiome[5];
uniform vec3 uRoot[5];
uniform vec3 uTip[5];
attribute vec4 aBlade;
varying vec3 vGrassCol;
`;

const VERT_MAIN = /* glsl */ `
  int gid = gl_InstanceID;
  vec2 gidx = vec2(float(gid % uGridW), float(gid / uGridW));
  vec2 cellPos = floor(uCenter / uCell) * uCell + (gidx - float(uGridW) * 0.5) * uCell;
  vec2 key = floor(cellPos / uCell + 0.5);
  float r1 = gHash(key), r2 = gHash(key + 7.13), r3 = gHash(key + 19.7), r4 = gHash(key + 31.1);
  vec2 clump = cellPos + (vec2(r1, r2) - 0.5) * uCell;
  vec4 fc = fieldAt(clump);
  int reg = regionAt(clump);
  vec4 bio = uBiome[reg];
  float clr = fc.g;

  // Density from the map: bare trail centre, thin trampled edges, full forest floor.
  float trail = smoothstep(-2.0, 0.6, clr) * (1.0 - fc.a);
  float dens = bio.x * trail;
  if (bio.w > 0.5) dens = bio.x * smoothstep(-1.2, -0.2, clr) * (1.0 - smoothstep(2.6, 4.0, clr)); // reeds on banks only
  float patchN = gNoise(clump * 0.07) * 0.65 + gNoise(clump * 0.23) * 0.35;
  dens *= mix(0.6, 1.0, smoothstep(0.25, 0.65, patchN)); // gentle patchiness, never bald
  float slope = length(vec2(fieldAt(clump + vec2(1.0, 0.0)).r - fc.r, fieldAt(clump + vec2(0.0, 1.0)).r - fc.r));
  dens *= 1.0 - smoothstep(0.65, 1.1, slope);

  // Distance LOD: thin out, then shrink to nothing at the field edge (no visible border).
  float dist = length(clump - uCenter);
  float lod = 1.0 - smoothstep(uRadius * 0.62, uRadius * 0.97, dist);
  float keep = step(r3, dens * mix(0.7, 1.0, lod));
  // Even heights within a clump (no lone tall spikes); shorter where trampled near trails.
  float H = bio.y * (0.75 + 0.35 * patchN) * (0.35 + 0.65 * trail) * (0.8 + 0.4 * aBlade.w) * keep * smoothstep(0.0, 0.4, lod);

  // Blade frame
  float ang = (aBlade.x + r4) * 6.2831;
  float ca = cos(r4 * 6.2831), sa = sin(r4 * 6.2831);
  vec2 off = mat2(ca, -sa, sa, ca) * aBlade.yz * uCell * 0.55;
  vec2 rootXZ = clump + off;
  float rootY = fieldAt(rootXZ).r - 0.02;
  vec3 facing = vec3(cos(ang), 0.0, sin(ang));
  vec3 side = vec3(-facing.z, 0.0, facing.x);
  float t = position.y;
  float w = bio.z * (1.0 - t * t * 0.8) * (0.8 + 0.4 * aBlade.w) * keep; // stays wide, then narrows near the tip

  // Natural lean + wind gusts + player trampling
  // Blades arch outward and droop under their own weight, like real grass.
  float lean = bio.w > 0.5 ? 0.12 + r1 * 0.2 : 0.35 + fract(r1 + aBlade.w) * 0.55;
  float front = dot(rootXZ, uWindDir) * 0.08 - uTime * (1.0 + uWindStrength * 1.5);
  float gust = 0.5 + 0.5 * sin(front) * sin(front * 0.43 + 1.3);
  float flutter = sin(uTime * (2.2 + r2 * 1.5) + r1 * 6.28 + t * 2.0) * 0.12;
  vec2 wind = uWindDir * uWindStrength * (0.3 + 0.7 * gust) + uWindDir.yx * vec2(-1.0, 1.0) * flutter * (0.3 + uWindStrength);
  vec2 away = rootXZ - uPlayer.xz;
  float pd = length(away);
  float press = (1.0 - smoothstep(0.2, 1.0, pd)) * step(abs(uPlayer.y - rootY), 2.2);
  vec2 push = (pd > 1e-3 ? away / pd : vec2(0.0)) * press * 1.3;
  vec2 bend = facing.xz * lean + wind + push;
  float b2 = t * t;
  vec3 grassPos = vec3(rootXZ.x, rootY, rootXZ.y) + side * position.x * w + vec3(0.0, t * H, 0.0) + vec3(bend.x, 0.0, bend.y) * b2 * H;
  grassPos.y -= b2 * H * min(dot(bend, bend) * 0.3, 0.6); // keep blade length ~constant when bent

  // Soft, mostly-up normals so a field of blades lights like a surface.
  vec3 objectNormal = normalize(mix(vec3(0.0, 1.0, 0.0), facing * sign(position.x + 0.001) * 0.7 + vec3(bend.x, 0.0, bend.y) * 0.3, 0.3));

  // Colour: ground-coloured root -> lighter tip, dry patches, per-blade variation.
  float dry = smoothstep(0.55, 0.85, gNoise(clump * 0.05 + 11.0));
  vec3 tipC = mix(uTip[reg], vec3(0.36, 0.32, 0.15), dry * 0.35);
  vGrassCol = mix(uRoot[reg], tipC, smoothstep(0.0, 0.8, t)) * (0.88 + 0.24 * fract(r3 * 7.7 + aBlade.w));
  // Wildflowers: a few blades per clump in the pine and bamboo forests carry a
  // small blossom at the tip (yellow, white or violet).
  if ((reg == 0 || reg == 2) && fract(r1 * 17.3 + aBlade.x * 7.1) < 0.05 && t > 0.7) {
    float k = fract(r2 * 9.7);
    vec3 bloom = k < 0.45 ? vec3(0.95, 0.72, 0.12) : k < 0.75 ? vec3(0.92, 0.92, 0.86) : vec3(0.52, 0.32, 0.78);
    vGrassCol = bloom;
  }
`;

export class Grass {
  readonly mesh: THREE.Mesh;
  private readonly uniforms: Record<string, THREE.IUniform>;
  private fieldTex: THREE.DataTexture | null = null;
  private readonly geo: THREE.InstancedBufferGeometry;

  constructor(quality: Quality) {
    this.geo = bladeClump();
    this.uniforms = {
      uField: { value: null },
      uFieldOrigin: { value: new THREE.Vector2() },
      uFieldCell: { value: 2 },
      uFieldSize: { value: 2 },
      uCenter: { value: new THREE.Vector2() },
      uCell: { value: 0.42 },
      uGridW: { value: 180 },
      uRadius: { value: 38 },
      uTime: env.uTime,
      uWindDir: env.uWindDir,
      uWindStrength: env.uWindStrength,
      uPlayer: { value: new THREE.Vector3(1e6, 0, 1e6) },
      uBiome: { value: Array.from({ length: 5 }, () => new THREE.Vector4()) },
      uRoot: { value: Array.from({ length: 5 }, () => new THREE.Color()) },
      uTip: { value: Array.from({ length: 5 }, () => new THREE.Color()) },
    };
    this.setQuality(quality);
    const mat = new THREE.MeshStandardMaterial({ side: THREE.DoubleSide, roughness: 0.85 });
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\n${VERT_PARS}`)
        .replace('#include <beginnormal_vertex>', VERT_MAIN)
        .replace('#include <begin_vertex>', 'vec3 transformed = grassPos;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vGrassCol;')
        .replace('#include <normal_fragment_begin>', THREE.ShaderChunk.normal_fragment_begin.replace(/normal \*= faceDirection;/g, ''))
        .replace('#include <map_fragment>', 'diffuseColor.rgb *= vGrassCol;')
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += diffuseColor.rgb * 0.08;');
    };
    mat.customProgramCacheKey = () => 'gpu-grass';
    this.mesh = new THREE.Mesh(this.geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.receiveShadow = true;
    this.mesh.castShadow = false;
    this.mesh.name = 'grass';
  }

  setQuality(quality: Quality): void {
    const gridW = quality === 'high' ? 150 : 96;
    const cell = quality === 'high' ? 0.45 : 0.55;
    this.uniforms.uGridW!.value = gridW;
    this.uniforms.uCell!.value = cell;
    this.uniforms.uRadius!.value = gridW * cell * 0.5;
    this.geo.instanceCount = gridW * gridW;
  }

  /** Upload the walk field (height, clearance, region) for the current maze. */
  setField(field: WalkField, exclude: Circle[] = []): void {
    this.fieldTex?.dispose();
    const fu = fieldUniforms(field, exclude);
    this.fieldTex = fu.uField!.value as THREE.DataTexture;
    for (const key of ['uField', 'uFieldOrigin', 'uFieldCell', 'uFieldSize']) this.uniforms[key]!.value = fu[key]!.value;
    // Region id -> biome parameters (region ids are 0..4).
    for (let r = 0; r < 5; r++) {
      const b = BIOME_GRASS[biomeOfRegion(r)];
      (this.uniforms.uBiome!.value as THREE.Vector4[])[r]!.set(b.density, b.height, b.width, b.reed ? 1 : 0);
      (this.uniforms.uRoot!.value as THREE.Color[])[r]!.set(b.root);
      (this.uniforms.uTip!.value as THREE.Color[])[r]!.set(b.tip);
    }
  }

  update(camera: THREE.Camera, player: THREE.Vector3 | null, visible: boolean): void {
    this.mesh.visible = visible;
    (this.uniforms.uCenter!.value as THREE.Vector2).set(camera.position.x, camera.position.z);
    if (player) (this.uniforms.uPlayer!.value as THREE.Vector3).copy(player);
    else (this.uniforms.uPlayer!.value as THREE.Vector3).set(1e6, 0, 1e6);
  }
}
