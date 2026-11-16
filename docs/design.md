# 斗地主 Bot 对战平台 — 设计方案

> 状态：选型已定（IP 直连 / 叫分制 / 第一版 M1–M5 / 支持真人下场） · 2026-11-15

## 1. 目标

- 服务端是唯一裁判：发牌、判定牌型、校验出牌合法性、计时、计分都在服务端完成。
- 参赛程序（下文统称 bot）只需实现 HTTP + WebSocket 接口即可参赛，语言不限。
- 真人可通过浏览器围观：大厅、实时牌桌、回放、排行榜。
- 比赛可复现、可审计：每局保存随机种子和完整事件日志。

非目标（第一版不做）：真人账号体系、聊天、移动端 App、付费。

## 2. 现有资源与推荐部署

| 资源 | 现状 | 用途 |
|---|---|---|
| VM `tt` | Ubuntu 24.04，2C / 2G（已用约 1G）/ 29G 可用盘，Node 22 已装，公网 IP 43.128.99.230，无 Docker / Nginx | 跑服务端（REST + WS + 静态页面 + SQLite） |
| Cloudflare | 有账号 | 域名 DNS + TLS + 反代 WebSocket（推荐用 Cloudflare Tunnel，VM 不用开放端口） |
| GitHub Pages | 有 | 可选：放 SDK 文档；前端默认由 VM 同源提供，避免 CORS 和 WS 跨域 |

**已定架构：单进程 Node 服务跑在 VM（腾讯云新加坡，无需备案），第一阶段直接用 `http://43.128.99.230` 访问（服务监听 80 端口：腾讯云安全组拦截了 8080 和 443，只放行 80）。现在 `https://ddz.ohmycat.me` 经 Cloudflare 代理（橙色云朵，SSL Flexible：浏览器到 Cloudflare 是 HTTPS，Cloudflare 到源站是 HTTP:80），WebSocket 透传；Cloudflare 会断开 100 秒无数据的连接，服务端每 20 秒 ping 一次。** 国内到新加坡直连延迟约 60–100ms，比走 Cloudflare 免费版更稳定。

```
bot / 浏览器 ──HTTP/WS──▶ 43.128.99.230:80 (Node)    # 域名：bot / 浏览器 ──HTTPS/WSS──▶ Cloudflare ──HTTP/WS──▶ :80
                                                  ├─ REST API  /api/v1/*
                                                  ├─ WebSocket /ws
                                                  ├─ 静态前端   /
                                                  └─ SQLite    ./data/ddz.db
```

理由：房间状态放在单进程内存里最简单，2C2G 跑几百个并发牌局没有压力（规则引擎是纯 CPU 小计算）；SQLite 足够存 bot、对局和回放。

备选：Cloudflare Workers + Durable Objects（每个房间一个 DO）。优点是免运维；缺点是本地调试和日志不如 VM 直观，bot 高频对战会很快吃掉免费额度。见第 10 节。

## 3. 游戏规则（写死在引擎里，以测试用例为准）

- 54 张牌，3 人，每人 17 张，底牌 3 张。
- **叫分制**（默认）：从随机首家开始，每人一次机会叫 1/2/3 分或不叫，必须高于当前分；叫到 3 分立即成为地主。三人都不叫则重新发牌，连续 3 次流局记为平局。
  - 可选：叫地主/抢地主制，作为房间配置项，第二期再做。
- 牌型：单张、对子、三张、三带一、三带一对、顺子（≥5 张，3–A）、连对（≥3 对）、飞机（≥2 个连续三张，可带同数量的单张或对子）、四带两单、四带两对、炸弹、王炸。2 和王不能进顺子 / 连对 / 飞机。
- 歧义处理：同一组牌可能有多种解释（如 `333444555666` 既是 4 连飞机，也是 3 连飞机带 3 单）。出牌请求可带可选字段 `pattern` 指定解释；不带时，跟牌选能压过上家的解释，首出选主体最长的解释。
- 计分：底分 = 叫分；每个炸弹 / 王炸 ×2；春天 / 反春 ×2。地主得失 2 倍，两个农民各得失 1 倍。

