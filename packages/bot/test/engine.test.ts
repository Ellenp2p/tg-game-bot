import test from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../src/db.js';
import { beginGame, applyNext, applySkip, applyRoll, advanceToStep } from '../../engine/src/index.js';
import { ruleDefinition, type RuleDefinition } from '../../engine/src/index.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sampleRule = (): RuleDefinition => ruleDefinition.parse({
  name: '测试',
  rounds: [
    {
      name: 'R1',
      steps: [
        { type: 'roll', label: '谁' },
        { type: 'text', label: '答', prompt: '请回答' },
        { type: 'punish', label: '罚', defaultText: '喝一口', ladder: [{ at: 2, text: '喝一杯' }, { at: 3, text: '喝两杯' }] }
      ]
    },
    {
      name: 'R2',
      loop: true,
      steps: [
        { type: 'punish', label: '循环罚', defaultText: '做鬼脸' }
      ]
    }
  ]
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'bot-'));
  const db = new Db(join(dir, 'bot.sqlite'));
  db.touchUser(1001);
  const rule = db.createRule(1001, 'test', sampleRule());
  const game = db.createGame(-100, rule.ruleId, 1001);
  db.addPlayer(game.gameId, 2001);
  db.addPlayer(game.gameId, 2002);
  return { dir, db, rule, game };
}
function teardown(ctx: { dir: string; db: Db }) { ctx.db.close(); rmSync(ctx.dir, { recursive: true, force: true }); }

test('schema and rule CRUD', () => {
  const ctx = setup();
  try {
    const fetched = ctx.db.getRule(ctx.rule.ruleId);
    assert.equal(fetched?.name, 'test');
    const list = ctx.db.listRules(1001);
    assert.equal(list.length, 1);
    const updated = ctx.db.updateRule(ctx.rule.ruleId, 1001, 'renamed', ctx.rule.definition);
    assert.equal(updated?.name, 'renamed');
    assert.ok(ctx.db.deleteRule(ctx.rule.ruleId, 1001));
    assert.equal(ctx.db.getRule(ctx.rule.ruleId), undefined);
  } finally { teardown(ctx); }
});

test('beginGame → roll → next → punish ladder escalation', () => {
  const ctx = setup();
  try {
    beginGame(ctx.game, ctx.rule.definition);
    assert.equal(ctx.game.status, 'in_progress');
    assert.equal(ctx.game.state.phase.kind, 'roll');
    applyRoll(ctx.game, ctx.rule.definition, 2001, 4, ctx.db.listPlayers(ctx.game.gameId));
    assert.equal(ctx.game.state.lastDice?.value, 4);
    assert.equal(ctx.game.state.phase.kind, 'text');
    applyNext(ctx.game, ctx.rule.definition, 1001);
    assert.equal(ctx.game.state.phase.kind, 'punish');
    assert.equal(ctx.game.state.phase.kind === 'punish' && ctx.game.state.phase.text, '喝一口');
    advanceToStep(ctx.game, ctx.rule.definition, 0, 2);
    assert.equal(ctx.game.state.phase.kind, 'punish');
    assert.equal(ctx.game.state.phase.kind === 'punish' && ctx.game.state.phase.hitCount, 2);
    assert.equal(ctx.game.state.phase.kind === 'punish' && ctx.game.state.phase.text, '喝一杯');
    advanceToStep(ctx.game, ctx.rule.definition, 0, 2);
    assert.equal(ctx.game.state.phase.kind, 'punish');
    assert.equal(ctx.game.state.phase.kind === 'punish' && ctx.game.state.phase.hitCount, 3);
    assert.equal(ctx.game.state.phase.kind === 'punish' && ctx.game.state.phase.text, '喝两杯');
  } finally { teardown(ctx); }
});

test('skip advances', () => {
  const ctx = setup();
  try {
    beginGame(ctx.game, ctx.rule.definition);
    applyRoll(ctx.game, ctx.rule.definition, 2001, 3, ctx.db.listPlayers(ctx.game.gameId));
    applySkip(ctx.game, ctx.rule.definition);
    assert.equal(ctx.game.state.phase.kind, 'punish');
  } finally { teardown(ctx); }
});

test('loop round continues indefinitely', () => {
  const ctx = setup();
  try {
    beginGame(ctx.game, ctx.rule.definition);
    applyRoll(ctx.game, ctx.rule.definition, 2001, 3, ctx.db.listPlayers(ctx.game.gameId));
    applyNext(ctx.game, ctx.rule.definition, 1001);
    applyNext(ctx.game, ctx.rule.definition, 1001);
    for (let i = 0; i < 10; i++) applyNext(ctx.game, ctx.rule.definition, 1001);
    assert.equal(ctx.game.status, 'in_progress');
    assert.equal(ctx.game.state.phase.kind, 'punish');
  } finally { teardown(ctx); }
});

test('events and undo', () => {
  const ctx = setup();
  try {
    ctx.db.addPlayer(ctx.game.gameId, 2003);
    ctx.db.recordEvent(ctx.game.gameId, 2003, 'join', {});
    const events = ctx.db.listEvents(ctx.game.gameId);
    assert.ok(events.find(e => e.type === 'join' && e.userId === 2003));
    beginGame(ctx.game, ctx.rule.definition);
    ctx.db.recordEvent(ctx.game.gameId, 1001, 'begin', { roundIdx: 0, stepIdx: 0 });
    applyRoll(ctx.game, ctx.rule.definition, 2001, 6, ctx.db.listPlayers(ctx.game.gameId));
    ctx.db.recordEvent(ctx.game.gameId, 2001, 'roll', { value: 6 });
    const allEvents = ctx.db.listEvents(ctx.game.gameId);
    assert.ok(allEvents.length >= 3);
    advanceToStep(ctx.game, ctx.rule.definition, 0, 0);
  } finally { teardown(ctx); }
});
