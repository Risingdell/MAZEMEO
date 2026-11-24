/**
 * Rapier physics world: terrain heightfield (same data as the walk field),
 * static trunk/rock colliders, loose props you can push, and throwable stones.
 */
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { DEFAULT_CONFIG, Rng, heightAt, clearanceAt, type Maze, type WalkField } from '@mazemeo/maze-core';
import type { RockCollider, TrunkCollider } from '../env/foliage.ts';

let rapierReady: Promise<void> | null = null;
export function initPhysics(): Promise<void> {
  rapierReady ??= RAPIER.init();
  return rapierReady;
}

interface Body {
  body: RAPIER.RigidBody;
  index: number;
  lastSpeed: number;
}

export type ImpactFn = (pos: THREE.Vector3, strength: number, kind: 'stone' | 'log' | 'rock') => void;

const MAX_STONES = 40;
const FIXED_DT = 1 / 60;

export class Physics {
  readonly world: RAPIER.World;
  readonly group = new THREE.Group();
  onImpact: ImpactFn | null = null;

  private readonly stoneMesh: THREE.InstancedMesh;
  private readonly rockMesh: THREE.InstancedMesh;
  private readonly logMesh: THREE.InstancedMesh;
  private readonly stones: Body[] = [];
  private readonly props: Array<Body & { mesh: THREE.InstancedMesh; kind: 'log' | 'rock' }> = [];
  private nextStone = 0;
  private accumulator = 0;
  private readonly tmpM = new THREE.Matrix4();
  private readonly tmpQ = new THREE.Quaternion();
  private readonly tmpP = new THREE.Vector3();
  private readonly one = new THREE.Vector3(1, 1, 1);

