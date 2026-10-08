import type {
  Game, GamePlayer, RuleDefinition, GamePhase, GameState, Step,
  ChoiceGoto, ChoiceOption, DiceEmoji, UserId,
  ShowdownResult, BranchConditionInput, BranchCondition, CompareOp
} from './model.js';
import {
  DICE_EMOJI_MAX_VALUE, resolveRollEmoji, resolveShowdownEmoji,
  decodeSlotValue, isJackpot, SLOT_SYMBOL_LABEL
} from './model.js';
import { now } from './clock.js';
import { displayName } from './names.js';

function playersOf(game: Game): GamePlayer[] {
  return game.players ?? [];
}

export function findStep(definition: RuleDefinition, roundIdx: number, stepIdx: number): Step | undefined {
  return definition.rounds[roundIdx]?.steps[stepIdx];
}

export function stepKey(roundIdx: number, stepIdx: number): string {
  return `${roundIdx}:${stepIdx}`;
}

export function initialState(): GameState {
  return { phase: { kind: 'signup' }, stepHitCounts: {}, loopCounters: {} };
}

export function nextRollerId(players: GamePlayer[], after: UserId | null): UserId | null {
  if (!players.length) return null;
  if (players.length === 1) return players[0].userId;
  const startIdx = after === null
    ? -1
    : players.findIndex(p => p.userId === after);
  const nextIdx = startIdx < 0 ? 0 : (startIdx + 1) % players.length;
  return players[nextIdx].userId;
}

export function pickPunishText(step: Extract<Step, { type: 'punish' }>, hitCount: number): string {
  if (!step.ladder.length) return step.defaultText;
  const applicable = step.ladder.filter(l => l.at <= hitCount).sort((a, b) => b.at - a.at);
  return applicable[0]?.text ?? step.defaultText;
}

function roundLenOf(definition: RuleDefinition, roundIdx: number): number {
  return definition.rounds[roundIdx]?.steps.length ?? 0;
}

export function resolveChoiceGoto(goto: ChoiceGoto, roundIdx: number, stepIdx: number, roundLen: number): { roundIdx: number; stepIdx: number } {
  if (goto === 'next') return { roundIdx, stepIdx: stepIdx + 1 };
  if (goto === 'end') return { roundIdx, stepIdx: roundLen }; // 一轮之末 → 触发轮结束逻辑
  return goto;
}

/** 把 1..sourceMax 的掷骰值映射到 1..count 号 */
export function drawBucket(value: number, count: number, uniform: 'equal' | 'exact', sourceMax: number): number {
  if (uniform === 'exact') {
    const m = count * Math.floor(sourceMax / count);
    const w = m / count;
    const v = Math.max(1, Math.min(value, m));
    return Math.floor((v - 1) / w) + 1;
  }
  const base = Math.floor(sourceMax / count);
  const rem = sourceMax % count;
  for (let i = 1; i <= count; i++) {
    const t = i * base + Math.min(i, rem);
    if (value <= t) return i;
  }
  return count;
}

/** 从结果槽里挑一个玩家（winner / loser），并列时按名次顺序取最前者（与看板显示一致） */
export function resolveActorPick(
  game: Game,
  players: GamePlayer[],
  pick: 'winner' | 'loser',
  slot?: string
): UserId | null {
  const key = slot ?? game.state.lastResultSlot ?? 'last';
  const res = game.state.results?.[key];
  if (!res) return null;
  const ids = pick === 'winner' ? res.winners : res.losers;
  if (!ids.length) return null;
  const byRanking = res.ranking.map(e => e.userId).filter(id => ids.includes(id));
  if (byRanking.length) return byRanking[0];
  const ordered = players.map(p => p.userId).filter(id => ids.includes(id));
  return ordered[0] ?? ids[0] ?? null;
}

