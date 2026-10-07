import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ruleDefinition, type RuleDefinition, type GameRecord, type GamePlayer,
  type ShowdownResult
} from '../src/model.js';
import {
  beginGame, applyShowdownRoll, applyNext, applySkip, applyChoice, applyRoll, formatTemplate
} from '../src/rules.js';

const PLAYERS: GamePlayer[] = [
  { userId: 2001, joinedAt: 0 },
  { userId: 2002, joinedAt: 0 },
  { userId: 2003, joinedAt: 0 }
];

function newGame(def: RuleDefinition, ps: GamePlayer[] = PLAYERS): GameRecord {
  const game: GameRecord = {
    gameId: 'g1', chatId: -100, ruleId: 'r1', starterId: ps[0].userId,
    status: 'signup',
    state: { phase: { kind: 'signup' }, stepHitCounts: {}, loopCounters: {} },
    roundIdx: 0, stepIdx: 0, createdAt: 0, endedAt: null, signupMsgId: null
  };
  (game as GameRecord & { _players?: GamePlayer[] })._players = ps;
  beginGame(game, def);
  return game;
}

function showdownDef(overrides: Record<string, unknown> = {}, extraSteps: unknown[] = []): RuleDefinition {
  return ruleDefinition.parse({
    name: 'sd', minPlayers: 2, maxPlayers: 8,
    rounds: [{
      name: 'R',
      steps: [
        { type: 'showdown', label: '比大小', order: 'high', tie: 'first', as: 'rank', ...overrides },
        { type: 'text', label: 'done', prompt: 'x' },
        ...extraSteps
      ]
    }]
  });
}

test('showdown: collects all players then settles with ranking', () => {
  const def = showdownDef();
  const g = newGame(def);
  assert.equal(g.state.phase.kind, 'showdown');
  assert.equal(applyShowdownRoll(g, def, 2001, 3, PLAYERS, '🎲').settled, false);
  assert.equal(applyShowdownRoll(g, def, 2002, 5, PLAYERS, '🎲').settled, false);
  const last = applyShowdownRoll(g, def, 2003, 1, PLAYERS, '🎲');
  assert.equal(last.settled, true);
  assert.match(last.message, /🏆/);
  assert.equal(g.state.phase.kind, 'text');
  const res = g.state.results!['rank'];
  assert.ok(res);
  assert.deepEqual(res.ranking.map(e => e.userId), [2002, 2001, 2003]);
  assert.deepEqual(res.winners, [2002]);
  assert.deepEqual(res.losers, [2003]);
  assert.equal(res.sum, 9);
  assert.equal(res.max, 5);
  assert.equal(res.min, 1);
});

test('showdown: order low → smallest wins', () => {
  const def = showdownDef({ order: 'low' });
  const g = newGame(def);
  applyShowdownRoll(g, def, 2001, 3, PLAYERS, '🎲');
  applyShowdownRoll(g, def, 2002, 5, PLAYERS, '🎲');
  applyShowdownRoll(g, def, 2003, 1, PLAYERS, '🎲');
  const res = g.state.results!['rank'];
  assert.deepEqual(res.ranking.map(e => e.userId), [2003, 2001, 2002]);
  assert.deepEqual(res.winners, [2003]);
  assert.deepEqual(res.losers, [2002]);
});

test('showdown: tie keep → all top players are winners', () => {
  const def = showdownDef({ tie: 'keep' });
  const g = newGame(def);
  applyShowdownRoll(g, def, 2001, 6, PLAYERS, '🎲');
  applyShowdownRoll(g, def, 2002, 6, PLAYERS, '🎲');
  applyShowdownRoll(g, def, 2003, 1, PLAYERS, '🎲');
  const res = g.state.results!['rank'];
  assert.deepEqual(new Set(res.winners), new Set([2001, 2002]));
  assert.deepEqual(res.losers, [2003]);
});

test('showdown: tie first → single winner, earliest roller wins tie', () => {
  const def = showdownDef({ tie: 'first' });
  const g = newGame(def);
  applyShowdownRoll(g, def, 2001, 6, PLAYERS, '🎲');
  applyShowdownRoll(g, def, 2002, 6, PLAYERS, '🎲');
  applyShowdownRoll(g, def, 2003, 1, PLAYERS, '🎲');
  const res = g.state.results!['rank'];
  assert.deepEqual(res.winners, [2001]);
  assert.deepEqual(res.losers, [2003]);
});

