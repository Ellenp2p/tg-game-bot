import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ruleDefinition, run, type RuleDefinition, type GameRecord, type GamePlayer, type Intent
} from '@tg-game/engine';
import { renderStatus } from '../src/render.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const GOLDEN = join(HERE, '__golden__', 'render.json');
const UPDATE = process.env.UPDATE_RENDER === '1';

const P: GamePlayer[] = [
  { userId: '9001', joinedAt: 0 },
  { userId: '9002', joinedAt: 0 },
  { userId: '9003', joinedAt: 0 }
];

function mk(def: RuleDefinition, players: GamePlayer[] = P): GameRecord {
  const g: GameRecord = {
    gameId: 'g', chatId: -1, ruleId: 'r', starterId: players[0]?.userId ?? '', status: 'signup',
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

const rollDef = ruleDefinition.parse({
  name: 'R', minPlayers: 2, maxPlayers: 3, defaultEmoji: '🎲',
  rounds: [{ name: '第一轮', loop: true, maxLoops: 4, steps: [
    { type: 'roll', label: '掷色子', emoji: '🎲' },
    { type: 'text', label: '回答', prompt: '请回答 {dice}', showActor: true },
    { type: 'punish', label: '惩罚', defaultText: '喝一口', ladder: [{ at: 2, text: '喝一杯' }] },
    { type: 'choice', label: '选择', prompt: '选一个', options: [{ text: 'A', goto: 'next' }, { text: 'B', goto: 'next' }] },
    { type: 'showdown', label: '比大小', emoji: '🎲', order: 'high', tie: 'keep' }
  ] }]
});

const slotDef = ruleDefinition.parse({
  name: 'S', minPlayers: 2, maxPlayers: 3,
  rounds: [{ name: '老虎机', steps: [
    { type: 'roll', label: '拉一把', emoji: '🎰' },
    { type: 'text', label: '结果', prompt: 'x' }
  ] }]
});

const cases: Record<string, string> = {};

// 1) signup 空
cases['signup-empty'] = renderStatus(mk(rollDef, []), rollDef, []);
// 2) signup 3 人
cases['signup-3'] = renderStatus(play(rollDef, []), rollDef, P);
// 3) roll 阶段
cases['roll'] = renderStatus(play(rollDef, [{ type: 'begin', userId: '9001' }]), rollDef, P);
// 4) text 阶段（lastDice 有）
cases['text'] = renderStatus(play(rollDef, [{ type: 'begin', userId: '9001' }, { type: 'roll', userId: '9001', value: 4, emoji: '🎲' }]), rollDef, P);
// 5) punish 阶段（第 1 次）
cases['punish'] = renderStatus(play(rollDef, [
  { type: 'begin', userId: '9001' },
  { type: 'roll', userId: '9001', value: 3, emoji: '🎲' },
  { type: 'next', userId: '9001' }
]), rollDef, P);
// 6) choice 阶段
cases['choice'] = renderStatus(play(rollDef, [
  { type: 'begin', userId: '9001' },
  { type: 'roll', userId: '9001', value: 3, emoji: '🎲' },
  { type: 'next', userId: '9001' },
  { type: 'next', userId: '9001' }
]), rollDef, P);
// 7) showdown（只掷了一人）
cases['showdown-partial'] = renderStatus(play(rollDef, [
  { type: 'begin', userId: '9001' },
  { type: 'roll', userId: '9001', value: 3, emoji: '🎲' },
  { type: 'next', userId: '9001' },
  { type: 'next', userId: '9001' },
  { type: 'choice', userId: '9001', optionIdx: 0 },
  { type: 'showdownRoll', userId: '9001', value: 5, emoji: '🎲' }
]), rollDef, P);
// 8) 老虎机 lastDice 解码（text 阶段）
cases['slot-text'] = renderStatus(play(slotDef, [
  { type: 'begin', userId: '9001' },
  { type: 'roll', userId: '9001', value: 22, emoji: '🎰' }
]), slotDef, P);

test('render golden: renderStatus 输出稳定', () => {
  const actual = JSON.stringify(cases, null, 2) + '\n';
  if (UPDATE || !existsSync(GOLDEN)) {
    mkdirSync(join(HERE, '__golden__'), { recursive: true });
    writeFileSync(GOLDEN, actual);
    console.log(`  ↻ 录制渲染 golden（${Object.keys(cases).length} 例）`);
    return;
  }
  const golden = readFileSync(GOLDEN, 'utf8').replace(/\r\n/g, '\n');
  if (golden !== actual) {
    const g = golden.split('\n'), a = actual.split('\n');
    for (let i = 0; i < Math.max(g.length, a.length); i++) {
      if (g[i] !== a[i]) {
        assert.fail(`渲染 golden 不一致（行 ${i + 1}）：\n  golden=${JSON.stringify(g[i])}\n  actual=${JSON.stringify(a[i])}\n（要更新：UPDATE_RENDER=1 pnpm --filter @tg-game/bot test）`);
      }
    }
  }
});
