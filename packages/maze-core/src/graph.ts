/** Graph algorithms over a Maze (or any node/edge list). */
import type { Maze, MazeEdge } from './types.ts';

/** Minimal binary min-heap keyed by number priority. */
export class MinHeap {
  private readonly keys: number[] = [];
  private readonly prio: number[] = [];

  get size(): number {
    return this.keys.length;
  }

  push(key: number, priority: number): void {
    this.keys.push(key);
    this.prio.push(priority);
    let i = this.keys.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if ((this.prio[p] as number) <= priority) break;
      this.swap(i, p);
      i = p;
    }
  }

  /** Removes and returns the key with the lowest priority. */
  pop(): number {
    const top = this.keys[0] as number;
    const lastK = this.keys.pop() as number;
    const lastP = this.prio.pop() as number;
    if (this.keys.length > 0) {
      this.keys[0] = lastK;
      this.prio[0] = lastP;
      let i = 0;
      const n = this.keys.length;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < n && (this.prio[l] as number) < (this.prio[m] as number)) m = l;
        if (r < n && (this.prio[r] as number) < (this.prio[m] as number)) m = r;
        if (m === i) break;
        this.swap(i, m);
        i = m;
      }
    }
    return top;
  }

  private swap(i: number, j: number): void {
    const k = this.keys[i] as number;
    this.keys[i] = this.keys[j] as number;
    this.keys[j] = k;
    const p = this.prio[i] as number;
    this.prio[i] = this.prio[j] as number;
    this.prio[j] = p;
  }
}

export type EdgeCostFn = (edge: MazeEdge) => number;

/** Adjacency list: for each node, [neighbourId, edgeId] pairs. */
export function buildAdjacency(nodeCount: number, edges: readonly MazeEdge[]): Array<Array<[number, number]>> {
  const adj: Array<Array<[number, number]>> = Array.from({ length: nodeCount }, () => []);
  for (const e of edges) {
    (adj[e.a] as Array<[number, number]>).push([e.b, e.id]);
    (adj[e.b] as Array<[number, number]>).push([e.a, e.id]);
  }
  return adj;
}

/** Single-source shortest path costs. Unreachable nodes get Infinity. */
export function dijkstra(nodeCount: number, edges: readonly MazeEdge[], source: number, cost: EdgeCostFn): { dist: Float64Array; prev: Int32Array } {
  const adj = buildAdjacency(nodeCount, edges);
  const distArr = new Float64Array(nodeCount).fill(Infinity);
  const prev = new Int32Array(nodeCount).fill(-1);
  const heap = new MinHeap();
  distArr[source] = 0;
  heap.push(source, 0);
  const done = new Uint8Array(nodeCount);
  while (heap.size > 0) {
    const u = heap.pop();
    if (done[u]) continue;
    done[u] = 1;
    for (const [v, eid] of adj[u] as Array<[number, number]>) {
      const nd = (distArr[u] as number) + cost(edges[eid] as MazeEdge);
      if (nd < (distArr[v] as number)) {
        distArr[v] = nd;
        prev[v] = u;
        heap.push(v, nd);
      }
    }
  }
  return { dist: distArr, prev };
}

/** Hop counts from `source` via BFS. Unreachable = -1. */
export function bfsHops(adj: ReadonlyArray<ReadonlyArray<readonly [number, number]>>, source: number): Int32Array {
  const hops = new Int32Array(adj.length).fill(-1);
  hops[source] = 0;
  const queue = [source];
  for (let head = 0; head < queue.length; head++) {
    const u = queue[head] as number;
    for (const [v] of adj[u] as ReadonlyArray<readonly [number, number]>) {
      if (hops[v] === -1) {
        hops[v] = (hops[u] as number) + 1;
        queue.push(v);
      }
    }
  }
  return hops;
}

export function isConnected(maze: Pick<Maze, 'nodes' | 'edges'>): boolean {
  if (maze.nodes.length === 0) return true;
  const hops = bfsHops(buildAdjacency(maze.nodes.length, maze.edges), 0);
  return hops.every((h) => h >= 0);
}

/** Node path from `from` to `to` (inclusive) using weighted shortest path. */
export function shortestPath(maze: Pick<Maze, 'nodes' | 'edges'>, from: number, to: number, cost: EdgeCostFn): number[] {
  const { prev, dist: d } = dijkstra(maze.nodes.length, maze.edges, from, cost);
  if (!Number.isFinite(d[to] as number)) return [];
  const path: number[] = [];
  for (let v = to; v !== -1; v = prev[v] as number) path.push(v);
  return path.reverse();
}

/** Union–find with path halving and union by size. */
export class DisjointSet {
  private readonly parent: Int32Array;
  private readonly size: Int32Array;

  constructor(n: number) {
    this.parent = new Int32Array(n);
    this.size = new Int32Array(n).fill(1);
    for (let i = 0; i < n; i++) this.parent[i] = i;
  }

  find(x: number): number {
    while (this.parent[x] !== x) {
      this.parent[x] = this.parent[this.parent[x] as number] as number;
      x = this.parent[x] as number;
    }
    return x;
  }

  union(a: number, b: number): boolean {
    let ra = this.find(a);
    let rb = this.find(b);
    if (ra === rb) return false;
    if ((this.size[ra] as number) < (this.size[rb] as number)) [ra, rb] = [rb, ra];
    this.parent[rb] = ra;
    this.size[ra] = (this.size[ra] as number) + (this.size[rb] as number);
    return true;
  }
}
