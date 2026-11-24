/**
 * Maze generator v2.
 *
 * Pipeline (per attempt):
 *   1. Poisson-disc junctions over the map disc, first point = summit/exit.
 *   2. Gabriel graph of the junctions -> planar candidate trails.
 *   3. Randomised Kruskal spanning tree -> a "perfect" maze.
 *   4. Re-add a fraction of long-shortcut edges -> loops for flanking/escape.
 *   5. Sample terrain heights, classify edges as path / climb / grapple.
 *   6. Biome regions (4 outer sectors + summit) and region adjacency.
 *   7. Weighted shortest path from the exit; pick 8 spawns, one per angular
 *      sector, with near-equal travel cost (fairness).
 *   8. Dead ends get tool caches; longer dead-end branches get better tools.
 *
 * Attempts repeat with derived seeds until fairness is within tolerance;
 * the fairest attempt wins. Same seed + config => identical maze.
 */
import { BIOME_NAMES, OUTER_BIOMES, TOOL_TIERS, resolveConfig, type MazeConfig } from './config.ts';
import { SpatialGrid, angleFrom, dist, segmentsCross, type P2 } from './geometry.ts';
import { DisjointSet, bfsHops, buildAdjacency, dijkstra } from './graph.ts';
import { Rng } from './rng.ts';
import { createBaseHeight } from './terrain.ts';
import type { BiomeId, EdgeKind, Maze, MazeEdge, MazeLayout, MazeNode, MazeRegion, MazeStats, ToolKind } from './types.ts';

export const SUMMIT_REGION_ID = OUTER_BIOMES.length; // 4

export function generateMaze(seed: number, overrides: Partial<MazeConfig> = {}): Maze {
  const cfg = resolveConfig(overrides);
  const root = new Rng(seed);
  let best: Maze | null = null;
  for (let attempt = 0; attempt < cfg.maxAttempts; attempt++) {
    const maze = generateAttempt(seed >>> 0, attempt, cfg, root.fork(`attempt:${attempt}`));
    if (!maze) continue;
    if (!best || maze.stats.fairnessSpread < best.stats.fairnessSpread) best = maze;
    if (maze.stats.fairnessSpread <= cfg.fairnessTolerance) break;
  }
  if (!best) throw new Error(`Maze generation failed for seed ${seed} after ${cfg.maxAttempts} attempts`);
  return best;
}

/** Region id for any world position (used by the field and gameplay). */
export function regionAt(x: number, z: number, layout: MazeLayout, cfg: Pick<MazeConfig, 'summitRadius'>): number {
  if (x * x + z * z < cfg.summitRadius * cfg.summitRadius) return SUMMIT_REGION_ID;
  const sector = Math.floor(angleFrom(x, z, layout.sectorOffset) / ((Math.PI * 2) / OUTER_BIOMES.length));
  return Math.min(sector, OUTER_BIOMES.length - 1);
}

export function biomeOfRegion(regionId: number): BiomeId {
  return regionId === SUMMIT_REGION_ID ? 'summit' : (OUTER_BIOMES[regionId] as BiomeId);
}

/** Weighted traversal cost of an edge for a given config. */
export function edgeCost(edge: MazeEdge, cfg: Pick<MazeConfig, 'kindCost'>): number {
  return edge.length * cfg.kindCost[edge.kind];
}

// ---------------------------------------------------------------------------

