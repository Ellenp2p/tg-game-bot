# 规则模板

每个 `.json` 都是一个完整规则。私聊机器人发 `/newrule`，把 JSON 内容粘进去（或直接把 `.json` 文件发过去）即可（`name` 字段建议写，规则列表用它显示）。

完整设计指南见根目录 [`RULES_AUTHORING.md`](../RULES_AUTHORING.md)。本目录只列示例。

## 步骤类型速查

| 类型 | 触发 | 推进方式 |
|---|---|---|
| `roll` | 玩家发指定 emoji（默认 🎲，可选 🎯🏀⚽🎰🎳） | 3.5 秒后自动推进 |
| `text` | 显示 prompt | 管理员 `/next` 或 Mini App「下一步」 |
| `punish` | 显示惩罚（支持 ladder 升级） | 管理员 `/next` |
| `choice` | 显示选项按钮 | 玩家点按钮（或管理员 `/next` 强制选第一个） |
| `showdown` | 全员各发一次指定 emoji | 全员集齐自动结算（或管理员 `/next` 强制结算） |
| `branch` | 进入即求值 | 自动跳转（不等待） |

## 字段约束速查

完整约束看 `RULES_AUTHORING.md`。这里只列常用：

```json
{
  "version": "1.7.0",              // 可省略，自动填当前 CURRENT_RULE_SCHEMA_VERSION
  "name": "规则名（必填）",
  "description": "简介（可选）",
  "defaultEmoji": "🎲",            // 可选，整局默认表情（被 round/step 覆盖）
  "rounds": [
    {
      "name": "轮次名",
      "loop": false,               // true = 本轮跑完回到本轮 step 0
      "maxLoops": 3,               // 可选，loop=true 时循环 N 次后结束；不写=无限
      "defaultEmoji": "🎰",        // 可选，本轮默认表情
      "steps": [
        { "type": "roll", "label": "短描述", "emoji": "🏀" },
        { "type": "text", "label": "短描述", "prompt": "详细提示" },
        {
          "type": "punish",
          "label": "短描述",
          "defaultText": "默认惩罚",
          "ladder": [
            { "at": 2, "text": "第 2 次的惩罚" },
            { "at": 5, "text": "第 5 次的惩罚" }
          ]
        },
        {
          "type": "choice",
          "label": "二选一",
          "options": [
            { "text": "选项 A", "goto": "next" },
            { "text": "选项 B", "goto": { "roundIdx": 0, "stepIdx": 2 } }
          ]
        }
      ]
    }
  ]
}
```

## 升级惩罚（ladder）

`ladder` 是按执行次数递进的惩罚列表。当该步骤第 N 次被执行时：
- 找到 `at <= N` 中最大的那条，用它的 `text`
- 没找到任何一条时用 `defaultText`

所以默认是第一次，反复触发后会升级。配合 `loop: true` 用效果最佳。

## 循环轮（loop）

- `loop: false` — 该轮跑完所有 step 后进入下一 round（最后一个 round 跑完则对局结束）
- `loop: true` — 该轮跑完后从头再跑，配合 `maxLoops` 可控循环次数
  - `maxLoops` 缺省：永不结束（除非管理员 `/endgame`）
  - `maxLoops: N`：跑满 N 次后跳出，进入下一 round；最后一个 round 跑满则对局结束
- 适合"每人轮一遍"的玩法

## choice 步骤

让玩家二选一或多选一。每个 option 必须有 `goto`：
- `"next"` — 跳到下一步
- `{ "roundIdx": N, "stepIdx": M }` — 跳到任意坐标

只有上一个 `roll` 掷出 🎲 的玩家才能点（`phase.pickedBy`）。其他人误点会弹 toast。可用 `chooser` 改成"赢家/输家/主角"来点。

## showdown 步骤（全员比大小）

```json
{ "type": "showdown", "label": "全体比大小", "order": "high", "tie": "first", "as": "rank", "actor": "loser" }
```

- 进入后发一条看板：`✅ 已掷 ... / ⏳ 未掷 ...`，之后编辑同一条
- 每位玩家各发一次指定 emoji；全员掷完自动排序结算
- 结果存进命名槽（`as`，默认 `last`），后续文案可用 `{winner}` `{loser}` `{ranking}` `{rank1}` `{score.winner}` 等占位符
- `order`: `high` 比大 / `low` 比小 / `none` 只收集
- `accumulate: true` 把多局分数累加（积分赛）
- `actor`: 结算后把主角设为 `winner`/`loser`，配合 `roll.assignment`/`choice.chooser` 让赢家/输家继续操作

## branch 步骤（条件跳转）

```json
{ "type": "branch", "label": "判定", "cases": [
  { "if": { "check": "any", "slot": "rank", "value": 6 }, "goto": { "roundIdx": 0, "stepIdx": 4 } },
  { "if": "tie", "goto": "next" }
], "default": "next" }
```

条件见根目录 `RULES_AUTHORING.md` 第 6 节（`tie`/`unique`/`any`/`all`/`rank`/`sum`/`count`/`dice`）。

## 抽签（roll.draw）与结束本轮（goto "end"）

