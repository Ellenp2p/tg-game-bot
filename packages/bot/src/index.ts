import dotenv from 'dotenv';
import { Bot, InlineKeyboard, InputFile, type BotError, type Context } from 'grammy';
import { createServer, type IncomingMessage } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { verifyInitData } from './auth.js';
import { Db } from './db.js';
import { session } from './session.js';
import { html, mentionHtml, renderStatus } from './render.js';
import {
  ruleDefinition, type RuleDefinition, type RuleRecord, type GameRecord,
  type GamePlayer, type DiceEmoji, SUPPORTED_DICE_EMOJIS,
  type GamePhase, type GameStatus, type UserId,
  advanceToStep, displayName, findStep, initialState, loopProgress, formatTemplate,
  decodeSlotValue, isJackpot, SLOT_SYMBOL_LABEL,
  run, type Intent as EngineIntent, type RunResult, buildView, applyUndo
} from '@tg-game/engine';

/** 仓库根目录（dev: packages/bot/src → ../../../；prod: packages/bot/dist → ../../../） */
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
dotenv.config({ path: join(ROOT, '.env') });

const token = process.env.BOT_TOKEN;
if (!token) throw Error('BOT_TOKEN is required');
const bot = new Bot(token, { client: { apiRoot: process.env.BOT_API_ROOT || 'https://api.telegram.org' } });
const db = new Db(process.env.DATA_FILE || join(ROOT, 'data', 'bot.sqlite'));
const port = Number(process.env.PORT || 3001);
const appLink = process.env.BOT_USERNAME && process.env.APP_SHORT_NAME
  ? `https://t.me/${process.env.BOT_USERNAME.replace(/^@/, '')}/${process.env.APP_SHORT_NAME}`
  : undefined;
const publicUrl = process.env.PUBLIC_URL;

type Pending = { kind: 'create-rule' | 'edit-rule'; userId: UserId; ruleId?: string };
const pending = new Map<string, Pending>();

// html / mentionHtml / renderStatus 已抽到 ./render.ts（纯函数，可单测 + golden 回归）
const isGroup = (ctx: Context) => ctx.chat?.type === 'group' || ctx.chat?.type === 'supergroup';
const isPrivate = (ctx: Context) => ctx.chat?.type === 'private';
const chatIdOf = (ctx: Context) => ctx.chat!.id;
/** Telegram 数字 id → 引擎/DB 的不透明 `UserId`（string）。所有引擎/DB 交互走它。 */
const uid = (n: number): UserId => String(n);
const userIdOf = (ctx: Context): UserId => uid(ctx.from!.id);

async function isTelegramGroupAdmin(chatId: number, userId: number): Promise<boolean> {
  try {
    const m = await bot.api.getChatMember(chatId, userId);
    return m.status === 'administrator' || m.status === 'creator';
  } catch { return false; }
}

async function isBotAdmin(chatId: number): Promise<boolean> {
  try {
    const me = await bot.api.getMe();
    const m = await bot.api.getChatMember(chatId, me.id);
    return m.status === 'administrator' || m.status === 'creator';
  } catch { return false; }
}

async function requireGroupAdmin(ctx: Context): Promise<void> {
  if (!isGroup(ctx)) throw Error('该命令仅在群内使用');
  if (!await isTelegramGroupAdmin(ctx.chat!.id, ctx.from!.id)) {
    throw Error('仅本群 Telegram 管理员可操作');
  }
}

/** 当前正在播掷骰动画的玩家（传输态，仅用于 Mini App 显示"掷骰中…"）。 */
function pendingRollsOf(gameId: string): Array<{ userId: UserId; emoji: DiceEmoji; kind: 'roll' | 'showdown' }> {
  return Object.values(session(gameId).pendingRolls).map(p => ({ userId: p.userId, emoji: p.emoji, kind: p.kind }));
}

function snapshot(game: GameRecord, definition: RuleDefinition | undefined, players: GamePlayer[], viewerId: UserId, isAdminViewer: boolean) {
  // 引擎视图 + 适配器补的传输字段（Mini App 用 chatId 做「去群里掷骰」、用 pending 显示掷骰动画）
  return {
    ...buildView(game, definition, players, viewerId, isAdminViewer),
    chatId: game.chatId,
    starterId: game.starterId,
    pending: pendingRollsOf(game.gameId)
  };
}

const wsByGame = new Map<string, Set<WebSocket>>();
const SIGNUP_PAGE_SIZE = 8;
function broadcast(gameId: string): void {
  const set = wsByGame.get(gameId);
  if (!set) return;
  const game = db.getGame(gameId);
  if (!game) return;
  const rule = db.getRule(game.ruleId);
  const players = db.listPlayers(gameId);
  const { viewer: _drop, ...rest } = snapshot(game, rule?.definition, players, '', false);
  const payload = JSON.stringify({
    type: 'state',
    snapshot: rest // 广播不含 viewer：观众身份由客户端初始化时（/api/games?initData）拿到，避免被覆盖成 0
  });
  for (const ws of set) if (ws.readyState === WebSocket.OPEN) ws.send(payload);
}

function renderSignupPage(game: GameRecord, def: RuleDefinition | undefined, players: GamePlayer[], page: number) {
  const total = players.length;
  const totalPages = Math.max(1, Math.ceil(total / SIGNUP_PAGE_SIZE));
  page = Math.min(Math.max(1, page), totalPages);
  const start = (page - 1) * SIGNUP_PAGE_SIZE;
  const pagePlayers = players.slice(start, start + SIGNUP_PAGE_SIZE);
  const list = pagePlayers.length
    ? pagePlayers.map((p, i) => `${start + i + 1}. ${mentionHtml(p.userId, displayName(p.userId))}`).join('\n')
    : '（暂无）';
  const name = def?.name ?? game.ruleId;
  const min = def?.minPlayers ?? 1;
  const max = def?.maxPlayers ?? 99;
  const header = game.status === 'signup'
    ? `🎲 <b>${html(name)}</b> 等待报名`
    : `🎲 <b>${html(name)}</b> · 游戏已开始`;
  const footer = game.status === 'signup'
    ? `· 玩家：/joingame\n· 退出：/leavegame\n· 管理员：/begin 开始（至少 ${min} 人，最多 ${max} 人）`
    : `查看实时：点下方「实时视图」`;
  return {
    page, totalPages,
    text: `${header}\n\n${list}\n\n第 ${page}/${totalPages} 页 · 共 ${total} / ${max} 人\n\n${footer}`
  };
}

function signupKeyboard(game: GameRecord, page: number): InlineKeyboard {
  const kb = new InlineKeyboard();
  const players = db.listPlayers(game.gameId);
  const totalPages = Math.max(1, Math.ceil(players.length / SIGNUP_PAGE_SIZE));
  page = Math.min(Math.max(1, page), totalPages);
  if (page > 1) kb.text('◀ 上一页', `sign:${game.gameId}:${page - 1}`);
  if (page < totalPages) kb.text('下一页 ▶', `sign:${game.gameId}:${page + 1}`);
  kb.text('🔄 刷新', `sign:${game.gameId}:${page}`);
  if (game.status === 'signup') {
    kb.text('加入', `join:${game.gameId}`).text('退出报名', `leave:${game.gameId}`);
    if (players.length > 0) kb.text('▶ 开始', `begin:${game.gameId}`);
  }
  if (appLink) kb.url('实时视图', `${appLink}?startapp=game_${game.gameId}`);
  return kb;
}

async function refreshSignupMessage(game: GameRecord): Promise<void> {
  const msgId = game.signupMsgId;
  if (!msgId) return;
  const rule = db.getRule(game.ruleId);
  const players = db.listPlayers(game.gameId);
  const { text } = renderSignupPage(game, rule?.definition, players, 1);
  try {
    await bot.api.editMessageText(game.chatId, msgId, text, { parse_mode: 'HTML', reply_markup: signupKeyboard(game, 1) });
  } catch (e) { console.warn('[signup] edit failed:', (e as Error).message); }
}

function push(game: GameRecord): void {
  db.updateGame(game);
  broadcast(game.gameId);
}

