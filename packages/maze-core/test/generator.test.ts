import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONFIG,
  SUMMIT_REGION_ID,
  buildAdjacency,
  buildField,
  generateMaze,
  heightAt,
  isConnected,
  isPlanar,
  isWalkable,
  mazeChecksum,
  regionAt,
  shortestPath,
  edgeCost,
  type Maze,
} from '../src/index.ts';

const SEEDS = Array.from({ length: 60 }, (_, i) => i * 7919 + 1);
const mazes = new Map<number, Maze>(SEEDS.map((s) => [s, generateMaze(s)]));
const each = (fn: (maze: Maze, seed: number) => void): void => mazes.forEach((m, s) => fn(m, s));

describe('determinism', () => {
  it('same seed produces an identical maze', () => {
    for (const seed of SEEDS.slice(0, 10)) {
      const a = generateMaze(seed);
      const b = generateMaze(seed);
      expect(mazeChecksum(a)).toBe(mazeChecksum(b));
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    }
  });

  it('different seeds produce different mazes', () => {
    const sums = new Set(SEEDS.map((s) => mazeChecksum(mazes.get(s) as Maze)));
    expect(sums.size).toBe(SEEDS.length);
  });

  it('config overrides change the result', () => {
    expect(mazeChecksum(generateMaze(5, { loopRatio: 0.05 }))).not.toBe(mazeChecksum(generateMaze(5)));
  });
});

describe('topology', () => {
  it('is fully connected', () => each((m) => expect(isConnected(m)).toBe(true)));

  it('has no crossing trails (planar)', () => each((m) => expect(isPlanar(m)).toBe(true)));

  it('has a sensible size', () =>
    each((m) => {
      expect(m.stats.nodes).toBeGreaterThan(90);
      expect(m.stats.nodes).toBeLessThan(170);
      expect(m.stats.treeEdges).toBe(m.stats.nodes - 1);
    }));

  it('adds loops so no single chokepoint decides the race', () =>
    each((m) => {
      expect(m.stats.loopEdges).toBeGreaterThanOrEqual(Math.round(m.stats.treeEdges * DEFAULT_CONFIG.loopRatio * 0.7));
      expect(m.edges.filter((e) => e.isLoop).length).toBe(m.stats.loopEdges);
    }));

  it('respects max junction degree for loop endpoints', () =>
    each((m) => {
      for (const e of m.edges.filter((x) => x.isLoop)) {
        expect(m.nodes[e.a]?.edges.length).toBeLessThanOrEqual(DEFAULT_CONFIG.maxDegree);
        expect(m.nodes[e.b]?.edges.length).toBeLessThanOrEqual(DEFAULT_CONFIG.maxDegree);
      }
    }));

  it('edge references are consistent', () =>
    each((m) => {
      m.edges.forEach((e, i) => {
        expect(e.id).toBe(i);
        expect(m.nodes[e.a]?.edges).toContain(e.id);
        expect(m.nodes[e.b]?.edges).toContain(e.id);
      });
    }));
});

describe('exit and spawns', () => {
  it('exit is node 0 on the summit, at the highest junction', () =>
    each((m) => {
      const exit = m.nodes[m.exit];
      expect(m.exit).toBe(0);
      expect(exit?.isExit).toBe(true);
      expect(exit?.regionId).toBe(SUMMIT_REGION_ID);
      const maxY = Math.max(...m.nodes.map((n) => n.y));
      expect(exit?.y).toBeGreaterThanOrEqual(maxY - 1);
    }));

  it('places 8 distinct spawns on the outer ring', () =>
    each((m) => {
      expect(m.spawns).toHaveLength(8);
      expect(new Set(m.spawns).size).toBe(8);
      for (const [i, id] of m.spawns.entries()) {
        const n = m.nodes[id];
        expect(n?.spawnIndex).toBe(i);
        expect(Math.hypot(n?.x ?? 0, n?.z ?? 0)).toBeGreaterThanOrEqual(DEFAULT_CONFIG.mapRadius * DEFAULT_CONFIG.spawnRingMin - 1e-6);
      }
    }));

  it('spawns are fair: travel cost to exit within ~10%', () =>
    each((m) => {
      expect(m.stats.fairnessSpread).toBeLessThanOrEqual(0.1);
      const costs = m.spawns.map((id) => m.nodes[id]?.costToExit ?? Infinity);
      expect(Math.max(...costs) - Math.min(...costs)).toBeCloseTo(m.stats.maxSpawnCost - m.stats.minSpawnCost, 6);
    }));

  it('most seeds hit the 8% fairness target', () => {
    const ok = [...mazes.values()].filter((m) => m.stats.fairnessSpread <= DEFAULT_CONFIG.fairnessTolerance).length;
    expect(ok / mazes.size).toBeGreaterThanOrEqual(0.95);
  });

  it('spawns are spread around the mountain (min separation)', () =>
    each((m) => {
      for (let i = 0; i < m.spawns.length; i++) {
        for (let j = i + 1; j < m.spawns.length; j++) {
          const a = m.nodes[m.spawns[i] as number];
          const b = m.nodes[m.spawns[j] as number];
          expect(Math.hypot((a?.x ?? 0) - (b?.x ?? 0), (a?.z ?? 0) - (b?.z ?? 0))).toBeGreaterThanOrEqual(DEFAULT_CONFIG.minSpawnSeparation);
        }
      }
    }));

  it('every spawn has a real route to the exit', () =>
    each((m) => {
      for (const s of m.spawns) {
        const path = shortestPath(m, s, m.exit, (e) => edgeCost(e, DEFAULT_CONFIG));
        expect(path[0]).toBe(s);
        expect(path[path.length - 1]).toBe(m.exit);
      }
    }));
});

