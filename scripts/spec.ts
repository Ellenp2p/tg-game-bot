#!/usr/bin/env tsx
/**
 * Spec 运行器（S0）——纯引擎驱动，无 Telegram。
 *
 * 用法：
 *   pnpm spec              # 跑全部 spec 并与 golden 比对
 *   pnpm spec --update     # 重新录制 golden
 *   pnpm spec <名字片段>    # 只跑名字包含该片段的 spec
 *
 * 见 specs/README.md。
 */
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import {
  ruleDefinition, DICE_EMOJI_MAX_VALUE, run, beginGame,
  type RuleDefinition, type DiceEmoji, type GameRecord, type GamePlayer, type Intent as EngineIntent
} from '../packages/engine/src/index.js';

const ROOT = process.cwd();
const SPECS_DIR = join(ROOT, 'specs');
const GOLDEN_DIR = join(SPECS_DIR, '__golden__');

type Intent =
  | { type: 'begin'; userId?: number }
  | { type: 'roll'; userId: number; value: number; emoji?: DiceEmoji }
  | { type: 'showdownRoll'; userId: number; value: number; emoji?: DiceEmoji }
  | { type: 'choice'; userId: number; optionIdx: number }
  | { type: 'next'; userId?: number }
  | { type: 'skip'; userId?: number };

type Expect = {
  ok?: boolean;
  error?: string;
  phase?: string;
  expectedPlayerId?: number | null;
  roundIdx?: number;
  stepIdx?: number;
  messageContains?: string;
  lastDraw?: number | null;
  loops?: Record<string, number>;
};

type PlaythroughSpec = {
  kind: 'playthrough';
  name: string;
  rule: string | object;
  players: number[];
  policy: { value: 'min' | 'max'; choice: number; maxOps: number };
};
type ScriptedSpec = {
  kind: 'scripted';
  name: string;
  rule: string | object;
  players: number[];
  steps: Array<{ do: Intent; expect?: Expect }>;
};
type Spec = PlaythroughSpec | ScriptedSpec;

type TraceEntry = {
  n: number;
  intent: Intent;
  ok: boolean;
  error?: string;
  phase: string;
  status: string;
  cursor: { roundIdx: number; stepIdx: number };
  expectedPlayerId?: number | null;
  emoji?: string;
  lastDice?: { userId: number; value: number; emoji: string } | null;
  lastDraw?: number | null;
  loops?: Record<string, number>;
  message?: string;
};

// ---------- 构建游戏 ----------
function buildGame(def: RuleDefinition, playerIds: number[]): { game: GameRecord; players: GamePlayer[] } {
  const players: GamePlayer[] = playerIds.map((id, i) => ({ userId: id, joinedAt: i }));
  const game: GameRecord = {
    gameId: 'spec', chatId: 0, ruleId: 'spec', starterId: players[0].userId, status: 'signup',
    state: { phase: { kind: 'signup' }, stepHitCounts: {}, loopCounters: {} },
    roundIdx: 0, stepIdx: 0, createdAt: 0, endedAt: null, signupMsgId: null
  };
  (game as GameRecord & { _players?: GamePlayer[] })._players = players;
  return { game, players };
}

function resolveRule(rule: string | object): RuleDefinition {
  if (typeof rule === 'string') {
    const p = join(ROOT, rule);
    return ruleDefinition.parse(JSON.parse(readFileSync(p, 'utf8')));
  }
  return ruleDefinition.parse(rule);
}

// ---------- intent → 引擎唯一入口 run() ----------
type ApplyOut = { ok: boolean; message?: string; error?: string; settled?: boolean; rerolled?: boolean };
function applyIntent(game: GameRecord, def: RuleDefinition, players: GamePlayer[], it: Intent): ApplyOut {
  const userId = it.userId ?? players[0].userId;
  const r = run(game, def, players, { ...it, userId } as EngineIntent);
  if (!r.ok) return { ok: false, error: r.text };
  const rerolled = r.events.some(e => e.type === 'showdownRerolled');
  const settled = r.events.some(e => e.type === 'showdownSettled' || e.type === 'showdownRerolled');
  return { ok: true, message: r.message, settled, rerolled };
}

