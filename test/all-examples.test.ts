import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ruleDefinition, type RuleDefinition, type DiceEmoji, DICE_EMOJI_MAX_VALUE, isJackpot } from '../src/model.js';
import { beginGame, applyRoll, applyNext, applyChoice, applySkip, applyShowdownRoll, displayName, findStep, stepKey } from '../src/rules.js';
import type { GameRecord, GamePlayer } from '../src/model.js';

const EXAMPLES_DIR = join(process.cwd(), 'examples');

function loadAll(): { name: string; def: RuleDefinition }[] {
  return readdirSync(EXAMPLES_DIR)
    .filter(f => f.endsWith('.json'))
    .sort()
    .map(f => {
      const raw = readFileSync(join(EXAMPLES_DIR, f), 'utf8');
      const def = ruleDefinition.parse(JSON.parse(raw));
      return { name: f, def };
    });
}

function newGame(def: RuleDefinition, players: GamePlayer[]): GameRecord {
  const game: GameRecord = {
    gameId: 'g1',
    chatId: -100,
    ruleId: 'r1',
    starterId: players[0].userId,
    status: 'signup',
    state: { phase: { kind: 'signup' }, stepHitCounts: {}, loopCounters: {} },
    roundIdx: 0,
    stepIdx: 0,
    createdAt: Date.now(),
    endedAt: null,
    signupMsgId: null
  };
  beginGame(game, def);
  return game;
}

function driveRoll(game: GameRecord, def: RuleDefinition, players: GamePlayer[]): void {
  const phase = game.state.phase;
  if (phase.kind !== 'roll') return;
  const userId = phase.expectedPlayerId ?? players[0].userId;
  const value = Math.min(DICE_EMOJI_MAX_VALUE[phase.emoji], 1);
  applyRoll(game, def, userId, value, players, phase.emoji);
}

function driveUntil(game: GameRecord, def: RuleDefinition, players: GamePlayer[], maxSteps: number): { rolls: number; showdowns: number; nexts: number; choices: number; skips: number; ended: boolean } {
  let rolls = 0, showdowns = 0, nexts = 0, choices = 0, skips = 0;
  for (let i = 0; i < maxSteps; i++) {
    if (game.status === 'ended') break;
    const phase = game.state.phase;
    if (phase.kind === 'roll') {
      driveRoll(game, def, players);
      rolls++;
    } else if (phase.kind === 'showdown') {
      // 全员各掷一次（用最小值 1）
      for (const p of players) {
        const cur = game.state.phase;
        if (cur.kind !== 'showdown') break;
        applyShowdownRoll(game, def, p.userId, Math.min(DICE_EMOJI_MAX_VALUE[cur.emoji], 1), players, cur.emoji);
        showdowns++;
      }
    } else if (phase.kind === 'signup') {
      break;
    } else if (phase.kind === 'choice') {
      const targetUser = phase.pickedBy ?? players[0].userId;
      applyChoice(game, def, targetUser, 0);
      choices++;
    } else if (phase.kind === 'text' || phase.kind === 'punish') {
      applyNext(game, def, players[0].userId);
      nexts++;
    }
  }
  return { rolls, showdowns, nexts, choices, skips, ended: game.status === 'ended' };
}

const examples = loadAll();
assert.ok(examples.length >= 10, `expected 10 examples, found ${examples.length}`);

test('all examples: parse as v1.8.0', () => {
  for (const { name, def } of examples) {
    assert.equal(def.version, '1.8.0', `${name} version mismatch`);
  }
});

test('all examples: every roll step has resolvable emoji via three-layer fallback', () => {
  for (const { name, def } of examples) {
    const visited = new Set<string>();
    for (let r = 0; r < def.rounds.length; r++) {
      const round = def.rounds[r];
      for (let s = 0; s < round.steps.length; s++) {
        const step = round.steps[s];
        if (step.type !== 'roll') continue;
        const key = stepKey(r, s);
        if (visited.has(key)) continue;
        visited.add(key);
        const expected = step.emoji ?? round.defaultEmoji ?? def.defaultEmoji ?? '🎲';
        const ok: DiceEmoji[] = ['🎲','🎯','🏀','⚽','🎰','🎳'];
        assert.ok(ok.includes(expected), `${name} step ${key} resolved to invalid emoji ${expected}`);
      }
    }
  }
});

