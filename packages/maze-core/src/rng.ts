/**
 * Deterministic PRNG (sfc32, seeded via splitmix32).
 *
 * Every random decision in maze-core flows through an Rng so that the same
 * seed produces a bit-identical maze on the server and on every client.
 * Never use Math.random() in this package.
 */

/** 32-bit string/number hash (FNV-1a over UTF-16 code units, then mixed). */
export function hash32(...parts: Array<string | number>): number {
  let h = 0x811c9dc5;
  for (const part of parts) {
    const s = typeof part === 'number' ? `#${part >>> 0}` : `$${part}`;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
  }
  return mix32(h);
}

/** Final avalanche step (murmur3 fmix32). */
export function mix32(x: number): number {
  x ^= x >>> 16;
  x = Math.imul(x, 0x85ebca6b);
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35);
  x ^= x >>> 16;
  return x >>> 0;
}

export class Rng {
  private a: number;
  private b: number;
  private c: number;
  private d: number;
  readonly seed: number;

  constructor(seed: number) {
    this.seed = seed >>> 0;
    let s = this.seed;
    const splitmix = (): number => {
      s = (s + 0x9e3779b9) >>> 0;
      return mix32(s);
    };
    this.a = splitmix();
    this.b = splitmix();
    this.c = splitmix();
    this.d = splitmix();
    // Warm up so nearby seeds diverge quickly.
    for (let i = 0; i < 12; i++) this.nextU32();
  }

  /** Independent child stream; same parent seed + label => same stream. */
  fork(label: string | number): Rng {
    return new Rng(hash32(this.seed, label));
  }

  nextU32(): number {
    const t = (((this.a + this.b) >>> 0) + this.d) >>> 0;
    this.d = (this.d + 1) >>> 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) >>> 0;
    this.c = ((this.c << 21) | (this.c >>> 11)) >>> 0;
    this.c = (this.c + t) >>> 0;
    return t;
  }

  /** Float in [0, 1). */
  next(): number {
    return this.nextU32() / 4294967296;
  }

  /** Float in [min, max). */
  range(min: number, max: number): number {
    return min + (max - min) * this.next();
  }

  /** Integer in [min, maxExclusive). */
  int(min: number, maxExclusive: number): number {
    return min + Math.floor(this.next() * (maxExclusive - min));
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('Rng.pick on empty array');
    return items[this.int(0, items.length)] as T;
  }

  /** In-place Fisher–Yates shuffle. Returns the same array. */
  shuffle<T>(items: T[]): T[] {
    for (let i = items.length - 1; i > 0; i--) {
      const j = this.int(0, i + 1);
      const tmp = items[i] as T;
      items[i] = items[j] as T;
      items[j] = tmp;
    }
    return items;
  }
}
