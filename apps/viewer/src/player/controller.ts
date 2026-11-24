/**
 * First-person character: Rapier kinematic character controller with
 * acceleration/friction, gravity, jumping, sprint, crouch, slope limits,
 * wet-ground slipperiness, footsteps and landing events.
 * Forest walls are enforced with the same walk field the server will use.
 */
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { DEFAULT_CONFIG, biomeOfRegion, clearanceAt, regionAt, type BiomeId, type Maze, type WalkField } from '@mazemeo/maze-core';
import { env } from '../env/shared.ts';

export type Surface = 'dirt' | 'grass' | 'leaves' | 'mud' | 'rock';

export interface PlayerEvents {
  onStep?(surface: Surface, loudness: number, wet: number): void;
  onLand?(impact: number, surface: Surface): void;
  onJump?(): void;
}

const RADIUS = 0.32;
const HALF = 0.55;
const EYE = HALF + RADIUS - 0.1; // eye height above capsule centre
const WALK = 4.2;
const RUN = 7.4;
const CROUCH = 2.0;
const GRAVITY = -17;
const JUMP = 6.0;
/** Max clearance (m) into the forest wall a player may push before being stopped. */
const WALL_LIMIT = 1.1;

export class PlayerController {
  readonly velocity = new THREE.Vector3();
  grounded = false;
  crouch = 0; // 0..1 smoothed
  sprinting = false;
  /** Horizontal speed (m/s), smoothed — drives head bob and hands. */
  speed = 0;
  stepPhase = 0;
  surface: Surface = 'dirt';
  biome: BiomeId = 'bamboo';
  events: PlayerEvents = {};
  /** 0..1. Sprinting drains it, jumping costs a little; it recovers at rest. */
  stamina = 1;
  /** 0..1 how loud you are right now (footsteps, landing); fades quickly. */
  noise = 0;
  private exhausted = false;

  private readonly body: RAPIER.RigidBody;
  private readonly collider: RAPIER.Collider;
  private readonly cc: RAPIER.KinematicCharacterController;
  private readonly world: RAPIER.World;
  private readonly field: WalkField;
  private readonly maze: Maze;
  private airTime = 0;
  private fallSpeed = 0;
  private stepDist = 0;
  private jumpQueued = false;
  private readonly wish = new THREE.Vector3();
  private bob = 0;
  private landDip = 0;

