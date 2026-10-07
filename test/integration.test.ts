import test from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../src/db.js';
import {
  advanceToStep, applyChoice, applyNext, applyRoll, applySkip, beginGame
} from '../src/rules.js';
import { ruleDefinition, type RuleDefinition } from '../src/model.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Integration test: simulate a complete game from start to end,
 * exercising every step type and path.
 *
 * Rule: 真心话大冒险 with emoji + maxLoops + choice + ladder
 */
const fullRule = (): RuleDefinition => ruleDefinition.parse({
  version: '1.3.0',
  name: 'integration test',
  rounds: [
    {
      name: '热身轮',
      loop: false,
      steps: [
        { type: 'roll', label: '热身', emoji: '🎲' },
        {
          type: 'choice',
          label: '热身选择',
          options: [
            { text: '玩色子', goto: { roundIdx: 1, stepIdx: 0 } },
            { text: '直接走', goto: 'next' }
          ]
        },
        { type: 'text', label: '热身题', prompt: '自我介绍' }
      ]
    },
    {
      name: '主轮',
      loop: true,
      maxLoops: 2,
      steps: [
        { type: 'roll', label: '主轮掷', emoji: '🏀' },
        {
          type: 'choice',
          label: '命运',
          options: [
            { text: '真心话', goto: 'next' },
            { text: '大冒险', goto: { roundIdx: 1, stepIdx: 2 } }
          ]
        },
        { type: 'text', label: '真心话', prompt: 'p' },
        { type: 'punish', label: '惩罚', defaultText: 'd1', ladder: [{ at: 2, text: 'd2' }, { at: 3, text: 'd3' }] }
      ]
    }
  ]
});

function setup(ruleMaker: () => RuleDefinition = fullRule) {
  const dir = mkdtempSync(join(tmpdir(), 'integ-'));
  const db = new Db(join(dir, 'bot.sqlite'));
  db.touchUser(1001);
  const rule = db.createRule(1001, 'integration', ruleMaker());
  const game = db.createGame(-100, rule.ruleId, 1001);
  db.addPlayer(game.gameId, 2001);
  db.addPlayer(game.gameId, 2002);
  db.addPlayer(game.gameId, 2003);
  return { dir, db, rule, game };
}
function teardown(ctx: { dir: string; db: Db }) { ctx.db.close(); rmSync(ctx.dir, { recursive: true, force: true }); }

// ============ Full happy path ============

test('integration: signup → begin → roll(emoji) → choice → text → next → punish → loop → end', () => {
  const ctx = setup();
  try {
    // signup phase
    assert.equal(ctx.game.state.phase.kind, 'signup');
    assert.equal(ctx.game.status, 'signup');

    // begin
    beginGame(ctx.game, ctx.rule.definition);
    assert.equal(ctx.game.state.phase.kind, 'roll');
    assert.equal(ctx.game.state.phase.kind === 'roll' && ctx.game.state.phase.emoji, '🎲');
    assert.equal(ctx.game.roundIdx, 0);
    assert.equal(ctx.game.stepIdx, 0);

    // roll (default assignment=next_player: expectedPlayerId = first joined = 2001)
    applyRoll(ctx.game, ctx.rule.definition, 2001, 3, ctx.db.listPlayers(ctx.game.gameId));
    assert.equal(ctx.game.state.phase.kind, 'choice');
    assert.equal(ctx.game.state.phase.kind === 'choice' && ctx.game.state.phase.pickedBy, 2001);

    // admin /next → option 0 ("玩色子") → jumps to (1, 0)
    applyNext(ctx.game, ctx.rule.definition, 1001);
    assert.equal(ctx.game.roundIdx, 1);
    assert.equal(ctx.game.state.phase.kind, 'roll');
    assert.equal(ctx.game.state.phase.kind === 'roll' && ctx.game.state.phase.emoji, '🏀');

    // rotation: 2001 rolled R0, so R1 expects 2002 next
    applyRoll(ctx.game, ctx.rule.definition, 2002, 5, ctx.db.listPlayers(ctx.game.gameId), '🏀');
    assert.equal(ctx.game.state.phase.kind, 'choice');

    // user picks "真心话" (option 0, "next")
    applyChoice(ctx.game, ctx.game.ruleId ? ctx.rule.definition : ctx.rule.definition, 2002, 0);
    assert.equal(ctx.game.state.phase.kind, 'text');

    // admin /next on text → punish
    applyNext(ctx.game, ctx.rule.definition, 1001);
    assert.equal(ctx.game.state.phase.kind, 'punish');
    const punish1 = ctx.game.state.phase;
    if (punish1.kind === 'punish') {
      assert.equal(punish1.hitCount, 1);
      assert.equal(punish1.text, 'd1');
    }

    // admin /next on punish → loop back to (1, 0)
    applyNext(ctx.game, ctx.rule.definition, 1001);
    assert.equal(ctx.game.state.phase.kind, 'roll');
    assert.equal(ctx.game.roundIdx, 1);

    // second pass: rotation after 2002 → expects 2003
    applyRoll(ctx.game, ctx.rule.definition, 2003, 3, ctx.db.listPlayers(ctx.game.gameId), '🏀');
    applyChoice(ctx.game, ctx.rule.definition, 2003, 1); // 大冒险 → (1, 2)
    assert.equal(ctx.game.state.phase.kind, 'text');
    applyNext(ctx.game, ctx.rule.definition, 1001);
    assert.equal(ctx.game.state.phase.kind, 'punish');
    const punish2 = ctx.game.state.phase;
    if (punish2.kind === 'punish') {
      assert.equal(punish2.hitCount, 2);
      assert.equal(punish2.text, 'd2');
    }

    // after 2nd punish → loop counter at 2 → maxLoops=2 → END
    applyNext(ctx.game, ctx.rule.definition, 1001);
    assert.equal(ctx.game.status, 'ended');
    assert.equal(ctx.game.state.loopCounters['1'], 2);
  } finally { teardown(ctx); }
});

