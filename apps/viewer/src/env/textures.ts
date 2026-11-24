/**
 * Procedural, tileable textures generated at startup (no downloaded assets).
 *
 * Ground layers are packed into DataArrayTextures so the terrain shader can
 * blend 5 materials with only 2 samplers. Layer order:
 *   0 forest floor (moss)  1 trail dirt  2 rock  3 leaf litter  4 mud
 * Albedo alpha holds height (used for height-based blending).
 */
import * as THREE from 'three';
import { lanceLeaf, ovateLeaf, palmateLeaf, twig, type RGB } from './leafArt.ts';

export interface EnvTextures {
  groundAlbedo: THREE.DataArrayTexture;
  groundNormal: THREE.DataArrayTexture;
  bark: THREE.Texture;
  bamboo: THREE.Texture;
  mapleCard: THREE.Texture;
  bambooCard: THREE.Texture;
  needleCard: THREE.Texture;

  /** 2x2 atlas of single leaves (falling leaves). */
  leafAtlas: THREE.Texture;
  cloth: THREE.Texture;
  granite: THREE.Texture;
  fernCard: THREE.Texture;
  pineBark: THREE.Texture;
  pineNeedles: THREE.Texture;
  leather: THREE.Texture;
  rope: THREE.Texture;
}

// --- tiny deterministic helpers ------------------------------------------------

