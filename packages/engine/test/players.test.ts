import test from 'node:test';
import assert from 'node:assert/strict';
import { ruleDefinition, type GameRecord, type GamePlayer } from '../src/model.js';
import { beginGame, applyRoll, nextRollerId } from '../src/rules.js';

function def(json: any) { return ruleDefinition.parse(json); }

function setupGame(rule: any): { game: GameRecord; players: GamePlayer[] } {
  const players: GamePlayer[] = [
    { userId: '1001', joinedAt: 0 },
    { userId: '1002', joinedAt: 1 },
    { userId: '1003', joinedAt: 2 }
  ];
  const game: GameRecord = {
    gameId: 'g1', chatId: -100, ruleId: 'r1', starterId: '1001',
    status: 'signup',
    state: { phase: { kind: 'signup' }, stepHitCounts: {}, loopCounters: {} },
    roundIdx: 0, stepIdx: 0, createdAt: 0, endedAt: null, signupMsgId: null
  };
  game.players = players;
  beginGame(game, rule);
  return { game, players };
}

test('schema: defaults minPlayers=2, maxPlayers=8 when omitted', () => {
  const d = def({ version: '1.5.0', name: 'x', rounds: [{ name: 'r', steps: [{ type: 'roll', label: 'x' }] }] });
  assert.equal(d.minPlayers, 2);
  assert.equal(d.maxPlayers, 8);
});

test('schema: explicit min/max parsed', () => {
  const d = def({ version: '1.5.0', name: 'x', minPlayers: 3, maxPlayers: 6, rounds: [{ name: 'r', steps: [{ type: 'roll', label: 'x' }] }] });
  assert.equal(d.minPlayers, 3);
  assert.equal(d.maxPlayers, 6);
});

test('schema: rejects min > max', () => {
  assert.throws(() => def({ version: '1.5.0', name: 'x', minPlayers: 5, maxPlayers: 3, rounds: [{ name: 'r', steps: [{ type: 'roll', label: 'x' }] }] }));
});

test('schema: rejects minPlayers=0', () => {
  assert.throws(() => def({ version: '1.5.0', name: 'x', minPlayers: 0, rounds: [{ name: 'r', steps: [{ type: 'roll', label: 'x' }] }] }));
});

test('schema: rejects maxPlayers>100', () => {
  assert.throws(() => def({ version: '1.5.0', name: 'x', maxPlayers: 200, rounds: [{ name: 'r', steps: [{ type: 'roll', label: 'x' }] }] }));
});

test('nextRollerId: from null picks first', () => {
  const ps = [{ userId: '1', joinedAt: 0 }, { userId: '2', joinedAt: 1 }];
  assert.equal(nextRollerId(ps, null), '1');
});

test('nextRollerId: rotates', () => {
  const ps = [{ userId: '1', joinedAt: 0 }, { userId: '2', joinedAt: 1 }, { userId: '3', joinedAt: 2 }];
  assert.equal(nextRollerId(ps, '1'), '2');
  assert.equal(nextRollerId(ps, '2'), '3');
  assert.equal(nextRollerId(ps, '3'), '1');
});

test('nextRollerId: unknown after → wraps from index 0', () => {
  const ps = [{ userId: '1', joinedAt: 0 }, { userId: '2', joinedAt: 1 }];
  assert.equal(nextRollerId(ps, '999'), '1');
});

test('nextRollerId: empty players → null', () => {
  assert.equal(nextRollerId([], null), null);
});

test('nextRollerId: 1 player → always that player', () => {
  const ps = [{ userId: '42', joinedAt: 0 }];
  assert.equal(nextRollerId(ps, null), '42');
  assert.equal(nextRollerId(ps, '42'), '42');
});

test('assignment=next_player: phase.expectedPlayerId rotates after each roll', () => {
  const rule = def({
    version: '1.5.0', name: 'rotate',
    rounds: [{ name: 'r', steps: [{ type: 'roll', label: 'x', assignment: 'next_player' }] }]
  });
  const { game, players } = setupGame(rule);
  let p = game.state.phase;
  assert.equal(p.kind, 'roll');
  if (p.kind === 'roll') {
    assert.equal(p.expectedPlayerId, '1001', 'first roller is first joined player');
  }
  applyRoll(game, rule, '1001', 3, players, '🎲');
  // After roll, advanceToStep is called but round only has 1 step → loop wraps
  // For testing rotation, set up a multi-step round.
});