function resetToEnded(game: Game): GamePhase {
  game.status = 'ended';
  game.endedAt = now();
  game.state = {
    phase: { kind: 'signup' },
    stepHitCounts: game.state.stepHitCounts,
    loopCounters: game.state.loopCounters,
    lastRollerId: game.state.lastRollerId,
    lastDice: game.state.lastDice,
    lastMessage: game.state.lastMessage,
    results: game.state.results,
    lastResultSlot: game.state.lastResultSlot,
    activeActorId: game.state.activeActorId
  };
  return game.state.phase;
}

export function beginGame(game: Game, definition: RuleDefinition): GamePhase {
  game.roundIdx = 0;
  game.stepIdx = 0;
  game.state = initialState();
  return advanceToStep(game, definition, 0, 0);
}

export function advanceToStep(game: Game, definition: RuleDefinition, roundIdx: number, stepIdx: number): GamePhase {
  return stepTo(game, definition, roundIdx, stepIdx, {});
}

/** guard 记录"本次推进链路"里每个 branch step 被访问的次数，用于拦截自环 */
function stepTo(game: Game, definition: RuleDefinition, roundIdx: number, stepIdx: number, guard: Record<string, number>): GamePhase {
  const round = definition.rounds[roundIdx];
  if (!round) {
    return resetToEnded(game);
  }
  const step = round.steps[stepIdx];
  if (!step) {
    if (round.loop) {
      const key = String(roundIdx);
      const newCount = (game.state.loopCounters[key] ?? 0) + 1;
      game.state.loopCounters = { ...game.state.loopCounters, [key]: newCount };
      if (round.maxLoops === undefined || newCount < round.maxLoops) {
        return stepTo(game, definition, roundIdx, 0, guard);
      }
      const nextRoundIdx = roundIdx + 1;
      if (definition.rounds[nextRoundIdx]) {
        return stepTo(game, definition, nextRoundIdx, 0, guard);
      }
      return resetToEnded(game);
    }
    const nextRoundIdx = roundIdx + 1;
    if (definition.rounds[nextRoundIdx]) {
      return stepTo(game, definition, nextRoundIdx, 0, guard);
    }
    return resetToEnded(game);
  }

  // branch step：立即求值并跳转（不进入 resting phase）
  if (step.type === 'branch') {
    const key = stepKey(roundIdx, stepIdx);
    const hits = (guard[key] ?? 0) + 1;
    guard[key] = hits;
    let target: { roundIdx: number; stepIdx: number } | null = null;
    if (hits <= step.maxHits) {
      for (const c of step.cases) {
        if (evaluateCondition(game, c.if)) {
          target = resolveChoiceGoto(c.goto, roundIdx, stepIdx, round.steps.length);
          break;
        }
      }
      if (!target) target = resolveChoiceGoto(step.default, roundIdx, stepIdx, round.steps.length);
    } else {
      // 超过安全次数：强制前进，避免分支自环死循环
      target = { roundIdx, stepIdx: stepIdx + 1 };
    }
    return stepTo(game, definition, target.roundIdx, target.stepIdx, guard);
  }

  game.roundIdx = roundIdx;
  game.stepIdx = stepIdx;
  game.status = 'in_progress';

  const key = stepKey(roundIdx, stepIdx);
  const hit = game.state.stepHitCounts[key] ?? 0;
  const players = playersOf(game);

  if (step.type === 'roll') {
    let expectedPlayerId: UserId | null = null;
    if (step.assignment === 'next_player') {
      expectedPlayerId = nextRollerId(players, game.state.lastRollerId ?? null);
    } else if (step.assignment === 'self') {
      expectedPlayerId = game.state.lastRollerId ?? (players[0]?.userId ?? null);
    } else if (step.assignment === 'winner' || step.assignment === 'loser') {
      expectedPlayerId = resolveActorPick(game, players, step.assignment, step.actorSlot);
    } else if (step.assignment === 'actor') {
      expectedPlayerId = game.state.activeActorId ?? null;
    }
    game.state.phase = { kind: 'roll', stepIdx, roundIdx, expectedPlayerId, emoji: resolveRollEmoji(definition, round, step) };
  } else if (step.type === 'text') {
    game.state.phase = { kind: 'text', stepIdx, roundIdx, text: step.prompt ?? step.label };
  } else if (step.type === 'choice') {
    let pickedBy: UserId | null;
    if (step.chooser === 'any') {
      pickedBy = null;
    } else if (step.chooser === 'winner' || step.chooser === 'loser') {
      pickedBy = resolveActorPick(game, players, step.chooser, step.chooserSlot);
    } else if (step.chooser === 'actor') {
      pickedBy = game.state.activeActorId ?? null;
    } else {
      pickedBy = game.state.lastDice?.userId ?? null;
    }
    game.state.phase = { kind: 'choice', stepIdx, roundIdx, options: step.options as ChoiceOption[], pickedBy };
  } else if (step.type === 'punish') {
    game.state.phase = { kind: 'punish', stepIdx, roundIdx, text: pickPunishText(step, hit + 1), hitCount: hit + 1 };
    game.state.stepHitCounts[key] = hit + 1;
  } else {
    // showdown
    game.state.phase = {
      kind: 'showdown', stepIdx, roundIdx,
      emoji: resolveShowdownEmoji(definition, round, step),
      order: step.order, tie: step.tie, slot: step.as ?? 'last', rolls: []
    };
  }
  return game.state.phase;
}

