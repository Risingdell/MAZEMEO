/**
 * Cinematic post-processing for ground level:
 *
 *   scene ─► Atmosphere (height mist + sun in-scattering + god rays, from depth)
 *         ─► hands overlay ─► bloom ─► tone map (OutputPass) ─► colour grade/vignette/grain
 *
 * The atmosphere pass replaces scene fog on the ground: mist pools in low
 * ground and thins with height, glows warm towards the sun and cool-blue away
 * from it (aerial perspective), and light shafts stream from bright sky gaps
 * between the trees towards the camera.
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { FullScreenQuad, Pass } from 'three/addons/postprocessing/Pass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';

export interface AtmosphereParams {
  sunDir: THREE.Vector3;
  sunColor: THREE.Color;
  /** 0..1 how strong direct sun is (cloud/weather/time). */
  sunStrength: number;
  /** Mist colour away from the sun (cool). */
  mistColor: THREE.Color;
  /** Mist colour towards the sun (warm). */
  glowColor: THREE.Color;
  /** Mist density at the base height (per metre). */
  density: number;
  /** World height where mist is densest (usually the ground under the player). */
  baseHeight: number;
  /** Light-shaft strength multiplier. */
  rays: number;
}

const QUAD_VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

/** Bright-pass of the sky near the sun (where shafts originate). */
const MASK_FRAG = /* glsl */ `
uniform sampler2D tColor;
uniform sampler2D tDepth;
uniform vec2 uSun;
uniform float uAspect;
varying vec2 vUv;
void main() {
  float depth = texture2D(tDepth, vUv).r;
  vec3 c = texture2D(tColor, vUv).rgb;
  float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
  float sky = step(0.9999, depth);
  vec2 d = (vUv - uSun) * vec2(uAspect, 1.0);
  float near = exp(-dot(d, d) * 2.2);
  float m = sky * smoothstep(0.35, 1.2, lum) * near;
  gl_FragColor = vec4(c * m, 1.0);
}`;

/** Radial blur towards the sun (volumetric light scattering approximation). */
const RAYS_FRAG = /* glsl */ `
uniform sampler2D tMask;
uniform vec2 uSun;
varying vec2 vUv;
const int N = 56;
void main() {
  vec2 delta = (vUv - uSun) / float(N) * 0.92;
  vec2 uv = vUv;
  float decay = 1.0;
  vec3 acc = vec3(0.0);
  for (int i = 0; i < N; i++) {
    uv -= delta;
    acc += texture2D(tMask, uv).rgb * decay;
    decay *= 0.955;
  }
  gl_FragColor = vec4(acc / float(N) * 2.6, 1.0);
}`;

const COMPOSE_FRAG = /* glsl */ `
uniform sampler2D tColor;
uniform sampler2D tDepth;
uniform sampler2D tRays;
uniform mat4 uInvProj;
uniform mat4 uCamWorld;
uniform vec3 uCamPos;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uSunStrength;
uniform vec3 uMist;
uniform vec3 uGlow;
uniform float uDensity;
uniform float uBase;
uniform float uFalloff;
uniform float uRays;
varying vec2 vUv;
void main() {
  vec3 scene = texture2D(tColor, vUv).rgb;
  float depth = texture2D(tDepth, vUv).r;
  vec4 ndc = vec4(vUv * 2.0 - 1.0, min(depth, 0.99999) * 2.0 - 1.0, 1.0);
  vec4 view = uInvProj * ndc;
  view /= view.w;
  vec3 world = (uCamWorld * vec4(view.xyz, 1.0)).xyz;
  vec3 ray = world - uCamPos;
  float dist = depth >= 0.9999 ? 2500.0 : length(ray);
  vec3 rd = normalize(ray);

  // Exponential height fog integrated along the view ray.
  float a = uDensity * exp(-uFalloff * (uCamPos.y - uBase));
  float k = uFalloff * rd.y;
  float fogAmt = abs(k * dist) < 1e-3 ? a * dist : a * (1.0 - exp(-k * dist)) / k;
  float f = 1.0 - exp(-max(fogAmt, 0.0));
  if (depth >= 0.9999) f *= 0.55; // keep some sky visible through the mist

  float toSun = max(dot(rd, uSunDir), 0.0);
  float glow = pow(toSun, 9.0) * 0.6 + pow(toSun, 48.0) * 0.5;
  vec3 mist = mix(uMist, uGlow, clamp(glow * uSunStrength, 0.0, 1.0));
  vec3 col = mix(scene, mist, clamp(f, 0.0, 0.97));
  // Light shafts, tinted by the sun, also lighting up the mist itself.
  vec3 rays = texture2D(tRays, vUv).rgb;
  col += rays * uSunColor * uRays * uSunStrength * (0.6 + f);
  gl_FragColor = vec4(col, 1.0);
}`;

