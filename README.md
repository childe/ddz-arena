# 斗地主 Bot 对战平台

供程序自动对战的棋牌服务，支持三人斗地主、四人斗地主和无限注德州扑克：服务端负责发牌、判定规则、计时和计分；参赛程序通过 HTTP + WebSocket 接入；真人可以在网页上围观、看回放，也可以下场和 bot 打。

- 设计方案：[docs/design.md](docs/design.md)，多游戏扩展：[docs/multigame.md](docs/multigame.md)
- 接口文档：[docs/api.md](docs/api.md)（服务运行后网页上的「接口文档」页也是这份）
- Python SDK 与示例 bot：[sdk/python](sdk/python)

## 目录

```
packages/engine   规则引擎（牌型识别、比较、合法出牌枚举、发牌、计分），纯 TypeScript，服务端和前端共用
packages/server   Fastify 服务：REST、WebSocket、房间与计时、SQLite 存储
packages/web      React 前端：大厅、牌桌、回放、排行榜、真人下场
sdk/python        Python SDK、随机 bot、贪心 bot
deploy            systemd 配置和部署脚本
```

## 本地运行

需要 Node ≥ 22.18（直接运行 TypeScript，并使用内置的 `node:sqlite`）。

```bash
npm install
npm run build          # 构建前端到 packages/web/dist
npm start              # http://localhost:8080
```

开发前端时另开一个终端执行 `npm run dev:web`，Vite 会把 `/api` 和 `/ws` 代理到 8080。

环境变量：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` / `HOST` | `8080` / `0.0.0.0` | 监听地址 |
| `DDZ_DB` | `data/ddz.db` | SQLite 文件路径 |
| `DDZ_INVITE_CODE` | 空 | 设置后，注册 bot 必须提供这个邀请码 |
| `DDZ_RATE_LIMIT` | `50` | 每个 bot 每秒平均请求数上限 |
| `DDZ_LOG` | 开 | 设为 `0` 关闭请求日志 |

## 测试

```bash
npm test               # 引擎单测 + 1 万局随机自对弈 + 服务端集成测试
npm run typecheck
# 压测：50 个房间并发，每个房间打 10 局
DDZ_RATE_LIMIT=100000 npm start &
node packages/server/scripts/stress.ts --base http://localhost:8080 --rooms 50 --games 10
```

## 部署

```bash
deploy/deploy.sh tt
```

脚本在本地构建前端，用 rsync 同步到 `tt:/opt/ddz`，安装运行时依赖，然后安装并重启 systemd 服务 `ddz`。第一次部署会生成 `/etc/ddz.env`，其中包含随机生成的邀请码。

演示桌 `ddz-demo` 是另一个 systemd 服务，运行 `deploy/demo.mjs`：三种游戏各开一桌（「三机演示」「四人斗地主演示」「德州扑克演示」），bot 无限对局，每步停 1.5 秒（`DDZ_DEMO_PAUSE_MS`），服务端重启后自动重建房间。用 `ssh tt sudo systemctl enable --now ddz-demo` 启用一次，之后每次部署会自动重启它；用 `disable --now` 停用。

常用运维命令：

```bash
ssh tt sudo systemctl status ddz
ssh tt sudo journalctl -u ddz -f
ssh tt cat /etc/ddz.env                      # 查看邀请码
ssh tt sqlite3 /opt/ddz/data/ddz.db .dump    # 备份（需要先安装 sqlite3）
```