export function applyRoll(game: Game, definition: RuleDefinition, userId: UserId, value: number, players: GamePlayer[], emoji?: DiceEmoji): { message: string; phase: GamePhase } {
  const phase = game.state.phase;
  if (phase.kind !== 'roll') throw Error('当前不等待色子');
  if (phase.expectedPlayerId !== null && phase.expectedPlayerId !== userId) {
    throw Error('不是你的回合，请等待系统指定玩家');
  }
  const isPlayer = players.some(p => p.userId === userId);
  if (!isPlayer) throw Error('只有已加入的玩家可以扔色子');
  const usedEmoji: DiceEmoji = emoji ?? phase.emoji;
  if (usedEmoji !== phase.emoji) throw Error(`本轮需要 ${phase.emoji}，你发的是 ${usedEmoji}`);
  const max = DICE_EMOJI_MAX_VALUE[phase.emoji];
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw Error(`${phase.emoji} 的点数范围是 1-${max}`);
  }

  const step = findStep(definition, phase.roundIdx, phase.stepIdx);
  if (!step || step.type !== 'roll') throw Error('找不到骰子步骤');
  const sourceMax = DICE_EMOJI_MAX_VALUE[phase.emoji];
  const slotSuffix = usedEmoji === '🎰'
    ? (() => {
        const d = decodeSlotValue(value);
        const jp = isJackpot(value);
        return `\n   ${SLOT_SYMBOL_LABEL[d.r1]} ${SLOT_SYMBOL_LABEL[d.r2]} ${SLOT_SYMBOL_LABEL[d.r3]}${jp ? ' 🎉 JACKPOT' : ''}`;
      })()
    : '';

  // roll.draw：抽签（按点数落到 1..count 号，再跳转到对应目标）
  if (step.draw) {
    const draw = step.draw;
    if (draw.count > sourceMax) throw Error(`draw.count=${draw.count} 超过 ${phase.emoji} 的点数上限 ${sourceMax}`);
    if (draw.uniform === 'exact') {
      const m = draw.count * Math.floor(sourceMax / draw.count);
      if (value > m) {
        const retry = `${usedEmoji} ${displayName(userId)} 掷出 ${value}，超出范围（只接受 1-${m}），请再抽一次。`;
        game.state.lastMessage = retry;
        return { message: retry, phase: game.state.phase };
      }
    }
    const bucket = drawBucket(value, draw.count, draw.uniform, sourceMax);
    game.state.lastDice = { userId, value, at: now(), emoji: usedEmoji };
    game.state.lastRollerId = userId;
    game.state.activeActorId = userId;
    game.state.lastDraw = bucket;
    if (draw.store) game.state.draws = { ...(game.state.draws ?? {}), [draw.store]: bucket };
    game.players = players;
    const dmsg = `${usedEmoji} ${displayName(userId)} 抽到第 <b>${bucket}</b> 号（点数 ${value}）${slotSuffix}`;
    game.state.lastMessage = dmsg;
    const target = resolveChoiceGoto(draw.targets[bucket - 1] ?? 'next', phase.roundIdx, phase.stepIdx, roundLenOf(definition, phase.roundIdx));
    advanceToStep(game, definition, target.roundIdx, target.stepIdx);
    return { message: dmsg, phase: game.state.phase };
  }

  game.state.lastDice = { userId, value, at: now(), emoji: usedEmoji };
  game.state.lastRollerId = userId;
  game.state.activeActorId = userId;
  game.players = players;
  const message = `${usedEmoji} ${displayName(userId)} 掷出 ${value} — ${step.label}${slotSuffix}`;
  game.state.lastMessage = message;
  advanceToStep(game, definition, phase.roundIdx, phase.stepIdx + 1);
  return { message, phase: game.state.phase };
}

