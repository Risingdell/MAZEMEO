/**
 * Procedural soundscape (Web Audio, no sample files): wind, leaf rustle,
 * rain, birdsong, thunder, a positional waterfall, surface-dependent footsteps,
 * impacts and throws.
 * The context starts on the first user gesture (browser autoplay rules).
 */
import type { Surface } from './player/controller.ts';

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private windGain!: GainNode;
  private windFilter!: BiquadFilterNode;
  private rustleGain!: GainNode;
  private rainGain!: GainNode;
  private rainLowGain!: GainNode;
  private white!: AudioBuffer;
  private brown!: AudioBuffer;
  private birdTimer = 2;
  private volume = 0.7;
  private muted = false;
  private water: { panner: PannerNode; gain: GainNode } | null = null;
  private waterPos: Vec3 | null = null;

  get started(): boolean {
    return this.ctx !== null;
  }

  start(): void {
    if (this.ctx) {
      void this.ctx.resume();
      return;
    }
    const ctx = new AudioContext();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : this.volume;
    const comp = ctx.createDynamicsCompressor();
    this.master.connect(comp).connect(ctx.destination);

    this.white = this.noiseBuffer('white');
    this.brown = this.noiseBuffer('brown');

    // Wind: brown noise through a moving low-pass.
    this.windFilter = ctx.createBiquadFilter();
    this.windFilter.type = 'lowpass';
    this.windFilter.frequency.value = 500;
    this.windFilter.Q.value = 0.8;
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;
    this.loop(this.brown).connect(this.windFilter).connect(this.windGain).connect(this.master);

    // Leaf rustle: high band-passed white noise, gated by gusts.
    const rf = ctx.createBiquadFilter();
    rf.type = 'bandpass';
    rf.frequency.value = 4200;
    rf.Q.value = 0.6;
    this.rustleGain = ctx.createGain();
    this.rustleGain.gain.value = 0;
    this.loop(this.white).connect(rf).connect(this.rustleGain).connect(this.master);

    // Rain: hiss + low drumming.
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 900;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 7000;
    this.rainGain = ctx.createGain();
    this.rainGain.gain.value = 0;
    this.loop(this.white).connect(hp).connect(lp).connect(this.rainGain).connect(this.master);
    const rl = ctx.createBiquadFilter();
    rl.type = 'lowpass';
    rl.frequency.value = 350;
    this.rainLowGain = ctx.createGain();
    this.rainLowGain.gain.value = 0;
    this.loop(this.brown).connect(rl).connect(this.rainLowGain).connect(this.master);
  }

  setVolume(v: number): void {
    this.volume = v;
    if (this.ctx) this.master.gain.setTargetAtTime(this.muted ? 0 : v, this.ctx.currentTime, 0.05);
  }

  /** Positional rushing water (the ravine waterfall). Pass null to silence it. */
  setWater(pos: Vec3 | null): void {
    this.waterPos = pos;
    if (this.water) this.water.panner.positionX.value = pos ? pos.x : 1e6;
    if (this.water && pos) {
      this.water.panner.positionY.value = pos.y;
      this.water.panner.positionZ.value = pos.z;
    }
  }

  /** Move the listener with the camera so positional sounds pan and fade correctly. */
  listen(pos: Vec3, forward: Vec3): void {
    const ctx = this.ctx;
    if (!ctx) return;
    if (!this.water && this.waterPos) this.createWater();
    const l = ctx.listener;
    if (l.positionX) {
      l.positionX.value = pos.x;
      l.positionY.value = pos.y;
      l.positionZ.value = pos.z;
      l.forwardX.value = forward.x;
      l.forwardY.value = forward.y;
      l.forwardZ.value = forward.z;
      l.upX.value = 0;
      l.upY.value = 1;
      l.upZ.value = 0;
    }
  }

  private createWater(): void {
    const ctx = this.ctx!;
    const p = this.waterPos!;
    const panner = ctx.createPanner();
    panner.panningModel = 'equalpower';
    panner.distanceModel = 'inverse';
    panner.refDistance = 5;
    panner.rolloffFactor = 1.3;
    panner.maxDistance = 120;
    panner.positionX.value = p.x;
    panner.positionY.value = p.y;
    panner.positionZ.value = p.z;
    const gain = ctx.createGain();
    gain.gain.value = 0.55;
    // Rushing hiss + low burble, slowly modulated so it never sounds like static.
    const hiss = ctx.createBiquadFilter();
    hiss.type = 'bandpass';
    hiss.frequency.value = 1500;
    hiss.Q.value = 0.4;
    const burble = ctx.createBiquadFilter();
    burble.type = 'lowpass';
    burble.frequency.value = 520;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.21;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 260;
    lfo.connect(lfoGain).connect(hiss.frequency);
    lfo.start();
    this.loop(this.white).connect(hiss).connect(gain);
    const bg = ctx.createGain();
    bg.gain.value = 1.6;
    this.loop(this.brown).connect(burble).connect(bg).connect(gain);
    gain.connect(panner).connect(this.master);
    this.water = { panner, gain };
  }

  /** Continuous ambience, called every frame. */
  update(dt: number, p: { wind: number; gust: number; rain: number; birds: number; daylight: number; indoorsOfCanopy: number }): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const now = ctx.currentTime;
    this.windGain.gain.setTargetAtTime(Math.min(0.9, p.wind * 0.45 * (0.6 + p.gust * 0.6)), now, 0.4);
    this.windFilter.frequency.setTargetAtTime(250 + p.wind * 500 + p.gust * 500, now, 0.5);
    this.rustleGain.gain.setTargetAtTime(p.wind * 0.06 * p.gust * p.indoorsOfCanopy, now, 0.3);
    this.rainGain.gain.setTargetAtTime(p.rain * 0.28, now, 0.6);
    this.rainLowGain.gain.setTargetAtTime(p.rain * p.rain * 0.4, now, 0.6);

    this.birdTimer -= dt;
    if (this.birdTimer <= 0) {
      this.birdTimer = 1.5 + Math.random() * 6 / Math.max(0.15, p.birds);
      if (p.birds * p.daylight > 0.25 && Math.random() < p.birds) this.bird();
    }
  }

  footstep(surface: Surface, loud: number, wet: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    const cfg: Record<Surface, { f: number; q: number; type: BiquadFilterType; dur: number; gain: number }> = {
      dirt: { f: 900, q: 0.9, type: 'bandpass', dur: 0.09, gain: 0.55 },
      grass: { f: 2600, q: 0.5, type: 'bandpass', dur: 0.12, gain: 0.35 },
      leaves: { f: 3400, q: 0.4, type: 'bandpass', dur: 0.16, gain: 0.5 },
      mud: { f: 420, q: 1.2, type: 'lowpass', dur: 0.16, gain: 0.7 },
      rock: { f: 1600, q: 2.5, type: 'bandpass', dur: 0.05, gain: 0.6 },
    };
    const c = cfg[surface];
    this.burst(this.white, c.type, c.f * (0.85 + Math.random() * 0.3), c.q, c.dur, c.gain * loud, t);
    // Heel thump
    this.burst(this.brown, 'lowpass', 160, 0.7, 0.07, 0.35 * loud, t);
    if (wet > 0.3 || surface === 'mud') this.burst(this.white, 'bandpass', 2400 + Math.random() * 900, 2, 0.14, 0.18 * Math.max(wet, surface === 'mud' ? 0.6 : 0) * loud, t + 0.02);
  }

  land(impact: number, surface: Surface): void {
    if (!this.ctx) return;
    this.footstep(surface, 0.6 + impact, 0);
    this.burst(this.brown, 'lowpass', 120, 0.8, 0.18, 0.6 * impact + 0.2, this.ctx.currentTime);
  }

  whoosh(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.white;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.Q.value = 1.2;
    f.frequency.setValueAtTime(500, t);
    f.frequency.exponentialRampToValueAtTime(2200, t + 0.18);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.25, t + 0.08);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.25);
    src.connect(f).connect(g).connect(this.master);
    src.start(t, Math.random());
    src.stop(t + 0.3);
  }

  /** Soft two-note chime when picking up a tool cache. */
  pickup(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t0 = ctx.currentTime;
    [880, 1320].forEach((f, i) => {
      const o = ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.value = f;
      const g = ctx.createGain();
      const t = t0 + i * 0.09;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.18, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
      o.connect(g).connect(this.master);
      o.start(t);
      o.stop(t + 0.55);
    });
  }

  /** Knock of a stone/log hitting something, attenuated by distance. */
  impact(distance: number, strength: number, kind: 'stone' | 'log' | 'rock'): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const att = Math.max(0, 1 - distance / 60) * strength;
    if (att < 0.02) return;
    const t = ctx.currentTime;
    const f = kind === 'stone' ? 2200 : kind === 'rock' ? 900 : 450;
    this.burst(this.white, 'bandpass', f * (0.8 + Math.random() * 0.4), kind === 'log' ? 3 : 5, 0.06, 0.8 * att, t);
    this.burst(this.brown, 'lowpass', kind === 'log' ? 180 : 260, 1, 0.12, 0.5 * att, t);
  }

  thunder(power: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.brown;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(900 * power + 200, t);
    f.frequency.exponentialRampToValueAtTime(70, t + 4);
    const g = ctx.createGain();
    const dur = 3 + power * 3;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(1.2 * power, t + 0.12);
    // Rolling rumble
    for (let i = 1; i < 6; i++) g.gain.exponentialRampToValueAtTime(Math.max(0.001, (0.4 + Math.random() * 0.6) * power * (1 - i / 7)), t + 0.12 + i * dur * 0.13);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(this.master);
    src.start(t, Math.random() * 2);
    src.stop(t + dur + 0.1);
  }

  private bird(): void {
    const ctx = this.ctx!;
    const t0 = ctx.currentTime;
    const pan = ctx.createStereoPanner();
    pan.pan.value = Math.random() * 2 - 1;
    const out = ctx.createGain();
    out.gain.value = 0.05 + Math.random() * 0.06;
    pan.connect(out).connect(this.master);
    const species = Math.floor(Math.random() * 3);
    const notes = 2 + Math.floor(Math.random() * 5);
    let t = t0;
    for (let i = 0; i < notes; i++) {
      const o = ctx.createOscillator();
      o.type = 'sine';
      const g = ctx.createGain();
      const base = species === 0 ? 3200 : species === 1 ? 2400 : 4200;
      const f0 = base * (0.85 + Math.random() * 0.3);
      const len = species === 2 ? 0.05 : 0.09 + Math.random() * 0.12;
      o.frequency.setValueAtTime(f0, t);
      o.frequency.exponentialRampToValueAtTime(species === 1 ? f0 * 0.6 : f0 * 1.35, t + len);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(1, t + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t + len);
      o.connect(g).connect(pan);
      o.start(t);
      o.stop(t + len + 0.02);
      t += len + 0.03 + Math.random() * 0.08;
    }
  }

  private burst(buf: AudioBuffer, type: BiquadFilterType, freq: number, q: number, dur: number, gain: number, t: number): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(this.master);
    src.start(t, Math.random() * (buf.duration - dur - 0.05));
    src.stop(t + dur + 0.02);
  }

  private loop(buf: AudioBuffer): AudioBufferSourceNode {
    const src = this.ctx!.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    src.start(0, Math.random() * buf.duration);
    return src;
  }

  private noiseBuffer(kind: 'white' | 'brown'): AudioBuffer {
    const ctx = this.ctx!;
    const len = ctx.sampleRate * 3;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      if (kind === 'white') d[i] = w;
      else {
        last = (last + 0.02 * w) / 1.02;
        d[i] = last * 3.5;
      }
    }
    return buf;
  }
}