给 `roll` 挂 `draw` 就能"抽 N 选一"：掷完骰子按点数落到 `1..count` 号，跳到 `targets[号-1]`。

```json
{ "type": "roll", "label": "抽奖", "emoji": "🎰", "draw": {
  "count": 16, "uniform": "exact", "store": "box",
  "targets": [ "next", "next", /* …共 16 项… */ "end" ]
}}
```

- `targets` 长度必须 = `count`（2–64）；每项支持 `"next"` / `"end"` / `{roundIdx,stepIdx}`
- 抽中编号：`{draw}`；命名槽：`{draw.box}`
- `uniform`：`equal`（默认，等距分段）/ `exact`（拒绝重掷，严格均匀）
- `goto` 和 `text`/`punish` 的 `next` 都支持 **`"end"`**（结束当前轮）

## 已有模板

| 文件 | 玩法 | 人数 | 用到的特性 |
|---|---|---|---|
| `01-truth-or-dare.json` | 真心话大冒险 | 2-8 | choice（答 or 罚）+ 双轮 + maxLoops=8 + step.emoji |
| `02-dice-punishment.json` | 骰子惩罚（单轮循环） | 2-10 | ladder 6 级 + round.defaultEmoji=🎲 + maxLoops=12 |
| `03-riddle-chain.json` | 谜语接龙 | 4-8 | 双轮（热身 + 循环）+ ladder 升级 + maxLoops=10 |
| `04-quiz-trivia.json` | 知识抢答（纯问答） | 2-12 | 无色子、纯 text/punish + maxLoops=8 |
| `05-idiom-chain.json` | 成语接龙 | 4-8 | 单轮循环 + text + ladder + rule.defaultEmoji=🎲 + maxLoops=15 |
| `06-drinking-wheel.json` | 喝酒转盘 | 2-12 | choice（喝 or 逃）+ ladder 6 级 + rule.defaultEmoji=🎲 + maxLoops=10 |
| `07-story-chain.json` | 故事接龙 | 3-6 | 双轮（开场 + 循环）+ text-heavy + maxLoops=12 |
| `08-charades.json` | 你说我猜 | 4-8 | 多 choice + 多 round + 跨 step goto + maxLoops=8 + rule.defaultEmoji=🎲 |
| `09-basketball-tournament.json` | 篮球三连冠 | 1-8 | rule.defaultEmoji=🏀 + maxLoops=8 + ladder 1-3 分 |
| `10-slot-machine-jackpot.json` | 老虎机 JACKPOT | 2-8 | rule.defaultEmoji=🎰 + maxLoops=3 + ladder 命中 jackpot 即胜 |
| `11-solo-truth.json` | 单人真心话 | 1 | roll 选题 + choice 答 or 罚 + ladder 升级 + maxLoops=20 |
| `12-solo-dice-challenge.json` | 单人骰子挑战 | 1 | roll + ladder 6 级 + maxLoops=10 |
| `13-solo-riddle.json` | 单人谜语闯关 | 1 | text 出题 + choice 答 or 罚 + ladder 升级 + maxLoops=5 |
| `14-showdown-duel.json` | 比大小·输家喝 | 2-10 | showdown + 模板占位符 + branch 条件跳转 + maxLoops=5 |
| `15-showdown-series.json` | 三局积分·最低分喝 | 2-8 | showdown accumulate 积分 + 命名结果槽 + 跨轮引用 |
| `16-showdown-chooser.json` | 比大小·赢家点菜 | 2-8 | showdown actor=winner + choice chooser=winner + branch 收尾 |
| `17-dice-branch-board.json` | 掷骰子走格子 | 2-8 | branch 的 dice 条件（按单掷点数分支）+ 模板 {dice}/{roller} |
| `18-draw-lucky.json` | 十六格抽奖 | 2-8 | `roll.draw` 抽签（16 格均匀）+ `goto:"end"` + `text.next` |

复制任一文件，改 `name`、改 `description`、改具体文案就能用。提交方式：

1. 私聊机器人：`/newrule`（长规则也可直接把 `.json` 文件发给机器人）
2. 等机器人回「请发 JSON 或 .json 文件」
3. 把完整 JSON 发过去（**单独一条消息**），或上传 `.json` 文件
4. 机器人回「已创建规则 <id8>」
5. 群里 `/startgame` 就能选这条规则

## 设计建议

- **玩家数量**：3-8 人最佳。1 人也能开（rules.ts 允许），但 choice 步骤要小心 — pickedBy 没人能点。
- **步数**：每个 round 建议 2-5 步，太长玩家记不住。
- **ladder 长度**：3-5 级最佳，太多反而没人记得自己第几次了。
- **label 长度**：尽量短（10-20 字），群里消息会用 `<轮名> · <label>` 作标题。
- **prompt**：可以多行用 `\n`，但每行不要太长（移动端显示截断）。
- **emoji**：用 🎲 🎯 ⚠️ 等 Unicode emoji，别用图片。`roll` 步骤可选 `emoji` 字段：`🎲🎯🏀⚽🎰🎳`（老虎机 1-64，其他 1-6，篮球/足球 1-5）。emoji 优先级：`step.emoji` > `round.defaultEmoji` > `rule.defaultEmoji` > `🎲`。
