import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';
import { DEFAULT_CONFIG, buildField, edgeCost, generateMaze, heightAt, shortestPath, type Maze, type WalkField } from '@mazemeo/maze-core';
import { AudioEngine } from './audio.ts';
import { GOLDEN_HOUR, atmosphereFor, effectLight, motesAmount, sunsetAzimuthOffset } from './env/ambience.ts';
import { Ferns } from './env/ferns.ts';
import type { Quality } from './env/foliage.ts';
import { Grass } from './env/grass.ts';
import { Leaves } from './env/leaves.ts';
import { Motes } from './env/motes.ts';
import { PostFX } from './env/post.ts';
import { Rain } from './env/rain.ts';
import { env } from './env/shared.ts';
import { SkySystem } from './env/sky.ts';
import { getEnvTextures } from './env/textures.ts';
import { WEATHER_KINDS, Weather, type WeatherKind } from './env/weather.ts';
import { Hud } from './hud.ts';
import { LocalMultiplayer, type NetworkPlayer, type NetworkRoom } from './multiplayer.ts';
import { Character } from './player/character.ts';
import { PlayerController } from './player/controller.ts';
import { Hands } from './player/hands.ts';
import { Physics, initPhysics } from './player/physics.ts';
import { Ui, type EnvState } from './ui.ts';
import { buildWorld, type World } from './world.ts';

// --- URL options --------------------------------------------------------------

const params = new URLSearchParams(window.location.search);
const envState: EnvState = {
  hours: clampNum(Number(params.get('time') ?? GOLDEN_HOUR), 5, 19),
  weather: (WEATHER_KINDS as string[]).includes(params.get('weather') ?? '') ? (params.get('weather') as WeatherKind) : 'clear',
  auto: params.get('auto') === '1',
  wind: 1,
  volume: 0.7,
  quality: params.get('quality') === 'low' ? 'low' : 'high',
  cinematic: params.get('cinematic') !== '0' && params.get('quality') !== 'low',
};

// --- Renderer / scene -----------------------------------------------------------

const canvas = document.getElementById('scene') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.62;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 2600);
camera.rotation.order = 'YXZ';

const loading = document.createElement('div');
loading.id = 'loading';
loading.textContent = 'Growing the forest…';
document.body.appendChild(loading);

const tex = getEnvTextures();
const sky = new SkySystem(scene, renderer);
const weather = new Weather();
weather.set(envState.weather);
weather.auto = envState.auto;
weather.snap();
const rain = new Rain();
const leaves = new Leaves(tex);
const grass = new Grass(envState.quality);
const ferns = new Ferns(tex, envState.quality);
const motes = new Motes();
const hands = new Hands(tex);
const character = new Character(tex);
character.root.visible = false;
scene.add(character.root);
const hud = new Hud();
const audio = new AudioEngine();
scene.add(rain.object, leaves.mesh, grass.mesh, ferns.mesh, motes.points);
const post = new PostFX(renderer, scene, camera, hands.scene, hands.camera);
post.setSize(window.innerWidth, window.innerHeight);
await initPhysics();

// --- Controls -------------------------------------------------------------------

const orbit = new OrbitControls(camera, canvas);
orbit.enableDamping = true;
orbit.dampingFactor = 0.08;
orbit.maxPolarAngle = Math.PI * 0.47;
orbit.minDistance = 15;
orbit.maxDistance = 900;

/** Mouse-look orientation (yaw/pitch). The camera copies it in first person and orbits with it in third. */
const view = new THREE.PerspectiveCamera(); // never rendered: just holds the look orientation
view.rotation.order = 'YXZ';
const look = new PointerLockControls(view, document.body);
type CameraMode = 'first' | 'third';
let cameraMode: CameraMode = params.get('view') === 'first' ? 'first' : 'third';
let tools = 0;
const walkHint = document.getElementById('walk-hint') as HTMLElement;
const crosshair = document.getElementById('crosshair') as HTMLElement;
const keys = new Set<string>();

