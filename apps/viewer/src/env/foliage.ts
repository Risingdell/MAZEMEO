/**
 * Forest walls: trees, bamboo, dead trees, rocks and stone lanterns.
 * (Grass and reeds are GPU-generated around the player: see grass.ts.)
 *
 * Each species has a few hand-built (procedural) variants in world units.
 * Instances are bucketed into spatial chunks so off-screen chunks are culled,
 * and every material bends in the shared wind. Trunk/rock positions are
 * returned for the physics world.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { DEFAULT_CONFIG, Rng, biomeOfRegion, clearanceAt, heightAt, regionAt, valueNoise, type BiomeId, type Maze, type WalkField } from '@mazemeo/maze-core';
import { applyWind, setSwayByHeight, setSwayConst, windDepthMaterial, type WindOptions } from './shared.ts';
import type { EnvTextures } from './textures.ts';

export interface TrunkCollider {
  x: number;
  y: number;
  z: number;
  radius: number;
  height: number;
}

export interface RockCollider {
  x: number;
  y: number;
  z: number;
  radius: number;
}

export interface Foliage {
  group: THREE.Group;
  trunks: TrunkCollider[];
  rocks: RockCollider[];
  instanceCount: number;
}

export type Quality = 'high' | 'low';

const CHUNK = 110;
const WHITE = new THREE.Color(1, 1, 1);

// --- geometry helpers ----------------------------------------------------------

/** Card (quad) facing +Z, centred, with a sway attribute filled later. */
function card(w: number, h: number): THREE.BufferGeometry {
  return new THREE.PlaneGeometry(w, h);
}

/** Point every vertex normal away from `center` (soft, volumetric foliage lighting). */
function crownNormals(geo: THREE.BufferGeometry, center: THREE.Vector3, upBias = 0.6): void {
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const nrm = geo.getAttribute('normal') as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.set(pos.getX(i) - center.x, pos.getY(i) - center.y + upBias, pos.getZ(i) - center.z).normalize();
    nrm.setXYZ(i, v.x, v.y, v.z);
  }
}

function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  // mergeGeometries needs all-indexed or all-non-indexed inputs.
  const allIndexed = parts.every((p) => p.index);
  const prepared = allIndexed ? parts : parts.map((p) => (p.index ? p.toNonIndexed() : p));
  const g = mergeGeometries(prepared, false);
  if (!g) throw new Error('mergeGeometries failed');
  g.computeBoundingSphere();
  return g;
}

/** Tapered cylinder from `a` to `b`. */
function limb(a: THREE.Vector3, b: THREE.Vector3, r0: number, r1: number, radial = 6, segs = 3): THREE.BufferGeometry {
  const len = a.distanceTo(b);
  const g = new THREE.CylinderGeometry(r1, r0, len, radial, segs, true).translate(0, len / 2, 0);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
  g.applyQuaternion(q).translate(a.x, a.y, a.z);
  return g;
}

/** Random leaf-card cluster in a sphere. */
function cardCluster(rng: Rng, center: THREE.Vector3, radius: number, cards: number, size: number): THREE.BufferGeometry[] {
  const out: THREE.BufferGeometry[] = [];
  const e = new THREE.Euler();
  for (let i = 0; i < cards; i++) {
    const g = card(size * rng.range(0.8, 1.2), size * rng.range(0.8, 1.2));
    e.set(rng.range(-1.2, 1.2), rng.range(0, Math.PI * 2), rng.range(-0.6, 0.6));
    g.applyQuaternion(new THREE.Quaternion().setFromEuler(e));
    const dir = new THREE.Vector3(rng.range(-1, 1), rng.range(-0.5, 1), rng.range(-1, 1)).normalize();
    const p = center.clone().addScaledVector(dir, radius * Math.sqrt(rng.next()) * 0.75);
    g.translate(p.x, p.y, p.z);
    crownNormals(g, center);
    out.push(g);
  }
  return out;
}

/**
 * Flat, layered leaf sprays (Japanese-maple habit): cards lie nearly horizontal
 * in tiers, so from below/through the canopy you see layers of lit leaves.
 */
function sprayCluster(rng: Rng, center: THREE.Vector3, radius: number, cards: number, size: number): THREE.BufferGeometry[] {
  const out: THREE.BufferGeometry[] = [];
  for (let i = 0; i < cards; i++) {
    const g = card(size * rng.range(0.85, 1.2), size * rng.range(0.85, 1.2));
    g.rotateX(-Math.PI / 2 + rng.range(-0.35, 0.35));
    g.rotateY(rng.range(0, Math.PI * 2));
    const a = rng.range(0, Math.PI * 2);
    const r = radius * Math.sqrt(rng.next());
    const p = new THREE.Vector3(center.x + Math.cos(a) * r, center.y + rng.range(-0.35, 0.35) - (r / radius) * 0.5, center.z + Math.sin(a) * r);
    g.translate(p.x, p.y, p.z);
    crownNormals(g, center, 1.2);
    out.push(g);
  }
  return out;
}

