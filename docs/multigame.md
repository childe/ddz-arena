# 多游戏扩展设计（四人斗地主 + 德州扑克）

用户已确认的规则与范围（2026-11-16）：按推荐规则，分三个阶段一次做完：

1. 平台支持多种游戏，三人斗地主接口与行为保持不变；
2. 四人斗地主；
3. 德州扑克。

## 游戏类型

| `game` | 名称 | 座位 | 开局条件 |
|---|---|---|---|
| `ddz` | 三人斗地主（默认） | 3 | 3 个座位都有人且都已准备 |
| `ddz4` | 四人斗地主 | 4 | 4 个座位都有人且都已准备 |
| `holdem` | 德州扑克（无限注） | `config.seats`，2–6，默认 6 | 至少 2 人入座，且所有入座者都已准备 |

## 四人斗地主规则（engine: `packages/engine/src/ddz4/`）

- 两副牌 108 张，牌面编码与三人版相同（`3S`…`2D`、`BJ`、`RJ`），同一编码最多出现 2 次。手牌、出牌都按多重集合处理。
- 每人 25 张，底牌 8 张。叫分 0–3，规则与三人版相同：从随机的首叫者开始每人叫一次，叫 3 立即结束，全不叫则本局 `nobid`（服务端最多重发 3 次）。
- 地主拿底牌后 33 张，先出。
- 牌型：`single`、`pair`、`triple`、`triple_single`、`triple_pair`、`straight`（≥5 张，3–A）、`pair_chain`（≥3 对，3–A）、`plane`（≥2 组连续三张，3–A）、`plane_single`、`plane_pair`、`bomb`、`rocket`。没有四带二。
  - `BJ BJ`、`RJ RJ` 是对子；`BJ RJ` 不是任何牌型。
  - `bomb`：同点数 4–8 张，`length` = 张数。王不能组成 bomb。
  - `rocket`（天王炸）：4 张王，最大。
  - 炸弹大小：rocket > 8 张 > 7 张 > 6 张 > 5 张 > 4 张；张数相同比点数。炸弹压一切非炸弹牌型。
  - 带牌：翅膀不能含主体（三张/飞机）的点数；`triple_pair`、`plane_pair` 的翅膀必须是同点数的对子，翅膀之间点数不同；翅膀不能含 4 张王。飞机主体的每个点数恰好用 3 张。
- 计分：底分 = 叫分；倍数 = 2^(炸弹数，含天王炸) × 春天/反春 ×2。地主赢：每个农民 −底分×倍数，地主 +3×底分×倍数；农民赢反之。三家分数之和为 0。
- 引擎导出 `Ddz4Game`，形状与三人版 `Game` 相同（座位 0–3）：`seed`、`firstBidder`、`initialHands`、`hands`、`bottom`、`phase`、`turn`、`bids`、`highBid`、`landlord`、`lastPlay`、`toBeat`、`history`、`result`、`multiplier`、`bid()`、`play(seat, cards, hint?)`、`autoAction()`；错误沿用 `GameError` 及同样的错误码。另导出 `identify4`、`resolve4`、`beats4`、`legalMoves4`。

## 德州扑克规则（engine: `packages/engine/src/holdem/`）

- 一副 52 张（无王），编码 `rank + suit`，rank 为 `23456789TJQKA`，suit 为 `SHCD`。
- 无限注，小盲 1、大盲 2。每手牌开始时所有参与者筹码重置为 200（100 大盲），所以不会出现边池。
- 庄位（button）每手顺时针移到下一个参与者。小盲在庄位左边，大盲再左边；两人时庄位下小盲、翻牌前先行动，翻牌后后行动。
- 下注轮：preflop → flop（3 张）→ turn → river → 摊牌。动作：`fold`、`check`、`call`、`raise`（`amount` 是本轮总下注额 raise-to；全下就是 raise 到自己能下的最大额）。
- 最小加注：加注幅度 ≥ 本轮上一次的加注幅度（翻牌前初始为大盲）。不足最小加注的全下不重新开放加注。
- 一人之外全部弃牌时立即结束，不摊牌。都全下后直接发完公共牌。
- 摊牌：7 选 5 最佳牌型比较；平分底池，零头按庄位左侧顺序给第一个赢家。
- 结果 `scores` 是每个参与者本手的净输赢筹码，和为 0。
- 超时自动动作：能 check 就 check，否则 fold。

## 服务端

- `Room` 改为通用的座位、准备、计时、托管、事件缓冲、重连、持久化；具体游戏通过 `GameSession` 适配器接入（`packages/server/src/games/`）。
- 房间 `summary()` 增加 `game` 字段；`POST /rooms`、`POST /rooms/quick-join` 接受 `game`（默认 `ddz`）。
- 动作接口：斗地主（ddz / ddz4）沿用 `POST /games/{gid}/bid` 与 `/play`；德州扑克用 `POST /games/{gid}/action`，WebSocket op `action`。
- 数据库 `games`、`game_players` 增加 `game_type` 列；排行榜 `GET /leaderboard?game=` 按游戏分开（默认 `ddz`）。
