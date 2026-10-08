import type { DiceEmoji } from '@tg-game/engine';

/** 掷骰动画期间的暂存（3.5s 后揭晓）——纯传输/时序状态，不属于引擎语义状态。 */
export type PendingRoll = {
  userId: number;
  value: number;
  chatId: number;
  waitingMsgId: number;
  emoji: DiceEmoji;
  kind: 'roll' | 'showdown';
  roundIdx: number;
  stepIdx: number;
};

/**
 * 每个对局的「传输态」：showdown 看板消息 id + 未揭晓骰子。
 * 放内存即可：看板丢最多重发一条；掷骰暂存只在 3.5s 窗口内有效。重启即清空。
 */
export type Session = {
  boardMsgId?: number;
  pendingRolls: Record<string, PendingRoll>;
};

const sessions = new Map<string, Session>();

export function session(gameId: string): Session {
  let s = sessions.get(gameId);
  if (!s) { s = { pendingRolls: {} }; sessions.set(gameId, s); }
  return s;
}

export function endSession(gameId: string): void {
  sessions.delete(gameId);
}
