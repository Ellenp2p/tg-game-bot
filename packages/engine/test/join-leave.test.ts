import test from 'node:test';
import assert from 'node:assert/strict';
import { ruleDefinition, run, type RuleDefinition, type GameRecord, type GamePlayer } from '../src/index.js';

function makeInitial(seed: GamePlayer[] = []): GameRecord {
  const g: GameRecord = {
    gameId: 'g', chatId: 0, ruleId: 'r', starterId: '0', status: 'signup',
    state: { phase: { kind: 'signup' }, stepHitCounts: {}, loopCounters: {} },
    roundIdx: 0, stepIdx: 0, createdAt: 0, endedAt: null, signupMsgId: null
  };
  g.players = seed.slice();
  return g;
}

const def: RuleDefinition = ruleDefinition.parse({
  name: 'r', minPlayers: 2, maxPlayers: 3,
  rounds: [{ name: 'R', steps: [{ type: 'text', label: 't', prompt: 'x' }] }]
});

function roster(g: GameRecord): number[] { return (g.players ?? []).map(p => p.userId); }

test('join: 报名 → 追加到名册（顺序保持）', () => {
  const g = makeInitial();
  const r1 = run(g, def, [], { type: 'join', userId: '101' });
  assert.equal(r1.ok, true);
  assert.ok(r1.ok && r1.events.some(e => e.type === 'playerJoined'));
  run(g, def, g.players!, { type: 'join', userId: '102' });
  assert.deepEqual(roster(g), ['101', '102']);
});

test('join: 重复报名被拒（ALREADY_JOINED）', () => {
  const g = makeInitial([{ userId: '101', joinedAt: 0 }]);
  const r = run(g, def, g.players!, { type: 'join', userId: '101' });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, 'ALREADY_JOINED');
});

test('join: 满员被拒（FULL）', () => {
  const g = makeInitial([{ userId: '1', joinedAt: 0 }, { userId: '2', joinedAt: 0 }, { userId: '3', joinedAt: 0 }]);
  const r = run(g, def, g.players!, { type: 'join', userId: '4' });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, 'FULL');
});

test('join: 开局后不能再报名（NOT_SIGNUP）', () => {
  const g = makeInitial([{ userId: '1', joinedAt: 0 }, { userId: '2', joinedAt: 0 }]);
  const players = g.players!;
  run(g, def, players, { type: 'begin', userId: '1' });
  assert.equal(g.status, 'in_progress');
  const r = run(g, def, g.players!, { type: 'join', userId: '9' });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, 'NOT_SIGNUP');
});

test('leave: 退出从名册移除（playerLeft）', () => {
  const g = makeInitial([{ userId: '101', joinedAt: 0 }, { userId: '102', joinedAt: 0 }]);
  const r = run(g, def, g.players!, { type: 'leave', userId: '101' });
  assert.equal(r.ok, true);
  assert.ok(r.ok && r.events.some(e => e.type === 'playerLeft'));
  assert.deepEqual(roster(g), ['102']);
});

test('leave: 未报名退出被拒（NOT_JOINED）', () => {
  const g = makeInitial([{ userId: '101', joinedAt: 0 }]);
  const r = run(g, def, g.players!, { type: 'leave', userId: '999' });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, 'NOT_JOINED');
});

test('roster 归引擎：调用方传入的数组不被污染', () => {
  const g = makeInitial();
  const shared: GamePlayer[] = [];
  run(g, def, shared, { type: 'join', userId: '101' });
  assert.deepEqual(shared, []);              // 调用方数组没被动
  assert.deepEqual(roster(g), ['101']);         // 引擎副本被更新
});