## 4. 核心模型

```
Bot      id, name, owner, token_hash, rating, created_at
Room     id, mode(casual|ranked|tournament), rules(json), seats[3], spectators, status(waiting|playing|closed)
Game     id, room_id, seed, deal, landlord, multiplier, result, events[]   # 内存态 + 结束后落库
Event    seq, ts, type, payload           # 每局单调递增 seq，回放和断线补发都靠它
```

牌的编码：点数 `3456789TJQKA2` + 花色 `SHCD`，大小王为 `BJ`（小王）、`RJ`（大王）。示例：`["3S","3H","TD","RJ"]`。bot 可以忽略花色，服务端只校验"这几张牌在你手里"。

牌局状态机：

```
waiting ──3 人 ready──▶ bidding ──定出地主──▶ playing ──有人出完──▶ finished
             ▲              │ 三人都不叫                              │
             └── redeal ◀───┘                         ranked 模式自动开下一局
```

## 5. HTTP 接口（`/api/v1`）

认证：`Authorization: Bearer <bot_token>`。围观接口不需要认证。

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/bots` | 注册 bot（需邀请码），返回 `bot_id` 和 `token`（只显示一次） |
| GET | `/me` | 当前 bot 信息、所在房间 |
| GET | `/rooms` | 房间列表（围观也可用） |
| POST | `/rooms` | 建房，可传规则配置 |
| POST | `/rooms/{rid}/join` | 入座，可指定 `seat` |
| POST | `/rooms/{rid}/leave` | 离座（对局中离开 = 托管至本局结束） |
| POST | `/rooms/{rid}/ready` | 准备 |
| POST | `/matchmaking` | 排队自动匹配（ranked） |
| GET | `/games/{gid}/state` | 自己视角的完整状态：手牌、轮到谁、上家出牌、截止时间、`seq` |
| GET | `/games/{gid}/legal-moves` | 可选：列出当前合法出牌（房间配置可关闭，正式比赛建议关） |
| POST | `/games/{gid}/bid` | `{"score":0..3, "seq":N}` |
| POST | `/games/{gid}/play` | `{"cards":["3S","3H"], "pattern":?, "seq":N}`，`cards` 为空表示不出 |
| GET | `/games/{gid}/replay` | 已结束牌局的完整事件日志（含种子和所有手牌） |
| GET | `/leaderboard` | 排行榜 |

`seq` 是客户端看到的最新事件序号，用来做幂等和防止"过期请求"：网络重试导致同一出牌请求发了两次，第二次会因 `seq` 过期被拒，不会重复出牌。

### 状态码

| Code | error.code 示例 | 场景 |
|---|---|---|
| 200 | — | 成功，返回出牌后的状态摘要 |
| 400 | `BAD_REQUEST` `UNKNOWN_CARD` | JSON 格式错、牌编码不存在、字段缺失 |
| 401 | `UNAUTHORIZED` | 没带 token 或 token 无效 |
| 403 | `NOT_A_PLAYER` | 不是该局玩家（如围观者调出牌接口） |
| 404 | `ROOM_NOT_FOUND` `GAME_NOT_FOUND` | 房间 / 牌局不存在 |
| 409 | `NOT_YOUR_TURN` `STALE_SEQ` `ROOM_FULL` `WRONG_PHASE` | 状态冲突：没轮到你、seq 过期、房间满、叫分阶段调了出牌 |
| 422 | `CARDS_NOT_IN_HAND` `INVALID_PATTERN` `CANNOT_BEAT` `MUST_PLAY` `BID_TOO_LOW` | 请求格式正确但违反规则 |
| 429 | `RATE_LIMITED` | 超频（默认每 bot 50 次/秒，瞬时 100 次） |

错误体统一：

```json
{"error": {"code": "CANNOT_BEAT", "message": "pair 55 cannot beat pair 77", "details": {"last": {"pattern":"pair","cards":["7S","7H"]}}}}
```

非法出牌不扣回合：bot 可以在截止时间内重试。同一回合非法请求超过 5 次，按超时处理。

## 6. WebSocket 推送

- 玩家：`wss://ddz.xxx/ws?token=...`
- 围观：`wss://ddz.xxx/ws/spectate?room={rid}`
- 断线重连：带 `&since=<last_seq>`，服务端补发漏掉的事件；超出缓存范围则要求客户端先调 `/state`。
- 心跳：服务端每 20 秒 ping，60 秒无响应断开。
- 可选：玩家也能通过 WS 发 `{"op":"play",...}`，响应格式和 HTTP 一致（给追求低延迟的 bot 用）。HTTP 是主接口。

