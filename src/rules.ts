import type { GameRecord, GamePlayer, RuleDefinition, GamePhase, GameState, Step, ChoiceGoto, ChoiceOption, DiceEmoji } from './model.js';
import { DICE_EMOJI_MAX_VALUE, resolveRollEmoji, decodeSlotValue, isJackpot, SLOT_SYMBOL_LABEL } from './model.js';

export function displayName(userId: number): string {
  return `用户 #${String(userId).slice(-4)}`;
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

export function nextRollerId(players: GamePlayer[], after: number | null): number | null {
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

export function resolveChoiceGoto(goto: ChoiceGoto, roundIdx: number, stepIdx: number): { roundIdx: number; stepIdx: number } {
  if (goto === 'next') return { roundIdx, stepIdx: stepIdx + 1 };
  return goto;
}

export function beginGame(game: GameRecord, definition: RuleDefinition): GamePhase {
  game.roundIdx = 0;
  game.stepIdx = 0;
  game.state = initialState();
  return advanceToStep(game, definition, 0, 0);
}

export function advanceToStep(game: GameRecord, definition: RuleDefinition, roundIdx: number, stepIdx: number): GamePhase {
  const resetToEnded = () => {
    game.status = 'ended';
    game.endedAt = Date.now();
    game.state = {
      phase: { kind: 'signup' },
      stepHitCounts: game.state.stepHitCounts,
      loopCounters: game.state.loopCounters,
      lastRollerId: game.state.lastRollerId,
      lastDice: game.state.lastDice,
      lastMessage: game.state.lastMessage
    };
    return game.state.phase;
  };
  const round = definition.rounds[roundIdx];
  if (!round) {
    return resetToEnded();
  }
  const step = round.steps[stepIdx];
  if (!step) {
    if (round.loop) {
      const key = String(roundIdx);
      const newCount = (game.state.loopCounters[key] ?? 0) + 1;
      game.state.loopCounters = { ...game.state.loopCounters, [key]: newCount };
      if (round.maxLoops === undefined || newCount < round.maxLoops) {
        return advanceToStep(game, definition, roundIdx, 0);
      }
      const nextRoundIdx = roundIdx + 1;
      if (definition.rounds[nextRoundIdx]) {
        return advanceToStep(game, definition, nextRoundIdx, 0);
      }
      return resetToEnded();
    }
    const nextRoundIdx = roundIdx + 1;
    if (definition.rounds[nextRoundIdx]) {
      return advanceToStep(game, definition, nextRoundIdx, 0);
    }
    return resetToEnded();
  }
  game.roundIdx = roundIdx;
  game.stepIdx = stepIdx;
  game.status = 'in_progress';

  const key = stepKey(roundIdx, stepIdx);
  const hit = game.state.stepHitCounts[key] ?? 0;

  if (step.type === 'roll') {
    const players = (game as GameRecord & { _players?: GamePlayer[] })._players ?? [];
    let expectedPlayerId: number | null = null;
    if (step.assignment === 'next_player') {
      expectedPlayerId = nextRollerId(players, game.state.lastRollerId ?? null);
    } else if (step.assignment === 'self') {
      expectedPlayerId = game.state.lastRollerId ?? (players[0]?.userId ?? null);
    }
    game.state.phase = { kind: 'roll', stepIdx, roundIdx, expectedPlayerId, emoji: resolveRollEmoji(definition, round, step) };
  } else if (step.type === 'text') {
    game.state.phase = { kind: 'text', stepIdx, roundIdx, text: step.prompt ?? step.label };
  } else if (step.type === 'choice') {
    game.state.phase = {
      kind: 'choice',
      stepIdx,
      roundIdx,
      options: step.options as ChoiceOption[],
      pickedBy: game.state.lastDice?.userId ?? null
    };
  } else {
    game.state.phase = { kind: 'punish', stepIdx, roundIdx, text: pickPunishText(step, hit + 1), hitCount: hit + 1 };
    game.state.stepHitCounts[key] = hit + 1;
  }
  return game.state.phase;
}

export function applyRoll(game: GameRecord, definition: RuleDefinition, userId: number, value: number, players: GamePlayer[], emoji?: DiceEmoji): { message: string; phase: GamePhase } {
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

  game.state.lastDice = { userId, value, at: Date.now(), emoji: usedEmoji };
  game.state.lastRollerId = userId;
  (game as GameRecord & { _players?: GamePlayer[] })._players = players;
  const step = findStep(definition, phase.roundIdx, phase.stepIdx)!;
  let message = `${usedEmoji} ${displayName(userId)} 掷出 ${value} — ${step.label}`;
  if (usedEmoji === '🎰') {
    const d = decodeSlotValue(value);
    const jp = isJackpot(value);
    message += `\n   ${SLOT_SYMBOL_LABEL[d.r1]} ${SLOT_SYMBOL_LABEL[d.r2]} ${SLOT_SYMBOL_LABEL[d.r3]}${jp ? ' 🎉 JACKPOT' : ''}`;
  }
  game.state.lastMessage = message;
  advanceToStep(game, definition, phase.roundIdx, phase.stepIdx + 1);
  return { message, phase: game.state.phase };
}

export function applyNext(game: GameRecord, definition: RuleDefinition, _userId: number): GamePhase {
  const phase = game.state.phase;
  if (phase.kind === 'signup') throw Error('报名阶段不能 /next');
  if (phase.kind === 'roll') throw Error('当前在等色子，等玩家掷 🎲 后再 /next');
  if (phase.kind === 'choice') {
    if (!phase.options.length) throw Error('选项为空');
    const target = resolveChoiceGoto(phase.options[0].goto, phase.roundIdx, phase.stepIdx);
    game.state.lastMessage = `👉 管理员强制选择「${phase.options[0].text}」`;
    return advanceToStep(game, definition, target.roundIdx, target.stepIdx);
  }
  return advanceToStep(game, definition, phase.roundIdx, phase.stepIdx + 1);
}

export function applySkip(game: GameRecord, definition: RuleDefinition): GamePhase {
  const phase = game.state.phase;
  if (phase.kind === 'signup') throw Error('报名阶段不能 /skip');
  if (phase.kind === 'roll') throw Error('当前在等色子，无法跳过');
  if (phase.kind === 'choice') {
    if (!phase.options.length) throw Error('选项为空');
    const target = resolveChoiceGoto(phase.options[0].goto, phase.roundIdx, phase.stepIdx);
    game.state.lastMessage = `👉 跳过选择，强制进入「${phase.options[0].text}」`;
    return advanceToStep(game, definition, target.roundIdx, target.stepIdx);
  }
  return advanceToStep(game, definition, phase.roundIdx, phase.stepIdx + 1);
}

export function applyChoice(game: GameRecord, definition: RuleDefinition, userId: number, optionIdx: number): { message: string; phase: GamePhase } {
  const phase = game.state.phase;
  if (phase.kind !== 'choice') throw Error('当前不在选择阶段');
  if (phase.pickedBy !== null && phase.pickedBy !== userId) throw Error('不是你的回合，请等待系统指定玩家');
  const opt = phase.options[optionIdx];
  if (!opt) throw Error('选项不存在');
  const target = resolveChoiceGoto(opt.goto, phase.roundIdx, phase.stepIdx);
  const message = `👉 ${displayName(userId)} 选择了「${opt.text}」`;
  game.state.lastMessage = message;
  game.state.lastRollerId = userId;
  advanceToStep(game, definition, target.roundIdx, target.stepIdx);
  return { message, phase: game.state.phase };
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
