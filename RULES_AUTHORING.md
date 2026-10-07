# 规则设计指南（给 AI / 设计者）

本指南描述如何为一个「派对主持人机器人」编写规则 JSON。所有规则必须符合当前 schema，否则 `/newrule` 会拒绝。规则以**用户私聊**形式提交，引擎驱动**群聊**对局。

## 版本控制

每条规则必须带 `version` 字段（语义化版本 `MAJOR.MINOR.PATCH`）。**如果省略，引擎默认填入 `CURRENT_RULE_SCHEMA_VERSION` 的值**。

```json
{
  "version": "1.3.0",
  "name": "我的规则",
  ...
}
```

- **MAJOR**：schema 不向后兼容（旧规则必须升级）
- **MINOR**：新增可选字段（旧规则仍可用）
- **PATCH**：纯文档/示例修复

当引擎升级时，旧规则会被照常加载，但任何不支持的字段会被忽略。要迁移旧规则，先读取，再用新版字段重写，把 `version` 改成新版本号。

**当前 `CURRENT_RULE_SCHEMA_VERSION` = `1.5.0`**（新增：`rule.minPlayers` / `rule.maxPlayers` 人数上下限；`step.roll.assignment` 引擎现在会强制校验）

## 顶层结构

```json
{
  "version": "1.5.0",
  "name": "规则名（≤80字）",
  "description": "玩家在 /startgame 选规则时看到的描述（≤500字）",
  "minPlayers": 2,                 // 可选，1-100；本规则最少需要几个人开（默认 2）
  "maxPlayers": 8,                 // 可选，1-100；本规则最多接受几个人报名（默认 8）
  "rounds": [ /* 至少 1 个 round，最多 20 个 */ ]
}
```

**人数约束**：
- 报名时如果 `players.length >= maxPlayers`，新点「加入报名」会被拒（toast「已满员」）
- 管理员点「开始」/ `/begin` 时如果 `players.length < minPlayers`，会拒（toast「至少需要 N 人」）
- `minPlayers` 必须 ≤ `maxPlayers`，否则 schema 拒绝
- 设 `minPlayers: 1` 可以允许单人游戏（如 `examples/09-basketball-tournament.json`）

## Round（轮）

```json
{
  "name": "第一轮 · 真心话",
  "loop": false,                // true = 本轮跑完后回到本轮 step 0；false = 进入下一轮
  "maxLoops": 3,                // 可选，配合 loop:true；本轮最多循环 N 次后退出
  "defaultEmoji": "🎲",         // 可选，本轮所有 roll step 的默认 emoji
  "steps": [ /* 至少 1 个 step，最多 40 个 */ ]
}
```

**循环 vs 不循环**：

- `loop: false`：本轮 steps 全部走完后进入 `rounds[roundIdx+1]`，最后一个 round 走完则对局结束
- `loop: true`（无 `maxLoops`）：本轮 steps 走完后回到本轮 step 0，**永不结束**（除非 `/endgame` 强制终止）
- `loop: true` + `maxLoops: N`：本轮最多循环 N 次。**优先级**：
  1. steps 走完 → 检查 counter：若 < N → 回到 step 0
  2. 若 counter == N → 跳过本轮循环，进入下一轮；如果没有下一轮 → 对局结束
- `maxLoops` 必须是 1-100 之间的整数

## Emoji 三层优先级

每个 roll step 最终用哪个 emoji，按下面顺序取第一个非空值：

```
step.emoji > round.defaultEmoji > rule.defaultEmoji > '🎲'
```

举例：

```json
{
  "name": "保龄球之夜",
  "defaultEmoji": "🎳",         // 整局默认保龄球
  "rounds": [
    {
      "name": "热身",
      "defaultEmoji": "🎲",     // 这一轮全用色子
      "steps": [
        { "type": "roll", "label": "热身" }           // → 🎲（step 没设，用 round）
      ]
    },
    {
      "name": "正式",
      "steps": [
        { "type": "roll", "label": "第一球" },       // → 🎳（round 没设，用 rule）
        { "type": "roll", "label": "最后一球", "emoji": "🎯" }  // → 🎯（step 自己指定）
      ]
    }
  ]
}
```

`rule.defaultEmoji` / `round.defaultEmoji` / `step.emoji` 都必须是 `🎲🎯🏀⚽🎰🎳` 之一，否则 schema 拒绝。

## Step 类型