function statusKeyboard(game: GameRecord, gameId: string, phase: GamePhase, status: GameStatus, players: GamePlayer[]): InlineKeyboard | undefined {
  const kb = new InlineKeyboard();
  if (status === 'ended') return undefined;
  if (status === 'signup') return undefined;
  if (phase.kind === 'roll') return undefined;
  if (phase.kind === 'choice') {
    if (!phase.options.length) return undefined;
    phase.options.forEach((o, i) => kb.text(o.text, `pickChoice:${gameId}:${i}`));
    return kb;
  }
  if (phase.kind === 'showdown') {
    kb.text('立即结算', `next:${gameId}`).text('跳过', `skip:${gameId}`);
    return kb;
  }
  if (phase.kind === 'text' || phase.kind === 'punish') {
    kb.text('下一步', `next:${gameId}`).text('跳过', `skip:${gameId}`);
    return kb;
  }
  return undefined;
}

async function sendStatus(chatId: number, gameId: string): Promise<void> {
  const game = db.getGame(gameId);
  if (!game) return;
  const rule = db.getRule(game.ruleId);
  const players = db.listPlayers(gameId);
  const text = renderStatus(game, rule?.definition, players);
  const kb = statusKeyboard(game, gameId, game.state.phase, game.status, players);
  const isShowdown = game.status !== 'ended' && game.state.phase.kind === 'showdown';
  const sess = session(gameId);
  if (isShowdown && sess.boardMsgId) {
    try {
      await bot.api.editMessageText(chatId, sess.boardMsgId, text, { parse_mode: 'HTML', reply_markup: kb });
      return;
    } catch (e) {
      console.warn('[board] edit failed:', (e as Error).message);
      sess.boardMsgId = undefined;
    }
  }
  if (!isShowdown && sess.boardMsgId) {
    // 离开 showdown：清掉旧看板按钮，避免误点
    const boardId = sess.boardMsgId;
    sess.boardMsgId = undefined;
    bot.api.editMessageReplyMarkup(chatId, boardId, { reply_markup: { inline_keyboard: [] } })
      .catch(e => console.warn('[board] clear markup failed:', (e as Error).message));
  }
  try {
    const sent = await bot.api.sendMessage(chatId, text, {
      parse_mode: 'HTML',
      reply_markup: kb
    });
    if (isShowdown) {
      sess.boardMsgId = sent.message_id;
    }
  } catch (e) {
    console.warn('[status] send failed:', (e as Error).message);
  }
}

async function notifyGroup(game: GameRecord, action: string, actorId: UserId): Promise<void> {
  const players = db.listPlayers(game.gameId);
  if (action === 'join' || action === 'leave' || action === 'begin') {
    await refreshSignupMessage(game);
  }
  if (action === 'begin' || action === 'next' || action === 'skip' || action === 'choice' || action === 'undo') {
    await sendStatus(game.chatId, game.gameId);
  } else if (action === 'end') {
    game.signupMsgId = null;
    db.updateGame(game);
    await bot.api.sendMessage(game.chatId, '🏁 对局已结束。');
  }
}

// renderStatus 已抽到 ./render.ts（纯函数）

bot.catch(async (err: BotError<Context>) => {
  console.error('[bot]', err.message);
  const ctx = err.ctx;
  const msg = `⚠️ ${err.message}`;
  try {
    if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: err.message, show_alert: true }).catch(() => {});
    else await ctx.reply(msg);
  } catch {}
});

const commandsZh = [
  { command: 'start', description: '开始使用' },
  { command: 'help', description: '查看所有命令' },
  { command: 'newrule', description: '创建规则（发 JSON 文本或 .json 文件）' },
  { command: 'editrule', description: '编辑规则 /editrule 编号' },
  { command: 'rules', description: '管理我的规则（按钮面板）' },
  { command: 'rule', description: '查看规则 /rule 编号' },
  { command: 'deleterule', description: '删除规则 /deleterule 编号' },
  { command: 'cancel', description: '取消当前创建/编辑' },
  { command: 'startgame', description: '群里开局（管理员）' },
  { command: 'joingame', description: '报名参与' },
  { command: 'leavegame', description: '退出报名' },
  { command: 'begin', description: '开始游戏（管理员）' },
  { command: 'next', description: '下一步（管理员）' },
  { command: 'skip', description: '跳过（管理员）' },
  { command: 'undo', description: '撤销（管理员）' },
  { command: 'endgame', description: '结束游戏（管理员）' },
  { command: 'status', description: '查看当前对局状态' },
  { command: 'play', description: '群里发，私聊收 Mini App 内嵌按钮' }
];

(async () => {
  try {
    await bot.api.setMyCommands(commandsZh, { scope: { type: 'all_private_chats' } });
    await bot.api.setMyCommands(commandsZh, { scope: { type: 'all_group_chats' } });
    if (publicUrl) {
      await bot.api.setChatMenuButton({
        menu_button: { type: 'web_app', text: '🎮 打开 Mini App', web_app: { url: publicUrl } }
      });
    }
  } catch (e) { console.error('[setMyCommands/menu]', (e as Error).message); }
})();

const RULE_PAGE_SIZE = 5;

function ruleListPage(userId: UserId, pageRaw: number): { text: string; keyboard: InlineKeyboard } {
  const rules = db.listRules(userId);
  const totalPages = Math.max(1, Math.ceil(rules.length / RULE_PAGE_SIZE));
  const page = Math.min(Math.max(1, Math.floor(pageRaw) || 1), totalPages);
  const startIdx = (page - 1) * RULE_PAGE_SIZE;
  const pageRules = rules.slice(startIdx, startIdx + RULE_PAGE_SIZE);
  const kb = new InlineKeyboard();
  for (const r of pageRules) {
    kb.text(`📜 ${r.name}`.slice(0, 40), `rview:${r.ruleId}`).row();
  }
  if (totalPages > 1) {
    if (page > 1) kb.text('◀ 上一页', `rlist:${page - 1}`);
    if (page < totalPages) kb.text('下一页 ▶', `rlist:${page + 1}`);
    kb.row();
  }
  kb.text('➕ 新建规则', 'rnew');
  const text = rules.length
    ? `🗂 <b>我的规则</b>（共 ${rules.length} 条）· 第 ${page}/${totalPages} 页\n\n点规则名可查看 / 编辑 / 删除，也可继续用 /newrule /rule /deleterule。`
    : '🗂 <b>我的规则</b>\n\n你还没有规则，点下方「➕ 新建规则」开始创建。';
  return { text, keyboard: kb };
}

function ruleDetailText(rule: RuleRecord): string {
  const d = rule.definition;
  return `📜 <b>${html(rule.name)}</b>\n` +
    `🆔 <code>${rule.ruleId}</code>\n` +
    `📊 ${d.rounds.length} 轮 / ${totalSteps(d)} 步 · 默认 ${d.defaultEmoji ?? '🎲'} · 人数 ${d.minPlayers}-${d.maxPlayers}\n\n` +
    `在群里 /startgame 选择它即可开局。`;
}

function ruleDetailKeyboard(ruleId: string): InlineKeyboard {
  return new InlineKeyboard()
    .text('✏️ 编辑', `redit:${ruleId}`)
    .text('🗑 删除', `rdel:${ruleId}`).row()
    .text('📄 查看 JSON', `rjson:${ruleId}`)
    .text('⬅️ 返回列表', 'rlist:1');
}

function ruleDeleteKeyboard(ruleId: string): InlineKeyboard {
  return new InlineKeyboard()
    .text('✅ 确认删除', `rdelok:${ruleId}`)
    .text('⬅️ 取消', `rview:${ruleId}`);
}

/** 就地编辑当前面板；消息未变化或无法编辑时静默降级 */
async function safeEdit(ctx: Context, text: string, keyboard?: InlineKeyboard): Promise<void> {
  try {
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
  } catch (e) {
    const msg = (e as Error).message || '';
    if (msg.includes('message is not modified')) return;
    try {
      await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
    } catch { /* ignore */ }
  }
}