type Mode = 'overview' | 'walk';
let mode: Mode = 'overview';

window.addEventListener('keydown', (e) => {
  keys.add(e.code);
  if (mode === 'walk' && e.code === 'KeyV') setCameraMode(cameraMode === 'first' ? 'third' : 'first');
  if (mode === 'walk' && look.isLocked) {
    if (e.code === 'Space') {
      player?.jump();
      e.preventDefault();
    }
  }
});
window.addEventListener('keyup', (e) => keys.delete(e.code));
window.addEventListener('blur', () => keys.clear());
look.addEventListener('lock', () => {
  walkHint.hidden = false;
  crosshair.hidden = false;
  document.body.classList.add('playing');
});
look.addEventListener('unlock', () => {
  walkHint.hidden = true;
  crosshair.hidden = true;
  document.body.classList.remove('playing');
  keys.clear();
});
canvas.addEventListener('mousedown', (e) => {
  audio.start();
  if (mode !== 'walk') return;
  if (!look.isLocked) {
    look.lock();
    return;
  }
  if (e.button === 0) throwStone();
});

// --- State ----------------------------------------------------------------------

let maze: Maze;
let field: WalkField;
let world: World | null = null;
let physics: Physics | null = null;
let player: PlayerController | null = null;
const layers = { forest: true, overlay: true, labels: true, fog: true };
let localPlayerId: string | null = null;
let roomStarted = false;
let poseSendTimer = 0;
interface RemoteAvatar {
  character: Character;
  target: THREE.Vector3;
  yaw: number;
  speed: number;
  crouch: number;
  sprinting: boolean;
  grounded: boolean;
  moveDir: THREE.Vector2;
  phase: number;
}
const remoteAvatars = new Map<string, RemoteAvatar>();

const ui = new Ui(
  document.getElementById('ui') as HTMLElement,
  {
    onGenerate: (seed) => regenerate(seed),
    onToggle: (layer, on) => {
      layers[layer] = on;
      applyLayers();
    },
    onOverview: () => overview(),
    onWalk: (i) => {
      audio.start();
      startWalk(i, true);
    },
    onTime: (h) => (envState.hours = h),
    onWeather: (k) => {
      envState.weather = k;
      weather.set(k);
    },
    onAutoWeather: (on) => (weather.auto = on),
    onWind: (s) => (weather.windScale = s),
    onVolume: (v) => audio.setVolume(v),
    onCinematic: (on) => (envState.cinematic = on),
    onQuality: (q) => {
      envState.quality = q;
      applyQuality();
      regenerate(maze.seed);
    },
  },
  envState,
);

function applyQuality(): void {
  const high = envState.quality === 'high';
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, high ? 2 : 1));
  sky.setShadowQuality(high ? 4096 : 2048);
  grass.setQuality(envState.quality);
  ferns.setQuality(envState.quality);
  post.setSize(window.innerWidth, window.innerHeight);
}
applyQuality();

function regenerate(seed: number): void {
  const t0 = performance.now();
  maze = generateMaze(seed);
  const t1 = performance.now();
  field = buildField(maze);
  const t2 = performance.now();
  if (world) {
    scene.remove(world.root);
    world.dispose();
  }
  player?.dispose();
  player = null;
  if (physics) {
    scene.remove(physics.group);
    physics.dispose();
  }
  world = buildWorld(maze, field, tex, envState.quality as Quality);
  scene.add(world.root);
  physics = new Physics(maze, field, world.trunks, world.rocks);
  physics.onImpact = (pos, strength, kind) => audio.impact(pos.distanceTo(camera.position), strength, kind);
  scene.add(physics.group);
  rain.setField(field);
  sky.azimuthOffset = sunsetAzimuthOffset(maze);
  grass.setField(field, world.cascade?.footprint);
  ferns.setField(field, world.cascade?.footprint);
  audio.setWater(world.cascade?.soundAt ?? null);
  hud.setMaze(maze);
  tools = 0;
  const t3 = performance.now();
  ui.show(maze, { generateMs: t1 - t0, fieldMs: t2 - t1, buildMs: t3 - t2, instances: world.instanceCount });
  const url = new URL(window.location.href);
  url.searchParams.set('seed', String(seed));
  window.history.replaceState(null, '', url);
  if (mode === 'walk') startWalk(0, look.isLocked);
  else overview();
  applyLayers();
}

