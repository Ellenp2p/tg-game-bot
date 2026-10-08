import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ruleDefinition, run, replay,
  type RuleDefinition, type GameRecord, type GamePlayer, type Intent
} from '../src/index.js';

const P: GamePlayer[] = [{ userId: '9001', joinedAt: 0 }, { userId: '9002', joinedAt: 0 }];

function makeInitial(): GameRecord {
  const g: GameRecord = {
    gameId: 'g', chatId: 0, ruleId: 'r', starterId: '9001', status: 'signup',
    state: { phase: { kind: 'signup' }, stepHitCounts: {}, loopCounters: {} },
    roundIdx: 0, stepIdx: 0, createdAt: 0, endedAt: null, signupMsgId: null
  };
  g.players = P;
  return g;
}

function strip(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(strip);
  if (v && typeof v === 'object') {
    const o: Record<string, unknown> = {};
    for (const k of Object.keys(v as object)) { if (k === 'at') continue; o[k] = strip((v as Record<string, unknown>)[k]); }
    return o;
  }
  return v;
}

const def: RuleDefinition = ruleDefinition.parse({
  name: 'r', minPlayers: 2, maxPlayers: 2,
  rounds: [{ name: 'R', loop: true, maxLoops: 3, steps: [
    { type: 'roll', label: '掷', emoji: '🎲' },
    { type: 'text', label: 't', prompt: 'x' }
  ] }]
});

const intents: Intent[] = [
  { type: 'begin', userId: '9001' },
  { type: 'roll', userId: '9001', value: 4, emoji: '🎲' },
  { type: 'next', userId: '9001' },
  { type: 'roll', userId: '9002', value: 2, emoji: '🎲' },
  { type: 'next', userId: '9001' }
];

test('replay: 重放意图序列得到与直接运行一致的局面', () => {
  // 直接跑
  const g1 = makeInitial();
  for (const it of intents) run(g1, def, P, it);

  // 重放
  const { game: g2, events } = replay(makeInitial, def, P, intents);

  assert.equal(JSON.stringify(strip(g1.state)), JSON.stringify(strip(g2.state)));
  assert.equal(g1.roundIdx, g2.roundIdx);
  assert.equal(g1.status, g2.status);
  assert.ok(events.length > 0);
});

test('replay: 非法意图被记录进 errors，不改变局面', () => {
  const bad: Intent[] = [
    { type: 'begin', userId: '9001' },
    { type: 'roll', userId: '9002', value: 4, emoji: '🎲' } // 不是他的回合
  ];
  const { game, errors } = replay(makeInitial, def, P, bad);
  assert.equal(errors.length, 1);
  assert.equal(game.state.phase.kind, 'roll'); // 仍停在原回合
});