// --- species --------------------------------------------------------------------

interface Variant {
  /** `tint: false` parts (bark, rock) ignore the per-instance colour. */
  parts: Array<{ geo: THREE.BufferGeometry; mat: THREE.Material; shadow: boolean; depth?: THREE.Material; tint?: boolean }>;
  height: number;
  trunkRadius: number;
}

interface Materials {
  bark: THREE.MeshStandardMaterial;
  greyBark: THREE.MeshStandardMaterial;
  deadBark: THREE.MeshStandardMaterial;
  mapleLeaf: THREE.MeshStandardMaterial;
  mapleDepth: THREE.Material;
  needle: THREE.MeshStandardMaterial;
  needleDepth: THREE.Material;
  pineBark: THREE.MeshStandardMaterial;
  pineNeedle: THREE.MeshStandardMaterial;
  pineNeedleDepth: THREE.Material;
  cedarCore: THREE.MeshStandardMaterial;
  stalk: THREE.MeshStandardMaterial;
  bambooLeaf: THREE.MeshStandardMaterial;
  bambooDepth: THREE.Material;
  rock: THREE.MeshStandardMaterial;
  stone: THREE.MeshStandardMaterial;
  trunkDepth: THREE.Material;
  stalkDepth: THREE.Material;
}

function makeMaterials(tex: EnvTextures): Materials {
  const wind = (m: THREE.MeshStandardMaterial, o: WindOptions): THREE.MeshStandardMaterial => {
    applyWind(m, o);
    return m;
  };
  const TRUNK: WindOptions = { bendScale: 0.012, flutter: 0 };
  const LEAF: WindOptions = { bendScale: 0.02, flutter: 0.05, foliage: true };
  const NEEDLE: WindOptions = { bendScale: 0.014, flutter: 0.025, foliage: true };
  const STALK: WindOptions = { bendScale: 0.055, flutter: 0 };
  const BLEAF: WindOptions = { bendScale: 0.055, flutter: 0.06, foliage: true };
  tex.bark.repeat.set(2, 3);
  tex.pineBark.repeat.set(5, 32); // plates ~15–25 cm, like real ponderosa bark
  tex.bamboo.repeat.set(1, 30);
  const leafCommon = { alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.75 } as const;
  return {
    bark: wind(new THREE.MeshStandardMaterial({ map: tex.bark, roughness: 0.95 }), TRUNK),
    // Smooth dark grey-brown hardwood bark (the tall trunks in the mist).
    greyBark: wind(new THREE.MeshStandardMaterial({ map: tex.bark, color: 0x5e5853, roughness: 0.8 }), TRUNK),
    deadBark: wind(new THREE.MeshStandardMaterial({ map: tex.bark, color: 0x9a948c, roughness: 1 }), TRUNK),
    mapleLeaf: wind(new THREE.MeshStandardMaterial({ map: tex.mapleCard, ...leafCommon }), LEAF),
    mapleDepth: windDepthMaterial(LEAF, tex.mapleCard),
    needle: wind(new THREE.MeshStandardMaterial({ map: tex.needleCard, ...leafCommon, roughness: 0.85 }), NEEDLE),
    needleDepth: windDepthMaterial(NEEDLE, tex.needleCard),
    pineBark: wind(new THREE.MeshStandardMaterial({ map: tex.pineBark, bumpMap: tex.pineBark, bumpScale: 2, roughness: 0.95 }), TRUNK),
    pineNeedle: wind(new THREE.MeshStandardMaterial({ map: tex.pineNeedles, ...leafCommon, roughness: 0.8 }), NEEDLE),
    pineNeedleDepth: windDepthMaterial(NEEDLE, tex.pineNeedles),
    cedarCore: wind(new THREE.MeshStandardMaterial({ color: 0x1a2a1c, roughness: 1 }), NEEDLE),
    stalk: wind(new THREE.MeshStandardMaterial({ map: tex.bamboo, roughness: 0.55 }), STALK),
    bambooLeaf: wind(new THREE.MeshStandardMaterial({ map: tex.bambooCard, ...leafCommon }), BLEAF),
    bambooDepth: windDepthMaterial(BLEAF, tex.bambooCard),
    // Granite with lichen (texture) and moss on top (vertex colour).
    rock: new THREE.MeshStandardMaterial({ map: tex.granite, bumpMap: tex.granite, bumpScale: 1.2, vertexColors: true, roughness: 0.9 }),
    stone: new THREE.MeshStandardMaterial({ color: 0x8a8780, roughness: 0.95 }),
    trunkDepth: windDepthMaterial(TRUNK),
    stalkDepth: windDepthMaterial(STALK),
  };
}

