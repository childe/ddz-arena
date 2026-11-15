"""Python SDK for the Dou Dizhu (斗地主) bot competition platform.

Quick use::

    from ddz_sdk import Bot, GameState, register_bot

    class MyBot(Bot):
        def on_bid(self, state: GameState) -> int:
            return 0

        def on_play(self, state: GameState):
            moves = state.legal_moves()
            return moves[0].cards if moves else []

    MyBot().run("http://localhost:8080", token)
"""

from .bot import Bot, GameState
from .client import ApiError, Client, register_bot
from .rules import Move, Pattern, RuleError, beats, identify, legal_moves, resolve

__all__ = [
    "ApiError",
    "Bot",
    "Client",
    "GameState",
    "Move",
    "Pattern",
    "RuleError",
    "beats",
    "identify",
    "legal_moves",
    "register_bot",
    "resolve",
]
__version__ = "0.1.0"
