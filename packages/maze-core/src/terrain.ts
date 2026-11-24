/**
 * Base terrain: a single mountain with the summit at the origin, plus
 * rolling noise. The maze graph samples this for node heights; the
 * walkability field (field.ts) carves paths and raises walls on top of it.
 */
import type { MazeConfig } from './config.ts';
import { fbm, smoothstep } from './noise.ts';

export type HeightFn = (x: number, z: number) => number;

/** Extra height of the summit cone (m). */
const SUMMIT_PEAK = 8;

export function createBaseHeight(terrainSeed: number, cfg: Pick<MazeConfig, 'mapRadius' | 'summitRadius' | 'summitHeight' | 'terrainRoughness'>): HeightFn {
  const R = cfg.mapRadius;
  const seedA = terrainSeed >>> 0;
  const seedB = (terrainSeed ^ 0x5bd1e995) >>> 0;
  return (x: number, z: number): number => {
    const r = Math.sqrt(x * x + z * z);
    // Mountain profile: plateau at the summit, steepest mid-slope, flat foothills.
    const t = Math.max(0, 1 - r / R);
    const mountain = cfg.summitHeight * smoothstep(0, 1, t) ** 1.15;
    // A gentle cone so the exit is always the single highest point (clear goal).
    const peak = SUMMIT_PEAK * Math.max(0, 1 - r / (cfg.summitRadius * 2));
    // Rolling hills + finer detail, faded out around the summit so it reads clearly.
    const hills = fbm(seedA, x / 70, z / 70, 4) * cfg.terrainRoughness;
    const detail = fbm(seedB, x / 22, z / 22, 2) * cfg.terrainRoughness * 0.25;
    const plateauFade = smoothstep(cfg.summitRadius * 0.8, cfg.summitRadius * 2.2, r);
    return mountain + peak + (hills + detail) * plateauFade;
  };
}
