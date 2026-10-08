import test from 'node:test';
import assert from 'node:assert/strict';
import { ruleDefinition, type RuleDefinition, type GameRecord, type GamePlayer } from '../src/model.js';
import { applyRoll, applyNext, beginGame, drawBucket, formatTemplate } from '../src/rules.js';

const PLAYERS: GamePlayer[] = [
  { userId: '1', joinedAt: 0 },
  { userId: '2', joinedAt: 0 }
];

function newGame(def: RuleDefinition, ps: GamePlayer[] = PLAYERS): GameRecord {
  const g: GameRecord = {
    gameId: 'g1', chatId: -100, ruleId: 'r1', starterId: ps[0].userId, status: 'signup',
    state: { phase: { kind: 'signup' }, stepHitCounts: {}, loopCounters: {} },
    roundIdx: 0, stepIdx: 0, createdAt: 0, endedAt: null, signupMsgId: null
  };
  g.players = ps;
  beginGame(g, def);
  return g;
}

function drawDef(count: number, uniform: 'equal' | 'exact' = 'equal'): RuleDefinition {
  const targets: unknown[] = [];
  for (let i = 1; i <= count; i++) targets.push(i < count ? { roundIdx: 0, stepIdx: 1 } : { roundIdx: 0, stepIdx: 2 });
  return ruleDefinition.parse({
    name: 'draw', minPlayers: 2, maxPlayers: 4,
    rounds: [{
      name: 'R',
      steps: [
        { type: 'roll', label: '抽签', emoji: '🎰', assignment: 'next_player', draw: { count, uniform, store: 'box', targets } },
        { type: 'text', label: '普通', prompt: '普通 {draw}', next: 'end' },
        { type: 'text', label: '顶格', prompt: '顶格 {draw}', next: 'end' }
      ]
    }]
  });
}

test('drawBucket: equal spacing over 64', () => {
  assert.equal(drawBucket(1, 16, 'equal', 64), 1);
  assert.equal(drawBucket(4, 16, 'equal', 64), 1);
  assert.equal(drawBucket(5, 16, 'equal', 64), 2);
  assert.equal(drawBucket(64, 16, 'equal', 64), 16);
  // N=10
  assert.equal(drawBucket(7, 10, 'equal', 64), 1);
  assert.equal(drawBucket(8, 10, 'equal', 64), 2);
  assert.equal(drawBucket(64, 10, 'equal', 64), 10);
});

test('drawBucket: exact uses equal-width buckets up to M', () => {
  // N=10 → M=60, w=6
  assert.equal(drawBucket(1, 10, 'exact', 64), 1);
  assert.equal(drawBucket(6, 10, 'exact', 64), 1);
  assert.equal(drawBucket(7, 10, 'exact', 64), 2);
  assert.equal(drawBucket(60, 10, 'exact', 64), 10);
});

test('drawBucket: works with smaller dice source', () => {
  assert.equal(drawBucket(1, 6, 'equal', 6), 1);
  assert.equal(drawBucket(6, 6, 'equal', 6), 6);
  assert.equal(drawBucket(3, 3, 'equal', 6), 2);
});

test('roll.draw jumps to the bucket target, stores number, {draw} renders', () => {
  const def = drawDef(16, 'exact'); // w=4
  const g = newGame(def);
  const r = applyRoll(g, def, '1', 4, PLAYERS, '🎰'); // bucket 1 -> step 1
  assert.equal(g.state.phase.kind, 'text');
  assert.equal(g.state.phase.kind === 'text' && g.state.phase.stepIdx, 1);
  assert.equal(g.state.lastDraw, 1);
  assert.equal(g.state.draws?.box, 1);
  assert.match(r.message, /第 <b>1<\/b> 号/);

  const g2 = newGame(def);
  applyRoll(g2, def, '1', 64, PLAYERS, '🎰'); // bucket 16 -> step 2
  assert.equal(g2.state.phase.kind === 'text' && g2.state.phase.stepIdx, 2);
  assert.equal(g2.state.lastDraw, 16);
  assert.equal(formatTemplate('{draw} / {draw.box}', g2, 'plain'), '16 / 16');
});

test('roll.draw exact rejects out-of-range roll without advancing', () => {
  const def = drawDef(10, 'exact'); // M=60
  const g = newGame(def);
  const r = applyRoll(g, def, '1', 61, PLAYERS, '🎰');
  assert.match(r.message, /再抽一次/);
  assert.equal(g.state.phase.kind, 'roll');
  assert.equal(g.state.lastDraw, undefined);
});

test('roll.draw requires targets.length === count', () => {
  assert.throws(() => ruleDefinition.parse({
    name: 'bad',
    rounds: [{ name: 'R', steps: [{ type: 'roll', label: 'x', draw: { count: 4, targets: ['next'] } }] }]
  }));
});

test('roll.draw count cannot exceed the dice range', () => {
  const def = ruleDefinition.parse({
    name: 'over', minPlayers: 2, maxPlayers: 4,
    rounds: [{ name: 'R', steps: [
      { type: 'roll', label: 'x', emoji: '🎲', draw: { count: 10, targets: Array.from({ length: 10 }, () => 'next') } },
      { type: 'text', label: 'y', prompt: 'y' }
    ] }]
  });
  const g = newGame(def);
  assert.throws(() => applyRoll(g, def, '1', 3, PLAYERS, '🎲'), /超过/);
});

test('goto "end" ends the round (and terminates a bounded loop)', () => {
  const def = ruleDefinition.parse({
    name: 'e',
    rounds: [{ name: 'R', loop: true, maxLoops: 2, steps: [
      { type: 'branch', label: 'b', cases: [{ if: { check: 'count', op: 'gte', value: 99 }, goto: 'next' }], default: 'end' },
      { type: 'text', label: 'never', prompt: 'x' }
    ] }]
  });
  const g = newGame(def);
  assert.equal(g.status, 'ended');
  assert.equal(g.state.loopCounters['0'], 2);
});

test('choice option goto "end" ends the round', () => {
  const def = ruleDefinition.parse({
    name: 'ce',
    rounds: [{ name: 'R', steps: [
      { type: 'choice', label: 'c', chooser: 'any', options: [
        { text: 'A', goto: 'end' },
        { text: 'B', goto: 'end' }
      ] }
    ] }]
  });
  const g = newGame(def);
  // 直接调用 applyNext（管理员强制选第一个 -> end）
  applyNext(g, def, '1');
  assert.equal(g.status, 'ended');
});

test('text.next "end" ends the round via applyNext', () => {
  const def = ruleDefinition.parse({
    name: 't',
    rounds: [{ name: 'R', steps: [
      { type: 'text', label: 'a', prompt: 'a', next: 'end' },
      { type: 'text', label: 'b', prompt: 'b' }
    ] }]
  });
  const g = newGame(def);
  applyNext(g, def, '1');
  assert.equal(g.status, 'ended');
});

test('limits raised: 16-case branch and 60-step round parse', () => {
  const cases = Array.from({ length: 16 }, (_, i) => ({ if: { check: 'dice', op: 'lte', value: i + 1 }, goto: 'next' }));
  const steps: unknown[] = [{ type: 'branch', label: 'b', cases, default: 'next' }];
  for (let i = 0; i < 59; i++) steps.push({ type: 'text', label: 't' + i, prompt: 'x' });
  const def = ruleDefinition.parse({ name: 'big', rounds: [{ name: 'R', steps }] });
  assert.equal(def.rounds[0].steps.length, 60);
});
