# 斗地主 Bot 接口文档

Base URL：`http://43.128.99.230`（下文路径都相对于它），WebSocket 地址把 `http` 换成 `ws`。所有请求和响应都是 JSON。

接口与语言无关，任何能发 HTTP 请求、连 WebSocket 的语言都能实现 bot。本文是完整协议；第 6 节是不用 SDK、从零实现 bot 的教程。

| 资料 | 用途 |
|---|---|
| 本文 | 完整协议、规则、错误码 |
| [`/api/v1/openapi.yaml`](/api/v1/openapi.yaml) | OpenAPI 3.1 机器可读规范，可用 openapi-generator 等工具生成 Go / Java / Rust / C# 等语言的 HTTP 客户端 |
| [`/api/v1/examples/node-bot.mjs`](/api/v1/examples/node-bot.mjs) | 零依赖的 Node.js 单文件 bot（约 120 行），可作为移植到其他语言的参照。运行：`node node-bot.mjs --base http://43.128.99.230 --invite <邀请码> --verbose` |
| [Python SDK](https://github.com/childe/ddz-arena/tree/main/sdk/python) | `pip install "git+https://github.com/childe/ddz-arena.git#subdirectory=sdk/python"`；含完整规则实现（牌型识别、合法出牌枚举），可供移植 |
| [规则引擎](https://github.com/childe/ddz-arena/tree/main/packages/engine/src) | 服务端使用的规则引擎（TypeScript），判定以它为准 |
| [GitHub 仓库](https://github.com/childe/ddz-arena) | 全部源码，问题和建议请提 Issue |

## 1. 快速上手

```bash
BASE=http://43.128.99.230
# 1. 注册 bot，拿到 token（只返回一次，请保存）
curl -X POST $BASE/api/v1/bots -H 'content-type: application/json' -d '{"name":"my-bot","invite_code":"..."}'
# 2. 连 WebSocket 收推送
wscat -c "ws://43.128.99.230/ws?token=$TOKEN"
# 3. 快速入座（有空位就坐，没有就新建房间），然后准备
curl -X POST $BASE/api/v1/rooms/quick-join -H "authorization: Bearer $TOKEN"
curl -X POST $BASE/api/v1/rooms/$RID/ready -H "authorization: Bearer $TOKEN"
# 4. 收到轮到自己的 bid.turn / turn 事件后，调用 bid / play
```

## 2. 约定

- 认证：`Authorization: Bearer <token>`。WebSocket 用查询参数 `?token=`。
- 座位：`0`、`1`、`2`，出牌顺序是 0→1→2→0。
- 牌：点数 `3456789TJQKA2` + 花色 `SHCD`，例如 `3S`、`TH`、`2D`；小王 `BJ`，大王 `RJ`。
- 点数（rank）：`3 4 5 6 7 8 9 T J Q K A 2 BJ RJ`，从小到大。
- 牌型（`pattern`）：`{"type": "...", "rank": "3", "length": 1}`
  - `type`：`single` 单张、`pair` 对子、`triple` 三张、`triple_single` 三带一、`triple_pair` 三带一对、`straight` 顺子、`pair_chain` 连对、`plane` 飞机、`plane_single` 飞机带单、`plane_pair` 飞机带对、`four_two_single` 四带二、`four_two_pair` 四带两对、`bomb` 炸弹、`rocket` 王炸。
  - `rank`：比较大小用的点数。连牌（顺子、连对、飞机）取最小的那个点数；带牌的牌型取主体（三张或四张）的点数。
  - `length`：连牌的长度（顺子张数、连对对数、飞机的三张组数），其他牌型为 1。
- 时间：`deadline` 是服务端的毫秒时间戳，`remaining_ms` 是发出事件时剩余的毫秒数。建议用 `remaining_ms` 计算，避免两边时钟不一致。

## 3. 规则摘要

- 54 张牌，每人 17 张，3 张底牌。
- 叫分：从 `first_bidder` 开始每人一次，叫 0（不叫）或 1–3 分，必须高于当前最高分；有人叫 3 分立即结束。最高分者当地主，拿走底牌（底牌公开），地主先出牌。三人都不叫则重新发牌（`redeal` 事件）。
- 出牌：首出必须出牌；跟牌必须同牌型、同长度且更大，或者出炸弹 / 王炸，或者不出（`cards: []`）。连续两家不出，最后出牌的人重新首出。
- 2 和王不能进顺子、连对、飞机。顺子至少 5 张，连对至少 3 对，飞机至少 2 组。
- 带牌限制：飞机的翅膀和四带二的带牌里不能同时有大小王；飞机主体的点数不能再出现在翅膀里（例如 `33334445` 不合法）；对子类的翅膀不能用王。
- 歧义：一组牌可能有多种牌型解释时，可以在出牌请求里用 `pattern` 指定（只需 `type`）。不指定时，跟牌取能压过上家的解释，首出取主体最长、点数最大的解释。
- 计分：底分 = 叫分，每个炸弹或王炸 ×2，春天或反春 ×2。地主得失 2 倍，两个农民各得失 1 倍，三家之和为 0。
- 计时：叫分 10 秒，出牌 20 秒（房间可配置）。超时由系统代出：叫分时不叫，跟牌时不出，首出时出最小的单张。连续 3 次超时进入托管，此后时限缩短为 2 秒，直到你自己成功出一次牌。同一回合非法请求超过 5 次，立即按超时处理。

## 4. HTTP 接口

所有路径以 `/api/v1` 开头。

### 账号

| 方法 | 路径 | 认证 | 请求 | 响应 |
|---|---|---|---|---|
| POST | `/bots` | 否 | `{"name", "invite_code"}` | `201 {"bot_id","name","kind":"bot","token"}` |
| POST | `/guests` | 否 | `{"name"}` | `201 {"bot_id","name","kind":"human","token"}`，网页真人玩家用 |
| GET | `/me` | 是 | — | `{"bot_id","name","kind","room_id","seat","game_id"}` |

`name`：1–24 个字符，字母、数字、中文、`-`、`_`。

### 房间

| 方法 | 路径 | 认证 | 请求 | 响应 |
|---|---|---|---|---|
| GET | `/rooms` | 否 | — | `{"rooms":[Room]}` |
| POST | `/rooms` | 是 | `{"name"?, "config"?}` | `201 Room` |
| GET | `/rooms/{rid}` | 否 | — | `{"room":Room, "game":PublicGame或null, "seq":房间最新事件序号}` |
| POST | `/rooms/quick-join` | 是 | — | `{"room":Room, "seat"}` |
| POST | `/rooms/{rid}/join` | 是 | `{"seat"?}` | `{"room":Room, "seat"}` |
| POST | `/rooms/{rid}/leave` | 是 | — | `{"ok":true}` |
| POST | `/rooms/{rid}/ready` | 是 | `{"ready"?: true}` | `{"room":Room}` |

`POST /rooms` 只建房，不会让创建者入座，创建者需要再调用 `/join`。一个 bot 同一时间只能坐在一个房间。两局之间离开房间会立即释放座位，并取消自动开下一局。三个座位都有人且都已准备时开局。`config.auto_restart` 为 `true`（默认）时，一局结束 3 秒后自动开下一局，不需要再次准备。对局中离开房间，你的座位进入托管直到本局结束。房间空置 10 分钟后自动关闭。

`Room`：

```json
{
  "id": "r_ab12cd", "name": "room-1", "status": "waiting | playing",
  "seats": [{"seat":0,"bot_id":"b_x","name":"alpha","kind":"bot","ready":true,"connected":true,"trustee":false,"score":12}, null, null],
  "spectators": 3, "game_id": "g_xxx 或 null", "games_played": 7,
  "config": {"bid_timeout_ms":10000, "play_timeout_ms":20000, "legal_moves_api":true, "auto_restart":true}
}
```

`seats[i].score` 是该座位在本房间的累计得分。

### 牌局

| 方法 | 路径 | 认证 | 请求 | 响应 |
|---|---|---|---|---|
| GET | `/games/{gid}/state` | 是（该局玩家） | — | `PlayerGame` |
| GET | `/games/{gid}/legal-moves` | 是（该局玩家） | — | `{"moves":[{"cards","pattern"}],"can_pass"}` |
| POST | `/games/{gid}/bid` | 是 | `{"score":0..3, "seq"?}` | `{"ok":true,"seq"}` |
| POST | `/games/{gid}/play` | 是 | `{"cards":[...], "pattern"?:{"type"}, "seq"?}` | `{"ok":true,"seq","pattern"}` |
| GET | `/games/{gid}` | 否 | — | `PublicGame`（进行中或已结束都可） |
| GET | `/games/{gid}/replay` | 否 | — | `Replay`（仅已结束） |
| GET | `/games?limit=20&bot_id=` | 否 | — | `{"games":[GameSummary]}` |
| GET | `/leaderboard` | 否 | — | `{"bots":[{"bot_id","name","games","wins","landlord_games","landlord_wins","score","timeouts"}]}` |

牌局结束后，对它调用 `/state`、`/bid`、`/play` 返回 `409 WRONG_PHASE`，请改用 `/games/{gid}` 或 `/replay`。

`seq`（可选但推荐）：填你收到的最新事件的 `seq`。如果它小于当前回合 `turn` / `bid.turn` 事件的 `seq`，说明你是基于旧状态做的决定，服务端返回 `409 STALE_SEQ`。这样网络重试不会导致重复出牌。

`PublicGame`（围观视角，没有手牌）：

```json
{
  "game_id": "g_xxx", "room_id": "r_xxx", "phase": "bidding | playing | finished",
  "players": [{"seat":0,"bot_id":"b_x","name":"alpha"}, ...],
  "first_bidder": 1, "bids": [{"seat":1,"score":2}], "high_bid": 2,
  "landlord": 1, "bottom": ["3S","BJ","2H"],
  "turn": 2, "deadline": 1731686400000, "remaining_ms": 15320,
  "to_beat": {"seat":1,"cards":["5S","5H"],"pattern":{"type":"pair","rank":"5","length":1}},
  "can_pass": true,
  "cards_left": [17, 18, 15], "multiplier": 2,
  "history": [{"seat":1,"cards":["5S","5H"],"pattern":{...}}, {"seat":2,"cards":[],"pattern":null}],
  "result": null, "seq": 42, "turn_seq": 40
}
```

- 叫分阶段 `landlord`、`bottom` 为 `null`。`to_beat` 为 `null` 表示轮到的人首出。
- `history` 里 `cards: []` 表示不出。

`GameSummary`：`{"game_id","room_id","players":[{"seat","bot_id","name","kind"}],"result","started_at","finished_at"}`。

`played` 事件里的 `cards_left` 和 `PublicGame.cards_left` 一样，是长度为 3 的数组。

`PlayerGame` = `PublicGame` + `{"seat": 你的座位, "hand": [你的手牌]}`。

`Replay` = `PublicGame` + `{"seed", "initial_hands": [[...],[...],[...]], "events": [Event...]}`。`initial_hands` 是发牌时的 17 张，不含底牌。

`result`：

```json
{"kind":"win | nobid", "winner":"landlord | farmers | null", "winner_seat":0, "landlord":1,
 "base":2, "bombs":1, "spring":false, "anti_spring":false, "multiplier":2, "scores":[4,-8,4]}
```

连续 3 次三人都不叫时，牌局以 `kind: "nobid"` 结束：`winner`、`winner_seat`、`landlord` 为 `null`，`base`、`multiplier` 为 0，`scores` 为 `[0,0,0]`。

### 错误

```json
{"error": {"code": "CANNOT_BEAT", "message": "pair(5) cannot beat pair(7)", "details": {...}}}
```

| HTTP | code |
|---|---|
| 400 | `BAD_REQUEST` 请求格式错 · `UNKNOWN_CARD` 牌编码不存在 · `BAD_BID` 叫分不是 0–3 |
| 401 | `UNAUTHORIZED` 缺少或无效 token |
| 403 | `BAD_INVITE` 邀请码错误 · `NOT_A_PLAYER` 不是该局玩家 · `LEGAL_MOVES_DISABLED` 房间关闭了合法出牌接口 |
| 404 | `NOT_FOUND` 房间或牌局不存在 |
| 409 | `NAME_TAKEN` · `ROOM_FULL` · `SEAT_TAKEN` · `ALREADY_IN_ROOM` · `NOT_IN_ROOM` · `WRONG_PHASE` · `NOT_YOUR_TURN` · `STALE_SEQ` · `GAME_IN_PROGRESS` |
| 422 | `BID_TOO_LOW` · `CARDS_NOT_IN_HAND` · `MUST_PLAY` 首出不能不出 · `INVALID_PATTERN` 不成牌型 · `CANNOT_BEAT` 压不过 |
| 429 | `RATE_LIMITED` 每个 bot 平均每秒最多 50 次请求（HTTP 和 WebSocket 出牌合计），瞬时最多 100 次 |

非法出牌不会结束你的回合，可以在截止时间内修正后重试。

## 5. WebSocket

- 玩家：`/ws?token=<token>&since=<seq>`。自动跟随你当前所在的房间，入座后开始收到该房间的事件。
- 围观：`/ws/spectate?room=<rid>&since=<seq>`。
- `since` 可选：断线重连时填最后收到的 `seq`，服务端补发之后的事件。如果补发范围已超出缓存，服务端发 `{"type":"resync"}`，请调用 `/games/{gid}/state` 重建状态。
- 服务端每 20 秒发一次 WebSocket ping；也可以发 `{"op":"ping"}`，服务端回 `{"type":"pong"}`。

### 服务端推送

每条消息：`{"type", "seq", "ts", "room_id", "game_id", "data"}`。`seq` 在房间内单调递增（跨局连续）。

| type | data | 说明 |
|---|---|---|
| `hello` | `{"bot_id"?, "room_id", "seq"}` | 连接建立或入座时发送；顶层 `seq` 为 `null`，`data.seq` 是房间当前的最新序号 |
| `room.updated` | `{"room": Room}` | 入座、离开、准备、托管、连接状态变化 |
| `game.started` | `{"players", "first_bidder", "cards_left", "hand"?}` | `hand` 只发给对应玩家 |
| `bid.turn` | `{"seat", "deadline", "remaining_ms", "high_bid"}` | 轮到某人叫分 |
| `bid.made` | `{"seat", "score", "auto"}` | `auto` 为 true 表示超时代叫 |
| `landlord.decided` | `{"landlord", "bottom", "high_bid"}` | 底牌公开 |
| `turn` | `{"seat", "deadline", "remaining_ms", "to_beat", "can_pass"}` | 轮到某人出牌 |
| `played` | `{"seat", "cards", "pattern", "cards_left", "multiplier", "auto"}` | |
| `passed` | `{"seat", "auto"}` | |
| `redeal` | `{"count"}` | 三人都不叫，重新发牌。此事件的 `game_id` 是旧牌局；随后的 `game.started` 带新的 `game_id`，之后的请求都要用新的 |
| `game.finished` | `{"result", "hands", "seed"}` | `hands` 是三家剩余手牌 |

bot 的主循环只需要处理两个事件：`bid.turn` 和 `turn`，并且 `data.seat` 等于自己的座位时行动。

### 通过 WebSocket 出牌（可选）

```json
{"op":"bid",  "req_id":"1", "game_id":"g_xxx", "score":2, "seq":40}
{"op":"play", "req_id":"2", "game_id":"g_xxx", "cards":["5S","5H"], "seq":42}
```

服务端回复 `{"type":"reply", "req_id":"2", "status":200, "body":{...}}`，`status` 和 `body` 与对应的 HTTP 接口一致。

## 6. 用任意语言实现 bot

### 6.1 你需要的能力

- 一个 HTTP 客户端（发 JSON、读状态码）。
- 一个 WebSocket 客户端（收文本帧，每帧是一个 JSON 对象）。
- 斗地主规则：至少要能判断"手里哪些牌能压过 `to_beat`"。房间开启 `legal_moves_api` 时（默认开启）可以先调 `/legal-moves` 偷懒，但正式比赛可能关闭它，届时需要自己实现。可移植的参考实现有两份：[`sdk/python/ddz_sdk/rules.py`](https://github.com/childe/ddz-arena/blob/main/sdk/python/ddz_sdk/rules.py) 和 [`packages/engine/src/patterns.ts`](https://github.com/childe/ddz-arena/blob/main/packages/engine/src/patterns.ts) + [`moves.ts`](https://github.com/childe/ddz-arena/blob/main/packages/engine/src/moves.ts)。

### 6.2 生命周期

```
注册 POST /bots ──▶ 保存 token（以后直接复用，不要每次重新注册）
      │
连接 WS /ws?token=...            ← 先连 WebSocket，再入座，避免漏掉开局事件
      │
入座 POST /rooms/quick-join  或  POST /rooms/{rid}/join   → 记下 room.id 和 seat
      │
准备 POST /rooms/{rid}/ready
      │
      ▼
事件循环（一直运行，房间默认自动连续开局）
```

### 6.3 主循环伪代码

```text
my_seat = 入座接口返回的 seat
last_seq = 0
hand = []

on_message(ev):
    if ev.seq 是数字:
        if ev.seq <= last_seq: return          # 重连补发时可能重复，丢弃
        last_seq = ev.seq

    switch ev.type:
        "game.started":
            hand = ev.data.hand                 # 只有自己能收到自己的手牌
        "landlord.decided":
            if ev.data.landlord == my_seat:
                hand += ev.data.bottom          # 地主拿底牌
        "played":
            if ev.data.seat == my_seat:
                hand -= ev.data.cards           # 包括超时被系统代出的牌（auto=true）
        "bid.turn":
            if ev.data.seat == my_seat:
                score = 决定叫分(hand, ev.data.high_bid)          # 0 或大于 high_bid 的 1..3
                POST /games/{ev.game_id}/bid  {"score": score, "seq": ev.seq}
        "turn":
            if ev.data.seat == my_seat:
                cards = 决定出牌(hand, ev.data.to_beat)           # [] 表示不出；to_beat 为 null 时必须出牌
                resp = POST /games/{ev.game_id}/play  {"cards": cards, "seq": ev.seq}
                if resp.status == 422:
                    # 规则判断有误：回合没有结束，可以修正后重试（同一回合最多 5 次）
                    出一个保底动作：能不出就不出，否则出最小的单张
        "resync":
            state = GET /games/{gid}/state      # 用返回的 hand、turn、to_beat 重建状态

on_close():
    等待 0.5s、1s、2s…（最多 15s）后重连 /ws?token=...&since={last_seq}
```

要点：

- 只在 `data.seat == my_seat` 时行动，其他人的 `turn` 只用于记牌。
- 出牌请求带上 `seq`（取触发它的 `turn` / `bid.turn` 事件的 `seq`），网络重试时不会重复出牌。
- 手牌以服务端为准：拿不准时调 `GET /games/{gid}/state`，返回里有 `hand`。
- 不要依赖 HTTP 出牌接口的返回来推进状态，统一以 WebSocket 推送的 `played` / `passed` 为准。

### 6.4 一段真实的消息记录

以下是 `examples/node/bot.mjs` 坐在 0 号座位时的实际收发记录（省略了 `room.updated` 等无关事件，部分字段截断）。`→` 是 bot 发出的 HTTP 请求，`←` 是 WebSocket 推送。

```text
→ POST /api/v1/bots {"name":"alice","invite_code":"..."}
  201 {"bot_id":"b_aae8fd07","name":"alice","kind":"bot","token":"ddz_cX6q..."}
← hello {"bot_id":"b_aae8fd07","room_id":null,"seq":0}
→ POST /api/v1/rooms/quick-join
  200 {"room":{"id":"r_1a20b2",...},"seat":0}
→ POST /api/v1/rooms/r_1a20b2/ready {"ready":true}
  200 {"room":{...}}
  …另外两个 bot 入座并准备…
← game.started {"players":[...],"first_bidder":1,"cards_left":[17,17,17],"hand":["4S","4H","4C","5S",...,"RJ"]}
← bid.turn  {"seat":1,"deadline":1794760218271,"remaining_ms":10000,"high_bid":0}
← bid.made  {"seat":1,"score":1,"auto":false}
← bid.turn  {"seat":2,...,"high_bid":1}
← bid.made  {"seat":2,"score":0,"auto":false}
← bid.turn  {"seat":0,...,"high_bid":1}                       seq=13，轮到我
→ POST /api/v1/games/g_0e5f362d505b/bid {"score":0,"seq":13}
  200 {"ok":true,"seq":14}
← bid.made  {"seat":0,"score":0,"auto":false}
← landlord.decided {"landlord":1,"bottom":["8C","QH","BJ"],"high_bid":1}
← turn   {"seat":1,"remaining_ms":20000,"to_beat":null,"can_pass":false}
← played {"seat":1,"cards":["3C","3D"],"pattern":{"type":"pair","rank":"3","length":1},"cards_left":[17,18,17],"multiplier":1,"auto":false}
← turn   {"seat":2,...}
← played {"seat":2,"cards":["5C","5D"],"pattern":{"type":"pair","rank":"5","length":1},...}
← turn   {"seat":0,"remaining_ms":20000,"to_beat":{"seat":2,"cards":["5C","5D"],"pattern":{"type":"pair","rank":"5","length":1}},"can_pass":true}   seq=20
→ POST /api/v1/games/g_0e5f362d505b/play {"cards":["6S","6D"],"seq":20}
  200 {"ok":true,"seq":21,"pattern":{"type":"pair","rank":"6","length":1}}
← played {"seat":0,"cards":["6S","6D"],...,"cards_left":[15,18,15]}
  …
← game.finished {"result":{"kind":"win","winner":"farmers","landlord":1,"scores":[2,-4,2],...},"hands":[[],[...],[...]],"seed":"..."}
```

### 6.5 上线前自检

- [ ] token 保存在本地，重启程序不重新注册。
- [ ] 先连 WebSocket 再入座。
- [ ] 断线后带 `since` 重连，并能处理 `resync`。
- [ ] 收到重复 `seq` 时丢弃。
- [ ] 首出（`to_beat` 为 `null`）时一定出牌，不会发 `cards: []`。
- [ ] 遇到 422 不会卡住，有保底动作；遇到 429 稍等 100ms 再试。
- [ ] 每步在时限内完成（叫分 10 秒、出牌 20 秒），留出网络往返时间。
- [ ] 在网页 `#/room/<房间号>` 围观自己的对局，确认行为符合预期。
