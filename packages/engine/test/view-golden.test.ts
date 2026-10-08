import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ruleDefinition, run, buildView, setClock,
  type RuleDefinition, type GameRecord, type GamePlayer, type Intent
} from '../src/index.js';

// 固定时钟 → lastDice.at 等时间戳确定，golden 稳定
setClock(() => 0);

const HERE = fileURLToPath(new URL('.', import.meta.url));
const GOLDEN = join(HERE, '__golden__', 'view.json');
const UPDATE = process.env.UPDATE_VIEW === '1';

const P: GamePlayer[] = [
  { userId: 9001, joinedAt: 0 },
  { userId: 9002, joinedAt: 0 },
  { userId: 9003, joinedAt: 0 }
];

function mk(def: RuleDefinition, players: GamePlayer[] = P): GameRecord {
  const g: GameRecord = {
    gameId: 'g', chatId: -100, ruleId: 'r', starterId: players[0]?.userId ?? 0, status: 'signup',
    state: { phase: { kind: 'signup' }, stepHitCounts: {}, loopCounters: {} },
    roundIdx: 0, stepIdx: 0, createdAt: 0, endedAt: null, signupMsgId: null
  };
  g.players = players;
  return g;
}
function play(def: RuleDefinition, intents: Intent[], players: GamePlayer[] = P): GameRecord {
  const g = mk(def, players);
  for (const it of intents) run(g, def, players, it);
  return g;
}

const def = ruleDefinition.parse({
  name: 'R', minPlayers: 2, maxPlayers: 3, defaultEmoji: '🎲',
  rounds: [{ name: '第一轮', loop: true, maxLoops: 4, steps: [
    { type: 'roll', label: '掷色子', emoji: '🎲' },
    { type: 'text', label: '回答', prompt: '请回答 {dice}', showActor: true },
    { type: 'punish', label: '惩罚', defaultText: '喝一口', ladder: [{ at: 2, text: '喝一杯' }] },
    { type: 'choice', label: '选择', prompt: '选一个', options: [{ text: 'A', goto: 'next' }, { text: 'B', goto: 'next' }] },
    { type: 'showdown', label: '比大小', emoji: '🎲', order: 'high', tie: 'keep' }
  ] }]
});

const cases: Record<string, unknown> = {};
cases['signup'] = buildView(mk(def), def, P, 9001, false);
cases['roll'] = buildView(play(def, [{ type: 'begin', userId: 9001 }]), def, P, 9001, true);
cases['text'] = buildView(play(def, [
  { type: 'begin', userId: 9001 }, { type: 'roll', userId: 9001, value: 4, emoji: '🎲' }
]), def, P, 9002, false);
cases['punish'] = buildView(play(def, [
  { type: 'begin', userId: 9001 }, { type: 'roll', userId: 9001, value: 3, emoji: '🎲' }, { type: 'next', userId: 9001 }
]), def, P, 9001, true);
cases['choice'] = buildView(play(def, [
  { type: 'begin', userId: 9001 }, { type: 'roll', userId: 9001, value: 3, emoji: '🎲' },
  { type: 'next', userId: 9001 }, { type: 'next', userId: 9001 }
]), def, P, 9001, true);
cases['showdown'] = buildView(play(def, [
  { type: 'begin', userId: 9001 }, { type: 'roll', userId: 9001, value: 3, emoji: '🎲' },
  { type: 'next', userId: 9001 }, { type: 'next', userId: 9001 }, { type: 'choice', userId: 9001, optionIdx: 0 },
  { type: 'showdownRoll', userId: 9001, value: 5, emoji: '🎲' }
]), def, P, 9003, false);

test('view golden: buildView 输出稳定（Mini App 契约）', () => {
  const actual = JSON.stringify(cases, null, 2) + '\n';
  if (UPDATE || !existsSync(GOLDEN)) {
    mkdirSync(join(HERE, '__golden__'), { recursive: true });
    writeFileSync(GOLDEN, actual);
    console.log(`  ↻ 录制 view golden（${Object.keys(cases).length} 例）`);
    return;
  }
  const golden = readFileSync(GOLDEN, 'utf8').replace(/\r\n/g, '\n');
  if (golden !== actual) {
    const g = golden.split('\n'), a = actual.split('\n');
    for (let i = 0; i < Math.max(g.length, a.length); i++) {
      if (g[i] !== a[i]) assert.fail(`view golden 不一致（行 ${i + 1}）：\n  golden=${JSON.stringify(g[i])}\n  actual=${JSON.stringify(a[i])}\n（更新：UPDATE_VIEW=1 pnpm --filter @tg-game/engine test）`);
    }
  }
});