test('all examples: every loop round has maxLoops in [1, 100]', () => {
  for (const { name, def } of examples) {
    for (let r = 0; r < def.rounds.length; r++) {
      const round = def.rounds[r];
      if (round.loop) {
        assert.ok(round.maxLoops !== undefined, `${name} round ${r} has loop:true but no maxLoops`);
        assert.ok(round.maxLoops! >= 1 && round.maxLoops! <= 100, `${name} round ${r} maxLoops out of range`);
      }
    }
  }
});

test('all examples: complete playthrough ends within bounded steps', () => {
  const players: GamePlayer[] = [
    { userId: 2001, joinedAt: 0 },
    { userId: 2002, joinedAt: 0 }
  ];
  for (const { name, def } of examples) {
    const totalSteps = def.rounds.reduce((s, r) => s + r.steps.length, 0);
    const maxLoops = def.rounds.reduce((m, r) => Math.max(m, r.loop ? (r.maxLoops ?? 99) : 1), 1);
    const game = newGame(def, players);
    const r = driveUntil(game, def, players, totalSteps * (maxLoops + 5));
    assert.equal(r.ended, true, `${name} did not end within ${totalSteps * (maxLoops + 5)} steps`);
    assert.ok(r.rolls + r.showdowns + r.nexts + r.choices > 0, `${name} produced no actions`);
  }
});

test('all examples: non-loop round advances to next round', () => {
  const players: GamePlayer[] = [{ userId: 2001, joinedAt: 0 }];
  for (const { name, def } of examples) {
    if (def.rounds.length < 2) continue;
    const first = def.rounds[0];
    if (first.loop) continue;
    const game = newGame(def, players);
    const totalSteps = def.rounds.reduce((s, r) => s + r.steps.length, 0);
    const maxLoops = def.rounds.reduce((m, r) => Math.max(m, r.loop ? (r.maxLoops ?? 99) : 1), 1);
    driveUntil(game, def, players, totalSteps * (maxLoops + 5));
    assert.equal(game.status, 'ended', `${name} non-loop start did not finish all rounds`);
  }
});

test('all examples: maxLoops termination works for every loop round', () => {
  const players: GamePlayer[] = [{ userId: 2001, joinedAt: 0 }];
  for (const { name, def } of examples) {
    const loopRounds = def.rounds.filter(r => r.loop);
    if (!loopRounds.length) continue;
    for (let r = 0; r < def.rounds.length; r++) {
      const round = def.rounds[r];
      if (!round.loop || round.maxLoops === undefined) continue;
      const game = newGame(def, players);
      const totalSteps = def.rounds.reduce((s, rr) => s + rr.steps.length, 0);
      const r2 = driveUntil(game, def, players, totalSteps * (round.maxLoops + 10));
      const expectedEndRounds = round.maxLoops;
      const actualEndLoops = game.state.loopCounters[String(r)] ?? 0;
      assert.ok(actualEndLoops <= expectedEndRounds, `${name} round ${r} looped ${actualEndLoops} times, maxLoops=${expectedEndRounds}`);
    }
  }
});

test('all examples: roll steps use the declared emoji range (not exceed max)', () => {
  const players: GamePlayer[] = [{ userId: 2001, joinedAt: 0 }];
  for (const { name, def } of examples) {
    const game = newGame(def, players);
    for (let i = 0; i < 50; i++) {
      const phase = game.state.phase;
      if (phase.kind !== 'roll' || game.status === 'ended') break;
      const expectedMax = DICE_EMOJI_MAX_VALUE[phase.emoji];
      for (let v = 1; v <= 6; v++) {
        if (v > expectedMax) {
          assert.throws(() => applyRoll(game, def, 2001, v, players, phase.emoji), /范围|需要/, `${name} should reject ${phase.emoji}=${v}`);
        }
      }
      applyRoll(game, def, 2001, Math.min(expectedMax, 1), players, phase.emoji);
    }
  }
});

