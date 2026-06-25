"""
Coinche game environment for reinforcement learning.
Handles card play only — bidding uses a fixed contract so the model
can focus entirely on learning to play cards well.
"""

import numpy as np
import random
from typing import List, Optional, Tuple

# ─── Card encoding ────────────────────────────────────────────────────────────
# 32 cards: 4 suits × 8 ranks
# card_id = suit * 8 + rank
RANKS = ['7', '8', '9', '10', 'J', 'Q', 'K', 'A']
SUITS = ['S', 'H', 'D', 'C']   # Spades, Hearts, Diamonds, Clubs

# rank index → strength / points
# Trump   : J=20, 9=14, A=11, 10=10, K=4, Q=3, 8=0, 7=0
# Plain   : A=11, 10=10, K=4, Q=3, J=2, 9=0, 8=0, 7=0
# SA      : same as plain but A=19
TRUMP_STR = [0, 0, 14, 10, 20, 3, 4, 11]   # indices 0-7 for ranks 7-A
PLAIN_STR = [0, 0,  0, 10,  2, 3, 4, 11]
SA_STR    = [0, 0,  0, 10,  2, 3, 4, 19]

TRUMP_PTS = [0, 0, 14, 10, 20, 3, 4, 11]
PLAIN_PTS = [0, 0,  0, 10,  2, 3, 4, 11]
SA_PTS    = [0, 0,  0, 10,  2, 3, 4, 19]

# trump codes:  0-3 = suit index,  4 = SA (no trump),  5 = TA (all trump)
TRUMP_SA = 4
TRUMP_TA = 5

def card_id(suit: int, rank: int) -> int:
    return suit * 8 + rank

def suit_of(c: int) -> int: return c // 8
def rank_of(c: int) -> int: return c % 8

def is_trump(c: int, trump: int) -> bool:
    if trump == TRUMP_SA: return False
    if trump == TRUMP_TA: return True
    return suit_of(c) == trump

def strength(c: int, trump: int) -> int:
    r = rank_of(c)
    if trump == TRUMP_SA:                          return SA_STR[r]
    if trump == TRUMP_TA or suit_of(c) == trump:   return TRUMP_STR[r]
    return PLAIN_STR[r]

def card_points(c: int, trump: int) -> int:
    r = rank_of(c)
    if trump == TRUMP_SA:                          return SA_PTS[r]
    if trump == TRUMP_TA or suit_of(c) == trump:   return TRUMP_PTS[r]
    return PLAIN_PTS[r]


# ─── Trick logic ──────────────────────────────────────────────────────────────

def trick_winner_idx(trick_cards: List[int], trump: int) -> int:
    """Returns 0-3 index of the winning card in the trick."""
    led_suit = suit_of(trick_cards[0])
    best_i, best_s = 0, -1
    for i, c in enumerate(trick_cards):
        if is_trump(c, trump) or suit_of(c) == led_suit:
            s = strength(c, trump)
            if s > best_s:
                best_s, best_i = s, i
    return best_i


def get_playable(hand: List[int], trick: List[int], trump: int,
                 partner_winning: bool) -> List[int]:
    """
    Returns the subset of hand that is legal to play given the current trick.
    partner_winning: True if the partner is currently winning the trick.
    """
    if not trick:
        return hand[:]

    led_suit = suit_of(trick[0])

    # Cards that follow the led suit
    follow = [c for c in hand if suit_of(c) == led_suit]

    if follow:
        # If the led suit IS trump we must over-trump if possible
        if led_suit == trump or trump == TRUMP_TA:
            current_best = max(strength(c, trump) for c in trick
                               if is_trump(c, trump) or suit_of(c) == led_suit)
            over = [c for c in follow if strength(c, trump) > current_best]
            return over if over else follow
        return follow

    # Can't follow suit
    if trump == TRUMP_SA:     # Sans-Atout: play anything
        return hand[:]

    if trump == TRUMP_TA:     # Tout-Atout: led suit = trump, handled above
        # All cards are trump; must over-trump if possible
        current_best = max(strength(c, trump) for c in trick)
        over = [c for c in hand if strength(c, trump) > current_best]
        return over if over else hand[:]

    # Normal trump suit
    trumps = [c for c in hand if suit_of(c) == trump]

    if not partner_winning and trumps:
        # Must trump; must over-trump if possible
        trump_in_trick = [c for c in trick if suit_of(c) == trump]
        if trump_in_trick:
            current_best = max(strength(c, trump) for c in trump_in_trick)
            over = [c for c in trumps if strength(c, trump) > current_best]
            return over if over else trumps
        return trumps

    return hand[:]


# ─── State vector ─────────────────────────────────────────────────────────────
# Dimension breakdown (total = 211):
#   [0:32]    my hand (one-hot)
#   [32:64]   cards played in past tricks (one-hot)
#   [64:192]  current trick slots ×4, each one-hot over 32 cards (0 = not played yet)
#   [192:198] trump one-hot: [S H D C SA TA]
#   [198:202] my position one-hot: [0 1 2 3]
#   [202]     tricks done / 8
#   [203]     my team's running trick pts / 162
#   [204]     opponent running trick pts / 162
STATE_DIM  = 205
ACTION_DIM = 32   # one output per card slot


