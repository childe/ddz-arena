"""Endgame search for the smart Dou Dizhu bots (3- and 4-player).

Near the end of a game the bot no longer has to guess with rules: it samples the hidden hands
(the unseen cards dealt to the other seats at random, with the bottom cards the landlord has
not played yet kept in the landlord's hand), solves each sample exactly, and plays the move
that wins in the most samples. Exact solving is a minimax over every legal move: the farmers
win if any farmer move wins (one shared goal), the landlord wins only if every farmer move
loses. A transposition table and suit-free hands keep it fast; see :func:`choose`.

Measured on production games (one solve with the true hands): with <= 20 cards left in all
hands, 3-player solves take <= 0.7s and 4-player solves <= 0.11s; 4-player solves with
21-24 cards reach about 4s. :func:`choose` stops at a deadline and then falls back to the
rule-based move.
"""

from __future__ import annotations

import random
import time
from typing import Callable, Dict, List, Optional, Sequence, Tuple

from ddz_sdk import GameState, Move, Pattern
from ddz_sdk.cards import RANK_COUNT, RANK_LABELS, rank_counts, rank_of
from ddz_sdk.rules import legal_moves
from ddz_sdk.rules4 import legal_moves4

SUITS = "SHCD"
BOMBS = ("bomb", "rocket")
#: copies of each rank in the whole deck
DECK_COUNTS = {
    "ddz": (4,) * 13 + (1, 1),
    "ddz4": (8,) * 13 + (2, 2),
}
#: (type, main, length) of the play to beat, or None when the side to act leads
Last = Optional[Tuple[str, int, int]]
Hands = Tuple[Tuple[str, ...], ...]


class Timeout(Exception):
    pass


def card_of(rank: int, copy: int) -> str:
    label = RANK_LABELS[rank]
    return label if label in ("BJ", "RJ") else label + SUITS[copy % 4]


def canon(cards: Sequence[str]) -> Tuple[str, ...]:
    """Suits never matter: rewrite a hand so equal rank multisets give equal tuples."""
    c = rank_counts(cards)
    return tuple(card_of(r, k) for r in range(RANK_COUNT) for k in range(c[r]))


class Solver:
    """Perfect-information solver for one deal of hidden hands (shares its table across
    the root moves of that deal)."""

    def __init__(self, game: str, landlord: int, deadline: float):
        self.n = 4 if game == "ddz4" else 3
        self.legal: Callable[..., List[Move]] = (
            legal_moves4 if game == "ddz4" else legal_moves
        )
        self.landlord = landlord
        self.deadline = deadline
        self.table: Dict[tuple, bool] = {}
        self.nodes = 0

    def play(self, hands: Hands, turn: int, m: Move) -> Hands:
        """Hands after ``turn`` plays ``m`` (matched by rank: suits are canonical)."""
        c = rank_counts(hands[turn])
        for card in m.cards:
            c[rank_of(card)] -= 1
        out = list(hands)
        out[turn] = tuple(card_of(r, k) for r in range(RANK_COUNT) for k in range(c[r]))
        return tuple(out)

    def farmers_win(self, hands: Hands, turn: int, last: Last, last_seat: int) -> bool:
        """True if the farmers win with best play from here; ``turn`` acts next."""
        if last_seat == turn:
            last = None
        key = (hands, turn, last, last_seat if last else None)
        hit = self.table.get(key)
        if hit is not None:
            return hit
        self.nodes += 1
        if self.nodes % 1000 == 0 and time.time() > self.deadline:
            raise Timeout
        farmer = turn != self.landlord
        moves = self.legal(list(hands[turn]), Pattern(*last) if last else None)
        moves.sort(key=lambda m: -len(m.cards))  # going out and big plays first
        result = not farmer
        for m in moves:
            if len(m.cards) == len(hands[turn]):
                won = farmer
            else:
                won = self.after(hands, turn, m)
            if won == farmer:
                result = farmer
                break
        else:
            if last is not None:
                won = self.farmers_win(hands, (turn + 1) % self.n, last, last_seat)
                if won == farmer:
                    result = farmer
        self.table[key] = result
        return result

    def after(
        self,
        hands: Hands,
        turn: int,
        m: Optional[Move],
        last: Last = None,
        last_seat: int = -1,
    ) -> bool:
        """Farmers win after ``turn`` plays ``m`` (None: passes on ``last`` by ``last_seat``)."""
        if m is None:
            return self.farmers_win(hands, (turn + 1) % self.n, last, last_seat)
        if len(m.cards) == len(hands[turn]):
            return turn != self.landlord
        p = m.pattern
        return self.farmers_win(
            self.play(hands, turn, m),
            (turn + 1) % self.n,
            (p.type, p.main, p.length),
            turn,
        )


def applies(st: GameState, total: int, short: int) -> bool:
    """Search when all hands hold <= ``total`` cards and someone has <= ``short``."""
    left = st.cards_left
    return sum(left) <= total and min(left) <= short


def unseen_cards(st: GameState) -> Tuple[List[str], List[str]]:
    """(cards the landlord must still hold from the bottom, the other unseen cards), both as
    canonical card strings. The bottom part is empty when we are the landlord."""
    deck = DECK_COUNTS[st.game]
    played = [0] * RANK_COUNT
    landlord_played = [0] * RANK_COUNT
    for h in st.history:
        for card in h.get("cards") or []:
            played[rank_of(card)] += 1
            if h.get("seat") == st.landlord:
                landlord_played[rank_of(card)] += 1
    mine = rank_counts(st.hand)
    left = [deck[r] - mine[r] - played[r] for r in range(RANK_COUNT)]
    fixed = [0] * RANK_COUNT
    if not st.is_landlord:
        bottom = rank_counts(st.bottom)
        for r in range(RANK_COUNT):
            fixed[r] = max(0, min(bottom[r] - landlord_played[r], left[r]))
    fixed_cards = [card_of(r, k) for r in range(RANK_COUNT) for k in range(fixed[r])]
    free = [card_of(r, k) for r in range(RANK_COUNT) for k in range(fixed[r], left[r])]
    return fixed_cards, free


