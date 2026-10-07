import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeSlotValue, isJackpot, SLOT_SYMBOL_LABEL } from '../src/model.js';

test('decode: value 1 = bar bar bar (jackpot)', () => {
  const d = decodeSlotValue(1);
  assert.deepEqual(d, { r1: 'bar', r2: 'bar', r3: 'bar', jackpot: true });
});

test('decode: value 22 = berries berries berries (jackpot)', () => {
  const d = decodeSlotValue(22);
  assert.deepEqual(d, { r1: 'berries', r2: 'berries', r3: 'berries', jackpot: true });
});

test('decode: value 43 = lemon lemon lemon (jackpot)', () => {
  const d = decodeSlotValue(43);
  assert.deepEqual(d, { r1: 'lemon', r2: 'lemon', r3: 'lemon', jackpot: true });
});

test('decode: value 64 = seven seven seven (jackpot)', () => {
  const d = decodeSlotValue(64);
  assert.deepEqual(d, { r1: 'seven', r2: 'seven', r3: 'seven', jackpot: true });
});

test('decode: jackpot helper matches the 4 known values', () => {
  assert.equal(isJackpot(1), true);
  assert.equal(isJackpot(22), true);
  assert.equal(isJackpot(43), true);
  assert.equal(isJackpot(64), true);
  assert.equal(isJackpot(2), false);
  assert.equal(isJackpot(21), false);
  assert.equal(isJackpot(23), false);
  assert.equal(isJackpot(63), false);
});

test('decode: all 4 reels symbol mapping', () => {
  assert.equal(SLOT_SYMBOL_LABEL.bar, 'BAR');
  assert.equal(SLOT_SYMBOL_LABEL.berries, '🍓');
  assert.equal(SLOT_SYMBOL_LABEL.lemon, '🍋');
  assert.equal(SLOT_SYMBOL_LABEL.seven, '7');
});

test('decode: 64 values total, 4 jackpots, 60 non-jackpots', () => {
  let jackpots = 0;
  for (let v = 1; v <= 64; v++) {
    const d = decodeSlotValue(v);
    if (d.jackpot) jackpots++;
  }
  assert.equal(jackpots, 4);
});

test('decode: each non-jackpot value has at least 2 distinct reels', () => {
  for (let v = 1; v <= 64; v++) {
    const d = decodeSlotValue(v);
    if (!d.jackpot) {
      const distinct = new Set([d.r1, d.r2, d.r3]).size;
      assert.ok(distinct >= 2, `value ${v} should have >=2 distinct reels, got ${JSON.stringify(d)}`);
    }
  }
});

test('decode: out-of-range values clamp and stay safe', () => {
  assert.equal(decodeSlotValue(0).r1, 'bar');
  assert.equal(decodeSlotValue(100).r1, 'seven');
  assert.equal(decodeSlotValue(3.7).r1, 'bar');
});

test('decode: r1 cycles through 4 symbols per 16 values', () => {
  assert.equal(decodeSlotValue(1).r1, 'bar');
  assert.equal(decodeSlotValue(16).r1, 'bar');
  assert.equal(decodeSlotValue(17).r1, 'berries');
  assert.equal(decodeSlotValue(32).r1, 'berries');
  assert.equal(decodeSlotValue(33).r1, 'lemon');
  assert.equal(decodeSlotValue(49).r1, 'seven');
  assert.equal(decodeSlotValue(64).r1, 'seven');
});

test('decode: first-symbol lookup table for common values', () => {
  const lookup: Record<number, string> = {};
  for (let v = 1; v <= 64; v++) lookup[v] = decodeSlotValue(v).r1;
  // spot-check a few
  assert.equal(lookup[1], 'bar');
  assert.equal(lookup[5], 'bar');
  assert.equal(lookup[17], 'berries');
  assert.equal(lookup[33], 'lemon');
  assert.equal(lookup[49], 'seven');
  assert.equal(lookup[64], 'seven');
});
