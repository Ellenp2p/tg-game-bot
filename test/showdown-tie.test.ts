import test from 'node:test';
import assert from 'node:assert/strict';
import { ruleDefinition, type RuleDefinition, type GameRecord, type GamePlayer } from '../src/model.js';
import { beginGame, applyShowdownRoll, resolveActorPick } from '../src/rules.js';

// 故意让「加入顺序」与「名次顺序」不同：#9002 先加入，但 #9001 的 userId 更小
const P: GamePlayer[] = [
  { userId: 9002, joinedAt: 0 },
  { userId: 9001, joinedAt: 0 },
  { userId: 9003, joinedAt: 0 }
];

function newGame(def: RuleDefinition, ps: GamePlayer[] = P): GameRecord {
  const g: GameRecord = {
    gameId: 'g1', chatId: -100, ruleId: 'r1', starterId: ps[0].userId, status: 'signup',
    state: { phase: { kind: 'signup' }, stepHitCounts: {}, loopCounters: {} },
    roundIdx: 0, stepIdx: 0, createdAt: 0, endedAt: null, signupMsgId: null
  };
  (g as GameRecord & { _players?: GamePlayer[] })._players = ps;
  beginGame(g, def);
  return g;
}

function sd(tie: 'keep' | 'first' | 'reroll'): RuleDefinition {
  return ruleDefinition.parse({
    name: 't', minPlayers: 3, maxPlayers: 3,
    rounds: [{
      name: 'R',
      steps: [
        { type: 'showdown', label: '比大小', emoji: '🎲', order: 'high', tie, actor: 'winner' },
        { type: 'text', label: 'next', prompt: 'x' }
      ]
    }]
  });
}

test('resolveActorPick 并列时按名次顺序取最前者（与看板一致）', () => {
  const def = sd('keep');
  const g = newGame(def);
  applyShowdownRoll(g, def, 9002, 4, P, '🎲');
  applyShowdownRoll(g, def, 9001, 4, P, '🎲');
  applyShowdownRoll(g, def, 9003, 1, P, '🎲');
  const res = g.state.results!['last'];
  assert.deepEqual(res.ranking.map(e => e.userId), [9001, 9002, 9003]);
  assert.deepEqual(res.winners, [9001, 9002]);
  // 老实现会取加入顺序最前的 #9002；现在应与名次第一 #9001 一致
  assert.equal(resolveActorPick(g, P, 'winner'), 9001);
});

test('showdown 结果消息里点名 赢家/输家', () => {
  const def = sd('keep');
  const g = newGame(def);
  applyShowdownRoll(g, def, 9002, 5, P, '🎲');
  applyShowdownRoll(g, def, 9001, 2, P, '🎲');
  const last = applyShowdownRoll(g, def, 9003, 1, P, '🎲');
  assert.match(last.message, /👉 赢家：/);
  assert.match(last.message, /输家：/);
});

test("tie:'reroll' 并列时清空本轮、不写结果、不推进", () => {
  const def = sd('reroll');
  const g = newGame(def);
  g.state.showdownBoardMsgId = 12345;
  applyShowdownRoll(g, def, 9002, 4, P, '🎲');
  applyShowdownRoll(g, def, 9001, 4, P, '🎲');
  const last = applyShowdownRoll(g, def, 9003, 1, P, '🎲');
  assert.equal(last.settled, true);
  assert.match(last.message, /并列/);
  assert.equal(g.state.phase.kind, 'showdown');
  assert.equal(g.state.phase.kind === 'showdown' && g.state.phase.rolls.length, 0);
  assert.equal(g.state.results, undefined);
  assert.equal(g.state.showdownBoardMsgId, undefined);
  assert.equal(g.status, 'in_progress');
});

test("tie:'reroll' 输家并列也触发重掷", () => {
  const def = sd('reroll');
  const g = newGame(def);
  applyShowdownRoll(g, def, 9002, 6, P, '🎲');
  applyShowdownRoll(g, def, 9001, 4, P, '🎲');
  const last = applyShowdownRoll(g, def, 9003, 4, P, '🎲');
  assert.match(last.message, /并列/);
  assert.equal(g.state.phase.kind, 'showdown');
  assert.equal(g.state.phase.kind === 'showdown' && g.state.phase.rolls.length, 0);
});

test("tie:'reroll' 重掷后产生唯一赢家 → 正常结算推进", () => {
  const def = sd('reroll');
  const g = newGame(def);
  applyShowdownRoll(g, def, 9002, 6, P, '🎲');
  applyShowdownRoll(g, def, 9001, 6, P, '🎲');
  applyShowdownRoll(g, def, 9003, 1, P, '🎲'); // 触发重掷
  assert.equal(applyShowdownRoll(g, def, 9002, 2, P, '🎲').settled, false);
  applyShowdownRoll(g, def, 9001, 5, P, '🎲');
  const r = applyShowdownRoll(g, def, 9003, 3, P, '🎲');
  assert.equal(r.settled, true);
  assert.equal(g.state.phase.kind, 'text');
  assert.deepEqual(g.state.results!['last'].winners, [9001]);
  assert.equal(resolveActorPick(g, P, 'winner'), 9001);
  assert.match(r.message, /👉 赢家：/);
});
