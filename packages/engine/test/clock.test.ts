import test from 'node:test';
import assert from 'node:assert/strict';
import { ruleDefinition, run, setClock, resetClock, type RuleDefinition, type GameRecord, type GamePlayer } from '../src/index.js';

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

const def: RuleDefinition = ruleDefinition.parse({
  name: 'r', minPlayers: 2, maxPlayers: 2,
  rounds: [{ name: 'R', steps: [
    { type: 'roll', label: '掷', emoji: '🎲' },
    { type: 'showdown', label: '比', emoji: '🎲' },
    { type: 'text', label: 't', prompt: 'x' }
  ] }]
});

test('clock: setClock 让引擎时间戳完全确定', () => {
  setClock(() => 1234567);
  try {
    const g = makeInitial();
    run(g, def, P, { type: 'begin', userId: '9001' });
    run(g, def, P, { type: 'roll', userId: '9001', value: 3, emoji: '🎲' });
    assert.equal(g.state.lastDice?.at, 1234567);
    run(g, def, P, { type: 'next', userId: '9001' }); // 进入 showdown
    run(g, def, P, { type: 'showdownRoll', userId: '9001', value: 5, emoji: '🎲' });
    const phase = g.state.phase;
    if (phase.kind === 'showdown') assert.equal(phase.rolls[0].at, 1234567);
  } finally {
    resetClock();
  }
});

test('clock: 默认时钟可读（resetClock 后）', () => {
  const before = Date.now();
  const g = makeInitial();
  run(g, def, P, { type: 'begin', userId: '9001' });
  run(g, def, P, { type: 'roll', userId: '9001', value: 3, emoji: '🎲' });
  const at = g.state.lastDice?.at ?? 0;
  assert.ok(at >= before && at <= Date.now() + 1000);
});
