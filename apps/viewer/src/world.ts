/**
 * Assembles the 3D world for a maze: textured terrain, bog water, forest,
 * the ravine waterfall,
 * distant mountains, debug trail overlay, exit gate, spawns and tool caches.
 * Everything derives from the maze + walk field, so every client with the
 * same seed sees the same world.
 */
import * as THREE from 'three';
import { DEFAULT_CONFIG, heightAt, smoothstep, valueNoise, type Maze, type WalkField } from '@mazemeo/maze-core';
import { buildCascade, type Cascade } from './env/cascade.ts';
import { buildFoliage, type Circle, type Quality, type RockCollider, type TrunkCollider } from './env/foliage.ts';
import { HORIZON_OVERLAP, buildTerrain, buildWater } from './env/terrain.ts';
import type { EnvTextures } from './env/textures.ts';
import { EDGE_COLORS, SPAWN_COLORS, TOOL_COLORS } from './palette.ts';

export interface World {
  root: THREE.Group;
  forest: THREE.Group;
  overlay: THREE.Group;
  labels: THREE.Group;
  /** Spawn pillars etc. — hidden on the ground for immersion. */
  markers: THREE.Group;
  trunks: TrunkCollider[];
  rocks: RockCollider[];
  instanceCount: number;
  /** The ravine waterfall landmark, if this maze has a ravine spawn. */
  cascade: Cascade | null;
  /** Pick up the tool cache at a node (hides it). Returns false if none/already taken. */
  collectCache(nodeId: number): boolean;
  update(timeSec: number): void;
  dispose(): void;
}

/**
 * Note: builds the waterfall first because it carves its pool into `field`;
 * build physics and ground cover from `field` after calling this.
 * @param focus optional circle limiting the forest to an area (Asset Lab previews)
 */
export function buildWorld(maze: Maze, field: WalkField, tex: EnvTextures, quality: Quality, focus?: Circle): World {
  const root = new THREE.Group();
  const cascade = buildCascade(maze, field, tex);
  const foliage = buildFoliage(maze, field, tex, quality, { focus, exclude: cascade?.footprint ?? [] });
  if (cascade) {
    foliage.trunks.push(...cascade.colliders);
    root.add(cascade.group);
  }
  const overlay = buildOverlay(maze, field);
  const markers = buildMarkers(maze, field, foliage.trunks);
  root.add(buildTerrain(field, tex), buildHorizon(field, maze.layout.terrainSeed), foliage.group, overlay, markers.group, markers.gate);
  const water = buildWater(field);
  if (water) root.add(water);

  return {
    root,
    forest: foliage.group,
    overlay,
    labels: markers.labels,
    markers: markers.group,
    trunks: foliage.trunks,
    rocks: foliage.rocks,
    instanceCount: foliage.instanceCount,
    cascade,
    update: markers.update,
    collectCache: markers.collect,
    dispose: () => disposeTree(root),
  };
}

// --- Horizon: distant mountain ring so the island never shows an edge --------