bot.command('start', async ctx => {
  if (!ctx.from) return;
  db.touchUser(userIdOf(ctx));
  const text =
    '欢迎使用游戏主理人。\n\n' +
    '私聊用法：\n' +
    '· /newrule <名称> — 创建规则\n' +
    '· /rules — 打开规则面板（按钮操作 / 分页）\n' +
    '· /rule <编号> — 查看规则\n' +
    '· /deleterule <编号> — 删除规则\n\n' +
    '群内用法（任何群管理员）：\n' +
    '· /startgame — 选择我的规则开局\n' +
    '· /joingame / /leavegame — 报名\n' +
    '· /begin / /next / /skip / /undo / /endgame\n\n' +
    '/help 查看完整说明';
  if (isPrivate(ctx)) {
    await ctx.reply(text, { reply_markup: new InlineKeyboard().text('🗂 管理我的规则', 'rlist:1') });
  } else {
    await ctx.reply(text);
  }
});

bot.command('help', async ctx => {
  if (isGroup(ctx)) {
    await ctx.reply(
      '<b>游戏主理人 · 群内命令</b>\n\n' +
      '<b>━━━ 玩家（所有人）━━━</b>\n' +
      '/joingame — 报名\n' +
      '/leavegame — 退出报名\n' +
      '/status — 查看当前对局状态和要用哪个表情\n' +
      '到玩家回合时发当前 step 需要的表情（Telegram 原生 dice）\n\n' +
      '<b>━━━ 管理员（群管理员 / 机器人管理员）━━━</b>\n' +
      '/startgame — 选择规则开局\n' +
      '/begin — 开始游戏（报名结束后）\n' +
      '/next — 下一步\n' +
      '/skip — 跳过当前步骤\n' +
      '/undo — 撤销上一次动作\n' +
      '/endgame — 强制结束\n\n' +
      '支持的表情（看 /status 知道当前要用哪个）：\n' +
      '🎲 色子 1-6　🎯 飞镖 1-6　🏀 篮球 1-5　⚽ 足球 1-5　🎰 老虎机 1-64　🎳 保龄球 1-6\n\n' +
      '创建/管理规则请私聊机器人。'
    , { parse_mode: 'HTML' });
    return;
  }
  await ctx.reply(
    '<b>游戏主理人 · 命令一览</b>\n\n' +
    '<b>━━━ 规则（私聊）━━━</b>\n' +
    '/rules — 打开规则面板（点击查看 / 编辑 / 删除，支持分页）\n' +
    '/newrule — 创建规则（下一步发 JSON 文本，或直接发 <code>.json</code> 文件；长规则建议用文件）\n' +
    '/editrule <code>编号</code> — 重新编辑规则\n' +
    '/rule <code>编号</code> — 查看规则 JSON\n' +
    '/deleterule <code>编号</code> — 删除规则\n' +
    '/cancel — 取消当前创建/编辑\n\n' +
    '<b>━━━ 玩家（群内）━━━</b>\n' +
    '/joingame — 报名\n' +
    '/leavegame — 退出报名\n' +
    '/status — 查看当前对局状态和要用哪个表情\n' +
    '到玩家回合时发当前 step 需要的表情\n\n' +
    '<b>━━━ 管理员（群内）━━━</b>\n' +
    '/startgame — 选择我的规则开局\n' +
    '/begin — 开始游戏\n' +
    '/next / /skip / /undo / /endgame — 流程控制\n\n' +
    '<b>━━━ 支持的表情 ━━━</b>\n' +
    '🎲 色子 1-6　🎯 飞镖 1-6　🏀 篮球 1-5　⚽ 足球 1-5　🎰 老虎机 1-64　🎳 保龄球 1-6\n' +
    '可在 step / round / rule 三层都设 <code>emoji</code>（或 <code>defaultEmoji</code>），优先级 step &gt; round &gt; rule &gt; 🎲。\n\n' +
    '<b>━━━ 全员比大小（showdown）━━━</b>\n' +
    '规则里用 <code>{"type":"showdown"}</code>：全员各发一次，看板实时标记 ✅ 已掷 / ⏳ 未掷，集齐自动排序结算；结果可用 <code>{winner}</code> <code>{loser}</code> <code>{ranking}</code> 等占位符引用。\n\n' +
    '<b>━━━ 规则 JSON 示例 ━━━</b>\n' +
    '<pre language="json">{\n' +
    '  "name": "真心话大冒险",\n' +
    '  "defaultEmoji": "🎲",\n' +
    '  "rounds": [\n' +
    '    { "name": "Round 1", "steps": [\n' +
    '      { "type": "roll", "label": "谁来回答真心话" },\n' +
    '      { "type": "text", "label": "回答问题", "prompt": "你最近撒的最大的谎是什么？" },\n' +
    '      { "type": "punish", "label": "惩罚", "defaultText": "喝一口", "ladder": [\n' +
    '        { "at": 3, "text": "喝一杯" },\n' +
    '        { "at": 5, "text": "喝两杯" }\n' +
    '      ]}\n' +
    '    ]}\n' +
    '  ]\n' +
    '}</pre>'
  , { parse_mode: 'HTML' });
});

bot.command('newrule', async ctx => {
  if (!isPrivate(ctx)) throw Error('请私聊机器人创建规则');
  if (!ctx.from) return;
  db.touchUser(userIdOf(ctx));
  pending.set(`${ctx.from.id}`, { kind: 'create-rule', userId: userIdOf(ctx) });
  await ctx.reply(
    '收到。\n\n' +
    '请把规则 JSON 发给我（<code>name</code> 字段为规则名）：\n' +
    '· 直接粘贴 JSON 文本，或\n' +
    '· 把规则存成 <code>.json</code> 文件发给我（长规则推荐）\n' +
    '结构见 /help。\n' +
    '取消：/cancel'
  , { parse_mode: 'HTML' });
});

bot.command('editrule', async ctx => {
  if (!isPrivate(ctx) || !ctx.from) throw Error('请私聊机器人');
  const ruleId = (ctx.message?.text ?? '').replace(/^\/\w+(?:@\w+)?\s*/, '').trim();
  if (!/^[0-9a-f]{8}$/.test(ruleId)) throw Error('格式：/editrule 8位编号');
  const rule = db.getRuleByUser(ruleId, userIdOf(ctx));
  if (!rule) throw Error('找不到规则');
  pending.set(`${ctx.from.id}`, { kind: 'edit-rule', userId: userIdOf(ctx), ruleId });
  await ctx.reply(
    `当前 JSON：\n<pre>${html(JSON.stringify(rule.definition, null, 2))}</pre>\n\n` +
    '把新 JSON 发给我即可覆盖；名称会沿用当前的：' + rule.name + '\n' +
    '取消：/cancel'
  , { parse_mode: 'HTML' });
});

bot.command('cancel', async ctx => {
  if (!ctx.from) return;
  pending.delete(`${ctx.from.id}`);
  await ctx.reply('已取消。');
});

bot.command('rules', async ctx => {
  if (!isPrivate(ctx) || !ctx.from) return;
  const { text, keyboard } = ruleListPage(userIdOf(ctx), 1);
  await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
});

function totalSteps(d: RuleDefinition): number {
  return d.rounds.reduce((s, r) => s + r.steps.length, 0);
}

bot.command('rule', async ctx => {
  if (!isPrivate(ctx) || !ctx.from) return;
  const ruleId = (ctx.message?.text ?? '').replace(/^\/\w+(?:@\w+)?\s*/, '').trim();
  if (!/^[0-9a-f]{8}$/.test(ruleId)) throw Error('格式：/rule 编号');
  const rule = db.getRuleByUser(ruleId, userIdOf(ctx));
  if (!rule) throw Error('找不到规则');
  await ctx.reply(
    `<b>${html(rule.name)}</b>\n\n<pre>${html(JSON.stringify(rule.definition, null, 2))}</pre>`,
    { parse_mode: 'HTML' }
  );
});

bot.command('deleterule', async ctx => {
  if (!isPrivate(ctx) || !ctx.from) return;
  const ruleId = (ctx.message?.text ?? '').replace(/^\/\w+(?:@\w+)?\s*/, '').trim();
  if (!/^[0-9a-f]{8}$/.test(ruleId)) throw Error('格式：/deleterule 编号');
  const ok = db.deleteRule(ruleId, userIdOf(ctx));
  if (!ok) throw Error('找不到规则或权限不足');
  await ctx.reply('已删除。');
});

