/**
 * Per-biome mood: how misty, how warm, how many light shafts and dust motes.
 * Shared by the game loop and the Asset Lab so previews match the game.
 */
import * as THREE from 'three';
import { DEFAULT_CONFIG, edgeCost, shortestPath, type BiomeId, type Maze } from '@mazemeo/maze-core';
import { ravineSpawn } from './cascade.ts';
import type { AtmosphereParams } from './post.ts';
import type { SkySystem } from './sky.ts';
import type { Weather } from './weather.ts';

interface Mood {
  /** Mist density multiplier. */
  mist: number;
  /** Light-shaft multiplier. */
  rays: number;
  /** Dust mote amount. */
  motes: number;
  /** Cool tint for mist away from the sun. */
  cool: number;
}

/** The autumn ravine is the misty, sun-shafted showcase; others are calmer. */
const MOODS: Record<BiomeId, Mood> = {
  maple: { mist: 4.2, rays: 1.6, motes: 1, cool: 0x7fa0b4 },
  shrine: { mist: 2.4, rays: 1.4, motes: 0.7, cool: 0x86a4c8 }, // pine forest: blue valley mist
  bamboo: { mist: 1.1, rays: 0.8, motes: 0.5, cool: 0x9fb0a4 },
  marsh: { mist: 2.6, rays: 0.5, motes: 0.2, cool: 0xa4b0b0 },
  summit: { mist: 0.6, rays: 0.6, motes: 0.15, cool: 0xb0bcc8 },
};

const params: AtmosphereParams = {
  sunDir: new THREE.Vector3(),
  sunColor: new THREE.Color(),
  sunStrength: 1,
  mistColor: new THREE.Color(),
  glowColor: new THREE.Color(),
  density: 0.005,
  baseHeight: 0,
  rays: 1,
};
const cool = new THREE.Color();
const smoothMood = { mist: 1, rays: 1, motes: 0.5 };

/** Atmosphere for the post pass. Mood changes blend smoothly as you cross biomes. */
export function atmosphereFor(dt: number, sky: SkySystem, weather: Weather, biome: BiomeId, groundY: number): AtmosphereParams {
  const m = MOODS[biome];
  const k = Math.min(1, dt * 0.6);
  smoothMood.mist += (m.mist - smoothMood.mist) * k;
  smoothMood.rays += (m.rays - smoothMood.rays) * k;
  smoothMood.motes += (m.motes - smoothMood.motes) * k;
  const w = weather.current;
  params.sunDir.copy(sky.sunDir);
  params.sunStrength = Math.min(1, sky.sun.intensity / 3.4);
  params.sunColor.copy(sky.sun.color);
  // Cool, slightly blue mist in the shade; warm golden glow towards the sun.
  cool.set(m.cool).multiplyScalar(0.35 + sky.daylight * 0.65);
  params.mistColor.copy(sky.fog.color).lerp(cool, 0.45);
  params.glowColor.copy(sky.sun.color).multiplyScalar(0.9 + params.sunStrength * 0.6).lerp(sky.fog.color, 0.25);
  params.density = 0.0042 * w.fog * smoothMood.mist;
  params.baseHeight = groundY;
  params.rays = smoothMood.rays * (1 - w.cloud * 0.75);
  return params;
}

/** How visible floating dust is right now (still, sunny air shows the most). */
export function motesAmount(sky: SkySystem, weather: Weather): number {
  const w = weather.current;
  return smoothMood.motes * Math.min(1, sky.sun.intensity / 3.4) * (1 - w.rain) * (1 - Math.min(1, w.wind) * 0.4);
}

/** Approximate light falling on unlit effects (waterfall sheets, mist). */
export function effectLight(sky: SkySystem, out: THREE.Color): THREE.Color {
  return out
    .copy(sky.hemi.color)
    .multiplyScalar(sky.hemi.intensity * 0.5)
    .add(new THREE.Color().copy(sky.sun.color).multiplyScalar(sky.sun.intensity * 0.12));
}

/** Time of day the showcase is tuned for (golden hour). */
export const GOLDEN_HOUR = 17.3;

/**
 * Sun-path rotation (degrees) so that at golden hour the sun sits low ahead,
 * slightly to one side, as you set off from the ravine spawn — you walk into
 * the light, backlit trees and shafts in the mist (the reference look).
 */
export function sunsetAzimuthOffset(maze: Maze): number {
  const id = ravineSpawn(maze);
  if (id === null) return 0;
  const s = maze.nodes[id]!;
  const route = shortestPath(maze, s.id, maze.exit, (e) => edgeCost(e, DEFAULT_CONFIG));
  const n = maze.nodes[route[1] ?? maze.exit]!;
  const facing = THREE.MathUtils.radToDeg(Math.atan2(n.x - s.x, n.z - s.z));
  const t = (GOLDEN_HOUR - 6) / 12;
  return facing - (100 + t * 160) + 14;
}
