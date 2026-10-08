import type { RuleDefinition, GameRecord, GamePlayer, DiceEmoji, GamePhase } from './model.js';
import {
  beginGame, applyRoll, applyShowdownRoll, applyChoice, applyNext, applySkip, findStep
} from './rules.js';

/** 引擎唯一入口的输入：一个"意图"。 */
export type Intent =
  | { type: 'begin'; userId: number }
  | { type: 'roll'; userId: number; value: number; emoji: DiceEmoji }
  | { type: 'showdownRoll'; userId: number; value: number; emoji: DiceEmoji }
  | { type: 'choice'; userId: number; optionIdx: number }
  | { type: 'next'; userId: number }
  | { type: 'skip'; userId: number };

export type EngineErrorCode =
  | 'NOT_A_PLAYER' | 'NOT_YOUR_TURN' | 'ALREADY_ROLLED' | 'WRONG_EMOJI'
  | 'OUT_OF_RANGE' | 'NOT_IN_PHASE' | 'INVALID' | 'NO_STEP';

/** 语义事件（不含时间戳，保持确定性；需要时由调用方补 at）。 */
export type EngineEvent =
  | { type: 'gameStarted'; actor: number }
  | { type: 'phaseEntered'; phase: string; roundIdx: number; stepIdx: number }
  | { type: 'rollResolved'; actor: number; value: number; emoji: string }
  | { type: 'drawResolved'; actor: number; value: number; bucket: number }
  | { type: 'showdownRolled'; actor: number; value: number }
  | { type: 'showdownSettled'; actor: number }
  | { type: 'showdownRerolled'; actor: number }
  | { type: 'choiceMade'; actor: number; optionIdx: number }
  | { type: 'gameEnded' };

export type RunResult =
  | { ok: true; message?: string; events: EngineEvent[] }
  | { ok: false; code: EngineErrorCode; text: string };

function classify(message: string): EngineErrorCode {
  if (/不是你的回合/.test(message)) return 'NOT_YOUR_TURN';
  if (/已经掷过/.test(message)) return 'ALREADY_ROLLED';
  if (/你发的是|需要 /.test(message)) return 'WRONG_EMOJI';
  if (/范围/.test(message)) return 'OUT_OF_RANGE';
  if (/只有已加入/.test(message)) return 'NOT_A_PLAYER';
  if (/当前不|不能/.test(message)) return 'NOT_IN_PHASE';
  if (/找不到/.test(message)) return 'NO_STEP';
  return 'INVALID';
}

/** 记录当前相位的事件（每次动作后调用）。 */
function entered(game: GameRecord): EngineEvent[] {
  const out: EngineEvent[] = [
    { type: 'phaseEntered', phase: game.state.phase.kind, roundIdx: game.roundIdx, stepIdx: game.stepIdx }
  ];
  if (game.status === 'ended') out.push({ type: 'gameEnded' });
  return out;
}

/**
 * 引擎唯一入口：(game, intent, players) → RunResult。
 * 纯函数：不碰 DB / 网络 / 定时器；成功时原地更新 game 并返回事件流。
 */
export function run(
  game: GameRecord,
  definition: RuleDefinition,
  players: GamePlayer[],
  intent: Intent
): RunResult {
  (game as GameRecord & { _players?: GamePlayer[] })._players = players;
  try {
    switch (intent.type) {
      case 'begin': {
        beginGame(game, definition);
        return { ok: true, events: [{ type: 'gameStarted', actor: intent.userId }, ...entered(game)] };
      }
      case 'roll': {
        const phaseBefore = game.state.phase;
        const step = phaseBefore.kind === 'roll' ? findStep(definition, phaseBefore.roundIdx, phaseBefore.stepIdx) : undefined;
        const r = applyRoll(game, definition, intent.userId, intent.value, players, intent.emoji);
        const events: EngineEvent[] = [{ type: 'rollResolved', actor: intent.userId, value: intent.value, emoji: intent.emoji }];
        if (step?.type === 'roll' && step.draw && game.state.lastDraw !== undefined) {
          events.push({ type: 'drawResolved', actor: intent.userId, value: intent.value, bucket: game.state.lastDraw });
        }
        return { ok: true, message: r.message, events: [...events, ...entered(game)] };
      }
      case 'showdownRoll': {
        const r = applyShowdownRoll(game, definition, intent.userId, intent.value, players, intent.emoji);
        const events: EngineEvent[] = [{ type: 'showdownRolled', actor: intent.userId, value: intent.value }];
        if (r.settled) events.push(r.rerolled ? { type: 'showdownRerolled', actor: intent.userId } : { type: 'showdownSettled', actor: intent.userId });
        return { ok: true, message: r.message, events: [...events, ...entered(game)] };
      }
      case 'choice': {
        const r = applyChoice(game, definition, intent.userId, intent.optionIdx);
        return {
          ok: true, message: r.message,
          events: [{ type: 'choiceMade', actor: intent.userId, optionIdx: intent.optionIdx }, ...entered(game)]
        };
      }
      case 'next': {
        applyNext(game, definition, intent.userId, players);
        return { ok: true, events: entered(game) };
      }
      case 'skip': {
        applySkip(game, definition);
        return { ok: true, events: entered(game) };
      }
      default: {
        const never: never = intent;
        return { ok: false, code: 'INVALID', text: `未知意图：${JSON.stringify(never)}` };
      }
    }
  } catch (e) {
    const text = (e as Error).message;
    return { ok: false, code: classify(text), text };
  }
}

/** 相位快照（调试/断言用）。 */
export function phaseOf(game: GameRecord): GamePhase {
  return game.state.phase;
}
