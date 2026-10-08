import { DICE_EMOJI_MAX_VALUE, type DiceEmoji } from './model.js';

/**
 * 可注入随机源。Telegram 有原生骰子（点数由 TG 给），Discord/网页没有——
 * 那些适配器可用 `rollDice(emoji)` 生成点数；注入 RNG 后即可确定复现。
 */
let rng: () => number = () => Math.random();

export function random(): number {
  return rng();
}

export function setRandom(fn: () => number): void {
  rng = fn;
}

export function resetRandom(): void {
  rng = () => Math.random();
}

/** 生成该 emoji 范围内的一次点数（1..上限）。 */
export function rollDice(emoji: DiceEmoji): number {
  const max = DICE_EMOJI_MAX_VALUE[emoji];
  return Math.min(max, Math.max(1, Math.floor(rng() * max) + 1));
}