test('showdown: rejects duplicate / wrong emoji / out-of-range / non-player', () => {
  const def = showdownDef();
  const g = newGame(def);
  applyShowdownRoll(g, def, 2001, 3, PLAYERS, '🎲');
  assert.throws(() => applyShowdownRoll(g, def, 2001, 4, PLAYERS, '🎲'), /已经掷过/);
  assert.throws(() => applyShowdownRoll(g, def, 2002, 4, PLAYERS, '🏀'), /需要 🎲/);
  assert.throws(() => applyShowdownRoll(g, def, 2002, 7, PLAYERS, '🎲'), /1-6/);
  assert.throws(() => applyShowdownRoll(g, def, 9999, 4, PLAYERS, '🎲'), /已加入/);
});

test('showdown: accumulate sums across settlements', () => {
  const def = ruleDefinition.parse({
    name: 'acc', minPlayers: 2, maxPlayers: 8,
    rounds: [{
      name: 'R', loop: true, maxLoops: 3,
      steps: [{ type: 'showdown', label: 's', order: 'high', accumulate: true, as: 'score' }]
    }]
  });
  const g = newGame(def);
  // 第一局
  applyShowdownRoll(g, def, 2001, 2, PLAYERS, '🎲');
  applyShowdownRoll(g, def, 2002, 4, PLAYERS, '🎲');
  applyShowdownRoll(g, def, 2003, 1, PLAYERS, '🎲');
  // 第二局（loop 回到同一步）
  assert.equal(g.state.phase.kind, 'showdown');
  applyShowdownRoll(g, def, 2001, 5, PLAYERS, '🎲');
  applyShowdownRoll(g, def, 2002, 1, PLAYERS, '🎲');
  applyShowdownRoll(g, def, 2003, 3, PLAYERS, '🎲');
  const res = g.state.results!['score'];
  assert.equal(res.totals['2001'], 7);
  assert.equal(res.totals['2002'], 5);
  assert.equal(res.totals['2003'], 4);
  assert.deepEqual(res.winners, [2001]);
  assert.deepEqual(res.losers, [2003]);
});

test('showdown: actor winner/loser sets activeActorId', () => {
  const defWin = showdownDef({ actor: 'winner' });
  const gw = newGame(defWin);
  applyShowdownRoll(gw, defWin, 2001, 1, PLAYERS, '🎲');
  applyShowdownRoll(gw, defWin, 2002, 6, PLAYERS, '🎲');
  applyShowdownRoll(gw, defWin, 2003, 2, PLAYERS, '🎲');
  assert.equal(gw.state.activeActorId, 2002);

  const defLose = showdownDef({ actor: 'loser' });
  const gl = newGame(defLose);
  applyShowdownRoll(gl, defLose, 2001, 1, PLAYERS, '🎲');
  applyShowdownRoll(gl, defLose, 2002, 6, PLAYERS, '🎲');
  applyShowdownRoll(gl, defLose, 2003, 2, PLAYERS, '🎲');
  assert.equal(gl.state.activeActorId, 2001);
});

test('showdown: single player settles immediately', () => {
  const def = showdownDef();
  const solo: GamePlayer[] = [{ userId: 2001, joinedAt: 0 }];
  const g = newGame(def, solo);
  const r = applyShowdownRoll(g, def, 2001, 4, solo, '🎲');
  assert.equal(r.settled, true);
  assert.deepEqual(g.state.results!['rank'].winners, [2001]);
});

test('showdown: assignment winner/loser picks the next roller', () => {
  const def = ruleDefinition.parse({
    name: 'actor', minPlayers: 2, maxPlayers: 8,
    rounds: [{
      name: 'R',
      steps: [
        { type: 'showdown', label: 's', order: 'high', tie: 'first', as: 'rank' },
        { type: 'roll', label: 'winner rolls', assignment: 'winner', actorSlot: 'rank' },
        { type: 'roll', label: 'loser rolls', assignment: 'loser', actorSlot: 'rank' }
      ]
    }]
  });
  const g = newGame(def);
  applyShowdownRoll(g, def, 2001, 1, PLAYERS, '🎲');
  applyShowdownRoll(g, def, 2002, 6, PLAYERS, '🎲');
  applyShowdownRoll(g, def, 2003, 2, PLAYERS, '🎲');
  const p = g.state.phase;
  assert.equal(p.kind, 'roll');
  assert.equal(p.kind === 'roll' && p.expectedPlayerId, 2002);
  // 赢家掷完，下一个 roll 用 loser
  applyRoll(g, def, 2002, 3, PLAYERS, '🎲');
  const p2 = g.state.phase;
  assert.equal(p2.kind === 'roll' && p2.expectedPlayerId, 2001);
});

