import test from 'node:test';
import assert from 'node:assert/strict';
import { rollDice, setRandom, resetRandom, DICE_EMOJI_MAX_VALUE } from '../src/index.js';

test('rollDice: 注入 RNG → 可复现，且落在合法范围', () => {
  try {
    setRandom(() => 0);            // 下界
    assert.equal(rollDice('🎲'), 1);
    setRandom(() => 0.999999);     // 上界
    assert.equal(rollDice('🎲'), DICE_EMOJI_MAX_VALUE['🎲']);
    assert.equal(rollDice('🎰'), DICE_EMOJI_MAX_VALUE['🎰']);
    assert.equal(rollDice('🏀'), DICE_EMOJI_MAX_VALUE['🏀']);
  } finally {
    resetRandom();
  }
});

test('rollDice: 默认 RNG 也始终落在范围', () => {
  for (const emoji of ['🎲', '🎯', '🏀', '⚽', '🎰', '🎳'] as const) {
    for (let i = 0; i < 50; i++) {
      const v = rollDice(emoji);
      assert.ok(Number.isInteger(v) && v >= 1 && v <= DICE_EMOJI_MAX_VALUE[emoji], `${emoji} -> ${v}`);
    }
  }
});
