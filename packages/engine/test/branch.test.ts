import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ruleDefinition, type RuleDefinition, type GameRecord, type ShowdownResult, type GamePlayer
} from '../src/model.js';
import { advanceToStep, evaluateCondition, beginGame, applyRoll } from '../src/rules.js';

function makeGame(def: RuleDefinition, results?: Record<string, ShowdownResult>, slot = 'last'): GameRecord {
  const g: GameRecord = {
    gameId: 'g1', chatId: -100, ruleId: 'r1', starterId: 1, status: 'signup',
    state: { phase: { kind: 'signup' }, stepHitCounts: {}, loopCounters: {} },
    roundIdx: 0, stepIdx: 0, createdAt: 0, endedAt: null, signupMsgId: null
  };
  (g as GameRecord & { _players?: GamePlayer[] })._players = [{ userId: 1, joinedAt: 0 }];
  if (results) { g.state.results = results; g.state.lastResultSlot = slot; }
  return g;
}

function mk(order: 'high' | 'low' | 'none', entries: Array<[number, number]>): ShowdownResult {
  const ranking = entries.map(([userId, value]) => ({ userId, value }));
  const vals = entries.map(e => e[1]);
  const top = order === 'high' ? Math.max(...vals) : Math.min(...vals);
  const bot = order === 'high' ? Math.min(...vals) : Math.max(...vals);
  const winners = order === 'none' ? [] : entries.filter(e => e[1] === top).map(e => e[0]);
  const losers = order === 'none' ? [] : entries.filter(e => e[1] === bot).map(e => e[0]);
  const totals: Record<string, number> = {};
  for (const [u, v] of entries) totals[String(u)] = v;
  return { order, totals, ranking, winners, losers, sum: vals.reduce((a, b) => a + b, 0), max: Math.max(...vals), min: Math.min(...vals) };
}

const baseDef: RuleDefinition = ruleDefinition.parse({ name: 'b', rounds: [{ name: 'R', steps: [{ type: 'text', label: 'x', prompt: 'x' }] }] });

test('condition: tie / unique / any / all / rank / sum / count', () => {
  const g = makeGame(baseDef, { last: mk('high', [[1, 6], [2, 6], [3, 2]]) });
  assert.equal(evaluateCondition(g, 'tie'), true);
  assert.equal(evaluateCondition(g, { check: 'tie' }), true);
  assert.equal(evaluateCondition(g, { check: 'unique' }), false);
  assert.equal(evaluateCondition(g, { check: 'any', value: 6 }), true);
  assert.equal(evaluateCondition(g, { check: 'any', value: 5 }), false);
  assert.equal(evaluateCondition(g, { check: 'all', value: 6 }), false);
  assert.equal(evaluateCondition(g, { check: 'rank', pick: 1, op: 'gte', value: 6 }), true);
  assert.equal(evaluateCondition(g, { check: 'rank', pick: 3, op: 'lt', value: 3 }), true);
  assert.equal(evaluateCondition(g, { check: 'rank', pick: -1, op: 'eq', value: 2 }), true);
  assert.equal(evaluateCondition(g, { check: 'sum', op: 'eq', value: 14 }), true);
  assert.equal(evaluateCondition(g, { check: 'count', op: 'eq', value: 3 }), true);
});

test('condition: all-true only when every player matches', () => {
  const g = makeGame(baseDef, { last: mk('high', [[1, 6], [2, 6], [3, 6]]) });
  assert.equal(evaluateCondition(g, { check: 'all', value: 6 }), true);
  assert.equal(evaluateCondition(g, { check: 'unique' }), false);
});

test('condition: named slot lookup', () => {
  const g = makeGame(baseDef, { score: mk('high', [[1, 1], [2, 2], [3, 2]]) }, 'score');
  assert.equal(evaluateCondition(g, { slot: 'score', check: 'tie' }), true);
  assert.equal(evaluateCondition(g, { slot: 'missing', check: 'tie' }), false);
});

test('condition: no results → false except count of 0', () => {
  const g = makeGame(baseDef);
  assert.equal(evaluateCondition(g, 'tie'), false);
  assert.equal(evaluateCondition(g, { check: 'any', value: 1 }), false);
  assert.equal(evaluateCondition(g, { check: 'sum', op: 'gt', value: 0 }), false);
  assert.equal(evaluateCondition(g, { check: 'count', op: 'eq', value: 0 }), true);
});