### 1. `roll`（等待掷骰子）

```json
{ "type": "roll", "label": "🎲 谁来回答真心话", "emoji": "🎲" }
```

- 引擎进入此步后，群里显示：「📍 <轮名> · <label>」+ 「等待 **任一玩家** 发送 <emoji>」
- 玩家在群里发对应表情（系统自带 2 秒动画）→ 3.5 秒后 bot edit 展示结果并自动推进
- 字段：
  - `label`（必填）：本步骤的玩家可读标签
  - `emoji`（可选）：本步骤使用的表情。缺省时按上面三层优先级回退到 `'🎲'`。支持的取值：`🎲 🎯 🏀 ⚽ 🎰 🎳`
    - 各 emoji 的取值范围：🎲/🎯/🎳 都是 1-6；🏀/⚽ 是 1-5；🎰 是 1-64
    - 玩家发错 emoji 或超过取值范围 → 引擎拒绝并提示
  - `assignment`（可选）：`'next_player' | 'self' | 'any'`，默认 `'next_player'`。引擎据此设置 `phase.expectedPlayerId`，不是当前回合的玩家掷 emoji 会被引擎拒绝
    - **`'next_player'`（默认）**：按加入顺序轮换。A 掷完骰子后，B 接力；B 掷完后 C 接力；循环回 A。每个轮 round 起点的初始「第一人」是加入顺序的第一位
    - **`self`**：一直是上一个掷骰子的玩家掷。适合「单人对线」/「独人挑战」类规则
    - **`any`**：任何人可以掷，不锁定。适合「抢答」「自由抢答」类规则

**何时用不同 emoji**：

| Emoji | 取值 | 玩法 |
|---|---|---|
| 🎲 | 1-6 均匀 | 经典色子，最常用 |
| 🎯 | 1-6 均匀（6=靶心） | 「命中数」类玩法 |
| 🏀 | 1-5 均匀 | 篮球主题 |
| ⚽ | 1-5 均匀 | 足球主题 |
| 🎰 | 1-64 — **见下面「老虎机解码」** | 抽奖/老虎机 |
| 🎳 | 1-6 均匀 | 保龄球主题 |

**公平性**：所有 6 个 emoji 都是均匀分布（服务端 PRNG），没有权重、没有房间优势。引擎 `applyRoll` 会校验 emoji 必须匹配 `phase.emoji`，值必须在 `DICE_EMOJI_MAX_VALUE[emoji]` 范围内。

**轮换机制详解（`assignment: 'next_player'`）**：

引擎内部维护一个 `state.lastRollerId`（谁最近掷过骰子），每次进入 roll 步骤时用 `nextRollerId(players, lastRollerId)` 算出下一个玩家：

```
nextRollerId([A, B, C], null)   → A   // 第一轮起点：加入顺序的第一位
nextRollerId([A, B, C], A)       → B
nextRollerId([A, B, C], C)       → A   // 循环
nextRollerId([A], anything)      → A   // 单人场：一直是这个人
nextRollerId([], anything)       → null // 没人，锁空（应该在报名阶段已被挡）
```

**什么时候轮到 choice 阶段**：

- 上一个 `roll` 阶段掷出 🎲 的那个人会被记到 `phase.pickedBy`
- choice 阶段只有 `pickedBy` 可以选；其他玩家误点 → toast「不是你的回合」
- choice 之后无论选什么，`state.lastRollerId` 都会更新成选 choice 的那个人 — 也就是说**下一个 roll 步骤默认会让 choice 的玩家继续掷**（除非用 `assignment: 'next_player'` 强制轮换）

## 🎰 老虎机（🎰）解码

Telegram 的 `🎰` 看起来返回 1-64 的"分数"，但**实际是 3 个独立 reel 打包成一个数**。每个 reel 4 个符号：

```
reel1 ∈ {BAR, 🍓, 🍋, 7}      ← 决定 value 的高位
reel2 ∈ {BAR, 🍓, 🍋, 7}      ← 中位
reel3 ∈ {BAR, 🍓, 🍋, 7}      ← 低位

value = (r1-1) * 16 + (r2-1) * 4 + r3
       r1 = Math.floor((value - 1) / 16) + 1
       r2 = Math.floor(((value - 1) % 16) / 4) + 1
       r3 = ((value - 1) % 4) + 1
```

