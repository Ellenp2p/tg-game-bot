import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ruleDefinition, run, setNameResolver,
  type RuleDefinition, type GameRecord, type GamePlayer
} from '@tg-game/engine';
import { renderStatus } from '../src/render.js';

const def: RuleDefinition = ruleDefinition.parse({
  name: 'R', minPlayers: 2, maxPlayers: 3, defaultEmoji: '🎲',
  rounds: [{ name: '第一轮', steps: [
    { type: 'roll', label: '掷色子', emoji: '🎲' },
    { type: 'text', label: '回答', prompt: 'x' }
  ] }]
});

const players: GamePlayer[] = [
  { userId: '9001', joinedAt: 0 },
  { userId: '9002', joinedAt: 0 }
];

function mk(): GameRecord {
  const g: GameRecord = {
    gameId: 'g', chatId: -1, ruleId: 'r', starterId: '9001', status: 'signup',
    state: { phase: { kind: 'signup' }, stepHitCounts: {}, loopCounters: {} },
    roundIdx: 0, stepIdx: 0, createdAt: 0, endedAt: null, signupMsgId: null
  };
  g.players = players;
  return g;
}

test('renderStatus：注入显示名后渲染真名/@ 用户名，而非「用户 #xxxx」', () => {
  setNameResolver(id => (id === '9001' ? '@alice' : '鲍勃'));
  try {
    const g = mk();
    run(g, def, players, { type: 'begin', userId: '9001' });
    const text = renderStatus(g, def, players);
    assert.match(text, /@alice/);
    assert.match(text, /鲍勃/);
    assert.ok(!text.includes('用户 #9001'), '不应回退到匿名名');
  } finally {
    setNameResolver(null); // 还原，避免影响其它渲染 golden
  }
});

test('renderStatus：无 resolver 时回退「用户 #后4位」', () => {
  setNameResolver(null);
  const g = mk();
  run(g, def, players, { type: 'begin', userId: '9001' });
  const text = renderStatus(g, def, players);
  assert.match(text, /用户 #9001/);
});

test('renderStatus：pending 显示「掷骰中」提示', () => {
  setNameResolver(id => (id === '9001' ? '@alice' : '鲍勃'));
  try {
    const g = mk();
    run(g, def, players, { type: 'begin', userId: '9001' });
    const text = renderStatus(g, def, players, [{ userId: '9001', emoji: '🎲' }]);
    assert.match(text, /⏳ 掷骰中：/);
    assert.match(text, /@alice<\/a> 正在掷 🎲/);
  } finally {
    setNameResolver(null);
  }
});