function buildHorizon(field: WalkField, seed: number): THREE.Mesh {
  // A real mountain range around the island: forested foothills close in,
  // then jagged granite peaks with snow on their high, gentler faces.
  const inner = DEFAULT_CONFIG.mapRadius + HORIZON_OVERLAP - 4;
  const radii = [inner, inner + 12, inner + 40, inner + 90, 380];
  for (let r = 440; r <= 1900; r += r < 1000 ? 55 : 75) radii.push(r);
  const segs = 720; // ~15 m between vertices at the far edge: no long thin streaks
  const pos: number[] = [];
  const heights: number[] = [];
  for (const r of radii) {
    for (let s = 0; s <= segs; s++) {
      const a = (s / segs) * Math.PI * 2;
      const rimY = heightAt(field, Math.cos(a) * inner, Math.sin(a) * inner);
      // 2D ridged noise over the landscape -> broad massifs, sharp crests and
      // valleys at many distances, so ranges layer behind one another.
      const wx = Math.cos(a) * r;
      const wz = Math.sin(a) * r;
      let ridge = 0;
      let amp = 1;
      let norm = 0;
      let freq = 1 / 760;
      // 3 octaves: the finest relief (~120 m) stays above twice the ring spacing,
      // otherwise it aliases into radial streaks. Colour noise adds the fine detail.
      for (let o = 0; o < 3; o++) {
        const n = 1 - Math.abs(valueNoise(seed + o * 17, wx * freq, wz * freq));
        ridge += amp * n * n * (o === 0 ? 1 : ridge / norm + 0.4); // detail mostly on the crests
        norm += amp;
        amp *= 0.5;
        freq *= 2.1;
      }
      ridge = Math.min(1, ridge / norm);
      // Broad massifs rising to a few sharper summits (steepness capped so faces stay mountain-like).
      const peaks = (25 + ridge ** 1.35 * 440) * smoothstep(inner + 60, 1100, r);
      const valley = -25 * smoothstep(inner, inner + 90, r) * (1 - smoothstep(420, 700, r));
      const y = rimY + valley + peaks;
      pos.push(Math.cos(a) * r, y, Math.sin(a) * r);
      heights.push(y - rimY);
    }
  }
  const index: number[] = [];
  const row = segs + 1;
  for (let ri = 0; ri < radii.length - 1; ri++) {
    for (let s = 0; s < segs; s++) {
      const a = ri * row + s;
      index.push(a, a + 1, a + row, a + 1, a + row + 1, a + row);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(index);
  geo.computeVertexNormals();
  // Colour by altitude and slope: forest -> granite -> snow (snow sticks to gentler faces).
  const nrm = geo.getAttribute('normal') as THREE.BufferAttribute;
  const forest = new THREE.Color(0x26331f);
  const rock = new THREE.Color(0x6f6b66);
  const snow = new THREE.Color(0xe9eef4);
  const col: number[] = [];
  const c = new THREE.Color();
  for (let i = 0; i < heights.length; i++) {
    const h = heights[i]!;
    const flat = nrm.getY(i);
    const n = valueNoise(seed + 99, pos[i * 3]! / 60, pos[i * 3 + 2]! / 60) * 40;
    c.copy(forest).lerp(rock, smoothstep(90, 170, h + n * 0.5));
    // Granite varies from warm grey to dark; snow only high up and only where it can lie.
    c.multiplyScalar(0.8 + valueNoise(seed + 7, pos[i * 3]! / 25, pos[i * 3 + 2]! / 25) * 0.25);
    const snowLine = 305 + n * 1.5 - (flat - 0.6) * 140;
    c.lerp(snow, smoothstep(snowLine, snowLine + 50, h) * smoothstep(0.45, 0.75, flat));
    col.push(c.r, c.g, c.b);
  }
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 }));
  mesh.receiveShadow = true;
  mesh.name = 'horizon';
  return mesh;
}

// --- Trail graph overlay ----------------------------------------------------

function buildOverlay(maze: Maze, field: WalkField): THREE.Group {
  const pos: number[] = [];
  const col: number[] = [];
  const c = new THREE.Color();
  for (const e of maze.edges) {
    const a = maze.nodes[e.a];
    const b = maze.nodes[e.b];
    if (!a || !b) continue;
    c.set(EDGE_COLORS[e.kind]);
    if (e.isLoop) c.offsetHSL(0, 0, 0.1);
    const segs = 14;
    for (let s = 0; s < segs; s++) {
      for (const t of [s / segs, (s + 1) / segs]) {
        const x = a.x + (b.x - a.x) * t;
        const z = a.z + (b.z - a.z) * t;
        pos.push(x, heightAt(field, x, z) + 0.7, z);
        col.push(c.r, c.g, c.b);
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  const lines = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.9, toneMapped: false }));
  lines.renderOrder = 2;

  const dot = new THREE.InstancedMesh(new THREE.SphereGeometry(0.9, 10, 8), new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false }), maze.nodes.length);
  const m = new THREE.Matrix4();
  maze.nodes.forEach((n, i) => {
    m.makeTranslation(n.x, heightAt(field, n.x, n.z) + 0.8, n.z);
    dot.setMatrixAt(i, m);
    dot.setColorAt(i, new THREE.Color(n.isDeadEnd ? 0x9a948a : 0xffffff));
  });
  dot.instanceMatrix.needsUpdate = true;

  const group = new THREE.Group();
  group.name = 'overlay';
  group.add(lines, dot);
  return group;
}