class AtmospherePass extends Pass {
  params: AtmosphereParams | null = null;
  camera: THREE.PerspectiveCamera;
  private readonly maskRT: THREE.WebGLRenderTarget;
  private readonly raysRT: THREE.WebGLRenderTarget;
  private readonly maskQuad: FullScreenQuad;
  private readonly raysQuad: FullScreenQuad;
  private readonly composeQuad: FullScreenQuad;
  private readonly maskMat: THREE.ShaderMaterial;
  private readonly raysMat: THREE.ShaderMaterial;
  private readonly composeMat: THREE.ShaderMaterial;
  private readonly sunNdc = new THREE.Vector3();

  constructor(camera: THREE.PerspectiveCamera) {
    super();
    this.camera = camera;
    const opts = { type: THREE.HalfFloatType, depthBuffer: false };
    this.maskRT = new THREE.WebGLRenderTarget(1, 1, opts);
    this.raysRT = new THREE.WebGLRenderTarget(1, 1, opts);
    const mk = (frag: string, uniforms: Record<string, THREE.IUniform>): THREE.ShaderMaterial =>
      new THREE.ShaderMaterial({ uniforms, vertexShader: QUAD_VERT, fragmentShader: frag, depthTest: false, depthWrite: false });
    this.maskMat = mk(MASK_FRAG, { tColor: { value: null }, tDepth: { value: null }, uSun: { value: new THREE.Vector2() }, uAspect: { value: 1 } });
    this.raysMat = mk(RAYS_FRAG, { tMask: { value: this.maskRT.texture }, uSun: { value: new THREE.Vector2() } });
    this.composeMat = mk(COMPOSE_FRAG, {
      tColor: { value: null },
      tDepth: { value: null },
      tRays: { value: this.raysRT.texture },
      uInvProj: { value: new THREE.Matrix4() },
      uCamWorld: { value: new THREE.Matrix4() },
      uCamPos: { value: new THREE.Vector3() },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uSunColor: { value: new THREE.Color() },
      uSunStrength: { value: 1 },
      uMist: { value: new THREE.Color() },
      uGlow: { value: new THREE.Color() },
      uDensity: { value: 0.01 },
      uBase: { value: 0 },
      uFalloff: { value: 0.06 },
      uRays: { value: 1 },
    });
    this.maskQuad = new FullScreenQuad(this.maskMat);
    this.raysQuad = new FullScreenQuad(this.raysMat);
    this.composeQuad = new FullScreenQuad(this.composeMat);
  }

  override setSize(width: number, height: number): void {
    this.maskRT.setSize(Math.max(1, width >> 1), Math.max(1, height >> 1));
    this.raysRT.setSize(Math.max(1, width >> 1), Math.max(1, height >> 1));
    this.maskMat.uniforms.uAspect!.value = width / Math.max(1, height);
  }

  override render(renderer: THREE.WebGLRenderer, writeBuffer: THREE.WebGLRenderTarget, readBuffer: THREE.WebGLRenderTarget): void {
    const p = this.params;
    if (!p) return;
    const cam = this.camera;
    // Sun position on screen; shafts fade out when the sun is behind us or far off-screen.
    this.sunNdc.copy(p.sunDir).multiplyScalar(1000).add(cam.position).project(cam);
    const facing = p.sunDir.dot(cam.getWorldDirection(new THREE.Vector3()));
    const sunUv = new THREE.Vector2(this.sunNdc.x * 0.5 + 0.5, this.sunNdc.y * 0.5 + 0.5);
    const onScreen = THREE.MathUtils.smoothstep(facing, 0.0, 0.35) * (1 - THREE.MathUtils.smoothstep(Math.max(Math.abs(this.sunNdc.x), Math.abs(this.sunNdc.y)), 1.2, 2.2));
    const rays = p.rays * onScreen;

    if (rays > 0.01) {
      this.maskMat.uniforms.tColor!.value = readBuffer.texture;
      this.maskMat.uniforms.tDepth!.value = readBuffer.depthTexture;
      (this.maskMat.uniforms.uSun!.value as THREE.Vector2).copy(sunUv);
      renderer.setRenderTarget(this.maskRT);
      this.maskQuad.render(renderer);
      (this.raysMat.uniforms.uSun!.value as THREE.Vector2).copy(sunUv);
      renderer.setRenderTarget(this.raysRT);
      this.raysQuad.render(renderer);
    }

    const u = this.composeMat.uniforms;
    u.tColor!.value = readBuffer.texture;
    u.tDepth!.value = readBuffer.depthTexture;
    (u.uInvProj!.value as THREE.Matrix4).copy(cam.projectionMatrixInverse);
    (u.uCamWorld!.value as THREE.Matrix4).copy(cam.matrixWorld);
    (u.uCamPos!.value as THREE.Vector3).copy(cam.position);
    (u.uSunDir!.value as THREE.Vector3).copy(p.sunDir);
    (u.uSunColor!.value as THREE.Color).copy(p.sunColor);
    u.uSunStrength!.value = p.sunStrength;
    (u.uMist!.value as THREE.Color).copy(p.mistColor);
    (u.uGlow!.value as THREE.Color).copy(p.glowColor);
    u.uDensity!.value = p.density;
    u.uBase!.value = p.baseHeight;
    u.uRays!.value = rays;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.composeQuad.render(renderer);
  }