/**
 * Understory Japanese maple (3.5–6 m): short leaning trunk splitting into a
 * few limbs that carry flat tiers of leaves at eye level — the low orange
 * branches that hang over the path.
 */
function mapleVariant(rng: Rng, m: Materials): Variant {
  const H = rng.range(3.5, 6);
  const lean = new THREE.Vector3(rng.range(-0.6, 0.6), 0, rng.range(-0.6, 0.6));
  const fork = new THREE.Vector3(lean.x, H * 0.38, lean.z);
  const wood: THREE.BufferGeometry[] = [limb(new THREE.Vector3(0, -0.3, 0), fork, 0.16, 0.1, 7, 4)];
  const leaves: THREE.BufferGeometry[] = [];
  const limbs = rng.int(3, 6);
  for (let b = 0; b < limbs; b++) {
    const a = (b / limbs) * Math.PI * 2 + rng.range(-0.5, 0.5);
    const reach = rng.range(1.4, 2.6);
    const end = new THREE.Vector3(fork.x + Math.cos(a) * reach, fork.y + rng.range(0.9, H * 0.6), fork.z + Math.sin(a) * reach);
    wood.push(limb(fork, end, 0.08, 0.025, 5, 3));
    // Two or three tiers of flat sprays along each limb.
    const tiers = rng.int(2, 4);
    for (let t = 0; t < tiers; t++) {
      const p = fork.clone().lerp(end, 0.55 + (t / tiers) * 0.5);
      leaves.push(...sprayCluster(rng, p, rng.range(1.0, 1.6), 7, 1.25));
    }
  }
  return {
    height: H,
    trunkRadius: 0.16,
    parts: [
      { geo: setSwayByHeight(merge(wood), 0, H, 2), mat: m.bark, shadow: true, depth: m.trunkDepth, tint: false },
      { geo: setSwayByHeight(merge(leaves), 0, H, 1.2), mat: m.mapleLeaf, shadow: true, depth: m.mapleDepth },
    ],
  };
}

/**
 * Tall autumn hardwood (beech-like, 16–24 m): a straight, dark, slightly
 * tapering trunk, bare for most of its height, with upswept branches carrying
 * a sparse golden crown high above — the colonnade of trunks receding into mist.
 * A few small leafy sprigs sprout from the mid trunk.
 */
function tallTreeVariant(rng: Rng, m: Materials): Variant {
  const H = rng.range(16, 24);
  const top = new THREE.Vector3(rng.range(-0.5, 0.5), H, rng.range(-0.5, 0.5));
  const wood: THREE.BufferGeometry[] = [limb(new THREE.Vector3(0, -0.4, 0), top, rng.range(0.3, 0.42), 0.07, 9, 8)];
  const leaves: THREE.BufferGeometry[] = [];
  const branches = rng.int(5, 8);
  for (let b = 0; b < branches; b++) {
    const a = (b / branches) * Math.PI * 2 + rng.range(-0.4, 0.4);
    const t = rng.range(0.55, 0.9);
    const start = new THREE.Vector3(0, 0, 0).lerp(top, t);
    const reach = rng.range(2.2, 4.2) * (1.1 - t * 0.5);
    const end = start.clone().add(new THREE.Vector3(Math.cos(a) * reach, reach * rng.range(0.6, 1.1), Math.sin(a) * reach));
    wood.push(limb(start, end, 0.1, 0.03, 5, 3));
    leaves.push(...cardCluster(rng, end, rng.range(1.3, 2.0), 8, 1.9));
    leaves.push(...cardCluster(rng, start.clone().lerp(end, 0.55), 1.0, 4, 1.5));
  }
  leaves.push(...cardCluster(rng, top.clone().add(new THREE.Vector3(0, -0.6, 0)), 1.6, 8, 1.9));
  // Epicormic sprigs on the trunk at head-to-mid height.
  for (let s = 0; s < rng.int(1, 4); s++) {
    const p = new THREE.Vector3(0, 0, 0).lerp(top, rng.range(0.18, 0.45));
    const a = rng.range(0, Math.PI * 2);
    const tip = p.clone().add(new THREE.Vector3(Math.cos(a) * 1.1, 0.3, Math.sin(a) * 1.1));
    wood.push(limb(p, tip, 0.03, 0.012, 4, 2));
    leaves.push(...sprayCluster(rng, tip, 0.7, 4, 0.9));
  }
  return {
    height: H,
    trunkRadius: 0.38,
    parts: [
      { geo: setSwayByHeight(merge(wood), 0, H, 2.2), mat: m.greyBark, shadow: true, depth: m.trunkDepth, tint: false },
      { geo: setSwayByHeight(merge(leaves), 0, H, 1.4), mat: m.mapleLeaf, shadow: true, depth: m.mapleDepth },
    ],
  };
}