  constructor(world: RAPIER.World, maze: Maze, field: WalkField, start: THREE.Vector3) {
    this.world = world;
    this.maze = maze;
    this.field = field;
    this.body = world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(start.x, start.y + HALF + RADIUS + 0.2, start.z));
    this.collider = world.createCollider(RAPIER.ColliderDesc.capsule(HALF, RADIUS).setFriction(0), this.body);
    this.cc = world.createCharacterController(0.03);
    this.cc.setUp({ x: 0, y: 1, z: 0 });
    this.cc.enableAutostep(0.45, 0.25, false);
    this.cc.enableSnapToGround(0.45);
    this.cc.setMaxSlopeClimbAngle(THREE.MathUtils.degToRad(48));
    this.cc.setMinSlopeSlideAngle(THREE.MathUtils.degToRad(55));
    this.cc.setApplyImpulsesToDynamicBodies(true);
    this.cc.setCharacterMass(75);
  }

  get position(): THREE.Vector3 {
    const t = this.body.translation();
    return new THREE.Vector3(t.x, t.y, t.z);
  }

  /** The player's collider (camera rays ignore it). */
  get colliderHandle(): RAPIER.Collider {
    return this.collider;
  }

  /** Horizontal movement direction (unit), or null when (nearly) still. */
  moveDir(out: THREE.Vector2): THREE.Vector2 | null {
    const l = Math.hypot(this.velocity.x, this.velocity.z);
    return l > 0.3 ? out.set(this.velocity.x / l, this.velocity.z / l) : null;
  }

  jump(): void {
    this.jumpQueued = true;
  }

  /**
   * Physics sub-step.
   * @param input move axes in camera space (x = strafe, z = forward), sprint/crouch flags
   * @param yaw camera yaw (radians)
   */
  step(dt: number, input: { x: number; z: number; sprint: boolean; crouch: boolean }, yaw: number): void {
    const t = this.body.translation();
    this.biome = biomeOfRegion(regionAt(t.x, t.z, this.maze.layout, DEFAULT_CONFIG));
    this.surface = this.surfaceAt(t.x, t.z);
    const wet = env.uWetness.value;

    // Desired horizontal velocity
    this.crouch += ((input.crouch ? 1 : 0) - this.crouch) * Math.min(1, dt * 10);
    this.sprinting = input.sprint && !input.crouch && input.z > 0.1 && !this.exhausted;
    if (this.sprinting && Math.hypot(this.velocity.x, this.velocity.z) > 1) this.stamina = Math.max(0, this.stamina - dt * 0.16);
    else this.stamina = Math.min(1, this.stamina + dt * (input.crouch ? 0.16 : 0.11));
    if (this.stamina <= 0) this.exhausted = true;
    else if (this.exhausted && this.stamina > 0.3) this.exhausted = false;
    this.noise = Math.max(0, this.noise - dt * 0.9);
    let max = input.crouch ? CROUCH : this.sprinting ? RUN : WALK;
    if (this.surface === 'mud') max *= 0.75;
    const len = Math.hypot(input.x, input.z);
    const sin = Math.sin(yaw);
    const cos = Math.cos(yaw);
    // Forward is -Z in camera space.
    this.wish.set(input.x * cos - input.z * sin, 0, -input.x * sin - input.z * cos);
    if (len > 1) this.wish.divideScalar(len);
    this.wish.multiplyScalar(max);

    // Acceleration / friction — wet ground is slippery, air control is weak.
    const slip = 1 - wet * (this.surface === 'mud' || this.surface === 'rock' ? 0.55 : 0.3);
    const accel = this.grounded ? (len > 0 ? 38 : 30) * slip : 5;
    const dvx = this.wish.x - this.velocity.x;
    const dvz = this.wish.z - this.velocity.z;
    const dl = Math.hypot(dvx, dvz);
    const maxDv = accel * dt;
    if (dl > 0) {
      const k = Math.min(1, maxDv / dl);
      this.velocity.x += dvx * k;
      this.velocity.z += dvz * k;
    }

    // Gravity & jump
    if (this.grounded && this.jumpQueued && this.crouch < 0.5 && this.stamina > 0.07) {
      this.stamina -= 0.07;
      this.velocity.y = JUMP;
      this.grounded = false;
      this.events.onJump?.();
    }
    this.jumpQueued = false;
    this.velocity.y += GRAVITY * dt;
    if (this.grounded && this.velocity.y < -2) this.velocity.y = -2;

    // Move with collisions
    const desired = { x: this.velocity.x * dt, y: this.velocity.y * dt, z: this.velocity.z * dt };
    this.cc.computeColliderMovement(this.collider, desired);
    const mv = this.cc.computedMovement();
    // Forest walls: block horizontal moves that go deep into the wall (axis-separated so you slide).
    let nx = t.x + mv.x;
    let nz = t.z + mv.z;
    const cNow = clearanceAt(this.field, t.x, t.z);
    if (clearanceAt(this.field, nx, t.z) > WALL_LIMIT && clearanceAt(this.field, nx, t.z) > cNow) {
      nx = t.x;
      this.velocity.x = 0;
    }
    if (clearanceAt(this.field, nx, nz) > WALL_LIMIT && clearanceAt(this.field, nx, nz) > cNow) {
      nz = t.z;
      this.velocity.z = 0;
    }
    this.body.setNextKinematicTranslation({ x: nx, y: t.y + mv.y, z: nz });

    const wasGrounded = this.grounded;
    this.grounded = this.cc.computedGrounded();
    if (this.grounded) {
      if (!wasGrounded && this.airTime > 0.25) {
        const impact = Math.min(1, -this.fallSpeed / 14);
        this.landDip = 0.12 * impact + 0.03;
        this.noise = Math.max(this.noise, 0.5 + impact * 0.5);
        this.events.onLand?.(impact, this.surface);
      }
      this.airTime = 0;
      this.velocity.y = Math.max(this.velocity.y, -2);
    } else {
      this.airTime += dt;
      this.fallSpeed = this.velocity.y;
      if (mv.y > desired.y + 1e-4 && this.velocity.y < 0) this.velocity.y *= 0.5; // hit ground/slope
      if (mv.y < desired.y - 1e-4 && this.velocity.y > 0) this.velocity.y = 0; // bonked head
    }

    // Footsteps
    const hs = Math.hypot(mv.x, mv.z) / dt;
    this.speed += (hs - this.speed) * Math.min(1, dt * 10);
    if (this.grounded && hs > 0.5) {
      const stride = this.sprinting ? 1.05 : this.crouch > 0.5 ? 0.6 : 0.78;
      this.stepDist += hs * dt;
      this.stepPhase += (hs * dt) / stride * Math.PI;
      if (this.stepDist >= stride) {
        this.stepDist -= stride;
        const loud = this.sprinting ? 1 : this.crouch > 0.5 ? 0.25 : 0.6;
        this.noise = Math.max(this.noise, loud);
        this.events.onStep?.(this.surface, loud, wet);
      }
    }
  }

  /** Camera position: eye height with crouch, head bob and landing dip. */
  eye(dt: number, out: THREE.Vector3): THREE.Vector3 {
    const t = this.body.translation();
    const bobAmp = this.grounded ? Math.min(1, this.speed / RUN) * (this.sprinting ? 0.06 : 0.035) : 0;
    this.bob += (bobAmp - this.bob) * Math.min(1, dt * 8);
    this.landDip += (0 - this.landDip) * Math.min(1, dt * 7);
    const y = t.y + EYE - this.crouch * 0.6 - Math.abs(Math.sin(this.stepPhase)) * this.bob - this.landDip;
    return out.set(t.x + Math.cos(this.stepPhase) * this.bob * 0.4, y, t.z);
  }

  private surfaceAt(x: number, z: number): Surface {
    const c = clearanceAt(this.field, x, z);
    switch (this.biome) {
      case 'marsh':
        return c > -1 ? 'mud' : 'dirt';
      case 'summit':
        return 'rock';
      case 'maple':
        return c > -1.5 ? 'leaves' : 'dirt';
      default:
        return c > -1.2 ? 'grass' : 'dirt';
    }
  }

  dispose(): void {
    this.world.removeCharacterController(this.cc);
    this.world.removeRigidBody(this.body);
  }
}
