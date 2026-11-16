# ddz-sdk：斗地主 / 德州扑克 Bot 对战平台 Python SDK

平台支持三种游戏：三人斗地主（`ddz`）、四人斗地主（`ddz4`）和无限注德州扑克（`holdem`）。用这个 SDK 写斗地主 bot，只需要实现两个方法：`on_bid`（叫几分）和 `on_play`（出什么牌），三人和四人用同一个 `Bot` 类；写德州扑克 bot 只需要实现 `on_action`（弃牌、过牌、跟注还是加注）。连接、断线重连、入座、准备、状态跟踪、出错兜底都由 SDK 处理。

- Python ≥ 3.9，唯一运行时依赖是 `websocket-client`，HTTP 用标准库 `urllib`。
- `ddz_sdk.rules`（三人）和 `ddz_sdk.rules4`（四人）是服务端斗地主规则引擎的纯 Python 移植，可以在本地判断牌型、生成合法出牌。正式比赛房间可能关闭 `/legal-moves` 接口，用它们就不依赖这个接口。`ddz_sdk.holdem` 是德州扑克 7 选 5 牌力评估的移植，分数和服务端摊牌结果里的 `score` 完全一致。
- 协议细节以 [`docs/api.md`](../../docs/api.md) 为准，第 8、9 节分别是四人斗地主和德州扑克。

## 安装

```bash
pip install "git+https://github.com/childe/ddz-arena.git#subdirectory=sdk/python"
```

需要改 SDK 或跑测试时，从源码安装：

```bash
git clone https://github.com/childe/ddz-arena.git && cd ddz-arena/sdk/python
pip install -e .            # 或：uv pip install -e .
pip install pytest          # 可选，跑测试用
```

## 5 分钟上手

下文用 `BASE=https://ddz.ohmycat.me` 作为服务地址；本地起服务时换成 `http://localhost:8080`。

1. 注册 bot，保存 token（token 只返回一次）：

   ```bash
   python -c "from ddz_sdk import register_bot; print(register_bot('$BASE', 'my-bot', '邀请码'))"
   ```

   服务端没有设置邀请码时，第三个参数省略。

2. 运行示例 bot（快速入座，有空位就坐，没有就新建房间）：

   ```bash
   python examples/greedy_bot.py --base $BASE --token <你的token>
   ```

   想直接注册并运行：`python examples/greedy_bot.py --base $BASE --register my-bot --invite 邀请码`。

3. 一个人凑不齐一桌时，用 `run_table.py` 注册 N 个 bot，坐进同一个房间打 K 局，打完打印比分和排行榜：

   ```bash
   python examples/run_table.py --base $BASE --game ddz    --games 5  --invite 邀请码   # 三人斗地主
   python examples/run_table.py --base $BASE --game ddz4   --games 5  --invite 邀请码   # 四人斗地主
   python examples/run_table.py --base $BASE --game holdem --players 6 --games 20 --invite 邀请码
   ```

   `--players` 默认等于一桌的座位数（`ddz` 3、`ddz4` 4、`holdem` 6，德州扑克可以是 2–6）。可选参数：`--bots` 指定策略，按座位轮流使用（斗地主 `greedy` / `random`，德州扑克 `simple` / `random`）；`--chaos 2` 每 2 秒随机断开一个 bot 的 WebSocket，用来验证断线重连；`--strict` 在出现兜底、处理异常、被服务端代打或状态不一致时以非 0 退出码结束；`-v` 打印 SDK 日志。每局结束时脚本会把 SDK 跟踪的状态和服务端公开的结果对比（斗地主比剩余手牌，德州扑克比摊牌分数），不一致时打印 `MISMATCH`。

   旧的 `run_three.py`（固定三人斗地主）仍然可用。

4. 打开网页围观房间，或者调用 `GET /api/v1/leaderboard` 查看排行榜。

## 写自己的 bot

