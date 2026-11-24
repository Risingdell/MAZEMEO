/**
 * Asset Lab: cheap scenes for reviewing environment assets up close without
 * the cost of the whole game (fast, low memory, screenshot-friendly).
 *
 *   lab.html?spawn=1..8            a real spawn area (seed 42; scene=p6 = spawn 6): forest within
 *                                  ~120 m, waterfall, ferns, grass, cinematic post
 *     &look=cascade                face the waterfall instead of down the trail
 *     &yaw=0.4&pitch=0.1           extra camera turn (radians, added to the view)
 *     &walk=12                     step forward along the trail (metres)
 *   lab.html                       small meadow + trail for grass/hands close-ups
 *   common: ?hands=0  ?pose=relaxed|stone|fist  ?zoom=2.2  ?textures=1
 *           ?quality=low  ?cinematic=0  ?time=16.6  ?weather=mist  ?wind=1  ?seed=42
 */
import * as THREE from 'three';
import { DEFAULT_CONFIG, biomeOfRegion, buildField, edgeCost, fbm, generateMaze, heightAt, regionAt, shortestPath, type BiomeId, type WalkField } from '@mazemeo/maze-core';
import { GOLDEN_HOUR, atmosphereFor, effectLight, motesAmount, sunsetAzimuthOffset } from './env/ambience.ts';
import type { Quality } from './env/foliage.ts';
import { Ferns } from './env/ferns.ts';
import { Grass } from './env/grass.ts';
import { Leaves } from './env/leaves.ts';
import { Motes } from './env/motes.ts';
import { PostFX } from './env/post.ts';
import { env } from './env/shared.ts';
import { SkySystem } from './env/sky.ts';
import { buildTerrain } from './env/terrain.ts';
import { getEnvTextures } from './env/textures.ts';
import { WEATHER_KINDS, Weather, type WeatherKind } from './env/weather.ts';
import { Hands } from './player/hands.ts';
import { buildWorld, type World } from './world.ts';

const params = new URLSearchParams(window.location.search);
const quality: Quality = params.get('quality') === 'low' ? 'low' : 'high';
const cinematic = params.get('cinematic') !== '0';
const canvas = document.getElementById('scene') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.62;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(72, window.innerWidth / window.innerHeight, 0.05, 2600);
camera.rotation.order = 'YXZ';

const tex = getEnvTextures();
const weather = new Weather();
const kind = params.get('weather') ?? 'clear';
weather.set((WEATHER_KINDS as string[]).includes(kind) ? (kind as WeatherKind) : 'clear');
weather.windScale = Number(params.get('wind') ?? 1);
weather.snap();
const sky = new SkySystem(scene, renderer);
sky.setShadowQuality(quality === 'low' ? 1024 : 2048);
const grass = new Grass(quality);
const ferns = new Ferns(tex, quality);
const leaves = new Leaves(tex);
const motes = new Motes();
const hands = new Hands(tex);
scene.add(grass.mesh, ferns.mesh, leaves.mesh, motes.points);
hands.resize(camera.aspect);
const post = new PostFX(renderer, scene, camera, hands.scene, hands.camera);
post.setSize(window.innerWidth, window.innerHeight);
const hours = Number(params.get('time') ?? GOLDEN_HOUR);

// --- Scene setup -------------------------------------------------------------------

let field: WalkField;
let world: World | null = null;
let biome: BiomeId = 'maple';

