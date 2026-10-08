import test from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../src/db.js';
import { applyNext, applyRoll, beginGame, applyChoice } from '../../engine/src/index.js';
import { ruleDefinition, type RuleDefinition } from '../../engine/src/index.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const loopRule = (maxLoops?: number): RuleDefinition => ruleDefinition.parse({
  version: '1.3.0',
  name: 'loop test',
  rounds: [
    {
      name: 'R1',
      loop: true,
      ...(maxLoops !== undefined ? { maxLoops } : {}),
      steps: [
        { type: 'roll', label: '谁' },
        { type: 'punish', label: '罚', defaultText: '喝一口', ladder: [
          { at: 2, text: '喝两杯' },
          { at: 3, text: '喝三杯' }
        ]}
      ]
    }
  ]
});

function setup(maxLoops?: number) {
  const dir = mkdtempSync(join(tmpdir(), 'loop-'));
  const db = new Db(join(dir, 'bot.sqlite'));
  db.touchUser(1001);
  const rule = db.createRule(1001, 'loop', loopRule(maxLoops));
  const game = db.createGame(-100, rule.ruleId, 1001);
  db.addPlayer(game.gameId, 2001);
  return { dir, db, rule, game };
}
function teardown(ctx: { dir: string; db: Db }) { ctx.db.close(); rmSync(ctx.dir, { recursive: true, force: true }); }

test('maxLoops: undefined = infinite loop (legacy behavior)', () => {
  const ctx = setup(undefined);
  try {
    beginGame(ctx.game, ctx.rule.definition);
    for (let i = 0; i < 20; i++) {
      applyRoll(ctx.game, ctx.rule.definition, 2001, 3, ctx.db.listPlayers(ctx.game.gameId));
      applyNext(ctx.game, ctx.rule.definition, 1001);
    }
    assert.equal(ctx.game.status, 'in_progress');
    assert.equal(ctx.game.state.loopCounters['0'], 20);
  } finally { teardown(ctx); }
});

test('maxLoops: 1 = single pass then end', () => {
  const ctx = setup(1);
  try {
    beginGame(ctx.game, ctx.rule.definition);
    applyRoll(ctx.game, ctx.rule.definition, 2001, 3, ctx.db.listPlayers(ctx.game.gameId));
    applyNext(ctx.game, ctx.rule.definition, 1001);
    // steps ran out, no more loops
    assert.equal(ctx.game.status, 'ended');
    assert.equal(ctx.game.state.loopCounters['0'], 1);
  } finally { teardown(ctx); }
});

test('maxLoops: 3 = three passes then end', () => {
  const ctx = setup(3);
  try {
    beginGame(ctx.game, ctx.rule.definition);
    for (let i = 0; i < 3; i++) {
      assert.equal(ctx.game.status, 'in_progress', `should still be in_progress before pass ${i + 1}`);
      applyRoll(ctx.game, ctx.rule.definition, 2001, 3, ctx.db.listPlayers(ctx.game.gameId));
      applyNext(ctx.game, ctx.rule.definition, 1001);
    }
    assert.equal(ctx.game.status, 'ended');
    assert.equal(ctx.game.state.loopCounters['0'], 3);
  } finally { teardown(ctx); }
});

test('maxLoops: punish ladder escalates across loops', () => {
  const ctx = setup(3);
  try {
    beginGame(ctx.game, ctx.rule.definition);
    const texts: string[] = [];
    for (let i = 0; i < 3; i++) {
      applyRoll(ctx.game, ctx.rule.definition, 2001, 3, ctx.db.listPlayers(ctx.game.gameId));
      const phase = ctx.game.state.phase;
      assert.equal(phase.kind, 'punish');
      if (phase.kind === 'punish') texts.push(phase.text);
      applyNext(ctx.game, ctx.rule.definition, 1001); // punish → loop back to roll
    }
    assert.equal(texts[0], '喝一口');
    assert.equal(texts[1], '喝两杯');
    assert.equal(texts[2], '喝三杯');
    assert.equal(ctx.game.status, 'ended');
  } finally { teardown(ctx); }
});

test('maxLoops: 0 rejected by schema', () => {
  assert.throws(() => ruleDefinition.parse({
    version: '1.3.0', name: 'bad',
    rounds: [{ name: 'R', loop: true, maxLoops: 0, steps: [{ type: 'roll', label: 'x' }] }]
  }));
});

test('maxLoops: 1000 rejected by schema (max 100)', () => {
  assert.throws(() => ruleDefinition.parse({
    version: '1.3.0', name: 'bad',
    rounds: [{ name: 'R', loop: true, maxLoops: 1000, steps: [{ type: 'roll', label: 'x' }] }]
  }));
});

test('maxLoops: with multi-round, last round maxLoops controls end', () => {
  const multiRule = ruleDefinition.parse({
    version: '1.3.0', name: 'multi',
    rounds: [
      {
        name: 'R1', loop: true, maxLoops: 2,
        steps: [{ type: 'roll', label: 'r1' }, { type: 'text', label: 'r1t', prompt: 'q1' }]
      },
      {
        name: 'R2', loop: true, maxLoops: 1,
        steps: [{ type: 'roll', label: 'r2' }, { type: 'text', label: 'r2t', prompt: 'q2' }]
      }
    ]
  });
  const dir = mkdtempSync(join(tmpdir(), 'multi-'));
  const db = new Db(join(dir, 'bot.sqlite'));
  try {
    db.touchUser(1001);
    const rule = db.createRule(1001, 'multi', multiRule);
    const game = db.createGame(-100, rule.ruleId, 1001);
    db.addPlayer(game.gameId, 2001);
    beginGame(game, rule.definition);
    // R1: 2 passes then → R2
    for (let i = 0; i < 2; i++) {
      applyRoll(game, rule.definition, 2001, 3, db.listPlayers(game.gameId));
      applyNext(game, rule.definition, 1001);
    }
    assert.equal(game.roundIdx, 1);
    assert.equal(game.state.loopCounters['0'], 2);
    // R2: 1 pass then end
    applyRoll(game, rule.definition, 2001, 3, db.listPlayers(game.gameId));
    applyNext(game, rule.definition, 1001);
    assert.equal(game.status, 'ended');
    assert.equal(game.state.loopCounters['1'], 1);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});