/** showdown 收集一颗骰子；集齐后自动结算 */
export function applyShowdownRoll(
  game: Game, definition: RuleDefinition, userId: UserId, value: number, players: GamePlayer[], emoji?: DiceEmoji
): { message: string; settled: boolean; rerolled?: boolean; phase: GamePhase } {
  const phase = game.state.phase;
  if (phase.kind !== 'showdown') throw Error('当前不等待比大小');
  if (!players.some(p => p.userId === userId)) throw Error('只有已加入的玩家可以扔色子');
  if (phase.rolls.some(r => r.userId === userId)) throw Error('你已经掷过了，等待其他玩家');
  const usedEmoji: DiceEmoji = emoji ?? phase.emoji;
  if (usedEmoji !== phase.emoji) throw Error(`本轮需要 ${phase.emoji}，你发的是 ${usedEmoji}`);
  const max = DICE_EMOJI_MAX_VALUE[phase.emoji];
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw Error(`${phase.emoji} 的点数范围是 1-${max}`);
  }

  game.players = players;
  phase.rolls.push({ userId, value, at: now() });
  let message = `${usedEmoji} ${displayName(userId)} 掷出 ${value}`;
  if (usedEmoji === '🎰') {
    const d = decodeSlotValue(value);
    const jp = isJackpot(value);
    message += `\n   ${SLOT_SYMBOL_LABEL[d.r1]} ${SLOT_SYMBOL_LABEL[d.r2]} ${SLOT_SYMBOL_LABEL[d.r3]}${jp ? ' 🎉 JACKPOT' : ''}`;
  }
  game.state.lastMessage = message;

  if (phase.rolls.length >= players.length) {
    const { message: finalMessage, rerolled } = settleShowdown(game, definition, players);
    return { message: finalMessage, settled: true, rerolled, phase: game.state.phase };
  }
  return { message, settled: false, phase: game.state.phase };
}

/** 结算 showdown：排序、写结果槽、按 actor 设置主角、推进到下一步。
 *  返回 rerolled=true 表示本轮出现并列、已清空重掷（未写结果、未推进）；UI 由调用方决定。 */
