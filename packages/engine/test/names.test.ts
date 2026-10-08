import test from 'node:test';
import assert from 'node:assert/strict';
import { displayName, setNameResolver } from '../src/index.js';

test('displayName: 默认用 用户 #后4位', () => {
  setNameResolver(null);
  assert.equal(displayName(9001), '用户 #9001');
  assert.equal(displayName(123456), '用户 #3456');
});

test('displayName: 注入解析器后返回适配器给的名字', () => {
  try {
    setNameResolver(id => (id === 1 ? 'Alice' : 'Bob'));
    assert.equal(displayName(1), 'Alice');
    assert.equal(displayName(2), 'Bob');
  } finally {
    setNameResolver(null);
  }
});
