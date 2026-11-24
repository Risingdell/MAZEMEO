/**
 * Botanical leaf painters for canvas textures.
 *
 * All leaves are drawn with the petiole (stem) joint at (0,0) and the blade
 * extending towards -y, so callers translate/rotate to place them. Each leaf
 * gets a shaded blade (lighter centre, darker margin), serrated edges,
 * a midrib + side veins and a stem.
 */

export type RGB = [number, number, number];

const rgb = (c: RGB, k = 1, a = 1): string => `rgba(${Math.round(c[0] * k)},${Math.round(c[1] * k)},${Math.round(c[2] * k)},${a})`;

interface Pt {
  x: number;
  y: number;
}

/** Saw-tooth offset used for serrated margins. */
function tooth(t: number, count: number, depth: number): number {
  const f = (t * count) % 1;
  return f < 0.7 ? (f / 0.7) * depth : depth * (1 - (f - 0.7) / 0.3);
}

/** One lanceolate lobe from `start` along angle `a`, as left + right edge point lists. */
function lobeEdges(start: Pt, a: number, len: number, width: number, teeth: number, toothDepth: number, rand: () => number): { left: Pt[]; right: Pt[]; tip: Pt } {
  const dx = Math.cos(a);
  const dy = Math.sin(a);
  const px = -dy;
  const py = dx;
  const left: Pt[] = [];
  const right: Pt[] = [];
  const steps = 18;
  const asym = 0.9 + rand() * 0.2;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    // Widest at ~35%, long acuminate tip.
    const w = width * Math.sin(Math.PI * Math.min(1, t * 1.25) ** 0.85) ** 1.2 * (1 - t * 0.25);
    const serr = t > 0.15 && t < 0.97 ? tooth(t, teeth, toothDepth * width) : 0;
    const cx = start.x + dx * len * t;
    const cy = start.y + dy * len * t;
    left.push({ x: cx + px * (w + serr) * asym, y: cy + py * (w + serr) * asym });
    right.push({ x: cx - px * (w + serr), y: cy - py * (w + serr) });
  }
  return { left, right, tip: { x: start.x + dx * len, y: start.y + dy * len } };
}

function shadeBlade(ctx: CanvasRenderingContext2D, size: number, base: RGB): void {
  const g = ctx.createRadialGradient(0, -size * 0.35, size * 0.05, 0, -size * 0.35, size * 0.75);
  g.addColorStop(0, rgb(base, 1.08));
  g.addColorStop(0.6, rgb(base, 0.97));
  g.addColorStop(1, rgb(base, 0.78));
  ctx.fillStyle = g;
  ctx.fill();
  // Thin darker rim for definition.
  ctx.strokeStyle = rgb(base, 0.6, 0.55);
  ctx.lineWidth = Math.max(0.6, size * 0.012);
  ctx.stroke();
}

function vein(ctx: CanvasRenderingContext2D, from: Pt, to: Pt, width: number, color: string, bend = 0): void {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  const mx = (from.x + to.x) / 2 + (to.y - from.y) * bend;
  const my = (from.y + to.y) / 2 - (to.x - from.x) * bend;
  ctx.quadraticCurveTo(mx, my, to.x, to.y);
  ctx.stroke();
}

function petiole(ctx: CanvasRenderingContext2D, size: number, base: RGB, length: number): void {
  vein(ctx, { x: 0, y: 0 }, { x: size * 0.04, y: length }, Math.max(1, size * 0.028), rgb(base, 0.62), 0.15);
}

/**
 * Palmate (Japanese-maple style) leaf: 5–7 deeply cut, serrated, pointed lobes.
 * @param size overall radius in px
 */