function branchDef(cases: unknown[], defGoto: unknown = 'next', maxHits = 50): RuleDefinition {
  return ruleDefinition.parse({
    name: 'br',
    rounds: [{
      name: 'R',
      steps: [
        { type: 'branch', label: 'b', cases, default: defGoto, maxHits },
        { type: 'text', label: 'default path', prompt: 'DEFAULT' },
        { type: 'text', label: 'case path', prompt: 'CASE' }
      ]
    }]
  });
}

test('branch: matching case jumps to its goto', () => {
  const def = branchDef([{ if: { check: 'any', value: 6 }, goto: { roundIdx: 0, stepIdx: 2 } }]);
  const g = makeGame(def, { last: mk('high', [[1, 6], [2, 1], [3, 2]]) });
  advanceToStep(g, def, 0, 0);
  assert.equal(g.state.phase.kind, 'text');
  assert.equal(g.state.phase.kind === 'text' && g.state.phase.text, 'CASE');
});

test('branch: no match → default (next)', () => {
  const def = branchDef([{ if: { check: 'any', value: 6 }, goto: { roundIdx: 0, stepIdx: 2 } }]);
  const g = makeGame(def, { last: mk('high', [[1, 1], [2, 2], [3, 3]]) });
  advanceToStep(g, def, 0, 0);
  assert.equal(g.state.phase.kind === 'text' && g.state.phase.text, 'DEFAULT');
});

test('branch: maxHits breaks self-loops and forces forward', () => {
  const def = branchDef([{ if: { check: 'any', value: 99 }, goto: 'next' }], { roundIdx: 0, stepIdx: 0 }, 3);
  const g = makeGame(def, { last: mk('high', [[1, 1]]) });
  advanceToStep(g, def, 0, 0);
  assert.equal(g.state.phase.kind === 'text' && g.state.phase.text, 'DEFAULT');
});

test('condition: dice compares the last single roll', () => {
  const g = makeGame(baseDef);
  assert.equal(evaluateCondition(g, { check: 'dice', op: 'eq', value: 6 }), false); // 还没掷
  g.state.lastDice = { userId: 1, value: 6, at: 0, emoji: '🎲' };
  assert.equal(evaluateCondition(g, { check: 'dice', op: 'eq', value: 6 }), true);
  assert.equal(evaluateCondition(g, { check: 'dice', op: 'lte', value: 2 }), false);
  assert.equal(evaluateCondition(g, { check: 'dice', op: 'gte', value: 6 }), true);
  assert.equal(evaluateCondition(g, { check: 'dice', op: 'ne', value: 6 }), false);
});

test('branch: routes on the last roll value', () => {
  const def = ruleDefinition.parse({
    name: 'dicebranch', minPlayers: 1, maxPlayers: 4,
    rounds: [{
      name: 'R',
      steps: [
        { type: 'roll', label: 'roll' },
        {
          type: 'branch', label: 'by dice',
          cases: [{ if: { check: 'dice', op: 'eq', value: 6 }, goto: { roundIdx: 0, stepIdx: 3 } }],
          default: 'next'
        },
        { type: 'text', label: 'low', prompt: 'LOW' },
        { type: 'text', label: 'six', prompt: 'SIX' }
      ]
    }]
  });
  const players: GamePlayer[] = [{ userId: 1, joinedAt: 0 }];
  const g6 = makeGame(def);
  (g6 as GameRecord & { _players?: GamePlayer[] })._players = players;
  beginGame(g6, def);
  applyRoll(g6, def, 1, 6, players, '🎲');
  assert.equal(g6.state.phase.kind === 'text' && g6.state.phase.text, 'SIX');

  const g3 = makeGame(def);
  (g3 as GameRecord & { _players?: GamePlayer[] })._players = players;
  beginGame(g3, def);
  applyRoll(g3, def, 1, 3, players, '🎲');
  assert.equal(g3.state.phase.kind === 'text' && g3.state.phase.text, 'LOW');
});

test('branch: schema rejects empty cases', () => {
  assert.throws(() => ruleDefinition.parse({
    name: 'bad',
    rounds: [{ name: 'R', steps: [{ type: 'branch', label: 'b', cases: [] }] }]
  }));
});
