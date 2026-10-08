import test from 'node:test';
import assert from 'node:assert/strict';
import { renderEntryCard } from '../src/render.js';

test('renderEntryCard：静态两行，含规则名与实时视图提示', () => {
  const text = renderEntryCard('命运色子');
  assert.equal(text, '🎲 <b>命运色子</b> · 对局进行中\n📱 点下方按钮打开实时视图');
  assert.equal(text.split('\n').length, 2, '应为两行（第一行是置顶栏摘要）');
});

test('renderEntryCard：规则名做 HTML 转义', () => {
  const text = renderEntryCard('A & <B>');
  assert.match(text, /A &amp; &lt;B&gt;/);
  assert.ok(!text.includes('<B>'), '不应残留裸尖括号');
});
