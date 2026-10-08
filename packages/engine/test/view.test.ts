import test from 'node:test';
import assert from 'node:assert/strict';
import { ruleDefinition, run, buildView, type RuleDefinition, type GameRecord, type GamePlayer } from '../src/index.js';

const P: GamePlayer[] = [{ userId: '9001', joinedAt: 0 }, { userId: '9002', joinedAt: 0 }];

function makeInitial(): GameRecord {
  const g: GameRecord = {
    gameId: 'g', chatId: -1, ruleId: 'r', starterId: '9001', status: 'signup',
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
    { type: 'text', label: 't', prompt: 'x' }
  ] }]
});

test('buildView: signup phase → kind signup', () => {
  const g = makeInitial();
  const v = buildView(g, def, P, '9001', false);
  assert.equal(v.phase.kind, 'signup');
  assert.equal(v.loopProgress, null);
  assert.equal(v.rule?.name, 'r');
  assert.equal(v.players.length, 2);
});

test('buildView: roll phase carries expectedPlayerId / emoji / stepLabel', () => {
  const g = makeInitial();
  run(g, def, P, { type: 'begin', userId: '9001' });
  const v = buildView(g, def, P, '9001', true);
  assert.equal(v.status, 'in_progress');
  assert.equal(v.phase.kind, 'roll');
  if (v.phase.kind === 'roll') {
    assert.equal(v.phase.expectedPlayerId, '9001');
    assert.equal(v.phase.emoji, '🎲');
    assert.equal(v.phase.stepLabel, '掷');
  }
  assert.equal(v.players[0].isViewer, true);
  assert.equal(v.viewer.isAdmin, true);
  assert.ok(v.loopProgress === null || typeof v.loopProgress === 'object');
});

test('buildView: showdown pending marks un-rolled players', () => {
  const sdDef = ruleDefinition.parse({
    name: 's', minPlayers: 2, maxPlayers: 2,
    rounds: [{ name: 'R', steps: [{ type: 'showdown', label: '比', emoji: '🎲' }, { type: 'text', label: 't', prompt: 'x' }] }]
  });
  const g = makeInitial();
  run(g, sdDef, P, { type: 'begin', userId: '9001' });
  run(g, sdDef, P, { type: 'showdownRoll', userId: '9001', value: 3, emoji: '🎲' });
  const v = buildView(g, sdDef, P, '9002', false);
  assert.equal(v.phase.kind, 'showdown');
  if (v.phase.kind === 'showdown') {
    assert.deepEqual(v.phase.rolls, [{ userId: '9001', value: 3 }]);
    assert.deepEqual(v.phase.pending, ['9002']);
    assert.equal(v.phase.total, 2);
  }
});