事件（所有事件都有 `seq`、`ts`、`game_id`）：

| type | 接收方 | payload 要点 |
|---|---|---|
| `room.updated` | 全部 | 座位、准备状态 |
| `game.started` | 玩家各自 | 自己的 17 张手牌、座位、首叫者 |
| `bid.turn` / `bid.made` | 全部 | 轮到谁、截止时间 / 谁叫了几分 |
| `landlord.decided` | 全部 | 地主座位、3 张底牌（公开） |
| `turn` | 全部 | 轮到谁、截止时间、需要压的牌（为空表示自由出牌） |
| `played` | 全部 | 座位、牌、牌型、剩余张数、当前倍数 |
| `passed` | 全部 | 座位 |
| `timeout` | 全部 | 座位、系统代出的动作 |
| `game.finished` | 全部 | 胜方、得分明细、所有人剩余手牌、随机种子 |

**防作弊**：围观推送里只有剩余张数，没有手牌。"上帝视角"（显示三家手牌）只对已结束的回放开放，或对实时对局延迟 N 秒（默认 ranked 不开），防止 bot 开一个围观连接偷看别家手牌。

## 7. 计时与托管

- 叫分 10 秒，出牌 20 秒（房间可配置）。截止时间以服务端时间为准，事件里给出绝对时间戳和剩余毫秒数。
- 超时系统代出：叫分 → 不叫；跟牌 → 不出；首出 → 出最小单张。
- 连续 3 次超时进入托管，直到 bot 再次成功出牌。超时次数计入统计和排行榜。

## 8. 比赛形式

1. **休闲房**：手动建房、入座、准备，用于调试。
2. **天梯**：`/matchmaking` 自动凑三人开局，Elo / TrueSkill 计分。同一 owner 的多个 bot 不会被匹配到同一桌（防串通）。
3. **复式赛（锦标赛）**：同一副牌在三个座位上轮转，三个 bot 各打一遍每个位置，消除"抓到好牌"的运气成分。赛程、轮次、积分表由服务端调度，大厅实时展示。

## 9. 前端（真人围观）

- **大厅**：进行中的房间、在线 bot、正在进行的比赛。
- **牌桌**：三家座位（地主标识、剩余张数、倒计时环）、桌面最近一手牌、出牌动画、倍数和叫分、底部出牌历史。
- **回放**：事件时间轴，可拖动、单步、变速，结束后可切上帝视角。
- **排行榜 / bot 主页**：胜率、地主胜率、平均得分、超时率、最近对局。
- **API 文档**：OpenAPI 自动生成，挂在 `/docs`。

技术：React + Vite + TypeScript，牌面用 SVG/CSS 绘制，不依赖图片素材。

## 10. 技术栈与工程结构

| 层 | 选择 | 说明 |
|---|---|---|
| 规则引擎 | TypeScript 纯函数包 | 服务端和前端共用；牌型识别、比较、合法出牌枚举；单测覆盖每种牌型和边界 |
| 服务端 | Node 22 + Fastify + `@fastify/websocket` | 自带 schema 校验和 OpenAPI 生成 |
| 存储 | SQLite（`better-sqlite3`） | bot、对局、事件日志、排行榜；单文件，`sqlite3 .backup` 即可备份 |
| 前端 | React + Vite | 构建产物由 Fastify 同源托管 |
| SDK | Python 包 + TS 包 | 封装认证、WS 重连、seq 处理；附随机 bot 和贪心 bot 示例 |
| 部署 | systemd（后续加 Caddy） | `git pull && npm ci && npm run build && systemctl restart ddz` |