bot.callbackQuery(/^rlist:(\d+)$/, async ctx => {
  if (!isPrivate(ctx) || !ctx.from) return;
  const page = Number(ctx.match[1]) || 1;
  const { text, keyboard } = ruleListPage(userIdOf(ctx), page);
  await ctx.answerCallbackQuery();
  await safeEdit(ctx, text, keyboard);
});

bot.callbackQuery('rnew', async ctx => {
  if (!isPrivate(ctx) || !ctx.from) return;
  db.touchUser(userIdOf(ctx));
  pending.set(`${ctx.from.id}`, { kind: 'create-rule', userId: userIdOf(ctx) });
  await ctx.answerCallbackQuery();
  await ctx.reply(
    '好的，请把规则 JSON 发给我（<code>name</code> 字段为规则名）：直接粘贴文本，或发送 <code>.json</code> 文件。\n结构见 /help。\n取消：/cancel',
    { parse_mode: 'HTML' }
  );
});

bot.callbackQuery(/^rview:([0-9a-f]{8})$/, async ctx => {
  if (!isPrivate(ctx) || !ctx.from) return;
  const rule = db.getRuleByUser(ctx.match[1], userIdOf(ctx));
  if (!rule) { await ctx.answerCallbackQuery({ text: '规则不存在或无权访问', show_alert: true }); return; }
  await ctx.answerCallbackQuery();
  await safeEdit(ctx, ruleDetailText(rule), ruleDetailKeyboard(rule.ruleId));
});

bot.callbackQuery(/^rjson:([0-9a-f]{8})$/, async ctx => {
  if (!isPrivate(ctx) || !ctx.from) return;
  const rule = db.getRuleByUser(ctx.match[1], userIdOf(ctx));
  if (!rule) { await ctx.answerCallbackQuery({ text: '规则不存在或无权访问', show_alert: true }); return; }
  await ctx.answerCallbackQuery();
  const json = JSON.stringify(rule.definition, null, 2);
  const body = `<b>${html(rule.name)}</b> · <code>${rule.ruleId}</code>\n\n<pre>${html(json)}</pre>`;
  const kb = new InlineKeyboard().text('⬅️ 返回', `rview:${rule.ruleId}`).text('🗑 删除', `rdel:${rule.ruleId}`);
  if (body.length <= 4000) {
    await safeEdit(ctx, body, kb);
  } else {
    try {
      await ctx.replyWithDocument(new InputFile(Buffer.from(json, 'utf8'), `rule-${rule.ruleId}.json`), {
        caption: `${rule.name} · ${rule.ruleId}（JSON 太长，以文件发送）`,
        reply_markup: kb
      });
    } catch { await ctx.reply('JSON 太长且发送文件失败，请用 /rule 查看。'); }
  }
});

bot.callbackQuery(/^redit:([0-9a-f]{8})$/, async ctx => {
  if (!isPrivate(ctx) || !ctx.from) return;
  const rule = db.getRuleByUser(ctx.match[1], userIdOf(ctx));
  if (!rule) { await ctx.answerCallbackQuery({ text: '规则不存在或无权访问', show_alert: true }); return; }
  pending.set(`${ctx.from.id}`, { kind: 'edit-rule', userId: userIdOf(ctx), ruleId: rule.ruleId });
  await ctx.answerCallbackQuery();
  await ctx.reply(
    `当前 JSON：\n<pre>${html(JSON.stringify(rule.definition, null, 2))}</pre>\n\n` +
    `把新 JSON 发给我即可覆盖；名称会沿用当前的：${html(rule.name)}\n取消：/cancel`,
    { parse_mode: 'HTML' }
  );
});

bot.callbackQuery(/^rdel:([0-9a-f]{8})$/, async ctx => {
  if (!isPrivate(ctx) || !ctx.from) return;
  const rule = db.getRuleByUser(ctx.match[1], userIdOf(ctx));
  if (!rule) { await ctx.answerCallbackQuery({ text: '规则不存在或无权访问', show_alert: true }); return; }
  await ctx.answerCallbackQuery();
  await safeEdit(
    ctx,
    `⚠️ 确定删除「<b>${html(rule.name)}</b>」(<code>${rule.ruleId}</code>)？\n此操作不可恢复。`,
    ruleDeleteKeyboard(rule.ruleId)
  );
});

bot.callbackQuery(/^rdelok:([0-9a-f]{8})$/, async ctx => {
  if (!isPrivate(ctx) || !ctx.from) return;
  const ok = db.deleteRule(ctx.match[1], userIdOf(ctx));
  if (!ok) { await ctx.answerCallbackQuery({ text: '删除失败或无权操作', show_alert: true }); return; }
  await ctx.answerCallbackQuery({ text: '已删除' });
  const { text, keyboard } = ruleListPage(userIdOf(ctx), 1);
  await safeEdit(ctx, text, keyboard);
});

bot.command('startgame', async ctx => {
  if (!isGroup(ctx) || !ctx.from) return;
  await requireGroupAdmin(ctx);
  if (!await isBotAdmin(chatIdOf(ctx))) {
    throw Error('请先把机器人设为本群管理员（需要发送消息权限）');
  }
  const existing = db.getActiveGameByChat(chatIdOf(ctx));
  if (existing) {
    existing.status = 'ended';
    existing.endedAt = Date.now();
    db.recordEvent(existing.gameId, userIdOf(ctx), 'replace', {});
    push(existing);
  }
  const rules = db.listRules(userIdOf(ctx));
  if (!rules.length) {
    await ctx.reply('你还没有规则。私聊 /newrule 名称 创建后再来开局。');
    return;
  }
  const kb = new InlineKeyboard();
  for (const r of rules) kb.text(r.name.slice(0, 30), `pick:${r.ruleId}`).row();
  await ctx.reply('选择要开始的规则：', { reply_markup: kb });
});

bot.callbackQuery(/^pick:([0-9a-f]{8})$/, async ctx => {
  if (!isGroup(ctx) || !ctx.from) return;
  await requireGroupAdmin(ctx);
  const ruleId = ctx.match[1];
  const rule = db.getRuleByUser(ruleId, userIdOf(ctx));
  if (!rule) throw Error('规则不存在');
  const game = db.createGame(chatIdOf(ctx), ruleId, userIdOf(ctx));
  await ctx.answerCallbackQuery();
  const { text } = renderSignupPage(game, rule.definition, [], 1);
  const sent = await bot.api.sendMessage(chatIdOf(ctx), text, { parse_mode: 'HTML', reply_markup: signupKeyboard(game, 1) });
  game.signupMsgId = sent.message_id;
  db.updateGame(game);
  broadcast(game.gameId);
});

bot.command('joingame', async ctx => {
  if (!isGroup(ctx) || !ctx.from) return;
  const game = db.getActiveGameByChat(chatIdOf(ctx));
  if (!game || game.status !== 'signup') throw Error('当前不在报名阶段');
  const rule = db.getRule(game.ruleId);
  if (!rule) throw Error('规则不存在（可能被删除）');
  joinLeave(game, rule.definition, userIdOf(ctx), 'join');
  push(game);
  await notifyGroup(game, 'join', userIdOf(ctx));
  await ctx.reply(`✅ 已加入（当前 ${db.listPlayers(game.gameId).length} / ${rule.definition.maxPlayers} 人）`);
});

bot.command('leavegame', async ctx => {
  if (!isGroup(ctx) || !ctx.from) return;
  const game = db.getActiveGameByChat(chatIdOf(ctx));
  if (!game) throw Error('本群没有进行中的对局');
  const rule = db.getRule(game.ruleId);
  if (!rule) throw Error('规则不存在（可能被删除）');
  joinLeave(game, rule.definition, userIdOf(ctx), 'leave');
  push(game);
  await notifyGroup(game, 'leave', userIdOf(ctx));
  await ctx.reply('已退出。');
});

