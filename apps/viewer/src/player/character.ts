/**
 * The player character: an original, procedurally built explorer.
 *
 * Built to fixed measurements (metres, origin at the feet, facing -Z):
 *   total height 1.80 (head unit 0.225); head 0.225 × 0.16; neck 0.10 × 0.12;
 *   shoulders 0.45, waist 0.32, chest depth 0.24 (tapered lathe torso);
 *   upper arm 0.30, forearm 0.27, hand 0.19; crotch 0.90, thigh 0.45, shin 0.42;
 *   thigh/knee/ankle widths 0.16/0.11/0.08; boots 0.27 × 0.16; hat brim 0.40,
 *   crown 0.12, brim at head top − 0.04.
 *
 * Every part hangs off a THREE.Bone hierarchy so it can be animated (walk
 * cycle here; first/third-person cameras can use `bones` and `eye`):
 *   hips → spine → chest → neck → head
 *   chest → shoulder.L/R → upperArm → forearm → hand
 *   hips → thigh.L/R → shin → foot
 * Left is the character's left (-X).
 */
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import type { EnvTextures } from '../env/textures.ts';

export interface CharacterState {
  speed: number; // horizontal m/s
  stepPhase: number; // radians, π per footstep
  sprinting: boolean;
  grounded: boolean;
  crouch: number; // 0..1
  /** World-space movement direction (x, z), or null when standing still. */
  moveDir: THREE.Vector2 | null;
}

export type BoneName =
  | 'hips'
  | 'spine'
  | 'chest'
  | 'neck'
  | 'head'
  | 'shoulder.L'
  | 'shoulder.R'
  | 'upperArm.L'
  | 'upperArm.R'
  | 'forearm.L'
  | 'forearm.R'
  | 'hand.L'
  | 'hand.R'
  | 'thigh.L'
  | 'thigh.R'
  | 'shin.L'
  | 'shin.R'
  | 'foot.L'
  | 'foot.R';

interface Limb {
  upper: THREE.Bone;
  lower: THREE.Bone;
  end: THREE.Bone;
}

// --- Measurements (metres) ------------------------------------------------------
const HEIGHT = 1.8;
const HEAD_H = 0.225;
const HEAD_W = 0.16;
const NECK_H = 0.1;
const NECK_W = 0.12;
const SHOULDER_W = 0.45;
const WAIST_W = 0.32;
const CHEST_DEPTH = 0.24;
const UPPER_ARM = 0.3;
const FOREARM = 0.27;
const HAND = 0.19;
const THIGH = 0.45;
const SHIN = 0.42;
const THIGH_W = 0.16;
const KNEE_W = 0.11;
const ANKLE_W = 0.08;
const BOOT_L = 0.27;
const BOOT_H = 0.16;
const ANKLE_Y = 0.08; // ankle joint height (half the boot height)
const HIP_Y = ANKLE_Y + SHIN + THIGH; // 0.95: hip joints; the crotch sits just below at 0.90
const SPINE_Y = 0.06; // spine bone above the hips
const CHEST_Y = 0.32; // chest bone above the spine (~1.33 m)
const NECK_Y = 0.17; // neck base above the chest bone (~1.50 m)
const DELTOID_R = 0.055;
const SHOULDER_X = SHOULDER_W / 2 - DELTOID_R; // shoulder joint, so deltoid-to-deltoid = 0.45
const HAT_BRIM_W = 0.4;
const HAT_CROWN_H = 0.12;
const PACK = { h: 0.5, w: 0.34, d: 0.18 };
const BEDROLL = { len: 0.4, dia: 0.12 };
const COLORS = { jacket: 0x5f6b3a, sweater: 0xd8cdb0, trousers: 0x2f2f2c, boots: 0x5a3a24 };
const CHEST_W = 0.38; // jacket chest width (shoulders incl. deltoids = 0.45)
/** Depth/width ratio of the torso lathe: chest 0.38 wide → 0.24 deep. */
const TORSO_Z = CHEST_DEPTH / CHEST_W;

function bone(name: BoneName, parent: THREE.Object3D, x: number, y: number, z = 0): THREE.Bone {
  const b = new THREE.Bone();
  b.name = name;
  b.position.set(x, y, z);
  parent.add(b);
  return b;
}

