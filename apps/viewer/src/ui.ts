import { mazeChecksum, type Maze, type ToolKind } from '@mazemeo/maze-core';
import { EDGE_COLORS, GROUND, SPAWN_COLORS, TOOL_COLORS, TOOL_LABELS } from './palette.ts';
import type { Quality } from './env/foliage.ts';
import { WEATHER_KINDS, type WeatherKind } from './env/weather.ts';

export interface UiHandlers {
  onGenerate(seed: number): void;
  onToggle(layer: 'forest' | 'overlay' | 'fog' | 'labels', on: boolean): void;
  onOverview(): void;
  onWalk(spawnIndex: number): void;
  onTime(hours: number): void;
  onWeather(kind: WeatherKind): void;
  onAutoWeather(on: boolean): void;
  onWind(scale: number): void;
  onVolume(v: number): void;
  onQuality(q: Quality): void;
  onCinematic(on: boolean): void;
}

export interface EnvState {
  hours: number;
  weather: WeatherKind;
  auto: boolean;
  wind: number;
  volume: number;
  quality: Quality;
  /** Mist, light shafts, bloom and colour grading on the ground. */
  cinematic: boolean;
}

const fmtTime = (h: number): string => `${String(Math.floor(h)).padStart(2, '0')}:${String(Math.floor((h % 1) * 60)).padStart(2, '0')}`;

export interface Timings {
  generateMs: number;
  fieldMs: number;
  buildMs: number;
  instances: number;
}

const hex = (n: number): string => `#${n.toString(16).padStart(6, '0')}`;

export class Ui {
  private readonly seedInput: HTMLInputElement;
  private readonly stats: HTMLElement;
  private readonly fairness: HTMLElement;
  private readonly regions: HTMLElement;
  private readonly spawnSelect: HTMLSelectElement;

  private readonly weatherSelect: HTMLSelectElement;
  private readonly timeLabel: HTMLElement;

