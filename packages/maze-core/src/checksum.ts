/**
 * Maze checksum: the server sends (seed, configVersion, checksum); each
 * client regenerates the maze and compares. A mismatch means a client is
 * running different code/config and must not join the match.
 */
import { hash32 } from './rng.ts';
import type { Maze } from './types.ts';

/** Positions are quantised to centimetres so float noise can't cause false mismatches. */
const q = (v: number): number => Math.round(v * 100);

export function mazeChecksum(maze: Maze): string {
  let h = hash32('maze', maze.seed, maze.nodes.length, maze.edges.length);
  for (const n of maze.nodes) h = hash32(h, q(n.x), q(n.y), q(n.z), n.regionId, n.spawnIndex, n.cache ?? '-');
  for (const e of maze.edges) h = hash32(h, e.a, e.b, e.kind, e.isLoop ? 1 : 0);
  for (const s of maze.spawns) h = hash32(h, s);
  return h.toString(16).padStart(8, '0');
}