function applyLayers(): void {
  if (!world) return;
  const ground = mode === 'walk';
  world.forest.visible = layers.forest;
  world.overlay.visible = layers.overlay && !ground;
  world.labels.visible = layers.labels && !ground;
  world.markers.visible = !ground;
  scene.fog = layers.fog ? sky.fog : null;
}

function overview(): void {
  mode = 'overview';
  if (look.isLocked) look.unlock();
  player?.dispose();
  player = null;
  hands.visible = false;
  character.root.visible = false;
  hud.setVisible(false);
  orbit.enabled = true;
  camera.fov = 50;
  camera.updateProjectionMatrix();
  camera.position.set(300, 250, 330);
  orbit.target.set(0, 25, 0);
  orbit.update();
  applyLayers();
}

/** Spawn the player at a spawn point, facing down the first trail of its route. */
function startWalk(spawnIndex: number, lock: boolean): void {
  const n = maze.nodes[maze.spawns[spawnIndex] ?? -1];
  if (!n || !physics) return;
  mode = 'walk';
  orbit.enabled = false;
  player?.dispose();
  player = new PlayerController(physics.world, maze, field, new THREE.Vector3(n.x, heightAt(field, n.x, n.z), n.z));
  player.events = {
    onStep: (s, loud, wet) => audio.footstep(s, loud, wet),
    onLand: (impact, s) => audio.land(impact, s),
  };
  const route = shortestPath(maze, n.id, maze.exit, (e) => edgeCost(e, DEFAULT_CONFIG));
  const next = maze.nodes[route[1] ?? maze.exit]!;
  const yaw = Math.atan2(-(next.x - n.x), -(next.z - n.z));
  view.rotation.set(0, yaw, 0);
  character.face(yaw);
  camDist = THIRD_OFFSET.length();
  setCameraMode(cameraMode);
  hud.setVisible(true);
  applyLayers();
  if (lock) look.lock();
}

// --- Throwing ---------------------------------------------------------------------

const fwd = new THREE.Vector3();
const right = new THREE.Vector3();
let thirdThrowBusy = false;
function throwStone(): void {
  if (!player || !physics) return;
  const release = (origin: THREE.Vector3): void => {
    view.getWorldDirection(fwd); // cameras report their -Z view direction
    const vel = fwd.clone().multiplyScalar(18).add(new THREE.Vector3(0, 2.2, 0)).add(player!.velocity);
    physics!.throwStone(origin, vel);
    audio.whoosh();
  };
  if (cameraMode === 'first') {
    hands.throw(() => {
      view.getWorldDirection(fwd);
      right.crossVectors(fwd, camera.up).normalize();
      release(camera.position.clone().addScaledVector(fwd, 0.5).addScaledVector(right, 0.22).add(new THREE.Vector3(0, -0.05, 0)));
    });
  } else if (!thirdThrowBusy) {
    thirdThrowBusy = true;
    character.throw();
    window.setTimeout(() => {
      view.getWorldDirection(fwd);
      right.crossVectors(fwd, camera.up).normalize();
      if (player) release(player.position.clone().add(new THREE.Vector3(0, 0.75, 0)).addScaledVector(right, 0.3).addScaledVector(fwd, 0.4));
      thirdThrowBusy = false;
    }, 270);
  }
}

// --- Camera modes -------------------------------------------------------------------

/** Over-the-shoulder offset in view space: right, up, back (the player sits on the left third). */
const THIRD_OFFSET = new THREE.Vector3(1.0, 0.22, 3.1);
let camDist = THIRD_OFFSET.length();
const camRay = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });
const camDir = new THREE.Vector3();
const camHead = new THREE.Vector3();