// ============ Error paths ============

test('integration: wrong emoji rejected', () => {
  const ctx = setup();
  try {
    beginGame(ctx.game, ctx.rule.definition);
    assert.throws(
      () => applyRoll(ctx.game, ctx.rule.definition, 2001, 3, ctx.db.listPlayers(ctx.game.gameId), '🏀'),
      /本轮需要 🎲/
    );
  } finally { teardown(ctx); }
});

test('integration: basketball value 6 rejected', () => {
  const ctx = setup();
  try {
    beginGame(ctx.game, ctx.rule.definition);
    advanceToStep(ctx.game, ctx.rule.definition, 1, 0);
    assert.throws(
      () => applyRoll(ctx.game, ctx.rule.definition, 2001, 6, ctx.db.listPlayers(ctx.game.gameId), '🏀'),
      /1-5/
    );
  } finally { teardown(ctx); }
});

test('integration: non-player cannot roll', () => {
  const ctx = setup();
  try {
    beginGame(ctx.game, ctx.rule.definition);
    assert.throws(
      () => applyRoll(ctx.game, ctx.rule.definition, 9999, 3, ctx.db.listPlayers(ctx.game.gameId)),
      /只有已加入的玩家/
    );
  } finally { teardown(ctx); }
});

test('integration: skip on roll throws', () => {
  const ctx = setup();
  try {
    beginGame(ctx.game, ctx.rule.definition);
    assert.throws(() => applySkip(ctx.game, ctx.rule.definition), /当前在等色子/);
  } finally { teardown(ctx); }
});

// ============ DB persistence ============

test('integration: signup → reload from db → continue', () => {
  const dir = mkdtempSync(join(tmpdir(), 'persist-'));
  let db: Db | null = null;
  let db2: Db | null = null;
  try {
    db = new Db(join(dir, 'bot.sqlite'));
    db.touchUser(1001);
    const rule = db.createRule(1001, 'p', fullRule());
    const game = db.createGame(-100, rule.ruleId, 1001);
    db.addPlayer(game.gameId, 2001);
    db.addPlayer(game.gameId, 2002);
    beginGame(game, rule.definition);
    db.updateGame(game); // persist begin state

    // reload from db
    const reloaded = db.getGame(game.gameId)!;
    assert.equal(reloaded.state.phase.kind, 'roll');
    assert.equal(reloaded.state.phase.kind === 'roll' && reloaded.state.phase.emoji, '🎲');

    // close + reopen db (simulates bot restart)
    db.close();
    db = null;
    db2 = new Db(join(dir, 'bot.sqlite'));
    const reloaded2 = db2.getGame(game.gameId)!;
    assert.equal(reloaded2.state.phase.kind, 'roll');
    assert.equal(reloaded2.roundIdx, 0);

    // continue playing after restart
    applyRoll(reloaded2, rule.definition, 2001, 4, db2.listPlayers(game.gameId));
    db2.updateGame(reloaded2);
    const reloaded3 = db2.getGame(game.gameId)!;
    assert.equal(reloaded3.state.phase.kind, 'choice');
    db2.close();
    db2 = null;
  } finally {
    try { db?.close(); } catch {}
    try { db2?.close(); } catch {}
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch {}
  }
});

// ============ Event log ============