  constructor(maze: Maze, field: WalkField, trunks: TrunkCollider[], rocks: RockCollider[]) {
    this.world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });

    // Terrain heightfield. Rapier wants cell counts, column-major data,
    // rows along Z and columns along X, centred on the collider position.
    const n = field.size;
    const heights = new Float32Array(n * n);
    for (let col = 0; col < n; col++) for (let row = 0; row < n; row++) heights[row + col * n] = field.height[row * n + col]!;
    const span = (n - 1) * field.cellSize;
    const terrain = RAPIER.ColliderDesc.heightfield(n - 1, n - 1, heights, { x: span, y: 1, z: span })
      .setTranslation(field.originX + span / 2, 0, field.originZ + span / 2)
      .setFriction(0.9);
    this.world.createCollider(terrain);

    for (const t of trunks) {
      this.world.createCollider(RAPIER.ColliderDesc.cylinder(t.height / 2, t.radius).setTranslation(t.x, t.y + t.height / 2 - 0.3, t.z));
    }
    for (const r of rocks) this.world.createCollider(RAPIER.ColliderDesc.ball(r.radius).setTranslation(r.x, r.y, r.z).setFriction(0.8));

    // Visual meshes for dynamic bodies
    const stoneGeo = new THREE.IcosahedronGeometry(0.09, 1);
    const stoneMat = new THREE.MeshStandardMaterial({ color: 0x7a756c, roughness: 0.85, flatShading: true });
    this.stoneMesh = new THREE.InstancedMesh(stoneGeo, stoneMat, MAX_STONES);
    this.stoneMesh.count = 0;
    this.stoneMesh.castShadow = true;
    this.stoneMesh.frustumCulled = false;

    // Loose props around junction clearings: rocks and fallen logs you can push.
    const rng = new Rng(maze.seed ^ 0x9a0b);
    const rockSpots: Array<[number, number, number]> = [];
    const logSpots: Array<[number, number, number]> = [];
    for (const node of maze.nodes) {
      if (node.isExit || !rng.chance(0.45)) continue;
      const count = rng.int(1, 4);
      for (let i = 0; i < count; i++) {
        const a = rng.range(0, Math.PI * 2);
        const r = rng.range(2, DEFAULT_CONFIG.clearingRadius + 1);
        const x = node.x + Math.cos(a) * r;
        const z = node.z + Math.sin(a) * r;
        if (clearanceAt(field, x, z) > 0.5) continue;
        (rng.chance(0.6) ? rockSpots : logSpots).push([x, heightAt(field, x, z), z]);
      }
    }
    const rockGeo = new THREE.DodecahedronGeometry(0.35, 0);
    this.rockMesh = new THREE.InstancedMesh(rockGeo, new THREE.MeshStandardMaterial({ color: 0x7d786f, roughness: 0.9, flatShading: true }), Math.max(1, rockSpots.length));
    const logGeo = new THREE.CylinderGeometry(0.18, 0.2, 2.2, 8).rotateZ(Math.PI / 2);
    const logMat = new THREE.MeshStandardMaterial({ color: 0x5e4a3a, roughness: 0.95 });
    this.logMesh = new THREE.InstancedMesh(logGeo, logMat, Math.max(1, logSpots.length));
    rockSpots.forEach(([x, y, z], i) => {
      const s = rng.range(0.7, 1.4);
      const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(x, y + 0.6 * s, z).setLinearDamping(0.1).setAngularDamping(0.4));
      this.world.createCollider(RAPIER.ColliderDesc.ball(0.3 * s).setDensity(2.4).setFriction(0.9).setRestitution(0.15), body);
      body.userData = { scale: s };
      this.props.push({ body, index: i, lastSpeed: 0, mesh: this.rockMesh, kind: 'rock' });
    });
    logSpots.forEach(([x, y, z], i) => {
      const body = this.world.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic()
          .setTranslation(x, y + 0.4, z)
          .setRotation(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rng.range(0, Math.PI)))
          .setLinearDamping(0.15)
          .setAngularDamping(0.6),
      );
      this.world.createCollider(RAPIER.ColliderDesc.cylinder(1.1, 0.19).setRotation(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2)).setDensity(0.7).setFriction(0.8), body);
      body.userData = { scale: 1 };
      this.props.push({ body, index: i, lastSpeed: 0, mesh: this.logMesh, kind: 'log' });
    });
    for (const m of [this.rockMesh, this.logMesh]) {
      m.castShadow = m.receiveShadow = true;
      m.frustumCulled = false;
      m.count = m === this.rockMesh ? rockSpots.length : logSpots.length;
    }
    this.group.add(this.stoneMesh, this.rockMesh, this.logMesh);
    this.syncProps();
  }

  /** Throw a stone from `origin` with `velocity` (m/s). Recycles the oldest stone. */
  throwStone(origin: THREE.Vector3, velocity: THREE.Vector3): void {
    let s = this.stones[this.nextStone];
    if (!s) {
      const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setCcdEnabled(true).setAngularDamping(0.3));
      this.world.createCollider(RAPIER.ColliderDesc.ball(0.09).setDensity(2.6).setRestitution(0.35).setFriction(0.7), body);
      s = { body, index: this.nextStone, lastSpeed: 0 };
      this.stones[this.nextStone] = s;
    }
    s.body.setTranslation(origin, true);
    s.body.setLinvel(velocity, true);
    s.body.setAngvel({ x: Math.random() * 10 - 5, y: Math.random() * 10 - 5, z: Math.random() * 10 - 5 }, true);
    s.lastSpeed = velocity.length();
    this.nextStone = (this.nextStone + 1) % MAX_STONES;
    this.stoneMesh.count = Math.max(this.stoneMesh.count, this.stones.length);
  }

  /** Advance with a fixed 60 Hz step. `beforeStep` runs once per sub-step (character controller). */
  step(dt: number, beforeStep: (h: number) => void): void {
    this.accumulator = Math.min(this.accumulator + dt, 0.25);
    while (this.accumulator >= FIXED_DT) {
      beforeStep(FIXED_DT);
      this.world.step();
      this.accumulator -= FIXED_DT;
      this.detectImpacts();
    }
    this.syncProps();
  }

  private detectImpacts(): void {
    const check = (b: Body, kind: 'stone' | 'log' | 'rock'): void => {
      if (b.body.isSleeping()) return;
      const v = b.body.linvel();
      const speed = Math.hypot(v.x, v.y, v.z);
      const drop = b.lastSpeed - speed;
      if (drop > 2.2 && this.onImpact) {
        const t = b.body.translation();
        this.onImpact(this.tmpP.set(t.x, t.y, t.z), Math.min(1, drop / 12), kind);
      }
      b.lastSpeed = speed;
    };
    for (const s of this.stones) check(s, 'stone');
    for (const p of this.props) check(p, p.kind);
  }

  private syncProps(): void {
    const write = (mesh: THREE.InstancedMesh, b: Body, scale: number): void => {
      const t = b.body.translation();
      const r = b.body.rotation();
      this.tmpQ.set(r.x, r.y, r.z, r.w);
      this.tmpM.compose(this.tmpP.set(t.x, t.y, t.z), this.tmpQ, this.one.set(scale, scale, scale));
      mesh.setMatrixAt(b.index, this.tmpM);
    };
    for (const s of this.stones) write(this.stoneMesh, s, 1);
    for (const p of this.props) write(p.mesh, p, (p.body.userData as { scale: number }).scale);
    this.stoneMesh.instanceMatrix.needsUpdate = true;
    this.rockMesh.instanceMatrix.needsUpdate = true;
    this.logMesh.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    this.world.free();
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose();
      (m.material as THREE.Material | undefined)?.dispose?.();
    });
  }
}