function setCameraMode(m: CameraMode): void {
  cameraMode = m;
  const third = m === 'third' && mode === 'walk';
  character.root.visible = third;
  hands.visible = mode === 'walk' && m === 'first';
  hud.setHint(third ? '<kbd>V</kbd> – first person' : '<kbd>V</kbd> – third person');
}

/** Shoulder camera that pulls in when trees, banks or rocks get between it and the player. */
function updateThirdPersonCamera(dt: number): void {
  if (!player || !physics) return;
  camHead.copy(player.position).add(new THREE.Vector3(0, 0.72 - player.crouch * 0.45, 0));
  camDir.copy(THIRD_OFFSET).applyQuaternion(view.quaternion);
  const want = camDir.length();
  camDir.normalize();
  camRay.origin = { x: camHead.x, y: camHead.y, z: camHead.z };
  camRay.dir = { x: camDir.x, y: camDir.y, z: camDir.z };
  const hit = physics.world.castRay(camRay, want + 0.3, true, undefined, undefined, player.colliderHandle);
  const allowed = hit ? Math.max(0.6, hit.timeOfImpact - 0.3) : want;
  // Snap in quickly when blocked, ease back out.
  camDist += (allowed - camDist) * Math.min(1, dt * (allowed < camDist ? 25 : 4));
  camera.position.copy(camHead).addScaledVector(camDir, camDist);
  const ground = heightAt(field, camera.position.x, camera.position.z) + 0.35;
  if (camera.position.y < ground) camera.position.y = ground;
  camera.quaternion.copy(view.quaternion);
}

/** Pick up tool caches you walk over. */
function collectCaches(): void {
  if (!player || !world) return;
  const p = player.position;
  for (const n of maze.nodes) {
    if (!n.cache || Math.hypot(n.x - p.x, n.z - p.z) > 1.8 || Math.abs(n.y - p.y) > 2.5) continue;
    if (world.collectCache(n.id)) {
      tools++;
      audio.pickup();
    }
  }
}

function syncRemotePlayers(players: NetworkPlayer[]): void {
  if (!roomStarted) {
    for (const remote of remoteAvatars.values()) remote.character.root.visible = false;
    return;
  }
  const visibleIds = new Set<string>();
  for (const p of players) {
    if (p.id === localPlayerId) continue;
    visibleIds.add(p.id);
    let remote = remoteAvatars.get(p.id);
    if (!remote) {
      const avatar = new Character(tex);
      scene.add(avatar.root);
      remote = {
        character: avatar,
        target: new THREE.Vector3(),
        yaw: 0,
        speed: 0,
        crouch: 0,
        sprinting: false,
        grounded: true,
        moveDir: new THREE.Vector2(),
        phase: 0,
      };
      remoteAvatars.set(p.id, remote);
    }
    remote.character.root.visible = p.connected;
    remote.target.set(p.position.x, p.position.y - 1.1, p.position.z);
    remote.yaw = p.yaw;
    remote.speed = p.speed;
    remote.crouch = p.crouch;
    remote.sprinting = p.sprinting;
    remote.grounded = p.grounded;
    remote.moveDir.set(p.moveDir.x, p.moveDir.z);
  }
  for (const [id, remote] of remoteAvatars) {
    if (visibleIds.has(id)) continue;
    remote.character.root.visible = false;
  }
}

function clearRemotePlayers(): void {
  for (const remote of remoteAvatars.values()) {
    scene.remove(remote.character.root);
    remote.character.root.traverse((object) => {
      const mesh = object as THREE.Mesh;
      mesh.geometry?.dispose();
      const material = mesh.material;
      if (Array.isArray(material)) material.forEach((item) => item.dispose());
      else material?.dispose();
    });
  }
  remoteAvatars.clear();
}