function shadowed<T extends THREE.Mesh>(m: T): T {
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

/**
 * Limb from a radius profile [radius, distance down from the joint] (local -Y),
 * slightly flattened front-to-back; `back` pushes the middle backwards (calf).
 * LatheGeometry needs points in increasing Y for outward normals, so the
 * (top-down) profile is reversed.
 */
function limbLathe(profile: Array<[number, number]>, mat: THREE.Material, flatten = 0.95, back = 0): THREE.Mesh {
  const g = new THREE.LatheGeometry(
    profile
      .slice()
      .reverse()
      .map(([r, d]) => new THREE.Vector2(r, -d)),
    20,
  );
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  const len = profile[profile.length - 1]![1];
  for (let i = 0; i < p.count; i++) {
    const d = -p.getY(i);
    p.setZ(i, p.getZ(i) * flatten + (back ? back * Math.sin(Math.PI * THREE.MathUtils.clamp(d / len, 0, 1)) : 0));
  }
  g.computeVertexNormals();
  return shadowed(new THREE.Mesh(g, mat));
}

/** Lathe around +Y from a bottom-up [radius, y] profile; optional open front. */
function lathe(profile: Array<[number, number]>, mat: THREE.Material, segments = 32, phiStart = 0, phiLength = Math.PI * 2): THREE.Mesh {
  const g = new THREE.LatheGeometry(
    profile.map(([r, y]) => new THREE.Vector2(r, y)),
    segments,
    phiStart,
    phiLength,
  );
  return shadowed(new THREE.Mesh(g, mat));
}

/** Smooth gaussian bump used for sculpting the face. */
function bump(x: number, y: number, z: number, cx: number, cy: number, cz: number, r: number): number {
  return Math.exp(-((x - cx) ** 2 + (y - cy) ** 2 + (z - cz) ** 2) / (r * r));
}

/**
 * A sculpted male head (faces -Z), half-width `sx`, half-height `sy`,
 * half-depth `sz`: brow ridge, nose, eye sockets, cheekbones, square jaw and
 * chin; vertex-coloured stubble, brows and lips; eyes and ears.
 */
function sculptedHead(skinColor: number, sx: number, sy: number, sz: number): THREE.Group {
  const g = new THREE.Group();
  const geo = new THREE.SphereGeometry(1, 56, 42);
  const p = geo.getAttribute('position') as THREE.BufferAttribute;
  const col = new Float32Array(p.count * 3);
  const base = new THREE.Color(skinColor);
  const stubble = new THREE.Color(0x3e3029);
  const brow = new THREE.Color(0x261b14);
  const lip = new THREE.Color(0x96584a);
  const c = new THREE.Color();
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const y = p.getY(i);
    const z = p.getZ(i);
    const front = Math.max(0, -z);
    let nx = x * (0.95 - (y < -0.3 ? (-0.3 - y) * 0.22 : 0)); // jaw tapers but stays square
    let ny = y;
    let nz = z < 0 ? z * 0.92 : z * 1.02;
    nz -= 0.09 * bump(x, y, z, 0, 0.3, -0.95, 0.38) * front; // brow ridge
    nz -= 0.24 * bump(x, y, z, 0, -0.06, -1, 0.15); // nose
    ny -= 0.04 * bump(x, y, z, 0, -0.12, -1, 0.12);
    nz += 0.09 * (bump(x, y, z, 0.36, 0.12, -0.93, 0.15) + bump(x, y, z, -0.36, 0.12, -0.93, 0.15)); // eye sockets
    nx += 0.05 * Math.sign(x) * bump(Math.abs(x), y, z, 0.62, -0.05, -0.72, 0.25); // cheekbones
    nz -= 0.07 * bump(x, y, z, 0, -0.8, -0.58, 0.22); // chin
    ny -= 0.05 * bump(x, y, z, 0, -0.85, -0.5, 0.25);
    nx *= 1 + 0.06 * bump(Math.abs(x), y, z, 0.7, -0.55, -0.4, 0.3); // jaw angle
    p.setXYZ(i, nx, ny, nz);
    c.copy(base).multiplyScalar(0.94 + 0.08 * Math.sin(x * 23 + y * 17) * Math.sin(z * 19 - y * 11));
    const jaw = THREE.MathUtils.smoothstep(-y, 0.12, 0.38) * (z < 0.35 ? 1 : 0) * (1 - bump(x, y, z, 0, -0.06, -1, 0.17));
    c.lerp(stubble, jaw * 0.68);
    c.lerp(lip, bump(x, y, z, 0, -0.42, -0.95, 0.11) * 0.45);
    for (const s of [-1, 1]) {
      const bx = (x - s * 0.34) / 0.2;
      const by = (y - 0.29) / 0.055;
      if (z < 0 && bx * bx + by * by < 1) c.lerp(brow, 0.85);
    }
    col.set([c.r, c.g, c.b], i * 3);
  }
  geo.computeVertexNormals();
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const head = shadowed(new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.62 })));
  head.scale.set(sx, sy, sz);
  g.add(head);
  const white = new THREE.MeshStandardMaterial({ color: 0xa89c90, roughness: 0.3 });
  const iris = new THREE.MeshStandardMaterial({ color: 0x3a2e24, roughness: 0.2 });
  const earMat = new THREE.MeshStandardMaterial({ color: skinColor, roughness: 0.6 });
  for (const s of [-1, 1]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(sx * 0.1, 14, 10), white);
    eye.position.set(s * 0.345 * sx, 0.11 * sy, -0.8 * sz);
    g.add(eye);
    const pupil = new THREE.Mesh(new THREE.SphereGeometry(sx * 0.056, 10, 8), iris);
    pupil.position.set(s * 0.345 * sx, 0.11 * sy, -0.88 * sz);
    g.add(pupil);
    const ear = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 10), earMat);
    ear.scale.set(0.011, sy * 0.24, sz * 0.18);
    ear.position.set(s * 0.98 * sx, 0, 0.06 * sz);
    g.add(ear);
  }
  return g;
}

