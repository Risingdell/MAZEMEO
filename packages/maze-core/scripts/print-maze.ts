/**
 * CLI: print maze stats for one or more seeds.
 *   npm run maze -- 42
 *   npm run maze -- 1 2 3 4 5
 */
import { generateMaze } from '../src/generator.ts';
import { mazeChecksum } from '../src/checksum.ts';
import { buildField } from '../src/field.ts';

const seeds = process.argv.slice(2).map(Number).filter(Number.isFinite);
if (seeds.length === 0) seeds.push(42);

for (const seed of seeds) {
  const t0 = performance.now();
  const maze = generateMaze(seed);
  const t1 = performance.now();
  buildField(maze);
  const t2 = performance.now();
  const s = maze.stats;
  console.log(`\n=== seed ${seed}  checksum ${mazeChecksum(maze)} ===`);
  console.log(`generate ${(t1 - t0).toFixed(1)} ms   field ${(t2 - t1).toFixed(1)} ms   attempt #${s.attempt}`);
  console.log(`nodes ${s.nodes}  edges ${s.edges} (tree ${s.treeEdges} + loops ${s.loopEdges})`);
  console.log(`edge kinds: path ${s.edgeKinds.path}  climb ${s.edgeKinds.climb}  grapple ${s.edgeKinds.grapple}`);
  console.log(`dead ends ${s.deadEnds}  caches ${s.caches}`);
  console.log(`spawn cost ${s.minSpawnCost.toFixed(0)}..${s.maxSpawnCost.toFixed(0)}  fairness spread ${(s.fairnessSpread * 100).toFixed(1)}%`);
  for (const r of maze.regions) console.log(`  region ${r.id} ${r.name.padEnd(15)} nodes ${String(r.nodeIds.length).padStart(3)}  neighbours [${r.neighbors.join(',')}]`);
}
