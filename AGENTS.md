# 项目说明（公共文档）

## 项目概要

Telegram 群内游戏主理人 bot（grammy + better-sqlite3 + 原生 ws）。

- 数据：SQLite (`./data/bot.sqlite`)
- 入口：bot 命令（私聊管规则 / 群内开对局）+ Mini App 实时视图
- 群内流程：管理员 `/startgame` 选规则 → 玩家 `/joingame` 报名 → `/begin` 开局 → 玩家掷色子/做选择 → 管理员 `/next`/`/skip`/`/undo`/`/endgame`
- 规则设计：见 [`RULES_AUTHORING.md`](RULES_AUTHORING.md)；模板见 [`examples/`](examples/)；schema 真源 `packages/engine/src/model.ts` 的 `CURRENT_RULE_SCHEMA_VERSION`

## 仓库结构（monorepo）

```
packages/engine/   纯规则引擎（只依赖 zod）：schema / 状态机 / step 处理器 / 模板
  src/model.ts     schema + 类型 + 常量（CURRENT_RULE_SCHEMA_VERSION）
  src/rules.ts     引擎逻辑（beginGame/applyRoll/applyShowdownRoll/advanceToStep…）
  test/            纯引擎单测（不碰 TG/DB）
packages/bot/      Telegram 适配器（grammy / better-sqlite3 / ws）
  src/index.ts     命令 / 回调 / 骰子 handler / HTTP+WS / 渲染
  src/db.ts        持久化
  test/            含 DB 的集成测试
specs/             声明式场景 + golden（`pnpm spec`，见 specs/README.md）
scripts/           spec 运行器 / 生成器
examples/          规则模板（18 条）
```

**命令**（根目录）：
- `pnpm build` — `pnpm -r build`（先 engine 后 bot）
- `pnpm test` — 单测（engine + bot）+ `pnpm spec`
- `pnpm spec` / `pnpm spec --update` — 跑 / 重录 golden
- `pnpm dev` — tsx watch（bot）
- 部署：`node packages/bot/dist/index.js`（systemd 的 ExecStart 已指向该路径）

引擎重构路线图见 [`ENGINE_ROADMAP.md`](ENGINE_ROADMAP.md)。


## bot 命令语义

### /startgame 多次发 = 覆盖

如果群里已有进行中的对局，再发 `/startgame` 会**直接结束旧对局**（记 `replace` event，status='ended'）并继续弹规则选择。旧 view 端（Mini App）会通过 WebSocket 收到 ended 状态自动收尾。

### Mini App 入口

- **群里**：inline url button 指向 `https://t.me/<bot>/<APP_SHORT_NAME>?startapp=game_<gameId>`。Telegram 自动按 Mini App 打开（不走浏览器）。
- **私聊**：webApp button 用 `PUBLIC_URL/?game=<gameId>`，全屏内嵌。
- **Menu Button**：启动时 `setChatMenuButton` 配置，私聊左侧栏固定入口。
- 前端 `app.js` 从 `?game=` 或 `tg.initDataUnsafe.start_param=game_<id>` 解析 gameId。

### 命令清单

- 私聊：`/start /help /newrule /editrule /rules /rule /deleterule /cancel`
  - `/rules` 打开**按钮式规则面板**（分页列表 → 详情 → 编辑/删除/查看 JSON），`/start` 也有入口按钮；所有命令依旧可用
  - 创建/编辑规则时，除了**粘贴 JSON 文本**，也可**直接发送 `.json` 文件**（走 `getFile` 下载 → 同一套 zod 校验；长规则用文件，绕过 Telegram 4096 字符消息上限）
- 群内：`/startgame /joingame /leavegame /begin /next /skip /undo /endgame /status /play`

## 调试技巧

- **真不知道 bot 收到没**：临时在 `bot.use(async (ctx, next) => { console.log('[upd]', ctx.update.update_id); await next(); })` 加一行，看 `[upd]` 出现没。
- **handler 跑没跑**：在 handler 第一行 `console.log('entered')`，配合 `journalctl -u tg-game-bot -f` 实时看。
- **BUTTON_TYPE_INVALID**：群里 inline 不能用 webApp button，必须用 url + t.me deeplink。
- **群命令静默 no-op**：八成是 `message:text` filter 注册顺序问题——`bot.on('message:text')` 必须在所有 `bot.command(...)` **之后**注册，否则它会断 chain。

## 数据存储

SQLite 文件位置（默认）：`./data/bot.sqlite`（WAL 模式）。`.gitignore` 已忽略 `data/` 和 `.env`。

- 不存任何 Telegram 用户名、群名、消息内容、媒体
- 只存：`user_id`、规则 JSON、游戏状态、游戏 events（动作流，不含聊天原文）

## 已知坑（不要重蹈）

