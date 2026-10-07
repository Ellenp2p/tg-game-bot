import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loopProgress } from '../src/rules.js';
import type { RuleDefinition } from '../src/model.js';

const def: RuleDefinition = {
  name: '测试',
  rounds: [
    { name: '非循环轮', loop: false, steps: [{ type: 'text', label: 'x' }] },
    { name: '循环无限', loop: true, steps: [{ type: 'roll', label: 'x' }] },
    { name: '循环有限', loop: true, maxLoops: 3, steps: [{ type: 'roll', label: 'x' }] }
  ]
};

test('loopProgress: 非循环轮返回 null', () => {
  assert.equal(loopProgress(def, {}, 0), null);
  assert.equal(loopProgress(def, { '0': 5 }, 0), null);
});

test('loopProgress: 无 maxLoops 无限循环', () => {
  const lp = loopProgress(def, {}, 1);
  assert.deepEqual(lp, { current: 1, total: null });
  const lp2 = loopProgress(def, { '1': 7 }, 1);
  assert.deepEqual(lp2, { current: 8, total: null });
});

test('loopProgress: 有 maxLoops 有限循环', () => {
  assert.deepEqual(loopProgress(def, {}, 2), { current: 1, total: 3 });
  assert.deepEqual(loopProgress(def, { '2': 1 }, 2), { current: 2, total: 3 });
  assert.deepEqual(loopProgress(def, { '2': 2 }, 2), { current: 3, total: 3 });
});

test('loopProgress: 越界 roundIdx 返回 null', () => {
  assert.equal(loopProgress(def, {}, 99), null);
});

test('loopProgress: 字符串键能解析', () => {
  assert.deepEqual(loopProgress(def, { '2': '2' as unknown as number }, 2), { current: 3, total: 3 });
});
