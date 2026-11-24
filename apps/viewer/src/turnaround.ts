/**
 * Character turnaround sheet: the in-game explorer model in a neutral A-pose,
 * rendered from the front, three-quarter, side and back on a light-grey
 * studio backdrop (key + fill + rim lights, soft room reflections, contact
 * shadow). Uses exactly the model the game uses, so it doubles as a review
 * page for character changes.
 */
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { getEnvTextures } from './env/textures.ts';
import { Character } from './player/character.ts';

const canvas = document.getElementById('scene') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.setScissorTest(true);

const scene = new THREE.Scene();
scene.background = null; // transparent: the CSS backdrop + grid show through
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.55;

// Studio lights: warm key (front-left, high), cool fill (front-right), rim from behind.
const key = new THREE.DirectionalLight(0xfff1e0, 2.6);
key.position.set(-2.5, 4, -3.5);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
key.shadow.camera.left = key.shadow.camera.bottom = -1.5;
key.shadow.camera.right = key.shadow.camera.top = 1.5;
key.shadow.bias = -0.0005;
const fill = new THREE.DirectionalLight(0xdfe8ff, 0.8);
fill.position.set(3, 2, -2);
const rim = new THREE.DirectionalLight(0xffffff, 1.4);
rim.position.set(0, 3, 4);
scene.add(key, fill, rim, new THREE.HemisphereLight(0xffffff, 0x8a8884, 0.5));

// Floor: shadow catcher on the backdrop colour.
const floor = new THREE.Mesh(new THREE.CircleGeometry(3, 48).rotateX(-Math.PI / 2), new THREE.ShadowMaterial({ opacity: 0.22 }));
floor.receiveShadow = true;
scene.add(floor);

const character = new Character(getEnvTextures());
character.aPose = true;
scene.add(character.root);
character.update(0, new THREE.Vector3(0, 0, 0), { speed: 0, stepPhase: 0, sprinting: false, grounded: true, crouch: 0, moveDir: null });

// Four views: angle measured from the front (the character faces -Z).
const views = [0, Math.PI / 4, Math.PI / 2, Math.PI].map((angle) => {
  const cam = new THREE.PerspectiveCamera(16, 1, 0.1, 50);
  const d = 9.2;
  cam.position.set(Math.sin(angle) * d, 1.05, -Math.cos(angle) * d);
  cam.lookAt(0, 0.98, 0);
  return cam;
});

function render(): void {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const cw = w / views.length;
  views.forEach((cam, i) => {
    cam.aspect = cw / h;
    cam.updateProjectionMatrix();
    renderer.setViewport(i * cw, 0, cw, h);
    renderer.setScissor(i * cw, 0, cw, h);
    renderer.render(scene, cam);
  });
}

/**
 * 8-head proportion grid (1 head = 0.225 m): a line at every head height, the
 * head count on the left and anatomy landmarks on the right. Heights are
 * projected through the front camera (all four views share height/distance).
 */
const HEAD = 0.225;
const LANDMARKS: Record<number, string> = { 8: 'Top of head', 7: 'Chin', 6: 'Chest', 5: 'Navel · elbow', 4: 'Crotch · wrist', 2: 'Knees', 0: 'Feet' };
const grid = document.getElementById('grid') as HTMLElement;
function drawGrid(): void {
  const cam = views[0]!;
  const h = window.innerHeight;
  grid.innerHTML = '';
  for (let k = 0; k <= 8; k++) {
    const y = new THREE.Vector3(0, k * HEAD, 0).project(cam).y;
    const top = (1 - (y * 0.5 + 0.5)) * h;
    const line = document.createElement('div');
    line.className = 'gl';
    line.style.top = `${top}px`;
    const label = LANDMARKS[k];
    line.innerHTML = `<span class="n">${k > 0 ? 9 - k : ''}</span>${label ? `<span class="l">${label}</span>` : ''}`;
    grid.appendChild(line);
  }
}

window.addEventListener('resize', () => {
  renderer.setSize(window.innerWidth, window.innerHeight);
  render();
  drawGrid();
});
render();
drawGrid();
