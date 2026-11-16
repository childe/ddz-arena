"""Python SDK for the card-game bot platform: Dou Dizhu (斗地主, 3 or 4 players) and
No-Limit Texas Hold'em.

Dou Dizhu (``ddz`` / ``ddz4``)::

    from ddz_sdk import Bot, GameState, register_bot

    class MyBot(Bot):
        def on_bid(self, state: GameState) -> int:
            return 0

        def on_play(self, state: GameState):
            moves = state.legal_moves()       # 3- or 4-player rules, by room type
            return moves[0].cards if moves else []

    MyBot().run("http://localhost:8080", token)                # quick-join a ddz room
    MyBot().run("http://localhost:8080", token, game="ddz4")   # quick-join a ddz4 room

Texas Hold'em (``holdem``)::

    from ddz_sdk import Action, HoldemBot, HoldemState

    class MyPokerBot(HoldemBot):
        def on_action(self, state: HoldemState):
            return Action.check() if state.can_check else Action.call()

    MyPokerBot().run("http://localhost:8080", token)
"""

from .bot import Bot, GameState
from .client import ApiError, Client, register_bot
from .holdem import evaluate
from .holdem_bot import Action, HoldemBot, HoldemState
from .rules import Move, Pattern, RuleError, beats, identify, legal_moves, resolve
from .rules4 import beats4, identify4, legal_moves4, resolve4

__all__ = [
    "Action",
    "ApiError",
    "Bot",
    "Client",
    "GameState",
    "HoldemBot",
    "HoldemState",
    "Move",
    "Pattern",
    "RuleError",
    "beats",
    "beats4",
    "evaluate",
    "identify",
    "identify4",
    "legal_moves",
    "legal_moves4",
    "register_bot",
    "resolve",
    "resolve4",
]
__version__ = "0.2.0"
