import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ruleDefinition, run, applyUndo,
  type RuleDefinition, type GameRecord, type GamePlayer, type GameEventRecord
} from '../src/index.js';

const P: GamePlayer[] = [{ userId: 9001, joinedAt: 0 }, { userId: 9002, joinedAt: 0 }];

function makeInitial(): GameRecord {
  const g: GameRecord = {
    gameId: 'g', chatId: 0, ruleId: 'r', starterId: 9001, status: 'signup',
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
    { type: 'text', label: 't', prompt: 'x' },
    { type: 'choice', label: 'c', options: [{ text: 'A', goto: 'next' }, { text: 'B', goto: { roundIdx: 0, stepIdx: 0 } }] },
    { type: 'showdown', label: '比', emoji: '🎲' }
  ] }]
});

function ev(type: GameEventRecord['type'], payload: Record<string, unknown> = {}, userId = 9001): GameEventRecord {
  return { eventId: 1, gameId: 'g', userId, type, payload, createdAt: 0 };
}

test('undo: roll 清空 lastDice/lastDraw 并返回清 pending', () => {
  const g = makeInitial();
  run(g, def, P, { type: 'begin', userId: 9001 });
  run(g, def, P, { type: 'roll', userId: 9001, value: 4, emoji: '🎲' });
  assert.ok(g.state.lastDice);
  const eff = applyUndo(g, def, ev('roll', { value: 4 }));
  assert.equal(g.state.lastDice, undefined);
  assert.equal(g.state.lastDraw, undefined);
  assert.deepEqual(eff, { kind: 'clear-pending-rolls' });
});

test('undo: join/leave 返回玩家增删副作用', () => {
  const g = makeInitial();
  assert.deepEqual(applyUndo(g, def, ev('join', {}, 9003)), { kind: 'remove-player', userId: 9003 });
  assert.deepEqual(applyUndo(g, def, ev('leave', {}, 9002)), { kind: 'add-player', userId: 9002 });
});

test('undo: begin 回到报名态', () => {
  const g = makeInitial();
  run(g, def, P, { type: 'begin', userId: 9001 });
  assert.equal(g.status, 'in_progress');
  applyUndo(g, def, ev('begin', { roundIdx: 0, stepIdx: 0 }));
  assert.equal(g.status, 'signup');
  assert.equal(g.state.phase.kind, 'signup');
  assert.equal(g.stepIdx, 0);
});

test('undo: showdown 收掉最近一次骰子（仍在同一步）', () => {
  const sdDef = ruleDefinition.parse({
    name: 's', minPlayers: 2, maxPlayers: 2,
    rounds: [{ name: 'R', steps: [{ type: 'showdown', label: '比', emoji: '🎲' }, { type: 'text', label: 't', prompt: 'x' }] }]
  });
  const g = makeInitial();
  run(g, sdDef, P, { type: 'begin', userId: 9001 });
  run(g, sdDef, P, { type: 'showdownRoll', userId: 9001, value: 3, emoji: '🎲' });
  run(g, sdDef, P, { type: 'showdownRoll', userId: 9002, value: 5, emoji: '🎲' });
  // 2 人全掷 → 已结算推进到 text；先回到 showdown 再撤
  const g2 = makeInitial();
  run(g2, sdDef, P, { type: 'begin', userId: 9001 });
  run(g2, sdDef, P, { type: 'showdownRoll', userId: 9001, value: 3, emoji: '🎲' });
  assert.equal(g2.state.phase.kind, 'showdown');
  applyUndo(g2, sdDef, ev('showdown', { roundIdx: 0, stepIdx: 0 }));
  const p = g2.state.phase;
  assert.equal(p.kind, 'showdown');
  assert.equal(p.kind === 'showdown' && p.rolls.length, 0);
});

test('undo: end 恢复为进行中', () => {
  const g = makeInitial();
  g.status = 'ended';
  g.endedAt = 123;
  applyUndo(g, def, ev('end'));
  assert.equal(g.status, 'in_progress');
  assert.equal(g.endedAt, null);
});

test('undo: 未知事件类型抛错', () => {
  const g = makeInitial();
  assert.throws(() => applyUndo(g, def, ev('replace')), /不能撤销/);
});
