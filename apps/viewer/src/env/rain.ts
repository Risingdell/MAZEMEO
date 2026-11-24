/**
 * GPU rain: streaks wrap in a box around the camera and slant with the wind;
 * CPU-spawned splashes pop on the terrain around the player.
 */
import * as THREE from 'three';
import { heightAt, type WalkField } from '@mazemeo/maze-core';
import { env } from './shared.ts';

const DROPS = 14000;
const BOX = new THREE.Vector3(70, 36, 70);
const SPLASHES = 500;

export class Rain {
  readonly object = new THREE.Group();
  private readonly streaks: THREE.LineSegments;
  private readonly uniforms: Record<string, THREE.IUniform>;
  private readonly splashGeo = new THREE.BufferGeometry();
  private readonly splashPos = new Float32Array(SPLASHES * 3);
  private readonly splashLife = new Float32Array(SPLASHES);
  private readonly splashMat: THREE.ShaderMaterial;
  private field: WalkField | null = null;

  constructor() {
    const seeds = new Float32Array(DROPS * 2 * 3);
    const ends = new Float32Array(DROPS * 2);
    for (let i = 0; i < DROPS; i++) {
      const s = [Math.random(), Math.random(), Math.random()];
      seeds.set(s, i * 6);
      seeds.set(s, i * 6 + 3);
      ends[i * 2] = 0;
      ends[i * 2 + 1] = 1;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(seeds, 3)); // seeds stored as position
    geo.setAttribute('aEnd', new THREE.BufferAttribute(ends, 1));
    this.uniforms = {
      uTime: env.uTime,
      uWindDir: env.uWindDir,
      uWindStrength: env.uWindStrength,
      uCam: { value: new THREE.Vector3() },
      uBox: { value: BOX },
      uIntensity: { value: 0 },
      uLight: { value: new THREE.Color(0.8, 0.82, 0.86) },
    };
    this.streaks = new THREE.LineSegments(
      geo,
      new THREE.ShaderMaterial({
        uniforms: this.uniforms,
        transparent: true,
        depthWrite: false,
        vertexShader: /* glsl */ `
          attribute float aEnd;
          uniform float uTime; uniform vec2 uWindDir; uniform float uWindStrength;
          uniform vec3 uCam; uniform vec3 uBox;
          varying float vFade;
          void main() {
            vec3 vel = vec3(uWindDir.x * uWindStrength * 7.0, -14.0 - position.y * 4.0, uWindDir.y * uWindStrength * 7.0);
            vec3 p = position * uBox + vel * uTime;
            p = mod(p - uCam + uBox * 0.5, uBox) - uBox * 0.5 + uCam;
            p -= normalize(vel) * aEnd * (0.55 + position.z * 0.35);
            vec4 mv = modelViewMatrix * vec4(p, 1.0);
            vFade = (1.0 - smoothstep(10.0, 34.0, length(p - uCam))) * (0.5 + 0.5 * aEnd);
            gl_Position = projectionMatrix * mv;
          }`,
        fragmentShader: /* glsl */ `
          uniform float uIntensity; uniform vec3 uLight;
          varying float vFade;
          void main() {
            gl_FragColor = vec4(uLight, 0.32 * uIntensity * vFade);
            #include <tonemapping_fragment>
            #include <colorspace_fragment>
          }`,
      }),
    );
    this.streaks.frustumCulled = false;
    this.object.add(this.streaks);

    this.splashGeo.setAttribute('position', new THREE.BufferAttribute(this.splashPos, 3));
    this.splashGeo.setAttribute('aLife', new THREE.BufferAttribute(this.splashLife, 1));
    this.splashMat = new THREE.ShaderMaterial({
      uniforms: { uIntensity: { value: 0 }, uLight: this.uniforms.uLight! },
      transparent: true,
      depthWrite: false,
      vertexShader: /* glsl */ `
        attribute float aLife;
        varying float vLife;
        void main() {
          vLife = aLife;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = (1.0 - aLife) * 220.0 / -mv.z;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        uniform float uIntensity; uniform vec3 uLight;
        varying float vLife;
        void main() {
          vec2 c = gl_PointCoord - 0.5;
          float r = length(c);
          float ring = smoothstep(0.5, 0.38, r) * smoothstep(0.18, 0.34, r);
          if (vLife <= 0.0 || ring < 0.01) discard;
          gl_FragColor = vec4(uLight, ring * vLife * 0.6 * uIntensity);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
    const splashes = new THREE.Points(this.splashGeo, this.splashMat);
    splashes.frustumCulled = false;
    this.object.add(splashes);
  }

  setField(field: WalkField): void {
    this.field = field;
  }

  update(dt: number, camera: THREE.Camera, intensity: number, light: THREE.Color, onGround: boolean): void {
    (this.uniforms.uCam!.value as THREE.Vector3).copy(camera.position);
    this.uniforms.uIntensity!.value = intensity;
    (this.uniforms.uLight!.value as THREE.Color).copy(light);
    this.object.visible = intensity > 0.01;
    this.streaks.geometry.setDrawRange(0, Math.floor(DROPS * Math.min(1, intensity * 1.1)) * 2);
    this.splashMat.uniforms.uIntensity!.value = onGround ? intensity : 0;
    if (!this.object.visible || !onGround || !this.field) return;
    const spawnRate = intensity * 900 * dt;
    let toSpawn = spawnRate;
    for (let i = 0; i < SPLASHES; i++) {
      if (this.splashLife[i]! > 0) {
        this.splashLife[i] = Math.max(0, this.splashLife[i]! - dt * 4);
      } else if (toSpawn > Math.random()) {
        toSpawn -= 1;
        const a = Math.random() * Math.PI * 2;
        const r = 1 + Math.sqrt(Math.random()) * 22;
        const x = camera.position.x + Math.cos(a) * r;
        const z = camera.position.z + Math.sin(a) * r;
        this.splashPos.set([x, heightAt(this.field, x, z) + 0.05, z], i * 3);
        this.splashLife[i] = 1;
      }
    }
    this.splashGeo.attributes.position!.needsUpdate = true;
    this.splashGeo.attributes.aLife!.needsUpdate = true;
  }
}