```python
from ddz_sdk import Bot, GameState


class MyBot(Bot):
    def on_bid(self, state: GameState) -> int:
        # 返回 0（不叫）或 1–3，必须大于 state.high_bid
        return 3 if "RJ" in state.hand and "BJ" in state.hand else 0

    def on_play(self, state: GameState):
        moves = state.legal_moves()          # 本地生成的合法出牌（不含"不出"）
        if not moves:
            return []                        # 空列表 = 不出
        return min(moves, key=lambda m: m.pattern.main).cards


MyBot().run("https://ddz.ohmycat.me", token)              # 快速入座（三人斗地主）
# MyBot().run(base, token, game="ddz4")                      # 快速入座四人斗地主
# MyBot().run(base, token, room_id="r_ab12cd")               # 加入指定房间（三人或四人都行）
# MyBot().run(base, token, max_games=10)                     # 打 10 局后退出
```

`on_play` 也可以返回一个 `Move`（`state.legal_moves()` 的元素）。这时 SDK 会把 `move.pattern.type` 作为 `pattern` 一起发给服务端，用于消除歧义，例如 `333444555666` 既可以是飞机，也可以是飞机带单。

可选的钩子：

| 方法 | 调用时机 |
|---|---|
| `on_event(event)` | 每条 WebSocket 推送，SDK 更新完 `self.state` 之后 |
| `on_game_over(result)` | `game.finished`，参数是 `result` 对象（见 api.md） |

### `GameState` 字段

| 字段 | 含义 |
|---|---|
| `game` | `ddz` 或 `ddz4` |
| `seat` | 你的座位，三人 0–2、四人 0–3，出牌顺序 0→1→…→0 |
| `hand` | 你的手牌，升序；当地主后已包含底牌。四人斗地主里同一张牌可能出现两次 |
| `phase` | `waiting` / `bidding` / `playing` / `finished` |
| `high_bid`、`bids`、`first_bidder` | 叫分信息 |
| `landlord`、`bottom` | 地主座位和底牌，叫分阶段为 `None` / `[]` |
| `to_beat` | 要压的牌 `{"seat","cards","pattern"}`；`None` 表示你首出 |
| `can_pass` | 能否不出 |
| `cards_left` | 每家剩余张数（三人 3 个元素，四人 4 个） |
| `history` | 出牌记录，`cards: []` 表示不出 |
| `multiplier`、`remaining_ms`、`game_id`、`room_id`、`seq` | 其他信息 |

辅助方法和属性：`state.legal_moves()`、`state.to_beat_pattern`（`Pattern` 对象）、`state.is_landlord`、`state.leading`、`state.teammates()`、`state.is_teammate(seat)`、`state.next_seat()`、`state.num_seats`、`state.is_ddz4`、`state.resolve(cards)`。`legal_moves()` 和 `resolve()` 按房间的游戏类型选用三人或四人规则。

### SDK 替你处理的事

- 入座：`room_id=None` 时按 `game` 参数快速入座（`Bot` 默认三人斗地主，`HoldemBot` 默认德州扑克）；已经坐在同类型的房间时直接沿用。入座后自动准备；房间关闭 `auto_restart` 时，每局结束后也会自动重新准备。
- 游戏类型：从入座接口、`room.updated` 推送和 `/games/{gid}/state` 里的 `game` 字段读取，断线重连和 `resync` 之后同样有效；`game.started` 的 `cards_left` 有 4 个元素时也会识别为四人斗地主。房间类型和 bot 类不匹配时（例如用 `Bot` 进德州扑克房间），`run` 离开房间并抛出 `ValueError`。
- WebSocket：断线后按 0.5 秒到 10 秒的退避间隔重连，带上 `since=<最后收到的 seq>` 补发漏掉的事件；收到 `resync` 时调用 `GET /games/{gid}/state` 重建状态；30 秒没有收到任何推送时，也会主动拉一次状态。
- 行动时机：只在 `bid.turn` / `turn` 事件的 `data.seat` 等于你的座位时调用钩子，每个回合只行动一次；请求里带上 `seq`，服务端可以拒绝基于旧状态的决定（`409 STALE_SEQ`）。
- 兜底：钩子抛异常，或者返回的牌在本地校验不合法时，SDK 不发这个请求，直接改用安全动作：叫分时叫 0；出牌时能不出就不出，首出时出最小的单张。服务端返回 422 时同样改用安全动作，再失败就拉取最新状态重试，保证不会卡住。
- 限流：收到 `429 RATE_LIMITED` 时等待约 100 毫秒后重试，最多重试 5 次。
- 统计：`bot.stats` 记录兜底次数、重连次数、被服务端代打（`auto`）的次数；`bot.api_errors` 记录各类错误码出现的次数。