export function settleShowdown(game: Game, definition: RuleDefinition, players: GamePlayer[]): { message: string; rerolled: boolean } {
  const phase = game.state.phase;
  if (phase.kind !== 'showdown') throw Error('当前不在比大小阶段');
  const step = findStep(definition, phase.roundIdx, phase.stepIdx);
  if (!step || step.type !== 'showdown') throw Error('找不到比大小步骤');
  const slot = step.as ?? 'last';

  const totals: Record<string, number> = {};
  if (step.accumulate) {
    const prev = game.state.results?.[slot];
    if (prev) for (const [u, v] of Object.entries(prev.totals)) totals[u] = v;
  }
  const firstAt: Record<string, number> = {};
  for (const r of phase.rolls) {
    totals[String(r.userId)] = (totals[String(r.userId)] ?? 0) + r.value;
    if (firstAt[String(r.userId)] === undefined) firstAt[String(r.userId)] = r.at;
  }

  const entries = players.map(p => ({ userId: p.userId, value: totals[String(p.userId)] ?? 0 }));
  const useFirstTie = step.tie === 'first' && !step.accumulate;
  const sorted = [...entries].sort((a, b) => {
    if (step.order === 'low') {
      if (a.value !== b.value) return a.value - b.value;
    } else if (step.order === 'high') {
      if (a.value !== b.value) return b.value - a.value;
    }
    if (useFirstTie) {
      const fa = firstAt[String(a.userId)] ?? Number.MAX_SAFE_INTEGER;
      const fb = firstAt[String(b.userId)] ?? Number.MAX_SAFE_INTEGER;
      if (fa !== fb) return fa - fb;
    }
    return a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0;
  });

  let winners: UserId[] = [];
  let losers: UserId[] = [];
  if (step.order !== 'none' && sorted.length) {
    if (step.tie === 'first') {
      winners = [sorted[0].userId];
      losers = [sorted[sorted.length - 1].userId];
    } else {
      const top = sorted[0].value;
      const bottom = sorted[sorted.length - 1].value;
      winners = sorted.filter(e => e.value === top).map(e => e.userId);
      losers = sorted.filter(e => e.value === bottom).map(e => e.userId);
    }
  }

  const label = step.order === 'high' ? '比大' : step.order === 'low' ? '比小' : '收集';
  const lines = sorted.map((e, i) => `${i + 1}. ${displayName(e.userId)} → ${e.value}`);

  // tie:'reroll'：赢家或输家出现并列 → 清空本轮重掷（不写结果槽、不推进）
  if (step.tie === 'reroll' && step.order !== 'none' && (winners.length > 1 || losers.length > 1)) {
    phase.rolls = [];
    const notice = `🏆 比大小结果（${label}）\n${lines.join('\n')}\n\n⚠️ 最大/最小出现并列，请全员重新掷一次。`;
    game.state.lastMessage = notice;
    return { message: notice, rerolled: true };
  }

  const values = entries.map(e => e.value);
  const result: ShowdownResult = {
    order: step.order,
    totals,
    ranking: sorted,
    winners,
    losers,
    sum: values.reduce((a, b) => a + b, 0),
    max: values.length ? Math.max(...values) : 0,
    min: values.length ? Math.min(...values) : 0
  };
  game.state.results = { ...(game.state.results ?? {}), [slot]: result };
  game.state.lastResultSlot = slot;

  if (step.actor === 'winner') game.state.activeActorId = winners[0];
  else if (step.actor === 'loser') game.state.activeActorId = losers[0];

  const extremes = step.order === 'none'
    ? ''
    : `\n\n👉 赢家：${winners.map(displayName).join('、') || '—'} ｜ 输家：${losers.map(displayName).join('、') || '—'}`;
  const message = `🏆 比大小结果（${label}）\n${lines.join('\n')}${extremes}`;
  game.state.lastMessage = message;
  advanceToStep(game, definition, phase.roundIdx, phase.stepIdx + 1);
  return { message, rerolled: false };
}

function cmp(a: number, op: CompareOp, b: number): boolean {
  switch (op) {
    case 'gt': return a > b;
    case 'gte': return a >= b;
    case 'lt': return a < b;
    case 'lte': return a <= b;
    case 'eq': return a === b;
    case 'ne': return a !== b;
  }
}

/** 求值 branch 条件 */
export function evaluateCondition(game: Game, cond: BranchConditionInput): boolean {
  const c: BranchCondition = typeof cond === 'string' ? { check: cond } : cond;
  const key = ('slot' in c && c.slot) ? c.slot : (game.state.lastResultSlot ?? 'last');
  const res = game.state.results?.[key];
  switch (c.check) {
    case 'tie': return !!res && res.winners.length > 1;
    case 'unique': return !!res && res.winners.length === 1;
    case 'any': return !!res && res.ranking.some(e => e.value === c.value);
    case 'all': return !!res && res.ranking.length > 0 && res.ranking.every(e => e.value === c.value);
    case 'rank': {
      if (!res) return false;
      const idx = c.pick > 0 ? c.pick - 1 : res.ranking.length + c.pick;
      const e = res.ranking[idx];
      return !!e && cmp(e.value, c.op, c.value);
    }
    case 'sum': return !!res && cmp(res.sum, c.op, c.value);
    case 'count': return cmp(res?.ranking.length ?? 0, c.op, c.value);
    case 'dice': {
      const v = game.state.lastDice?.value;
      return v !== undefined && cmp(v, c.op, c.value);
    }
  }
}