/**
 * Mountain pine (ponderosa or lodgepole): a tall straight trunk with plated
 * bark, dead branch stubs below the crown, and whorls of branches carrying
 * needle tufts. Ponderosa: thick trunk, broad open crown, drooping limbs.
 * Lodgepole: slim, very straight, narrow crown high up.
 */
function pineVariant(rng: Rng, m: Materials, kind: 'ponderosa' | 'lodgepole'): Variant {
  const pond = kind === 'ponderosa';
  const H = pond ? rng.range(20, 27) : rng.range(18, 25);
  const crownStart = H * (pond ? rng.range(0.45, 0.55) : rng.range(0.6, 0.7));
  const crownR = pond ? rng.range(2.8, 3.6) : rng.range(1.5, 2.1);
  const top = new THREE.Vector3(rng.range(-0.3, 0.3), H, rng.range(-0.3, 0.3));
  const wood: THREE.BufferGeometry[] = [limb(new THREE.Vector3(0, -0.5, 0), top, pond ? rng.range(0.42, 0.55) : rng.range(0.26, 0.34), 0.06, 10, 10)];
  const needles: THREE.BufferGeometry[] = [];
  const at = (y: number): THREE.Vector3 => new THREE.Vector3(0, 0, 0).lerp(top, y / H);
  // Dead stubs on the bare lower trunk.
  for (let s = 0; s < rng.int(4, 9); s++) {
    const p = at(rng.range(H * 0.15, crownStart));
    const a = rng.range(0, Math.PI * 2);
    wood.push(limb(p, p.clone().add(new THREE.Vector3(Math.cos(a) * rng.range(0.3, 0.9), rng.range(-0.2, 0.1), Math.sin(a) * rng.range(0.3, 0.9))), 0.04, 0.01, 4, 1));
  }
  // Branch whorls up the crown.
  for (let y = crownStart; y < H - 0.6; y += rng.range(1.1, 1.6)) {
    const f = (y - crownStart) / (H - crownStart); // 0 bottom of crown .. 1 top
    const reach = crownR * (pond ? Math.sin(Math.PI * (0.25 + f * 0.75)) * 0.9 + 0.15 : (1 - f) ** 0.8 + 0.25);
    const n = rng.int(4, 6);
    const base = rng.range(0, Math.PI * 2);
    for (let b = 0; b < n; b++) {
      const a = base + (b / n) * Math.PI * 2 + rng.range(-0.25, 0.25);
      const start = at(y);
      const droop = pond ? rng.range(-0.45, -0.1) : rng.range(0.05, 0.35);
      const end = start.clone().add(new THREE.Vector3(Math.cos(a) * reach, reach * droop, Math.sin(a) * reach));
      wood.push(limb(start, end, 0.07 * (1 - f * 0.6), 0.015, 4, 2));
      // Needle tufts along the outer half of each branch, densest at the tip.
      for (const t of [0.6, 1.0]) {
        needles.push(...cardCluster(rng, start.clone().lerp(end, t).add(new THREE.Vector3(0, 0.15, 0)), 0.75, t === 1 ? 4 : 2, 1.35));
      }
    }
  }
  needles.push(...cardCluster(rng, top.clone().add(new THREE.Vector3(0, -0.4, 0)), 0.6, 4, 1.2)); // leader
  return {
    height: H,
    trunkRadius: pond ? 0.5 : 0.3,
    parts: [
      { geo: setSwayByHeight(merge(wood), 0, H, 2.4), mat: m.pineBark, shadow: true, depth: m.trunkDepth, tint: false },
      { geo: setSwayByHeight(merge(needles), 0, H, 1.6), mat: m.pineNeedle, shadow: true, depth: m.pineNeedleDepth },
    ],
  };
}

/** Low mixed shrub (0.6–1.3 m) for trail edges: a dome of leafy cards. */
function shrubVariant(rng: Rng, m: Materials): Variant {
  const h = rng.range(0.6, 1.3);
  const leaves: THREE.BufferGeometry[] = [];
  for (let k = 0; k < rng.int(3, 5); k++) {
    const c = new THREE.Vector3(rng.range(-0.5, 0.5), h * rng.range(0.4, 0.75), rng.range(-0.5, 0.5));
    leaves.push(...cardCluster(rng, c, h * 0.7, 6, h * 0.9));
  }
  return { height: h, trunkRadius: 0, parts: [{ geo: setSwayByHeight(merge(leaves), 0, h * 1.4, 1.2), mat: m.mapleLeaf, shadow: true, depth: m.mapleDepth }] };
}