test('integration: event log records all phase transitions', () => {
  const ctx = setup();
  try {
    ctx.db.recordEvent(ctx.game.gameId, 1001, 'create', {});
    beginGame(ctx.game, ctx.rule.definition);
    ctx.db.recordEvent(ctx.game.gameId, 1001, 'begin', { roundIdx: 0, stepIdx: 0 });
    applyRoll(ctx.game, ctx.rule.definition, 2001, 3, ctx.db.listPlayers(ctx.game.gameId));
    ctx.db.recordEvent(ctx.game.gameId, 2001, 'roll', { value: 3, emoji: '🎲' });
    applyChoice(ctx.game, ctx.rule.definition, 2001, 0);
    ctx.db.recordEvent(ctx.game.gameId, 2001, 'choice', { optionIdx: 0, fromRoundIdx: 0, fromStepIdx: 1 });

    const events = ctx.db.listEvents(ctx.game.gameId);
    const types = events.map(e => e.type);
    assert.ok(types.includes('create'));
    assert.ok(types.includes('begin'));
    assert.ok(types.includes('roll'));
    assert.ok(types.includes('choice'));
    const choiceEvt = events.find(e => e.type === 'choice')!;
    assert.equal(choiceEvt.payload.fromRoundIdx, 0);
    assert.equal(choiceEvt.payload.fromStepIdx, 1);
  } finally { teardown(ctx); }
});

// ============ Choice edge cases ============

test('integration: choice pickedBy respected after undo', () => {
  const ctx = setup();
  try {
    beginGame(ctx.game, ctx.rule.definition);
    applyRoll(ctx.game, ctx.rule.definition, 2001, 3, ctx.db.listPlayers(ctx.game.gameId));
    applyChoice(ctx.game, ctx.rule.definition, 2001, 0);
    // Now at text (R0 S2) - manually jump back to choice via advanceToStep
    advanceToStep(ctx.game, ctx.rule.definition, 0, 1);
    // pickedBy should still be 2001 (lastDice.userId persists)
    const phase = ctx.game.state.phase;
    assert.equal(phase.kind, 'choice');
    if (phase.kind === 'choice') assert.equal(phase.pickedBy, 2001);
    // 2002 should still be rejected
    assert.throws(() => applyChoice(ctx.game, ctx.rule.definition, 2002, 0), /不是你的回合/);
  } finally { teardown(ctx); }
});

// ============ Status transitions ============

test('integration: status transitions: signup → in_progress → ended', () => {
  const ctx = setup();
  try {
    assert.equal(ctx.game.status, 'signup');
    beginGame(ctx.game, ctx.rule.definition);
    assert.equal(ctx.game.status, 'in_progress');
    // R0: roll → choice (option 1 "next" → step 2 text "热身题") → next → step 3 doesn't exist → next round
    applyRoll(ctx.game, ctx.rule.definition, 2001, 3, ctx.db.listPlayers(ctx.game.gameId));
    assert.equal(ctx.game.state.phase.kind, 'choice');
    applyChoice(ctx.game, ctx.rule.definition, 2001, 1); // 'next' → (0, 2) text "热身题"
    assert.equal(ctx.game.state.phase.kind, 'text');
    applyNext(ctx.game, ctx.rule.definition, 1001); // (0, 3) doesn't exist → next round
    assert.equal(ctx.game.roundIdx, 1);
    // R1 (maxLoops=2): roll → choice → text → punish → loop back
    // rotation: 2001 rolled R0, so R1 expects 2002
    applyRoll(ctx.game, ctx.rule.definition, 2002, 3, ctx.db.listPlayers(ctx.game.gameId), '🏀');
    applyChoice(ctx.game, ctx.rule.definition, 2002, 0); // option 0 'next' → (1, 2) text
    applyNext(ctx.game, ctx.rule.definition, 1001); // (1, 3) punish
    assert.equal(ctx.game.state.phase.kind, 'punish');
    applyNext(ctx.game, ctx.rule.definition, 1001); // punish done → loop counter 1, loop back
    assert.equal(ctx.game.state.loopCounters['1'], 1);
    assert.equal(ctx.game.state.phase.kind, 'roll');
    // rotation: 2002 rolled R1 step 0, now expects 2003
    applyRoll(ctx.game, ctx.rule.definition, 2003, 3, ctx.db.listPlayers(ctx.game.gameId), '🏀');
    applyChoice(ctx.game, ctx.rule.definition, 2003, 0);
    applyNext(ctx.game, ctx.rule.definition, 1001); // punish again
    applyNext(ctx.game, ctx.rule.definition, 1001); // counter 2 = maxLoops → end
    assert.equal(ctx.game.status, 'ended');
  } finally { teardown(ctx); }
});