function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Tileable value-noise fBm in [0,1] over a size x size grid. */
function fbmTile(size: number, basePeriod: number, octaves: number, seed: number, gain = 0.5): Float32Array {
  const out = new Float32Array(size * size);
  const rand = mulberry(seed);
  let amp = 1;
  let norm = 0;
  let period = basePeriod;
  for (let o = 0; o < octaves; o++) {
    const lattice = new Float32Array(period * period);
    for (let i = 0; i < lattice.length; i++) lattice[i] = rand();
    const cell = size / period;
    for (let y = 0; y < size; y++) {
      const fy = y / cell;
      const iy = Math.floor(fy);
      const ty = fy - iy;
      const sy = ty * ty * (3 - 2 * ty);
      const y0 = iy % period;
      const y1 = (iy + 1) % period;
      for (let x = 0; x < size; x++) {
        const fx = x / cell;
        const ix = Math.floor(fx);
        const tx = fx - ix;
        const sx = tx * tx * (3 - 2 * tx);
        const x0 = ix % period;
        const x1 = (ix + 1) % period;
        const a = lattice[y0 * period + x0]!;
        const b = lattice[y0 * period + x1]!;
        const c = lattice[y1 * period + x0]!;
        const d = lattice[y1 * period + x1]!;
        out[y * size + x] = out[y * size + x]! + amp * ((a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy);
      }
    }
    norm += amp;
    amp *= gain;
    period *= 2;
    if (period > size) break;
  }
  for (let i = 0; i < out.length; i++) out[i] = out[i]! / norm;
  return out;
}

const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const clamp255 = (v: number): number => Math.max(0, Math.min(255, Math.round(v)));

/** A colour canvas and a matching height canvas painted in lockstep, with wrap-around drawing. */
class Painter {
  readonly size: number;
  readonly color: CanvasRenderingContext2D;
  readonly height: CanvasRenderingContext2D;

  constructor(size: number) {
    this.size = size;
    const mk = (): CanvasRenderingContext2D => {
      const c = document.createElement('canvas');
      c.width = c.height = size;
      return c.getContext('2d', { willReadFrequently: true })!;
    };
    this.color = mk();
    this.height = mk();
  }

  /** Fill both canvases from per-pixel functions. */
  fill(colorAt: (i: number) => RGB, heightAt: (i: number) => number): void {
    const n = this.size * this.size;
    const c = this.color.createImageData(this.size, this.size);
    const h = this.height.createImageData(this.size, this.size);
    for (let i = 0; i < n; i++) {
      const rgb = colorAt(i);
      c.data[i * 4] = clamp255(rgb[0]);
      c.data[i * 4 + 1] = clamp255(rgb[1]);
      c.data[i * 4 + 2] = clamp255(rgb[2]);
      c.data[i * 4 + 3] = 255;
      const v = clamp255(heightAt(i) * 255);
      h.data[i * 4] = h.data[i * 4 + 1] = h.data[i * 4 + 2] = v;
      h.data[i * 4 + 3] = 255;
    }
    this.color.putImageData(c, 0, 0);
    this.height.putImageData(h, 0, 0);
  }

  /** Draw a shape on both canvases at (x,y) and its wrapped copies so the tile stays seamless. */
  shape(x: number, y: number, reach: number, draw: (ctx: CanvasRenderingContext2D, isHeight: boolean) => void): void {
    const s = this.size;
    for (const ox of [-s, 0, s]) {
      for (const oy of [-s, 0, s]) {
        const px = x + ox;
        const py = y + oy;
        if (px < -reach || px > s + reach || py < -reach || py > s + reach) continue;
        for (const [ctx, isH] of [
          [this.color, false],
          [this.height, true],
        ] as const) {
          ctx.save();
          ctx.translate(px, py);
          draw(ctx, isH);
          ctx.restore();
        }
      }
    }
  }

  rgba(): Uint8ClampedArray {
    const c = this.color.getImageData(0, 0, this.size, this.size).data;
    const h = this.height.getImageData(0, 0, this.size, this.size).data;
    const out = new Uint8ClampedArray(c.length);
    for (let i = 0; i < c.length; i += 4) {
      out[i] = c[i]!;
      out[i + 1] = c[i + 1]!;
      out[i + 2] = c[i + 2]!;
      out[i + 3] = h[i]!; // height in alpha
    }
    return out;
  }

  normals(strength: number): Uint8ClampedArray {
    const s = this.size;
    const h = this.height.getImageData(0, 0, s, s).data;
    const H = (x: number, y: number): number => h[(((y + s) % s) * s + ((x + s) % s)) * 4]! / 255;
    const out = new Uint8ClampedArray(s * s * 4);
    for (let y = 0; y < s; y++) {
      for (let x = 0; x < s; x++) {
        const dx = (H(x + 1, y) - H(x - 1, y)) * strength;
        const dy = (H(x, y + 1) - H(x, y - 1)) * strength;
        const len = Math.hypot(dx, dy, 1);
        const i = (y * s + x) * 4;
        out[i] = clamp255((-dx / len) * 127.5 + 127.5);
        out[i + 1] = clamp255((dy / len) * 127.5 + 127.5);
        out[i + 2] = clamp255((1 / len) * 127.5 + 127.5);
        out[i + 3] = 255;
      }
    }
    return out;
  }
}

// --- ground layers ------------------------------------------------------------

const GROUND_SIZE = 512;

function paintMoss(p: Painter): void {
  const s = p.size;
  const big = fbmTile(s, 4, 5, 11);
  const fine = fbmTile(s, 32, 3, 12);
  const dark: RGB = [44, 52, 28];
  const light: RGB = [96, 98, 52];
  const dry: RGB = [104, 88, 56];
  const dryMask = fbmTile(s, 3, 3, 13);
  p.fill(
    (i) => {
      const t = big[i]! * 0.7 + fine[i]! * 0.3;
      return mix(mix(dark, light, t), dry, Math.max(0, dryMask[i]! - 0.55) * 1.6);
    },
    (i) => big[i]! * 0.5 + fine[i]! * 0.5,
  );
  const r = mulberry(14);
  // Soft, low-contrast fibres so the floor reads as smooth moss under the grass.
  for (let k = 0; k < 900; k++) {
    const x = r() * s;
    const y = r() * s;
    const a = r() * Math.PI * 2;
    const l = 2 + r() * 5;
    const g = 78 + r() * 30;
    p.shape(x, y, 10, (ctx, isH) => {
      ctx.rotate(a);
      ctx.globalAlpha = 0.45;
      ctx.strokeStyle = isH ? 'rgb(170,170,170)' : `rgb(${g * 0.78},${g},${g * 0.5})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.quadraticCurveTo(l * 0.3, -l * 0.5, l * 0.1, -l);
      ctx.stroke();
      ctx.globalAlpha = 1;
    });
  }
}

function paintDirt(p: Painter): void {
  const s = p.size;
  const big = fbmTile(s, 4, 5, 21);
  const grain = fbmTile(s, 128, 2, 22);
  const a: RGB = [104, 82, 58];
  const b: RGB = [146, 122, 90];
  p.fill(
    (i) => {
      const c = mix(a, b, big[i]! * 0.8 + grain[i]! * 0.2);
      const g = (grain[i]! - 0.5) * 30;
      return [c[0] + g, c[1] + g, c[2] + g];
    },
    (i) => big[i]! * 0.35 + grain[i]! * 0.25,
  );
  const r = mulberry(23);
  for (let k = 0; k < 900; k++) {
    const x = r() * s;
    const y = r() * s;
    const rad = 1.2 + r() ** 2.5 * 7;
    const tone = 90 + r() * 90;
    const warm = r() * 20;
    const ang = r() * Math.PI;
    p.shape(x, y, rad + 2, (ctx, isH) => {
      ctx.rotate(ang);
      ctx.scale(1, 0.65 + r() * 0.3);
      if (isH) {
        const g = ctx.createRadialGradient(-rad * 0.2, -rad * 0.2, 0, 0, 0, rad);
        g.addColorStop(0, '#fff');
        g.addColorStop(1, '#888');
        ctx.fillStyle = g;
      } else {
        const g = ctx.createRadialGradient(-rad * 0.3, -rad * 0.3, 0, 0, 0, rad);
        g.addColorStop(0, `rgb(${tone + 40 + warm},${tone + 36},${tone + 28})`);
        g.addColorStop(1, `rgb(${tone * 0.55 + warm},${tone * 0.5},${tone * 0.45})`);
        ctx.fillStyle = g;
      }
      ctx.beginPath();
      ctx.arc(0, 0, rad, 0, Math.PI * 2);
      ctx.fill();
    });
  }
}

function paintRock(p: Painter): void {
  const s = p.size;
  const big = fbmTile(s, 4, 6, 31, 0.55);
  const fine = fbmTile(s, 64, 2, 32);
  const lichen = fbmTile(s, 8, 4, 33);
  const a: RGB = [78, 76, 72];
  const b: RGB = [138, 134, 126];
  const li: RGB = [128, 136, 92];
  p.fill(
    (i) => mix(mix(a, b, big[i]! * 0.75 + fine[i]! * 0.25), li, Math.max(0, lichen[i]! - 0.62) * 2.2),
    (i) => big[i]! * 0.75 + fine[i]! * 0.25,
  );
  const r = mulberry(34);
  for (let k = 0; k < 28; k++) { // a few fine cracks, not a web of veins
    let x = r() * s;
    let y = r() * s;
    let a2 = r() * Math.PI * 2;
    const steps = 10 + Math.floor(r() * 30);
    const w = 0.5 + r() * 0.8;
    for (let st = 0; st < steps; st++) {
      const nx = x + Math.cos(a2) * 6;
      const ny = y + Math.sin(a2) * 6;
      const x0 = x;
      const y0 = y;
      p.shape(x0, y0, 10, (ctx, isH) => {
        ctx.strokeStyle = isH ? '#555' : 'rgba(40,38,34,0.35)';
        ctx.lineWidth = w;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(nx - x0, ny - y0);
        ctx.stroke();
      });
      x = nx;
      y = ny;
      a2 += (r() - 0.5) * 0.9;
    }
  }
}

function paintLitter(p: Painter): void {
  const s = p.size;
  const base = fbmTile(s, 8, 4, 41);
  p.fill(
    (i) => mix([46, 32, 22], [84, 62, 42], base[i]!),
    (i) => base[i]! * 0.3,
  );
  const r = mulberry(42);
  // Fallen leaves: browns, rusts and a few faded reds/yellows.
  const palette: RGB[] = [
    [176, 96, 38],
    [200, 132, 52],
    [140, 74, 36],
    [182, 72, 36],
    [196, 150, 64],
    [150, 104, 52],
  ];
  for (let k = 0; k < 520; k++) {
    const x = r() * s;
    const y = r() * s;
    const c = palette[Math.floor(r() * palette.length)]!;
    const shade = 0.75 + r() * 0.4;
    const col: RGB = [c[0] * shade, c[1] * shade, c[2] * shade];
    const rot = r() * Math.PI * 2;
    const kind = r();
    const sz = 7 + r() * 9;
    const hgt = 150 + r() * 100;
    const leafSeed = r();
    p.shape(x, y, sz * 2, (ctx, isH) => {
      ctx.rotate(rot);
      const lr = mulberry(Math.floor(leafSeed * 1e6));
      if (isH) {
        // Height pass: same silhouette, flat grey.
        const g: RGB = [hgt, hgt, hgt];
        if (kind < 0.55) palmateLeaf(ctx, sz, g, lr, kind < 0.3 ? 7 : 5);
        else ovateLeaf(ctx, sz * 0.6, g, lr);
      } else if (kind < 0.55) palmateLeaf(ctx, sz, col, lr, kind < 0.3 ? 7 : 5);
      else ovateLeaf(ctx, sz * 0.6, col, lr);
    });
  }
}

function paintMud(p: Painter): void {
  const s = p.size;
  const big = fbmTile(s, 4, 5, 51);
  const fine = fbmTile(s, 64, 2, 52);
  const pools = fbmTile(s, 6, 3, 53);
  p.fill(
    (i) => {
      const wet = Math.max(0, pools[i]! - 0.55) * 2.5;
      return mix(mix([48, 38, 28], [86, 70, 50], big[i]! * 0.8 + fine[i]! * 0.2), [30, 26, 20], wet);
    },
    (i) => big[i]! * 0.5 + fine[i]! * 0.15 - Math.max(0, pools[i]! - 0.55),
  );
}

function arrayTexture(layers: Uint8ClampedArray[], size: number, colorSpace: THREE.ColorSpace): THREE.DataArrayTexture {
  const data = new Uint8Array(size * size * 4 * layers.length);
  layers.forEach((l, i) => data.set(l, i * size * size * 4));
  const tex = new THREE.DataArrayTexture(data, size, size, layers.length);
  tex.format = THREE.RGBAFormat;
  tex.type = THREE.UnsignedByteType;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 8;
  tex.colorSpace = colorSpace;
  tex.needsUpdate = true;
  return tex;
}

// --- props ----------------------------------------------------------------------

function canvasTex(w: number, h: number, draw: (ctx: CanvasRenderingContext2D) => void, srgb = true): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  draw(ctx);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.anisotropy = 8;
  return t;
}

function barkTexture(): THREE.CanvasTexture {
  const w = 256;
  const h = 512;
  const r = mulberry(61);
  const t = canvasTex(w, h, (ctx) => {
    ctx.fillStyle = '#6a5a4c';
    ctx.fillRect(0, 0, w, h);
    for (let k = 0; k < 220; k++) {
      const x = r() * w;
      const tone = 40 + r() * 80;
      ctx.strokeStyle = `rgba(${tone},${tone * 0.85},${tone * 0.7},${0.4 + r() * 0.5})`;
      ctx.lineWidth = 1 + r() * 5;
      ctx.beginPath();
      let y = -20;
      let xx = x;
      ctx.moveTo(xx, y);
      while (y < h + 20) {
        y += 10 + r() * 30;
        xx += (r() - 0.5) * 8;
        ctx.lineTo(xx, y);
      }
      ctx.stroke();
    }
  });
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

function bambooTexture(): THREE.CanvasTexture {
  const w = 128;
  const h = 256;
  const r = mulberry(62);
  const t = canvasTex(w, h, (ctx) => {
    const g = ctx.createLinearGradient(0, 0, w, 0);
    g.addColorStop(0, '#5f7d2e');
    g.addColorStop(0.5, '#9fb85a');
    g.addColorStop(1, '#5f7d2e');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    for (let k = 0; k < 40; k++) {
      ctx.strokeStyle = `rgba(${60 + r() * 60},${90 + r() * 50},${30},0.25)`;
      ctx.lineWidth = 1 + r() * 2;
      const x = r() * w;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x + (r() - 0.5) * 3, h);
      ctx.stroke();
    }
    // Node ring at the bottom of each internode
    const ng = ctx.createLinearGradient(0, h - 14, 0, h);
    ng.addColorStop(0, 'rgba(60,70,30,0)');
    ng.addColorStop(0.6, 'rgba(210,205,150,0.9)');
    ng.addColorStop(1, 'rgba(50,60,25,0.9)');
    ctx.fillStyle = ng;
    ctx.fillRect(0, h - 14, w, 14);
  });
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

/** Neutral light leaf tones: the per-instance tint supplies the hue (red/orange/gold/green). */
function neutralLeaf(r: () => number): RGB {
  const v = 200 + r() * 45;
  const warm = r();
  // A few leaves yellower or redder than the rest, like a real crown.
  return warm < 0.15 ? [v, v * 0.95, v * 0.7] : warm < 0.28 ? [v, v * 0.82, v * 0.78] : [v, v * 0.96, v * 0.9];
}

/** Maple canopy card: twigs carrying palmate leaves, alpha-cut, tinted per tree. */
function mapleCardTexture(): THREE.CanvasTexture {
  const s = 512;
  const r = mulberry(63);
  return canvasTex(s, s, (ctx) => {
    ctx.clearRect(0, 0, s, s);
    const bark: RGB = [70, 52, 40];
    for (let b = 0; b < 7; b++) {
      // A twig from near the card edge towards the middle, leaves alternating along it.
      const a0 = r() * Math.PI * 2;
      const x0 = s / 2 + Math.cos(a0) * s * 0.45;
      const y0 = s / 2 + Math.sin(a0) * s * 0.45;
      const a = a0 + Math.PI + (r() - 0.5) * 0.8;
      const len = s * (0.35 + r() * 0.25);
      ctx.save();
      ctx.translate(x0, y0);
      twig(ctx, Math.cos(a) * len, Math.sin(a) * len, 3, bark);
      const n = 6 + Math.floor(r() * 4);
      for (let k = 0; k < n; k++) {
        const t = 0.2 + (k / n) * 0.8;
        const side = k % 2 === 0 ? 1 : -1;
        ctx.save();
        ctx.translate(Math.cos(a) * len * t, Math.sin(a) * len * t);
        ctx.rotate(a + Math.PI / 2 + side * (0.6 + r() * 0.6) + Math.PI);
        ctx.translate(0, -(10 + r() * 8));
        palmateLeaf(ctx, 26 + r() * 20, neutralLeaf(r), r, r() < 0.7 ? 7 : 5);
        ctx.restore();
      }
      ctx.restore();
    }
  });
}

/** Bamboo foliage card: fans of drooping lance leaves on thin stems. */
function bambooCardTexture(): THREE.CanvasTexture {
  const s = 512;
  const r = mulberry(64);
  return canvasTex(s, s, (ctx) => {
    ctx.clearRect(0, 0, s, s);
    const stem: RGB = [118, 128, 66];
    for (let spray = 0; spray < 8; spray++) {
      const sx = s * (0.2 + r() * 0.6);
      const sy = s * (0.15 + r() * 0.5);
      const base = Math.PI / 2 + (r() - 0.5) * 1.6; // mostly hanging down
      ctx.save();
      ctx.translate(sx, sy);
      twig(ctx, Math.cos(base) * 60, Math.sin(base) * 60, 2, stem);
      const n = 4 + Math.floor(r() * 4);
      for (let k = 0; k < n; k++) {
        ctx.save();
        const t = 0.3 + (k / n) * 0.7;
        ctx.translate(Math.cos(base) * 60 * t, Math.sin(base) * 60 * t);
        ctx.rotate(base + Math.PI / 2 + (r() - 0.5) * 1.6);
        const v = 200 + r() * 45;
        lanceLeaf(ctx, 26 + r() * 16, [v * 0.95, v, v * 0.82], r);
        ctx.restore();
      }
      ctx.restore();
    }
  });
}

/** Cedar needle sprays: radiating short strokes. */
function needleCardTexture(): THREE.CanvasTexture {
  const s = 512;
  const r = mulberry(67);
  return canvasTex(s, s, (ctx) => {
    ctx.clearRect(0, 0, s, s);
    for (let c = 0; c < 30; c++) {
      const cx = s * (0.12 + r() * 0.76);
      const cy = s * (0.12 + r() * 0.76);
      const base = r() * Math.PI * 2;
      for (let k = 0; k < 26; k++) {
        const a = base + (r() - 0.5) * 2.6;
        const len = 30 + r() * 55;
        const v = 140 + r() * 115;
        ctx.strokeStyle = `rgb(${v * 0.9},${v},${v * 0.9})`;
        ctx.lineWidth = 3 + r() * 4;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.quadraticCurveTo(cx + Math.cos(a) * len * 0.5 + (r() - 0.5) * 10, cy + Math.sin(a) * len * 0.5, cx + Math.cos(a) * len, cy + Math.sin(a) * len);
        ctx.stroke();
      }
    }
  });
}

/**
 * 2x2 atlas of single leaves for falling leaves (neutral tones, tinted by biome):
 *   0 seven-lobed maple · 1 five-lobed maple · 2 ovate broadleaf · 3 bamboo lance
 */
function leafAtlasTexture(): THREE.CanvasTexture {
  const s = 512;
  const h = s / 2;
  const r = mulberry(68);
  return canvasTex(s, s, (ctx) => {
    ctx.clearRect(0, 0, s, s);
    const cell = (i: number, draw: () => void): void => {
      ctx.save();
      ctx.translate((i % 2) * h + h / 2, Math.floor(i / 2) * h + h * 0.78);
      draw();
      ctx.restore();
    };
    cell(0, () => palmateLeaf(ctx, h * 0.42, [232, 226, 212], r, 7));
    cell(1, () => palmateLeaf(ctx, h * 0.44, [235, 228, 210], r, 5));
    cell(2, () => ovateLeaf(ctx, h * 0.3, [230, 228, 205], r));
    cell(3, () => {
      ctx.rotate(0.35);
      lanceLeaf(ctx, h * 0.3, [225, 232, 200], r);
    });
  });
}

/**
 * Bracken frond card (neutral tones, tinted per plant): stem up the middle,
 * paired pinnae that are longest in the lower-middle and shrink to the tip,
 * each made of small rounded lobes. Stem base at the bottom of the texture.
 */
function fernCardTexture(): THREE.CanvasTexture {
  const w = 256;
  const h = 512;
  const r = mulberry(75);
  return canvasTex(w, h, (ctx) => {
    ctx.clearRect(0, 0, w, h);
    const cx = w / 2;
    const pairs = 17;
    for (let k = 0; k < pairs; k++) {
      const t = k / (pairs - 1); // 0 base .. 1 tip
      const y = h * (0.94 - t * 0.9);
      const len = w * 0.46 * Math.sin(Math.PI * (0.18 + 0.82 * t)) ** 0.7 * (1 - t * 0.35);
      for (const side of [-1, 1]) {
        const lobes = Math.max(3, Math.round(len / 9));
        for (let j = 0; j < lobes; j++) {
          const u = j / lobes;
          const px = cx + side * (6 + u * len);
          const py = y - u * len * 0.32; // pinnae angle forward towards the tip
          const lr = (1 - u * 0.65) * 6.5 + 1.5;
          const v = 175 + r() * 60;
          ctx.fillStyle = `rgb(${v},${v * 0.97},${v * 0.86})`;
          ctx.beginPath();
          ctx.ellipse(px, py, lr * 0.9, lr * 1.25, side * 0.5, 0, Math.PI * 2);
          ctx.fill();
        }
        // Pinna midrib
        ctx.strokeStyle = 'rgba(120,105,80,0.75)';
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.moveTo(cx, y);
        ctx.lineTo(cx + side * (6 + len), y - len * 0.32);
        ctx.stroke();
      }
    }
    // Rachis (main stem)
    ctx.strokeStyle = 'rgb(140,118,84)';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(cx, h);
    ctx.quadraticCurveTo(cx + 4, h * 0.5, cx, h * 0.03);
    ctx.stroke();
  });
}

/**
 * Weathered granite boulder skin: pink-grey crystalline speckle, pale sage
 * crustose lichen blotches with ragged edges, dark lichen dots.
 */
function graniteTexture(): THREE.CanvasTexture {
  const s = 512;
  const big = fbmTile(s, 4, 5, 71);
  const grain = fbmTile(s, 128, 2, 72);
  const lichen = fbmTile(s, 8, 5, 73, 0.6);
  const r = mulberry(74);
  const t = canvasTex(s, s, (ctx) => {
    const img = ctx.createImageData(s, s);
    for (let i = 0; i < s * s; i++) {
      // Base: warm pink-grey granite with mottling.
      let c = mix([112, 80, 72], [150, 116, 104], big[i]!);
      // Crystal speckle: feldspar pink, quartz light, mica dark.
      const sp = r();
      if (sp < 0.08) c = mix(c, [60, 50, 50], 0.7);
      else if (sp < 0.16) c = mix(c, [220, 205, 195], 0.5);
      else if (sp < 0.24) c = mix(c, [190, 110, 95], 0.4);
      c = mix(c, [c[0] * (0.8 + grain[i]! * 0.4), c[1] * (0.8 + grain[i]! * 0.4), c[2] * (0.8 + grain[i]! * 0.4)], 0.6);
      // Lichen: pale sage-grey crust with ragged edges.
      const l = THREE.MathUtils.smoothstep(lichen[i]!, 0.6, 0.64);
      c = mix(c, [176 + grain[i]! * 30, 184 + grain[i]! * 25, 160 + grain[i]! * 20], l * 0.9);
      img.data[i * 4] = c[0];
      img.data[i * 4 + 1] = c[1];
      img.data[i * 4 + 2] = c[2];
      img.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    // Dark lichen dots, clustered.
    for (let k = 0; k < 1600; k++) {
      const x = r() * s;
      const y = r() * s;
      ctx.fillStyle = `rgba(30,28,24,${0.4 + r() * 0.5})`;
      ctx.beginPath();
      ctx.arc(x, y, 0.6 + r() * 1.6, 0, Math.PI * 2);
      ctx.fill();
    }
  });
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(2, 1);
  return t;
}

/**
 * Ponderosa-style pine bark: large reddish-orange plates separated by deep,
 * dark fissures (jigsaw pattern), vertical grain inside each plate.
 */
function pineBarkTexture(): THREE.CanvasTexture {
  const w = 256;
  const h = 512;
  const r = mulberry(81);
  const t = canvasTex(w, h, (ctx) => {
    ctx.fillStyle = '#2a1e18'; // fissures
    ctx.fillRect(0, 0, w, h);
    // Plates: irregular vertical slabs, wrapped horizontally for tiling.
    let y = -40;
    while (y < h + 40) {
      const rowH = 40 + r() * 70;
      let x = -20;
      while (x < w + 20) {
        const pw = 30 + r() * 50;
        const tone = 0.7 + r() * 0.4;
        const cx = x + pw / 2;
        const cy = y + rowH / 2;
        for (const ox of [-w, 0, w]) {
          ctx.save();
          ctx.translate(cx + ox, cy);
          ctx.beginPath();
          const pts = 9;
          for (let k = 0; k <= pts; k++) {
            const a = (k / pts) * Math.PI * 2;
            const rr = 0.85 + r() * 0.25;
            const px = Math.cos(a) * (pw / 2 - 3) * rr;
            const py = Math.sin(a) * (rowH / 2 - 3) * rr;
            if (k === 0) ctx.moveTo(px, py);
            else ctx.lineTo(px, py);
          }
          ctx.closePath();
          const g = ctx.createLinearGradient(-pw / 2, 0, pw / 2, 0);
          // Muted cinnamon-brown plates with grey weathering (not bright orange).
          g.addColorStop(0, `rgb(${88 * tone},${60 * tone},${46 * tone})`);
          g.addColorStop(0.5, `rgb(${128 * tone},${88 * tone},${66 * tone})`);
          g.addColorStop(1, `rgb(${84 * tone},${58 * tone},${44 * tone})`);
          ctx.fillStyle = g;
          ctx.fill();
          // Vertical grain / flaking layers
          ctx.strokeStyle = `rgba(60,36,26,0.35)`;
          ctx.lineWidth = 1;
          for (let s = 0; s < 6; s++) {
            const gx = (r() - 0.5) * pw * 0.7;
            ctx.beginPath();
            ctx.moveTo(gx, -rowH * 0.4);
            ctx.lineTo(gx + (r() - 0.5) * 4, rowH * 0.4);
            ctx.stroke();
          }
          ctx.restore();
        }
        x += pw;
      }
      y += rowH;
    }
  });
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

/** Pine needle tufts: dense bundles of long needles radiating from twig ends. */
function pineNeedleCardTexture(): THREE.CanvasTexture {
  const s = 512;
  const r = mulberry(82);
  return canvasTex(s, s, (ctx) => {
    ctx.clearRect(0, 0, s, s);
    for (let b = 0; b < 14; b++) {
      // A twig with several tufts along it.
      const x0 = s * (0.1 + r() * 0.8);
      const y0 = s * (0.1 + r() * 0.8);
      const a = r() * Math.PI * 2;
      const len = 60 + r() * 90;
      ctx.strokeStyle = 'rgb(90,70,50)';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x0 + Math.cos(a) * len, y0 + Math.sin(a) * len);
      ctx.stroke();
      const tufts = 3 + Math.floor(r() * 3);
      for (let t2 = 0; t2 < tufts; t2++) {
        const f = 0.35 + (t2 / tufts) * 0.65;
        const tx = x0 + Math.cos(a) * len * f;
        const ty = y0 + Math.sin(a) * len * f;
        for (let n = 0; n < 34; n++) {
          const na = a + (r() - 0.5) * 2.4;
          const nl = 22 + r() * 30;
          const v = 120 + r() * 100;
          ctx.strokeStyle = `rgb(${v * 0.88},${v},${v * 0.9})`;
          ctx.lineWidth = 1.2 + r() * 0.8;
          ctx.beginPath();
          ctx.moveTo(tx, ty);
          ctx.quadraticCurveTo(tx + Math.cos(na) * nl * 0.5, ty + Math.sin(na) * nl * 0.5 + 3, tx + Math.cos(na) * nl, ty + Math.sin(na) * nl + 5);
          ctx.stroke();
        }
      }
    }
  });
}

/** Worn leather: brown with fine pebble grain, creases and lighter scuffed wear. */
function leatherTexture(): THREE.CanvasTexture {
  const s = 256;
  const big = fbmTile(s, 4, 4, 83);
  const grain = fbmTile(s, 64, 2, 84);
  const r = mulberry(85);
  const t = canvasTex(s, s, (ctx) => {
    const img = ctx.createImageData(s, s);
    for (let i = 0; i < s * s; i++) {
      const wear = THREE.MathUtils.smoothstep(big[i]!, 0.55, 0.8);
      const c = mix(mix([78, 50, 32], [104, 70, 46], grain[i]!), [150, 112, 80], wear * 0.7);
      img.data.set([c[0], c[1], c[2], 255], i * 4);
    }
    ctx.putImageData(img, 0, 0);
    // Creases
    for (let k = 0; k < 40; k++) {
      ctx.strokeStyle = `rgba(30,18,10,${0.25 + r() * 0.3})`;
      ctx.lineWidth = 0.6 + r();
      const x = r() * s;
      const y = r() * s;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.quadraticCurveTo(x + (r() - 0.5) * 40, y + (r() - 0.5) * 10, x + (r() - 0.5) * 60, y + (r() - 0.5) * 16);
      ctx.stroke();
    }
  });
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(3, 3);
  return t;
}

/** Twisted hemp rope: diagonal strands with fibre noise. */
function ropeTexture(): THREE.CanvasTexture {
  const w = 128;
  const h = 64;
  const r = mulberry(86);
  const t = canvasTex(w, h, (ctx) => {
    ctx.fillStyle = 'rgb(150,128,92)';
    ctx.fillRect(0, 0, w, h);
    for (let k = -4; k < 12; k++) {
      const x = k * 16;
      const g = ctx.createLinearGradient(x, 0, x + 16, 0);
      g.addColorStop(0, 'rgba(70,56,38,0.9)');
      g.addColorStop(0.5, 'rgba(200,178,136,0.6)');
      g.addColorStop(1, 'rgba(70,56,38,0.9)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(x, h);
      ctx.lineTo(x + 16, h);
      ctx.lineTo(x + 16 + 32, 0);
      ctx.lineTo(x + 32, 0);
      ctx.closePath();
      ctx.fill();
    }
    for (let k = 0; k < 300; k++) {
      ctx.fillStyle = `rgba(${r() > 0.5 ? 220 : 60},${r() > 0.5 ? 200 : 50},${140},0.15)`;
      ctx.fillRect(r() * w, r() * h, 1 + r() * 3, 1);
    }
  });
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

function clothTexture(): THREE.CanvasTexture {
  const s = 128;
  const r = mulberry(66);
  const t = canvasTex(s, s, (ctx) => {
    ctx.fillStyle = '#dadada'; // light, so material colours read true (it only adds weave)
    ctx.fillRect(0, 0, s, s);
    for (let y = 0; y < s; y += 2) {
      ctx.fillStyle = `rgba(255,255,255,${0.05 + r() * 0.08})`;
      ctx.fillRect(0, y, s, 1);
    }
    for (let x = 0; x < s; x += 2) {
      ctx.fillStyle = `rgba(0,0,0,${0.05 + r() * 0.08})`;
      ctx.fillRect(x, 0, 1, s);
    }
  });
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

let cached: EnvTextures | null = null;

export function getEnvTextures(): EnvTextures {
  if (cached) return cached;
  const painters = [paintMoss, paintDirt, paintRock, paintLitter, paintMud].map((paint) => {
    const p = new Painter(GROUND_SIZE);
    paint(p);
    return p;
  });
  const strengths = [3, 5, 6, 4, 2.5];
  cached = {
    groundAlbedo: arrayTexture(
      painters.map((p) => p.rgba()),
      GROUND_SIZE,
      THREE.SRGBColorSpace,
    ),
    groundNormal: arrayTexture(
      painters.map((p, i) => p.normals(strengths[i]!)),
      GROUND_SIZE,
      THREE.NoColorSpace,
    ),
    bark: barkTexture(),
    bamboo: bambooTexture(),
    mapleCard: mapleCardTexture(),
    bambooCard: bambooCardTexture(),
    needleCard: needleCardTexture(),

    leafAtlas: leafAtlasTexture(),
    cloth: clothTexture(),
    granite: graniteTexture(),
    fernCard: fernCardTexture(),
    pineBark: pineBarkTexture(),
    pineNeedles: pineNeedleCardTexture(),
    leather: leatherTexture(),
    rope: ropeTexture(),
  };
  return cached;
}