# ─── Environment ─────────────────────────────────────────────────────────────

class CoincheEnv:
    """
    4-player Coinche environment.
    All 4 positions share the same model (self-play).
    Bidding is fixed (random suit, 80 pts) — model only learns card play.
    """

    def __init__(self, fixed_trump: Optional[int] = None,
                 fixed_contract_team: Optional[int] = None):
        self.fixed_trump         = fixed_trump
        self.fixed_contract_team = fixed_contract_team
        self.reset()

    def reset(self) -> np.ndarray:
        deck = list(range(32))
        random.shuffle(deck)
        self.hands = [sorted(deck[i*8:(i+1)*8]) for i in range(4)]

        self.trump         = self.fixed_trump         if self.fixed_trump         is not None else random.randint(0, 3)
        self.contract_team = self.fixed_contract_team if self.fixed_contract_team is not None else random.randint(0, 1)
        self.contract_pts  = 80

        self.teams        = [[0, 2], [1, 3]]
        self.current_player = 0
        self.trick_leader   = 0
        self.current_trick: List[int] = []
        self.past_tricks: List[dict]  = []
        self.trick_scores = [0, 0]
        self.done = False

        return self._observe()

    # ── Helpers ───────────────────────────────────────────────────────────────

    def team_of(self, p: int) -> int:
        return 0 if p in self.teams[0] else 1

    def partner_of(self, p: int) -> int:
        t = self.team_of(p)
        return next(x for x in self.teams[t] if x != p)

    def _partner_winning(self) -> bool:
        if not self.current_trick:
            return False
        partner = self.partner_of(self.current_player)
        players_so_far = [(self.trick_leader + i) % 4 for i in range(len(self.current_trick))]
        if partner not in players_so_far:
            return False
        w_idx    = trick_winner_idx(self.current_trick, self.trump)
        w_player = players_so_far[w_idx]
        return w_player == partner

    def get_legal_actions(self) -> List[int]:
        return get_playable(
            self.hands[self.current_player],
            self.current_trick,
            self.trump,
            self._partner_winning(),
        )

    # ── Observation ───────────────────────────────────────────────────────────

    def _observe(self) -> np.ndarray:
        pi  = self.current_player
        obs = np.zeros(STATE_DIM, dtype=np.float32)

        for c in self.hands[pi]:
            obs[c] = 1.0

        for t in self.past_tricks:
            for c in t['cards']:
                obs[32 + c] = 1.0

        for i, c in enumerate(self.current_trick):
            obs[64 + i * 32 + c] = 1.0

        if self.trump < 6:
            obs[192 + self.trump] = 1.0

        obs[198 + pi] = 1.0
        obs[202] = len(self.past_tricks) / 8.0

        my_t = self.team_of(pi)
        obs[203] = self.trick_scores[my_t]    / 162.0
        obs[204] = self.trick_scores[1-my_t]  / 162.0

        return obs

    # ── Step ──────────────────────────────────────────────────────────────────

    def step(self, card: int) -> Tuple[np.ndarray, float, bool]:
        """Play one card. Returns (observation, reward, done)."""
        assert card in self.hands[self.current_player], \
            f"Illegal: card {card} not in hand {self.hands[self.current_player]}"

        self.hands[self.current_player].remove(card)
        self.current_trick.append(card)

        if len(self.current_trick) == 4:
            players = [(self.trick_leader + i) % 4 for i in range(4)]
            w_idx   = trick_winner_idx(self.current_trick, self.trump)
            winner  = players[w_idx]

            pts = sum(card_points(c, self.trump) for c in self.current_trick)
            self.trick_scores[self.team_of(winner)] += pts

            self.past_tricks.append({
                'cards':  self.current_trick[:],
                'winner': winner,
            })
            self.current_trick = []
            self.trick_leader  = winner
            self.current_player = winner

            if len(self.past_tricks) == 8:
                self.trick_scores[self.team_of(winner)] += 10   # 10-de-der
                self.done = True
                return self._observe(), 0.0, True
        else:
            self.current_player = (self.current_player + 1) % 4

        return self._observe(), 0.0, False

    def final_rewards(self) -> np.ndarray:
        """Call after done=True. Returns reward for each player [0..3]."""
        ct   = self.contract_team
        made = self.trick_scores[ct] >= self.contract_pts
        r    = np.zeros(4, dtype=np.float32)
        for p in range(4):
            on_contract_team = self.team_of(p) == ct
            r[p] = 1.0 if (made == on_contract_team) else -1.0
        return r

    def render(self):
        print(f"Trump: {SUITS[self.trump] if self.trump < 4 else ('SA','TA')[self.trump-4]}")
        print(f"Contract team: {self.contract_team}  Score: {self.trick_scores}")
        print(f"Current player: {self.current_player}")
        for i, h in enumerate(self.hands):
            print(f"  P{i}: {[(RANKS[rank_of(c)], SUITS[suit_of(c)]) for c in h]}")
