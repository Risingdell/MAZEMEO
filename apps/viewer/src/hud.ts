/**
 * In-game HUD (walk mode): a round parchment compass map in the bottom-left
 * showing only the trails you have explored (the maze stays hidden), rotating
 * with your view, with N/E/S/W on a leather ring and a red marker towards the
 * summit exit; three status icons above it (stamina, tools, noise) with ring
 * meters; and a subtle "V – switch camera" hint in the bottom-right.
 */
import * as THREE from 'three';
import type { Maze } from '@mazemeo/maze-core';

const SIZE = 168;
const RANGE = 70; // metres from centre to the map edge
const REVEAL = 22; // trails within this distance get mapped

const ICONS = {
  // Original glyphs (simple strokes), not any particular game's icon set.
  stamina: '<ellipse cx="8.5" cy="8" rx="2.6" ry="4.2" /><ellipse cx="15.5" cy="15.5" rx="2.6" ry="4.2" />', // footprints
  tools: '<path d="M12 3l6 7-6 11-6-11z" /><path d="M6 10h12" />',
  noise: '<path d="M4 10v4M8 7v10M12 4v16M16 8v8M20 11v2" />',
};

export class Hud {
  private readonly root: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly paper: HTMLCanvasElement;
  private readonly meters: Record<'stamina' | 'tools' | 'noise', HTMLElement>;
  private readonly toolCount: HTMLElement;
  private readonly hint: HTMLElement;
  private readonly explored = new Set<number>();
  private maze: Maze | null = null;
  private redraw = 0;

  constructor() {
    this.root = document.createElement('div');
    this.root.id = 'hud';
    this.root.hidden = true;
    const status = Object.entries(ICONS)
      .map(([k, path]) => `<div class="hud-icon" data-k="${k}" title="${k}"><svg viewBox="0 0 24 24">${path}</svg>${k === 'tools' ? '<b class="hud-count">0</b>' : ''}</div>`)
      .join('');
    this.root.innerHTML = `<div class="hud-status">${status}</div><canvas class="hud-map"></canvas><div class="hud-hint"><kbd>V</kbd> – switch camera</div>`;
    document.body.appendChild(this.root);
    this.canvas = this.root.querySelector('.hud-map') as HTMLCanvasElement;
    const dpr = Math.min(window.devicePixelRatio, 2);
    this.canvas.width = this.canvas.height = SIZE * dpr;
    this.ctx = this.canvas.getContext('2d')!;
    this.ctx.scale(dpr, dpr);
    this.meters = {
      stamina: this.root.querySelector('[data-k="stamina"]') as HTMLElement,
      tools: this.root.querySelector('[data-k="tools"]') as HTMLElement,
      noise: this.root.querySelector('[data-k="noise"]') as HTMLElement,
    };
    this.toolCount = this.root.querySelector('.hud-count') as HTMLElement;
    this.hint = this.root.querySelector('.hud-hint') as HTMLElement;
    this.paper = this.makePaper();
  }

  setMaze(maze: Maze): void {
    this.maze = maze;
    this.explored.clear();
  }

  setVisible(on: boolean): void {
    this.root.hidden = !on;
  }

  setHint(text: string): void {
    this.hint.innerHTML = text;
  }

  update(dt: number, pos: THREE.Vector3, viewYaw: number, stamina: number, noise: number, tools: number): void {
    if (this.root.hidden || !this.maze) return;
    this.setMeter('stamina', stamina);
    this.setMeter('noise', noise);
    this.setMeter('tools', Math.min(1, tools / 4));
    this.toolCount.textContent = String(tools);
    this.meters.stamina.classList.toggle('low', stamina < 0.25);
    this.redraw -= dt;
    if (this.redraw > 0) return;
    this.redraw = 1 / 15;
    this.explore(pos);
    this.draw(pos, viewYaw);
  }

  private setMeter(k: 'stamina' | 'tools' | 'noise', v: number): void {
    this.meters[k].style.setProperty('--v', String(Math.round(THREE.MathUtils.clamp(v, 0, 1) * 100)));
  }

  /** Remember every trail segment that passes near the player. */
  private explore(pos: THREE.Vector3): void {
    const m = this.maze!;
    for (const e of m.edges) {
      if (this.explored.has(e.id)) continue;
      const a = m.nodes[e.a]!;
      const b = m.nodes[e.b]!;
      const abx = b.x - a.x;
      const abz = b.z - a.z;
      const t = THREE.MathUtils.clamp(((pos.x - a.x) * abx + (pos.z - a.z) * abz) / (abx * abx + abz * abz), 0, 1);
      if (Math.hypot(a.x + abx * t - pos.x, a.z + abz * t - pos.z) < REVEAL) this.explored.add(e.id);
    }
  }

