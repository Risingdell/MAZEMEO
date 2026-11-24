/**
 * Sun, physically-based sky, moving cloud layer, fog colour, image-based
 * lighting (PMREM from the sky) and lightning flashes.
 */
import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { env } from './shared.ts';
import type { Weather } from './weather.ts';

const CLOUD_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = p.xyww; // always at the far plane
}`;

const CLOUD_FRAG = /* glsl */ `
uniform float uTime;
uniform vec2 uWind;
uniform float uWindStrength;
uniform float uCoverage;
uniform float uDark;
uniform float uFlash;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uAmbient;
uniform vec3 uHaze;
varying vec3 vDir;

float h(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float n2(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h(i), h(i + vec2(1, 0)), f.x), mix(h(i + vec2(0, 1)), h(i + vec2(1, 1)), f.x), f.y);
}
float fbm(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 6; i++) { s += a * n2(p); p = p * 2.03 + vec2(1.7, 9.2); a *= 0.5; }
  return s;
}
void main() {
  vec3 d = normalize(vDir);
  if (d.y < 0.0) discard;
  float t = 1.0 / max(d.y, 0.03);
  vec2 p = d.xz * t * 0.9;
  vec2 drift = uWind * uTime * (0.012 + uWindStrength * 0.03);
  float base = fbm(p + drift);
  float detail = fbm(p * 2.7 + drift * 1.6);
  float n = base * 0.75 + detail * 0.25;
  float cov = mix(0.62, 0.18, uCoverage);
  float density = smoothstep(cov, cov + 0.28, n);
  // Self-shadowing: sample towards the sun.
  float toward = fbm(p + drift + uSunDir.xz * 0.35);
  float shade = clamp(1.0 - (toward - n) * 2.5, 0.35, 1.0);
  float sunFacing = pow(max(dot(d, uSunDir), 0.0), 6.0);
  vec3 lit = uAmbient * 1.1 + uSunColor * (0.55 * shade + sunFacing * 0.8);
  vec3 col = mix(lit, uAmbient * 0.35, uDark * density);
  col += vec3(0.9, 0.92, 1.0) * uFlash * 3.0 * density;
  float horizon = smoothstep(0.0, 0.22, d.y);
  col = mix(uHaze, col, horizon);
  float alpha = density * horizon * mix(0.85, 1.0, uCoverage);
  gl_FragColor = vec4(col, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export class SkySystem {
  readonly sun = new THREE.DirectionalLight(0xffffff, 3);
  readonly hemi = new THREE.HemisphereLight(0xbfd4ff, 0x3a3226, 0.6);
  readonly fog = new THREE.FogExp2(0xb0b6b8, 0.002);
  readonly sunDir = new THREE.Vector3();
  /** 0..1 how much daylight there is (for audio/birds). */
  daylight = 1;
  /** Rotates the sun path (degrees) so golden hour can set down a chosen trail. */
  azimuthOffset = 0;

  private readonly sky = new Sky();
  private readonly envSky = new Sky();
  private readonly envScene = new THREE.Scene();
  private readonly clouds: THREE.Mesh;
  private readonly cloudUniforms: Record<string, THREE.IUniform>;
  private readonly pmrem: THREE.PMREMGenerator;
  private envTarget: THREE.WebGLRenderTarget | null = null;
  private envKey = '';
  private envCooldown = 0;
  private readonly scene: THREE.Scene;

  constructor(scene: THREE.Scene, renderer: THREE.WebGLRenderer) {
    this.scene = scene;
    this.sky.scale.setScalar(3000);
    this.sky.frustumCulled = false;
    this.envSky.scale.setScalar(3000);
    this.envScene.add(this.envSky);
    scene.add(this.sky);

    this.cloudUniforms = {
      uTime: env.uTime,
      uWind: env.uWindDir,
      uWindStrength: env.uWindStrength,
      uCoverage: { value: 0.2 },
      uDark: { value: 0 },
      uFlash: { value: 0 },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uSunColor: { value: new THREE.Color(1, 1, 1) },
      uAmbient: { value: new THREE.Color(0.5, 0.55, 0.6) },
      uHaze: { value: new THREE.Color(0.6, 0.65, 0.7) },
    };
    this.clouds = new THREE.Mesh(
      new THREE.SphereGeometry(2500, 48, 24, 0, Math.PI * 2, 0, Math.PI / 2),
      new THREE.ShaderMaterial({ uniforms: this.cloudUniforms, vertexShader: CLOUD_VERT, fragmentShader: CLOUD_FRAG, transparent: true, depthWrite: false, side: THREE.BackSide, fog: false }),
    );
    this.clouds.frustumCulled = false;
    this.clouds.renderOrder = -1;
    scene.add(this.clouds);

    this.sun.castShadow = true;
    this.sun.shadow.bias = -0.0003;
    this.sun.shadow.normalBias = 0.5;
    scene.add(this.sun, this.sun.target, this.hemi);
    scene.fog = this.fog;
    this.pmrem = new THREE.PMREMGenerator(renderer);
  }

  setShadowQuality(mapSize: number): void {
    if (this.sun.shadow.mapSize.x === mapSize) return;
    this.sun.shadow.mapSize.set(mapSize, mapSize);
    this.sun.shadow.map?.dispose();
    this.sun.shadow.map = null;
  }

  /**
   * @param hours time of day 5..19
   * @param focus point the shadow frustum follows (player or map centre)
   * @param shadowRadius half-size of the shadow frustum (m)
   * @param fogBase base fog density before weather
   */
  update(dt: number, weather: Weather, hours: number, focus: THREE.Vector3, camera: THREE.Camera, shadowRadius: number, fogBase: number): void {
    const w = weather.current;

    // --- Sun path: rises in the east (+x), sets in the west, peaks ~58°.
    const t = (hours - 6) / 12;
    const elevation = Math.sin(t * Math.PI) * 58 - (t < 0 || t > 1 ? 8 : 0);
    const azimuth = 100 + t * 160 + this.azimuthOffset;
    this.sunDir.setFromSphericalCoords(1, THREE.MathUtils.degToRad(90 - elevation), THREE.MathUtils.degToRad(azimuth));
    const day = THREE.MathUtils.smoothstep(elevation, -4, 12);
    const golden = 1 - THREE.MathUtils.smoothstep(elevation, 4, 30);
    this.daylight = day * (1 - w.darkness * 0.5);

    // --- Sky model
    for (const s of [this.sky, this.envSky]) {
      const u = (s.material as THREE.ShaderMaterial).uniforms;
      u.turbidity!.value = 2.5 + w.cloud * 10 + w.fog * 0.6;
      u.rayleigh!.value = 1.2 + golden * 1.6 - w.darkness * 0.9;
      u.mieCoefficient!.value = 0.004 + w.cloud * 0.01;
      u.mieDirectionalG!.value = 0.85 - w.cloud * 0.2;
      u.sunPosition!.value.copy(this.sunDir);
    }

    // --- Sun light (dims under cloud)
    const sunWarm = new THREE.Color(1.0, 0.52, 0.28);
    const sunNoon = new THREE.Color(1.0, 0.95, 0.88);
    const sunColor = sunNoon.clone().lerp(sunWarm, golden);
    this.sun.color.copy(sunColor);
    this.sun.intensity = 3.4 * day * w.sun;
    this.sun.position.copy(focus).addScaledVector(this.sunDir, 500);
    this.sun.target.position.copy(focus);
    const sc = this.sun.shadow.camera;
    if (sc.right !== shadowRadius) {
      sc.left = -shadowRadius;
      sc.right = shadowRadius;
      sc.top = shadowRadius;
      sc.bottom = -shadowRadius;
      sc.near = 10;
      sc.far = 1200;
      sc.updateProjectionMatrix();
    }

    // --- Ambient (hemisphere) — brighter & greyer when overcast, flashes with lightning
    const skyDay = new THREE.Color(0.62, 0.72, 0.9).lerp(new THREE.Color(0.55, 0.58, 0.62), w.cloud);
    const skyNight = new THREE.Color(0.08, 0.1, 0.16);
    this.hemi.color.copy(skyNight).lerp(skyDay, day).lerp(new THREE.Color(0.9, 0.7, 0.55), golden * day * 0.35 * (1 - w.cloud));
    this.hemi.groundColor.set(0x2e2a20).multiplyScalar(0.4 + day * 0.6);
    this.hemi.intensity = (0.35 + day * (0.75 + w.cloud * 0.5) * (1 - w.darkness * 0.45)) + weather.flash * 5;

    // --- Fog colour follows the sky near the horizon
    const fogDay = new THREE.Color(0.63, 0.69, 0.74).lerp(new THREE.Color(0.52, 0.54, 0.56), w.cloud).lerp(new THREE.Color(0.8, 0.6, 0.45), golden * day * (1 - w.cloud) * 0.7);
    const fogNight = new THREE.Color(0.04, 0.05, 0.07);
    this.fog.color.copy(fogNight).lerp(fogDay, day * (1 - w.darkness * 0.45));
    this.fog.color.lerp(new THREE.Color(0.85, 0.88, 0.95), weather.flash * 0.6);
    this.fog.density = fogBase * w.fog;

    // --- Clouds
    const cu = this.cloudUniforms;
    cu.uCoverage!.value = w.cloud;
    cu.uDark!.value = w.darkness;
    cu.uFlash!.value = weather.flash;
    (cu.uSunDir!.value as THREE.Vector3).copy(this.sunDir);
    (cu.uSunColor!.value as THREE.Color).copy(sunColor).multiplyScalar(day * 1.4);
    (cu.uAmbient!.value as THREE.Color).copy(this.hemi.color).multiplyScalar(0.6 + day * 0.4);
    (cu.uHaze!.value as THREE.Color).copy(this.fog.color);
    this.clouds.position.copy(camera.position);
    this.sky.position.copy(camera.position);

    // --- Image-based lighting from the sky (re-baked only when it changes noticeably)
    this.envCooldown -= dt;
    const key = `${hours.toFixed(1)}|${w.cloud.toFixed(2)}|${w.darkness.toFixed(2)}`;
    if (key !== this.envKey && this.envCooldown <= 0) {
      this.envKey = key;
      this.envCooldown = 0.75;
      const rt = this.pmrem.fromScene(this.envScene, 0, 1, 5000);
      this.envTarget?.dispose();
      this.envTarget = rt;
      this.scene.environment = rt.texture;
    }
    this.scene.environmentIntensity = (0.25 + 0.55 * day) * (1 - w.darkness * 0.6);
  }
}
