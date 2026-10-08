import { decodeSlotValue } from './model.js';
import type { RuleDefinition, Game, GamePlayer, UserId } from './model.js';
import { findStep, formatTemplate, loopProgress } from './rules.js';
import { displayName } from './names.js';

/**
 * 通道无关的「当前局面视图」。渲染成 HTML / 键盘是适配器的事；
 * 这里是纯数据（模板已解析为 plain 文案）。
 */
export type ViewPhase =
  | { kind: 'signup' }
  | { kind: 'roll'; roundIdx: number; stepIdx: number; expectedPlayerId: UserId | null; emoji: string; drawHint: number | null; stepLabel: string }
  | { kind: 'text'; roundIdx: number; stepIdx: number; text: string; stepLabel: string }
  | { kind: 'choice'; roundIdx: number; stepIdx: number; options: Array<Record<string, unknown>>; pickedBy: UserId | null; stepLabel: string }
  | { kind: 'showdown'; roundIdx: number; stepIdx: number; emoji: string; order: string; slot: string; stepLabel: string; rolls: { userId: UserId; value: number }[]; pending: UserId[]; total: number }
  | { kind: 'punish'; roundIdx: number; stepIdx: number; text: string; hitCount: number; stepLabel: string };

export type View = {
  gameId: string;
  ruleId: string;
  status: string;
  rule: { ruleId: string; name: string; rounds: unknown } | null;
  roundIdx: number;
  stepIdx: number;
  loopProgress: { current: number; total: number | null } | null;
  phase: ViewPhase;
  players: Array<{ userId: UserId; label: string; isViewer: boolean }>;
  activeActorId: UserId | null;
  showActor: boolean;
  lastResult: unknown;
  lastDice: unknown;
  lastMessage: string | null;
  viewer: { id: UserId; isAdmin: boolean };
};

/** 由局面 + 规则 + 玩家（+ 观察者）构造视图。与 bot 的 snapshot 形状一致。 */
export function buildView(
  game: Game,
  definition: RuleDefinition | undefined,
  players: GamePlayer[],
  viewerId: UserId,
  isAdminViewer: boolean
): View {
  const rule = definition ?? null;
  const phase = game.state.phase;
  const step = rule && phase.kind !== 'signup' ? findStep(rule, phase.roundIdx, phase.stepIdx) : undefined;
  const fmt = (t: string) => formatTemplate(t, game, 'plain');
  const lastResult = game.state.lastResultSlot ? game.state.results?.[game.state.lastResultSlot] : undefined;
  return {
    gameId: game.gameId,
    ruleId: game.ruleId,
    status: game.status,
    rule: rule ? { ruleId: rule.name, name: rule.name, rounds: rule.rounds } : null,
    roundIdx: game.roundIdx,
    stepIdx: game.stepIdx,
    loopProgress: rule && phase.kind !== 'signup' ? loopProgress(rule, game.state.loopCounters, phase.roundIdx) : null,
    phase: phase.kind === 'signup' ? { kind: 'signup' as const }
      : phase.kind === 'roll' ? { kind: 'roll' as const, roundIdx: phase.roundIdx, stepIdx: phase.stepIdx, expectedPlayerId: phase.expectedPlayerId, emoji: phase.emoji, drawHint: step?.type === 'roll' && step.draw ? step.draw.count : null, stepLabel: step?.type === 'roll' ? fmt(step.label) : '' }
      : phase.kind === 'text' ? { kind: 'text' as const, roundIdx: phase.roundIdx, stepIdx: phase.stepIdx, text: fmt(phase.text), stepLabel: step?.type === 'text' ? fmt(step.label) : '' }
      : phase.kind === 'choice' ? { kind: 'choice' as const, roundIdx: phase.roundIdx, stepIdx: phase.stepIdx, options: phase.options.map(o => ({ ...o, text: fmt(o.text) })), pickedBy: phase.pickedBy, stepLabel: step?.type === 'choice' ? fmt(step.label) : '' }
      : phase.kind === 'showdown' ? {
          kind: 'showdown' as const, roundIdx: phase.roundIdx, stepIdx: phase.stepIdx, emoji: phase.emoji,
          order: phase.order, slot: phase.slot, stepLabel: step?.type === 'showdown' ? fmt(step.label) : '',
          rolls: phase.rolls.map(r => ({ userId: r.userId, value: r.value })),
          pending: players.filter(p => !phase.rolls.some(r => r.userId === p.userId)).map(p => p.userId),
          total: players.length
        }
      : { kind: 'punish' as const, roundIdx: phase.roundIdx, stepIdx: phase.stepIdx, text: fmt(phase.text), hitCount: phase.hitCount, stepLabel: step?.type === 'punish' ? fmt(step.label) : '' },
    players: players.map(p => ({
      userId: p.userId,
      label: displayName(p.userId),
      isViewer: p.userId === viewerId
    })),
    activeActorId: game.state.activeActorId ?? null,
    showActor: (step?.type === 'text' || step?.type === 'punish') ? !!step.showActor && !!game.state.activeActorId : false,
    lastResult: lastResult
      ? { slot: game.state.lastResultSlot!, order: lastResult.order, ranking: lastResult.ranking, winners: lastResult.winners, losers: lastResult.losers, sum: lastResult.sum, max: lastResult.max, min: lastResult.min }
      : null,
    lastDice: game.state.lastDice
      ? { ...game.state.lastDice, decoded: game.state.lastDice.emoji === '🎰' ? decodeSlotValue(game.state.lastDice.value) : null }
      : null,
    lastMessage: game.state.lastMessage ?? null,
    viewer: { id: viewerId, isAdmin: isAdminViewer }
  };
}