function cedarVariant(rng: Rng, m: Materials): Variant {
  const H = rng.range(12, 17);
  const R = rng.range(2.2, 3.0);
  const trunk = limb(new THREE.Vector3(0, -0.3, 0), new THREE.Vector3(0, H, 0), 0.42, 0.08, 8, 6);
  const core = new THREE.ConeGeometry(R * 0.55, H * 0.72, 7, 3, true).translate(0, H * 0.64, 0);
  const cards: THREE.BufferGeometry[] = [];
  const tiers = 9;
  for (let t = 0; t < tiers; t++) {
    const f = t / (tiers - 1);
    const y = H * (0.3 + f * 0.66);
    const r = R * (1 - f * 0.85) + 0.25;
    const n = Math.max(3, Math.round(8 * (1 - f * 0.6)));
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + rng.range(-0.3, 0.3) + t;
      const g = card(r * 1.3, r * 0.9 + 0.6);
      g.rotateX(-0.5);
      g.rotateY(-a + Math.PI / 2);
      g.translate(Math.cos(a) * r * 0.62, y + rng.range(-0.3, 0.3), Math.sin(a) * r * 0.62);
      crownNormals(g, new THREE.Vector3(0, y - 0.5, 0), 0.3);
      cards.push(g);
    }
  }
  return {
    height: H,
    trunkRadius: 0.42,
    parts: [
      { geo: setSwayByHeight(merge([trunk]), 0, H, 2), mat: m.bark, shadow: true, depth: m.trunkDepth, tint: false },
      { geo: setSwayByHeight(core, H * 0.2, H, 1.6), mat: m.cedarCore, shadow: true, depth: m.needleDepth, tint: false },
      { geo: setSwayByHeight(merge(cards), H * 0.2, H, 1.6), mat: m.needle, shadow: true, depth: m.needleDepth },
    ],
  };
}

function bambooVariant(rng: Rng, m: Materials): Variant {
  const stalks: THREE.BufferGeometry[] = [];
  const leaves: THREE.BufferGeometry[] = [];
  const n = rng.int(4, 8);
  let H = 0;
  for (let s = 0; s < n; s++) {
    const h = rng.range(9, 14);
    H = Math.max(H, h);
    const base = new THREE.Vector3(rng.range(-0.9, 0.9), -0.2, rng.range(-0.9, 0.9));
    const top = base.clone().add(new THREE.Vector3(rng.range(-0.8, 0.8), h, rng.range(-0.8, 0.8)));
    const r = rng.range(0.045, 0.075);
    stalks.push(limb(base, top, r, r * 0.7, 5, 4));
    const sprays = rng.int(6, 10);
    for (let k = 0; k < sprays; k++) {
      const t = rng.range(0.45, 1);
      const p = base.clone().lerp(top, t);
      const g = card(rng.range(1.4, 2.2), rng.range(1.1, 1.7));
      g.rotateX(rng.range(-0.9, -0.2));
      g.rotateY(rng.range(0, Math.PI * 2));
      const a = rng.range(0, Math.PI * 2);
      g.translate(p.x + Math.cos(a) * 0.5, p.y, p.z + Math.sin(a) * 0.5);
      crownNormals(g, new THREE.Vector3(p.x, p.y - 1, p.z), 0.2);
      leaves.push(g);
    }
  }
  return {
    height: H,
    trunkRadius: 0.9,
    parts: [
      { geo: setSwayByHeight(merge(stalks), 0, H, 1.3), mat: m.stalk, shadow: true, depth: m.stalkDepth },
      { geo: setSwayByHeight(merge(leaves), 0, H, 1.3), mat: m.bambooLeaf, shadow: true, depth: m.bambooDepth },
    ],
  };
}

function deadTreeVariant(rng: Rng, m: Materials): Variant {
  const H = rng.range(4, 7);
  const top = new THREE.Vector3(rng.range(-0.6, 0.6), H, rng.range(-0.6, 0.6));
  const wood = [limb(new THREE.Vector3(0, -0.4, 0), top, 0.22, 0.05, 6, 4)];
  for (let b = 0; b < rng.int(2, 4); b++) {
    const s = new THREE.Vector3(0, 0, 0).lerp(top, rng.range(0.4, 0.8));
    const a = rng.range(0, Math.PI * 2);
    wood.push(limb(s, s.clone().add(new THREE.Vector3(Math.cos(a) * 1.6, rng.range(0.5, 1.5), Math.sin(a) * 1.6)), 0.07, 0.02, 4, 2));
  }
  return { height: H, trunkRadius: 0.22, parts: [{ geo: setSwayByHeight(merge(wood), 0, H, 2), mat: m.deadBark, shadow: true, depth: m.trunkDepth }] };
}

