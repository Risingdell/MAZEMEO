/**
 * Dust motes / pollen drifting around the player. They catch the light like
 * dust in a forest sunbeam: barely visible in shade or looking away from the
 * sun, glowing warm when backlit.
 */
import * as THREE from 'three';
import { env } from './shared.ts';

const COUNT = 700;
const BOX = new THREE.Vector3(22, 10, 22);

export class Motes {
  readonly points: THREE.Points;
  private readonly uniforms: Record<string, THREE.IUniform>;

  constructor() {
    const pos = new Float32Array(COUNT * 3);
    for (let i = 0; i < COUNT * 3; i++) pos[i] = Math.random();
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.uniforms = {
      uTime: env.uTime,
      uWindDir: env.uWindDir,
      uWindStrength: env.uWindStrength,
      uCam: { value: new THREE.Vector3() },
      uBox: { value: BOX },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uSunColor: { value: new THREE.Color() },
      uAmount: { value: 0 },
    };
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexShader: /* glsl */ `
        uniform float uTime; uniform vec2 uWindDir; uniform float uWindStrength;
        uniform vec3 uCam; uniform vec3 uBox; uniform vec3 uSunDir;
        varying float vGlow;
        void main() {
          vec3 seed = position;
          vec3 drift = vec3(uWindDir.x, 0.0, uWindDir.y) * (0.15 + uWindStrength * 0.6) * uTime
                     + vec3(sin(uTime * 0.31 + seed.x * 40.0), sin(uTime * 0.23 + seed.y * 30.0) * 0.6 - 0.05 * uTime, cos(uTime * 0.27 + seed.z * 50.0)) * 0.6;
          vec3 p = seed * uBox + drift;
          p = mod(p - uCam + uBox * 0.5, uBox) - uBox * 0.5 + uCam;
          vec3 toP = normalize(p - uCam);
          // Forward scattering: bright when the sun is behind the mote.
          vGlow = pow(max(dot(toP, uSunDir), 0.0), 3.0) * 0.9 + 0.08;
          vGlow *= 1.0 - smoothstep(6.0, 11.0, length(p - uCam));
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          // Tiny specks: capped so motes right in front of the lens never balloon into blobs.
          gl_PointSize = clamp((0.8 + fract(seed.x * 91.0) * 1.2) * 14.0 / -mv.z, 1.0, 3.5);
          vGlow *= smoothstep(1.2, 3.0, -mv.z);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uSunColor; uniform float uAmount;
        varying float vGlow;
        void main() {
          float r = length(gl_PointCoord - 0.5) * 2.0;
          float a = smoothstep(1.0, 0.0, r) * vGlow * uAmount;
          gl_FragColor = vec4(uSunColor * a, a);
        }`,
    });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
  }

  /** @param amount 0..1 (sun strength × how dusty/still the air is) */
  update(camera: THREE.Camera, sunDir: THREE.Vector3, sunColor: THREE.Color, amount: number, visible: boolean): void {
    this.points.visible = visible && amount > 0.01;
    (this.uniforms.uCam!.value as THREE.Vector3).copy(camera.position);
    (this.uniforms.uSunDir!.value as THREE.Vector3).copy(sunDir);
    (this.uniforms.uSunColor!.value as THREE.Color).copy(sunColor);
    this.uniforms.uAmount!.value = amount;
  }
}
