# ddz-sdk：斗地主 Bot 对战平台 Python SDK

用这个 SDK 写一个斗地主 bot，只需要实现两个方法：`on_bid`（叫几分）和 `on_play`（出什么牌）。连接、断线重连、入座、准备、状态跟踪、出错兜底都由 SDK 处理。

- Python ≥ 3.9，唯一运行时依赖是 `websocket-client`，HTTP 用标准库 `urllib`。
- `ddz_sdk.rules` 是服务端规则引擎的纯 Python 移植，可以在本地判断牌型、生成合法出牌。正式比赛房间可能关闭 `/legal-moves` 接口，用它就不依赖这个接口。
- 协议细节以 [`docs/api.md`](../../docs/api.md) 为准。

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

下文用 `BASE=http://43.128.99.230` 作为服务地址；本地起服务时换成 `http://localhost:8080`。

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

3. 一个人凑不齐三家时，用 `run_three.py` 注册 3 个 bot，坐进同一个房间打 N 局，打完打印比分和排行榜：

   ```bash
   python examples/run_three.py --base $BASE --games 5 --invite 邀请码
   ```

   可选参数：`--bots greedy,greedy,random` 指定三家的策略；`--chaos 2` 每 2 秒随机断开一个 bot 的 WebSocket，用来验证断线重连；`-v` 打印 SDK 日志。

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


MyBot().run("http://43.128.99.230", token)              # 快速入座
# MyBot().run(base, token, room_id="r_ab12cd")               # 加入指定房间
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
| `seat` | 你的座位 0/1/2，出牌顺序 0→1→2→0 |
| `hand` | 你的手牌，升序；当地主后已包含底牌 |
| `phase` | `waiting` / `bidding` / `playing` / `finished` |
| `high_bid`、`bids`、`first_bidder` | 叫分信息 |
| `landlord`、`bottom` | 地主座位和底牌，叫分阶段为 `None` / `[]` |
| `to_beat` | 要压的牌 `{"seat","cards","pattern"}`；`None` 表示你首出 |
| `can_pass` | 能否不出 |
| `cards_left` | 三家剩余张数 |
| `history` | 出牌记录，`cards: []` 表示不出 |
| `multiplier`、`remaining_ms`、`game_id`、`room_id`、`seq` | 其他信息 |

辅助方法和属性：`state.legal_moves()`、`state.to_beat_pattern`（`Pattern` 对象）、`state.is_landlord`、`state.leading`、`state.teammates()`、`state.is_teammate(seat)`。

### SDK 替你处理的事

- 入座：`room_id=None` 时快速入座；已经坐在某个房间时直接沿用。入座后自动准备；房间关闭 `auto_restart` 时，每局结束后也会自动重新准备。
- WebSocket：断线后按 0.5 秒到 10 秒的退避间隔重连，带上 `since=<最后收到的 seq>` 补发漏掉的事件；收到 `resync` 时调用 `GET /games/{gid}/state` 重建状态；30 秒没有收到任何推送时，也会主动拉一次状态。
- 行动时机：只在 `bid.turn` / `turn` 事件的 `data.seat` 等于你的座位时调用钩子，每个回合只行动一次；请求里带上 `seq`，服务端可以拒绝基于旧状态的决定（`409 STALE_SEQ`）。
- 兜底：钩子抛异常，或者返回的牌在本地校验不合法时，SDK 不发这个请求，直接改用安全动作：叫分时叫 0；出牌时能不出就不出，首出时出最小的单张。服务端返回 422 时同样改用安全动作，再失败就拉取最新状态重试，保证不会卡住。
- 限流：收到 `429 RATE_LIMITED` 时等待约 100 毫秒后重试，最多重试 5 次。
- 统计：`bot.stats` 记录兜底次数、重连次数、被服务端代打（`auto`）的次数；`bot.api_errors` 记录各类错误码出现的次数。

用 `logging.basicConfig(level=logging.INFO)` 可以看到 SDK 日志。

## 只用 HTTP 客户端

```python
from ddz_sdk import Client, ApiError

c = Client("http://43.128.99.230", token)
print(c.me())
room = c.quick_join()["room"]
c.ready(room["id"])
try:
    c.play(game_id, ["5S", "5H"], seq=42)
except ApiError as e:
    print(e.status, e.code, e.message, e.details)   # 例如 422 CANNOT_BEAT
```

`Client` 为 api.md 里的每个 HTTP 接口都提供了一个方法：`register_bot`、`register_guest`、`me`、`list_rooms`、`create_room`、`get_room`、`quick_join`、`join_room`、`leave_room`、`ready`、`game_state`、`legal_moves`、`bid`、`play`（`pass_turn`）、`get_game`、`replay`、`list_games`、`leaderboard`。非 2xx 响应抛出 `ApiError(status, code, message, details)`；网络错误的 `status` 为 0，`code` 为 `NETWORK_ERROR`。

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

## 开发

```bash
cd sdk/python
pytest tests                    # 规则、客户端、bot 状态机的离线测试
black .
```