  private draw(pos: THREE.Vector3, yaw: number): void {
    const ctx = this.ctx;
    const m = this.maze!;
    const c = SIZE / 2;
    const R = c - 9;
    const scale = R / RANGE;
    // View-up projection: the direction you're looking is always up on the map.
    const fx = -Math.sin(yaw);
    const fz = -Math.cos(yaw);
    const rx = Math.cos(yaw);
    const rz = -Math.sin(yaw);
    const project = (x: number, z: number): [number, number] => {
      const dx = x - pos.x;
      const dz = z - pos.z;
      return [c + (dx * rx + dz * rz) * scale, c - (dx * fx + dz * fz) * scale];
    };
    ctx.clearRect(0, 0, SIZE, SIZE);
    ctx.save();
    ctx.beginPath();
    ctx.arc(c, c, R, 0, Math.PI * 2);
    ctx.clip();
    ctx.drawImage(this.paper, 0, 0, SIZE, SIZE);
    // Explored trails: ink line with a softer halo.
    for (const [w, col] of [
      [5, 'rgba(120,90,55,0.35)'],
      [2.2, 'rgba(70,46,26,0.9)'],
    ] as const) {
      ctx.lineWidth = w;
      ctx.strokeStyle = col;
      ctx.lineCap = 'round';
      ctx.beginPath();
      for (const id of this.explored) {
        const e = m.edges[id]!;
        const a = m.nodes[e.a]!;
        const b = m.nodes[e.b]!;
        const [ax, ay] = project(a.x, a.z);
        const [bx, by] = project(b.x, b.z);
        ctx.moveTo(ax, ay);
        ctx.lineTo(bx, by);
      }
      ctx.stroke();
    }
    // Summit exit: on the map if close, else pinned to the edge.
    const exit = m.nodes[m.exit]!;
    let [ex, ey] = project(exit.x, exit.z);
    const ed = Math.hypot(ex - c, ey - c);
    if (ed > R - 10) {
      ex = c + ((ex - c) / ed) * (R - 10);
      ey = c + ((ey - c) / ed) * (R - 10);
    }
    ctx.fillStyle = '#a3261b';
    ctx.strokeStyle = '#f4e8cf';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(ex, ey - 6);
    ctx.lineTo(ex + 5, ey + 4);
    ctx.lineTo(ex - 5, ey + 4);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    // Player arrow (always pointing up = view direction).
    ctx.fillStyle = '#2c1d12';
    ctx.strokeStyle = '#f4e8cf';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(c, c - 8);
    ctx.lineTo(c + 5.5, c + 6);
    ctx.lineTo(c, c + 3);
    ctx.lineTo(c - 5.5, c + 6);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
    // Leather ring with compass letters (N = world -Z).
    ctx.lineWidth = 9;
    ctx.strokeStyle = '#3b2a1d';
    ctx.beginPath();
    ctx.arc(c, c, R + 3, 0, Math.PI * 2);
    ctx.stroke();
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(244,232,207,0.35)';
    ctx.beginPath();
    ctx.arc(c, c, R - 0.5, 0, Math.PI * 2);
    ctx.stroke();
    ctx.font = '700 9px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const [label, dx, dz] of [
      ['N', 0, -1],
      ['E', 1, 0],
      ['S', 0, 1],
      ['W', -1, 0],
    ] as const) {
      const sx = dx * rx + dz * rz;
      const sy = -(dx * fx + dz * fz);
      ctx.fillStyle = label === 'N' ? '#e9c98a' : '#d8c8a8';
      ctx.fillText(label, c + sx * (R + 3), c + sy * (R + 3));
    }
  }

  /** Aged parchment background (drawn once). */
  private makePaper(): HTMLCanvasElement {
    const p = document.createElement('canvas');
    p.width = p.height = SIZE;
    const ctx = p.getContext('2d')!;
    const g = ctx.createRadialGradient(SIZE / 2, SIZE / 2, 10, SIZE / 2, SIZE / 2, SIZE / 2);
    g.addColorStop(0, '#e2d2ae');
    g.addColorStop(1, '#b49c72');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, SIZE, SIZE);
    let seed = 99;
    const rnd = (): number => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    for (let k = 0; k < 900; k++) {
      ctx.fillStyle = `rgba(${rnd() > 0.5 ? 90 : 250},${rnd() > 0.5 ? 70 : 235},40,${0.04 + rnd() * 0.06})`;
      ctx.fillRect(rnd() * SIZE, rnd() * SIZE, 1 + rnd() * 3, 1 + rnd() * 2);
    }
    return p;
  }
}
