import test from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../src/db.js';
import { applyRoll, beginGame } from '../../engine/src/index.js';
import { ruleDefinition, resolveRollEmoji, type RuleDefinition, DICE_EMOJI_MAX_VALUE } from '../../engine/src/index.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const emojiRule = (emoji: '🎲' | '🏀' | '🎰' = '🎲'): RuleDefinition => ruleDefinition.parse({
  version: '1.3.0',
  name: 'emoji test',
  rounds: [
    {
      name: 'R1',
      steps: [
        { type: 'roll', label: '谁', emoji },
        { type: 'punish', label: '罚', defaultText: '喝一口', ladder: [
          { at: 1, text: '一点惩罚' },
          { at: 6, text: '六点惩罚' }
        ]}
      ]
    }
  ]
});

function setup(emoji: '🎲' | '🏀' | '🎰' = '🎲') {
  const dir = mkdtempSync(join(tmpdir(), 'emoji-'));
  const db = new Db(join(dir, 'bot.sqlite'));
  db.touchUser(1001);
  const rule = db.createRule(1001, 'emoji', emojiRule(emoji));
  const game = db.createGame(-100, rule.ruleId, 1001);
  db.addPlayer(game.gameId, 2001);
  return { dir, db, rule, game };
}
function teardown(ctx: { dir: string; db: Db }) { ctx.db.close(); rmSync(ctx.dir, { recursive: true, force: true }); }

test('emoji: step without explicit emoji resolves to 🎲 by default', () => {
  const def = ruleDefinition.parse({
    version: '1.3.0', name: 'no-emoji',
    rounds: [{ name: 'R', steps: [{ type: 'roll', label: 'x' }] }]
  });
  const step = def.rounds[0].steps[0];
  assert.equal(step.type, 'roll');
  if (step.type === 'roll') assert.equal(resolveRollEmoji(def, def.rounds[0], step), '🎲');
});

test('emoji: round.defaultEmoji is used when step has no emoji', () => {
  const def = ruleDefinition.parse({
    version: '1.3.0', name: 'round-default',
    rounds: [{ name: 'R', defaultEmoji: '🎰', steps: [{ type: 'roll', label: 'x' }] }]
  });
  const step = def.rounds[0].steps[0];
  assert.equal(step.type, 'roll');
  if (step.type === 'roll') assert.equal(resolveRollEmoji(def, def.rounds[0], step), '🎰');
});

test('emoji: rule.defaultEmoji used when no round or step emoji', () => {
  const def = ruleDefinition.parse({
    version: '1.3.0', name: 'rule-default', defaultEmoji: '⚽',
    rounds: [
      { name: 'R1', steps: [{ type: 'roll', label: 'a' }] },
      { name: 'R2', defaultEmoji: '🎯', steps: [{ type: 'roll', label: 'b' }] },
      { name: 'R3', steps: [{ type: 'roll', label: 'c', emoji: '🏀' }] }
    ]
  });
  const s1 = def.rounds[0].steps[0]; const s2 = def.rounds[1].steps[0]; const s3 = def.rounds[2].steps[0];
  if (s1.type === 'roll') assert.equal(resolveRollEmoji(def, def.rounds[0], s1), '⚽');
  if (s2.type === 'roll') assert.equal(resolveRollEmoji(def, def.rounds[1], s2), '🎯');
  if (s3.type === 'roll') assert.equal(resolveRollEmoji(def, def.rounds[2], s3), '🏀');
});

test('emoji: step.emoji wins over round/rule defaults', () => {
  const def = ruleDefinition.parse({
    version: '1.3.0', name: 'priority', defaultEmoji: '⚽',
    rounds: [{ name: 'R', defaultEmoji: '🎯', steps: [{ type: 'roll', label: 'x', emoji: '🎳' }] }]
  });
  const step = def.rounds[0].steps[0];
  if (step.type === 'roll') assert.equal(resolveRollEmoji(def, def.rounds[0], step), '🎳');
});

test('emoji: applyRoll validates emoji matches phase.emoji', () => {
  const ctx = setup('🏀');
  try {
    beginGame(ctx.game, ctx.rule.definition);
    assert.throws(
      () => applyRoll(ctx.game, ctx.rule.definition, 2001, 3, ctx.db.listPlayers(ctx.game.gameId), '🎲'),
      /本轮需要 🏀/
    );
  } finally { teardown(ctx); }
});

test('emoji: basketball emoji max value is 5', () => {
  assert.equal(DICE_EMOJI_MAX_VALUE['🏀'], 5);
  assert.equal(DICE_EMOJI_MAX_VALUE['🎲'], 6);
  assert.equal(DICE_EMOJI_MAX_VALUE['🎰'], 64);
});

test('emoji: basketball value 6 rejected', () => {
  const ctx = setup('🏀');
  try {
    beginGame(ctx.game, ctx.rule.definition);
    assert.throws(
      () => applyRoll(ctx.game, ctx.rule.definition, 2001, 6, ctx.db.listPlayers(ctx.game.gameId), '🏀'),
      /1-5/
    );
  } finally { teardown(ctx); }
});

test('emoji: basketball value 5 accepted', () => {
  const ctx = setup('🏀');
  try {
    beginGame(ctx.game, ctx.rule.definition);
    const r = applyRoll(ctx.game, ctx.rule.definition, 2001, 5, ctx.db.listPlayers(ctx.game.gameId), '🏀');
    assert.match(r.message, /掷出 5/);
    assert.equal(ctx.game.state.lastDice?.emoji, '🏀');
  } finally { teardown(ctx); }
});

test('emoji: slot machine accepts value up to 64', () => {
  const ctx = setup('🎰');
  try {
    beginGame(ctx.game, ctx.rule.definition);
    const r = applyRoll(ctx.game, ctx.rule.definition, 2001, 64, ctx.db.listPlayers(ctx.game.gameId), '🎰');
    assert.match(r.message, /掷出 64/);
  } finally { teardown(ctx); }
});

test('emoji: phase.emoji is set from rule', () => {
  const ctx = setup('🏀');
  try {
    beginGame(ctx.game, ctx.rule.definition);
    const phase = ctx.game.state.phase;
    assert.equal(phase.kind, 'roll');
    if (phase.kind === 'roll') assert.equal(phase.emoji, '🏀');
  } finally { teardown(ctx); }
});

test('emoji: phase.emoji persists through same round steps', () => {
  const ctx = setup('⚽');
  try {
    beginGame(ctx.game, ctx.rule.definition);
    const phase = ctx.game.state.phase;
    if (phase.kind === 'roll') assert.equal(phase.emoji, '⚽');
  } finally { teardown(ctx); }
});

test('emoji: schema rejects unsupported emoji', () => {
  assert.throws(() => ruleDefinition.parse({
    version: '1.3.0', name: 'bad',
    rounds: [{ name: 'R', steps: [{ type: 'roll', label: 'x', emoji: '🎅' }] }]
  }));
});
