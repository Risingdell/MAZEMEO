/**
 * Hero landmark for the autumn ravine: a stepped waterfall beside the trail
 * near the ravine spawn (P6 when it is in the Maple Ravine).
 *
 * It descends the ravine wall on the uphill side over five mossy granite
 * ledges into a pool at the trail edge: rippling ledge water, falling sheets
 * with animated streaks, foam, spray mist and floating leaves. The pool basin
 * is carved into the walk field (before terrain/physics are built), so water
 * sits in a real hollow. Fully deterministic from the maze.
 */
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { DEFAULT_CONFIG, biomeOfRegion, clearanceAt, edgeCost, heightAt, shortestPath, valueNoise, type Maze, type WalkField } from '@mazemeo/maze-core';
import type { Circle, TrunkCollider } from './foliage.ts';
import { env } from './shared.ts';
import type { EnvTextures } from './textures.ts';

export interface Cascade {
  group: THREE.Group;
  /** Where the water sound comes from. */
  soundAt: THREE.Vector3;
  colliders: TrunkCollider[];
  /** Circles to keep clear of trees and boulders. */
  footprint: Circle[];
  /** A good place to stand (on the far side of the trail) and where to look. */
  viewpoint: { from: THREE.Vector3; to: THREE.Vector3 };
  /** @param light approximate scene light colour (for the unlit water sheets). */
  update(light: THREE.Color): void;
}

const TIERS = 5;

/** Pick the spawn the cascade belongs to: P6 if it's in the ravine, else the first ravine spawn. */
export function ravineSpawn(maze: Maze): number | null {
  const isRavine = (id: number): boolean => biomeOfRegion(maze.nodes[id]!.regionId) === 'maple';
  const p6 = maze.spawns[5];
  if (p6 !== undefined && isRavine(p6)) return p6;
  return maze.spawns.find(isRavine) ?? null;
}

const SHEET_VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