// ---------- 归一化快照（不含时间戳，保证 golden 稳定） ----------
function snap(game: GameRecord, def: RuleDefinition): Omit<TraceEntry, 'n' | 'intent' | 'ok' | 'error' | 'message'> {
  const p = game.state.phase;
  const out: Omit<TraceEntry, 'n' | 'intent' | 'ok' | 'error' | 'message'> = {
    phase: p.kind,
    status: game.status,
    cursor: { roundIdx: game.roundIdx, stepIdx: game.stepIdx }
  };
  if (p.kind === 'roll') { out.expectedPlayerId = p.expectedPlayerId; out.emoji = p.emoji; }
  const ld = game.state.lastDice;
  out.lastDice = ld ? { userId: ld.userId, value: ld.value, emoji: ld.emoji } : null;
  out.lastDraw = game.state.lastDraw ?? null;
  out.loops = game.state.loopCounters;
  return out;
}

// ---------- 运行 ----------
function pickValue(policy: 'min' | 'max', emoji: DiceEmoji): number {
  const max = DICE_EMOJI_MAX_VALUE[emoji];
  return policy === 'max' ? max : 1;
}

function runPlaythrough(spec: PlaythroughSpec): TraceEntry[] {
  const def = resolveRule(spec.rule);
  const { game, players } = buildGame(def, spec.players);
  beginGame(game, def);
  const trace: TraceEntry[] = [];
  let n = 0;

  for (let i = 0; i < spec.policy.maxOps && game.status !== 'ended'; i++) {
    const phase = game.state.phase;
    let it: Intent;
    if (phase.kind === 'roll') {
      it = { type: 'roll', userId: phase.expectedPlayerId ?? players[0].userId, value: pickValue(spec.policy.value, phase.emoji), emoji: phase.emoji };
    } else if (phase.kind === 'showdown') {
      const pending = players.find(p => !phase.rolls.some(r => r.userId === p.userId));
      if (!pending) break;
      it = { type: 'showdownRoll', userId: pending.userId, value: pickValue(spec.policy.value, phase.emoji), emoji: phase.emoji };
    } else if (phase.kind === 'choice') {
      it = { type: 'choice', userId: phase.pickedBy ?? players[0].userId, optionIdx: Math.min(spec.policy.choice, phase.options.length - 1) };
    } else if (phase.kind === 'text' || phase.kind === 'punish') {
      it = { type: 'next', userId: players[0].userId };
    } else {
      break;
    }
    const r = applyIntent(game, def, players, it);
    trace.push({ n: n++, intent: it, ok: r.ok, error: r.error, message: r.message, ...snap(game, def) });
    if (!r.ok) break;
  }
  if (game.status !== 'ended') {
    throw new Error(`[${spec.name}] playthrough 未在 ${spec.policy.maxOps} 步内结束（可能死循环）`);
  }
  return trace;
}

function runScripted(spec: ScriptedSpec): TraceEntry[] {
  const def = resolveRule(spec.rule);
  const { game, players } = buildGame(def, spec.players);
  const trace: TraceEntry[] = [];
  let n = 0;

  for (const step of spec.steps) {
    const r = applyIntent(game, def, players, step.do);
    const entry: TraceEntry = { n: n++, intent: step.do, ok: r.ok, error: r.error, message: r.message, ...snap(game, def) };
    trace.push(entry);
    if (step.expect) assertExpect(entry, r, step.expect, spec.name);
  }
  return trace;
}