const spawnParam = Number(params.get('spawn') ?? (params.get('scene') === 'p6' ? 6 : 0));
if (spawnParam >= 1 && spawnParam <= 8) {
  const maze = generateMaze(Number(params.get('seed') ?? 42));
  field = buildField(maze);
  const spawn = maze.nodes[maze.spawns[spawnParam - 1]!]!;
  sky.azimuthOffset = sunsetAzimuthOffset(maze);
  world = buildWorld(maze, field, tex, quality, { x: spawn.x, z: spawn.z, r: 120 });
  world.overlay.visible = false;
  world.labels.visible = false;
  world.markers.visible = false;
  scene.add(world.root);
  biome = biomeOfRegion(spawn.regionId);
  // Stand at the spawn facing down the first trail of the route (as in the game).
  const route = shortestPath(maze, spawn.id, maze.exit, (e) => edgeCost(e, DEFAULT_CONFIG));
  const next = maze.nodes[route[1] ?? maze.exit]!;
  const dir = new THREE.Vector2(next.x - spawn.x, next.z - spawn.z).normalize();
  const walk = Number(params.get('walk') ?? 0);
  const x = spawn.x + dir.x * walk;
  const z = spawn.z + dir.y * walk;
  camera.position.set(x, heightAt(field, x, z) + 1.7, z);
  let yaw = Math.atan2(-dir.x, -dir.y);
  let pitch = 0.02;
  if (params.get('look') === 'cascade' && world.cascade) {
    // Stand across the trail from the pool and look up the falls.
    const { from, to } = world.cascade.viewpoint;
    camera.position.copy(from);
    yaw = Math.atan2(-(to.x - from.x), -(to.z - from.z));
    pitch = Math.atan2(to.y - from.y, Math.hypot(to.x - from.x, to.z - from.z));
  }
  camera.rotation.set(pitch + Number(params.get('pitch') ?? 0), yaw + Number(params.get('yaw') ?? 0), 0);
  camera.position.y += Number(params.get('up') ?? 0); // ?up=8 raises the camera for inspection
  biome = biomeOfRegion(regionAt(x, z, maze.layout, DEFAULT_CONFIG));
} else {
  // Small meadow with a gently winding trail along Z (grass / hands close-ups).
  const size = 61;
  const cell = 2;
  const n = size * size;
  field = { originX: -60, originZ: -60, cellSize: cell, size, clearance: new Float32Array(n), height: new Float32Array(n), region: new Uint8Array(n) };
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const k = j * size + i;
      const x = -60 + i * cell;
      const z = -60 + j * cell;
      const trailX = Math.sin(z * 0.05) * 4;
      field.clearance[k] = Math.abs(x - trailX) - 2.6;
      field.height[k] = fbm(77, x / 40, z / 40, 3) * 2.5 + Math.max(0, Math.abs(x - trailX) - 8) * 0.12;
      field.region[k] = x < 0 ? 1 : 0; // maple on the left, bamboo on the right
    }
  }
  scene.add(buildTerrain(field, tex));
  camera.position.set(0.5, heightAt(field, 0.5, 22) + 1.7, 22);
  camera.rotation.set(-0.12, 0, 0);
}
grass.setField(field, world?.cascade?.footprint);
ferns.setField(field, world?.cascade?.footprint);
hands.visible = params.get('hands') !== '0';

// ?zoom=2 magnifies the bottom-centre of the view (where the hands are) for close inspection.
const zoom = Number(params.get('zoom') ?? 1);
if (zoom > 1) {
  const w = window.innerWidth;
  const h = window.innerHeight;
  for (const cam of [camera, hands.camera]) cam.setViewOffset(w * zoom, h * zoom, (w * zoom - w) / 2, h * zoom - h * 1.05, w, h);
}

if (params.get('textures') === '1') {
  const sw = document.getElementById('swatches') as HTMLElement;
  for (const [label, t] of [
    ['Maple canopy card', tex.mapleCard],
    ['Fern frond', tex.fernCard],
    ['Granite', tex.granite],
    ['Falling-leaf atlas', tex.leafAtlas],
  ] as const) {
    const fig = document.createElement('figure');
    const c = document.createElement('canvas');
    const src = t.image as HTMLCanvasElement;
    c.width = src.width;
    c.height = src.height;
    c.getContext('2d')!.drawImage(src, 0, 0);
    fig.append(c, label);
    sw.append(fig);
  }
}

// --- Loop --------------------------------------------------------------------------

const pose = params.get('pose') ?? 'relaxed';
hands.holdingStone = pose === 'stone';
const clock = new THREE.Clock();
const noLook = new THREE.Vector2();
const fxLight = new THREE.Color();
let warm = 0;
function frame(): void {
  const dt = Math.min(clock.getDelta(), 0.05);
  env.uTime.value += dt;
  weather.update(dt);
  sky.update(dt, weather, hours, camera.position, camera, 75, 0.0042);
  grass.update(camera, null, true);
  ferns.update(camera, null, true);
  // Settle moods/leaf density immediately on the first frames (screenshots).
  const settle = warm < 30 ? 2 : dt;
  leaves.update(settle, camera, biome, true);
  motes.update(camera, sky.sunDir, sky.sun.color, motesAmount(sky, weather), true);
  world?.cascade?.update(effectLight(sky, fxLight));
  warm++;
  camera.updateMatrixWorld();
  if (hands.visible) {
    hands.update(dt, 0, 0, pose === 'fist', true, 0, noLook, {
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
  }
  if (cinematic) {
    scene.fog = null;
    post.render(atmosphereFor(settle, sky, weather, biome, camera.position.y - 1.7), hands.visible, env.uTime.value);
  } else {
    scene.fog = sky.fog;
    renderer.render(scene, camera);
    if (hands.visible) hands.render(renderer);
  }
  requestAnimationFrame(frame);
}
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  hands.resize(camera.aspect);
  renderer.setSize(window.innerWidth, window.innerHeight);
  post.setSize(window.innerWidth, window.innerHeight);
});
frame();
