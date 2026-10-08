import test from 'node:test';
import assert from 'node:assert/strict';
import { ruleDefinition, run, beginGame, type RuleDefinition, type GameRecord, type GamePlayer } from '../src/index.js';

const P: GamePlayer[] = [{ userId: 9001, joinedAt: 0 }, { userId: 9002, joinedAt: 0 }];

function newGame(): GameRecord {
  const g: GameRecord = {
    gameId: 'g', chatId: 0, ruleId: 'r', starterId: 9001, status: 'signup',
    state: { phase: { kind: 'signup' }, stepHitCounts: {}, loopCounters: {} },
    roundIdx: 0, stepIdx: 0, createdAt: 0, endedAt: null, signupMsgId: null
  };
  g.players = P;
  return g;
}

/** 去掉时间戳（Date.now()），用于确定性比较 */
function strip(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(strip);
  if (v && typeof v === 'object') {
    const o: Record<string, unknown> = {};
    for (const k of Object.keys(v as object)) { if (k === 'at') continue; o[k] = strip((v as Record<string, unknown>)[k]); }
    return o;
  }
  return v;
}

const rollDef: RuleDefinition = ruleDefinition.parse({
  name: 'r', minPlayers: 2, maxPlayers: 2,
  rounds: [{ name: 'R', steps: [
    { type: 'roll', label: '掷', emoji: '🎲' },
    { type: 'text', label: 't', prompt: 'x' }
  ] }]
});

const drawDef: RuleDefinition = ruleDefinition.parse({
  name: 'd', minPlayers: 2, maxPlayers: 2,
  rounds: [{ name: 'R', steps: [
    { type: 'roll', label: '抽', emoji: '🎰', draw: { count: 16, uniform: 'exact', targets: Array.from({ length: 16 }, () => ({ roundIdx: 0, stepIdx: 1 })) } },
    { type: 'text', label: 't', prompt: 'x' }
  ] }]
});

const rerollDef: RuleDefinition = ruleDefinition.parse({
  name: 's', minPlayers: 2, maxPlayers: 2,
  rounds: [{ name: 'R', steps: [
    { type: 'showdown', label: '比大小', emoji: '🎲', order: 'high', tie: 'reroll' },
    { type: 'text', label: 't', prompt: 'x' }
  ] }]
});

test('run: begin emits gameStarted + phaseEntered', () => {
  const g = newGame();
  const r = run(g, rollDef, P, { type: 'begin', userId: 9001 });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(r.events.map(e => e.type), ['gameStarted', 'phaseEntered']);
  assert.equal(g.state.phase.kind, 'roll');
});

test('run: wrong turn → typed error NOT_YOUR_TURN', () => {
  const g = newGame();
  beginGame(g, rollDef);
  const r = run(g, rollDef, P, { type: 'roll', userId: 9002, value: 3, emoji: '🎲' });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.code, 'NOT_YOUR_TURN');
});

test('run: roll emits rollResolved', () => {
  const g = newGame();
  beginGame(g, rollDef);
  const r = run(g, rollDef, P, { type: 'roll', userId: 9001, value: 3, emoji: '🎲' });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.ok(r.events.some(e => e.type === 'rollResolved'));
  assert.ok(r.events.some(e => e.type === 'phaseEntered' && e.phase === 'text'));
});

test('run: roll.draw emits drawResolved with the bucket', () => {
  const g = newGame();
  beginGame(g, drawDef);
  const r = run(g, drawDef, P, { type: 'roll', userId: 9001, value: 64, emoji: '🎰' });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  const draw = r.events.find(e => e.type === 'drawResolved');
  assert.ok(draw && draw.type === 'drawResolved');
  if (draw && draw.type === 'drawResolved') assert.equal(draw.bucket, 16);
  assert.equal(g.state.lastDraw, 16);
});

test('run: showdown settle / reroll events', () => {
  const g = newGame();
  beginGame(g, rerollDef);
  run(g, rerollDef, P, { type: 'showdownRoll', userId: 9001, value: 4, emoji: '🎲' });
  const r = run(g, rerollDef, P, { type: 'showdownRoll', userId: 9002, value: 4, emoji: '🎲' });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.ok(r.events.some(e => e.type === 'showdownRerolled'));
  assert.equal(g.state.phase.kind, 'showdown');
});

test('run: deterministic —— 相同意图序列 → 相同状态（去掉时间戳）', () => {
  const plays = (): GameRecord => {
    const g = newGame();
    run(g, rollDef, P, { type: 'begin', userId: 9001 });
    run(g, rollDef, P, { type: 'roll', userId: 9001, value: 4, emoji: '🎲' });
    run(g, rollDef, P, { type: 'next', userId: 9001 });
    return g;
  };
  const a = plays(); const b = plays();
  assert.equal(JSON.stringify(strip(a.state)), JSON.stringify(strip(b.state)));
  assert.equal(a.status, b.status);
});
