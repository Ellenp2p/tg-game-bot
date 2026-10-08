# 引擎重构路线图（S0–S6）

> 目标：把规则引擎从 Telegram bot 里彻底解耦，成为**可独立、纯、确定性、事件驱动、可 spec 化回归**的引擎；仓库改为 **monorepo**（`packages/engine` + `packages/bot`）。

## 决策（已定）

| 项 | 决定 |
|---|---|
| 范围 | S0–S6 全做（彻底独立） |
| 打包 | **monorepo**：`packages/engine`（纯，仅依赖 zod）+ `packages/bot`（grammy/DB/WS） |
| golden | **提交进仓库**（`specs/__golden__/`），可 diff |
| spec 种子 | 以 `examples/*.json` 为准（playthrough spec 由示例自动生成） |
| 每步纪律 | 每步都 `build + 全量 spec/单测绿 + 提交`；行为由 golden 守护 |

## 好引擎的判据

1. 确定性（不读 `Date.now()`/随机；时钟与 RNG 注入）
2. 纯（无 DB/网络/定时器/TG）
3. 显式状态（可序列化，无隐藏挂载如 `_players`）
4. 意图驱动（唯一入口 `run(game, intent)`）
5. 事件为真源（完整有序语义事件，可重放）
6. 类型化错误（`{ok:false, code}`，非裸 throw）
7. 通道无关视图（`View` 数据，渲染归适配器）
8. 可 spec 化（声明式场景 + golden）

## 目标分层

```
bot 适配器 (grammy/DB/WS/定时器/HTML/键盘)
  └─ app 应用层 (载入 → run → 持久化 → 投递 → 记事件)
       └─ engine (纯、确定性、零 IO): (Game, Intent) → RunResult
```

## 目标 API（草案）

```ts
run(game: Game, intent: Intent, ctx: EngineCtx): RunResult

type Game = { status: GameStatus; state: GameState; players: Player[] };
type GameState = {
  cursor: { roundIdx: number; stepIdx: number };
  phase: Phase; stepHitCounts; loopCounters; lastRollerId?; lastDice?;
  draws?; results?; lastResultSlot?; activeActorId?;
  // 无 pendingRolls / *MsgId（传输态，属 Session）
};
type Intent =
  | { type:'join'|'leave'|'begin'|'next'|'skip'|'undo'|'end'|'replace'; userId:number }
  | { type:'roll'|'showdownRoll'; userId:number; value:number; emoji:DiceEmoji }
  | { type:'choice'; userId:number; optionIdx:number };
type RunResult =
  | { ok:true; game:Game; events:EngineEvent[]; view:View; effects:Effect[] }
  | { ok:false; error:{ code:EngineErrorCode; text:string } };
type EngineCtx = { definition:RuleDefinition; now:()=>number; rng?:()=>number };
```

---

## 步骤

### S0 — spec runner + golden（不改引擎行为） ✅/⬜

**做**：
- `scripts/spec.ts`：声明式 spec 运行器（纯引擎驱动，无 TG）。
- `specs/*.spec.json`：两类
  - `playthrough`：`{ rule: "examples/NN-*.json", players:[...], policy:{roll:'min',showdown:'min',choice:0,maxSteps:N} }`——**由 examples 自动生成**。
  - `scripted`：显式 `intent` 序列 + `expect`（针对 reroll / draw / 非法操作等）。
- `specs/__golden__/*.trace.json`：录制结果（**不含时间戳**，保证稳定），提交入库。
- CLI：`pnpm spec`（跑+diff）、`pnpm spec --update`（重录）。
- `specs/README.md`：格式说明。

**验收**：`pnpm spec` 全绿；18 个示例 + 盲盒行为被 golden 钉死；改坏引擎会 diff 失败。

**不改**：`src/`（引擎/机器人）。

### S1 — 抽 `packages/engine`（纯搬运 + 注入时钟 + players 显式化）

