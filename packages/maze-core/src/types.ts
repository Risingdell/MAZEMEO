/**
 * Core data model for a Forest Escape maze.
 *
 * Coordinate system: X/Z is the ground plane, Y is up, units are metres.
 * The map is a disc of radius `config.mapRadius` centred on the origin;
 * the exit sits on the summit at (0, 0).
 */

export type BiomeId = 'bamboo' | 'maple' | 'shrine' | 'marsh' | 'summit';

/**
 * How an edge is traversed.
 *  - path:    walkable trail
 *  - climb:   steep scramble (slower, noisy)
 *  - grapple: cliff that needs the grapple (fast but exposed)
 */
export type EdgeKind = 'path' | 'climb' | 'grapple';

export type ToolKind = 'smoke_bomb' | 'snare_trap' | 'grapple_charge' | 'scout_kite';

export interface MazeNode {
  id: number;
  x: number;
  y: number;
  z: number;
  regionId: number;
  /** Edge ids touching this node. */
  edges: number[];
  isDeadEnd: boolean;
  /** 0..spawnCount-1 when this node is a spawn, otherwise -1. */
  spawnIndex: number;
  isExit: boolean;
  /** Tool cache placed here (dead ends only), or null. */
  cache: ToolKind | null;
  /** Weighted travel cost from this node to the exit. */
  costToExit: number;
}

export interface MazeEdge {
  id: number;
  a: number;
  b: number;
  kind: EdgeKind;
  /** 3D length in metres. */
  length: number;
  /** rise / run between the endpoints (absolute). */
  slope: number;
  /** True if this edge was added after the spanning tree (creates a loop). */
  isLoop: boolean;
}

export interface MazeRegion {
  id: number;
  biome: BiomeId;
  name: string;
  nodeIds: number[];
  /** Regions sharing at least one edge with this one (used for kill reveals). */
  neighbors: number[];
  /** Centroid of member nodes. */
  centerX: number;
  centerZ: number;
}

export interface MazeStats {
  nodes: number;
  edges: number;
  treeEdges: number;
  loopEdges: number;
  deadEnds: number;
  caches: number;
  edgeKinds: Record<EdgeKind, number>;
  /** (max - min) / mean of spawn costs to the exit. 0 = perfectly fair. */
  fairnessSpread: number;
  minSpawnCost: number;
  maxSpawnCost: number;
  /** Which generation attempt produced this maze (0-based). */
  attempt: number;
}

export interface MazeLayout {
  /** Angle (radians) where biome sector 0 starts. */
  sectorOffset: number;
  /** Angle (radians) where spawn sector 0 starts. */
  spawnOffset: number;
  /** Seed for terrain noise. */
  terrainSeed: number;
}

export interface Maze {
  seed: number;
  nodes: MazeNode[];
  edges: MazeEdge[];
  regions: MazeRegion[];
  /** Node ids, index = spawn index. */
  spawns: number[];
  exit: number;
  layout: MazeLayout;
  stats: MazeStats;
}