// --- Exit gate, spawns, caches ----------------------------------------------

function buildMarkers(
  maze: Maze,
  field: WalkField,
  colliders: TrunkCollider[],
): { group: THREE.Group; gate: THREE.Group; labels: THREE.Group; update: (t: number) => void; collect: (nodeId: number) => boolean } {
  const group = new THREE.Group();
  const labels = new THREE.Group();
  const gate = new THREE.Group();
  group.add(labels);

  // Exit: vermilion torii gate (always visible) + a tall beam of light.
  const exit = maze.nodes[maze.exit];
  if (exit) {
    const y = heightAt(field, exit.x, exit.z);
    const torii = buildTorii();
    torii.position.set(exit.x, y, exit.z);
    const firstEdge = maze.edges[exit.edges[0] ?? 0];
    if (firstEdge) {
      const other = maze.nodes[firstEdge.a === exit.id ? firstEdge.b : firstEdge.a];
      if (other) torii.rotation.y = Math.atan2(other.x - exit.x, other.z - exit.z);
    }
    gate.add(torii);
    gate.add(lightBeam(exit.x, y, exit.z, 0xffd27a, 3.2, 160, 0.22));
    labels.add(textSprite('EXIT', exit.x, y + 18, exit.z, '#ffd27a'));
    // Gate posts are solid.
    for (const sx of [-1, 1]) {
      const local = new THREE.Vector3(sx * 3.5, 0, 0).applyAxisAngle(new THREE.Vector3(0, 1, 0), torii.rotation.y);
      colliders.push({ x: exit.x + local.x, y, z: exit.z + local.z, radius: 0.55, height: 9 });
    }
  }

  // Spawns: coloured pillars + labels.
  const pulses: THREE.Mesh[] = [];
  maze.spawns.forEach((id, i) => {
    const n = maze.nodes[id];
    if (!n) return;
    const y = heightAt(field, n.x, n.z);
    const color = SPAWN_COLORS[i % SPAWN_COLORS.length] as number;
    const beam = lightBeam(n.x, y, n.z, color, 1.6, 55, 0.35);
    pulses.push(beam);
    group.add(beam);
    labels.add(textSprite(`P${i + 1}`, n.x, y + 9, n.z, `#${color.toString(16).padStart(6, '0')}`));
  });

  // Caches: floating crystals on a stone plinth at dead ends.
  const crystals: THREE.Mesh[] = [];
  const cacheMeshes = new Map<number, THREE.Mesh[]>();
  const crystalGeo = new THREE.OctahedronGeometry(0.28, 0);
  const plinthGeo = new THREE.CylinderGeometry(0.35, 0.5, 0.9, 7);
  const plinthMat = new THREE.MeshStandardMaterial({ color: 0x77736b, roughness: 0.95 });
  for (const n of maze.nodes) {
    if (!n.cache) continue;
    const color = TOOL_COLORS[n.cache];
    const mesh = new THREE.Mesh(crystalGeo, new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 1.2, roughness: 0.25 }));
    const y = heightAt(field, n.x, n.z) + 1.35;
    mesh.position.set(n.x, y, n.z);
    mesh.userData.baseY = y;
    mesh.castShadow = true;
    crystals.push(mesh);
    gate.add(mesh);
    const stand = new THREE.Mesh(plinthGeo, plinthMat);
    stand.position.set(n.x, y - 0.95, n.z);
    stand.castShadow = stand.receiveShadow = true;
    gate.add(stand);
    cacheMeshes.set(n.id, [mesh, stand]);
    colliders.push({ x: n.x, y: y - 1.4, z: n.z, radius: 0.45, height: 0.9 });
  }

  const update = (t: number): void => {
    crystals.forEach((c, i) => {
      c.rotation.y = t * 1.2 + i;
      c.position.y = (c.userData.baseY as number) + Math.sin(t * 2 + i) * 0.08;
    });
    pulses.forEach((p, i) => {
      (p.material as THREE.MeshBasicMaterial).opacity = 0.25 + 0.12 * Math.sin(t * 2.4 + i * 0.8);
    });
  };
  const collect = (nodeId: number): boolean => {
    const meshes = cacheMeshes.get(nodeId);
    if (!meshes || !meshes[0]!.visible) return false;
    meshes[0]!.visible = false; // the crystal is taken; the plinth stays
    return true;
  };
  return { group, gate, labels, update, collect };
}

