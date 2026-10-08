import {
  buildView, displayName, SLOT_SYMBOL_LABEL,
  type GameRecord, type RuleDefinition, type GamePlayer, type UserId
} from '@tg-game/engine';

/** HTML 转义 */
export const html = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

/** @mention（Telegram HTML） */
export function mentionHtml(id: UserId, label: string): string {
  return `<a href="tg://user?id=${id}">${html(label)}</a>`;
}

function roundNameOf(v: ReturnType<typeof buildView>): string {
  const rounds = (v.rule?.rounds as Array<{ name?: string }> | undefined) ?? [];
  return rounds[v.roundIdx]?.name ?? `第 ${v.roundIdx + 1} 轮`;
}

/**
 * 群里/私聊状态消息（HTML）。**由引擎 `buildView` 派生**，与 Mini App 共用同一视图：
 * 群消息 = View→HTML，Mini App = View→JSON，内容不会漂。
 */
export function renderStatus(game: GameRecord, def: RuleDefinition | undefined, players: GamePlayer[]): string {
  const v = buildView(game, def, players, '', false);
  const header = v.status === 'ended' ? '🏁 对局已结束\n\n' : '';

  if (v.phase.kind === 'signup') {
    if (v.players.length === 0) {
      return '⏳ 等待开局\n\n已 /startgame，但还没有玩家加入。\n玩家 /joingame 加入；管理员 /begin 开始；或 /endgame 取消。';
    }
    const list = v.players.map((p, i) => `${i + 1}. ${mentionHtml(p.userId, p.label)}`).join('\n');
    return `🎲 报名中（${v.players.length} 人）\n\n${list}\n\n玩家点 /joingame 加入；管理员 /begin 开始。`;
  }

  let body = `📍 ${html(roundNameOf(v))} · ${html(v.phase.stepLabel)}`;
  if (v.loopProgress) {
    body += v.loopProgress.total === null
      ? ` · 🔁 第 ${v.loopProgress.current} 轮（无限）`
      : ` · 🔁 第 ${v.loopProgress.current} / ${v.loopProgress.total} 轮`;
  }
  if (v.showActor && v.activeActorId) {
    body += `\n👉 主角：${mentionHtml(v.activeActorId, displayName(v.activeActorId))}`;
  }

  const ph = v.phase;
  if (ph.kind === 'roll') {
    const expected = ph.expectedPlayerId
      ? mentionHtml(ph.expectedPlayerId, displayName(ph.expectedPlayerId))
      : '任一玩家';
    const hint = ph.drawHint ? `（抽 1-${ph.drawHint} 号）` : '';
    body += `\n\n等待 ${expected} 发送 ${ph.emoji}${hint}`;
  } else if (ph.kind === 'text') {
    body += `\n\n${html(ph.text)}`;
  } else if (ph.kind === 'punish') {
    body += `\n\n🎯 惩罚：${html(ph.text)}（第 ${ph.hitCount} 次）`;
  } else if (ph.kind === 'choice') {
    const who = ph.pickedBy ? `${mentionHtml(ph.pickedBy, displayName(ph.pickedBy))} 请选择：` : '请选择：';
    body += `\n\n${who}\n` + ph.options.map((o, i) => `${i + 1}. ${html(String(o.text ?? ''))}`).join('\n');
  } else if (ph.kind === 'showdown') {
    const modeLabel = ph.order === 'high' ? '比大' : ph.order === 'low' ? '比小' : '收集';
    body += `\n\n${ph.emoji} ${modeLabel} · 已掷 <b>${ph.rolls.length}</b>/${ph.total}`;
    for (const r of ph.rolls) {
      body += `\n✅ ${mentionHtml(r.userId, displayName(r.userId))} → <b>${r.value}</b>`;
    }
    if (ph.pending.length) {
      body += `\n⏳ 未掷(${ph.pending.length})：` + ph.pending.map(id => mentionHtml(id, displayName(id))).join(' ');
    }
    if (ph.rolls.length < ph.total) {
      body += `\n\n等全员发送 ${ph.emoji}（管理员可「立即结算」/ /next）。`;
    }
  }

  const lr = v.lastResult as {
    order: string; ranking: Array<{ userId: UserId; value: number }>;
  } | null;
  if (lr && v.phase.kind !== 'showdown') {
    const label = lr.order === 'high' ? '比大' : lr.order === 'low' ? '比小' : '收集';
    body += `\n\n🏆 上次比大小（${label}）：` + lr.ranking.map(e => `${mentionHtml(e.userId, displayName(e.userId))} ${e.value}`).join(' · ');
  }

  const ld = v.lastDice as {
    userId: UserId; value: number; emoji: string;
    decoded: { r1: keyof typeof SLOT_SYMBOL_LABEL; r2: keyof typeof SLOT_SYMBOL_LABEL; r3: keyof typeof SLOT_SYMBOL_LABEL; jackpot: boolean } | null;
  } | null;
  if (ld && v.phase.kind !== 'showdown') {
    let line = `🎲 上次：${mentionHtml(ld.userId, displayName(ld.userId))} → ${ld.value}`;
    if (ld.emoji === '🎰' && ld.decoded) {
      const d = ld.decoded;
      line += ` (${SLOT_SYMBOL_LABEL[d.r1]} ${SLOT_SYMBOL_LABEL[d.r2]} ${SLOT_SYMBOL_LABEL[d.r3]}${d.jackpot ? ' · 🎉 JACKPOT' : ''})`;
    }
    body += `\n\n${line}`;
  }

  const playerList = v.players.map((p, i) => `${i + 1}. ${mentionHtml(p.userId, p.label)}`).join('\n');
  body += `\n\n👥 玩家\n${playerList}`;
  return header + body;
}
