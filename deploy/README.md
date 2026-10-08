# 部署（systemd）

monorepo：engine 与 bot 分开；生产启动的是 `packages/bot/dist/index.js`。

## 首次部署

```bash
# 1. 依赖与配置
corepack enable
pnpm install --frozen-lockfile
cp .env.example .env          # 编辑：BOT_TOKEN / PUBLIC_URL 等

# 2. 构建（pnpm -r build：先 engine 后 bot）
pnpm build

# 3. 安装 systemd 单元
cp deploy/tg-game-bot.service /etc/systemd/system/tg-game-bot.service
systemctl daemon-reload
systemctl enable --now tg-game-bot
systemctl status tg-game-bot
```

单元里 `WorkingDirectory=/root/tg-game-bot`，`ExecStart=/usr/bin/env node packages/bot/dist/index.js`。
若你之前手动加过 drop-in（旧路径 `dist/index.js`），先删掉以免覆盖：

```bash
rm -rf /etc/systemd/system/tg-game-bot.service.d
systemctl daemon-reload
```

## 更新

```bash
cd /root/tg-game-bot
git fetch origin && git reset --hard origin/main
pnpm install --frozen-lockfile
pnpm build
systemctl restart tg-game-bot
```

## 排障

```bash
journalctl -u tg-game-bot -f          # 实时日志
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3001/   # 200 = Mini App 起来了
```

## 测试 / 回归

```bash
pnpm test        # 构建 + engine/bot 单测 + spec/golden
pnpm spec        # 只跑声明式场景 + golden（specs/）
```

## Docker（可选）

仓库含 `Dockerfile` + `compose.yaml`；生产默认走 systemd，Docker 仅作替代。
