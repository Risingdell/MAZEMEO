/**
 * Walkability / height field.
 *
 * Rasterises the maze graph onto a regular grid:
 *  - `clearance`: signed distance (m) to the nearest trail or clearing.
 *    <= 0 means walkable; > 0 is forest wall (trees, cliffs, bamboo).
 *  - `height`: final ground height with trails carved smoothly between
 *    junction heights and walls raised as berms/cliffs per biome.
 *  - `region`: region id per cell.
 *
 * The same field drives server collision (Phase 6) and client rendering,
 * so both always agree on where a player can stand.
 */
import { resolveConfig, type MazeConfig } from './config.ts';
import { biomeOfRegion, regionAt } from './generator.ts';
import { pointSegment } from './geometry.ts';
import { smoothstep, valueNoise } from './noise.ts';
import { createBaseHeight } from './terrain.ts';
import type { BiomeId, Maze } from './types.ts';

/** How tall the forest wall rises above the trail, per biome (m). */
export const BIOME_WALL_RAISE: Record<BiomeId, number> = {
  bamboo: 4,
  maple: 2.2, // gentle forest-floor rises: the trees and undergrowth form the walls
  shrine: 3, // mossy earth banks along a sunken trail
  marsh: -2.2, // sunken bog channels: impassable water between raised boardwalk trails
  summit: 8, // rock
};

export interface WalkField {
  /** World X/Z of grid cell (0,0). */
  originX: number;
  originZ: number;
  cellSize: number;
  /** Vertices per side. */
  size: number;
  clearance: Float32Array;
  height: Float32Array;
  region: Uint8Array;
}

/** Influence radius beyond the trail edge where carving still blends (m). */
const BLEND = 14;
/** Rim wall height outside the playable disc (m). */
const RIM_RAISE = 22;

export function buildField(maze: Maze, overrides: Partial<MazeConfig> = {}, cellSize = 2): WalkField {
  const cfg = resolveConfig(overrides);
  const extent = cfg.mapRadius + 24;
  const size = Math.ceil((extent * 2) / cellSize) + 1;
  const originX = -extent;
  const originZ = -extent;
  const n = size * size;
  const clearance = new Float32Array(n).fill(BLEND);
  const wSum = new Float32Array(n);
  const ySum = new Float32Array(n);
  const height = new Float32Array(n);
  const region = new Uint8Array(n);
  const base = createBaseHeight(maze.layout.terrainSeed, cfg);

  const stamp = (minX: number, maxX: number, minZ: number, maxZ: number, fn: (x: number, z: number) => { d: number; y: number }): void => {
    const i0 = Math.max(0, Math.floor((minX - originX) / cellSize));
    const i1 = Math.min(size - 1, Math.ceil((maxX - originX) / cellSize));
    const j0 = Math.max(0, Math.floor((minZ - originZ) / cellSize));
    const j1 = Math.min(size - 1, Math.ceil((maxZ - originZ) / cellSize));
    for (let j = j0; j <= j1; j++) {
      const z = originZ + j * cellSize;
      for (let i = i0; i <= i1; i++) {
        const x = originX + i * cellSize;
        const { d, y } = fn(x, z);
        if (d >= BLEND) continue;
        const k = j * size + i;
        if (d < (clearance[k] as number)) clearance[k] = d;
        const w = 1 / (Math.max(d, 0) + 1) ** 4;
        wSum[k] = (wSum[k] as number) + w;
        ySum[k] = (ySum[k] as number) + w * y;
      }
    }
  };

  // Trails: carved ramps between junction heights.
  const pad = cfg.pathHalfWidth + BLEND;
  for (const e of maze.edges) {
    const a = maze.nodes[e.a];
    const b = maze.nodes[e.b];
    if (!a || !b) continue;
    stamp(Math.min(a.x, b.x) - pad, Math.max(a.x, b.x) + pad, Math.min(a.z, b.z) - pad, Math.max(a.z, b.z) + pad, (x, z) => {
      const { t, d } = pointSegment(x, z, a.x, a.z, b.x, b.z);
      // Ease in/out so ramps flatten into clearings.
      const s = t * t * (3 - 2 * t);
      return { d: d - cfg.pathHalfWidth, y: a.y + (b.y - a.y) * s };
    });
  }
  // Clearings at junctions.
  const cpad = cfg.clearingRadius + BLEND;
  for (const node of maze.nodes) {
    stamp(node.x - cpad, node.x + cpad, node.z - cpad, node.z + cpad, (x, z) => ({
      d: Math.hypot(x - node.x, z - node.z) - cfg.clearingRadius,
      y: node.y,
    }));
  }

  const noiseSeed = (maze.layout.terrainSeed ^ 0x2545f491) >>> 0;
  for (let j = 0; j < size; j++) {
    const z = originZ + j * cellSize;
    for (let i = 0; i < size; i++) {
      const x = originX + i * cellSize;
      const k = j * size + i;
      const rid = regionAt(x, z, maze.layout, cfg);
      region[k] = rid;
      const b = base(x, z);
      const c = clearance[k] as number;
      const w = wSum[k] as number;
      const trailY = w > 0 ? (ySum[k] as number) / w : b;
      const ground = trailY + (b - trailY) * smoothstep(0, BLEND, c);
      const jitter = 0.7 + 0.6 * (valueNoise(noiseSeed, x / 9, z / 9) * 0.5 + 0.5);
      let raise = BIOME_WALL_RAISE[biomeOfRegion(rid)] * jitter * smoothstep(0.5, 7, c);
      const r = Math.hypot(x, z);
      const rim = smoothstep(cfg.mapRadius - 6, cfg.mapRadius + 10, r);
      raise += RIM_RAISE * rim;
      if (rim > 0) clearance[k] = Math.max(c, rim * BLEND);
      height[k] = ground + raise;
    }
  }

  return { originX, originZ, cellSize, size, clearance, height, region };
}

function sample(field: WalkField, arr: Float32Array, x: number, z: number): number {
  const fx = (x - field.originX) / field.cellSize;
  const fz = (z - field.originZ) / field.cellSize;
  const i = Math.max(0, Math.min(field.size - 2, Math.floor(fx)));
  const j = Math.max(0, Math.min(field.size - 2, Math.floor(fz)));
  const tx = Math.max(0, Math.min(1, fx - i));
  const tz = Math.max(0, Math.min(1, fz - j));
  const k = j * field.size + i;
  const a = arr[k] as number;
  const b = arr[k + 1] as number;
  const c = arr[k + field.size] as number;
  const d = arr[k + field.size + 1] as number;
  return (a + (b - a) * tx) * (1 - tz) + (c + (d - c) * tx) * tz;
}

/** Bilinear ground height at a world position. */
export function heightAt(field: WalkField, x: number, z: number): number {
  return sample(field, field.height, x, z);
}

/** Signed clearance at a world position (<= 0 walkable). */
export function clearanceAt(field: WalkField, x: number, z: number): number {
  return sample(field, field.clearance, x, z);
}

export function isWalkable(field: WalkField, x: number, z: number): boolean {
  return clearanceAt(field, x, z) <= 0;
}
