import {
  findStep, formatTemplate, loopProgress, displayName,
  decodeSlotValue, isJackpot, SLOT_SYMBOL_LABEL,
  type GameRecord, type RuleDefinition, type GamePlayer
} from '@tg-game/engine';

/** HTML 转义 */
export const html = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

/** @mention（Telegram HTML） */
export function mentionHtml(id: number, label: string): string {
  return `<a href="tg://user?id=${id}">${html(label)}</a>`;
}

/**
 * 群里/私聊的状态消息（HTML）。纯函数：给定局面 + 规则 + 玩家 → 文本。
 * 抽出来是为了可单测 / golden 回归（不依赖 bot 实例）。
 */
export function renderStatus(game: GameRecord, def: RuleDefinition | undefined, players: GamePlayer[]): string {
  const phase = game.state.phase;
  const header = game.status === 'ended' ? '🏁 对局已结束\n\n' : '';
  if (phase.kind === 'signup') {
    if (players.length === 0) {
      return '⏳ 等待开局\n\n已 /startgame，但还没有玩家加入。\n玩家 /joingame 加入；管理员 /begin 开始；或 /endgame 取消。';
    }
    const list = players.map((p, i) => `${i + 1}. ${mentionHtml(p.userId, displayName(p.userId))}`).join('\n');
    return `🎲 报名中（${players.length} 人）\n\n${list}\n\n玩家点 /joingame 加入；管理员 /begin 开始。`;
  }
  const fmt = (t: string) => formatTemplate(t, game, 'html');
  const step = def ? findStep(def, phase.roundIdx, phase.stepIdx) : undefined;
  const roundName = def?.rounds[phase.roundIdx]?.name ?? `第 ${phase.roundIdx + 1} 轮`;
  let body = `📍 ${html(roundName)} · ${html(step ? fmt(step.label) : '')}`;
  if (def) {
    const lp = loopProgress(def, game.state.loopCounters, phase.roundIdx);
    if (lp) body += lp.total === null ? ` · 🔁 第 ${lp.current} 轮（无限）` : ` · 🔁 第 ${lp.current} / ${lp.total} 轮`;
  }
  const showActor = (step?.type === 'text' || step?.type === 'punish') && step.showActor && game.state.activeActorId;
  if (showActor) {
    body += `\n👉 主角：${mentionHtml(game.state.activeActorId!, displayName(game.state.activeActorId!))}`;
  }
  if (phase.kind === 'roll') {
    const expected = phase.expectedPlayerId
      ? mentionHtml(phase.expectedPlayerId, displayName(phase.expectedPlayerId))
      : '任一玩家';
    const drawHint = step?.type === 'roll' && step.draw ? `（抽 1-${step.draw.count} 号）` : '';
    body += `\n\n等待 ${expected} 发送 ${phase.emoji}${drawHint}`;
  } else if (phase.kind === 'text') {
    body += `\n\n${fmt(phase.text)}`;
  } else if (phase.kind === 'punish') {
    body += `\n\n🎯 惩罚：${fmt(phase.text)}（第 ${phase.hitCount} 次）`;
  } else if (phase.kind === 'choice') {
    const who = phase.pickedBy ? `${mentionHtml(phase.pickedBy, displayName(phase.pickedBy))} 请选择：` : '请选择：';
    body += `\n\n${who}\n` + phase.options.map((o, i) => `${i + 1}. ${fmt(o.text)}`).join('\n');
  } else if (phase.kind === 'showdown') {
    const modeLabel = phase.order === 'high' ? '比大' : phase.order === 'low' ? '比小' : '收集';
    body += `\n\n${phase.emoji} ${modeLabel} · 已掷 <b>${phase.rolls.length}</b>/${players.length}`;
    for (const r of phase.rolls) {
      body += `\n✅ ${mentionHtml(r.userId, displayName(r.userId))} → <b>${r.value}</b>`;
    }
    const pending = players.filter(p => !phase.rolls.some(r => r.userId === p.userId));
    if (pending.length) {
      body += `\n⏳ 未掷(${pending.length})：` + pending.map(p => mentionHtml(p.userId, displayName(p.userId))).join(' ');
    }
    if (phase.rolls.length < players.length) {
      body += `\n\n等全员发送 ${phase.emoji}（管理员可「立即结算」/ /next）。`;
    }
  }
  const lastResult = game.state.lastResultSlot ? game.state.results?.[game.state.lastResultSlot] : undefined;
  if (lastResult && phase.kind !== 'showdown') {
    const label = lastResult.order === 'high' ? '比大' : lastResult.order === 'low' ? '比小' : '收集';
    body += `\n\n🏆 上次比大小（${label}）：` + lastResult.ranking.map(e => `${mentionHtml(e.userId, displayName(e.userId))} ${e.value}`).join(' · ');
  }
  if (game.state.lastDice && phase.kind !== 'showdown') {
    let lastLine = `🎲 上次：${mentionHtml(game.state.lastDice.userId, displayName(game.state.lastDice.userId))} → ${game.state.lastDice.value}`;
    if (game.state.lastDice.emoji === '🎰') {
      const d = decodeSlotValue(game.state.lastDice.value);
      const jp = isJackpot(game.state.lastDice.value);
      lastLine += ` (${SLOT_SYMBOL_LABEL[d.r1]} ${SLOT_SYMBOL_LABEL[d.r2]} ${SLOT_SYMBOL_LABEL[d.r3]}${jp ? ' · 🎉 JACKPOT' : ''})`;
    }
    body += `\n\n${lastLine}`;
  }
  const playerList = players.map((p, i) => `${i + 1}. ${mentionHtml(p.userId, displayName(p.userId))}`).join('\n');
  body += `\n\n👥 玩家\n${playerList}`;
  return header + body;
}
