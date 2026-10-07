# 规则模板

每个 `.json` 都是一个完整规则。私聊机器人发 `/newrule`，把 JSON 内容粘进去即可（不需要 `name` 字段，因为 `/newrule` 已经隐式传入，但 JSON 里也允许写）。

完整设计指南见根目录 [`RULES_AUTHORING.md`](../RULES_AUTHORING.md)。本目录只列示例。

## 步骤类型速查

| 类型 | 触发 | 推进方式 |
|---|---|---|
| `roll` | 玩家发指定 emoji（默认 🎲，可选 🎯🏀⚽🎰🎳） | 3.5 秒后自动推进 |
| `text` | 显示 prompt | 管理员 `/next` 或 Mini App「下一步」 |
| `punish` | 显示惩罚（支持 ladder 升级） | 管理员 `/next` |
| `choice` | 显示选项按钮 | 玩家点按钮（或管理员 `/next` 强制选第一个） |

## 字段约束速查

完整约束看 `RULES_AUTHORING.md`。这里只列常用：

```json
{
  "version": "1.4.0",              // 可省略，自动填当前 CURRENT_RULE_SCHEMA_VERSION
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

只有上一个 `roll` 掷出 🎲 的玩家才能点（`phase.pickedBy`）。其他人误点会弹 toast。

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

复制任一文件，改 `name`、改 `description`、改具体文案就能用。提交方式：

1. 私聊机器人：`/newrule`
2. 等机器人回「请发 JSON」
3. 把完整 JSON 发过去（**单独一条消息**）
4. 机器人回「已创建规则 <id8>」
5. 群里 `/startgame` 就能选这条规则

## 设计建议

- **玩家数量**：3-8 人最佳。1 人也能开（rules.ts 允许），但 choice 步骤要小心 — pickedBy 没人能点。
- **步数**：每个 round 建议 2-5 步，太长玩家记不住。
- **ladder 长度**：3-5 级最佳，太多反而没人记得自己第几次了。
- **label 长度**：尽量短（10-20 字），群里消息会用 `<轮名> · <label>` 作标题。
- **prompt**：可以多行用 `\n`，但每行不要太长（移动端显示截断）。
- **emoji**：用 🎲 🎯 ⚠️ 等 Unicode emoji，别用图片。`roll` 步骤可选 `emoji` 字段：`🎲🎯🏀⚽🎰🎳`（老虎机 1-64，其他 1-6，篮球/足球 1-5）。emoji 优先级：`step.emoji` > `round.defaultEmoji` > `rule.defaultEmoji` > `🎲`。
