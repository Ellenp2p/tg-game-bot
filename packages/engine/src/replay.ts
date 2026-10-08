import type { RuleDefinition, Game, GamePlayer } from './model.js';
import { run, type Intent, type EngineEvent } from './machine.js';

/**
 * 从「初始局面工厂 + 意图序列」重放，得到最终局面与事件流。
 * 用于：审计 / time-travel 调试 / 校验"同序列必得同局"（确定性）。
 */
export function replay(
  makeInitial: () => Game,
  definition: RuleDefinition,
  players: GamePlayer[],
  intents: Intent[]
): { game: Game; events: EngineEvent[]; errors: string[] } {
  const game = makeInitial();
  const events: EngineEvent[] = [];
  const errors: string[] = [];
  for (const it of intents) {
    const r = run(game, definition, players, it);
    if (r.ok) events.push(...r.events);
    else errors.push(r.text);
  }
  return { game, events, errors };
}