- **不要给 `bot.use(...)` 加非 async 中间件**——grammy v1 要求 async，同步 return Promise 会断 chain
- **不要在 `bot.on('message:text', ...)` 里不调 `next()` 就 return**——它在所有 command 之前注册时会把整个 command chain 截断
- **bot handler throw 必须给用户回消息**——消息用 `ctx.reply`，callback 用 `ctx.answerCallbackQuery({ show_alert: true })`。否则用户看到「没反应」。

## 规则设计（AI 翻译用 → JSON）

> 任务：给定人类可读的规则描述，输出符合 schema 的 JSON。
> 工作流：先读 [`RULES_AUTHORING.md`](RULES_AUTHORING.md)（完整 schema + step 类型 + AI 自检清单），再扫 [`examples/`](examples/)（18 个现成模板覆盖 1/2/N 人 / 单轮循环 / 多轮升级 / 选择岔路 / 篮球足球老虎机 / 真心话大冒险 / 全员比大小 / 按点数分支 / 抽签）。

### 入口三件套

| 文件 | 何时读 |
|---|---|
| [`RULES_AUTHORING.md`](RULES_AUTHORING.md) | **必读**。schema 字段约束、step 类型细节、AI 自检清单、已知引擎限制、🎰 抽签策略、**平台 vs 规则归因判据** |
| [`examples/README.md`](examples/README.md) | 18 个规则的表格（人数 / 用到的特性），找最相近的模板 |
| [`examples/*.json`](examples/) | 复制最相近的模板改写，保留 `version: "1.8.0"` |

### 关键 schema 速记

- 引擎当前 `CURRENT_RULE_SCHEMA_VERSION` = `1.8.0`
  - 顶层：`name` / `description` / `minPlayers`(1-100, 默认 2) / `maxPlayers`(1-100, 默认 8) / `rounds[]`
  - `round`：`name` / `loop` / `maxLoops`(1-100, loop=true 时) / `defaultEmoji` / `steps[]`
  - `step` 六种：`roll` / `text` / `punish` / `choice` / `showdown` / `branch`
    - `roll`：`label` / `emoji`(🎲 🎯 🏀 ⚽ 🎰 🎳) / `assignment`(next_player/self/any/winner/loser/actor，默认 next_player) / `actorSlot`
    - `text`：`label` / `prompt` / `mode`(manual，默认) / `showActor`
    - `punish`：`label` / `defaultText` / `ladder[{at, text}]` / `showActor`
    - `choice`：`label` / `prompt` / `options[{text, goto}]` / `chooser`(last_roller/winner/loser/actor/any) — `goto` 是 `"next"` 或 `{roundIdx, stepIdx}`
    - `showdown`（全员比大小）：`label` / `emoji` / `order`(high/low/none) / `tie`(keep/first/**reroll**) / `as`(结果槽名) / `accumulate` / `actor`(winner/loser/none)；并列时选人按名次顺序（与看板一致）
    - `branch`（条件跳转）：`label` / `cases[{if, goto}]` / `default` / `maxHits`；`if` 支持 tie/unique/any/all/rank/sum/count/**dice**（最近一次单掷点数）
    - `roll.draw`（N 选一抽签）：`count`(2-64) / `targets[count 个 goto]` / `store` / `uniform`(equal/exact)；`goto` 与 `text`/`punish` 的 `next` 都支持 `"end"`（结束当前轮）
  - 文案占位符：`{winner}` `{loser}` `{ranking}` `{rank1}` `{rank-1}` `{sum}` `{max}` `{min}` `{count}` `{actor}` `{dice}` `{roller}` `{draw}`，命名槽写法 `{score.winner}` `{draw.box}`
- emoji 取值范围：🎲🎯🎳=1-6；🏀⚽=1-5；🎰=1-64
- 引擎用 `state.lastRollerId` + `nextRollerId()` 自动轮换（assignment=next_player），单人场永远轮到自己
- `showdown` 全员各掷一次后自动排序；结果存命名槽并可用 `{...}` 引用；`branch` 按条件跳转
- 需要「N 选一」抽签（N ≤ 64）：用 🎰(1–64) + `branch` 的 `dice` 阈值分段，见 RULES_AUTHORING.md「🎰 抽签策略」

### 修改 `CURRENT_RULE_SCHEMA_VERSION` 时

- 改 `src/model.ts` 的 `CURRENT_RULE_SCHEMA_VERSION`
- **必须同步改 [`RULES_AUTHORING.md`](RULES_AUTHORING.md)** 的「顶层结构」「字段约束速查」「AI 自检清单」三处
- 改 [`examples/*.json`](examples/) 整批版本号 + 把新字段补上
- 跑 `pnpm run test` 验证 `test/all-examples.test.ts` 还过