**做**：monorepo 骨架；`model.ts`/`rules.ts` → `packages/engine/src`；`src/db.ts`/`auth.ts`/`index.ts` → `packages/bot/src`；bot 依赖 `@tg-game/engine`；引擎内 `Date.now()` → `ctx.now()`；去掉 `game._players`；测试与脚本改路径。

**验收**：golden 全绿（行为不变）；bot 构建/启动正常；服务部署正常。

### S2 — `run(game, intent)` 唯一入口

**做**：`packages/engine/src/machine.ts` 实现 `run`（薄壳，内部复用现有 applyX/advanceToStep）；bot 的 handler 改走 `run`；spec runner 改走 `run`。

**验收**：golden 全绿；`index.ts` 里重复编排消失。

### S3 — 事件化（真源 + 可重放）

**做**：`run` 产出完整 `EngineEvent[]`；`app` 层写 `game_events`；`/undo` 改为基于事件的 replay；`replay(initial, events)` 落地。

**验收**：`replay(initial, events) === state`（属性测试）；undo 用 replay 实现且 golden 全绿。

### S4 — 抽 `View`（数据）+ `effects`

**做**：`view.ts` 产出结构化 `View`（phase/round/loop/board/buttons=意图）；bot 只做 `View → HTML + InlineKeyboard`；"发新消息 vs 编辑看板"由 `effects` 驱动；去掉 `renderStatus`/`snapshot` 里的业务判断。

**验收**：群里/私聊/Mini App 显示等价；golden view 序列入库。

### S5 — 传输态外移

**做**：`pendingRolls` / `showdownBoardMsgId` / `signupMsgId` / `waitingMsgId` → `packages/bot/src/session.ts`；`GameState` 变干净；定时器/动画留适配器。

**验收**：golden 全绿；关键字不再出现在引擎状态里。

### S6 — 边界固化 + 收尾

**做**：`packages/engine` 禁止 import `grammy/better-sqlite3/ws/node:http`（import 守卫测试）；`pnpm -r build`/`pnpm -r test`；部署改用 `packages/bot/dist/index.js`；文档更新（本文件 + AGENTS + RULES_AUTHORING）。

**验收**：守卫测试通过；服务器部署成功；README/AGENTS 反映新结构。

---

## 测试体系

| 层 | 内容 | 依赖 |
|---|---|---|
| 单元 | step 处理器 / templates / conditions / drawBucket / replay | 无 |
| Spec + golden | 声明式场景 + 事件/视图序列录制比对 | 无 |
| 属性/fuzz | 随机意图 → 不变量（必终止、`replay(events)===state`、状态合法、仅 expectedPlayer 可 roll） | 无 |
| 适配器烟测 | 假 transport 记录发出的消息/键盘 | 无 TG |

## 迁移纪律

- 先录 golden（S0）再重构；任何一步行为漂移必须由 golden 暴露。
- 每步独立提交，提交信息带 `S<N>`；每步保持 bot 可构建、可部署。
- 不引入 DSL/表达式语言/插件系统；引擎只管"按 JSON 推进的游戏状态机"。

## 进度

- [x] S0 spec runner + golden（39 spec 全绿，`specs/__golden__` 入库）
- [x] S1 monorepo + engine 抽取（`packages/engine` 纯包 / `packages/bot` 适配器；测试归位：engine 86 + bot 43）
- [x] S2 引擎 `run(game, intent, players)` 唯一入口（`machine.ts`；typed 错误 + 语义事件；spec 运行器已改走它；引擎测试 92）
      —— bot 的 handler 收口到 `run` 与后续事件/视图一起做（避免多套路径并存），并入 S3/S4
- [x] S3 事件化（引擎侧）
      - bot **全部**引擎调用收口到 `run()`（12 处，grep 无残留）；typed 错误透传
      - 引擎新增 `replay(makeInitial, def, players, intents)`（同序列必得同局 + 非法意图入 errors），+测试
      - 既有 `game_events` 事件日志保留（undo 依赖其 payload）；「事件落库 + undo 改走 replay」留待后续
- [ ] S4 View 抽取
- [ ] S5 传输态外移
- [ ] S6 边界固化 + 部署