describe('regions, edges, caches', () => {
  it('has 4 outer biomes + summit, all populated, and summit touches the outer ring', () =>
    each((m) => {
      expect(m.regions.map((r) => r.biome)).toEqual(['bamboo', 'maple', 'shrine', 'marsh', 'summit']);
      for (const r of m.regions) expect(r.nodeIds.length).toBeGreaterThan(0);
      expect(m.regions[SUMMIT_REGION_ID]?.neighbors.length).toBeGreaterThanOrEqual(2);
      for (const n of m.nodes) expect(regionAt(n.x, n.z, m.layout, DEFAULT_CONFIG)).toBe(n.regionId);
    }));

  it('region adjacency is symmetric', () =>
    each((m) => {
      for (const r of m.regions) for (const nb of r.neighbors) expect(m.regions[nb]?.neighbors).toContain(r.id);
    }));

  it('classifies edges by slope', () =>
    each((m) => {
      for (const e of m.edges) {
        if (e.kind === 'grapple') expect(e.slope).toBeGreaterThanOrEqual(DEFAULT_CONFIG.grappleSlope);
        else if (e.kind === 'climb') expect(e.slope).toBeGreaterThanOrEqual(DEFAULT_CONFIG.climbSlope);
        else expect(e.slope).toBeLessThan(DEFAULT_CONFIG.climbSlope);
      }
    }));

  it('produces a mix of traversal kinds across seeds', () => {
    const totals = { path: 0, climb: 0, grapple: 0 };
    mazes.forEach((m) => {
      totals.path += m.stats.edgeKinds.path;
      totals.climb += m.stats.edgeKinds.climb;
      totals.grapple += m.stats.edgeKinds.grapple;
    });
    const sum = totals.path + totals.climb + totals.grapple;
    expect(totals.path / sum).toBeGreaterThan(0.55);
    expect(totals.climb / sum).toBeGreaterThan(0.08);
    expect(totals.grapple / sum).toBeGreaterThan(0.02);
  });

  it('caches only on dead ends that are not spawns/exit', () =>
    each((m) => {
      for (const n of m.nodes) {
        expect(n.isDeadEnd).toBe(n.edges.length === 1);
        if (n.cache) {
          expect(n.isDeadEnd).toBe(true);
          expect(n.spawnIndex).toBe(-1);
          expect(n.isExit).toBe(false);
        }
      }
      expect(m.stats.caches).toBeGreaterThan(10);
    }));
});

describe('walk field', () => {
  const maze = mazes.get(SEEDS[0] as number) as Maze;
  const field = buildField(maze);

  it('every junction and trail midpoint is walkable', () => {
    for (const n of maze.nodes) expect(isWalkable(field, n.x, n.z)).toBe(true);
    for (const e of maze.edges) {
      const a = maze.nodes[e.a];
      const b = maze.nodes[e.b];
      expect(isWalkable(field, ((a?.x ?? 0) + (b?.x ?? 0)) / 2, ((a?.z ?? 0) + (b?.z ?? 0)) / 2)).toBe(true);
    }
  });

  it('trail height matches junction height', () => {
    for (const n of maze.nodes) expect(Math.abs(heightAt(field, n.x, n.z) - n.y)).toBeLessThan(1.5);
  });

  it('outside the map is wall', () => {
    expect(isWalkable(field, DEFAULT_CONFIG.mapRadius + 15, 0)).toBe(false);
  });

  it('most of the map is forest wall, not open ground', () => {
    let open = 0;
    let total = 0;
    for (let k = 0; k < field.clearance.length; k++) {
      total++;
      if ((field.clearance[k] as number) <= 0) open++;
    }
    expect(open / total).toBeGreaterThan(0.05);
    expect(open / total).toBeLessThan(0.45);
  });
});

describe('performance', () => {
  it('generates within budget', () => {
    const t0 = performance.now();
    for (let s = 1000; s < 1020; s++) generateMaze(s);
    const avg = (performance.now() - t0) / 20;
    expect(avg).toBeLessThan(80);
  });

  it('adjacency helper matches node edge lists', () => {
    const m = mazes.get(SEEDS[1] as number) as Maze;
    const adj = buildAdjacency(m.nodes.length, m.edges);
    m.nodes.forEach((n) => expect(adj[n.id]?.length).toBe(n.edges.length));
  });
});