**重要事实**（实测验证）：
- 64 个 value **完全均匀**，每个 1/64 ≈ 1.56%
- **JACKPOT = 3 个 reel 相同**，即 value ∈ {1, 22, 43, 64}，概率 = **4/64 = 6.25%**（不是 1/64）
- 三条 7、三条 🍋、三条 🍓、三条 BAR **出现概率完全相同**

引擎内置 `decodeSlotValue(value)` (`src/model.ts`) 返回 `{ r1, r2, r3, jackpot }`，每次 🎰 roll 后自动调用：

- 群里 `/status` 的「上次：」行会显示 `→ 64 (7 7 7 · 🎉 JACKPOT)`
- Mini App 实时视图同样展示
- `snapshot.lastDice.decoded` 暴露给前端

**示例规则**（`examples/10-slot-machine-jackpot.json`）：3 轮内抽中 jackpot 的人获胜。ladder 第 1 次执行命中 jackpot 就给奖励，其他 60 种杂花落到默认「喝一口」。

**如果你想写"第一个 reel 是 7 才给奖励"这种规则**，目前的 schema 还不直接支持（`punish.ladder` 只按执行次数递进）。要支持的话需要扩展 schema，比如：

```jsonc
{
  "type": "punish",
  "label": "...",
  "defaultText": "...",
  "ladder": [ /* 原来的按次数 ladder */ ],
  "when": [                    // 新增：基于本次 roll 的花色
    { "if": { "reel": 1, "symbol": "seven" }, "text": "第一个是 7：喝一杯" },
    { "if": { "reel": 2, "symbol": "lemon" }, "text": "中间是 🍋：你选惩罚" },
    { "if": "jackpot", "text": "三条相同：MVP！" }
  ]
}
```

如果想做这种「基于花色」的规则，告诉我，我加进 schema。
| 🎳 | 保龄球 1-6 |

### 2. `text`（文本提示）

```json
{
  "type": "text",
  "label": "回答真心话",
  "prompt": "选一个问题回答：\n1. 你最近撒的最大的谎是什么？\n2. 你暗恋过谁？",
  "mode": "manual"  // 当前引擎只支持 manual
}
```

- 引擎进入此步后，群里显示：步骤 label + prompt 内容
- 玩家**口头**回答（在群聊里发消息），**管理员**点「下一步」或 `/next` 才推进
- `mode: 'auto'` 当前**未实现**，所有 text 都是 manual

### 3. `punish`（惩罚）

```json
{
  "type": "punish",
  "label": "接受惩罚",
  "defaultText": "喝一小口",
  "ladder": [
    { "at": 2, "text": "喝一口" },
    { "at": 4, "text": "喝一杯" },
    { "at": 6, "text": "喝两杯" }
  ]
}
```

- 进入此步时，引擎根据 `stepHitCounts[key]` 选**最大满足 `at <= hitCount`** 的 ladder 项作为文案；没有就 fallback 到 `defaultText`
- 每次进入 punish 步骤，`hitCount` 自增 1（同一轮循环里 hitCount 会持续累加）
- 管理员点「下一步」或 `/next` 推进
- **配合 `loop: true`** 用：每轮循环 punish 的文案会越来越狠

### 4. `choice`（玩家二选一/多选一）★ 新增

```json
{
  "type": "choice",
  "label": "选择命运",
  "prompt": "掷到你啦，选一个：",
  "options": [
    { "text": "回答真心话", "goto": "next" },
    { "text": "接受惩罚", "goto": { "roundIdx": 0, "stepIdx": 2 } }
  ]
}
```

- 引擎进入此步后，群里显示：「📍 选择命运」+ 选项列表 + 每个选项对应一个 inline 按钮
- 只有 **`phase.pickedBy` 指定的那个玩家**才能点（通常是上一个 `roll` 掷出 🎲 的玩家）
- 其他玩家点 → toast「不是你的回合」
- 管理员点 `/next` → **强制选第一个选项**（防止玩家挂机）
- `goto` 两种形式：
  - **`"next"`**（字符串字面量）：跳到 `stepIdx + 1`，最常用
  - **`{ "roundIdx": N, "stepIdx": M }`**：跳到任意坐标，用于跳过中间步骤（比如选「惩罚」直接跳到 punish 跳过 text）

**典型用法**：在 `roll` 之后插入 `choice`，让玩家决定走 `text` 还是直接 `punish`。

## 完整示例：真心话大冒险