function assertExpect(entry: TraceEntry, r: ApplyOut, ex: Expect, specName: string): void {
  const fail = (msg: string) => { throw new Error(`[${specName}] 第 ${entry.n} 步断言失败：${msg}\n  intent=${JSON.stringify(entry.intent)}\n  实际=${JSON.stringify({ ok: entry.ok, error: entry.error, phase: entry.phase, expectedPlayerId: entry.expectedPlayerId, lastDraw: entry.lastDraw, message: entry.message })}`); };
  if (ex.ok !== undefined && entry.ok !== ex.ok) fail(`ok 期望 ${ex.ok} 实得 ${entry.ok}`);
  if (ex.error !== undefined && !(entry.error ?? '').includes(ex.error)) fail(`error 期望含 "${ex.error}" 实得 "${entry.error}"`);
  if (ex.phase !== undefined && entry.phase !== ex.phase) fail(`phase 期望 ${ex.phase} 实得 ${entry.phase}`);
  if (ex.expectedPlayerId !== undefined && entry.expectedPlayerId !== ex.expectedPlayerId) fail(`expectedPlayerId 期望 ${ex.expectedPlayerId} 实得 ${entry.expectedPlayerId}`);
  if (ex.roundIdx !== undefined && entry.cursor.roundIdx !== ex.roundIdx) fail(`roundIdx 期望 ${ex.roundIdx}`);
  if (ex.stepIdx !== undefined && entry.cursor.stepIdx !== ex.stepIdx) fail(`stepIdx 期望 ${ex.stepIdx} 实得 ${entry.cursor.stepIdx}`);
  if (ex.messageContains !== undefined && !(entry.message ?? '').includes(ex.messageContains)) fail(`message 期望含 "${ex.messageContains}" 实得 "${entry.message}"`);
  if (ex.lastDraw !== undefined && entry.lastDraw !== ex.lastDraw) fail(`lastDraw 期望 ${ex.lastDraw} 实得 ${entry.lastDraw}`);
  if (ex.loops !== undefined) {
    for (const [k, v] of Object.entries(ex.loops)) {
      if ((entry.loops ?? {})[k] !== v) fail(`loops[${k}] 期望 ${v} 实得 ${(entry.loops ?? {})[k]}`);
    }
  }
}

// ---------- golden ----------
function serialize(trace: TraceEntry[]): string {
  return JSON.stringify(trace, null, 2) + '\n';
}

function loadSpecs(): { file: string; spec: Spec }[] {
  const files = readdirSync(SPECS_DIR).filter(f => f.endsWith('.spec.json')).sort();
  return files.map(f => ({ file: f, spec: JSON.parse(readFileSync(join(SPECS_DIR, f), 'utf8')) as Spec }));
}

function main(): void {
  const args = process.argv.slice(2);
  const update = args.includes('--update');
  const filter = args.find(a => !a.startsWith('--'));

  if (!existsSync(GOLDEN_DIR)) mkdirSync(GOLDEN_DIR, { recursive: true });

  const specs = loadSpecs().filter(({ file, spec }) => !filter || file.includes(filter) || spec.name.includes(filter));
  let pass = 0, fail = 0, updated = 0;

  for (const { file, spec } of specs) {
    const trace = spec.kind === 'playthrough' ? runPlaythrough(spec) : runScripted(spec);
    const goldenName = basename(file, '.spec.json') + '.trace.json';
    const goldenPath = join(GOLDEN_DIR, goldenName);
    const actual = serialize(trace);

    if (update || !existsSync(goldenPath)) {
      writeFileSync(goldenPath, actual);
      console.log(`  ↻ 录制 ${goldenName}（${trace.length} 步）`);
      updated++;
      continue;
    }
    const golden = readFileSync(goldenPath, 'utf8').replace(/\r\n/g, '\n');
    if (golden === actual) {
      console.log(`  ✓ ${spec.name}（${trace.length} 步）`);
      pass++;
    } else {
      console.log(`  ✗ ${spec.name} —— golden 不一致（${goldenName}）`);
      const g = golden.split('\n'), a = actual.split('\n');
      for (let i = 0; i < Math.max(g.length, a.length); i++) {
        if (g[i] !== a[i]) { console.log(`      行 ${i + 1}: golden=${JSON.stringify(g[i])}  actual=${JSON.stringify(a[i])}`); break; }
      }
      fail++;
    }
  }

  console.log(`\nspec: ${pass} passed, ${fail} failed, ${updated} recorded（共 ${specs.length}）`);
  if (fail > 0) process.exit(1);
}

main();
