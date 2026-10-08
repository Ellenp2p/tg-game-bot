# Specs —— 声明式场景 + golden 回归

无需 Telegram，用纯引擎驱动可复现的场景，并把结果录成 golden 供 diff。

## 运行

```bash
pnpm spec              # 跑全部 spec，与 golden 比对
pnpm spec --update     # 重新录制 golden（改动了预期行为后）
pnpm spec draw         # 只跑文件名/名字含 "draw" 的 spec
pnpm gen-specs         # 从 examples/*.json 重新生成 playthrough 种子
```

`pnpm test` 会先跑单测，再跑 `pnpm spec`。

## 目录

```
specs/
  *.spec.json            # 场景
  __golden__/*.trace.json# 录制结果（入库，可 diff）
```

## 两类 spec

### 1. `playthrough`（由 examples 自动生成）

对某条示例规则，用固定策略从开局一路打到结束，录制整条轨迹。

```jsonc
{
  "kind": "playthrough",
  "name": "18-draw-lucky.min",
  "rule": "examples/18-draw-lucky.json",   // 也可以内联对象
  "players": [2001, 2002],
  "policy": { "value": "min", "choice": 0, "maxOps": 1234 }
}
```

- `policy.value`：`min`=每次都掷最小值(1)，`max`=每次掷该 emoji 的上限。
- `policy.choice`：遇到 `choice` 步固定选第几个（从 0 起）。
- `policy.maxOps`：安全上限，防止不终止。

生成：`pnpm gen-specs`（每个 example 出 `min`/`max` 两份）。

### 2. `scripted`（手写，针对具体行为）

显式给出一串 intent，并对结果断言。

```jsonc
{
  "kind": "scripted",
  "name": "behavior-draw-box",
  "rule": "examples/18-draw-lucky.json",
  "players": [9001, 9002],
  "steps": [
    { "do": { "type": "begin" }, "expect": { "phase": "roll", "expectedPlayerId": 9001 } },
    { "do": { "type": "roll", "userId": 9001, "value": 64, "emoji": "🎰" },
      "expect": { "phase": "text", "stepIdx": 3, "lastDraw": 16, "messageContains": "16" } }
  ]
}
```

**intent**：`join` / `leave` / `begin` / `roll` / `showdownRoll` / `choice` / `next` / `skip`。
（`join`/`leave` 是引擎 intent——名册归引擎，满员/重复/阶段校验都在引擎；`end`/`replace` 仍是应用层动作，见 `packages/bot`。）

**expect**：`ok` / `error` / `phase` / `expectedPlayerId` / `roundIdx` / `stepIdx` / `messageContains` / `lastDraw` / `loops`。

## golden

每个 spec 对应 `__golden__/<spec 名>.trace.json`：逐步记录 `intent / ok / error / phase / cursor / expectedPlayerId / lastDice / lastDraw / loops / message`。

- **不含时间戳**，保证稳定。
- 引擎行为一旦漂移，`pnpm spec` 会给出第一处不一致的行，`--update` 重录。
- golden **入库**，作为重构（S1–S6）的 characterization 守护。