```json
{
  "version": "1.2.0",
  "name": "真心话大冒险",
  "description": "经典派对游戏。色子决定谁来答题，玩家在 choice 阶段二选一答或罚。",
  "rounds": [
    {
      "name": "第一轮 · 真心话",
      "loop": false,
      "steps": [
        { "type": "roll", "label": "🎲 谁来回答真心话" },
        {
          "type": "choice",
          "label": "选择命运",
          "options": [
            { "text": "回答真心话", "goto": "next" },
            { "text": "接受惩罚", "goto": { "roundIdx": 0, "stepIdx": 2 } }
          ]
        },
        {
          "type": "text",
          "label": "回答真心话",
          "prompt": "选一个问题回答：\n1. 你最近撒的最大的谎是什么？\n2. 你暗恋过谁？\n3. 你做过最尴尬的事？"
        },
        {
          "type": "punish",
          "label": "接受惩罚",
          "defaultText": "喝一小口",
          "ladder": [
            { "at": 2, "text": "喝一口" },
            { "at": 4, "text": "喝一杯" },
            { "at": 6, "text": "喝两杯" }
          ]
        }
      ]
    },
    {
      "name": "第二轮 · 大冒险（循环）",
      "loop": true,
      "steps": [
        { "type": "roll", "label": "🎲 谁做大冒险" },
        {
          "type": "choice",
          "label": "选择命运",
          "options": [
            { "text": "做大冒险", "goto": "next" },
            { "text": "接受惩罚", "goto": { "roundIdx": 1, "stepIdx": 2 } }
          ]
        },
        {
          "type": "text",
          "label": "做大冒险",
          "prompt": "选一个任务完成：\n· 学一种动物叫\n· 跳舞 30 秒\n· 模仿表情包"
        },
        {
          "type": "punish",
          "label": "没完成？惩罚升级",
          "defaultText": "做 5 个俯卧撑",
          "ladder": [
            { "at": 2, "text": "做 10 个俯卧撑" },
            { "at": 4, "text": "原地跑 30 秒" },
            { "at": 6, "text": "表演一段 B-box" }
          ]
        }
      ]
    }
  ]
}
```

## 设计模式速查

### 模式 A：色子决定惩罚等级（不需要 choice）

```json
{ "type": "roll", "label": "🎲 掷色子" },
{ "type": "punish", "label": "接受惩罚",
  "defaultText": "喝一口",
  "ladder": [
    { "at": 1, "text": "喝一口" },
    { "at": 4, "text": "喝两杯" },
    { "at": 6, "text": "喝一瓶" }
  ]
}
```
→ 玩家掷色子 → 直接进入 punish，但 punish 文案不依赖色子值，需要配合其他机制（或者让玩家自己宣布）

### 模式 B：真心话或大冒险（用 choice 拆二选一）

```json
{ "type": "roll" },                      // 谁被选中
{ "type": "choice", "options": [         // 玩家二选一
    { "text": "真心话", "goto": "next" },
    { "text": "大冒险", "goto": { "roundIdx": 0, "stepIdx": 3 } }
]},
{ "type": "text", "prompt": "真心话问题..." },     // step 2：真心话
{ "type": "text", "prompt": "大冒险任务..." },     // step 3：大冒险
{ "type": "punish", "defaultText": "喝一口" }      // step 4：公共惩罚
```

### 模式 C：循环升级惩罚

```json
{ "name": "惩罚轮", "loop": true, "steps": [
  { "type": "roll" },
  { "type": "text", "prompt": "完成任务了吗？" },
  { "type": "punish", "defaultText": "做 5 个俯卧撑",
    "ladder": [
      { "at": 2, "text": "做 10 个俯卧撑" },
      { "at": 5, "text": "做 20 个俯卧撑" }
    ]
  }
]}
```
→ 每次进入 punish hitCount+1，循环里持续升级

### 模式 D：纯问答（无色子）

```json
{ "name": "问答", "loop": false, "steps": [
  { "type": "text", "prompt": "问题 1：..." },
  { "type": "text", "prompt": "问题 2：..." },
  { "type": "text", "prompt": "问题 3：..." }
]}
```
→ 管理员每答完一题就 `/next`，简单到极致

## 操作矩阵（设计时要考虑）