bot.command('begin', async ctx => {
  if (!isGroup(ctx) || !ctx.from) return;
  await requireGroupAdmin(ctx);
  const game = db.getActiveGameByChat(chatIdOf(ctx));
  if (!game || game.status !== 'signup') throw Error('没有处于报名阶段的对局');
  const players = db.listPlayers(game.gameId);
  const rule = db.getRule(game.ruleId);
  if (!rule) throw Error('规则不存在（可能被删除）');
  const min = rule.definition.minPlayers;
  const max = rule.definition.maxPlayers;
  if (players.length < min) throw Error(`至少需要 ${min} 位玩家，当前 ${players.length} 人`);
  if (players.length > max) throw Error(`最多 ${max} 位玩家，当前 ${players.length} 人`);
  attachPlayers(game);
  runOk(game, rule.definition, players, { type: 'begin', userId: userIdOf(ctx) });
  db.recordEvent(game.gameId, userIdOf(ctx), 'begin', { roundIdx: game.roundIdx, stepIdx: game.stepIdx });
  push(game);
  await sendStatus(chatIdOf(ctx), game.gameId);
});

bot.command('next', async ctx => {
  if (!isGroup(ctx) || !ctx.from) return;
  await requireGroupAdmin(ctx);
  await doAdmin(ctx, async game => {
    const rule = db.getRule(game.ruleId);
    if (!rule) throw Error('规则不存在');
    runOk(game, rule.definition, db.listPlayers(game.gameId), { type: 'next', userId: userIdOf(ctx) });
    db.recordEvent(game.gameId, userIdOf(ctx), 'next', { roundIdx: game.roundIdx, stepIdx: game.stepIdx });
  });
});

bot.command('skip', async ctx => {
  if (!isGroup(ctx) || !ctx.from) return;
  await requireGroupAdmin(ctx);
  await doAdmin(ctx, async game => {
    const rule = db.getRule(game.ruleId);
    if (!rule) throw Error('规则不存在');
    runOk(game, rule.definition, db.listPlayers(game.gameId), { type: 'skip', userId: userIdOf(ctx) });
    db.recordEvent(game.gameId, userIdOf(ctx), 'skip', { roundIdx: game.roundIdx, stepIdx: game.stepIdx });
  });
});

bot.command('undo', async ctx => {
  if (!isGroup(ctx) || !ctx.from) return;
  await requireGroupAdmin(ctx);
  await doAdmin(ctx, async game => {
    const rule = db.getRule(game.ruleId);
    if (!rule) throw Error('规则不存在');
    performUndo(game, rule.definition, userIdOf(ctx));
  });
});

bot.command('endgame', async ctx => {
  if (!isGroup(ctx) || !ctx.from) return;
  await requireGroupAdmin(ctx);
  const game = db.getActiveGameByChat(chatIdOf(ctx));
  if (!game) throw Error('本群没有进行中的对局');
  game.status = 'ended';
  game.endedAt = Date.now();
  db.recordEvent(game.gameId, userIdOf(ctx), 'end', {});
  push(game);
  await ctx.reply('已结束本群当前对局。');
});

bot.command('play', async ctx => {
  if (!isGroup(ctx) || !ctx.from) return;
  const game = db.getActiveGameByChat(chatIdOf(ctx));
  if (!game) throw Error('本群没有进行中的对局');
  if (!publicUrl) throw Error('未配置 PUBLIC_URL');
  const url = `${publicUrl}/?game=${game.gameId}`;
  try {
    await bot.api.sendMessage(ctx.from.id,
      `点击下方按钮在 Telegram 内嵌 Mini App 中查看本群当前对局：\n${url}`,
      { reply_markup: new InlineKeyboard().webApp('🎮 打开实时视图', url) });
    await ctx.reply('已私聊发给你打开按钮（电脑 Telegram Desktop 也可用）。');
  } catch (e) {
    await ctx.reply('请先私聊过我一次（/start）我才能发私聊消息。');
  }
});

bot.command('status', async ctx => {
  if (!isGroup(ctx)) return;
  const game = db.getActiveGameByChat(chatIdOf(ctx));
  if (!game) {
    await ctx.reply('📊 本群没有进行中的对局。');
    return;
  }
  await sendStatus(chatIdOf(ctx), game.gameId);
});

/** 下载 Telegram 服务器上的文件（用户上传的 .json 规则） */
async function downloadTelegramFile(filePath: string): Promise<string> {
  const root = (process.env.BOT_API_ROOT || 'https://api.telegram.org').replace(/\/+$/, '');
  const res = await fetch(`${root}/file/bot${token}/${filePath}`);
  if (!res.ok) throw Error(`下载文件失败：HTTP ${res.status}`);
  return await res.text();
}

/** 把一段规则 JSON（粘贴的文本或上传的文件内容）落库：新建或覆盖 */
async function saveRuleJson(ctx: Context, p: Pending, raw: string): Promise<void> {
  if (!ctx.from) return;
  db.touchUser(userIdOf(ctx));
  const clean = raw.replace(/^\uFEFF/, '').trim();
  let def: RuleDefinition;
  try { def = ruleDefinition.parse(JSON.parse(clean)); }
  catch (e) { throw Error(`JSON 解析失败：${(e as Error).message}`); }
  if (p.kind === 'create-rule') {
    const name = def.name?.trim() || '未命名';
    const rule = db.createRule(userIdOf(ctx), name, def);
    pending.delete(`${ctx.from.id}`);
    await ctx.reply('✅ 已创建\n\n' + ruleDetailText(rule), { parse_mode: 'HTML', reply_markup: ruleDetailKeyboard(rule.ruleId) });
  } else {
    const existing = db.getRuleByUser(p.ruleId!, userIdOf(ctx));
    const updated = db.updateRule(p.ruleId!, userIdOf(ctx), existing?.name ?? def.name, def);
    pending.delete(`${ctx.from.id}`);
    if (!updated) throw Error('更新失败');
    await ctx.reply('✅ 已更新\n\n' + ruleDetailText(updated), { parse_mode: 'HTML', reply_markup: ruleDetailKeyboard(updated.ruleId) });
  }
}

bot.on('message:text', async ctx => {
  if (!isPrivate(ctx) || !ctx.from) return;
  const p = pending.get(`${ctx.from.id}`);
  if (!p) return;
  await saveRuleJson(ctx, p, ctx.message.text);
});

bot.on('message:document', async ctx => {
  if (!isPrivate(ctx) || !ctx.from) return;
  const doc = ctx.message.document;
  const fname = doc.file_name ?? '';
  const looksJson = /\.json$/i.test(fname) || (doc.mime_type ?? '').includes('json');
  if (!looksJson) {
    if (pending.has(`${ctx.from.id}`)) {
      await ctx.reply('这似乎不是 .json 文件。请发送 <code>.json</code> 规则文件，或直接粘贴 JSON 文本。', { parse_mode: 'HTML' });
    }
    return;
  }
  const fresh = !pending.has(`${ctx.from.id}`);
  let raw: string;
  try {
    const file = await ctx.getFile();
    if (!file.file_path) throw Error('拿不到文件路径');
    raw = await downloadTelegramFile(file.file_path);
  } catch (e) {
    throw Error(`读取文件失败：${(e as Error).message}`);
  }
  const p: Pending = pending.get(`${ctx.from.id}`) ?? { kind: 'create-rule', userId: userIdOf(ctx) };
  await saveRuleJson(ctx, p, raw);
  if (fresh) {
    await ctx.reply('ℹ️ 未在 /newrule 流程中，已按「新建规则」处理；要覆盖已有规则请先 /editrule &lt;编号&gt; 再发文件。', { parse_mode: 'HTML' });
  }
});

async function doAdmin(ctx: Context, fn: (game: GameRecord) => void | Promise<void>) {
  const game = db.getActiveGameByChat(chatIdOf(ctx));
  if (!game) throw Error('本群没有进行中的对局');
  attachPlayers(game);
  await fn(game);
  push(game);
  await sendStatus(chatIdOf(ctx), game.gameId);
}

/** 把玩家挂到 game 上，供引擎的轮换 / 主角 / 比大小结算读取 */
function attachPlayers(game: GameRecord): void {
  game.players = db.listPlayers(game.gameId);
}

