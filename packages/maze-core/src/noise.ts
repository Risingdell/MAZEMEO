/**
 * Seeded 2D value noise + fractal Brownian motion.
 * Pure functions of (seed, x, z) so terrain is identical everywhere.
 */
import { mix32 } from './rng.ts';

function lattice(seed: number, ix: number, iz: number): number {
  const h = mix32((seed ^ Math.imul(ix, 0x27d4eb2d) ^ Math.imul(iz, 0x165667b1)) >>> 0);
  return h / 4294967296; // [0,1)
}

function smooth(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10); // quintic fade
}

/** Value noise in [-1, 1]. */
export function valueNoise(seed: number, x: number, z: number): number {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = smooth(x - ix);
  const fz = smooth(z - iz);
  const a = lattice(seed, ix, iz);
  const b = lattice(seed, ix + 1, iz);
  const c = lattice(seed, ix, iz + 1);
  const d = lattice(seed, ix + 1, iz + 1);
  const top = a + (b - a) * fx;
  const bottom = c + (d - c) * fx;
  return (top + (bottom - top) * fz) * 2 - 1;
}

/** Fractal noise in roughly [-1, 1]. */
export function fbm(seed: number, x: number, z: number, octaves = 4, lacunarity = 2, gain = 0.5): number {
  let sum = 0;
  let amp = 1;
  let freq = 1;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += amp * valueNoise((seed + o * 0x9e3779b9) >>> 0, x * freq, z * freq);
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}
