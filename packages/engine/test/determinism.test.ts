import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ruleDefinition, run, replay, setClock, resetClock, DICE_EMOJI_MAX_VALUE,
  type RuleDefinition, type GameRecord, type GamePlayer, type Intent
} from '../src/index.js';

// 固定时钟：把 lastDice.at / rolls[].at / endedAt 都钉成常量，从而能比较完整局面
setClock(() => 0);

const EXAMPLES_DIR = fileURLToPath(new URL('../../../examples', import.meta.url));

function loadAll(): { name: string; def: RuleDefinition }[] {
  return readdirSync(EXAMPLES_DIR)
    .filter(f => f.endsWith('.json'))
    .sort()
    .map(f => ({
      name: f,
      def: ruleDefinition.parse(JSON.parse(readFileSync(join(EXAMPLES_DIR, f), 'utf8')))
    }));
}

function makeInitial(players: GamePlayer[]): GameRecord {
  const g: GameRecord = {
    gameId: 'g', chatId: 0, ruleId: 'r', starterId: players[0].userId, status: 'signup',
    state: { phase: { kind: 'signup' }, stepHitCounts: {}, loopCounters: {} },
    roundIdx: 0, stepIdx: 0, createdAt: 0, endedAt: null, signupMsgId: null
  };
  g.players = players;
  return g;
}

function makePlayers(def: RuleDefinition): GamePlayer[] {
  const n = Math.max(1, Math.min(def.minPlayers, def.maxPlayers));
  return Array.from({ length: n }, (_, i) => ({ userId: 2001 + i, joinedAt: 0 }));
}

/** 可复现的伪随机源（LCG）。 */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 0x100000000;
}

/** 依当前相位产生一个合法意图（随机点数 / 随机选项 / 偶发 skip）。 */
function nextIntent(game: GameRecord, def: RuleDefinition, players: GamePlayer[], rnd: () => number): Intent | null {
  const p = game.state.phase;
  const pick = <T>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)];
  const rollValue = (max: number) => 1 + Math.floor(rnd() * max);
  if (p.kind === 'roll') {
    const userId = p.expectedPlayerId ?? pick(players).userId;
    return { type: 'roll', userId, value: rollValue(DICE_EMOJI_MAX_VALUE[p.emoji]), emoji: p.emoji };
  }
  if (p.kind === 'showdown') {
    const pending = players.filter(x => !p.rolls.some(r => r.userId === x.userId));
    if (!pending.length) return null;
    return { type: 'showdownRoll', userId: pick(pending).userId, value: rollValue(DICE_EMOJI_MAX_VALUE[p.emoji]), emoji: p.emoji };
  }
  if (p.kind === 'choice') {
    const userId = p.pickedBy ?? players[0].userId;
    if (!p.options.length) return { type: 'next', userId }; // 无选项：交给管理员推进
    return { type: 'choice', userId, optionIdx: Math.floor(rnd() * p.options.length) };
  }
  if (p.kind === 'text' || p.kind === 'punish') {
    const userId = pick(players).userId;
    return rnd() < 0.2 ? { type: 'skip', userId } : { type: 'next', userId };
  }
  return null;
}

/** 跑到结束，记录完整意图序列（含兜底推进）。 */
function drive(def: RuleDefinition, players: GamePlayer[], seed: number): { game: GameRecord; intents: Intent[]; steps: number } {
  const game = makeInitial(players);
  const rnd = lcg(seed);
  const intents: Intent[] = [{ type: 'begin', userId: players[0].userId }];
  run(game, def, players, intents[0]);
  let steps = 0;
  while (game.status !== 'ended' && steps++ < 5000) {
    const it = nextIntent(game, def, players, rnd);
    if (!it) break;
    intents.push(it);
    const r = run(game, def, players, it);
    if (!r.ok) {
      // 兜底：管理员推进，避免个别非法意图把对局卡死
      const fallback: Intent = { type: 'next', userId: players[0].userId };
      intents.push(fallback);
      if (!run(game, def, players, fallback).ok) break;
    }
  }
  return { game, intents, steps };
}

/** 完整局面签名（时钟已固定，可确定性比较）。 */
function signature(g: GameRecord): string {
  return JSON.stringify({ status: g.status, roundIdx: g.roundIdx, stepIdx: g.stepIdx, endedAt: g.endedAt, state: g.state });
}

const examples = loadAll();
assert.ok(examples.length >= 10, `expected ≥10 examples, found ${examples.length}`);

test('determinism: 同一随机种子 → 同意图序列 → 同终局（全部 examples）', () => {
  for (const { name, def } of examples) {
    const players = makePlayers(def);
    const a = drive(def, players, 12345);
    const b = drive(def, players, 12345);
    assert.deepEqual(a.intents, b.intents, `${name} 意图序列应一致`);
    assert.equal(signature(a.game), signature(b.game), `${name} 终局应一致`);
  }
});

test('replay: replay(intents) 与直接跑得到同局面（全部 examples）', () => {
  for (const { name, def } of examples) {
    const players = makePlayers(def);
    const direct = drive(def, players, 999);
    const { game: replayed } = replay(() => makeInitial(players), def, players, direct.intents);
    assert.equal(signature(replayed), signature(direct.game), `${name} replay 应等于直接跑`);
  }
});

test('invariant: 全部 examples 在保护步数内终止', () => {
  for (const { name, def } of examples) {
    const players = makePlayers(def);
    const { game, steps } = drive(def, players, 7);
    assert.equal(game.status, 'ended', `${name} 未在保护步数内结束`);
    assert.ok(steps < 5000, `${name} 超出保护步数`);
  }
});

test.after(() => resetClock());
