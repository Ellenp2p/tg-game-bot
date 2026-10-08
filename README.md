# tg-game-bot — Telegram 群内派对游戏主理人

> 一个帮你主持派对游戏（真心话大冒险、骰子惩罚、知识抢答、篮球三连冠等）的 Telegram bot。规则用 JSON 描述，玩家发 🎲 触发，机器人跑完全部流程；Mini App 提供实时进度面板。

Telegram 群内由管理员开对局 → 玩家掷色子 / 答题 / 受罚 → 管理员推进或跳过。可私聊机器人创建并管理规则（规则可发给其他 AI 翻译生成，详见 [`RULES_AUTHORING.md`](RULES_AUTHORING.md)）。

## 特性

- **群内对局**：每个群独立的对局；多人轮换、全员比大小、惩罚 ladder 自动升级、可循环轮、可设置特定 step
- **声明式规则**：JSON 描述游戏流程，6 种 step 类型（`roll` / `text` / `punish` / `choice` / `showdown` / `branch`），18 个模板见 [`examples/`](examples/)
- **多种 emoji**：🎲🎯🏀⚽🎰🎳（骰子 1-6、篮球足球 1-5、老虎机 1-64）
- **实时视图**：Telegram Mini App（WebSocket 推送）— 玩家看到当前进度，管理员看到全员状态
- **管理面板**：Mini App 提供报名 / 推进 / 跳过 / 撤销 / 结束 / 切换步骤
- **规则共享**：同一组织项目可绑定多个群，规则一份多群共享
- **隐私优先**：SQLite 只存 `user_id` + 规则 JSON + 动作流事件，**不存任何聊天内容、用户名、群名、图片**

## 快速开始

```bash
# 1. 准备：Node.js 22+、pnpm、一个 Telegram Bot、可公开访问的 HTTPS 域名
corepack enable
pnpm install --frozen-lockfile

# 2. 配置
cp .env.example .env
# 编辑 .env，至少填 BOT_TOKEN 和 PUBLIC_URL

# 3. 构建并运行
pnpm build
pnpm start
```

生产用 systemd 部署见 [`deploy/README.md`](deploy/README.md)（单元文件在 [`deploy/tg-game-bot.service`](deploy/tg-game-bot.service)）。

向 @BotFather：

1. 创建机器人拿到 `BOT_TOKEN`
2. 在 **Bot Settings → Menu Button** 设置 URL 为 `https://你的域名/`（让 t.me 链接能重定向到你的域名）
3. **关闭群隐私模式**（Privacy Mode → Disable），否则机器人看不到玩家发的 🎲
4. 把机器人加入目标群并设为管理员

## 用法

### 群里

| 命令 | 谁能用 | 干啥 |
|---|---|---|
| `/startgame` | 群管理员 | 选规则开局（自动结束旧对局） |
| `/leavegame` | 玩家 | 退出报名 |
| `/begin` | 群管理员 | 开始游戏 |
| `/next` | 群管理员 | 推进到下一步 |
| `/undo` | 群管理员 | 撤销上一次动作 |
| `/endgame` | 群管理员 | 强制结束 |
| `/status` | 群成员 | 查看当前状态 |
| `/play` | 群管理员 | 召唤/重置置顶入口（卡片被删或被顶掉时） |

### 私聊

| 命令 | 干啥 |
|---|---|
| `/newrule` | 上传新规则（粘贴 JSON 文本，或直接发 `.json` 文件） |
| `/editrule` | 编辑已有规则 |
| `/rules` | 打开规则管理面板（按钮操作 + 分页） |
| `/rule <id8>` | 查看规则详情 |
| `/deleterule` | 删除规则 |

### 玩家操作

到点轮到自己时，发对应 emoji（默认 🎲，根据规则也可能是 🎯🏀⚽🎰🎳）。引擎 3.5 秒后自动公布结果并推进（或等管理员 `/next`）。

「比大小（`showdown`）」步骤则由**全员各发一次**：看板实时显示 ✅ 已掷 / ⏳ 未掷名单，全员集齐后自动排序结算。

## 文档

| 文档 | 内容 |
|---|---|
| [`AGENTS.md`](AGENTS.md) | 项目说明、bot 语义、调试技巧、规则设计概览 |
| [`RULES_AUTHORING.md`](RULES_AUTHORING.md) | **规则 JSON 完整 schema**，给设计者 / AI 用 |
| [`examples/README.md`](examples/README.md) | 18 个规则的表格（人数 + 用到的特性） |
| [`examples/*.json`](examples/) | 现成模板（真心话大冒险、骰子惩罚、谜语接龙、篮球三连冠、老虎机 JACKPOT、比大小等） |

## 部署

### 反向代理（nginx + Cloudflare）

源站只听 80/HTTP，HTTPS 在 Cloudflare 终止。`SSL/TLS` 模式选 **Full**（不是 Full (Strict)，因为 Origin 用 Cloudflare Origin CA 证书）：

```nginx
server {
    listen 80;
    server_name your-domain.example.com;

    location / {
        proxy_pass         http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade $http_upgrade;
        proxy_set_header   Connection "upgrade";
        proxy_set_header   Host $host;
        proxy_read_timeout 86400;
        proxy_buffering    off;
    }
}
```

### systemd

```ini
[Unit]
Description=Telegram Game Master Bot
After=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/tg-game-bot
ExecStart=/usr/bin/node /opt/tg-game-bot/dist/index.js
Restart=on-failure
RestartSec=5
EnvironmentFile=/opt/tg-game-bot/.env

[Install]
WantedBy=multi-user.target
```

### Docker（可选）

```bash
docker compose up -d --build
```

示例 `compose.yaml` 只把端口绑到 `127.0.0.1:3000`，需在前方配置 HTTPS 反代。数据放在 `game-data` 卷中，升级前备份。

## 安全 / 边界

- Mini App 只信任服务端验证过的 Telegram `initData`（HMAC-SHA256 校验）。1 小时后需重新打开登录。会话 30 分钟有效。
- 原生骰子结果由 Telegram 产生；Bot API 不会通知服务端「动画已结束」，默认延时 4 秒再公布（可调 `DICE_ANIMATION_MS`）。
- WebSocket 连接先提交临时会话令牌，验证前不会收到游戏数据；令牌不放在 URL。生产必须 HTTPS/WSS。
- 每个进程只跑一个实例（同一 Bot Token 多进程长轮询会冲突）。
- 每群一个对局，不按论坛话题拆分。`/status` 消息对群成员可见；规则详情命令限管理员。

## 开发

```bash
pnpm dev            # tsx watch（bot），热重载
pnpm test           # 单测（engine + bot）+ spec/golden
pnpm spec           # 只跑声明式场景 + golden（specs/）
pnpm build          # pnpm -r build（先 engine 后 bot）
```

仓库是 monorepo：`packages/engine`（纯引擎）+ `packages/bot`（Telegram 适配器）。详见 [`ENGINE_ROADMAP.md`](ENGINE_ROADMAP.md) 与 [`specs/README.md`](specs/README.md)。

## License

MIT