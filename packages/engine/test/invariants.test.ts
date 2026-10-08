import test from 'node:test';
import assert from 'node:assert/strict';
import { ruleDefinition, run, type RuleDefinition, type GameRecord, type GamePlayer, type Intent } from '../src/index.js';

const P: GamePlayer[] = [{ userId: 9001, joinedAt: 0 }, { userId: 9002, joinedAt: 0 }];

function makeInitial(): GameRecord {
  const g: GameRecord = {
    gameId: 'g', chatId: 0, ruleId: 'r', starterId: 9001, status: 'signup',
    state: { phase: { kind: 'signup' }, stepHitCounts: {}, loopCounters: {} },
    roundIdx: 0, stepIdx: 0, createdAt: 0, endedAt: null, signupMsgId: null
  };
  g.players = P;
  return g;
}

const def: RuleDefinition = ruleDefinition.parse({
  name: 'r', minPlayers: 2, maxPlayers: 2,
  rounds: [
    { name: 'R1', loop: true, maxLoops: 3, steps: [
      { type: 'showdown', label: '比', emoji: '🎲', order: 'high', tie: 'keep', actor: 'winner' },
      { type: 'roll', label: '掷', emoji: '🎰', assignment: 'winner', draw: { count: 6, uniform: 'equal', targets: Array.from({ length: 6 }, () => ({ roundIdx: 0, stepIdx: 2 })) } },
      { type: 'text', label: 't', prompt: 'x', next: 'end' }
    ] }
  ]
});

/** 由当前相位决定下一步意图 */
function nextIntent(g: GameRecord): Intent | null {
  const p = g.state.phase;
  if (p.kind === 'showdown') {
    const pending = P.find(x => !p.rolls.some(r => r.userId === x.userId));
    return pending ? { type: 'showdownRoll', userId: pending.userId, value: (pending.userId % 6) + 1, emoji: '🎲' } : null;
  }
  if (p.kind === 'roll') return { type: 'roll', userId: p.expectedPlayerId ?? 9001, value: 3, emoji: p.emoji };
  if (p.kind === 'choice') return { type: 'choice', userId: p.pickedBy ?? 9001, optionIdx: 0 };
  if (p.kind === 'text' || p.kind === 'punish') return { type: 'next', userId: 9001 };
  return null;
}

test('invariant: record 与 phase 的 cursor 始终一致，且对局能终止', () => {
  const g = makeInitial();
  run(g, def, P, { type: 'begin', userId: 9001 });
  let guard = 0;
  while (g.status !== 'ended' && guard++ < 300) {
    const it = nextIntent(g);
    if (!it) break;
    run(g, def, P, it);
    const p = g.state.phase;
    if (p.kind !== 'signup') {
      assert.equal(g.roundIdx, p.roundIdx, `roundIdx 漂移于 ${JSON.stringify(it)}`);
      assert.equal(g.stepIdx, p.stepIdx, `stepIdx 漂移于 ${JSON.stringify(it)}`);
    }
  }
  assert.equal(g.status, 'ended');
  assert.ok(guard < 300, '不应超过保护步数');
});