def pass_evidence(st: GameState) -> List[Tuple[int, Pattern, List[str]]]:
    """Passes on an opponent's play, as (seat, play it passed on, cards that seat played
    later). A player who passes usually cannot beat the play without a bomb."""
    out: List[Tuple[int, Pattern, List[str]]] = []
    last: Optional[Tuple[int, Pattern]] = None
    for i, h in enumerate(st.history):
        seat = h.get("seat")
        cards = h.get("cards") or []
        if cards:
            p = Pattern.from_api(h.get("pattern")) or st.resolve(cards)
            last = (seat, p)
            continue
        if last is None or seat == st.seat or last[0] == seat:
            continue
        if (seat == st.landlord) == (last[0] == st.landlord):
            continue  # passing on a teammate says nothing
        later = [
            c
            for g in st.history[i + 1 :]
            if g.get("seat") == seat
            for c in g.get("cards") or []
        ]
        out.append((seat, last[1], later))
    return out


def plausibility(
    st: GameState,
    hands: Hands,
    evidence: Sequence[Tuple[int, Pattern, List[str]]],
    weight: float,
) -> float:
    """``weight`` to the power of the passes in ``hands`` that had a non-bomb answer."""
    legal = legal_moves4 if st.game == "ddz4" else legal_moves
    w = 1.0
    for seat, p, later in evidence:
        held = list(hands[seat]) + later
        if any(m.pattern.type not in BOMBS for m in legal(held, p)):
            w *= weight
    return w


def sample_hands(
    st: GameState,
    rng: random.Random,
    evidence: Sequence[Tuple[int, Pattern, List[str]]] = (),
    weight: float = 1.0,
    tries: int = 20,
) -> Optional[Hands]:
    """A random deal of the hidden cards consistent with the card counts, or None if the
    counts do not add up (missing history). With ``evidence``, deals that contradict the
    passes are kept with probability :func:`plausibility` (up to ``tries`` draws)."""
    for _ in range(tries - 1):
        hands = _deal(st, rng)
        if hands is None or not evidence:
            return hands
        if rng.random() < plausibility(st, hands, evidence, weight):
            return hands
    return _deal(st, rng)


def _deal(st: GameState, rng: random.Random) -> Optional[Hands]:
    fixed, free = unseen_cards(st)
    n = st.num_seats
    need = list(st.cards_left)
    need[st.seat] = 0
    if not st.is_landlord:
        need[st.landlord] -= len(fixed)
    if min(need) < 0 or sum(need) != len(free):
        return None
    pool = list(free)
    rng.shuffle(pool)
    hands: List[Tuple[str, ...]] = []
    at = 0
    for s in range(n):
        if s == st.seat:
            hands.append(canon(st.hand))
            continue
        cards = pool[at : at + need[s]]
        at += need[s]
        if s == st.landlord and not st.is_landlord:
            cards += fixed
        hands.append(canon(cards))
    return tuple(hands)


def choose(
    st: GameState,
    rule_move: Optional[Move],
    samples: int,
    budget_s: float,
    rng: Optional[random.Random] = None,
    pass_weight: float = 1.0,
) -> Optional[Move]:
    """Best move by sampled exact search, or ``rule_move`` when the search runs out of time.

    Returns a :class:`Move`, or None to pass. Every sample solves every candidate (each legal
    play, plus passing when allowed); the move with the most wins is played, ties go to
    ``rule_move``, then to the order of the legal moves. Stops after ``samples`` samples or
    ``budget_s`` seconds; fewer than a third of ``samples`` completed means no answer.
    ``pass_weight`` < 1 makes deals where an opponent passed while holding a non-bomb
    answer less likely (see :func:`pass_evidence`).
    """
    rng = rng or random.Random()
    deadline = time.time() + budget_s
    to_beat = st.to_beat_pattern
    last: Last = (to_beat.type, to_beat.main, to_beat.length) if to_beat else None
    last_seat = st.to_beat["seat"] if st.to_beat else st.seat
    cands: List[Optional[Move]] = list(st.legal_moves())
    if st.can_pass and st.to_beat:
        cands.append(None)
    if len(cands) <= 1:
        return rule_move
    farmer = not st.is_landlord
    evidence = pass_evidence(st) if pass_weight < 1 else []
    wins = [0] * len(cands)
    done = 0
    try:
        for _ in range(samples):
            hands = sample_hands(st, rng, evidence, pass_weight)
            if hands is None:
                return rule_move
            solver = Solver(st.game, st.landlord, deadline)
            res = [
                solver.after(hands, st.seat, m, last, last_seat) == farmer
                for m in cands
            ]
            for i, w in enumerate(res):
                wins[i] += w
            done += 1
    except Timeout:
        pass
    if done * 3 < samples:
        return rule_move
    key = lambda m: tuple(sorted(m.cards)) if m else ()
    rule_key = key(rule_move)
    best = max(
        range(len(cands)), key=lambda i: (wins[i], key(cands[i]) == rule_key, -i)
    )
    if wins[best] == max(
        (wins[i] for i in range(len(cands)) if key(cands[i]) == rule_key), default=-1
    ):
        return rule_move
    return cands[best]