/** 引擎唯一入口；失败即抛（沿用 bot.catch 的错误提示），成功返回事件结果 */
function runOk(game: GameRecord, definition: RuleDefinition, players: GamePlayer[], intent: EngineIntent): Extract<RunResult, { ok: true }> {
  const r = run(game, definition, players, intent);
  if (!r.ok) throw Error(r.text);
  return r;
}

/** 报名/退出：引擎校验（阶段 / 满员 / 重复），适配器落库 */
function joinLeave(game: GameRecord, definition: RuleDefinition, userId: UserId, kind: 'join' | 'leave'): void {
  attachPlayers(game);
  runOk(game, definition, game.players ?? [], { type: kind, userId });
  if (kind === 'join') db.addPlayer(game.gameId, userId);
  else db.removePlayer(game.gameId, userId);
  db.recordEvent(game.gameId, userId, kind, {});
}

async function withAdminGame(ctx: Context, fn: (game: GameRecord, rule: RuleRecord) => void | Promise<void>): Promise<void> {
  const gameId = ctx.match![1];
  const game = db.getGame(gameId);
  if (!game) return;
  const rule = db.getRule(game.ruleId);
  if (!rule) return;
  attachPlayers(game);
  try {
    await fn(game, rule);
    push(game);
    await ctx.answerCallbackQuery();
    await sendStatus(game.chatId, gameId);
  } catch (e) {
    await ctx.answerCallbackQuery({ text: (e as Error).message, show_alert: true });
  }
}

function performUndo(game: GameRecord, definition: RuleDefinition, actorId: UserId): void {
  const events = db.listEvents(game.gameId);
  const last = events.at(-1);
  if (!last) throw Error('没有可撤销的事件');
  const eff = applyUndo(game, definition, last);
  if (eff?.kind === 'add-player') db.addPlayer(game.gameId, eff.userId);
  else if (eff?.kind === 'remove-player') db.removePlayer(game.gameId, eff.userId);
  else if (eff?.kind === 'clear-pending-rolls') session(game.gameId).pendingRolls = {};
  db.recordEvent(game.gameId, actorId, 'undo', { undoneType: last.type });
}

function performChoice(game: GameRecord, definition: RuleDefinition, userId: UserId, optIdx: number, isAdmin: boolean): string {
  const phase = game.state.phase;
  if (phase.kind !== 'choice') throw Error('当前不在选择阶段');
  if (phase.pickedBy !== null && phase.pickedBy !== userId) throw Error('不是你的回合，请等待系统指定玩家');
  if (phase.pickedBy === null && !isAdmin) throw Error('需要管理员或被指定玩家点击');
  const r = runOk(game, definition, db.listPlayers(game.gameId), { type: 'choice', userId, optionIdx: optIdx });
  db.recordEvent(game.gameId, userId, 'choice', {
    optionIdx: optIdx,
    optionText: phase.options[optIdx]?.text,
    fromRoundIdx: phase.roundIdx,
    fromStepIdx: phase.stepIdx
  });
  return r.message ?? '';
}

const DICE_ANIMATION_MS = Number(process.env.DICE_ANIMATION_MS || 3500);

bot.on('message:dice', async ctx => {
  if (!isGroup(ctx) || !ctx.from) return;
  const emoji = ctx.message.dice.emoji as DiceEmoji;
  if (!SUPPORTED_DICE_EMOJIS.includes(emoji)) return;
  const game = db.getActiveGameByChat(chatIdOf(ctx));
  if (!game || game.status !== 'in_progress') return;
  const phase = game.state.phase;
  if (phase.kind !== 'roll' && phase.kind !== 'showdown') return;
  if (phase.emoji !== emoji) {
    await bot.api.sendMessage(chatIdOf(ctx), `❌ 本轮需要 ${phase.emoji}，你发的是 ${emoji}`);
    return;
  }
  const players = db.listPlayers(game.gameId);
  const userId = userIdOf(ctx);
  if (!players.some(p => p.userId === userId)) return;

  const sess = session(game.gameId);
  const pendingRolls = sess.pendingRolls;
  if (pendingRolls[String(userId)]) {
    await bot.api.sendMessage(chatIdOf(ctx), '⏳ 你的色子结果还没揭晓，请稍候。');
    return;
  }
  if (phase.kind === 'roll') {
    if (phase.expectedPlayerId !== null && phase.expectedPlayerId !== userId) return;
  } else if (phase.rolls.some(r => r.userId === userId)) {
    await bot.api.sendMessage(chatIdOf(ctx), '✅ 你已经掷过了，等待其他玩家。');
    return;
  }

  let waitingMsgId = 0;
  if (phase.kind === 'roll') {
    const waiting = await bot.api.sendMessage(
      chatIdOf(ctx),
      `${emoji} ${mentionHtml(userId, displayName(userId))} 正在掷${emojiLabel(emoji)}…`,
      { parse_mode: 'HTML' }
    );
    waitingMsgId = waiting.message_id;
  }

  sess.pendingRolls = {
    ...pendingRolls,
    [String(userId)]: {
      userId,
      value: ctx.message.dice.value,
      chatId: chatIdOf(ctx),
      waitingMsgId,
      emoji,
      kind: phase.kind,
      roundIdx: phase.roundIdx,
      stepIdx: phase.stepIdx
    }
  };
  push(game);

  setTimeout(() => resolvePendingRoll(game.gameId, userId, ctx.message.dice!.value, emoji), DICE_ANIMATION_MS);
});

function emojiLabel(emoji: DiceEmoji): string {
  return ({
    '🎲': '色子', '🎯': '飞镖', '🏀': '篮球', '⚽': '足球', '🎰': '老虎机', '🎳': '保龄球'
  } as Record<DiceEmoji, string>)[emoji];
}

async function resolvePendingRoll(gameId: string, expectedUserId: UserId, expectedValue: number, expectedEmoji: DiceEmoji): Promise<void> {
  const game = db.getGame(gameId);
  if (!game) return;
  const sess = session(gameId);
  const pending = sess.pendingRolls[String(expectedUserId)];
  if (!pending) return;
  if (pending.value !== expectedValue || pending.emoji !== expectedEmoji) return;
  const rest = { ...sess.pendingRolls };
  delete rest[String(expectedUserId)];
  sess.pendingRolls = rest;
  const rule = db.getRule(game.ruleId);
  if (!rule) { push(game); return; }
  const players = db.listPlayers(gameId);
  const phase0 = game.state.phase;
  const matchesStep = (p: typeof phase0) => p.kind !== 'signup' && p.roundIdx === pending.roundIdx && p.stepIdx === pending.stepIdx;
  const boardId = sess.boardMsgId;

  if (pending.kind === 'showdown' && phase0.kind === 'showdown' && matchesStep(phase0)) {
    let resultMessage: string;
    let settled = false;
    let rerolled = false;
    try {
      const r = run(game, rule.definition, players, { type: 'showdownRoll', userId: pending.userId, value: pending.value, emoji: pending.emoji });
      if (r.ok) {
        resultMessage = r.message ?? '';
        settled = r.events.some(e => e.type === 'showdownSettled' || e.type === 'showdownRerolled');
        rerolled = r.events.some(e => e.type === 'showdownRerolled');
      } else {
        resultMessage = `骰子未接受：${r.text}`;
      }
    } catch (e) {
      resultMessage = `骰子未接受：${(e as Error).message}`;
    }
    db.recordEvent(gameId, pending.userId, 'showdown', {
      value: pending.value, emoji: pending.emoji, roundIdx: pending.roundIdx, stepIdx: pending.stepIdx
    });
    push(game);
    if (settled) {
      if (boardId) {
        try {
          await bot.api.editMessageText(pending.chatId, boardId, resultMessage, { parse_mode: 'HTML', reply_markup: { inline_keyboard: [] } });
        } catch {
          await bot.api.sendMessage(pending.chatId, resultMessage, { parse_mode: 'HTML' }).catch(() => {});
        }
      } else {
        await bot.api.sendMessage(pending.chatId, resultMessage, { parse_mode: 'HTML' });
      }
      if (rerolled) {
        // 平局重掷：把并列提示留在旧看板，另发一条新看板
        sess.boardMsgId = undefined;
      }
      if (game.status === 'ended') {
        await bot.api.sendMessage(pending.chatId, '🏁 对局已结束。');
        return;
      }
      await sendStatus(pending.chatId, gameId);
      return;
    }
    await sendStatus(pending.chatId, gameId);
    return;
  }

  if (pending.kind === 'roll' && phase0.kind === 'roll' && matchesStep(phase0)) {
    let resultMessage: string;
    try {
      const r = run(game, rule.definition, players, { type: 'roll', userId: pending.userId, value: pending.value, emoji: pending.emoji });
      resultMessage = r.ok ? (r.message ?? '') : `骰子未接受：${r.text}`;
    } catch (e) {
      resultMessage = `骰子未接受：${(e as Error).message}`;
    }
    db.recordEvent(gameId, pending.userId, 'roll', { value: pending.value, emoji: pending.emoji });
    push(game);
    try {
      await bot.api.editMessageText(pending.chatId, pending.waitingMsgId,
        `${pending.emoji} ${mentionHtml(pending.userId, displayName(pending.userId))} 掷出 <b>${pending.value}</b>`,
        { parse_mode: 'HTML' });
    } catch {}
    await bot.api.sendMessage(pending.chatId, resultMessage, { parse_mode: 'HTML' });
    if (game.status === 'ended') {
      await bot.api.sendMessage(pending.chatId, '🏁 对局已结束。');
      return;
    }
    await sendStatus(pending.chatId, gameId);
    return;
  }

  // phase 已切换，丢弃这次结果
  push(game);
}

