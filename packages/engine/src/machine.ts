import type { RuleDefinition, Game, GamePlayer, DiceEmoji, GamePhase, UserId } from './model.js';
import {
  beginGame, applyRoll, applyShowdownRoll, applyChoice, applyNext, applySkip, findStep
} from './rules.js';
import { now } from './clock.js';

/** 引擎唯一入口的输入：一个"意图"。 */
export type Intent =
  | { type: 'join'; userId: UserId }
  | { type: 'leave'; userId: UserId }
  | { type: 'begin'; userId: UserId }
  | { type: 'roll'; userId: UserId; value: number; emoji: DiceEmoji }
  | { type: 'showdownRoll'; userId: UserId; value: number; emoji: DiceEmoji }
  | { type: 'choice'; userId: UserId; optionIdx: number }
  | { type: 'next'; userId: UserId }
  | { type: 'skip'; userId: UserId };

export type EngineErrorCode =
  | 'NOT_A_PLAYER' | 'NOT_YOUR_TURN' | 'ALREADY_ROLLED' | 'WRONG_EMOJI'
  | 'OUT_OF_RANGE' | 'NOT_IN_PHASE' | 'INVALID' | 'NO_STEP'
  | 'NOT_SIGNUP' | 'FULL' | 'ALREADY_JOINED' | 'NOT_JOINED';

/** 语义事件（不含时间戳，保持确定性；需要时由调用方补 at）。 */
export type EngineEvent =
  | { type: 'playerJoined'; actor: UserId }
  | { type: 'playerLeft'; actor: UserId }
  | { type: 'gameStarted'; actor: UserId }
  | { type: 'phaseEntered'; phase: string; roundIdx: number; stepIdx: number }
  | { type: 'rollResolved'; actor: UserId; value: number; emoji: string }
  | { type: 'drawResolved'; actor: UserId; value: number; bucket: number }
  | { type: 'showdownRolled'; actor: UserId; value: number }
  | { type: 'showdownSettled'; actor: UserId }
  | { type: 'showdownRerolled'; actor: UserId }
  | { type: 'choiceMade'; actor: UserId; optionIdx: number }
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
function entered(game: Game): EngineEvent[] {
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
  game: Game,
  definition: RuleDefinition,
  players: GamePlayer[],
  intent: Intent
): RunResult {
  // 名册归引擎：拷贝一份，避免污染调用方数组；join/leave 在副本上增删
  game.players = players.slice();
  try {
    switch (intent.type) {
      case 'join': {
        if (game.status !== 'signup') return { ok: false, code: 'NOT_SIGNUP', text: '已开始的对局不能加入' };
        const roster = game.players;
        if (roster.some(p => p.userId === intent.userId)) return { ok: false, code: 'ALREADY_JOINED', text: '你已经报名了' };
        if (roster.length >= definition.maxPlayers) return { ok: false, code: 'FULL', text: `已满员（最多 ${definition.maxPlayers} 人）` };
        roster.push({ userId: intent.userId, joinedAt: now() });
        return { ok: true, events: [{ type: 'playerJoined', actor: intent.userId }, ...entered(game)] };
      }
      case 'leave': {
        if (game.status !== 'signup') return { ok: false, code: 'NOT_SIGNUP', text: '已开始的对局不能退出' };
        const idx = game.players.findIndex(p => p.userId === intent.userId);
        if (idx < 0) return { ok: false, code: 'NOT_JOINED', text: '你不在报名列表里' };
        game.players.splice(idx, 1);
        return { ok: true, events: [{ type: 'playerLeft', actor: intent.userId }, ...entered(game)] };
      }
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
export function phaseOf(game: Game): GamePhase {
  return game.state.phase;
}
