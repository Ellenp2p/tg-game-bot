#!/usr/bin/env tsx
/** 从 examples/*.json 生成 playthrough spec（min / max 两种取值），S0 种子。 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ruleDefinition } from '../packages/engine/src/index.js';

const EXAMPLES = join(process.cwd(), 'examples');
const SPECS = join(process.cwd(), 'specs');

const files = readdirSync(EXAMPLES).filter(f => f.endsWith('.json')).sort();
let n = 0;
for (const f of files) {
  const def = ruleDefinition.parse(JSON.parse(readFileSync(join(EXAMPLES, f), 'utf8')));
  const count = Math.min(Math.max(def.minPlayers, 1), def.maxPlayers);
  const players = Array.from({ length: count }, (_, i) => 2001 + i);
  const totalSteps = def.rounds.reduce((s, r) => s + r.steps.length, 0);
  const maxLoops = def.rounds.reduce((m, r) => Math.max(m, r.loop ? (r.maxLoops ?? 99) : 1), 1);
  const maxOps = totalSteps * maxLoops * (count + 1) + 200;
  const stem = f.replace(/\.json$/, '');
  for (const value of ['min', 'max'] as const) {
    const spec = {
      kind: 'playthrough',
      name: `${stem}.${value}`,
      rule: `examples/${f}`,
      players,
      policy: { value, choice: 0, maxOps }
    };
    writeFileSync(join(SPECS, `example-${stem}.${value}.spec.json`), JSON.stringify(spec, null, 2) + '\n');
    n++;
  }
}
console.log(`generated ${n} playthrough specs from ${files.length} examples`);