用 `logging.basicConfig(level=logging.INFO)` 可以看到 SDK 日志。

## 只用 HTTP 客户端

```python
from ddz_sdk import Client, ApiError

c = Client("https://ddz.ohmycat.me", token)
print(c.me())
room = c.quick_join()["room"]
c.ready(room["id"])
try:
    c.play(game_id, ["5S", "5H"], seq=42)
except ApiError as e:
    print(e.status, e.code, e.message, e.details)   # 例如 422 CANNOT_BEAT
```

`Client` 为 api.md 里的每个 HTTP 接口都提供了一个方法：`register_bot`、`register_guest`、`me`、`list_rooms`、`create_room`、`get_room`、`quick_join`、`join_room`、`leave_room`、`ready`、`game_state`、`legal_moves`、`bid`、`play`（`pass_turn`）、`action`（德州扑克下注）、`get_game`、`replay`、`list_games`、`leaderboard`。非 2xx 响应抛出 `ApiError(status, code, message, details)`；网络错误的 `status` 为 0，`code` 为 `NETWORK_ERROR`。

和游戏类型有关的参数都是可选的，不传时等于 `ddz`，旧代码不用改：

```python
c.create_room("周五牌局", {"seats": 6}, game="holdem")   # 建德州扑克房间，6 个座位
c.quick_join(game="ddz4")                                # 只进四人斗地主房间
c.leaderboard(game="holdem")                             # 德州扑克排行榜
c.list_games(limit=20, game="ddz4")                      # 最近的四人斗地主对局
c.list_games(limit=100, room_id="r_ab12cd")             # 某个房间的历史对局
c.action(game_id, "raise", 12, seq=42)                   # 加注到本轮总额 12
c.action(game_id, "call", seq=42)                        # fold / check / call 不需要 amount
```

## 规则库 `ddz_sdk.rules`

```python
from ddz_sdk.rules import identify, resolve, beats, legal_moves, Pattern
from ddz_sdk.cards import parse_short, sort_cards, rank_counts

identify(["3S", "3H", "3C", "4S"])          # [Pattern(type='triple_single', main=0, length=1)]
resolve(parse_short("333444555666"))        # 首出时服务端采用的解释：plane, length=4
beats(Pattern.from_api({"type": "bomb", "rank": "3"}), {"type": "pair", "rank": "2"})  # True
legal_moves(hand, state.to_beat_pattern)    # 能压过上家的所有出牌
```

`Pattern.main` 是点数的整数值：`3`..`A` 为 0..11，`2` 为 12，小王 13，大王 14。`pattern.rank` 和 `pattern.to_api()` 给出 api.md 里用的字符串形式。`legal_moves` 与服务端 `packages/engine/src/moves.ts` 的算法一致；测试会用穷举子集的方式对比两者的结果。

## 四人斗地主（`ddz4`）

接口和事件与三人斗地主相同，所以直接用 `Bot`：

```python
MyBot().run(base, token, game="ddz4")            # 快速入座四人斗地主
MyBot().run(base, token, room_id="r_ab12cd")     # 加入指定房间，类型自动识别
```

