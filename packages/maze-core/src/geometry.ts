/** Small 2D geometry helpers on the X/Z ground plane. */

export interface P2 {
  x: number;
  z: number;
}

export function dist2(a: P2, b: P2): number {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return dx * dx + dz * dz;
}

export function dist(a: P2, b: P2): number {
  return Math.sqrt(dist2(a, b));
}

/** Closest-point parameter t in [0,1] of p on segment ab, and the distance. */
export function pointSegment(px: number, pz: number, ax: number, az: number, bx: number, bz: number): { t: number; d: number } {
  const abx = bx - ax;
  const abz = bz - az;
  const len2 = abx * abx + abz * abz;
  let t = len2 > 0 ? ((px - ax) * abx + (pz - az) * abz) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const cx = ax + abx * t - px;
  const cz = az + abz * t - pz;
  return { t, d: Math.sqrt(cx * cx + cz * cz) };
}

function orient(a: P2, b: P2, c: P2): number {
  return (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x);
}

/**
 * True if segments ab and cd properly cross. Segments that only share an
 * endpoint (graph edges meeting at a node) do not count as crossing.
 */
export function segmentsCross(a: P2, b: P2, c: P2, d: P2): boolean {
  const eps = 1e-9;
  const o1 = orient(a, b, c);
  const o2 = orient(a, b, d);
  const o3 = orient(c, d, a);
  const o4 = orient(c, d, b);
  return ((o1 > eps && o2 < -eps) || (o1 < -eps && o2 > eps)) && ((o3 > eps && o4 < -eps) || (o3 < -eps && o4 > eps));
}

/** Angle of (x,z) normalised to [0, 2π) after subtracting `offset`. */
export function angleFrom(x: number, z: number, offset: number): number {
  const tau = Math.PI * 2;
  let a = Math.atan2(z, x) - offset;
  a %= tau;
  if (a < 0) a += tau;
  return a;
}

/** Uniform grid for neighbour queries over points. */
export class SpatialGrid {
  private readonly cells = new Map<number, number[]>();
  private readonly cellSize: number;
  private readonly points: readonly P2[];

  constructor(cellSize: number, points: readonly P2[]) {
    this.cellSize = cellSize;
    this.points = points;
    points.forEach((p, i) => this.insert(i, p));
  }

  private key(cx: number, cz: number): number {
    return (cx + 32768) * 65536 + (cz + 32768);
  }

  insert(index: number, p: P2): void {
    const k = this.key(Math.floor(p.x / this.cellSize), Math.floor(p.z / this.cellSize));
    const bucket = this.cells.get(k);
    if (bucket) bucket.push(index);
    else this.cells.set(k, [index]);
  }

  /** Indices of points within `radius` of (x,z). */
  query(x: number, z: number, radius: number): number[] {
    const out: number[] = [];
    const r2 = radius * radius;
    const minX = Math.floor((x - radius) / this.cellSize);
    const maxX = Math.floor((x + radius) / this.cellSize);
    const minZ = Math.floor((z - radius) / this.cellSize);
    const maxZ = Math.floor((z + radius) / this.cellSize);
    for (let cx = minX; cx <= maxX; cx++) {
      for (let cz = minZ; cz <= maxZ; cz++) {
        const bucket = this.cells.get(this.key(cx, cz));
        if (!bucket) continue;
        for (const i of bucket) {
          const p = this.points[i] as P2;
          const dx = p.x - x;
          const dz = p.z - z;
          if (dx * dx + dz * dz <= r2) out.push(i);
        }
      }
    }
    return out;
  }
}