bot.callbackQuery(/^join:([0-9a-f]{8})$/, async ctx => {
  if (!isGroup(ctx) || !ctx.from) return;
  const gameId = ctx.match[1];
  const game = db.getGame(gameId);
  if (!game) { await ctx.answerCallbackQuery({ text: '对局不存在' }); return; }
  const rule = db.getRule(game.ruleId);
  if (!rule) { await ctx.answerCallbackQuery({ text: '规则已删除' }); return; }
  try { joinLeave(game, rule.definition, userIdOf(ctx), 'join'); }
  catch (e) { await ctx.answerCallbackQuery({ text: (e as Error).message, show_alert: true }); return; }
  push(game);
  await refreshSignupMessage(game);
  await ctx.answerCallbackQuery({ text: '已加入' });
});

bot.callbackQuery(/^leave:([0-9a-f]{8})$/, async ctx => {
  if (!isGroup(ctx) || !ctx.from) return;
  const gameId = ctx.match[1];
  const game = db.getGame(gameId);
  if (!game) { await ctx.answerCallbackQuery({ text: '对局不存在' }); return; }
  const rule = db.getRule(game.ruleId);
  if (!rule) { await ctx.answerCallbackQuery({ text: '规则已删除' }); return; }
  try { joinLeave(game, rule.definition, userIdOf(ctx), 'leave'); }
  catch (e) { await ctx.answerCallbackQuery({ text: (e as Error).message, show_alert: true }); return; }
  push(game);
  await refreshSignupMessage(game);
  await ctx.answerCallbackQuery({ text: '已退出' });
});

bot.callbackQuery(/^begin:([0-9a-f]{8})$/, async ctx => {
  if (!isGroup(ctx) || !ctx.from) return;
  await requireGroupAdmin(ctx);
  const gameId = ctx.match[1];
  const game = db.getGame(gameId);
  if (!game || game.status !== 'signup') { await ctx.answerCallbackQuery({ text: '已不在报名阶段' }); return; }
  const players = db.listPlayers(gameId);
  const rule = db.getRule(game.ruleId);
  if (!rule) { await ctx.answerCallbackQuery({ text: '规则已删除' }); return; }
  if (players.length < rule.definition.minPlayers) {
    await ctx.answerCallbackQuery({ text: `至少需要 ${rule.definition.minPlayers} 位玩家（当前 ${players.length} 人）`, show_alert: true });
    return;
  }
  if (players.length > rule.definition.maxPlayers) {
    await ctx.answerCallbackQuery({ text: `最多 ${rule.definition.maxPlayers} 位玩家`, show_alert: true });
    return;
  }
  attachPlayers(game);
  runOk(game, rule.definition, players, { type: 'begin', userId: userIdOf(ctx) });
  db.recordEvent(gameId, userIdOf(ctx), 'begin', { roundIdx: game.roundIdx, stepIdx: game.stepIdx });
  push(game);
  await refreshSignupMessage(game);
  await ctx.answerCallbackQuery();
  await sendStatus(chatIdOf(ctx), gameId);
});

bot.callbackQuery(/^pickChoice:([0-9a-f]{8}):(\d+)$/, async ctx => {
  if (!isGroup(ctx) || !ctx.from) return;
  const gameId = ctx.match[1];
  const optIdx = Number(ctx.match[2]);
  const game = db.getGame(gameId);
  if (!game) { await ctx.answerCallbackQuery({ text: '对局不存在' }); return; }
  const rule = db.getRule(game.ruleId);
  if (!rule) { await ctx.answerCallbackQuery({ text: '规则已删除' }); return; }
  const phase = game.state.phase;
  if (phase.kind !== 'choice') { await ctx.answerCallbackQuery({ text: '当前不在选择阶段' }); return; }
  if (phase.pickedBy !== null && phase.pickedBy !== userIdOf(ctx)) {
    await ctx.answerCallbackQuery({ text: '不是你的回合', show_alert: true });
    return;
  }
  const isAdmin = await isTelegramGroupAdmin(ctx.chat!.id, ctx.from.id);
  if (phase.pickedBy === null && !isAdmin) {
    await ctx.answerCallbackQuery({ text: '需要管理员或被指定玩家点击', show_alert: true });
    return;
  }
  try {
    const message = performChoice(game, rule.definition, userIdOf(ctx), optIdx, isAdmin);
    push(game);
    await ctx.answerCallbackQuery({ text: message });
    await sendStatus(game.chatId, gameId);
  } catch (e) {
    await ctx.answerCallbackQuery({ text: (e as Error).message, show_alert: true });
  }
});

bot.callbackQuery(/^next:([0-9a-f]{8})$/, async ctx => {
  if (!isGroup(ctx) || !ctx.from) return;
  await requireGroupAdmin(ctx);
  await withAdminGame(ctx, (game, rule) => {
    runOk(game, rule.definition, db.listPlayers(game.gameId), { type: 'next', userId: userIdOf(ctx) });
    db.recordEvent(game.gameId, userIdOf(ctx), 'next', { roundIdx: game.roundIdx, stepIdx: game.stepIdx });
  });
});

bot.callbackQuery(/^skip:([0-9a-f]{8})$/, async ctx => {
  if (!isGroup(ctx) || !ctx.from) return;
  await requireGroupAdmin(ctx);
  await withAdminGame(ctx, (game, rule) => {
    runOk(game, rule.definition, db.listPlayers(game.gameId), { type: 'skip', userId: userIdOf(ctx) });
    db.recordEvent(game.gameId, userIdOf(ctx), 'skip', { roundIdx: game.roundIdx, stepIdx: game.stepIdx });
  });
});

bot.callbackQuery(/^undo:([0-9a-f]{8})$/, async ctx => {
  if (!isGroup(ctx) || !ctx.from) return;
  await requireGroupAdmin(ctx);
  await withAdminGame(ctx, (game, rule) => {
    performUndo(game, rule.definition, userIdOf(ctx));
  });
});

bot.callbackQuery(/^end:([0-9a-f]{8})$/, async ctx => {
  if (!isGroup(ctx) || !ctx.from) return;
  await requireGroupAdmin(ctx);
  await withAdminGame(ctx, (game) => {
    game.status = 'ended'; game.endedAt = Date.now();
    db.recordEvent(game.gameId, userIdOf(ctx), 'end', {});
  });
});