const SHEET_FRAG = /* glsl */ `
uniform float uTime;
uniform vec3 uLight;
uniform vec3 uDeep;
uniform float uSeed;
varying vec2 vUv;
float h1(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float n2(vec2 p) { vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h1(i), h1(i + vec2(1, 0)), f.x), mix(h1(i + vec2(0, 1)), h1(i + vec2(1, 1)), f.x), f.y); }
void main() {
  float x = vUv.x;
  float y = vUv.y; // 1 = lip, 0 = bottom
  float cols = n2(vec2(x * 14.0 + uSeed, 0.5));
  float s1 = n2(vec2(x * 26.0 + uSeed, y * 2.5 + uTime * 3.2));
  float s2 = n2(vec2(x * 70.0 - uSeed, y * 7.0 + uTime * 5.5));
  float streak = s1 * 0.6 + s2 * 0.4;
  float a = mix(0.3, 0.92, streak) * mix(0.65, 1.0, cols);
  a *= smoothstep(0.0, 0.14, x) * smoothstep(1.0, 0.86, x);
  a *= smoothstep(0.0, 0.08, y + 0.02);
  float white = clamp(streak * 0.75 + (1.0 - y) * 0.45, 0.0, 1.0);
  vec3 c = mix(uDeep, vec3(0.93, 0.96, 0.98), white) * uLight;
  gl_FragColor = vec4(c, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

const FOAM_FRAG = /* glsl */ `
uniform float uTime;
uniform vec3 uLight;
varying vec2 vUv;
float h1(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float n2(vec2 p) { vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h1(i), h1(i + vec2(1, 0)), f.x), mix(h1(i + vec2(0, 1)), h1(i + vec2(1, 1)), f.x), f.y); }
void main() {
  vec2 c = vUv - 0.5;
  float r = length(c) * 2.0;
  float ang = atan(c.y, c.x);
  float n = n2(vec2(ang * 3.0, r * 6.0 - uTime * 1.6)) * 0.6 + n2(vec2(ang * 9.0, r * 14.0 - uTime * 2.4)) * 0.4;
  float a = smoothstep(1.0, 0.25, r) * smoothstep(0.35, 0.75, n) * 0.85;
  gl_FragColor = vec4(vec3(0.95) * uLight, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export function buildCascade(maze: Maze, field: WalkField, tex: EnvTextures): Cascade | null {
  const spawnId = ravineSpawn(maze);
  if (spawnId === null) return null;
  const S = maze.nodes[spawnId]!;
  const route = shortestPath(maze, S.id, maze.exit, (e) => edgeCost(e, DEFAULT_CONFIG));
  const N = maze.nodes[route[1] ?? maze.exit]!;
  const d = new THREE.Vector2(N.x - S.x, N.z - S.z);
  const edgeLen = d.length();
  d.normalize();
  const p = new THREE.Vector2(-d.y, d.x);
  const along = Math.min(15, edgeLen * 0.45);
  const O = new THREE.Vector2(S.x, S.z).addScaledVector(d, along);
  // Uphill side of the trail.
  const rise = (side: number): number => heightAt(field, O.x + p.x * side * 18, O.y + p.y * side * 18);
  const side = rise(1) >= rise(-1) ? 1 : -1;
  const edgeOff = DEFAULT_CONFIG.pathHalfWidth + 3.4;
  const B = O.clone().addScaledVector(p, side * edgeOff);
  const T = O.clone().addScaledVector(p, side * (edgeOff + 17));
  const yPool = heightAt(field, B.x, B.y) - 0.1;
  const flow = B.clone().sub(T).normalize(); // downhill, towards the trail
  const perp = new THREE.Vector2(flow.y, -flow.x);
  const yaw = Math.atan2(flow.x, flow.y);
  const total = T.distanceTo(B);
  const segLen = total / (TIERS - 1); // last tier centre = the pool
  const tierCenter = (i: number): THREE.Vector2 => T.clone().lerp(B, i / (TIERS - 1));
  const tierWidth = (i: number): number => 5.6 - i * 0.3;

  // Ledge stones sit on the real slope like stone steps (slightly proud of the
  // ground) and always step down at least 0.9 m, so every ledge has a visible fall.
  const tierY: number[] = new Array<number>(TIERS).fill(0);
  tierY[TIERS - 1] = yPool + 0.05; // the last fall lands straight in the pool
  for (let i = TIERS - 2; i >= 0; i--) {
    const C = tierCenter(i);
    tierY[i] = Math.max(heightAt(field, C.x, C.y) + 0.55, tierY[i + 1]! + 0.9);
  }
  const yTop = tierY[0]!;

  // Press the ground down under each ledge stone's own footprint (the stone
  // covers the cut), so the 2 m terrain grid can never poke through a ledge.
  for (let j = 0; j < field.size; j++) {
    for (let i = 0; i < field.size; i++) {
      const x = field.originX + i * field.cellSize;
      const z = field.originZ + j * field.cellSize;
      const rx = x - T.x;
      const rz = z - T.y;
      const u = rx * flow.x + rz * flow.y;
      if (u < -segLen * 0.7 || u > total) continue;
      const tier = THREE.MathUtils.clamp(Math.round(u / segLen), 0, TIERS - 1);
      if (tier === TIERS - 1) continue; // the pool, not a ledge
      if (Math.abs(rx * perp.x + rz * perp.y) > tierWidth(tier) / 2 + 0.3) continue;
      const k = j * field.size + i;
      if (field.clearance[k]! < 0.3) continue;
      field.height[k] = Math.min(field.height[k]!, tierY[tier]! - 0.3);
    }
  }

  // --- Carve the pool basin into the walk field (lowering only, off the trail).
  const poolR = 3.6;
  for (let j = 0; j < field.size; j++) {
    for (let i = 0; i < field.size; i++) {
      const x = field.originX + i * field.cellSize;
      const z = field.originZ + j * field.cellSize;
      const dd = Math.hypot(x - B.x, z - B.y);
      if (dd > poolR + 1.5) continue;
      const k = j * field.size + i;
      if (field.clearance[k]! < 0.3) continue;
      const floor = yPool - 0.75 * Math.max(0, 1 - (dd / poolR) ** 2) - 0.05;
      const blend = THREE.MathUtils.smoothstep(dd, poolR + 1.5, poolR - 0.5);
      field.height[k] = Math.min(field.height[k]!, THREE.MathUtils.lerp(field.height[k]!, floor, blend));
    }
  }

  const group = new THREE.Group();
  group.name = 'cascade';
  const colliders: TrunkCollider[] = [];
  const stoneMat = new THREE.MeshStandardMaterial({ map: tex.granite, bumpMap: tex.granite, bumpScale: 1.0, vertexColors: true, roughness: 0.85, color: 0xd8ccc4 });
  const light = new THREE.Color(1, 1, 1);
  const sheetMats: THREE.ShaderMaterial[] = [];

  const stone = (w: number, h: number, l: number, seed: number): THREE.BufferGeometry => {
    const g = new RoundedBoxGeometry(w, h, l, 4, Math.min(w, h, l) * 0.22);
    const pos = g.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      const z = pos.getZ(i);
      const n = valueNoise(seed, x * 0.9 + 4, z * 0.9 + y * 0.7) * 0.18 + valueNoise(seed + 1, x * 2.5, z * 2.5) * 0.06;
      pos.setXYZ(i, x * (1 + n), y + (y > 0 ? n * 0.25 : 0), z * (1 + n * 0.6));
    }
    g.computeVertexNormals();
    // Moss on top, wet-dark lower down.
    const nrm = g.getAttribute('normal') as THREE.BufferAttribute;
    const col = new Float32Array(pos.count * 3);
    const c = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const up = THREE.MathUtils.smoothstep(nrm.getY(i), 0.5, 0.9);
      const patchy = valueNoise(seed + 2, pos.getX(i) * 1.6, pos.getZ(i) * 1.6) * 0.5 + 0.5;
      c.setRGB(1, 1, 1).lerp(new THREE.Color(0.22, 0.32, 0.09), up * THREE.MathUtils.smoothstep(patchy, 0.4, 0.7) * 0.85);
      if (pos.getY(i) < 0) c.multiplyScalar(0.7);
      col.set([c.r, c.g, c.b], i * 3);
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    return g;
  };

  // Dark, slightly soft reflections: a shaded forest pool, not a mirror of the sky.
  const ledgeWaterMat = new THREE.MeshStandardMaterial({ color: 0x1c2620, roughness: 0.12, transparent: true, opacity: 0.9, envMapIntensity: 0.55 });
  ledgeWaterMat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = env.uTime;
    shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\nvarying vec2 vFlowUv;').replace('#include <uv_vertex>', '#include <uv_vertex>\nvFlowUv = uv;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vFlowUv;\nuniform float uTime;')
      .replace(
        '#include <normal_fragment_maps>',
        `{
          // uv.y runs upstream after the plane is laid flat, so flip it: fy = 0 top, 1 at the lip.
          vec2 q = vec2(vFlowUv.x, 1.0 - vFlowUv.y) * vec2(6.0, 4.0) - vec2(0.0, uTime * 1.4);
          vec2 dn = vec2(sin(q.x * 3.1 + q.y * 2.0), cos(q.y * 4.3 - q.x)) * 0.12 + vec2(sin(q.y * 9.0 + q.x * 5.0) * 0.05);
          normal = normalize(normal + vec3(dn.x, 0.0, dn.y));
        }`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        float foamEdge = smoothstep(0.78, 1.0, 1.0 - vFlowUv.y) * (0.5 + 0.5 * sin(vFlowUv.x * 40.0 + uTime * 6.0));
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.85), foamEdge * 0.5);`,
      );
  };
  ledgeWaterMat.customProgramCacheKey = () => 'cascade-ledge-water';

  const place = (obj: THREE.Object3D, at: THREE.Vector2, y: number): void => {
    obj.position.set(at.x, y, at.y);
    obj.rotation.y = yaw;
    group.add(obj);
  };

  for (let i = 0; i < TIERS; i++) {
    const C = tierCenter(i);
    const w = tierWidth(i);
    const top = tierY[i]!;
    // Each ledge stone is a full step: it runs back under the step above and
    // reaches down past the next step, so every riser is stone, never bare ground.
    const below = i < TIERS - 1 ? tierY[i + 1]! - 1.2 : Math.min(heightAt(field, C.x, C.y), top) - 1.6;
    const thick = top - below;
    if (i < TIERS - 1) {
      // Ledge stone (the last tier is the pool itself)
      const slab = new THREE.Mesh(stone(w, thick, segLen * 1.35, 900 + i * 7), stoneMat);
      slab.castShadow = slab.receiveShadow = true;
      // Downstream end flush with the lip (where the fall starts), extra length runs upstream.
      place(slab, C.clone().addScaledVector(flow, -segLen * 0.205), top - 0.12 - thick / 2);
    }
    // Framing boulders either side
    for (const s of [-1, 1]) {
      const bs = 1.1 + ((i * 13 + (s > 0 ? 5 : 0)) % 7) * 0.12;
      const side2 = perp.clone().multiplyScalar(s * (w * 0.5 + bs * 0.6));
      const at = C.clone().add(side2);
      const boulder = new THREE.Mesh(stone(bs * 1.6, bs * 1.3, bs * 1.5, 1300 + i * 11 + s), stoneMat);
      boulder.castShadow = boulder.receiveShadow = true;
      place(boulder, at, heightAt(field, at.x, at.y) + bs * 0.15); // resting on the ground
      boulder.rotation.y += i + s;
      colliders.push({ x: at.x, y: heightAt(field, at.x, at.y), z: at.y, radius: bs * 0.8, height: 2.5 });
    }
    if (i === TIERS - 1) continue;
    // Water flowing across the ledge
    const water = new THREE.Mesh(new THREE.PlaneGeometry(w * 0.72, segLen * 0.95, 1, 1).rotateX(-Math.PI / 2), ledgeWaterMat);
    water.receiveShadow = true;
    place(water, C, top + 0.02);
    // Falling sheet off the lip down to the next ledge
    const drop = top - tierY[i + 1]!;
    const sheetGeo = new THREE.PlaneGeometry(w * 0.55, 1, 10, 14);
    const sp = sheetGeo.getAttribute('position') as THREE.BufferAttribute;
    const uvs = sheetGeo.getAttribute('uv') as THREE.BufferAttribute;
    for (let k = 0; k < sp.count; k++) {
      const v = uvs.getY(k); // 1 top .. 0 bottom
      const t = 1 - v;
      // Parabolic arc: the water shoots slightly out, then falls.
      sp.setXYZ(k, sp.getX(k) * (1 + t * 0.15), -t * drop, Math.sqrt(t) * 0.75 + t * 0.2);
    }
    sheetGeo.computeVertexNormals();
    const sheetMat = new THREE.ShaderMaterial({
      uniforms: { uTime: env.uTime, uLight: { value: light }, uDeep: { value: new THREE.Color(0.32, 0.42, 0.42) }, uSeed: { value: i * 3.7 } },
      vertexShader: SHEET_VERT,
      fragmentShader: SHEET_FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    sheetMats.push(sheetMat);
    const sheet = new THREE.Mesh(sheetGeo, sheetMat);
    const lip = C.clone().addScaledVector(flow, segLen * 0.47);
    place(sheet, lip, top + 0.03);
    // Foam where it lands
    const foamMat = new THREE.ShaderMaterial({ uniforms: { uTime: env.uTime, uLight: { value: light } }, vertexShader: SHEET_VERT, fragmentShader: FOAM_FRAG, transparent: true, depthWrite: false });
    const foam = new THREE.Mesh(new THREE.CircleGeometry(w * 0.32, 24).rotateX(-Math.PI / 2), foamMat);
    place(foam, lip.clone().addScaledVector(flow, 0.9), tierY[i + 1]! + 0.06);
  }

  // Pool at the bottom (trail edge)
  const poolMat = ledgeWaterMat.clone();
  poolMat.onBeforeCompile = ledgeWaterMat.onBeforeCompile;
  poolMat.customProgramCacheKey = ledgeWaterMat.customProgramCacheKey;
  const pool = new THREE.Mesh(new THREE.CircleGeometry(poolR, 40).rotateX(-Math.PI / 2), poolMat);
  pool.receiveShadow = true;
  place(pool, B, yPool);
  // Pool rim stones
  for (let k = 0; k < 9; k++) {
    const a = (k / 9) * Math.PI * 2 + 0.3;
    const at = B.clone().add(new THREE.Vector2(Math.cos(a), Math.sin(a)).multiplyScalar(poolR + 0.2));
    if (clearanceAt(field, at.x, at.y) < 0.2) continue; // keep the trail clear
    const s = 0.5 + ((k * 7) % 5) * 0.12;
    const rim = new THREE.Mesh(stone(s * 1.4, s, s * 1.2, 1700 + k), stoneMat);
    rim.castShadow = rim.receiveShadow = true;
    place(rim, at, heightAt(field, at.x, at.y) + s * 0.25);
    rim.rotation.y = a;
  }

  // Spray mist at each landing
  const mistCount = 160;
  const mistPos = new Float32Array(mistCount * 3);
  const mistSeed = new Float32Array(mistCount);
  for (let k = 0; k < mistCount; k++) {
    const tier = 1 + (k % (TIERS - 1));
    const C = tierCenter(tier - 1).addScaledVector(flow, segLen * 0.47 + 0.9);
    mistPos.set([C.x + (Math.random() - 0.5) * 2.5, tierY[tier]! + 0.2, C.y + (Math.random() - 0.5) * 2.5], k * 3);
    mistSeed[k] = Math.random();
  }
  const mistGeo = new THREE.BufferGeometry();
  mistGeo.setAttribute('position', new THREE.BufferAttribute(mistPos, 3));
  mistGeo.setAttribute('aSeed', new THREE.BufferAttribute(mistSeed, 1));
  const mistMat = new THREE.ShaderMaterial({
    uniforms: { uTime: env.uTime, uLight: { value: light } },
    transparent: true,
    depthWrite: false,
    vertexShader: /* glsl */ `
      attribute float aSeed; uniform float uTime; varying float vA;
      void main() {
        float life = fract(uTime * 0.25 + aSeed);
        vec3 p = position + vec3(sin(aSeed * 40.0 + uTime) * 0.3, life * 1.8, cos(aSeed * 31.0 + uTime) * 0.3);
        vA = sin(life * 3.14159) * 0.22;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_PointSize = (0.8 + life * 1.6) * 260.0 / -mv.z;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uLight; varying float vA;
      void main() {
        float r = length(gl_PointCoord - 0.5) * 2.0;
        gl_FragColor = vec4(vec3(0.95) * uLight, smoothstep(1.0, 0.0, r) * vA);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const mist = new THREE.Points(mistGeo, mistMat);
  mist.frustumCulled = false;
  group.add(mist);

  // Floating leaves on the pool, drifting slowly.
  const leafMat = new THREE.MeshStandardMaterial({ map: tex.leafAtlas, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.6 });
  const leafCount = 22;
  const leaves = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.16, 0.16).rotateX(-Math.PI / 2), leafMat, leafCount);
  const leafUv = new Float32Array(leafCount * 2);
  for (let k = 0; k < leafCount; k++) leafUv.set([k % 2 ? 0.5 : 0, 0.5], k * 2);
  leaves.geometry.setAttribute('aUvOff', new THREE.InstancedBufferAttribute(leafUv, 2));
  leafMat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec2 aUvOff;')
      .replace('#include <uv_vertex>', '#include <uv_vertex>\nvMapUv = vMapUv * 0.5 + aUvOff;');
  };
  leafMat.customProgramCacheKey = () => 'cascade-leaves';
  const leafPhase = Array.from({ length: leafCount }, (_, k) => ({ r: 0.5 + ((k * 37) % 30) / 10, a: k * 2.4, s: 0.05 + ((k * 13) % 10) / 100 }));
  for (let k = 0; k < leafCount; k++) leaves.setColorAt(k, new THREE.Color().setHSL(0.03 + ((k * 7) % 9) / 100, 0.85, 0.45));
  group.add(leaves);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const one = new THREE.Vector3(1, 1, 1);
  // Viewpoint: far side of the trail, looking up the falls.
  const stand = O.clone().addScaledVector(p, -side * (DEFAULT_CONFIG.pathHalfWidth - 0.8));
  const lookAt = B.clone().lerp(T, 0.4);

  return {
    group,
    soundAt: new THREE.Vector3(B.x, yPool + 1.5, B.y).lerp(new THREE.Vector3(T.x, yTop, T.y), 0.3),
    colliders,
    viewpoint: {
      from: new THREE.Vector3(stand.x, heightAt(field, stand.x, stand.y) + 1.7, stand.y),
      to: new THREE.Vector3(lookAt.x, THREE.MathUtils.lerp(yPool, yTop, 0.38), lookAt.y),
    },
    footprint: Array.from({ length: TIERS + 2 }, (_, k) => {
      const c = T.clone().lerp(B, Math.min(1.1, k / TIERS));
      return { x: c.x, z: c.y, r: 5.5 };
    }),
    update(lightColor: THREE.Color): void {
      light.copy(lightColor);
      const t = env.uTime.value;
      leafPhase.forEach((lp, k) => {
        const a = lp.a + t * lp.s;
        const r = Math.min(poolR - 0.4, lp.r);
        q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), a * 1.7);
        m.compose(new THREE.Vector3(B.x + Math.cos(a) * r, yPool + 0.015, B.y + Math.sin(a) * r), q, one);
        leaves.setMatrixAt(k, m);
      });
      leaves.instanceMatrix.needsUpdate = true;
    },
  };
}
