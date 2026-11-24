import type { BiomeId, EdgeKind, ToolKind } from './types.ts';

/**
 * All tuning knobs for generation. Pass a Partial<MazeConfig> to override.
 * Server and clients MUST use the same config for a given match.
 */
export interface MazeConfig {
  /** Radius of the playable disc (m). */
  mapRadius: number;
  /** Minimum spacing between junction nodes (Poisson-disc radius, m). */
  nodeSpacing: number;
  /** Nodes within this radius of the centre belong to the summit region. */
  summitRadius: number;
  /** Terrain height at the summit relative to the rim (m). */
  summitHeight: number;
  /** Amplitude of rolling terrain noise (m). */
  terrainRoughness: number;

  /** Extra loop edges as a fraction of spanning-tree edges. */
  loopRatio: number;
  /** A loop edge must shortcut at least this many tree hops. */
  minLoopHops: number;
  /** Max edges per junction (keeps junctions readable). */
  maxDegree: number;

  /** Slope (rise/run) above which an edge is a climb. */
  climbSlope: number;
  /** Slope above which an edge needs the grapple. */
  grappleSlope: number;
  /** Travel-cost multiplier per edge kind (used for fairness + AI). */
  kindCost: Record<EdgeKind, number>;

  spawnCount: number;
  /** Hard minimum straight-line distance between any two spawns (m). */
  minSpawnSeparation: number;
  /** Spawns are chosen from nodes beyond this fraction of mapRadius. */
  spawnRingMin: number;
  /** Accept a maze when spawn fairness spread <= this. */
  fairnessTolerance: number;
  /** Attempts before returning the fairest maze found. */
  maxAttempts: number;

  /** Path half-width used by the walkability field (m). */
  pathHalfWidth: number;
  /** Radius of the open clearing at each junction (m). */
  clearingRadius: number;
}

export const DEFAULT_CONFIG: Readonly<MazeConfig> = Object.freeze({
  mapRadius: 250,
  nodeSpacing: 30,
  summitRadius: 48,
  summitHeight: 70,
  terrainRoughness: 18,

  loopRatio: 0.18,
  minLoopHops: 6,
  maxDegree: 4,

  climbSlope: 0.33,
  grappleSlope: 0.52,
  kindCost: Object.freeze({ path: 1, climb: 1.8, grapple: 1.35 }) as Record<EdgeKind, number>,

  spawnCount: 8,
  minSpawnSeparation: 60,
  spawnRingMin: 0.6,
  fairnessTolerance: 0.08,
  maxAttempts: 16,

  pathHalfWidth: 3,
  clearingRadius: 7,
});

export function resolveConfig(overrides: Partial<MazeConfig> = {}): MazeConfig {
  const cfg: MazeConfig = { ...DEFAULT_CONFIG, ...overrides, kindCost: { ...DEFAULT_CONFIG.kindCost, ...overrides.kindCost } };
  if (cfg.nodeSpacing <= 0 || cfg.mapRadius <= cfg.nodeSpacing * 3) throw new Error('mapRadius must be > 3 * nodeSpacing');
  if (cfg.spawnCount < 1) throw new Error('spawnCount must be >= 1');
  if (cfg.grappleSlope <= cfg.climbSlope) throw new Error('grappleSlope must be > climbSlope');
  if (cfg.summitRadius >= cfg.mapRadius * cfg.spawnRingMin) throw new Error('summitRadius must be inside the spawn ring');
  return cfg;
}

/** The four outer biomes, in sector order (clockwise from sectorOffset). */
export const OUTER_BIOMES: readonly BiomeId[] = ['bamboo', 'maple', 'shrine', 'marsh'];

export const BIOME_NAMES: Record<BiomeId, string> = {
  bamboo: 'Bamboo Thicket',
  maple: 'Maple Ravine',
  shrine: 'Shrine Ruins',
  marsh: 'Misty Marsh',
  summit: 'Summit Pass',
};

/** Tool tiers: longer dead-end branches hold better tools (risk/reward). */
export const TOOL_TIERS: readonly (readonly ToolKind[])[] = [
  ['smoke_bomb', 'snare_trap'],
  ['grapple_charge', 'smoke_bomb'],
  ['scout_kite', 'grapple_charge'],
];