  override dispose(): void {
    this.maskRT.dispose();
    this.raysRT.dispose();
    this.maskMat.dispose();
    this.raysMat.dispose();
    this.composeMat.dispose();
  }
}

const GRADE = {
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uResolution: { value: new THREE.Vector2(1, 1) },
    uWarm: { value: new THREE.Color(1.06, 1.0, 0.9) },
    uCool: { value: new THREE.Color(0.9, 0.98, 1.06) },
    uSplit: { value: 0.6 },
    uContrast: { value: 1.06 },
    uSaturation: { value: 1.08 },
    uVignette: { value: 0.32 },
    uGrain: { value: 0.025 },
  },
  vertexShader: QUAD_VERT,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uTime;
    uniform vec2 uResolution;
    uniform vec3 uWarm;
    uniform vec3 uCool;
    uniform float uSplit;
    uniform float uContrast;
    uniform float uSaturation;
    uniform float uVignette;
    uniform float uGrain;
    varying vec2 vUv;
    float h(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    void main() {
      vec3 c = texture2D(tDiffuse, vUv).rgb; // display-referred (after tone mapping)
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      // Split toning: cool shadows, warm highlights.
      c *= mix(vec3(1.0), uCool, (1.0 - smoothstep(0.05, 0.5, l)) * uSplit);
      c *= mix(vec3(1.0), uWarm, smoothstep(0.4, 0.95, l) * uSplit);
      c = (c - 0.5) * uContrast + 0.5;
      c = mix(vec3(dot(c, vec3(0.2126, 0.7152, 0.0722))), c, uSaturation);
      float v = smoothstep(0.95, 0.3, length((vUv - 0.5) * vec2(1.1, 1.0)));
      c *= mix(1.0 - uVignette, 1.0, v);
      c += (h(vUv * uResolution + fract(uTime) * 91.7) - 0.5) * uGrain;
      gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
    }`,
};

export class PostFX {
  readonly composer: EffectComposer;
  private readonly atmosphere: AtmospherePass;
  private readonly bloom: UnrealBloomPass;
  private readonly grade: ShaderPass;
  private readonly handsPass: RenderPass;
  private readonly scenePass: RenderPass;

  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera, handsScene: THREE.Scene, handsCamera: THREE.Camera) {
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    const rt = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType });
    rt.depthTexture = new THREE.DepthTexture(size.x, size.y);
    rt.depthTexture.type = THREE.UnsignedIntType;
    this.composer = new EffectComposer(renderer, rt);
    this.scenePass = new RenderPass(scene, camera);
    this.atmosphere = new AtmospherePass(camera);
    this.handsPass = new RenderPass(handsScene, handsCamera);
    this.handsPass.clear = false;
    this.handsPass.clearDepth = true;
    this.bloom = new UnrealBloomPass(new THREE.Vector2(size.x / 2, size.y / 2), 0.32, 0.55, 0.92);
    this.grade = new ShaderPass(GRADE);
    this.composer.addPass(this.scenePass);
    this.composer.addPass(this.atmosphere);
    this.composer.addPass(this.handsPass);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    this.composer.addPass(this.grade);
  }

  setSize(w: number, h: number): void {
    this.composer.setSize(w, h);
    (this.grade.uniforms.uResolution!.value as THREE.Vector2).set(w, h);
  }

  render(params: AtmosphereParams, showHands: boolean, time: number): void {
    this.atmosphere.params = params;
    this.handsPass.enabled = showHands;
    this.grade.uniforms.uTime!.value = time;
    this.composer.render();
  }

  dispose(): void {
    this.composer.dispose();
  }
}