test('showdown: chooser winner sets pickedBy', () => {
  const def = ruleDefinition.parse({
    name: 'chooser', minPlayers: 2, maxPlayers: 8,
    rounds: [{
      name: 'R',
      steps: [
        { type: 'showdown', label: 's', order: 'high', tie: 'first', as: 'rank', actor: 'winner' },
        { type: 'choice', label: 'c', chooser: 'winner', options: [{ text: 'a', goto: 'next' }, { text: 'b', goto: 'next' }] }
      ]
    }]
  });
  const g = newGame(def);
  applyShowdownRoll(g, def, 2001, 1, PLAYERS, '🎲');
  applyShowdownRoll(g, def, 2002, 6, PLAYERS, '🎲');
  applyShowdownRoll(g, def, 2003, 2, PLAYERS, '🎲');
  const p = g.state.phase;
  assert.equal(p.kind, 'choice');
  assert.equal(p.kind === 'choice' && p.pickedBy, 2002);
  // 非 pickedBy 不能选
  assert.throws(() => applyChoice(g, def, 2001, 0), /不是你的回合/);
  applyChoice(g, def, 2002, 0);
});

test('showdown: applyNext force-settles with current rolls, applySkip abandons', () => {
  const def = showdownDef();
  const g = newGame(def);
  applyShowdownRoll(g, def, 2002, 6, PLAYERS, '🎲');
  assert.equal(g.state.phase.kind, 'showdown');
  applyNext(g, def, 1001, PLAYERS);
  assert.equal(g.state.phase.kind, 'text');
  assert.deepEqual(g.state.results!['rank'].winners, [2002]);
  assert.deepEqual(g.state.results!['rank'].losers, [2003]); // 未掷 = 0 分，末位按 tie:first 取最后一个

  const g2 = newGame(def);
  applySkip(g2, def);
  assert.equal(g2.state.phase.kind, 'text');
  assert.equal(g2.state.results, undefined);
});

test('templates: resolve slot selectors in html and plain', () => {
  const def = showdownDef({ actor: 'winner' });
  const g = newGame(def);
  applyShowdownRoll(g, def, 2001, 1, PLAYERS, '🎲');
  applyShowdownRoll(g, def, 2002, 6, PLAYERS, '🎲');
  applyShowdownRoll(g, def, 2003, 2, PLAYERS, '🎲');
  // 回到 showdown 相位不够，直接用 results
  const plain = formatTemplate('赢家 {winner} 输家 {loser} 第一 {rank1} 末位 {rank-1} 总分 {sum}', g, 'plain');
  assert.ok(plain.includes('用户 #2002'));
  assert.ok(plain.includes('用户 #2001'));
  assert.ok(plain.includes('9'));
  const htmlOut = formatTemplate('{rank.ranking}', g, 'html');
  assert.ok(htmlOut.includes('tg://user?id=2002'));
  const escaped = formatTemplate('<b>{winner}</b>', g, 'html');
  assert.ok(escaped.startsWith('&lt;b&gt;'));
  assert.ok(escaped.endsWith('&lt;/b&gt;'));
  // 未知 token 原样保留
  assert.equal(formatTemplate('{nope}', g, 'plain'), '{nope}');
  // {actor}
  assert.ok(formatTemplate('{actor}', g, 'plain').includes('用户 #2002'));
});

test('templates: slot from start of game leaves token untouched', () => {
  const def = showdownDef();
  const g = newGame(def);
  assert.equal(formatTemplate('{winner}', g, 'plain'), '{winner}');
});

test('templates: {dice} and {roller} from the last single roll', () => {
  const def = showdownDef();
  const g = newGame(def);
  assert.equal(formatTemplate('{dice}', g, 'plain'), '{dice}'); // 还没掷
  g.state.lastDice = { userId: 2002, value: 5, at: 0, emoji: '🎲' };
  assert.equal(formatTemplate('{dice}', g, 'plain'), '5');
  assert.ok(formatTemplate('{roller}', g, 'plain').includes('用户 #2002'));
  assert.ok(formatTemplate('{roller}', g, 'html').includes('tg://user?id=2002'));
});