```
playing-card/
├─ packages/
│  ├─ engine/     # 牌型、比较、发牌、合法出牌枚举（无 IO）
│  ├─ server/     # Fastify：REST、WS、房间管理、计时、SQLite
│  ├─ web/        # React 围观前端
│  └─ sdk-ts/
├─ sdk/python/    # Python SDK + 示例 bot
├─ docs/          # 本文档、rules.md、API 指南
└─ deploy/        # systemd unit、cloudflared 配置、部署脚本
```

部署备选对比：

| 方案 | 优点 | 缺点 |
|---|---|---|
| A. VM + Cloudflare Tunnel | 不开端口，自动 TLS，WS 原生支持，调试直观 | 需要一个托管在 Cloudflare 的域名 |
| **B. VM 直连，先 IP 后加 Caddy（已选）** | 不依赖 Cloudflare | 需要开放 80/443、域名指向 IP，暴露源站 |
| C. Workers + Durable Objects | 免运维，全球边缘 | 本地调试较绕，bot 高频对战易超免费额度，SQLite/定时器写法受限 |
| D. 前端 GitHub Pages + 后端 VM | 前端走 CDN | 要处理 CORS、WS 跨域、两处发布；收益不大 |

## 11. 测试与质量

- 引擎：每种牌型的识别 / 比较表驱动测试，加随机对局的性质测试（任意合法出牌都能被引擎识别；枚举出的合法动作都能通过校验）。
- 服务端：用 3 个随机 bot 跑 1 万局压测，检查无卡死、seq 连续、计分守恒（三家得分之和为 0）。
- 接口：每个错误码至少一个集成测试。

## 12. 里程碑

| 阶段 | 内容 | 产出 |
|---|---|---|
| M1 | 规则引擎 + 测试 | `packages/engine`，覆盖全部牌型 |
| M2 | 服务端：房间、状态机、REST、WS、计时、SQLite | 本地能用 curl / wscat 打完一局 |
| M3 | Python SDK + 随机 / 贪心 bot | 3 个 bot 自动对战 |
| M4 | 围观前端：大厅、牌桌、回放 | 浏览器实时看 bot 对战 |
| M5 | 部署到 `tt` + Cloudflare | 公网地址可用 |
| M6 | 天梯 + 排行榜 + 复式赛 | 可以办比赛 |

M1–M5 是第一个可用版本。

## 13. 待确认

1. ~~部署方案~~：已定为 B，先 IP 直连。
2. ~~规则~~：只做叫分制。
3. ~~第一版范围~~：M1–M5，M6 放第二期。
4. ~~真人下场~~：要。网页上可入座出牌，浏览器拿一个临时 token，走和 bot 相同的接口。
5. bot 注册方式：默认邀请码自助注册（未确认，可改为管理员发 token）。
6. bot 生命周期与管理端：未做。现状：
   - bot 和游客（`kind=human`）注册后永久有效，`bots` 表没有过期字段。token 只在注册时返回一次，库里只存 sha256，丢了无法找回，也没有重置接口。
   - 没有管理接口，不能列出、删除、禁用 bot。只能直接改库：`sqlite3 /opt/ddz/data/ddz.db "DELETE FROM bots WHERE name='xxx';"`，然后重启服务。`Arena.tokenCache` 缓存已认证的 token 且从不失效，不重启的话，被删的 bot 仍能用旧 token 访问。
   - 删除后 `game_players` 里的历史记录还在，但排行榜和对局查询 JOIN `bots` 表，这个 bot 的战绩会从结果里消失。要保留战绩，应改为禁用而不是删除。
   - 候选方案：加 admin token（环境变量，同邀请码）鉴权的管理接口，支持列出 / 禁用 / 删除 bot、重置 token，操作时同步清 `tokenCache`。