规则差异（详见 api.md 第 8 节）：两副牌 108 张，每人 25 张、底牌 8 张，地主 33 张；同一张牌最多 2 张，出牌可以写 `["3S", "3S"]`；炸弹 4–8 张，`Pattern.length` 是张数；王炸是 4 张王（`length` 4）；`BJ BJ`、`RJ RJ` 是对子；没有四带二。`state.legal_moves()` 在四人房间里自动使用 `ddz_sdk.rules4`，规则也可以单独使用：

```python
from ddz_sdk.rules4 import identify4, resolve4, beats4, legal_moves4
from ddz_sdk.cards import parse_short

identify4(parse_short("33333"))                 # [Pattern(type='bomb', main=0, length=5)]
identify4(["BJ", "BJ"])                         # [Pattern(type='pair', main=13, length=1)]
beats4(identify4(parse_short("XXDD"))[0], identify4(parse_short("22222222"))[0])  # True
legal_moves4(hand, state.to_beat_pattern)       # 能压过上家的所有出牌
```

`parse_short` 给同一点数的第 5–8 张牌依次分配第二副牌的 `S H C D`。`cards.contains_all` 和 `cards.remove_cards` 按多重集合处理（每张重复的牌各算一次），对三人斗地主的结果不变。

## 德州扑克（`holdem`）

继承 `HoldemBot`，实现 `on_action`：

```python
from ddz_sdk import Action, HoldemBot, HoldemState


class MyPokerBot(HoldemBot):
    def on_action(self, state: HoldemState):
        hv = state.hand_value()                      # 翻牌后：(score, rank, best5)
        if hv and hv[1] in ("three_of_a_kind", "straight", "flush", "full_house"):
            amount = state.clamp_raise(state.current_bet + state.pot)
            if amount is not None:
                return Action.raise_to(amount)       # 加注到本轮总额 amount
        if state.can_check:
            return Action.check()
        if state.to_call <= state.big_blind * 2:
            return Action.call()
        return Action.fold()


MyPokerBot().run("https://ddz.ohmycat.me", token)            # 快速入座德州扑克
# MyPokerBot().run(base, token, room_id="r_ab12cd")          # 加入指定的德州扑克房间
# MyPokerBot().run(base, token, max_games=100)               # 打 100 手后退出
```

`on_action` 的返回值可以是以下任意一种：

| 写法 | 含义 |
|---|---|
| `Action.fold()`、`Action.check()`、`Action.call()` | 弃牌、过牌、跟注 |
| `Action.raise_to(12)` 或 `Action("raise", 12)` | 下注或加注，`12` 是本轮你的下注总额（raise-to），不是增加的数额；全下就是 `state.max_raise_to` |
| `("raise", 12)`、`("call", None)` | 元组形式，`fold` / `check` / `call` 的金额被忽略 |
| `"check"` | 只写动作名 |

没有需要跟的注时返回 `call`，SDK 按 `check` 发送。加注额必须是 `min_raise_to` 到 `max_raise_to` 之间的整数，可以用 `state.clamp_raise(x)` 截到合法范围；不能加注时 `clamp_raise` 返回 `None`。

示例 `examples/holdem_bot.py` 有两个策略：`SimpleHoldemBot`（翻牌前按底牌分档，强牌加注、中等牌跟小注；翻牌后按牌力下注、跟注或放弃）和 `RandomHoldemBot`（随机合法动作，用来测试）：

```bash
python examples/holdem_bot.py --base $BASE --token <你的token> [--strategy simple|random] [--room r_xxx]
```

### `HoldemState` 字段

座位相关的列表按房间座位号索引，没参加这手牌的座位为 `None`。

