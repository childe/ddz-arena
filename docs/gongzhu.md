# 拱猪设计

用户已确认（2026-11-17）：标准规则 + 亮牌；一场累计到 -1000 结束；做 Python bot 并接入智能 bot 服务。本文是引擎、服务端、网页和 SDK 的共同依据。

## 1. 座位和牌

- 4 个座位，`game: "gongzhu"`，各自为战，没有队友。出牌顺序 0 → 1 → 2 → 3 → 0。
- 一副牌 52 张（没有王），每人 13 张。编码与斗地主相同：`rank + suit`，rank 为 `23456789TJQKA`，suit 为 `SHCD`。
- 同一花色内 `2` 最小、`A` 最大。没有主牌，不同花色之间不比大小。

## 2. 分牌和计分

16 张分牌：

| 牌 | 名称 | 分值 |
|---|---|---|
| `QS` | 猪 | -100 |
| `JD` | 羊 | +100 |
| `TC` | 变压器 | 把自己其余分牌的得分翻倍；没有其他分牌时 +50 |
| `AH` `KH` `QH` `JH` | 红桃大牌 | -50、-40、-30、-20 |
| `TH`…`5H` | 红桃 10–5 | 各 -10 |
| `4H` `3H` `2H` | 红桃小牌 | 0 |

- 红桃合计 -200。**全红**：一人收齐 13 张红桃，红桃记 +200，同时收到的猪改记 +100。
- **全收**：一人收齐 16 张分牌 = (200 + 100 + 100) × 2 = +800，由上面的规则自然得出。
- 「没有其他分牌」指 16 张分牌中除变压器外一张都没有（收到 `2H` 也算有，此时 0 × 2 = 0）。
- **亮牌**翻倍（见第 3 节）：亮猪 → 猪 ±200；亮羊 → 羊 +200；亮变压器 → 乘 4（单独时 +100）；亮 `AH` → 所有红桃分值翻倍（全红时 +400）。亮牌对收到这张牌的人生效，不论是谁亮的。

## 3. 一局的流程

1. **发牌**：洗牌后每人 13 张。
2. **首出**：一场的第一局由持 `2C` 的人先出（可以出任意牌）；之后由上一局收到猪的人先出。
3. **亮牌**：从首出者开始按座位顺序，每人轮流决定亮出手中 `QS` / `JD` / `TC` / `AH` 中的任意几张（可以不亮）。所有人都要做一次决定。亮出的牌公开。
4. **出牌**：首出者领出一张，其余人按顺序各出一张。
   - 有领出花色的牌就必须跟这门花色；没有时可以出任意牌（不限制何时出红桃或猪）。
   - **亮牌的限制**：亮出的牌在这门花色第一次被领出的那一轮里不能出（领出和跟牌都不行），除非它是手中这门花色唯一的一张。这门花色领出过一轮以后就没有限制。
   - 领出花色中最大的牌赢这一墩，收走墩里的分牌，下一墩由他领出。
5. **结束**：13 墩打完，或 16 张分牌都已被收走时，本局提前结束。

## 4. 一场比赛和平台计分

- 每人累计本局得分 `totals`。某局结束后有人累计 ≤ -1000，这一场结束（`match_over`，`losers` 是这些座位）。下一局重新开始：`hand_no` 从 1 计，累计清零，持 `2C` 的人先出。
- **平台计分**（`scores`，用于排行榜）：`(4 × 本局得分 − 四人本局得分之和) / 10`，四人之和为 0，`scores > 0` 记为赢。分值都是 10 的倍数，所以结果是整数。

## 5. 接口

在通用接口之上：

| 方法 | 路径 / WS op | 请求体 | 说明 |
|---|---|---|---|
| POST | `/games/{gid}/expose` / `expose` | `{"cards":["QS"], "seq"?}` | 亮牌；`cards: []` 为不亮 |
| POST | `/games/{gid}/play` / `play` | `{"card":"5S", "seq"?}` | 出一张牌；也接受 `{"cards":["5S"]}` |
| GET | `/games/{gid}/legal-moves` | — | 亮牌阶段 `{"exposable":[...]}`；出牌阶段 `{"cards":[...]}`（可以出的牌） |

错误码（422）：`MUST_FOLLOW_SUIT`（有领出花色却没跟）、`EXPOSED_CARD_LOCKED`（亮出的牌在首轮不能出）、`BAD_EXPOSE`（亮了不能亮或不在手里的牌）、`CARDS_NOT_IN_HAND`。

房间配置：`play_timeout_ms`（默认 20000，亮牌和出牌共用）、`legal_moves_api`、`auto_restart`。

超时代打：亮牌阶段不亮；出牌阶段出可出牌中最小的一张，优先不是分牌的牌。

### 事件

- `game.started`：`{"game":"gongzhu","players","hand_no":1,"totals":[0,0,0,0],"first_leader":2,"cards_left":[13,13,13,13]}`，私有字段 `hand`。
- `turn`：`{"seat","phase":"expose"|"playing","trick_no","led_suit","trick"}`。`trick` 是进行中的这一墩 `{"leader","plays":[{"seat","card"}],"winner":null}`，还没人出时为 null；`led_suit` 是这一墩领出的花色，自己领出时为 null。
- `exposed`：`{"seat","cards":["QS","AH"],"auto"}`（`cards` 可以为空）。
- `played`：`{"seat","card","trick_no","cards_left","auto"}`。
- `trick.won`：`{"seat":赢家,"trick_no","plays":[{"seat","card"}],"cards":[这一墩里的分牌]}`，紧跟在这一墩第 4 张的 `played` 后面。
- `game.finished`：`{"result":{"points":[-100,-150,200,-50],"totals_before":[...],"totals_after":[...],"taken":[["QS"],[...],[...],[...]],"exposed":[[],["AH"],[],[]],"all_hearts":null,"pig":0,"losers":[],"match_over":false,"scores":[-30,-50,90,-10]},"hands","seed"}`。`hands` 是提前结束时各人剩下的牌。

### 视图

- `GET /games/{gid}`：`game`、`phase`（`expose`/`playing`/`finished`）、`hand_no`、`totals`（本局前的累计）、`first_leader`、`exposed`（每个座位亮出的牌）、`turn`、`trick_no`、`led_suit`、`trick`、`tricks`（已完成的墩，含 `winner`）、`taken`（每人已收的分牌）、`cards_left`、`result`。
- `GET /games/{gid}/state`：再加 `seat`、`hand`，轮到自己时加 `legal`：亮牌阶段 `{"phase":"expose","exposable"}`，出牌阶段 `{"phase":"playing","cards"}`。
- 回放：`initial_hands` 和 `seed`。

## 6. 实现位置

- 引擎 `packages/engine/src/gongzhu/`：`cards.ts`（牌、分牌、红桃分值、排序）、`game.ts`（`GongzhuGame`：一局；`scoreTaken`、`settleGz`；跨局状态 `GongzhuMatch`）。
- 服务端 `packages/server/src/games/gongzhu.ts`。
- 网页：拱猪牌桌（亮牌、墩、已收分牌、累计分）。
- Python SDK：`ddz_sdk/rules_gz.py`、`GongzhuBot` 基类、`examples/gongzhu_bot.py`；智能 bot `sdk/python/smart/smart_gz_bot.py` 接入 `service.py`。
