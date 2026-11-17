"""Python SDK for the card-game bot platform: Dou Dizhu (斗地主, 3 or 4 players), Guandan
(掼蛋), Gongzhu (拱猪) and No-Limit Texas Hold'em.

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

Guandan (``guandan``)::

    from ddz_sdk import GuandanBot, GuandanState

    class MyGuandanBot(GuandanBot):
        def on_return(self, state: GuandanState) -> str:
            return state.returnable_cards()[0]  # smallest card you may give back

        def on_play(self, state: GuandanState):
            if state.to_beat and state.is_teammate(state.to_beat["seat"]):
                return []                     # let the teammate's play stand
            moves = state.legal_moves()       # rules_gd: level, wildcards, straight flushes
            return min(moves, key=lambda m: m.pattern.main) if moves else []

    MyGuandanBot().run("http://localhost:8080", token)        # quick-join a guandan room

Gongzhu (``gongzhu``)::

    from ddz_sdk import GongzhuBot, GongzhuState

    class MyGongzhuBot(GongzhuBot):
        def choose_expose(self, state: GongzhuState):
            return []                         # expose nothing

        def choose_card(self, state: GongzhuState) -> str:
            return state.legal_cards()[0]     # follow suit, exposed-card lock applied

    MyGongzhuBot().run("http://localhost:8080", token)        # quick-join a gongzhu room

Texas Hold'em (``holdem``)::

    from ddz_sdk import Action, HoldemBot, HoldemState

    class MyPokerBot(HoldemBot):
        def on_action(self, state: HoldemState):
            return Action.check() if state.can_check else Action.call()

    MyPokerBot().run("http://localhost:8080", token)
"""

from .bot import Bot, GameState
from .client import ApiError, Client, register_bot
from .gongzhu_bot import GongzhuBot, GongzhuState
from .guandan_bot import GuandanBot, GuandanState
from .holdem import evaluate
from .holdem_bot import Action, HoldemBot, HoldemState
from .rules import Move, Pattern, RuleError, beats, identify, legal_moves, resolve
from .rules4 import beats4, identify4, legal_moves4, resolve4
from .rules_gd import GdPattern, beats_gd, identify_gd, legal_moves_gd, resolve_gd
from .rules_gz import legal_cards, score_taken, trick_winner

__all__ = [
    "Action",
    "ApiError",
    "Bot",
    "Client",
    "GameState",
    "GdPattern",
    "GongzhuBot",
    "GongzhuState",
    "GuandanBot",
    "GuandanState",
    "HoldemBot",
    "HoldemState",
    "Move",
    "Pattern",
    "RuleError",
    "beats",
    "beats4",
    "beats_gd",
    "evaluate",
    "identify",
    "identify4",
    "identify_gd",
    "legal_cards",
    "legal_moves",
    "legal_moves4",
    "legal_moves_gd",
    "register_bot",
    "resolve",
    "resolve4",
    "resolve_gd",
    "score_taken",
    "trick_winner",
]
__version__ = "0.4.0"