test('assignment=next_player: across multiple roll steps, lastRollerId advances', () => {
  const rule = def({
    version: '1.5.0', name: 'rotate-multi',
    rounds: [{ name: 'r', steps: [
      { type: 'roll', label: 'r1', assignment: 'next_player' },
      { type: 'roll', label: 'r2', assignment: 'next_player' }
    ] }]
  });
  const { game, players } = setupGame(rule);
  let p = game.state.phase;
  if (p.kind === 'roll') assert.equal(p.expectedPlayerId, '1001');

  applyRoll(game, rule, '1001', 3, players, '🎲');
  // now at step 1
  p = game.state.phase;
  if (p.kind === 'roll') assert.equal(p.expectedPlayerId, '1002', 'next player rotates');

  applyRoll(game, rule, '1002', 4, players, '🎲');
  // step 2 doesn't exist → round ends → game ends (1 round only)
  assert.equal(game.status, 'ended');
});

test('assignment=self: same player keeps rolling', () => {
  const rule = def({
    version: '1.5.0', name: 'self',
    rounds: [{ name: 'r', steps: [
      { type: 'roll', label: 'r1', assignment: 'self' },
      { type: 'roll', label: 'r2', assignment: 'self' }
    ] }]
  });
  const { game, players } = setupGame(rule);
  let p = game.state.phase;
  if (p.kind === 'roll') assert.equal(p.expectedPlayerId, '1001');

  applyRoll(game, rule, '1001', 3, players, '🎲');
  p = game.state.phase;
  if (p.kind === 'roll') assert.equal(p.expectedPlayerId, '1001', 'self keeps the same player');
});

test('assignment=any: anyone can roll (no enforcement)', () => {
  const rule = def({
    version: '1.5.0', name: 'any',
    rounds: [{ name: 'r', steps: [{ type: 'roll', label: 'x', assignment: 'any' }] }]
  });
  const { game, players } = setupGame(rule);
  let p = game.state.phase;
  if (p.kind === 'roll') assert.equal(p.expectedPlayerId, null);

  // any userId (even non-roller) is rejected only if not joined, otherwise accepted
  assert.throws(() => applyRoll(game, rule, '9999', 3, players, '🎲'), /只有已加入的玩家/);
  applyRoll(game, rule, '1003', 3, players, '🎲'); // joined → accepted
  assert.equal(game.state.lastRollerId, '1003');
});

test('enforcement: wrong expectedPlayerId rejected', () => {
  const rule = def({
    version: '1.5.0', name: 'enforce',
    rounds: [{ name: 'r', steps: [{ type: 'roll', label: 'x', assignment: 'next_player' }] }]
  });
  const { game, players } = setupGame(rule);
  // expectedPlayerId=1001, try 1002
  assert.throws(() => applyRoll(game, rule, '1002', 3, players, '🎲'), /不是你的回合/);
});

test('enforcement: correct expectedPlayerId accepted', () => {
  const rule = def({
    version: '1.5.0', name: 'enforce',
    rounds: [{ name: 'r', steps: [{ type: 'roll', label: 'x', assignment: 'next_player' }] }]
  });
  const { game, players } = setupGame(rule);
  applyRoll(game, rule, '1001', 3, players, '🎲');
  assert.equal(game.state.lastRollerId, '1001');
});

test('lastRollerId updates on roll', () => {
  const rule = def({
    version: '1.5.0', name: 'last',
    rounds: [{ name: 'r', steps: [{ type: 'roll', label: 'x', assignment: 'any' }] }]
  });
  const { game, players } = setupGame(rule);
  assert.equal(game.state.lastRollerId, undefined);
  applyRoll(game, rule, '1003', 3, players, '🎲');
  assert.equal(game.state.lastRollerId, '1003');
});