export class Character {
  readonly root = new THREE.Group();
  /** Named bones for animation and camera attachment. */
  readonly bones = {} as Record<BoneName, THREE.Bone>;
  /** Eye-level anchor inside the head (for a first-person camera). */
  readonly eye = new THREE.Object3D();
  private readonly hips: THREE.Bone;
  private readonly spine: THREE.Bone;
  private readonly chest: THREE.Bone;
  private readonly neck: THREE.Bone;
  private readonly head: THREE.Bone;
  private readonly legs: Limb[] = [];
  private readonly arms: Limb[] = [];
  private heading = 0;
  private t = 0;
  private throwT = -1;
  private air = 0;

  constructor(tex: EnvTextures) {
    // --- Materials: exact colours; textures only add surface relief (bump) ---
    const fabric = (color: number, rough = 0.95): THREE.MeshStandardMaterial =>
      new THREE.MeshStandardMaterial({ color, bumpMap: tex.cloth, bumpScale: 0.4, roughness: rough });
    const leather = (color: number): THREE.MeshStandardMaterial => new THREE.MeshStandardMaterial({ color, bumpMap: tex.leather, bumpScale: 0.6, roughness: 0.7 });
    const jacket = fabric(COLORS.jacket);
    jacket.side = THREE.DoubleSide;
    const worn = fabric(0x7b8557); // rubbed lighter at cuffs and elbows
    const sweater = fabric(COLORS.sweater, 0.98);
    const trousers = fabric(COLORS.trousers);
    const boots = leather(COLORS.boots);
    const sole = new THREE.MeshStandardMaterial({ color: 0x1e1a17, roughness: 0.9 });
    const gloves = leather(0x7a5638);
    const beltLeather = leather(0x5e3e28);
    const strapLeather = leather(0x553521);
    const canvas = fabric(0x8f7b56); // rucksack + bedroll canvas
    const felt = new THREE.MeshStandardMaterial({ color: 0x4e3626, bumpMap: tex.cloth, bumpScale: 0.3, roughness: 1, side: THREE.DoubleSide });
    const skin = new THREE.MeshStandardMaterial({ color: 0x9a6c55, roughness: 0.6 });
    const hair = new THREE.MeshStandardMaterial({ color: 0x231912, roughness: 0.8 });
    const brass = new THREE.MeshStandardMaterial({ color: 0xb8954a, metalness: 0.8, roughness: 0.4 });
    const steel = new THREE.MeshStandardMaterial({ color: 0x8c8f92, metalness: 0.7, roughness: 0.42 });
    const wood = new THREE.MeshStandardMaterial({ color: 0x6a4a30, roughness: 0.8 });
    tex.rope.repeat.set(40, 1);
    const rope = new THREE.MeshStandardMaterial({ map: tex.rope, color: 0xc0ae8c, roughness: 0.95 });
    const box = (w: number, h: number, d: number, r: number, mat: THREE.Material): THREE.Mesh => shadowed(new THREE.Mesh(new RoundedBoxGeometry(w, h, d, 2, r), mat));
    const tube = (pts: THREE.Vector3[], r: number, mat: THREE.Material): THREE.Mesh =>
      shadowed(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 48, r, 6), mat));

    // --- Skeleton -----------------------------------------------------------------
    this.hips = bone('hips', this.root, 0, HIP_Y);
    this.spine = bone('spine', this.hips, 0, SPINE_Y);
    this.chest = bone('chest', this.spine, 0, CHEST_Y);
    this.neck = bone('neck', this.chest, 0, NECK_Y);
    this.head = bone('head', this.neck, 0, NECK_H);
    for (const b of [this.hips, this.spine, this.chest, this.neck, this.head]) this.bones[b.name as BoneName] = b;

    // --- Legs: thigh → shin → foot -------------------------------------------------
    for (const s of [-1, 1]) {
      const side = s < 0 ? 'L' : 'R';
      // Thighs 0.16 wide set 0.16 apart: they meet at the crotch, no gap.
      const thigh = bone(`thigh.${side}` as BoneName, this.hips, s * (THIGH_W / 2), 0);
      thigh.add(limbLathe([[THIGH_W / 2, 0], [THIGH_W / 2, 0.08], [0.068, 0.28], [KNEE_W / 2, THIGH]], trousers));
      const shin = bone(`shin.${side}` as BoneName, thigh, 0, -THIGH);
      shin.add(limbLathe([[KNEE_W / 2, 0], [0.058, 0.12], [0.05, 0.26], [ANKLE_W / 2, SHIN]], trousers, 0.95, 0.008));
      shin.add(new THREE.Mesh(new THREE.SphereGeometry(KNEE_W / 2 - 0.003, 14, 10), trousers)); // fills the knee when bent
      const tuck = new THREE.Mesh(new THREE.TorusGeometry(ANKLE_W / 2 + 0.008, 0.006, 8, 20), trousers);
      tuck.rotation.x = Math.PI / 2;
      tuck.position.y = -SHIN + 0.09; // trousers tucked into the boot
      shin.add(tuck);
      const foot = bone(`foot.${side}` as BoneName, shin, 0, -SHIN); // ankle, 0.08 m above the ground
      // Boot: 0.27 long × 0.16 tall (sole to shaft top), rounded toe, thin dark sole.
      foot.add(limbLathe([[0.047, -(BOOT_H - ANKLE_Y)], [0.049, 0], [0.05, 0.04]], boots));
      const vamp = box(0.1, 0.085, BOOT_L - 0.012, 0.035, boots);
      vamp.position.set(0, -ANKLE_Y + 0.012 + 0.0425, -0.06);
      foot.add(vamp);
      const toe = shadowed(new THREE.Mesh(new THREE.SphereGeometry(1, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2), boots));
      toe.scale.set(0.05, 0.04, 0.055);
      toe.position.set(0, -ANKLE_Y + 0.02, -0.06 - (BOOT_L - 0.012) / 2 + 0.055);
      foot.add(toe);
      const bootSole = box(0.106, 0.012, BOOT_L, 0.005, sole);
      bootSole.position.set(0, -ANKLE_Y + 0.006, -0.06);
      foot.add(bootSole);
      for (let k = 0; k < 4; k++) {
        const lace = box(0.03, 0.004, 0.004, 0.0015, sole);
        lace.position.set(0, 0.04 - k * 0.026, -0.05);
        lace.rotation.z = k % 2 ? 0.35 : -0.35;
        foot.add(lace);
      }
      for (const b of [thigh, shin, foot]) this.bones[b.name as BoneName] = b;
      this.legs.push({ upper: thigh, lower: shin, end: foot });
    }

    // --- Pelvis, belt, jacket hem (hips) -----------------------------------------
    const pelvis = lathe([[WAIST_W / 2 - 0.01, -0.1], [WAIST_W / 2 + 0.005, -0.02], [WAIST_W / 2, SPINE_Y + 0.02]], trousers);
    pelvis.scale.z = TORSO_Z;
    this.hips.add(pelvis);
    const belt = new THREE.Mesh(new THREE.TorusGeometry(WAIST_W / 2 + 0.004, 0.017, 6, 32), beltLeather);
    belt.rotation.x = Math.PI / 2;
    belt.scale.y = TORSO_Z;
    belt.position.y = 0.05;
    this.hips.add(belt);
    const buckle = box(0.05, 0.04, 0.01, 0.004, brass);
    buckle.position.set(0, 0.05, -(WAIST_W / 2) * TORSO_Z - 0.012);
    this.hips.add(buckle);
    const GAP = 0.85; // open front (radians)
    const hem = lathe([[WAIST_W / 2 + 0.018, -0.12], [WAIST_W / 2 + 0.02, -0.02], [WAIST_W / 2 + 0.012, SPINE_Y + 0.04]], jacket, 32, Math.PI + GAP / 2, Math.PI * 2 - GAP);
    hem.scale.z = TORSO_Z;
    this.hips.add(hem); // hem at the hips (~0.83 m)

    // --- Torso (spine): tapered lathe, sweater under an open jacket ---------------
    const torsoProfile: Array<[number, number]> = [
      [WAIST_W / 2, 0.0], // waist 0.32 wide
      [WAIST_W / 2 - 0.002, 0.08],
      [0.176, 0.2],
      [CHEST_W / 2, CHEST_Y], // chest 0.38 wide × 0.24 deep
      [CHEST_W / 2 - 0.002, 0.4],
      [0.15, 0.46], // shoulder slope
      [NECK_W / 2 + 0.01, 0.5],
    ];
    const shirt = lathe(
      torsoProfile.map(([r, y]) => [r * 0.97, y] as [number, number]),
      sweater,
    );
    shirt.scale.z = TORSO_Z;
    this.spine.add(shirt);
    const torso = lathe(torsoProfile, jacket, 36, Math.PI + GAP / 2, Math.PI * 2 - GAP);
    torso.scale.z = TORSO_Z;
    this.spine.add(torso);
    const frontZ = -CHEST_DEPTH / 2; // chest surface
    const placket = box(0.022, 0.11, 0.006, 0.003, sweater);
    placket.position.set(0, 0.425, frontZ * 0.97 + 0.004);
    this.spine.add(placket);
    for (const y of [0.39, 0.43, 0.47]) {
      const b = new THREE.Mesh(new THREE.SphereGeometry(0.005, 8, 6), wood);
      b.position.set(0, y, frontZ * 0.97 - 0.003);
      this.spine.add(b);
    }
    for (const s of [-1, 1]) {
      const pocket = box(0.072, 0.085, 0.012, 0.005, jacket);
      pocket.position.set(s * 0.1, 0.3, frontZ + 0.012);
      pocket.rotation.y = s * 0.4;
      this.spine.add(pocket);
      const flapGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-0.04, 0.012, 0), new THREE.Vector3(0.04, 0.012, 0), new THREE.Vector3(0, -0.03, 0)]);
      flapGeo.setIndex([0, 2, 1]);
      flapGeo.computeVertexNormals();
      const flap = new THREE.Mesh(flapGeo, jacket);
      flap.position.set(s * 0.1, 0.345, frontZ + 0.004);
      flap.rotation.y = s * 0.4;
      this.spine.add(flap);
    }
    const collarBand = new THREE.Mesh(new THREE.TorusGeometry(NECK_W / 2 + 0.018, 0.02, 8, 24, Math.PI * 1.5), jacket);
    collarBand.rotation.set(Math.PI / 2 - 0.2, 0, Math.PI * 0.75);
    collarBand.position.set(0, 0.5, 0.005);
    this.spine.add(collarBand);
    for (const s of [-1, 1]) {
      const pt = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(s * 0.07, 0.005, 0.02), new THREE.Vector3(s * 0.03, -0.075, 0)]);
      pt.setIndex(s > 0 ? [0, 2, 1] : [0, 1, 2]);
      pt.computeVertexNormals();
      const collarPoint = new THREE.Mesh(pt, jacket);
      collarPoint.position.set(s * 0.03, 0.5, frontZ * 0.72);
      collarPoint.rotation.x = 0.35;
      this.spine.add(collarPoint);
    }

    // --- Neck & head ---------------------------------------------------------------
    // Neck 0.10 tall × 0.12 wide (a little extra length tucks under the jaw).
    this.neck.add(shadowed(new THREE.Mesh(new THREE.CylinderGeometry(NECK_W / 2, NECK_W / 2 + 0.004, NECK_H + 0.03, 18).translate(0, NECK_H / 2, 0), skin)));
    // Head 0.225 tall × 0.16 wide: chin at 1.575, top of skull at 1.80.
    const headBoneY = HIP_Y + SPINE_Y + CHEST_Y + NECK_Y + NECK_H;
    const faceY = HEIGHT - HEAD_H / 2 - headBoneY; // face centre relative to the head bone
    const face = sculptedHead(0x9a6c55, HEAD_W / 2, HEAD_H / 2, 0.1);
    face.position.y = faceY;
    this.head.add(face);
    this.eye.position.set(0, faceY + 0.012, -0.06);
    this.head.add(this.eye);
    const hairGeo = new THREE.SphereGeometry(1, 30, 22, Math.PI * 1.8, Math.PI * 1.4, 0, Math.PI * 0.64);
    const hp = hairGeo.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < hp.count; i++) {
      const x = hp.getX(i);
      let y = hp.getY(i);
      const z = hp.getZ(i);
      const back = Math.max(0, z);
      if (y < 0.1) y -= (0.1 - y) * 0.6 * back;
      const clump = 1 + Math.sin(Math.atan2(z, x) * 18) * 0.012;
      hp.setXYZ(i, x * clump, y, z * clump + back * 0.012);
    }
    hairGeo.computeVertexNormals();
    const hairMesh = shadowed(new THREE.Mesh(hairGeo, hair));
    hairMesh.scale.set((HEAD_W / 2) * 1.06, (HEAD_H / 2) * 1.03, 0.104);
    hairMesh.position.y = faceY + 0.008;
    this.head.add(hairMesh);

    // Hat, parented to the head bone: brim at forehead height (head top − 0.04),
    // crown fitted over the head + hair (no gap), pinched outback crown.
    const hat = new THREE.Group();
    hat.position.y = faceY + HEAD_H / 2 - 0.04;
    hat.rotation.x = -0.04;
    this.head.add(hat);
    const crownR = (HEAD_W / 2) * 1.08; // sits on the hair
    const crown = lathe(
      [
        [crownR, 0.0],
        [crownR - 0.003, HAT_CROWN_H * 0.45],
        [crownR * 0.86, HAT_CROWN_H * 0.85],
        [crownR * 0.5, HAT_CROWN_H * 0.98],
        [0.0, HAT_CROWN_H],
      ],
      felt,
      36,
    );
    const cp = crown.geometry.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < cp.count; i++) {
      const x = cp.getX(i);
      const y = cp.getY(i);
      const z = cp.getZ(i);
      let ny = y;
      if (y > HAT_CROWN_H * 0.7) ny -= Math.max(0, 0.025 - Math.abs(x) * 0.45); // centre dent
      const pinch = z < 0 ? THREE.MathUtils.smoothstep(y, HAT_CROWN_H * 0.35, HAT_CROWN_H * 0.9) * THREE.MathUtils.smoothstep(-z, 0.03, 0.09) : 0;
      cp.setXYZ(i, x * (1 - 0.3 * pinch), ny, z);
    }
    crown.geometry.computeVertexNormals();
    crown.scale.z = 0.104 / crownR; // oval, matching the head + hair depth
    hat.add(crown);
    const band = new THREE.Mesh(new THREE.TorusGeometry(crownR + 0.001, 0.005, 6, 36), new THREE.MeshStandardMaterial({ color: 0x2c1e16, roughness: 0.8 }));
    band.rotation.x = Math.PI / 2;
    band.scale.y = crown.scale.z;
    band.position.y = 0.012;
    hat.add(band);
    const brimGeo = new THREE.RingGeometry(crownR - 0.005, HAT_BRIM_W / 2, 48, 3);
    brimGeo.rotateX(-Math.PI / 2);
    const bp = brimGeo.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < bp.count; i++) {
      const x = bp.getX(i);
      const z = bp.getZ(i);
      const r = Math.hypot(x, z);
      const a = Math.atan2(z, x);
      const out = THREE.MathUtils.clamp((r - crownR) / (HAT_BRIM_W / 2 - crownR), 0, 1);
      bp.setY(i, out * out * (0.028 * Math.cos(a) ** 2 - 0.012 * Math.sin(a) ** 2)); // sides curl up
    }
    brimGeo.computeVertexNormals();
    hat.add(shadowed(new THREE.Mesh(brimGeo, felt)));

    // --- Arms: shoulder → upper arm → forearm → hand ---------------------------------
    for (const s of [-1, 1]) {
      const side = s < 0 ? 'L' : 'R';
      const shoulder = bone(`shoulder.${side}` as BoneName, this.chest, s * 0.04, 0.12);
      const upperArm = bone(`upperArm.${side}` as BoneName, shoulder, s * (SHOULDER_X - 0.04), 0);
      upperArm.add(shadowed(new THREE.Mesh(new THREE.SphereGeometry(DELTOID_R, 14, 10), jacket)));
      const epaulette = box(0.1, 0.008, 0.035, 0.003, jacket);
      epaulette.position.set(-s * 0.04, DELTOID_R - 0.002, 0);
      epaulette.rotation.z = s * 0.25;
      upperArm.add(epaulette);
      upperArm.add(limbLathe([[0.054, 0], [0.053, 0.12], [0.046, UPPER_ARM]], jacket));
      const elbowPatch = new THREE.Mesh(new THREE.SphereGeometry(1, 10, 8), worn);
      elbowPatch.scale.set(0.032, 0.045, 0.012);
      elbowPatch.position.set(0, -UPPER_ARM, 0.04);
      upperArm.add(elbowPatch);
      const forearm = bone(`forearm.${side}` as BoneName, upperArm, 0, -UPPER_ARM); // elbow at navel height
      forearm.add(limbLathe([[0.046, 0], [0.045, 0.08], [0.038, FOREARM]], jacket));
      const cuff = new THREE.Mesh(new THREE.TorusGeometry(0.039, 0.009, 6, 18), worn);
      cuff.rotation.x = Math.PI / 2;
      cuff.position.y = -FOREARM + 0.015;
      forearm.add(cuff);
      const hand = bone(`hand.${side}` as BoneName, forearm, 0, -FOREARM); // wrist at crotch height
      const gloveCuff = new THREE.Mesh(new THREE.CylinderGeometry(0.038, 0.041, 0.05, 14, 1, true), gloves);
      gloveCuff.position.y = 0.01;
      hand.add(gloveCuff);
      const helix: THREE.Vector3[] = [];
      for (let k = 0; k <= 60; k++) {
        const t = k / 60;
        const a = t * Math.PI * 2 * 3;
        helix.push(new THREE.Vector3(Math.cos(a) * 0.043, -0.01 + t * 0.04, Math.sin(a) * 0.043));
      }
      hand.add(tube(helix, 0.0042, rope));
      // Hand 0.19 long: palm 0.10 + slightly curled fingers 0.09.
      const palmLen = 0.1;
      const palm = box(0.085, palmLen, 0.034, 0.014, gloves);
      palm.position.y = -palmLen / 2;
      hand.add(palm);
      const fingers = box(0.08, HAND - palmLen, 0.026, 0.012, gloves);
      fingers.position.set(0, -palmLen - (HAND - palmLen) / 2 + 0.004, -0.01);
      fingers.rotation.x = 0.22;
      hand.add(fingers);
      const thumb = shadowed(new THREE.Mesh(new THREE.CapsuleGeometry(0.013, 0.045, 4, 10).translate(0, -0.0225, 0), gloves));
      thumb.position.set(-s * 0.038, -0.03, -0.014);
      thumb.rotation.z = -s * 0.45;
      hand.add(thumb);
      for (const b of [shoulder, upperArm, forearm, hand]) this.bones[b.name as BoneName] = b;
      this.arms.push({ upper: upperArm, lower: forearm, end: hand });
    }

    // --- Gear ------------------------------------------------------------------------
    const backZ = CHEST_DEPTH / 2; // back surface of the chest
    const packZ = backZ + PACK.d / 2; // flush against the back (no gap)
    const packY = 0.5 - PACK.h / 2; // top of the pack level with the shoulders
    const pack = box(PACK.w, PACK.h, PACK.d, 0.045, canvas);
    pack.position.set(0, packY, packZ);
    this.spine.add(pack);
    const packBase = box(PACK.w, 0.06, PACK.d, 0.025, strapLeather);
    packBase.position.set(0, packY - PACK.h / 2 + 0.03, packZ + 0.004);
    this.spine.add(packBase);
    const packFlap = box(PACK.w - 0.01, 0.18, 0.022, 0.01, strapLeather);
    packFlap.position.set(0, packY + PACK.h / 2 - 0.09, packZ + PACK.d / 2 + 0.006);
    packFlap.rotation.x = 0.06;
    this.spine.add(packFlap);
    for (const s of [-1, 1]) {
      const strap = box(0.026, 0.22, 0.006, 0.002, strapLeather);
      strap.position.set(s * 0.09, packY + 0.04, packZ + PACK.d / 2 + 0.008);
      this.spine.add(strap);
      const bk = box(0.032, 0.026, 0.008, 0.002, brass);
      bk.position.set(s * 0.09, packY - 0.03, packZ + PACK.d / 2 + 0.011);
      this.spine.add(bk);
    }
    // Bedroll 0.40 × Ø0.12 on top of the pack, two strap rings.
    const bedrollY = packY + PACK.h / 2 + BEDROLL.dia / 2;
    const bedroll = shadowed(new THREE.Mesh(new THREE.CylinderGeometry(BEDROLL.dia / 2, BEDROLL.dia / 2, BEDROLL.len, 22), canvas));
    bedroll.rotation.z = Math.PI / 2;
    bedroll.position.set(0, bedrollY, packZ);
    this.spine.add(bedroll);
    for (const x of [-0.12, 0.12]) {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(BEDROLL.dia / 2 + 0.003, 0.008, 6, 22), strapLeather);
      ring.rotation.y = Math.PI / 2;
      ring.position.set(x, bedrollY, packZ);
      this.spine.add(ring);
    }
    // Rope coil pressed against the LEFT side of the pack (-X).
    for (let k = 0; k < 3; k++) {
      const coil = shadowed(new THREE.Mesh(new THREE.TorusGeometry(0.09 - k * 0.004, 0.011, 6, 30), rope));
      coil.rotation.y = Math.PI / 2;
      coil.position.set(-(PACK.w / 2 + 0.011 + k * 0.016), packY, packZ);
      this.spine.add(coil);
    }
    // Shoulder straps: curved tubes from the pack, over the shoulders, down the chest.
    for (const s of [-1, 1]) {
      this.spine.add(
        tube(
          [
            new THREE.Vector3(s * 0.1, 0.44, backZ + 0.01),
            new THREE.Vector3(s * 0.12, 0.505, 0.04),
            new THREE.Vector3(s * 0.125, 0.47, frontZ + 0.035),
            new THREE.Vector3(s * 0.12, 0.33, frontZ - 0.008),
            new THREE.Vector3(s * 0.13, 0.17, frontZ + 0.01),
          ],
          0.013,
          strapLeather,
        ),
      );
    }
    // Chest strap: right shoulder (+X) diagonally to the left hip, with a small pouch.
    this.spine.add(
      tube(
        [
          new THREE.Vector3(0.13, 0.5, 0.03),
          new THREE.Vector3(0.1, 0.42, frontZ - 0.006),
          new THREE.Vector3(0.0, 0.26, frontZ - 0.014),
          new THREE.Vector3(-0.11, 0.09, frontZ + 0.002),
          new THREE.Vector3(-0.16, -0.03, -0.06),
        ],
        0.014,
        strapLeather,
      ),
    );
    const pouch = box(0.075, 0.085, 0.035, 0.012, strapLeather);
    pouch.position.set(0.045, 0.3, frontZ - 0.03);
    pouch.rotation.z = 0.6;
    this.spine.add(pouch);
    // Hatchet on the right hip (+X), handle down, head up.
    const hatchet = new THREE.Group();
    hatchet.position.set(WAIST_W / 2 + 0.015, 0.02, 0.03);
    hatchet.rotation.set(0.1, 0, 0.1);
    this.hips.add(hatchet);
    hatchet.add(shadowed(new THREE.Mesh(new THREE.CylinderGeometry(0.011, 0.014, 0.34, 10).translate(0, -0.12, 0), wood)));
    const headGeo = new THREE.BoxGeometry(0.018, 0.05, 0.095);
    const hg = headGeo.getAttribute('position') as THREE.BufferAttribute;
    for (let k = 0; k < hg.count; k++) {
      const z = hg.getZ(k);
      hg.setX(k, hg.getX(k) * (z < 0 ? 0.35 : 1));
      hg.setY(k, hg.getY(k) * (z < 0 ? 1.5 : 1));
    }
    headGeo.computeVertexNormals();
    const axeHead = shadowed(new THREE.Mesh(headGeo, steel));
    axeHead.position.set(0, 0.045, -0.025);
    hatchet.add(axeHead);
    const loop = new THREE.Mesh(new THREE.TorusGeometry(0.02, 0.005, 6, 14), beltLeather);
    loop.rotation.x = Math.PI / 2;
    loop.position.y = 0.02;
    hatchet.add(loop);
  }

  /** Hold a neutral A-pose (turnaround / character sheet) instead of animating. */
  aPose = false;

  /** Turn instantly to a heading (spawning). Same convention as the camera yaw. */
  face(yaw: number): void {
    this.heading = yaw;
  }

  /** Swing the right arm through a throw (third-person counterpart of the hands' throw). */
  throw(): void {
    this.throwT = 0;
  }

  /** Place at the feet and animate. */
  update(dt: number, feet: THREE.Vector3, s: CharacterState): void {
    this.t += dt;
    this.root.position.copy(feet);
    // Turn smoothly to face the way we're moving.
    if (s.moveDir && s.speed > 0.4) {
      const target = Math.atan2(-s.moveDir.x, -s.moveDir.y);
      let d = target - this.heading;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      this.heading += d * Math.min(1, dt * 10);
    }
    this.root.rotation.y = this.heading;
    if (this.aPose) {
      this.hips.position.y = HIP_Y;
      this.hips.rotation.set(0, 0, 0);
      this.spine.rotation.set(0, 0, 0);
      this.neck.rotation.set(0, 0, 0);
      this.head.rotation.set(0, 0, 0);
      this.legs.forEach((l) => {
        l.upper.rotation.set(0, 0, 0);
        l.lower.rotation.set(0, 0, 0);
        l.end.rotation.set(0, 0, 0);
      });
      this.arms.forEach((a, i) => {
        a.upper.rotation.set(0, 0, (i === 0 ? -1 : 1) * THREE.MathUtils.degToRad(20)); // 20° from the body
        a.lower.rotation.set(0.08, 0, 0);
        a.end.rotation.set(0, 0, 0);
      });
      return;
    }

    const move = Math.min(1, s.speed / 4.2);
    const run = s.sprinting ? Math.min(1, s.speed / 7) : 0;
    const amp = move * (1 + run * 0.5);
    const ph = s.stepPhase;
    this.air += ((s.grounded ? 0 : 1) - this.air) * Math.min(1, dt * 8);
    const c = s.crouch;

    // Hips: bob, crouch, lean
    this.hips.position.y = HIP_Y - Math.abs(Math.cos(ph)) * 0.035 * amp - c * 0.3 + this.air * 0.03;
    this.hips.rotation.y = Math.sin(ph) * 0.08 * amp;
    this.spine.rotation.x = -(0.04 + run * 0.2 + c * 0.35) * (0.4 + move * 0.6) - c * 0.1;
    this.spine.rotation.y = -Math.sin(ph) * 0.1 * amp;
    const breathe = Math.sin(this.t * 1.7) * 0.012 * (1 - move);
    this.chest.scale.set(1 + breathe, 1, 1 + breathe);
    this.neck.rotation.x = -this.spine.rotation.x * 0.3;
    this.head.rotation.x = -this.spine.rotation.x * 0.3;

    // Legs: thighs swing opposite, knees bend on the passing/lift phase.
    this.legs.forEach((l, i) => {
      const p = ph + (i === 0 ? 0 : Math.PI);
      const swing = Math.sin(p) * (0.42 + run * 0.25) * amp;
      // +X rotation swings forward (-Z); knees bend backward (negative), feet stay roughly level.
      l.upper.rotation.x = swing + c * 0.9 + this.air * 0.5;
      const lift = Math.max(0, -Math.cos(p)) * (0.75 + run * 0.6) * amp;
      l.lower.rotation.x = -(lift + 0.06 + c * 1.6 + this.air * 0.9);
      l.end.rotation.x = -(l.upper.rotation.x + l.lower.rotation.x) * 0.85;
    });

    // Arms: swing opposite to the legs, elbows bend more when running.
    let throwBack = 0;
    let throwFwd = 0;
    if (this.throwT >= 0) {
      this.throwT += dt;
      const tt = this.throwT;
      throwBack = tt < 0.22 ? THREE.MathUtils.smoothstep(tt, 0, 0.22) : 1 - THREE.MathUtils.smoothstep(tt, 0.22, 0.32);
      throwFwd = tt < 0.22 ? 0 : tt < 0.34 ? THREE.MathUtils.smoothstep(tt, 0.22, 0.32) : 1 - THREE.MathUtils.smoothstep(tt, 0.34, 0.75);
      if (tt > 0.8) this.throwT = -1;
    }
    this.arms.forEach((a, i) => {
      const side = i === 0 ? -1 : 1;
      const p = ph + (i === 0 ? Math.PI : 0);
      a.upper.rotation.x = Math.sin(p) * (0.35 + run * 0.4) * amp + this.air * 0.4;
      a.upper.rotation.z = side * (0.12 + this.air * 0.25 + c * 0.1);
      a.lower.rotation.x = 0.2 + run * 0.9 + move * 0.15 + Math.max(0, Math.sin(p)) * 0.3 * amp; // elbows flex forward
      if (side > 0 && this.throwT >= 0) {
        a.upper.rotation.x = -2.4 * throwBack + 1.0 * throwFwd;
        a.upper.rotation.z = 0.3 * throwBack;
        a.lower.rotation.x = 1.2 * throwBack + 0.2;
      }
    });
  }
}
