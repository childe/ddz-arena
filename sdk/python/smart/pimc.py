"""Mid-game Monte Carlo for the smart 3-player Dou Dizhu bot.

Before the endgame search applies (see endgame.py) the bot otherwise plays by rules alone.
With Monte Carlo on (``Smart3Bot.PIMC_SAMPLES`` > 0) it instead:

1. Samples the hidden hands: the unseen cards dealt at random to the other two seats, the
   bottom cards the landlord has not played yet kept in the landlord's hand
   (:func:`endgame.sample_hands`).
2. Weighs each sampled deal by how well it explains what the opponents did
   (:func:`weight`): each bid against the strength of the 17 cards the deal gives that
   player, and each pass made while holding a non-bomb answer. ``pool`` deals are drawn
   and ``samples`` of them are kept with probability proportional to their weight.
3. Plays every candidate move on every kept deal, finishes the game with the rule bot in
   all seats (:func:`rollout`), and plays the candidate with the best average result.
   The rule move keeps its place unless another candidate beats it by ``margin``.
"""

from __future__ import annotations

import math
import random
import time
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

import endgame
from ddz_sdk import GameState, Move
from ddz_sdk.cards import rank_counts, remove_cards, sort_cards
from ddz_sdk.rules import RuleError, lowest_single, resolve

BOMBS = ("bomb", "rocket")
Hands = Tuple[Tuple[str, ...], ...]
Policy = Callable[[GameState], Any]


# ---------------------------------------------------------------- rollouts
def rollout(
    st: GameState,
    hands: Sequence[Sequence[str]],
    first: Optional[Move],
    policy: Policy,
    win_only: bool = False,
) -> float:
    """Play ``first`` (None = pass) for ``st.seat`` on the deal ``hands``, finish the game
    with ``policy`` in every seat, and return ``st.seat``'s result: +-1 for a farmer,
    +-2 for the landlord, times 2 per bomb played from now on and 2 for a spring; with
    ``win_only`` just +1 for a win and -1 for a loss."""
    n = st.num_seats
    cur = [list(h) for h in hands]
    cur[st.seat] = list(
        st.hand
    )  # sampled hands use canonical suits; ``first`` does not
    history: List[Dict[str, Any]] = list(st.history)
    plays = [0] * n
    bombs = 0
    for h in history:
        if h.get("cards"):
            plays[h["seat"]] += 1
    last: Optional[Dict[str, Any]] = st.to_beat
    turn = st.seat
    move: Any = first
    while True:
        to_beat = last if last is not None and last["seat"] != turn else None
        if move is None and (turn != st.seat or len(history) > len(st.history)):
            move = policy(
                GameState(
                    game=st.game,
                    seat=turn,
                    hand=sort_cards(cur[turn]),
                    phase="playing",
                    bids=st.bids,
                    high_bid=st.high_bid,
                    landlord=st.landlord,
                    bottom=st.bottom,
                    turn=turn,
                    to_beat=to_beat,
                    can_pass=to_beat is not None,
                    cards_left=[len(h) for h in cur],
                    multiplier=st.multiplier * 2**bombs,
                    history=history,
                )
            )
        cards = list(move.cards) if isinstance(move, Move) else list(move or [])
        pattern = None
        if cards:
            hint = move.pattern.type if isinstance(move, Move) else None
            try:
                pattern = resolve(cards, to_beat["pattern"] if to_beat else None, hint)
            except RuleError:
                cards = []
        if not cards and to_beat is None:
            cards = lowest_single(cur[turn])
            pattern = resolve(cards, None)
        if cards:
            cur[turn] = remove_cards(cur[turn], cards)
            entry = {"seat": turn, "cards": cards, "pattern": pattern.to_api()}
            history.append(entry)
            last = entry
            plays[turn] += 1
            bombs += pattern.type in BOMBS
            if not cur[turn]:
                break
        else:
            history.append({"seat": turn, "cards": [], "pattern": None})
        turn = (turn + 1) % n
        move = None
    ll = st.landlord
    landlord_wins = turn == ll
    if win_only:
        return 1.0 if (st.seat == ll) == landlord_wins else -1.0
    spring = landlord_wins and all(plays[s] == 0 for s in range(n) if s != ll)
    anti = not landlord_wins and plays[ll] == 1
    unit = 2**bombs * (2 if spring or anti else 1)
    mine = 2 * unit if st.seat == ll else unit
    return mine if (st.seat == ll) == landlord_wins else -mine


