/**
 * Weather state machine. Presets blend smoothly; rain accumulates wetness and
 * the ground dries slowly afterwards. Storms emit lightning strikes.
 */
import { env } from './shared.ts';

export type WeatherKind = 'clear' | 'overcast' | 'mist' | 'rain' | 'storm';
export const WEATHER_KINDS: WeatherKind[] = ['clear', 'overcast', 'mist', 'rain', 'storm'];

export interface WeatherParams {
  /** Cloud coverage 0..1. */
  cloud: number;
  /** How dark/thick the clouds are 0..1. */
  darkness: number;
  /** Fog density multiplier. */
  fog: number;
  /** Rain intensity 0..1. */
  rain: number;
  /** Wind strength 0..1.5. */
  wind: number;
  /** Direct sunlight multiplier 0..1. */
  sun: number;
  /** Lightning frequency 0..1. */
  lightning: number;
  /** Bird activity 0..1. */
  birds: number;
}

const PRESETS: Record<WeatherKind, WeatherParams> = {
  clear: { cloud: 0.22, darkness: 0.0, fog: 0.7, rain: 0, wind: 0.3, sun: 1, lightning: 0, birds: 1 },
  overcast: { cloud: 0.78, darkness: 0.35, fog: 1.3, rain: 0, wind: 0.55, sun: 0.3, lightning: 0, birds: 0.5 },
  mist: { cloud: 0.55, darkness: 0.2, fog: 4.2, rain: 0, wind: 0.12, sun: 0.45, lightning: 0, birds: 0.35 },
  rain: { cloud: 0.92, darkness: 0.6, fog: 2.0, rain: 0.6, wind: 0.7, sun: 0.12, lightning: 0, birds: 0 },
  storm: { cloud: 1.0, darkness: 0.85, fog: 2.4, rain: 1.0, wind: 1.35, sun: 0.04, lightning: 1, birds: 0 },
};

export interface LightningStrike {
  /** Seconds until thunder reaches the listener. */
  thunderDelay: number;
  /** 0..1 loudness. */
  power: number;
}

export class Weather {
  kind: WeatherKind = 'clear';
  auto = false;
  /** User wind multiplier (UI slider). */
  windScale = 1;
  readonly current: WeatherParams = { ...PRESETS.clear };
  wetness = 0;
  /** Lightning flash brightness 0..1 (decays quickly). */
  flash = 0;
  onLightning: ((s: LightningStrike) => void) | null = null;

  private autoTimer = 120;
  private strikeTimer = 6;
  private flashQueue: number[] = [];
  private windAngle = 0.4;

  set(kind: WeatherKind): void {
    this.kind = kind;
    this.autoTimer = 90 + Math.random() * 120;
  }

  /** Jump straight to the target state (used on load / screenshots). */
  snap(): void {
    Object.assign(this.current, PRESETS[this.kind]);
    if (this.current.rain > 0) this.wetness = 0.9;
  }

  update(dt: number): void {
    if (this.auto) {
      this.autoTimer -= dt;
      if (this.autoTimer <= 0) {
        const next: Record<WeatherKind, WeatherKind[]> = {
          clear: ['overcast', 'mist', 'clear'],
          overcast: ['rain', 'clear', 'mist'],
          mist: ['clear', 'overcast'],
          rain: ['storm', 'overcast', 'rain'],
          storm: ['rain', 'overcast'],
        };
        const options = next[this.kind];
        this.set(options[Math.floor(Math.random() * options.length)]!);
      }
    }

    // Smoothly approach the target preset (~6 s time constant; rain starts/stops a bit faster).
    const target = PRESETS[this.kind];
    const k = 1 - Math.exp(-dt / 6);
    const kr = 1 - Math.exp(-dt / 3.5);
    for (const key of Object.keys(target) as Array<keyof WeatherParams>) {
      this.current[key] += (target[key] - this.current[key]) * (key === 'rain' ? kr : k);
    }

    // Wetness builds in ~25 s of heavy rain, dries over ~2 min.
    if (this.current.rain > 0.05) this.wetness = Math.min(1, this.wetness + dt * this.current.rain * 0.04);
    else this.wetness = Math.max(0, this.wetness - dt / 120);

    // Wind direction wanders slowly.
    this.windAngle += Math.sin(env.uTime.value * 0.013) * dt * 0.02;
    env.uWindDir.value.set(Math.cos(this.windAngle), Math.sin(this.windAngle));
    env.uWindStrength.value = this.current.wind * this.windScale;
    env.uRain.value = this.current.rain;
    env.uWetness.value = this.wetness;

    // Lightning
    if (this.current.lightning > 0.3) {
      this.strikeTimer -= dt * this.current.lightning;
      if (this.strikeTimer <= 0) {
        this.strikeTimer = 5 + Math.random() * 14;
        // Double/triple flicker like real strikes.
        this.flashQueue = [0, 0.09 + Math.random() * 0.05, Math.random() < 0.5 ? 0.25 : -1].filter((t) => t >= 0);
        const distanceKm = 0.4 + Math.random() * 3;
        this.onLightning?.({ thunderDelay: distanceKm * 2.9, power: Math.max(0.25, 1 - distanceKm / 3.6) });
      }
    }
    this.flash = Math.max(0, this.flash - dt * 6);
    this.flashQueue = this.flashQueue.map((t) => t - dt);
    while (this.flashQueue.length && this.flashQueue[0]! <= 0) {
      this.flashQueue.shift();
      this.flash = 0.7 + Math.random() * 0.3;
    }
  }
}