| 谁能做 | 操作 | 触发 |
|---|---|---|
| 玩家 | 发 🎲 表情 | roll 阶段 |
| 玩家 | 点 choice 按钮 | choice 阶段（必须是 pickedBy） |
| 玩家 | 群里发言 / /joingame / /leavegame | 报名阶段 |
| 管理员 | `/startgame` `/begin` `/next` `/skip` `/undo` `/endgame` | 全程 |
| 任何人 | `/status` `/play` | 全程（不改变状态） |

## 提交方式（用户视角）

1. 用户**私聊**机器人：`/newrule`
2. 机器人回复「请发 JSON」
3. 用户**单独一条消息**发完整 JSON
4. 机器人解析 → zod 校验 → 存入 db → 回复「已创建规则 `<id8>`」
5. 任何群里 `/startgame` 即可选用此规则

**编辑**：`/editrule <id8>` → 重新发 JSON → 覆盖更新

## 引擎已知限制（写规则时要避开）

1. **text 阶段没有 auto 模式**：必须管理员手动 `/next`
2. **choice 选项里不能引用其他 step 的 label**：goto 只能用坐标或 `'next'`
3. **punish ladder 只能升级不能降级**：hitCount 单调递增
4. **`/undo` 不能跨 choice 跳转回更早的 step**（只能撤销最近一个事件）
5. **`assignment` 只控制 roll 阶段**：choice / text / punish 阶段没有「轮到谁」的概念（`pickedBy` 在 choice 时才有意义）

## AI 设计规则时的自检清单

设计完一条规则后，问自己：

1. **每个 round 至少 1 个 step**？✓
2. **`minPlayers` 和 `maxPlayers` 是否合理**？一般 2-10，避免过小或过大
3. **没有空 `goto`**？所有 choice 的 option 都有 goto
4. **loop: true 的 round 是否真的想无限循环**？否则会卡住；如果想循环 N 次一定写 `maxLoops`
5. **punish ladder 是否按 at 升序**？引擎按 `at <= hitCount` 取最大，所以乱序也能工作，但为了可读性建议升序
6. **text 步骤是否依赖前面的色子/选择**？如果是，需要配合 choice 在前面
7. **choice 选项的 goto 是否都指向有效坐标**？比如 `{ "roundIdx": 0, "stepIdx": 5 }` 但 round 只有 4 个 step → 会越过 round 边界进入下一轮（这是允许的，但要确认意图）
8. **规则总步数 ≤ 40 × 20 = 800**？超过会被 zod 拒绝
9. **version 字段是否填了当前引擎的 CURRENT_RULE_SCHEMA_VERSION（1.5.0）**？不填会被填默认值，但显式填更好
10. **`step.roll.assignment` 是否考虑过**？默认 `next_player` 适合绝大多数规则；`self` 适合独人挑战；`any` 适合抢答

## 完整示例库

参考 `examples/` 目录：

- `01-truth-or-dare.json` — 真心话大冒险（roll → choice → text/punish）
- `02-dice-punishment.json` — 色子惩罚
- `03-riddle-chain.json` — 谜语链
- `04-quiz-trivia.json` — 问答

## 字段约束速查

| 字段 | 类型 | 必填 | 范围 |
|---|---|---|---|
| `version` | string | 否（默认 `CURRENT_RULE_SCHEMA_VERSION`） | 语义化版本 `X.Y.Z` |
| `name` | string | 是 | 1–80 字 |
| `description` | string | 否（默认空串） | 0–500 字 |
| `minPlayers` | int | 否（默认 2） | 1–100（且 ≤ maxPlayers） |
| `maxPlayers` | int | 否（默认 8） | 1–100（且 ≥ minPlayers） |
| `defaultEmoji` | enum | 否 | `🎲`/`🎯`/`🏀`/`⚽`/`🎰`/`🎳` |
| `rounds` | array | 是 | 1–20 项 |
| `round.name` | string | 是 | 1–80 字 |
| `round.loop` | boolean | 否（默认 false） | — |
| `round.maxLoops` | int | 否 | 1–100 |
| `round.defaultEmoji` | enum | 否 | `🎲`/`🎯`/`🏀`/`⚽`/`🎰`/`🎳` |
| `round.steps` | array | 是 | 1–40 项 |
| `step.type` | enum | 是 | `roll`/`text`/`punish`/`choice` |
| `step.label` | string | 是 | 1–200 字 |
| `roll.emoji` | enum | 否（默认 `🎲`） | `🎲`/`🎯`/`🏀`/`⚽`/`🎰`/`🎳` |
| `roll.assignment` | enum | 否（默认 `next_player`） | `next_player`/`self`/`any` |
| `text.prompt` | string | 否 | 1–1000 字 |
| `text.mode` | enum | 否 | `manual`（默认）/`auto` |
| `punish.defaultText` | string | 是 | 1–500 字 |
| `punish.ladder` | array | 否（默认空） | 0–N 项 `{ at: 1–1000, text: 1–500 }` |
| `choice.prompt` | string | 否 | 0–500 字 |
| `choice.options` | array | 是 | 2–6 项 |
| `option.text` | string | 是 | 1–80 字 |
| `option.goto` | union | 是 | `"next"` 或 `{ roundIdx: ≥0, stepIdx: ≥0 }` |