bot.callbackQuery(/^sign:([0-9a-f]{8}):(\d+)$/, async ctx => {
  if (!isGroup(ctx)) return;
  const gameId = ctx.match[1];
  const page = Math.max(1, Number(ctx.match[2]));
  const game = db.getGame(gameId);
  if (!game) { await ctx.answerCallbackQuery({ text: '对局不存在' }); return; }
  const rule = db.getRule(game.ruleId);
  const players = db.listPlayers(gameId);
  const { text, totalPages } = renderSignupPage(game, rule?.definition, players, page);
  try {
    await ctx.answerCallbackQuery();
    await bot.api.editMessageText(game.chatId, ctx.callbackQuery.message!.message_id, text,
      { parse_mode: 'HTML', reply_markup: signupKeyboard(game, page) });
  } catch (e) { console.warn('[sign]', (e as Error).message); }
});

const STATIC_FILES: Record<string, string> = {
  '/': 'index.html',
  '/index.html': 'index.html',
  '/app.js': 'app.js',
  '/style.css': 'style.css'
};
const STATIC_MIME: Record<string, string> = {
  'index.html': 'text/html',
  'app.js': 'application/javascript',
  'style.css': 'text/css'
};

const server = createServer(async (req, res) => {
  try {
    if (!req.url) { res.writeHead(404); res.end(); return; }
    const url = new URL(req.url, `http://localhost`);
    if (url.pathname in STATIC_FILES) {
      const filename = STATIC_FILES[url.pathname];
      const buf = readFileSync(join(ROOT, 'public', filename));
      res.writeHead(200, {
        'content-type': `${STATIC_MIME[filename]}; charset=utf-8`,
        'cache-control': 'no-store, no-cache, must-revalidate'
      });
      res.end(buf);
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
      return;
    }
    res.writeHead(404); res.end();
  } catch (e) {
    console.error('[http]', e);
    res.writeHead(500); res.end(String(e));
  }
});

async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function handleApi(req: IncomingMessage, res: any, url: URL): Promise<void> {
  const setJson = (code: number, body: unknown) => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  };
  const initData = url.searchParams.get('initData') ?? (req.headers['x-init-data'] as string | undefined) ?? '';
  let userId: UserId;
  let tgUserId: number;
  try { tgUserId = verifyInitData(initData, token!).id; userId = String(tgUserId); }
  catch (e) { setJson(401, { error: (e as Error).message }); return; }
  db.touchUser(userId);

  const m = url.pathname.match(/^\/api\/(.+)$/);
  if (!m) { setJson(404, { error: 'not found' }); return; }
  const path = m[1];

  if (path === 'rules' && req.method === 'GET') {
    setJson(200, { rules: db.listRules(userId).map(serializeRule) });
    return;
  }
  const ruleGet = path.match(/^rules\/([0-9a-f]{8})$/);
  if (ruleGet) {
    const rule = db.getRuleByUser(ruleGet[1], userId);
    if (!rule) { setJson(404, { error: 'not found' }); return; }
    if (req.method === 'GET') { setJson(200, serializeRule(rule)); return; }
    if (req.method === 'DELETE') {
      if (db.deleteRule(ruleGet[1], userId)) setJson(200, { ok: true });
      else setJson(404, { error: 'not found' });
      return;
    }
  }
  const gameMatch = path.match(/^games\/([0-9a-f]{8})$/);
  if (gameMatch && req.method === 'GET') {
    const game = db.getGame(gameMatch[1]);
    if (!game) { setJson(404, { error: 'not found' }); return; }
    const rule = db.getRule(game.ruleId);
    const players = db.listPlayers(game.gameId);
    const isAdmin = await isTelegramGroupAdmin(game.chatId, tgUserId);
    setJson(200, snapshot(game, rule?.definition, players, userId, isAdmin));
    return;
  }
  const actionMatch = path.match(/^games\/([0-9a-f]{8})\/(join|leave|next|skip|undo|end|choice)$/);
  if (actionMatch) {
    const [, gameId, action] = actionMatch;
    const game = db.getGame(gameId);
    if (!game) { setJson(404, { error: 'not found' }); return; }
    const rule = db.getRule(game.ruleId);
    if (!rule) { setJson(404, { error: 'rule missing' }); return; }
    attachPlayers(game);
    const isAdmin = await isTelegramGroupAdmin(game.chatId, tgUserId);
    try {
      if (action === 'join') {
        joinLeave(game, rule.definition, userId, 'join');
      } else if (action === 'leave') {
        joinLeave(game, rule.definition, userId, 'leave');
      } else if (action === 'next') {
        if (!isAdmin) throw Error('仅群管理员');
        runOk(game, rule.definition, db.listPlayers(game.gameId), { type: 'next', userId });
        db.recordEvent(gameId, userId, 'next', { roundIdx: game.roundIdx, stepIdx: game.stepIdx });
      } else if (action === 'skip') {
        if (!isAdmin) throw Error('仅群管理员');
        runOk(game, rule.definition, db.listPlayers(game.gameId), { type: 'skip', userId });
        db.recordEvent(gameId, userId, 'skip', { roundIdx: game.roundIdx, stepIdx: game.stepIdx });
      } else if (action === 'undo') {
        if (!isAdmin) throw Error('仅群管理员');
        performUndo(game, rule.definition, userId);
      } else if (action === 'end') {
        if (!isAdmin) throw Error('仅群管理员');
        game.status = 'ended'; game.endedAt = Date.now();
        db.recordEvent(gameId, userId, 'end', {});
      } else if (action === 'choice') {
        const raw = await readBody(req);
        let body: { optionIdx?: number } = {};
        try { body = JSON.parse(raw || '{}') as { optionIdx?: number }; } catch { body = {}; }
        const optIdx = Number(body.optionIdx);
        if (!Number.isInteger(optIdx) || optIdx < 0) throw Error('optionIdx 无效');
        const message = performChoice(game, rule.definition, userId, optIdx, isAdmin);
        notifyGroup(game, 'choice', userId).catch(e => console.error('[notify]', (e as Error).message));
        setJson(200, { ok: true, message });
        push(game);
        return;
      }
      push(game);
      notifyGroup(game, action, userId).catch(e => console.error('[notify]', (e as Error).message));
      const players = db.listPlayers(gameId);
      setJson(200, snapshot(game, rule.definition, players, userId, isAdmin));
    } catch (e) { setJson(400, { error: (e as Error).message }); }
    return;
  }
  setJson(404, { error: 'unknown route' });
}

function serializeRule(r: RuleRecord) {
  return {
    ruleId: r.ruleId, name: r.name, definition: r.definition,
    createdAt: r.createdAt, updatedAt: r.updatedAt
  };
}

const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const deny = (code: number, reason: string) => {
    console.warn('[ws] upgrade denied:', code, reason);
    const body = reason;
    socket.write(`HTTP/1.1 ${code} ${reason}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
    socket.destroy();
  };
  if (url.pathname !== '/ws') { deny(404, 'Not Found'); return; }
  const initData = url.searchParams.get('initData') ?? '';
  const gameId = url.searchParams.get('game') ?? '';
  if (!gameId) { deny(400, 'Missing game'); return; }
  let userId: UserId;
  try { userId = String(verifyInitData(initData, token!).id); }
  catch (e) { deny(401, `initData invalid: ${(e as Error).message}`); return; }
  wss.handleUpgrade(req, socket, head, ws => {
    if (!wsByGame.has(gameId)) wsByGame.set(gameId, new Set());
    wsByGame.get(gameId)!.add(ws);
    const game = db.getGame(gameId);
    if (game) {
      const rule = db.getRule(game.ruleId);
      const players = db.listPlayers(gameId);
      ws.send(JSON.stringify({
        type: 'state',
        snapshot: snapshot(game, rule?.definition, players, userId, false)
      }));
    }
    ws.on('close', () => { wsByGame.get(gameId)?.delete(ws); });
  });
});

server.listen(port, () => console.log(`Mini App listening on :${port}`));
bot.start();

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] ${signal}`);
  try { await bot.stop(); } catch (e) { console.warn('[shutdown] bot.stop:', (e as Error).message); }
  try { wss.close(); } catch { /* ignore */ }
  try { server.close(); } catch { /* ignore */ }
  try { db.close(); } catch { /* ignore */ }
  process.exit(0);
}
process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
process.on('SIGINT', () => { void shutdown('SIGINT'); });