function rockVariant(rng: Rng, m: Materials): Variant {
  // Rounded, weathered boulder: low-frequency lumps + a few flattened facets.
  const g = new THREE.IcosahedronGeometry(1, 4);
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const seed = rng.nextU32();
  const facet = new THREE.Vector3(rng.range(-1, 1), rng.range(0.2, 1), rng.range(-1, 1)).normalize();
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.set(pos.getX(i), pos.getY(i), pos.getZ(i));
    const n = 1 + valueNoise(seed, v.x * 1.3 + 3, v.z * 1.3 + v.y * 1.1) * 0.3 + valueNoise(seed + 1, v.x * 3.5, v.y * 3.5 + v.z) * 0.06;
    v.multiplyScalar(n);
    const cut = v.dot(facet) - 0.75; // sheared-off face like split granite
    if (cut > 0) v.addScaledVector(facet, -cut * 0.85);
    pos.setXYZ(i, v.x, v.y * 0.72, v.z);
  }
  g.computeVertexNormals();
  // Moss on upward-facing surfaces (soft, patchy).
  const nrm = g.getAttribute('normal') as THREE.BufferAttribute;
  const colors = new Float32Array(pos.count * 3);
  const c = new THREE.Color();
  const moss = new THREE.Color(0.2, 0.3, 0.08);
  for (let i = 0; i < pos.count; i++) {
    const up = THREE.MathUtils.smoothstep(nrm.getY(i), 0.45, 0.85);
    const patchy = THREE.MathUtils.smoothstep(valueNoise(seed + 2, pos.getX(i) * 2.2, pos.getZ(i) * 2.2) * 0.5 + 0.5, 0.35, 0.65);
    c.setRGB(1, 1, 1).lerp(moss, up * patchy * 0.9);
    colors.set([c.r, c.g, c.b], i * 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  setSwayConst(g, 0);
  return { height: 1, trunkRadius: 1, parts: [{ geo: g, mat: m.rock, shadow: true }] };
}

function lanternGeometry(): THREE.BufferGeometry {
  const parts = [
    new THREE.CylinderGeometry(0.5, 0.6, 0.3, 8).translate(0, 0.15, 0),
    new THREE.CylinderGeometry(0.16, 0.2, 1.1, 8).translate(0, 0.85, 0),
    new THREE.CylinderGeometry(0.45, 0.4, 0.2, 6).translate(0, 1.5, 0),
    new THREE.BoxGeometry(0.55, 0.5, 0.55).translate(0, 1.85, 0),
    new THREE.ConeGeometry(0.75, 0.45, 6).translate(0, 2.32, 0),
    new THREE.SphereGeometry(0.12, 8, 6).translate(0, 2.6, 0),
  ];
  return setSwayConst(merge(parts), 0);
}

// --- instancing with chunks -------------------------------------------------------

interface Placement {
  matrix: THREE.Matrix4;
  color: THREE.Color;
  bend: number;
}

class InstanceSet {
  private readonly chunks = new Map<string, Placement[]>();
  readonly variant: Variant;
  constructor(variant: Variant) {
    this.variant = variant;
  }
  add(p: Placement): void {
    const x = p.matrix.elements[12]!;
    const z = p.matrix.elements[14]!;
    const key = `${Math.floor(x / CHUNK)},${Math.floor(z / CHUNK)}`;
    const list = this.chunks.get(key);
    if (list) list.push(p);
    else this.chunks.set(key, [p]);
  }
  build(group: THREE.Group): number {
    let total = 0;
    for (const list of this.chunks.values()) {
      for (const part of this.variant.parts) {
        // Share vertex data, give each chunk its own per-instance bend attribute.
        const geo = new THREE.BufferGeometry();
        for (const [name, attr] of Object.entries(part.geo.attributes)) geo.setAttribute(name, attr);
        geo.setIndex(part.geo.index);
        geo.setAttribute('aBend', new THREE.InstancedBufferAttribute(new Float32Array(list.map((p) => p.bend)), 1));
        const mesh = new THREE.InstancedMesh(geo, part.mat, list.length);
        list.forEach((p, i) => {
          mesh.setMatrixAt(i, p.matrix);
          mesh.setColorAt(i, part.tint === false ? WHITE : p.color);
        });
        mesh.castShadow = part.shadow;
        mesh.receiveShadow = true;
        if (part.depth) mesh.customDepthMaterial = part.depth;
        mesh.computeBoundingSphere();
        group.add(mesh);
      }
      total += list.length;
    }
    return total;
  }
}

// --- placement --------------------------------------------------------------------

/**
 * @param opts.focus optional circle: only instances inside it are kept (Asset Lab previews).
 * @param opts.exclude circles kept clear of trees and boulders (e.g. the waterfall).
 *   Placement is otherwise identical to the full build, so previews match the game.
 */
export interface Circle {
  x: number;
  z: number;
  r: number;
}

export function buildFoliage(maze: Maze, field: WalkField, tex: EnvTextures, quality: Quality, opts: { focus?: Circle; exclude?: Circle[] } = {}): Foliage {
  const { focus, exclude = [] } = opts;
  const m = makeMaterials(tex);
  const vr = new Rng(maze.seed ^ 0x7ee5);
  const sets = {
    maple: [0, 1, 2, 3].map(() => new InstanceSet(mapleVariant(vr, m))),
    tall: [0, 1, 2, 3].map(() => new InstanceSet(tallTreeVariant(vr, m))),
    cedar: [0, 1, 2].map(() => new InstanceSet(cedarVariant(vr, m))),
    ponderosa: [0, 1, 2].map(() => new InstanceSet(pineVariant(vr, m, 'ponderosa'))),
    lodgepole: [0, 1, 2].map(() => new InstanceSet(pineVariant(vr, m, 'lodgepole'))),
    shrub: [0, 1, 2].map(() => new InstanceSet(shrubVariant(vr, m))),
    bamboo: [0, 1, 2].map(() => new InstanceSet(bambooVariant(vr, m))),
    dead: [0, 1].map(() => new InstanceSet(deadTreeVariant(vr, m))),
    rock: [0, 1, 2].map(() => new InstanceSet(rockVariant(vr, m))),
  };

  const trunks: TrunkCollider[] = [];
  const rocks: RockCollider[] = [];
  const rng = new Rng(maze.seed ^ 0x51f15e);
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  /** Whether the last place() call actually added an instance (colliders follow it). */
  let placed = false;
  const place = (set: InstanceSet, x: number, z: number, scale: number, color: THREE.Color, yOffset = -0.15, sy = scale): void => {
    placed = false;
    q.setFromAxisAngle(up, rng.range(0, Math.PI * 2));
    if (focus && (x - focus.x) ** 2 + (z - focus.z) ** 2 > focus.r ** 2) return;
    if (exclude.some((c) => (x - c.x) ** 2 + (z - c.z) ** 2 < c.r ** 2)) return;
    placed = true;
    const y = heightAt(field, x, z) + yOffset;
    const matrix = new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), q, new THREE.Vector3(scale, sy, scale));
    set.add({ matrix, color, bend: set.variant.height * sy });
  };
  const R = DEFAULT_CONFIG.mapRadius + 18;
  const biomeAt = (x: number, z: number): BiomeId => biomeOfRegion(regionAt(x, z, maze.layout, DEFAULT_CONFIG));

  // Trees & bamboo
  const step = quality === 'high' ? 3.6 : 4.6;
  for (let gz = -R; gz <= R; gz += step) {
    for (let gx = -R; gx <= R; gx += step) {
      const x = gx + rng.range(-step * 0.45, step * 0.45);
      const z = gz + rng.range(-step * 0.45, step * 0.45);
      if (x * x + z * z > R * R) continue;
      const c = clearanceAt(field, x, z);
      if (c < 1.6) continue;
      const biome = biomeAt(x, z);
      const y = heightAt(field, x, z);
      const nearTrail = c < 12;
      switch (biome) {
        case 'bamboo': {
          if (!rng.chance(0.8)) break;
          const set = rng.pick(sets.bamboo);
          place(set, x, z, rng.range(0.85, 1.1), new THREE.Color().setHSL(0.2 + rng.range(-0.02, 0.03), 0.45, 0.48 + rng.range(-0.06, 0.06)), -0.1);
          if (nearTrail && placed) trunks.push({ x, y, z, radius: 0.9, height: 10 });
          break;
        }
        case 'maple': {
          // Autumn ravine: a colonnade of tall golden hardwoods, with low red/orange
          // maples crowding the trail edges.
          const autumn = (): THREE.Color => new THREE.Color().setHSL(rng.pick([0.02, 0.04, 0.06, 0.08, 0.1, 0.11]), 0.9, 0.42 + rng.range(-0.06, 0.08));
          if (c < 7 && rng.chance(0.45)) {
            place(rng.pick(sets.maple), x, z, rng.range(0.85, 1.2), autumn());
            if (nearTrail && placed) trunks.push({ x, y, z, radius: 0.16, height: 2.5 });
          } else if (rng.chance(c < 5 ? 0.5 : 0.42)) {
            place(rng.pick(sets.tall), x, z, rng.range(0.85, 1.12), autumn(), -0.2);
            if (nearTrail && placed) trunks.push({ x, y, z, radius: 0.38, height: 8 });
          }
          break;
        }
        case 'shrine': {
          // Mountain pine forest: tall ponderosa and lodgepole pines, with low
          // shrubs crowding the trail edges.
          // Dark blue-green needles (pines read dark against the sky, not mint).
          const needles = (): THREE.Color => new THREE.Color().setHSL(0.31 + rng.range(-0.02, 0.03), 0.32, 0.17 + rng.range(-0.03, 0.04));
          if (c < 5 && rng.chance(0.3)) {
            place(rng.pick(sets.shrub), x, z, rng.range(0.8, 1.3), new THREE.Color().setHSL(0.24 + rng.range(-0.03, 0.04), 0.45, 0.32 + rng.range(-0.05, 0.06)), -0.1);
            break;
          }
          if (!rng.chance(c < 6 ? 0.42 : 0.38)) break;
          const pond = rng.chance(0.5);
          const set = pond ? rng.pick(sets.ponderosa) : rng.pick(sets.lodgepole);
          place(set, x, z, rng.range(0.85, 1.12), needles(), -0.25);
          if (nearTrail && placed) trunks.push({ x, y, z, radius: pond ? 0.5 : 0.32, height: 8 });
          break;
        }
        case 'marsh': {
          if (rng.chance(0.12)) {
            place(rng.pick(sets.dead), x, z, rng.range(0.8, 1.2), new THREE.Color(0xffffff), -0.5);
            if (nearTrail && placed) trunks.push({ x, y, z, radius: 0.22, height: 4 });
          }
          break;
        }
        case 'summit': {
          if (rng.chance(0.55)) {
            const s = rng.range(0.9, 3.0);
            place(rng.pick(sets.rock), x, z, s, new THREE.Color(0xffffff), s * 0.2, s * rng.range(0.7, 1.1));
            if (nearTrail && placed) rocks.push({ x, y: y + s * 0.2, z, radius: s * 0.85 });
          } else if (rng.chance(0.3)) {
            place(rng.pick(sets.cedar), x, z, rng.range(0.4, 0.6), new THREE.Color().setHSL(0.33, 0.3, 0.26)); // stunted wind-blown pines
            if (nearTrail && placed) trunks.push({ x, y, z, radius: 0.25, height: 5 });
          }
          break;
        }
      }
    }
  }

  // Scattered boulders along trails (cover + landmarks); the autumn ravine gets
  // more, larger mossy ones, sometimes in pairs.
  const warmGranite = new THREE.Color(1, 0.93, 0.9);
  const coolGranite = new THREE.Color(0.82, 0.86, 0.9); // grey mountain granite
  for (const e of maze.edges) {
    const edgeBiome = biomeOfRegion(maze.nodes[e.a]!.regionId);
    const ravine = edgeBiome === 'maple' || edgeBiome === 'shrine'; // rocky, boulder-strewn trails
    if (!rng.chance(ravine ? 0.9 : 0.35)) continue;
    const a = maze.nodes[e.a]!;
    const b = maze.nodes[e.b]!;
    const t = rng.range(0.2, 0.8);
    const side = rng.chance(0.5) ? 1 : -1;
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len = Math.hypot(dx, dz);
    const off = DEFAULT_CONFIG.pathHalfWidth + rng.range(0.5, 1.8) + (ravine ? 1.0 : 0);
    const x = a.x + dx * t + (-dz / len) * off * side;
    const z = a.z + dz * t + (dx / len) * off * side;
    const s = ravine ? rng.range(0.9, 2.0) : rng.range(0.6, 1.4);
    place(rng.pick(sets.rock), x, z, s, edgeBiome === 'maple' ? warmGranite : edgeBiome === 'shrine' ? coolGranite : WHITE, s * 0.15, s * rng.range(0.6, 1));
    if (placed) rocks.push({ x, y: heightAt(field, x, z) + s * 0.15, z, radius: s * 0.8 });
  }

  // Stone lanterns at shrine junctions.
  const lanterns: THREE.Matrix4[] = [];
  for (const n of maze.nodes) {
    if (biomeOfRegion(n.regionId) !== 'shrine' || n.edges.length < 3 || !rng.chance(0.6)) continue;
    const a = rng.range(0, Math.PI * 2);
    const r = DEFAULT_CONFIG.clearingRadius - 1;
    const x = n.x + Math.cos(a) * r;
    const z = n.z + Math.sin(a) * r;
    lanterns.push(new THREE.Matrix4().compose(new THREE.Vector3(x, heightAt(field, x, z) - 0.05, z), q.setFromAxisAngle(up, rng.range(0, 6.28)), new THREE.Vector3(1, 1, 1)));
    trunks.push({ x, y: heightAt(field, x, z), z, radius: 0.5, height: 2.6 });
  }

  const group = new THREE.Group();
  group.name = 'forest';
  let instanceCount = 0;
  for (const list of Object.values(sets)) for (const s of list) instanceCount += s.build(group);
  if (lanterns.length) {
    const lm = new THREE.InstancedMesh(lanternGeometry(), m.stone, lanterns.length);
    lanterns.forEach((mx, i) => lm.setMatrixAt(i, mx));
    lm.castShadow = lm.receiveShadow = true;
    lm.computeBoundingSphere();
    group.add(lm);
  }
  return { group, trunks, rocks, instanceCount };
}