### Emoji 取值范围

| Emoji | 取值范围 | 用途 |
|---|---|---|
| 🎲 | 1–6 | 经典色子 |
| 🎯 | 1–6 | 飞镖 |
| 🏀 | 1–5 | 篮球 |
| ⚽ | 1–5 | 足球 |
| 🎰 | 1–64 | 老虎机（高方差抽奖） |
| 🎳 | 1–6 | 保龄球 |

## 标准 Phase UI

写规则时**不用关心 UI**，每个 phase 在群里/私聊/Mini App 都有统一的展示。引擎按当前 `phase.kind` 自动渲染对应的消息 + 按钮：

| Phase | 群里显示 | 按钮（inline） |
|---|---|---|
| `signup`（0 人） | `⏳ 等待开局\n已 /startgame，但还没有玩家加入…` | 无 |
| `signup`（N 人） | `🎲 报名中（N 人）` + 玩家列表 | 在另一条 `renderSignupPage` 消息里有 `加入/退出报名/开始` |
| `roll` | `📍 <轮名> · <label>` + `等待 <谁> 发送 <emoji>` + 上次掷骰结果 | 无（让玩家发 emoji） |
| `text` | `📍 <轮名> · <label>` + `prompt` 内容 | `[下一步] [跳过]` |
| `punish` | `📍 <轮名> · <label>` + `🎯 惩罚：<text>（第 N 次）` | `[下一步] [跳过]` |
| `choice` | `📍 <轮名> · <label>` + `请选择：\n1. <optA>\n2. <optB>` | 每个 option 一个按钮（pickedBy 校验） |
| `ended` | `🏁 对局已结束` + 最后一帧信息 | 无 |

**自动推进规则**：任何 phase 切换后引擎自动发送新状态消息，不用规则作者写。

| 触发动作 | 之后自动展示 |
|---|---|
| `/joingame` `/leavegame` | refreshSignupMessage（更新报名列表） |
| `/begin`（点按钮） | 切换到第 1 步第 1 阶段的 status |
| 玩家发 emoji（roll 阶段） | resultMessage + 新 phase 的 status |
| `/next` `/skip`（管理员命令或按钮） | 新 phase 的 status（带新按钮） |
| `/undo` | 回到上一步的 status |
| `/endgame` | `🏁 对局已结束。` |
| 玩家点 choice 按钮 | resultMessage + 新 phase 的 status |
| `/status` 命令 | 主动查询当前 phase 的 status |

**按钮的权限**：所有 inline 按钮点了都会带 `ctx.from.id`，服务端校验：
- `[下一步] [跳过]` 必须群管理员（`doAdmin` 校验）
- `[pickChoice]` 必须 `phase.pickedBy === null || phase.pickedBy === ctx.from.id`（避免别人误选）
- `[加入] [退出报名]` 必须未加入/已加入
- `[开始]` 必须群管理员 + 至少 1 个玩家
- `[撤销] [结束]` 必须群管理员（命令 `/undo` `/endgame`，暂未做按钮版）

**规则作者的约定**：
- 写 JSON 时只关心 `step.label` 和 `step.prompt` / `punish.defaultText` / `choice.options` 这些**内容字段**
- 不要试图通过 label 控制按钮（按钮由 `phase.kind` 自动决定）
- 想做"按顺序轮到某玩家才能选" → `step.roll.assignment: 'next_player'`（引擎强制校验；其他人掷会收到「不是你的回合，请等待系统指定玩家」toast）
- 想做"任何人抢答" → `step.roll.assignment: 'any'`
- 想做"独人掷骰" → `step.roll.assignment: 'self'`