  constructor(root: HTMLElement, handlers: UiHandlers, envState: EnvState) {
    root.innerHTML = `
      <header>
        <h1>Maze Lab</h1>
        <p class="sub">Forest Escape · maze-core v2</p>
      </header>
      <section class="row">
        <label class="seed">Seed <input id="seed" type="number" min="0" step="1" /></label>
        <button id="gen" class="primary">Generate</button>
        <button id="rand" title="Random seed">🎲</button>
      </section>
      <section class="row toggles">
        <label><input type="checkbox" data-layer="forest" checked /> Forest</label>
        <label><input type="checkbox" data-layer="overlay" checked /> Trails</label>
        <label><input type="checkbox" data-layer="labels" checked /> Labels</label>
        <label><input type="checkbox" data-layer="fog" checked /> Fog</label>
      </section>
      <section class="row">
        <button id="overview">Overview</button>
        <select id="spawn"></select>
        <button id="walk" class="primary">Walk</button>
      </section>
      <h2>Environment</h2>
      <section class="env">
        <label>Time <input id="time" type="range" min="5" max="19" step="0.05" value="${envState.hours}" /><output id="time-out">${fmtTime(envState.hours)}</output></label>
        <label>Weather
          <select id="weather">${WEATHER_KINDS.map((k) => `<option value="${k}" ${k === envState.weather ? 'selected' : ''}>${k[0]!.toUpperCase() + k.slice(1)}</option>`).join('')}</select>
          <span class="auto"><input id="auto" type="checkbox" ${envState.auto ? 'checked' : ''} /> Auto</span>
        </label>
        <label>Wind <input id="wind" type="range" min="0" max="2" step="0.05" value="${envState.wind}" /></label>
        <label>Volume <input id="volume" type="range" min="0" max="1" step="0.05" value="${envState.volume}" /></label>
        <label>Quality
          <select id="quality"><option value="high" ${envState.quality === 'high' ? 'selected' : ''}>High</option><option value="low" ${envState.quality === 'low' ? 'selected' : ''}>Low (faster)</option></select>
          <span class="auto"><input id="cinematic" type="checkbox" ${envState.cinematic ? 'checked' : ''} /> Cinematic</span>
        </label>
      </section>
      <h2>Stats</h2>
      <dl id="stats" class="stats"></dl>
      <h2>Spawn fairness <span class="hint">cost to exit</span></h2>
      <div id="fairness" class="fairness"></div>
      <h2>Regions</h2>
      <ul id="regions" class="regions"></ul>
      <h2>Legend</h2>
      <div class="legend">
        <span><i style="background:${hex(EDGE_COLORS.path)}"></i>Trail</span>
        <span><i style="background:${hex(EDGE_COLORS.climb)}"></i>Climb</span>
        <span><i style="background:${hex(EDGE_COLORS.grapple)}"></i>Grapple</span>
        ${(Object.keys(TOOL_COLORS) as ToolKind[]).map((t) => `<span><i class="gem" style="background:${hex(TOOL_COLORS[t])}"></i>${TOOL_LABELS[t]}</span>`).join('')}
      </div>
      <p class="foot">Drag to orbit · Right-drag to pan · Scroll to zoom<br/>Walk: WASD · Shift run · Space jump · C crouch · Click throw stone · Esc exit</p>
    `;
    this.weatherSelect = root.querySelector('#weather') as HTMLSelectElement;
    this.timeLabel = root.querySelector('#time-out') as HTMLElement;
    const on = <T extends HTMLElement>(sel: string, ev: string, fn: (el: T) => void): void => {
      const el = root.querySelector(sel) as T;
      el.addEventListener(ev, () => fn(el));
    };
    on<HTMLInputElement>('#time', 'input', (el) => {
      this.timeLabel.textContent = fmtTime(Number(el.value));
      handlers.onTime(Number(el.value));
    });
    on<HTMLSelectElement>('#weather', 'change', (el) => handlers.onWeather(el.value as WeatherKind));
    on<HTMLInputElement>('#auto', 'change', (el) => handlers.onAutoWeather(el.checked));
    on<HTMLInputElement>('#wind', 'input', (el) => handlers.onWind(Number(el.value)));
    on<HTMLInputElement>('#volume', 'input', (el) => handlers.onVolume(Number(el.value)));
    on<HTMLSelectElement>('#quality', 'change', (el) => handlers.onQuality(el.value as Quality));
    on<HTMLInputElement>('#cinematic', 'change', (el) => handlers.onCinematic(el.checked));
    this.seedInput = root.querySelector('#seed') as HTMLInputElement;
    this.stats = root.querySelector('#stats') as HTMLElement;
    this.fairness = root.querySelector('#fairness') as HTMLElement;
    this.regions = root.querySelector('#regions') as HTMLElement;
    this.spawnSelect = root.querySelector('#spawn') as HTMLSelectElement;
    this.spawnSelect.innerHTML = SPAWN_COLORS.map((_, i) => `<option value="${i}">Spawn P${i + 1}</option>`).join('');

    const generate = (): void => {
      const seed = Math.max(0, Math.floor(Number(this.seedInput.value) || 0));
      handlers.onGenerate(seed);
    };
    root.querySelector('#gen')?.addEventListener('click', generate);
    this.seedInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') generate();
    });
    root.querySelector('#rand')?.addEventListener('click', () => {
      this.seedInput.value = String(Math.floor(Math.random() * 1_000_000));
      generate();
    });
    root.querySelectorAll<HTMLInputElement>('input[data-layer]').forEach((el) =>
      el.addEventListener('change', () => handlers.onToggle(el.dataset.layer as 'forest' | 'overlay' | 'fog' | 'labels', el.checked)),
    );
    root.querySelector('#overview')?.addEventListener('click', () => handlers.onOverview());
    root.querySelector('#walk')?.addEventListener('click', () => handlers.onWalk(Number(this.spawnSelect.value)));
  }

  /** Reflect weather changes made by auto mode. */
  setWeather(kind: WeatherKind): void {
    if (this.weatherSelect.value !== kind) this.weatherSelect.value = kind;
  }

  show(maze: Maze, t: Timings): void {
    this.seedInput.value = String(maze.seed);
    const s = maze.stats;
    const rows: Array<[string, string]> = [
      ['Junctions', `${s.nodes}`],
      ['Trails', `${s.edges} <small>(${s.loopEdges} loops)</small>`],
      ['Kinds', `${s.edgeKinds.path} / <b style="color:${hex(EDGE_COLORS.climb)}">${s.edgeKinds.climb}</b> / <b style="color:${hex(EDGE_COLORS.grapple)}">${s.edgeKinds.grapple}</b>`],
      ['Dead ends', `${s.deadEnds} <small>(${s.caches} caches)</small>`],
      ['Fairness', `<b class="${s.fairnessSpread <= 0.08 ? 'ok' : 'warn'}">${(s.fairnessSpread * 100).toFixed(1)}%</b> spread`],
      ['Attempt', `#${s.attempt}`],
      ['Gen / field', `${t.generateMs.toFixed(1)} / ${t.fieldMs.toFixed(0)} ms`],
      ['Scene build', `${t.buildMs.toFixed(0)} ms · ${t.instances.toLocaleString()} props`],
      ['Checksum', `<code>${mazeChecksum(maze)}</code>`],
    ];
    this.stats.innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');

    const costs = maze.spawns.map((id) => maze.nodes[id]?.costToExit ?? 0);
    const max = Math.max(...costs);
    const min = Math.min(...costs);
    const floor = min * 0.85;
    this.fairness.innerHTML = costs
      .map((c, i) => {
        const pct = ((c - floor) / (max - floor)) * 100;
        const col = hex(SPAWN_COLORS[i] as number);
        return `<div class="bar"><span class="who" style="color:${col}">P${i + 1}</span><span class="track"><span style="width:${pct.toFixed(1)}%;background:${col}"></span></span><span class="val">${c.toFixed(0)}</span></div>`;
      })
      .join('');

    this.regions.innerHTML = maze.regions
      .map((r) => `<li><i style="background:${hex(GROUND[r.biome])}"></i>${r.name}<small>${r.nodeIds.length} junctions · borders ${r.neighbors.length}</small></li>`)
      .join('');
  }
}