function generateAttempt(seed: number, attempt: number, cfg: MazeConfig, rng: Rng): Maze | null {
  const layout: MazeLayout = {
    sectorOffset: rng.fork('layout').range(0, Math.PI * 2),
    spawnOffset: rng.fork('spawn-offset').range(0, Math.PI * 2),
    terrainSeed: rng.fork('terrain').nextU32(),
  };
  const height = createBaseHeight(layout.terrainSeed, cfg);

  // 1. Junctions
  const points = poissonDisc(rng.fork('poisson'), cfg.mapRadius - cfg.nodeSpacing * 0.6, cfg.nodeSpacing);

  // 2. Candidate trails
  const candidates = gabrielEdges(points, cfg.nodeSpacing * 2.2);

  // 3. Spanning tree
  const treeRng = rng.fork('tree');
  const order = candidates.map((c, i) => ({ i, w: treeRng.next() * (0.6 + 0.4 * (c.len / (cfg.nodeSpacing * 2))) }));
  order.sort((p, q) => p.w - q.w || p.i - q.i);
  const ds = new DisjointSet(points.length);
  const inTree = new Uint8Array(candidates.length);
  let treeCount = 0;
  for (const { i } of order) {
    const c = candidates[i] as Candidate;
    if (ds.union(c.a, c.b)) {
      inTree[i] = 1;
      treeCount++;
    }
  }
  if (treeCount !== points.length - 1) return null; // candidate graph was disconnected

  // 4. Loops
  const treeEdges = candidates.filter((_, i) => inTree[i]);
  const degree = new Int32Array(points.length);
  for (const c of treeEdges) {
    degree[c.a] = (degree[c.a] as number) + 1;
    degree[c.b] = (degree[c.b] as number) + 1;
  }
  const loopEdges = pickLoops(candidates.filter((_, i) => !inTree[i]), treeEdges, degree, points.length, cfg, rng.fork('loops'));

  // 5. Nodes + classified edges
  const nodes: MazeNode[] = points.map((p, id) => ({
    id,
    x: p.x,
    y: height(p.x, p.z),
    z: p.z,
    regionId: regionAt(p.x, p.z, layout, cfg),
    edges: [],
    isDeadEnd: false,
    spawnIndex: -1,
    isExit: id === 0,
    cache: null,
    costToExit: Infinity,
  }));
  const edges: MazeEdge[] = [];
  const addEdge = (c: Candidate, isLoop: boolean): void => {
    const na = nodes[c.a] as MazeNode;
    const nb = nodes[c.b] as MazeNode;
    const run = c.len;
    const rise = Math.abs(na.y - nb.y);
    const slope = rise / run;
    const kind: EdgeKind = slope >= cfg.grappleSlope ? 'grapple' : slope >= cfg.climbSlope ? 'climb' : 'path';
    const e: MazeEdge = { id: edges.length, a: c.a, b: c.b, kind, length: Math.sqrt(run * run + rise * rise), slope, isLoop };
    edges.push(e);
    na.edges.push(e.id);
    nb.edges.push(e.id);
  };
  treeEdges.forEach((c) => addEdge(c, false));
  loopEdges.forEach((c) => addEdge(c, true));

  // 6. Regions
  const regions = buildRegions(nodes, edges);

  // 7. Fair spawns
  const exit = 0;
  const { dist: costs } = dijkstra(nodes.length, edges, exit, (e) => edgeCost(e, cfg));
  nodes.forEach((n) => (n.costToExit = costs[n.id] as number));
  const spawnPick = pickSpawns(nodes, layout, cfg);
  if (!spawnPick) return null;
  spawnPick.spawns.forEach((nodeId, i) => ((nodes[nodeId] as MazeNode).spawnIndex = i));

  // 8. Dead ends + caches
  const cacheRng = rng.fork('caches');
  let caches = 0;
  for (const n of nodes) {
    n.isDeadEnd = n.edges.length === 1;
    if (n.isDeadEnd && n.spawnIndex < 0 && !n.isExit) {
      const tier = Math.min(TOOL_TIERS.length - 1, Math.floor((deadEndBranchLength(n.id, nodes, edges) - 1) / 2));
      n.cache = cacheRng.pick(TOOL_TIERS[tier] as readonly ToolKind[]);
      caches++;
    }
  }

  const edgeKinds: Record<EdgeKind, number> = { path: 0, climb: 0, grapple: 0 };
  edges.forEach((e) => edgeKinds[e.kind]++);
  const stats: MazeStats = {
    nodes: nodes.length,
    edges: edges.length,
    treeEdges: treeEdges.length,
    loopEdges: loopEdges.length,
    deadEnds: nodes.filter((n) => n.isDeadEnd).length,
    caches,
    edgeKinds,
    fairnessSpread: spawnPick.spread,
    minSpawnCost: spawnPick.min,
    maxSpawnCost: spawnPick.max,
    attempt,
  };

  return { seed, nodes, edges, regions, spawns: spawnPick.spawns, exit, layout, stats };
}

