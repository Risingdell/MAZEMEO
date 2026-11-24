/**
 * First-person hands (view model), rendered in their own scene on top of the
 * world so they never clip into trees.
 *
 * Built at real adult proportions (metres): a shaped palm (wider at the
 * knuckles, arched back, fleshy thumb pad), knuckle bumps, fingers of the
 * correct relative lengths that taper to the tip, fingernails, and a
 * three-bone thumb. Both hands are built as right hands; the left is a true
 * mirror. Worn leather gloves with rope-wrapped wrists (or bare skin with a
 * soft sheen + faint warm glow when `gloved` is false).
 *
 * Animation: idle breathing, walk/run swing synced to footsteps, look-sway
 * inertia, jump/land, and a stone throw (wind-up -> release -> recover).
 */
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import type { EnvTextures } from '../env/textures.ts';

interface Finger {
  joints: THREE.Group[];
}

interface Hand {
  root: THREE.Group; // positioned/rotated in camera space
  wrist: THREE.Group;
  fingers: Finger[]; // index, middle, ring, little
  thumb: Finger;
  side: 1 | -1; // 1 = right, -1 = left
}

export interface HandLighting {
  sunDir: THREE.Vector3;
  sunColor: THREE.Color;
  sunIntensity: number;
  hemiSky: THREE.Color;
  hemiGround: THREE.Color;
  hemiIntensity: number;
  env: THREE.Texture | null;
  envIntensity: number;
  viewMatrix: THREE.Matrix4;
}

/** Finger specs for a right hand, palm down, fingers towards -Z (thumb on -X). */
const FINGERS = [
  { x: -0.029, z: -0.101, y: 0.0, r: 0.0098, len: [0.041, 0.025, 0.02] }, // index
  { x: -0.0095, z: -0.105, y: 0.0015, r: 0.0101, len: [0.046, 0.028, 0.021] }, // middle
  { x: 0.0105, z: -0.101, y: 0.0, r: 0.0095, len: [0.043, 0.027, 0.02] }, // ring
  { x: 0.0285, z: -0.093, y: -0.003, r: 0.0084, len: [0.033, 0.02, 0.018] }, // little
];