| 字段 | 含义 |
|---|---|
| `seat`、`hole` | 你的座位和 2 张底牌 |
| `board` | 公共牌，0、3、4 或 5 张 |
| `phase` | `waiting` / `preflop` / `flop` / `turn` / `river` / `finished` |
| `players` | 本手牌的参与者 `[{"seat","bot_id","name","kind"}]` |
| `button`、`small_blind_seat`、`big_blind_seat`、`small_blind`、`big_blind` | 庄位和盲注 |
| `pot`、`current_bet` | 底池总额、本轮最高下注 |
| `stacks`、`bets`、`committed` | 每个座位的剩余筹码、本轮下注、本手累计投入 |
| `folded`、`all_in` | 每个座位是否已弃牌、是否已全下 |
| `to_call`、`can_check` | 轮到你时需要补的筹码（0 表示可以过牌）、能否过牌 |
| `min_raise_to`、`max_raise_to` | 加注总额的范围，不能加注时为 `None` |
| `history` | 动作记录 `{"seat","phase","action","amount","all_in"}`，含盲注；`raise` 的 `amount` 是本轮下注总额，`call` 和盲注是补进的筹码 |
| `turn`、`remaining_ms`、`result`、`game_id`、`room_id`、`seq` | 其他信息 |

辅助方法和属性：`state.hand_value()`（翻牌后返回 `evaluate(hole + board)`，翻牌前返回 `None`）、`state.can_raise`、`state.clamp_raise(x)`、`state.pot_odds()`、`state.my_stack`、`state.my_bet`、`state.in_hand`、`state.active_seats()`、`state.opponents()`。

### `HoldemBot` 替你处理的事

生命周期和 `Bot` 一样：先连 WebSocket 再入座，快速入座只进德州扑克房间，入座后自动准备，断线后带 `since` 重连，收到 `resync` 时拉取 `/games/{gid}/state`（其中的 `legal` 字段用来恢复 `to_call`、加注范围），`429` 等待后重试，请求带 `seq`，每个回合只行动一次。另外：

- 一手牌进行中才入座的 bot 不在本手的 `players` 里，`state.in_hand` 为 `False`，SDK 不会调用 `on_action`，从下一手开始参加。
- 兜底：`on_action` 抛异常、返回值不合法（例如面对下注时过牌、加注额超出范围），或者服务端返回 400 / 422 时，SDK 改用安全动作：能过牌就过牌，否则弃牌。`bot.stats["fallbacks"]` 记录兜底次数。
- `on_event(event)`、`on_game_over(result)` 两个钩子与 `Bot` 相同；`result` 的格式见 api.md 第 9.3 节。

### 牌力评估 `ddz_sdk.holdem`

```python
from ddz_sdk.holdem import evaluate, hand_score, compare, HAND_NAMES

evaluate(["AS", "AD", "KC", "KH", "4S", "4D", "2C"])
# (2929152, 'two_pair', ['AS', 'AD', 'KH', 'KC', '4S'])
hand_score(["AH", "2H", "3H", "4H", "5H", "KS", "KD"]) >> 20   # 8，即 straight_flush
compare(hand_a, hand_b)                                       # >0 表示 a 大，0 表示平局
```

`evaluate(cards)` 接受 5–7 张牌，返回 `(score, rank_name, best5)`。`score` 的编码与服务端相同：`牌型序号 << 20` 加上最多 5 个 4 位的点数，越大越强，相等即平局；`best5` 按服务端的顺序排列（先主体后踢脚，A-2-3-4-5 顺子的 A 排最后）。牌型从小到大见 `HAND_NAMES`。

## 开发

```bash
cd sdk/python
pytest tests                    # 规则、客户端、bot 状态机的离线测试
black .
```

`tests/data/engine_fixtures.json` 是 TypeScript 规则引擎（以它为准）对随机手牌算出的参考结果，测试用它逐项核对 `rules4` 和 `holdem` 的移植。引擎规则改动后，在仓库根目录重新生成：

```bash
node --disable-warning=ExperimentalWarning sdk/python/tests/data/gen_fixtures.ts > sdk/python/tests/data/engine_fixtures.json
```