// --- 1. Poisson disc (Bridson) inside a disc --------------------------------

function poissonDisc(rng: Rng, radius: number, minDist: number, tries = 30): P2[] {
  const cell = minDist / Math.SQRT2;
  const gridSize = Math.ceil((radius * 2) / cell) + 1;
  const grid = new Int32Array(gridSize * gridSize).fill(-1);
  const points: P2[] = [];
  const active: number[] = [];
  const gi = (p: P2): [number, number] => [Math.floor((p.x + radius) / cell), Math.floor((p.z + radius) / cell)];
  const add = (p: P2): void => {
    const [cx, cz] = gi(p);
    grid[cz * gridSize + cx] = points.length;
    active.push(points.length);
    points.push(p);
  };
  const fits = (p: P2): boolean => {
    if (p.x * p.x + p.z * p.z > radius * radius) return false;
    const [cx, cz] = gi(p);
    for (let z = Math.max(0, cz - 2); z <= Math.min(gridSize - 1, cz + 2); z++) {
      for (let x = Math.max(0, cx - 2); x <= Math.min(gridSize - 1, cx + 2); x++) {
        const idx = grid[z * gridSize + x] as number;
        if (idx >= 0 && dist(points[idx] as P2, p) < minDist) return false;
      }
    }
    return true;
  };

  add({ x: 0, z: 0 }); // summit / exit is always node 0
  while (active.length > 0) {
    const ai = rng.int(0, active.length);
    const base = points[active[ai] as number] as P2;
    let placed = false;
    for (let k = 0; k < tries; k++) {
      const ang = rng.range(0, Math.PI * 2);
      const r = minDist * (1 + rng.next());
      const p = { x: base.x + Math.cos(ang) * r, z: base.z + Math.sin(ang) * r };
      if (fits(p)) {
        add(p);
        placed = true;
        break;
      }
    }
    if (!placed) {
      active[ai] = active[active.length - 1] as number;
      active.pop();
    }
  }
  return points;
}

// --- 2. Gabriel graph -------------------------------------------------------

interface Candidate {
  a: number;
  b: number;
  len: number;
}

/**
 * Gabriel graph: keep edge ab iff no other point lies inside the circle with
 * diameter ab. It is planar (no crossing trails) and contains the MST, so it
 * is connected for well-spaced points.
 */
function gabrielEdges(points: readonly P2[], maxLen: number): Candidate[] {
  const grid = new SpatialGrid(maxLen / 2, points);
  const out: Candidate[] = [];
  for (let a = 0; a < points.length; a++) {
    const pa = points[a] as P2;
    for (const b of grid.query(pa.x, pa.z, maxLen)) {
      if (b <= a) continue;
      const pb = points[b] as P2;
      const mx = (pa.x + pb.x) / 2;
      const mz = (pa.z + pb.z) / 2;
      const len = dist(pa, pb);
      const r = len / 2;
      const blocked = grid.query(mx, mz, r).some((k) => {
        if (k === a || k === b) return false;
        const pk = points[k] as P2;
        return (pk.x - mx) ** 2 + (pk.z - mz) ** 2 < r * r - 1e-6;
      });
      if (!blocked) out.push({ a, b, len });
    }
  }
  return out;
}

// --- 4. Loops ---------------------------------------------------------------