function skinDetailTexture(): THREE.CanvasTexture {
  const s = 128;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(s, s);
  let seed = 7;
  for (let i = 0; i < s * s; i++) {
    seed = (seed * 16807) % 2147483647;
    const v = 128 + ((seed / 2147483647) - 0.5) * 40;
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(6, 6);
  return t;
}

export class Hands {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(62, 1, 0.01, 10);
  private readonly sun = new THREE.DirectionalLight(0xffffff, 2);
  private readonly hemi = new THREE.HemisphereLight(0xffffff, 0x333333, 1);
  private readonly rig = new THREE.Group();
  private readonly left: Hand;
  private readonly right: Hand;
  private readonly heldStone: THREE.Mesh;

  private t = 0;
  private readonly sway = new THREE.Vector2();
  private readonly swayVel = new THREE.Vector2();
  private throwT = -1; // -1 idle, else seconds since throw started
  private stoneReady = true;
  private reloadT = 0;
  private air = 0;
  private onRelease: (() => void) | null = null;
  visible = true;
  /** Leather gloves (true) or bare skin. */
  readonly gloved = true;
  /** Whether the right hand carries a stone between throws (the lab turns this off). */
  holdingStone = true;

  constructor(tex: EnvTextures) {
    this.scene.add(this.sun, this.sun.target, this.hemi, this.rig);
    const detail = skinDetailTexture();
    const skin = new THREE.MeshPhysicalMaterial({
      color: 0xb47d5c,
      roughness: 0.55,
      sheen: 0.4,
      sheenColor: new THREE.Color(0xffa585),
      sheenRoughness: 0.45,
      emissive: 0x3a1408,
      emissiveIntensity: 0.22,
      bumpMap: detail,
      bumpScale: 0.25,
    });
    const nail = new THREE.MeshPhysicalMaterial({ color: 0xd9a790, roughness: 0.3, clearcoat: 0.6, clearcoatRoughness: 0.3 });
    const sleeve = new THREE.MeshStandardMaterial({ color: 0x2b3550, roughness: 0.95, map: tex.cloth });
    // Worn leather gloves with rope-wrapped wrists.
    tex.rope.repeat.set(40, 1);
    const wrap = new THREE.MeshStandardMaterial({ map: tex.rope, bumpMap: tex.rope, bumpScale: 0.8, roughness: 0.95, color: 0x9a8a70 }); // weathered hemp
    const glove = new THREE.MeshStandardMaterial({ map: tex.leather, bumpMap: tex.leather, bumpScale: 0.6, roughness: 0.7 });
    const hand = this.gloved ? glove : skin;
    this.right = this.buildHand(1, hand, this.gloved ? glove : nail, sleeve, wrap);
    this.left = this.buildHand(-1, hand, this.gloved ? glove : nail, sleeve, wrap);
    this.heldStone = new THREE.Mesh(new THREE.IcosahedronGeometry(0.03, 1), new THREE.MeshStandardMaterial({ color: 0x7a756c, roughness: 0.85, flatShading: true }));
    this.heldStone.position.set(-0.006, -0.03, -0.075);
    this.right.wrist.add(this.heldStone);
  }

  private buildHand(side: 1 | -1, skin: THREE.Material, nail: THREE.Material, sleeve: THREE.Material, wrap: THREE.Material): Hand {
    const root = new THREE.Group();
    this.rig.add(root);
    // Build a right hand; mirror it for the left.
    const mirror = new THREE.Group();
    mirror.scale.x = side;
    root.add(mirror);

    // Forearm (+Z towards the elbow), slightly oval.
    const forearm = new THREE.Mesh(new THREE.CylinderGeometry(0.031, 0.04, 0.22, 20, 4).rotateX(Math.PI / 2), skin);
    forearm.position.z = 0.1;
    forearm.scale.set(1.15, 0.86, 1);
    mirror.add(forearm);
    // Sleeve with cloth folds, rolled to mid-forearm.
    const sleeveGeo = new THREE.CylinderGeometry(0.052, 0.062, 0.3, 18, 8, true).rotateX(Math.PI / 2);
    const sp = sleeveGeo.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < sp.count; i++) {
      const x = sp.getX(i);
      const y = sp.getY(i);
      const z = sp.getZ(i);
      const a = Math.atan2(y, x);
      const k = 1 + Math.sin(a * 5 + z * 30) * 0.05 + Math.sin(z * 50) * 0.025;
      sp.setXYZ(i, x * k, y * k * 0.92, z);
    }
    sleeveGeo.computeVertexNormals();
    const sleeveMesh = new THREE.Mesh(sleeveGeo, sleeve);
    sleeveMesh.position.z = 0.24;
    mirror.add(sleeveMesh);
    // Glove cuff over the wrist, then rope wound round it in a spiral.
    const cuff = new THREE.Mesh(new THREE.CylinderGeometry(0.041, 0.047, 0.075, 20, 1, true).rotateX(Math.PI / 2), skin);
    cuff.position.z = 0.028;
    cuff.scale.set(1.13, 0.88, 1);
    mirror.add(cuff);
    const turns = 3;
    const helix: THREE.Vector3[] = [];
    for (let k = 0; k <= 90; k++) {
      const t = k / 90;
      const a = t * turns * Math.PI * 2;
      const r = 0.047 + Math.sin(t * Math.PI) * 0.002;
      helix.push(new THREE.Vector3(Math.cos(a) * r * 1.13, Math.sin(a) * r * 0.88, 0.006 + t * 0.052));
    }
    mirror.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(helix), 140, 0.0032, 6), wrap));

    const wrist = new THREE.Group();
    mirror.add(wrist);

    // Palm: rounded box, tapered towards the wrist, arched on the back,
    // thinner at the knuckles, with a thenar (thumb) pad underneath.
    const palmGeo = new RoundedBoxGeometry(0.08, 0.03, 0.1, 4, 0.012);
    const pp = palmGeo.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < pp.count; i++) {
      let x = pp.getX(i);
      let y = pp.getY(i);
      const z = pp.getZ(i); // +0.05 wrist end .. -0.05 knuckle end
      const along = (0.05 - z) / 0.1; // 0 wrist -> 1 knuckles
      x *= 0.8 + 0.2 * along;
      if (y > 0) y -= x * x * 4; // arched back of the hand
      y *= 1 - along * 0.2; // thinner towards the knuckles
      if (y < 0) {
        const dx = x + 0.022;
        const dz = z - 0.022;
        y -= 0.009 * Math.exp(-(dx * dx + dz * dz) / 0.00035); // thumb pad
        const hx = x - 0.026;
        const hz = z - 0.02;
        y -= 0.004 * Math.exp(-(hx * hx + hz * hz) / 0.0003); // heel on the little-finger side
      }
      pp.setXYZ(i, x, y, z);
    }
    palmGeo.computeVertexNormals();
    const palm = new THREE.Mesh(palmGeo, skin);
    palm.position.set(0, 0, -0.052);
    wrist.add(palm);

    const fingers: Finger[] = FINGERS.map((f) => {
      const knuckle = new THREE.Mesh(new THREE.SphereGeometry(f.r * 1.08, 14, 10), skin);
      knuckle.position.set(f.x, f.y + 0.004, f.z + 0.004);
      knuckle.scale.set(1, 0.9, 1.1);
      wrist.add(knuckle);
      return this.buildFinger(wrist, new THREE.Vector3(f.x, f.y, f.z), f.len, f.r, skin, nail);
    });

    // Thumb: metacarpal from the base of the palm, angled forward, out and down.
    const thumb = this.buildFinger(wrist, new THREE.Vector3(-0.026, -0.008, -0.022), [0.042, 0.031, 0.026], 0.0122, skin, nail);
    thumb.joints[0]!.rotation.set(-0.3, 0.62, 0.75);
    return { root, wrist, fingers, thumb, side };
  }

  private buildFinger(parent: THREE.Object3D, at: THREE.Vector3, lengths: number[], radius: number, skin: THREE.Material, nail: THREE.Material): Finger {
    const joints: THREE.Group[] = [];
    let p: THREE.Object3D = parent;
    let pos = at;
    lengths.forEach((len, i) => {
      const j = new THREE.Group();
      j.position.copy(pos);
      p.add(j);
      const r = radius * (1 - i * 0.1);
      // Segment slightly tapered along its length, flattened top-to-bottom.
      const geo = new THREE.CapsuleGeometry(r, len, 6, 14).rotateX(Math.PI / 2);
      const gp = geo.getAttribute('position') as THREE.BufferAttribute;
      for (let k = 0; k < gp.count; k++) {
        const z = gp.getZ(k); // +len/2 base .. -len/2 tip
        const taper = 1 - ((len / 2 - z) / len) * 0.1;
        gp.setXYZ(k, gp.getX(k) * taper, gp.getY(k) * taper * 0.9, z);
      }
      geo.computeVertexNormals();
      const seg = new THREE.Mesh(geo, skin);
      seg.position.z = -len / 2;
      j.add(seg);
      if (i === lengths.length - 1) {
        const n = new THREE.Mesh(new THREE.SphereGeometry(1, 14, 8), nail);
        n.scale.set(r * 0.78, r * 0.25, len * 0.42);
        n.position.set(0, r * 0.74, -len * 0.62);
        n.rotation.x = 0.06;
        j.add(n);
      }
      joints.push(j);
      p = j;
      pos = new THREE.Vector3(0, 0, -len);
    });
    return { joints };
  }

  /** Curl a finger: 0 = straight, 1 = tight fist. Joints bend MCP < PIP > DIP like a real hand. */
  private curl(f: Finger, amount: number, spread = 0): void {
    const k = [1.3, 1.65, 1.1];
    f.joints.forEach((j, i) => {
      j.rotation.x = -amount * k[i]!;
      if (i === 0) j.rotation.y = spread;
    });
  }

  private curlThumb(f: Finger, amount: number): void {
    f.joints[1]!.rotation.x = -amount * 0.7;
    f.joints[2]!.rotation.x = -amount * 0.9;
  }

  /** Begin a throw; `release` fires at the moment the stone leaves the hand. */
  throw(release: () => void): boolean {
    if (this.throwT >= 0 || !this.stoneReady) return false;
    this.throwT = 0;
    this.onRelease = release;
    return true;
  }

  resize(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  /**
   * @param speed horizontal speed m/s, @param stepPhase footstep phase (radians)
   * @param lookDelta camera yaw/pitch change this frame (radians)
   */
  update(dt: number, speed: number, stepPhase: number, sprinting: boolean, grounded: boolean, crouch: number, lookDelta: THREE.Vector2, world: HandLighting): void {
    this.t += dt;
    // Lights follow the world, expressed in view space (hands live in camera space).
    this.sun.position.copy(world.sunDir).transformDirection(world.viewMatrix).multiplyScalar(5);
    this.sun.color.copy(world.sunColor);
    this.sun.intensity = world.sunIntensity * 0.55;
    this.hemi.position.set(0, 1, 0).transformDirection(world.viewMatrix);
    this.hemi.color.copy(world.hemiSky);
    this.hemi.groundColor.copy(world.hemiGround);
    this.hemi.intensity = world.hemiIntensity * 0.7;
    this.scene.environment = world.env;
    this.scene.environmentIntensity = world.envIntensity * 0.7;

    // Look sway: spring towards the opposite of mouse motion.
    this.swayVel.x += (-lookDelta.x * 0.9 - this.sway.x) * 60 * dt;
    this.swayVel.y += (-lookDelta.y * 0.9 - this.sway.y) * 60 * dt;
    this.swayVel.multiplyScalar(Math.exp(-dt * 14));
    this.sway.addScaledVector(this.swayVel, dt);
    this.air += ((grounded ? 0 : 1) - this.air) * Math.min(1, dt * 6);

    const move = Math.min(1, speed / 7.4);
    const run = sprinting ? 1 : 0;
    const breathe = Math.sin(this.t * 1.6) * 0.003;

    // Throw timeline: 0-0.22 wind-up, 0.22-0.34 release, -> 0.75 recover.
    let throwBack = 0;
    let throwFwd = 0;
    if (this.throwT >= 0) {
      this.throwT += dt;
      const tt = this.throwT;
      if (tt < 0.22) throwBack = THREE.MathUtils.smoothstep(tt, 0, 0.22);
      else if (tt < 0.34) {
        throwBack = 1 - THREE.MathUtils.smoothstep(tt, 0.22, 0.3);
        throwFwd = THREE.MathUtils.smoothstep(tt, 0.22, 0.32);
        if (this.stoneReady && tt >= 0.27) {
          this.stoneReady = false;
          this.heldStone.visible = false;
          this.onRelease?.();
          this.reloadT = 0.55;
        }
      } else {
        throwFwd = 1 - THREE.MathUtils.smoothstep(tt, 0.34, 0.75);
      }
      if (tt > 0.8) this.throwT = -1;
    }
    if (!this.stoneReady) {
      this.reloadT -= dt;
      if (this.reloadT <= 0 && this.throwT < 0) {
        this.stoneReady = true;
        this.heldStone.visible = true;
      }
    }

    for (const h of [this.left, this.right]) {
      const s = h.side;
      // Arms swing opposite to each other with the stride; running pumps harder.
      const swing = Math.sin(stepPhase + (s > 0 ? 0 : Math.PI)) * move * (0.022 + run * 0.045);
      const bobY = -Math.abs(Math.cos(stepPhase)) * move * (0.01 + run * 0.018);
      const pos = new THREE.Vector3(0.15 * s, -0.165 - crouch * 0.03, -0.32);
      pos.x += this.sway.x * 0.035 + Math.sin(stepPhase * 0.5) * move * 0.006;
      pos.y += this.sway.y * 0.035 + bobY + breathe + this.air * 0.035;
      pos.z += swing;
      // Forearms rise from below the view, hands turned slightly inwards, palms angled down-in.
      const rot = new THREE.Euler(0.16 + swing * 2 - this.air * 0.25 + run * 0.2, -0.3 * s + this.sway.x * 0.25, -0.6 * s + swing * 0.6 * s);
      h.wrist.rotation.set(-0.02, 0, 0.05 * s);

      // Relaxed hand: each finger a little more curled than the one before (index -> little).
      let curls = [0.36, 0.44, 0.52, 0.6].map((c) => c + Math.sin(this.t * 1.1 + s) * 0.02);
      let thumbCurl = 0.35;
      if (run) curls = [0.8, 0.85, 0.9, 0.92]; // loose fists when sprinting
      if (s > 0) {
        this.heldStone.visible = this.holdingStone && this.stoneReady;
        if (this.holdingStone && this.stoneReady && this.throwT < 0) {
          curls = [0.62, 0.7, 0.78, 0.85];
          thumbCurl = 0.55;
        }
        // Throw: arm goes up/back over the shoulder, then whips forward.
        pos.x -= throwBack * 0.02 - throwFwd * 0.06;
        pos.y += throwBack * 0.16 - throwFwd * 0.05;
        pos.z += throwBack * 0.17 - throwFwd * 0.24;
        rot.x += throwBack * 1.2 - throwFwd * 0.9;
        rot.z -= throwBack * 0.5;
        if (throwFwd > 0.2) {
          curls = [0.05, 0.05, 0.08, 0.1];
          thumbCurl = 0.05;
        }
      } else {
        // Left hand balances the throw.
        pos.z -= throwBack * 0.08;
        pos.x += throwBack * 0.04;
        rot.x -= throwBack * 0.3;
      }
      h.root.position.copy(pos);
      h.root.rotation.copy(rot);
      h.fingers.forEach((f, i) => this.curl(f, curls[i]!, (i - 1.5) * 0.018));
      this.curlThumb(h.thumb, thumbCurl);
    }
  }

  render(renderer: THREE.WebGLRenderer): void {
    if (!this.visible) return;
    renderer.autoClear = false;
    renderer.clearDepth();
    renderer.render(this.scene, this.camera);
    renderer.autoClear = true;
  }
}
