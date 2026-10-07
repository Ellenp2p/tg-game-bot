import test from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../src/db.js';
import { advanceToStep, applyChoice, applyNext, applyRoll, applySkip, beginGame } from '../src/rules.js';
import { ruleDefinition, type RuleDefinition } from '../src/model.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const choiceRule = (): RuleDefinition => ruleDefinition.parse({
  version: '1.3.0',
  name: 'choice test',
  rounds: [
    {
      name: 'R1',
      steps: [
        { type: 'roll', label: '谁' },
        {
          type: 'choice',
          label: '选',
          options: [
            { text: '真心话', goto: 'next' },
            { text: '大冒险', goto: { roundIdx: 0, stepIdx: 3 } }
          ]
        },
        { type: 'text', label: '真心话', prompt: '回答' },
        { type: 'text', label: '大冒险', prompt: '做任务' },
        { type: 'punish', label: '惩罚', defaultText: '喝一口' }
      ]
    }
  ]
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'choice-'));
  const db = new Db(join(dir, 'bot.sqlite'));
  db.touchUser(1001);
  const rule = db.createRule(1001, 'choice', choiceRule());
  const game = db.createGame(-100, rule.ruleId, 1001);
  db.addPlayer(game.gameId, 2001);
  db.addPlayer(game.gameId, 2002);
  return { dir, db, rule, game };
}
function teardown(ctx: { dir: string; db: Db }) { ctx.db.close(); rmSync(ctx.dir, { recursive: true, force: true }); }

test('choice: defaults pickedBy to lastDice.userId after roll', () => {
  const ctx = setup();
  try {
    beginGame(ctx.game, ctx.rule.definition);
    applyRoll(ctx.game, ctx.rule.definition, 2001, 4, ctx.db.listPlayers(ctx.game.gameId));
    const phase = ctx.game.state.phase;
    assert.equal(phase.kind, 'choice');
    if (phase.kind === 'choice') {
      assert.equal(phase.pickedBy, 2001);
      assert.equal(phase.options.length, 2);
      assert.equal(phase.options[0].text, '真心话');
      assert.equal(phase.options[1].text, '大冒险');
    }
  } finally { teardown(ctx); }
});

test('choice: applyChoice "next" jumps to step+1', () => {
  const ctx = setup();
  try {
    beginGame(ctx.game, ctx.rule.definition);
    applyRoll(ctx.game, ctx.rule.definition, 2001, 4, ctx.db.listPlayers(ctx.game.gameId));
    applyChoice(ctx.game, ctx.rule.definition, 2001, 0);
    const phase = ctx.game.state.phase;
    assert.equal(phase.kind, 'text');
    if (phase.kind === 'text') assert.equal(phase.text, '回答');
  } finally { teardown(ctx); }
});

test('choice: applyChoice explicit goto jumps to arbitrary step', () => {
  const ctx = setup();
  try {
    beginGame(ctx.game, ctx.rule.definition);
    applyRoll(ctx.game, ctx.rule.definition, 2001, 4, ctx.db.listPlayers(ctx.game.gameId));
    applyChoice(ctx.game, ctx.rule.definition, 2001, 1);
    const phase = ctx.game.state.phase;
    assert.equal(phase.kind, 'text');
    if (phase.kind === 'text') assert.equal(phase.text, '做任务');
  } finally { teardown(ctx); }
});

test('choice: wrong user gets rejected', () => {
  const ctx = setup();
  try {
    beginGame(ctx.game, ctx.rule.definition);
    applyRoll(ctx.game, ctx.rule.definition, 2001, 4, ctx.db.listPlayers(ctx.game.gameId));
    assert.throws(() => applyChoice(ctx.game, ctx.rule.definition, 2002, 0), /不是你的回合/);
  } finally { teardown(ctx); }
});

test('choice: invalid optionIdx throws', () => {
  const ctx = setup();
  try {
    beginGame(ctx.game, ctx.rule.definition);
    applyRoll(ctx.game, ctx.rule.definition, 2001, 4, ctx.db.listPlayers(ctx.game.gameId));
    assert.throws(() => applyChoice(ctx.game, ctx.rule.definition, 2001, 5), /选项不存在/);
  } finally { teardown(ctx); }
});

test('choice: applyNext on choice phase picks option 0', () => {
  const ctx = setup();
  try {
    beginGame(ctx.game, ctx.rule.definition);
    applyRoll(ctx.game, ctx.rule.definition, 2001, 4, ctx.db.listPlayers(ctx.game.gameId));
    applyNext(ctx.game, ctx.rule.definition, 1001);
    const phase = ctx.game.state.phase;
    assert.equal(phase.kind, 'text');
    if (phase.kind === 'text') assert.equal(phase.text, '回答');
  } finally { teardown(ctx); }
});

test('choice: applySkip on choice phase also picks option 0', () => {
  const ctx = setup();
  try {
    beginGame(ctx.game, ctx.rule.definition);
    applyRoll(ctx.game, ctx.rule.definition, 2001, 4, ctx.db.listPlayers(ctx.game.gameId));
    applySkip(ctx.game, ctx.rule.definition);
    const phase = ctx.game.state.phase;
    assert.equal(phase.kind, 'text');
    if (phase.kind === 'text') assert.equal(phase.text, '回答');
  } finally { teardown(ctx); }
});

test('choice: applyNext on non-choice phase advances step+1', () => {
  const ctx = setup();
  try {
    beginGame(ctx.game, ctx.rule.definition);
    applyRoll(ctx.game, ctx.rule.definition, 2001, 4, ctx.db.listPlayers(ctx.game.gameId));
    applyChoice(ctx.game, ctx.rule.definition, 2001, 0); // → step 2 (text "回答")
    assert.equal(ctx.game.state.phase.kind, 'text');
    const beforeStepIdx = ctx.game.state.phase.kind === 'text' ? ctx.game.state.phase.stepIdx : -1;
    applyNext(ctx.game, ctx.rule.definition, 1001); // text step 2 → step 3 (text "做任务")
    const after = ctx.game.state.phase;
    assert.equal(after.kind, 'text');
    if (after.kind === 'text') {
      assert.equal(after.stepIdx, beforeStepIdx + 1);
    }
    applyNext(ctx.game, ctx.rule.definition, 1001); // step 3 → step 4 (punish)
    assert.equal(ctx.game.state.phase.kind, 'punish');
  } finally { teardown(ctx); }
});

test('choice: applyNext on roll throws', () => {
  const ctx = setup();
  try {
    beginGame(ctx.game, ctx.rule.definition);
    assert.throws(() => applyNext(ctx.game, ctx.rule.definition, 1001), /等玩家掷/);
  } finally { teardown(ctx); }
});

test('choice: pickedBy null allows anyone (lastDice cleared case)', () => {
  const ctx = setup();
  try {
    beginGame(ctx.game, ctx.rule.definition);
    applyRoll(ctx.game, ctx.rule.definition, 2001, 4, ctx.db.listPlayers(ctx.game.gameId));
    // Clear lastDice and re-enter choice
    ctx.game.state.lastDice = undefined;
    advanceToStep(ctx.game, ctx.rule.definition, 0, 1);
    const phase = ctx.game.state.phase;
    assert.equal(phase.kind, 'choice');
    if (phase.kind === 'choice') {
      assert.equal(phase.pickedBy, null);
      // 2002 should be allowed
      applyChoice(ctx.game, ctx.rule.definition, 2002, 0);
      assert.equal(ctx.game.state.phase.kind, 'text');
    }
  } finally { teardown(ctx); }
});