export function palmateLeaf(ctx: CanvasRenderingContext2D, size: number, base: RGB, rand: () => number, lobes = 7): void {
  const sinus = size * 0.17;
  const spread = (lobes === 7 ? 250 : 200) * (Math.PI / 180);
  const centre = { x: 0, y: -size * 0.08 };
  const edges: Array<ReturnType<typeof lobeEdges>> = [];
  for (let i = 0; i < lobes; i++) {
    const f = lobes === 1 ? 0 : i / (lobes - 1) - 0.5; // -0.5..0.5
    const a = -Math.PI / 2 + f * spread + (rand() - 0.5) * 0.08;
    const len = size * (1 - Math.abs(f) ** 1.6 * 0.95) * (0.92 + rand() * 0.12);
    const start = { x: centre.x + Math.cos(a) * sinus * 0.4, y: centre.y + Math.sin(a) * sinus * 0.4 };
    edges.push(lobeEdges(start, a, len, len * 0.2, 9 + Math.floor(rand() * 4), 0.22, rand));
  }
  // Outline: walk lobes from one side to the other, joining at the sinuses near the centre.
  ctx.beginPath();
  edges.forEach((e, i) => {
    const pts = [...e.right, ...e.left.slice().reverse()];
    pts.forEach((p, j) => (i === 0 && j === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
    // Sinus between this lobe and the next.
    if (i < edges.length - 1) {
      const nextA = Math.atan2(edges[i + 1]!.tip.y - centre.y, edges[i + 1]!.tip.x - centre.x);
      const thisA = Math.atan2(e.tip.y - centre.y, e.tip.x - centre.x);
      const mid = (thisA + nextA) / 2;
      ctx.lineTo(centre.x + Math.cos(mid) * sinus, centre.y + Math.sin(mid) * sinus);
    }
  });
  ctx.lineTo(centre.x, centre.y + size * 0.05);
  ctx.closePath();
  shadeBlade(ctx, size, base);
  // Veins: one per lobe, radiating from the centre, with faint side veins.
  for (const e of edges) {
    vein(ctx, centre, e.tip, Math.max(0.7, size * 0.018), rgb(base, 1.18, 0.7), 0.02);
    const n = 4;
    for (let k = 1; k <= n; k++) {
      const t = k / (n + 1);
      const p = { x: centre.x + (e.tip.x - centre.x) * t, y: centre.y + (e.tip.y - centre.y) * t };
      const li = Math.min(e.left.length - 1, Math.round(t * (e.left.length - 1)) + 2);
      const l = e.left[li]!;
      const r = e.right[li]!;
      vein(ctx, p, { x: (p.x + l.x) / 2, y: (p.y + l.y) / 2 }, Math.max(0.4, size * 0.007), rgb(base, 1.12, 0.45));
      vein(ctx, p, { x: (p.x + r.x) / 2, y: (p.y + r.y) / 2 }, Math.max(0.4, size * 0.007), rgb(base, 1.12, 0.45));
    }
  }
  petiole(ctx, size, base, size * 0.55);
}

/** Ovate broadleaf with toothed margin, midrib and pinnate side veins. */
export function ovateLeaf(ctx: CanvasRenderingContext2D, size: number, base: RGB, rand: () => number): void {
  const len = size * 1.6;
  const e = lobeEdges({ x: 0, y: -size * 0.05 }, -Math.PI / 2, len, size * 0.42, 22, 0.06, rand);
  ctx.beginPath();
  [...e.right, ...e.left.slice().reverse()].forEach((p, j) => (j === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
  ctx.closePath();
  shadeBlade(ctx, len * 0.7, base);
  vein(ctx, { x: 0, y: -size * 0.05 }, e.tip, Math.max(0.8, size * 0.03), rgb(base, 1.18, 0.75), 0.03);
  for (let k = 1; k <= 7; k++) {
    const t = k / 8.5;
    const p = { x: 0, y: -size * 0.05 - len * t };
    const li = Math.min(e.left.length - 1, Math.round((t + 0.12) * (e.left.length - 1)));
    vein(ctx, p, e.left[li]!, Math.max(0.5, size * 0.012), rgb(base, 1.12, 0.5), 0.12);
    vein(ctx, p, e.right[li]!, Math.max(0.5, size * 0.012), rgb(base, 1.12, 0.5), -0.12);
  }
  petiole(ctx, size, base, size * 0.3);
}

/** Long narrow bamboo leaf with parallel veins. */
export function lanceLeaf(ctx: CanvasRenderingContext2D, size: number, base: RGB, rand: () => number): void {
  const len = size * 2.2;
  const e = lobeEdges({ x: 0, y: -size * 0.03 }, -Math.PI / 2 + (rand() - 0.5) * 0.1, len, size * 0.17, 1, 0, rand);
  ctx.beginPath();
  [...e.right, ...e.left.slice().reverse()].forEach((p, j) => (j === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
  ctx.closePath();
  shadeBlade(ctx, len * 0.6, base);
  vein(ctx, { x: 0, y: -size * 0.03 }, e.tip, Math.max(0.6, size * 0.02), rgb(base, 1.15, 0.7));
  for (const off of [-0.45, 0.45]) {
    vein(ctx, { x: off * size * 0.12, y: -size * 0.1 }, { x: e.tip.x + off * 0.5, y: e.tip.y + len * 0.08 }, Math.max(0.3, size * 0.006), rgb(base, 1.1, 0.4));
  }
  petiole(ctx, size, base, size * 0.12);
}

/** A thin woody twig from (0,0) to (x,y). */
export function twig(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, color: RGB): void {
  vein(ctx, { x: 0, y: 0 }, { x, y }, width, rgb(color), 0.08);
}
