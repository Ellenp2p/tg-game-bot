import type { Game, RuleDefinition, GameEventRecord, UserId } from './model.js';
import { advanceToStep, initialState } from './rules.js';

/** 撤销一个事件需要适配器额外做的副作用（DB / 传输态）。 */
export type UndoEffect =
  | { kind: 'add-player'; userId: UserId }
  | { kind: 'remove-player'; userId: UserId }
  | { kind: 'clear-pending-rolls' };

/**
 * 撤销最近一个事件对局面/状态的影响（纯函数，作用在 game 上）。
 * 返回适配器需要补做的副作用（玩家增删、清空未揭晓骰子）。
 * `game.players` 由调用方保证已挂载（join/leave 会用到）。
 */
export function applyUndo(game: Game, definition: RuleDefinition, event: GameEventRecord): UndoEffect | null {
  switch (event.type) {
    case 'join':
      return { kind: 'remove-player', userId: event.userId };
    case 'leave':
      return { kind: 'add-player', userId: event.userId };
    case 'begin':
      game.status = 'signup';
      game.state = initialState();
      game.roundIdx = 0;
      game.stepIdx = 0;
      return null;
    case 'next':
    case 'skip': {
      const p = event.payload as { roundIdx?: number; stepIdx?: number };
      if (typeof p.roundIdx === 'number' && typeof p.stepIdx === 'number') {
        advanceToStep(game, definition, p.roundIdx, p.stepIdx);
      }
      return null;
    }
    case 'choice': {
      const p = event.payload as { fromRoundIdx?: number; fromStepIdx?: number };
      if (typeof p.fromRoundIdx === 'number' && typeof p.fromStepIdx === 'number') {
        advanceToStep(game, definition, p.fromRoundIdx, p.fromStepIdx);
      }
      return null;
    }
    case 'roll':
      game.state.lastDice = undefined;
      game.state.lastDraw = undefined;
      return { kind: 'clear-pending-rolls' };
    case 'showdown': {
      const p = event.payload as { roundIdx?: number; stepIdx?: number };
      const phase = game.state.phase;
      if (phase.kind === 'showdown' && phase.roundIdx === p.roundIdx && phase.stepIdx === p.stepIdx) {
        phase.rolls.pop();
      } else if (typeof p.roundIdx === 'number' && typeof p.stepIdx === 'number') {
        advanceToStep(game, definition, p.roundIdx, p.stepIdx);
      }
      return null;
    }
    case 'end':
      game.status = 'in_progress';
      game.endedAt = null;
      return null;
    default:
      throw Error(`不能撤销 ${event.type}`);
  }
}