const multiplayer = new LocalMultiplayer({
  onRoom: (room: NetworkRoom) => {
    localPlayerId = room.you.id;
    roomStarted = room.started;
    syncRemotePlayers(room.players);
  },
  onSnapshot: (players: NetworkPlayer[]) => syncRemotePlayers(players),
  onStart: (room: NetworkRoom) => {
    roomStarted = true;
    regenerate(room.seed);
    startWalk(room.you.spawnIndex, false);
    syncRemotePlayers(room.players);
  },
  onEnd: (winnerId: string | null) => {
    roomStarted = false;
    if (winnerId === null) {
      localPlayerId = null;
      clearRemotePlayers();
    } else {
      syncRemotePlayers([]);
    }
  },
});

weather.onLightning = (s) => window.setTimeout(() => audio.thunder(s.power), s.thunderDelay * 1000);

// --- Loop -------------------------------------------------------------------------

const clock = new THREE.Clock();
const prevLook = new THREE.Vector2();
const lookDelta = new THREE.Vector2();
const focus = new THREE.Vector3();
const moveDir = new THREE.Vector2();
const fxLight = new THREE.Color();
let lastWeather = weather.kind;

function frame(): void {
  const dt = Math.min(clock.getDelta(), 0.05);
  env.uTime.value += dt;
  weather.update(dt);
  if (weather.kind !== lastWeather) {
    lastWeather = weather.kind;
    ui.setWeather(weather.kind);
  }

  const walking = mode === 'walk' && player !== null;
  const active = walking && look.isLocked;
  const input = {
    x: active ? (keys.has('KeyD') ? 1 : 0) - (keys.has('KeyA') ? 1 : 0) : 0,
    z: active ? (keys.has('KeyW') ? 1 : 0) - (keys.has('KeyS') ? 1 : 0) : 0,
    sprint: active && (keys.has('ShiftLeft') || keys.has('ShiftRight')),
    crouch: active && (keys.has('KeyC') || keys.has('ControlLeft')),
  };
  physics?.step(dt, (h) => player?.step(h, input, view.rotation.y));

  if (walking && player) {
    if (cameraMode === 'first') {
      player.eye(dt, camera.position);
      camera.quaternion.copy(view.quaternion);
    } else {
      updateThirdPersonCamera(dt);
      character.update(dt, player.position.clone().add(new THREE.Vector3(0, -0.87, 0)), {
        speed: player.speed,
        stepPhase: player.stepPhase,
        sprinting: player.sprinting,
        grounded: player.grounded,
        crouch: player.crouch,
        moveDir: player.moveDir(moveDir),
      });
    }
    collectCaches();
    if (roomStarted) {
      poseSendTimer += dt;
      if (poseSendTimer >= 0.1) {
        poseSendTimer %= 0.1;
        const p = player.position;
        multiplayer.sendPose({
          x: p.x,
          y: p.y,
          z: p.z,
          yaw: view.rotation.y,
          speed: player.speed,
          crouch: player.crouch,
          sprinting: player.sprinting,
          grounded: player.grounded,
        });
      }
    }
    hud.update(dt, player.position, view.rotation.y, player.stamina, player.noise, tools);
    const targetFov = (cameraMode === 'first' ? 72 : 60) + (player.sprinting ? 7 : 0);
    if (Math.abs(camera.fov - targetFov) > 0.05) {
      camera.fov += (targetFov - camera.fov) * Math.min(1, dt * 6);
      camera.updateProjectionMatrix();
    }
    focus.copy(player.position);
  } else {
    if (orbit.enabled) orbit.update();
    focus.set(0, 20, 0);
  }

  if (roomStarted) {
    for (const remote of remoteAvatars.values()) {
      if (!remote.character.root.visible) continue;
      remote.character.root.position.lerp(remote.target, Math.min(1, dt * 12));
      remote.character.face(remote.yaw);
      remote.phase += remote.speed * dt * 3.5;
      remote.character.update(dt, remote.character.root.position, {
        speed: remote.speed,
        stepPhase: remote.phase,
        sprinting: remote.sprinting,
        grounded: remote.grounded,
        crouch: remote.crouch,
        moveDir: remote.speed > 0.25 ? remote.moveDir : null,
      });
    }
  }

  sky.update(dt, weather, envState.hours, focus, camera, walking ? 75 : 300, walking ? 0.0042 : 0.00085);
  const rainLight = sky.hemi.color.clone().multiplyScalar(0.5 + sky.daylight * 0.6).lerp(new THREE.Color(1, 1, 1), weather.flash);
  rain.update(dt, camera, weather.current.rain, rainLight, walking);
  leaves.update(dt, camera, player?.biome ?? 'maple', walking);
  grass.update(camera, player?.position ?? null, walking);
  ferns.update(camera, player?.position ?? null, walking);
  motes.update(camera, sky.sunDir, sky.sun.color, motesAmount(sky, weather), walking);
  world?.update(env.uTime.value);
  world?.cascade?.update(effectLight(sky, fxLight));
  camera.getWorldDirection(fwd);
  audio.listen(camera.position, fwd);

  audio.update(dt, {
    wind: env.uWindStrength.value,
    gust: 0.5 + 0.5 * Math.sin(env.uTime.value * 0.37) * Math.sin(env.uTime.value * 0.13 + 1),
    rain: weather.current.rain * (walking ? 1 : 0.5),
    birds: weather.current.birds,
    daylight: sky.daylight,
    indoorsOfCanopy: walking ? 1 : 0.4,
  });

  const cinematic = walking && envState.cinematic;
  // The atmosphere pass replaces scene fog when cinematic rendering is on.
  scene.fog = cinematic || !layers.fog ? null : sky.fog;
  if (!cinematic) renderer.render(scene, camera);

  if (walking && player) {
    lookDelta.set(view.rotation.y - prevLook.x, view.rotation.x - prevLook.y);
    if (Math.abs(lookDelta.x) > Math.PI) lookDelta.x = 0;
    prevLook.set(view.rotation.y, view.rotation.x);
    camera.updateMatrixWorld();
    if (hands.visible) hands.update(dt, player.speed, player.stepPhase, player.sprinting, player.grounded, player.crouch, lookDelta, {
      sunDir: sky.sunDir,
      sunColor: sky.sun.color,
      sunIntensity: sky.sun.intensity,
      hemiSky: sky.hemi.color,
      hemiGround: sky.hemi.groundColor,
      hemiIntensity: sky.hemi.intensity,
      env: scene.environment,
      envIntensity: scene.environmentIntensity,
      viewMatrix: camera.matrixWorldInverse,
    });
    if (!cinematic && hands.visible) hands.render(renderer);
  }
  if (cinematic && player) post.render(atmosphereFor(dt, sky, weather, player.biome, player.position.y - 0.9), hands.visible, env.uTime.value);
  requestAnimationFrame(frame);
}

window.addEventListener('beforeunload', () => multiplayer.dispose());

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  hands.resize(camera.aspect);
  renderer.setSize(window.innerWidth, window.innerHeight);
  post.setSize(window.innerWidth, window.innerHeight);
});
hands.resize(camera.aspect);

function clampNum(v: number, lo: number, hi: number): number {
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo;
}

const initialSeed = Number(params.get('seed') ?? 42);
regenerate(Number.isFinite(initialSeed) ? initialSeed : 42);
// ?cam=p3 drops you at spawn 3 on the ground (no mouse lock) — handy for screenshots.
const camParam = /^p([1-8])$/i.exec(params.get('cam') ?? '');
if (camParam) startWalk(Number(camParam[1]) - 1, false);
// ?turn=3.14 rotates that starting view (radians), e.g. to face the mountains.
if (camParam && params.get('turn')) {
  view.rotation.y += Number(params.get('turn'));
  character.face(view.rotation.y + Number(params.get('face') ?? 0)); // ?face= turns just the explorer (screenshots)
}
// ?ui=0 hides the side panel (clean screenshots).
if (params.get('ui') === '0') (document.getElementById('ui') as HTMLElement).hidden = true;
loading.remove();
frame();