# ---------------------------------------------------------------- inference
def dealt_hand(st: GameState, hands: Hands, seat: int) -> List[str]:
    """The 17 cards ``seat`` was dealt in the deal ``hands``: what it holds now plus what
    it played, without the bottom cards for the landlord."""
    cards = list(hands[seat])
    for h in st.history:
        if h.get("seat") == seat:
            cards += h.get("cards") or []
    if seat == st.landlord:
        cards = remove_cards(cards, st.bottom)
    return cards


def bid_likelihood(
    strength: float,
    bid: int,
    high_before: int,
    thresholds: Sequence[Tuple[int, float]],
    temp: float,
) -> float:
    """P(this bid | hand strength) for a player who bids k once the strength reaches the
    threshold for k, with logistic noise of width ``temp`` around each threshold."""
    at_least = {k: 1 / (1 + math.exp(-(strength - t) / temp)) for k, t in thresholds}
    at_least[4] = 0.0
    if bid == 0:
        # Passing only says the hand did not want more than the current high bid.
        return 1 - at_least.get(high_before + 1, 0.0)
    return max(1e-6, at_least[bid] - at_least[bid + 1])


def weight(
    st: GameState,
    hands: Hands,
    strength: Callable[[Sequence[str]], float],
    thresholds: Sequence[Tuple[int, float]],
    bid_temp: float,
    evidence: Sequence[Tuple[int, Any, List[str]]],
    pass_weight: float,
) -> float:
    """How well the deal ``hands`` explains the opponents' bids and passes (relative)."""
    w = 1.0
    if bid_temp > 0:
        high = 0
        for b in st.bids:
            seat, score = b.get("seat"), b.get("score") or 0
            if seat != st.seat:
                s = strength(dealt_hand(st, hands, seat))
                w *= bid_likelihood(s, score, high, thresholds, bid_temp)
            high = max(high, score)
    if evidence and pass_weight < 1:
        w *= endgame.plausibility(st, hands, evidence, pass_weight)
    return w


def draw(
    st: GameState,
    rng: random.Random,
    pool: int,
    samples: int,
    weigh: Callable[[Hands], float],
) -> List[Hands]:
    """``samples`` deals drawn from ``pool`` uniform deals in proportion to ``weigh``."""
    deals: List[Hands] = []
    ws: List[float] = []
    for _ in range(pool):
        h = endgame.sample_hands(st, rng)
        if h is None:
            return []
        deals.append(h)
        ws.append(weigh(h))
    if pool <= samples:
        return deals
    return rng.choices(deals, weights=ws, k=samples)


# ---------------------------------------------------------------- choosing
def choose(
    st: GameState,
    rule_move: Optional[Move],
    cands: Sequence[Optional[Move]],
    policy: Policy,
    deals: Sequence[Hands],
    margin: float,
    deadline: float,
    win_only: bool = False,
) -> Optional[Move]:
    """The candidate with the best average :func:`rollout` result over ``deals``; the rule
    move unless another beats it by more than ``margin``, or when time runs out before
    half of the deals are done."""
    key = lambda m: tuple(sorted(m.cards)) if m else ()
    rule_key = key(rule_move)
    moves = [rule_move] + [m for m in cands if key(m) != rule_key]
    if len(moves) <= 1 or not deals:
        return rule_move
    totals = [0.0] * len(moves)
    done = 0
    for hands in deals:
        if time.time() > deadline:
            break
        for i, m in enumerate(moves):
            totals[i] += rollout(st, hands, m, policy, win_only)
        done += 1
    if done * 2 < len(deals):
        return rule_move
    best = max(range(len(moves)), key=lambda i: (totals[i], i == 0))
    if (totals[best] - totals[0]) / done > margin:
        return moves[best]
    return rule_move
