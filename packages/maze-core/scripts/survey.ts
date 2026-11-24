/** Survey many seeds: attempts, fairness, slope distribution, timing. npm run survey */
import { generateMaze } from '../src/generator.ts';

const N = Number(process.argv[2] ?? 300);
const slopes: number[] = [];
const attempts: number[] = [];
const spreads: number[] = [];
const times: number[] = [];
const loops: number[] = [];
const deadEnds: number[] = [];
let fails = 0;
for (let seed = 1; seed <= N; seed++) {
  const t0 = performance.now();
  try {
    const m = generateMaze(seed);
    times.push(performance.now() - t0);
    attempts.push(m.stats.attempt);
    spreads.push(m.stats.fairnessSpread);
    loops.push(m.stats.loopEdges);
    deadEnds.push(m.stats.deadEnds);
    m.edges.forEach((e) => slopes.push(e.slope));
  } catch {
    fails++;
  }
}
const pct = (a: number[], p: number): number => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))] ?? NaN;
const f = (a: number[], d = 2): string => `p50 ${pct(a, 0.5).toFixed(d)}  p90 ${pct(a, 0.9).toFixed(d)}  p99 ${pct(a, 0.99).toFixed(d)}  max ${Math.max(...a).toFixed(d)}`;
console.log(`seeds ${N}  failures ${fails}`);
console.log(`attempt  ${f(attempts, 0)}`);
console.log(`spread   ${f(spreads, 3)}   over tolerance: ${spreads.filter((s) => s > 0.08).length}`);
console.log(`time ms  ${f(times, 1)}`);
console.log(`slope    ${f(slopes, 2)}   p70 ${pct(slopes, 0.7).toFixed(2)}  p80 ${pct(slopes, 0.8).toFixed(2)}  p95 ${pct(slopes, 0.95).toFixed(2)}`);
console.log(`loops    ${f(loops, 0)}   deadEnds ${f(deadEnds, 0)}`);