export function applyNext(game: Game, definition: RuleDefinition, _userId: UserId, players?: GamePlayer[]): GamePhase {
  const phase = game.state.phase;
  if (phase.kind === 'signup') throw Error('报名阶段不能 /next');
  if (phase.kind === 'roll') throw Error('当前在等色子，等玩家掷 🎲 后再 /next');
  if (phase.kind === 'showdown') {
    const ps = players ?? playersOf(game);
    if (!phase.rolls.length) {
      return advanceToStep(game, definition, phase.roundIdx, phase.stepIdx + 1);
    }
    game.state.lastMessage = '👉 管理员强制结算比大小';
    settleShowdown(game, definition, ps);
    return game.state.phase;
  }
  if (phase.kind === 'choice') {
    if (!phase.options.length) throw Error('选项为空');
    const target = resolveChoiceGoto(phase.options[0].goto, phase.roundIdx, phase.stepIdx, roundLenOf(definition, phase.roundIdx));
    game.state.lastMessage = `👉 管理员强制选择「${phase.options[0].text}」`;
    return advanceToStep(game, definition, target.roundIdx, target.stepIdx);
  }
  const step = findStep(definition, phase.roundIdx, phase.stepIdx);
  const customNext = (step?.type === 'text' || step?.type === 'punish') ? step.next : undefined;
  if (customNext) {
    const target = resolveChoiceGoto(customNext, phase.roundIdx, phase.stepIdx, roundLenOf(definition, phase.roundIdx));
    return advanceToStep(game, definition, target.roundIdx, target.stepIdx);
  }
  return advanceToStep(game, definition, phase.roundIdx, phase.stepIdx + 1);
}

export function applySkip(game: Game, definition: RuleDefinition): GamePhase {
  const phase = game.state.phase;
  if (phase.kind === 'signup') throw Error('报名阶段不能 /skip');
  if (phase.kind === 'roll') throw Error('当前在等色子，无法跳过');
  if (phase.kind === 'showdown') {
    return advanceToStep(game, definition, phase.roundIdx, phase.stepIdx + 1);
  }
  if (phase.kind === 'choice') {
    if (!phase.options.length) throw Error('选项为空');
    const target = resolveChoiceGoto(phase.options[0].goto, phase.roundIdx, phase.stepIdx, roundLenOf(definition, phase.roundIdx));
    game.state.lastMessage = `👉 跳过选择，强制进入「${phase.options[0].text}」`;
    return advanceToStep(game, definition, target.roundIdx, target.stepIdx);
  }
  const step = findStep(definition, phase.roundIdx, phase.stepIdx);
  const customNext = (step?.type === 'text' || step?.type === 'punish') ? step.next : undefined;
  if (customNext) {
    const target = resolveChoiceGoto(customNext, phase.roundIdx, phase.stepIdx, roundLenOf(definition, phase.roundIdx));
    return advanceToStep(game, definition, target.roundIdx, target.stepIdx);
  }
  return advanceToStep(game, definition, phase.roundIdx, phase.stepIdx + 1);
}

export function applyChoice(game: Game, definition: RuleDefinition, userId: UserId, optionIdx: number): { message: string; phase: GamePhase } {
  const phase = game.state.phase;
  if (phase.kind !== 'choice') throw Error('当前不在选择阶段');
  if (phase.pickedBy !== null && phase.pickedBy !== userId) throw Error('不是你的回合，请等待系统指定玩家');
  const opt = phase.options[optionIdx];
  if (!opt) throw Error('选项不存在');
  const target = resolveChoiceGoto(opt.goto, phase.roundIdx, phase.stepIdx, roundLenOf(definition, phase.roundIdx));
  const message = `👉 ${displayName(userId)} 选择了「${opt.text}」`;
  game.state.lastMessage = message;
  game.state.lastRollerId = userId;
  game.state.activeActorId = userId;
  advanceToStep(game, definition, target.roundIdx, target.stepIdx);
  return { message, phase: game.state.phase };
}