function pickLoops(nonTree: Candidate[], tree: readonly Candidate[], degree: Int32Array, nodeCount: number, cfg: MazeConfig, rng: Rng): Candidate[] {
  const treeAdj = buildAdjacency(
    nodeCount,
    tree.map((c, id) => ({ id, a: c.a, b: c.b, kind: 'path', length: c.len, slope: 0, isLoop: false })),
  );
  const hopCache = new Map<number, Int32Array>();
  const hopsBetween = (a: number, b: number): number => {
    let h = hopCache.get(a);
    if (!h) {
      h = bfsHops(treeAdj, a);
      hopCache.set(a, h);
    }
    return h[b] as number;
  };

  const target = Math.round(tree.length * cfg.loopRatio);
  const pool = rng.shuffle(nonTree.filter((c) => c.a !== 0 && c.b !== 0 && hopsBetween(c.a, c.b) >= cfg.minLoopHops));
  const chosen: Candidate[] = [];
  for (const c of pool) {
    if (chosen.length >= target) break;
    if ((degree[c.a] as number) >= cfg.maxDegree || (degree[c.b] as number) >= cfg.maxDegree) continue;
    degree[c.a] = (degree[c.a] as number) + 1;
    degree[c.b] = (degree[c.b] as number) + 1;
    chosen.push(c);
  }
  return chosen;
}

// --- 6. Regions -------------------------------------------------------------

function buildRegions(nodes: readonly MazeNode[], edges: readonly MazeEdge[]): MazeRegion[] {
  const count = OUTER_BIOMES.length + 1;
  const regions: MazeRegion[] = Array.from({ length: count }, (_, id) => {
    const biome = biomeOfRegion(id);
    return { id, biome, name: BIOME_NAMES[biome], nodeIds: [], neighbors: [], centerX: 0, centerZ: 0 };
  });
  for (const n of nodes) {
    const r = regions[n.regionId] as MazeRegion;
    r.nodeIds.push(n.id);
    r.centerX += n.x;
    r.centerZ += n.z;
  }
  const adjacent = Array.from({ length: count }, () => new Set<number>());
  for (const e of edges) {
    const ra = (nodes[e.a] as MazeNode).regionId;
    const rb = (nodes[e.b] as MazeNode).regionId;
    if (ra !== rb) {
      (adjacent[ra] as Set<number>).add(rb);
      (adjacent[rb] as Set<number>).add(ra);
    }
  }
  for (const r of regions) {
    if (r.nodeIds.length > 0) {
      r.centerX /= r.nodeIds.length;
      r.centerZ /= r.nodeIds.length;
    }
    r.neighbors = [...(adjacent[r.id] as Set<number>)].sort((a, b) => a - b);
  }
  return regions;
}

// --- 7. Spawns --------------------------------------------------------------

interface SpawnPick {
  spawns: number[];
  spread: number;
  min: number;
  max: number;
}

interface SpawnCandidate {
  sector: number;
  cost: number;
  id: number;
  x: number;
  z: number;
}

/**
 * Choose one spawn per angular sector so that travel costs to the exit are as
 * equal as possible, subject to a hard minimum distance between spawns.
 *
 * Covering windows over the cost-sorted candidates are tried from narrowest
 * cost range upwards; inside a window a small backtracking search finds one
 * candidate per sector that respects the separation. The first success is the
 * fairest valid layout.
 */