function buildTorii(): THREE.Group {
  const red = new THREE.MeshStandardMaterial({ color: 0xb8301b, roughness: 0.55 });
  const black = new THREE.MeshStandardMaterial({ color: 0x1f1a17, roughness: 0.6 });
  const stone = new THREE.MeshStandardMaterial({ color: 0x7d7a73, roughness: 0.95 });
  const g = new THREE.Group();
  const span = 7;
  const h = 9;
  for (const sx of [-1, 1]) {
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.52, h, 16), red);
    post.position.set((sx * span) / 2, h / 2, 0);
    g.add(post);
    const foot = new THREE.Mesh(new THREE.CylinderGeometry(0.62, 0.62, 0.7, 16), black);
    foot.position.set((sx * span) / 2, 0.35, 0);
    g.add(foot);
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 1.0, 0.5, 8), stone);
    base.position.set((sx * span) / 2, 0.05, 0);
    g.add(base);
  }
  const nuki = new THREE.Mesh(new THREE.BoxGeometry(span + 1.6, 0.55, 0.42), red);
  nuki.position.y = h * 0.72;
  // Kasagi: the upswept top beam.
  const kasagiGeo = new THREE.BoxGeometry(span + 3.6, 0.65, 0.95, 24, 1, 1);
  const kp = kasagiGeo.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < kp.count; i++) {
    const x = kp.getX(i);
    kp.setY(i, kp.getY(i) + (x / ((span + 3.6) / 2)) ** 2 * 0.55);
  }
  kasagiGeo.computeVertexNormals();
  const kasagi = new THREE.Mesh(kasagiGeo, black);
  kasagi.position.y = h + 0.35;
  const shimaki = new THREE.Mesh(new THREE.BoxGeometry(span + 2.8, 0.55, 0.75), red);
  shimaki.position.y = h - 0.25;
  const plaque = new THREE.Mesh(new THREE.BoxGeometry(0.9, 1.4, 0.3), black);
  plaque.position.y = h * 0.86;
  g.add(nuki, kasagi, shimaki, plaque);
  g.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      o.castShadow = true;
      o.receiveShadow = true;
    }
  });
  return g;
}

function lightBeam(x: number, y: number, z: number, color: number, radius: number, height: number, opacity: number): THREE.Mesh {
  const geo = new THREE.CylinderGeometry(radius * 0.6, radius, height, 16, 1, true).translate(0, height / 2, 0);
  // Normal blending (not additive) so beams keep their colour against bright fog.
  const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, side: THREE.FrontSide, fog: false, toneMapped: false });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(x, y, z);
  mesh.renderOrder = 3;
  return mesh;
}

function textSprite(text: string, x: number, y: number, z: number, color: string): THREE.Sprite {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.font = '600 64px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 10;
    ctx.strokeStyle = 'rgba(10,12,14,0.85)';
    ctx.strokeText(text, 128, 64);
    ctx.fillStyle = color;
    ctx.fillText(text, 128, 64);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  // Fixed on-screen size so labels stay readable at any zoom.
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true, fog: false, sizeAttenuation: false, toneMapped: false }));
  sprite.position.set(x, y, z);
  sprite.scale.set(0.07, 0.035, 1);
  sprite.renderOrder = 10;
  return sprite;
}

/** Disposes geometries and per-world materials. Shared env textures are kept. */
function disposeTree(obj: THREE.Object3D): void {
  const seen = new Set<object>();
  obj.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.geometry && !seen.has(mesh.geometry)) {
      seen.add(mesh.geometry);
      mesh.geometry.dispose();
    }
    const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
    for (const m of Array.isArray(mat) ? mat : mat ? [mat] : []) {
      if (seen.has(m)) continue;
      seen.add(m);
      if (m instanceof THREE.SpriteMaterial) m.map?.dispose();
      m.dispose();
    }
  });
}