test('all examples: wrong emoji rejected for roll', () => {
  const players: GamePlayer[] = [{ userId: 2001, joinedAt: 0 }];
  for (const { name, def } of examples) {
    const game = newGame(def, players);
    const phase = game.state.phase;
    if (phase.kind !== 'roll') continue;
    const wrong: DiceEmoji = phase.emoji === '🎲' ? '🏀' : '🎲';
    if (phase.emoji === '🎲') {
      assert.throws(() => applyRoll(game, def, 2001, 1, players, wrong), /需要/, `${name} should reject wrong emoji`);
    }
  }
});

test('all examples: slot machine produces correctly decoded lastDice', () => {
  const players: GamePlayer[] = [{ userId: 2001, joinedAt: 0 }];
  const ten = examples.find(e => e.name === '10-slot-machine-jackpot.json')!;
  const game = newGame(ten.def, players);
  for (let i = 0; i < 20 && game.state.phase.kind === 'roll'; i++) {
    driveRoll(game, ten.def, players);
    if (game.state.lastDice?.emoji === '🎰') {
      const v = game.state.lastDice.value;
      const jp = isJackpot(v);
      assert.equal(jp, v === 1 || v === 22 || v === 43 || v === 64, `slot ${v} jackpot flag wrong`);
    }
  }
});

test('all examples: maxLoops counter persists across loop iterations', () => {
  const players: GamePlayer[] = [{ userId: 2001, joinedAt: 0 }];
  const two = examples.find(e => e.name === '02-dice-punishment.json')!;
  const game = newGame(two.def, players);
  const target = two.def.rounds[0].maxLoops!;
  const totalSteps = two.def.rounds.reduce((s, r) => s + r.steps.length, 0);
  driveUntil(game, two.def, players, totalSteps * target * 2);
  const counter = game.state.loopCounters['0'] ?? 0;
  assert.equal(counter, target, `02 should loop exactly ${target} times, got ${counter}`);
});

test('all examples: 03 (riddle chain) two rounds, second loop with maxLoops=10', () => {
  const players: GamePlayer[] = [{ userId: 2001, joinedAt: 0 }];
  const three = examples.find(e => e.name === '03-riddle-chain.json')!;
  assert.equal(three.def.rounds.length, 2);
  assert.equal(three.def.rounds[1].loop, true);
  assert.equal(three.def.rounds[1].maxLoops, 10);
  const game = newGame(three.def, players);
  const totalSteps = three.def.rounds.reduce((s, r) => s + r.steps.length, 0);
  driveUntil(game, three.def, players, totalSteps * 15);
  assert.equal(game.state.loopCounters['1'], 10);
  assert.equal(game.status, 'ended');
});

test('all examples: 09 (basketball) uses 🏀 and rejects 🎲', () => {
  const players: GamePlayer[] = [{ userId: 2001, joinedAt: 0 }];
  const nine = examples.find(e => e.name === '09-basketball-tournament.json')!;
  const game = newGame(nine.def, players);
  const phase = game.state.phase;
  assert.equal(phase.kind, 'roll');
  if (phase.kind === 'roll') {
    assert.equal(phase.emoji, '🏀');
    assert.throws(() => applyRoll(game, nine.def, 2001, 3, players, '🎲'), /需要 🏀/);
    assert.throws(() => applyRoll(game, nine.def, 2001, 6, players, '🏀'), /1-5/);
    const r = applyRoll(game, nine.def, 2001, 4, players, '🏀');
    assert.match(r.message, /掷出 4/);
  }
});

test('all examples: 10 (slot) first-roll symbol display works', () => {
  const players: GamePlayer[] = [{ userId: 2001, joinedAt: 0 }];
  const ten = examples.find(e => e.name === '10-slot-machine-jackpot.json')!;
  const game = newGame(ten.def, players);
  for (let v = 1; v <= 64; v++) {
    const phase = game.state.phase;
    if (phase.kind !== 'roll') break;
    const r = applyRoll(game, ten.def, 2001, v, players, '🎰');
    if (isJackpot(v)) {
      assert.match(r.message, /JACKPOT/, `value ${v} should be jackpot`);
    } else {
      assert.doesNotMatch(r.message, /JACKPOT/, `value ${v} should NOT be jackpot`);
    }
    if (game.state.phase.kind !== 'roll') break;
  }
});