function pickSpawns(nodes: readonly MazeNode[], layout: MazeLayout, cfg: MazeConfig): SpawnPick | null {
  const n = cfg.spawnCount;
  const sectorWidth = (Math.PI * 2) / n;
  const ringMin = cfg.mapRadius * cfg.spawnRingMin;
  const all: SpawnCandidate[] = [];
  for (const node of nodes) {
    if (node.isExit || !Number.isFinite(node.costToExit)) continue;
    if (node.x * node.x + node.z * node.z < ringMin * ringMin) continue;
    const sector = Math.min(n - 1, Math.floor(angleFrom(node.x, node.z, layout.spawnOffset) / sectorWidth));
    all.push({ sector, cost: node.costToExit, id: node.id, x: node.x, z: node.z });
  }
  all.sort((p, q) => p.cost - q.cost || p.id - q.id);

  // Every [lo, hi] window that contains at least one candidate of each sector.
  const windows: Array<{ lo: number; hi: number; range: number }> = [];
  for (let lo = 0; lo < all.length; lo++) {
    const seen = new Uint8Array(n);
    let covered = 0;
    for (let hi = lo; hi < all.length; hi++) {
      const s = (all[hi] as SpawnCandidate).sector;
      if (seen[s] === 0) {
        seen[s] = 1;
        covered++;
      }
      if (covered === n) windows.push({ lo, hi, range: (all[hi] as SpawnCandidate).cost - (all[lo] as SpawnCandidate).cost });
    }
  }
  if (windows.length === 0) return null;
  windows.sort((p, q) => p.range - q.range || p.lo - q.lo);

  const minSep2 = cfg.minSpawnSeparation * cfg.minSpawnSeparation;
  const MAX_WINDOWS = 600;
  for (const w of windows.slice(0, MAX_WINDOWS)) {
    const inWindow = all.slice(w.lo, w.hi + 1);
    const centre = ((all[w.lo] as SpawnCandidate).cost + (all[w.hi] as SpawnCandidate).cost) / 2;
    const groups: SpawnCandidate[][] = Array.from({ length: n }, () => []);
    for (const c of inWindow) (groups[c.sector] as SpawnCandidate[]).push(c);
    for (const g of groups) g.sort((p, q) => Math.abs(p.cost - centre) - Math.abs(q.cost - centre) || p.id - q.id);

    const chosen: SpawnCandidate[] = [];
    const search = (s: number): boolean => {
      if (s === n) return true;
      for (const c of groups[s] as SpawnCandidate[]) {
        if (chosen.some((p) => (p.x - c.x) ** 2 + (p.z - c.z) ** 2 < minSep2)) continue;
        chosen.push(c);
        if (search(s + 1)) return true;
        chosen.pop();
      }
      return false;
    };
    if (!search(0)) continue;

    const costs = chosen.map((c) => c.cost);
    const min = Math.min(...costs);
    const max = Math.max(...costs);
    const mean = costs.reduce((a, b) => a + b, 0) / costs.length;
    return { spawns: chosen.map((c) => c.id), spread: (max - min) / mean, min, max };
  }
  return null;
}

// --- 8. Dead-end branch length ----------------------------------------------

/** Hops from a dead end back to the first junction (degree >= 3). */
function deadEndBranchLength(start: number, nodes: readonly MazeNode[], edges: readonly MazeEdge[]): number {
  let prev = -1;
  let cur = start;
  let hops = 0;
  for (;;) {
    const n = nodes[cur] as MazeNode;
    if (hops > 0 && (n.edges.length >= 3 || n.isExit || n.spawnIndex >= 0)) return hops;
    const next = n.edges.map((eid) => edges[eid] as MazeEdge).map((e) => (e.a === cur ? e.b : e.a)).find((v) => v !== prev);
    if (next === undefined) return hops;
    prev = cur;
    cur = next;
    hops++;
    if (hops > nodes.length) return hops;
  }
}

/** True if no two edges cross (used by tests and debug validation). */
export function isPlanar(maze: Pick<Maze, 'nodes' | 'edges'>): boolean {
  const { nodes, edges } = maze;
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i] as MazeEdge;
    for (let j = i + 1; j < edges.length; j++) {
      const f = edges[j] as MazeEdge;
      if (e.a === f.a || e.a === f.b || e.b === f.a || e.b === f.b) continue;
      if (segmentsCross(nodes[e.a] as MazeNode, nodes[e.b] as MazeNode, nodes[f.a] as MazeNode, nodes[f.b] as MazeNode)) return false;
    }
  }
  return true;
}