// ───────────────────────── 模板渲染 ─────────────────────────

const TEMPLATE_RE = /\{([a-zA-Z0-9_.\-]+)\}/g;

function escHtml(s: string): string {
  return s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function nameMention(userId: UserId, mode: 'html' | 'plain'): string {
  const label = displayName(userId);
  return mode === 'html' ? `<a href="tg://user?id=${userId}">${escHtml(label)}</a>` : label;
}

function resolveTemplateToken(token: string, game: Game, mode: 'html' | 'plain'): string | null {
  const dot = token.indexOf('.');
  const slot = dot >= 0 ? token.slice(0, dot) : undefined;
  const sel = dot >= 0 ? token.slice(dot + 1) : token;

  if (sel === 'actor') {
    const id = game.state.activeActorId;
    return id ? nameMention(id, mode) : null;
  }
  if (!slot && sel === 'dice') {
    const d = game.state.lastDice;
    return d ? String(d.value) : null;
  }
  if (!slot && sel === 'roller') {
    const id = game.state.lastDice?.userId;
    return id ? nameMention(id, mode) : null;
  }
  if (!slot && sel === 'draw') {
    return game.state.lastDraw !== undefined ? String(game.state.lastDraw) : null;
  }
  if (slot === 'draw') {
    const n = game.state.draws?.[sel];
    return n !== undefined ? String(n) : null;
  }

  const key = slot ?? game.state.lastResultSlot ?? 'last';
  const res = game.state.results?.[key];
  if (!res) return null;
  switch (sel) {
    case 'winner':
    case 'winners':
    case 'loser':
    case 'losers': {
      const ids = sel.startsWith('w') ? res.winners : res.losers;
      return ids.length ? ids.map(id => nameMention(id, mode)).join('、') : null;
    }
    case 'ranking':
      return res.ranking.map(e => `${nameMention(e.userId, mode)} ${e.value}`).join(' · ');
    case 'sum': return String(res.sum);
    case 'max': return String(res.max);
    case 'min': return String(res.min);
    case 'count': return String(res.ranking.length);
    default: {
      const m = /^rank(-?\d+)$/.exec(sel);
      if (!m) return null;
      const n = Number(m[1]);
      const idx = n > 0 ? n - 1 : res.ranking.length + n;
      const e = res.ranking[idx];
      return e ? nameMention(e.userId, mode) : null;
    }
  }
}

/**
 * 渲染文案模板。群消息用 'html'（字面段转义、玩家插入 @mention），
 * Mini App 用 'plain'。无法识别的 token 原样保留。
 */
export function formatTemplate(text: string, game: Game, mode: 'html' | 'plain'): string {
  if (!text) return text;
  if (!text.includes('{')) return mode === 'html' ? escHtml(text) : text;
  let out = '';
  let last = 0;
  TEMPLATE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TEMPLATE_RE.exec(text))) {
    const lit = text.slice(last, m.index);
    out += mode === 'html' ? escHtml(lit) : lit;
    const rep = resolveTemplateToken(m[1], game, mode);
    out += rep ?? (mode === 'html' ? escHtml(m[0]) : m[0]);
    last = m.index + m[0].length;
  }
  const tail = text.slice(last);
  out += mode === 'html' ? escHtml(tail) : tail;
  return out;
}

export function loopProgress(
  definition: RuleDefinition,
  loopCounters: Record<string, number>,
  roundIdx: number
): { current: number; total: number | null } | null {
  const round = definition.rounds[roundIdx];
  if (!round || !round.loop) return null;
  const raw = loopCounters[String(roundIdx)] ?? 0;
  const counter = typeof raw === 'number' ? raw : Number(raw) || 0;
  return { current: counter + 1, total: round.maxLoops ?? null };
}
