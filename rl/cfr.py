"""
Outcome Sampling Monte Carlo CFR for Coinche (card play phase).

Complexity: O(32) per iteration (one sampled trajectory), scales to millions
of iterations on CPU without needing a GPU.

After training, use export_cfr_onnx.py to convert → neural network → ONNX.
"""

import os
import numpy as np
import pickle
from collections import defaultdict
from coinche_env import (
    CoincheEnv, ACTION_DIM, card_points,
    get_playable, trick_winner_idx,
)


# ── Undo-based game state (avoids deepcopy) ───────────────────────────────────

class CoincheCFREnv:
    """
    Lightweight Coinche state that supports push/pop instead of deepcopy.
    """
    __slots__ = ['hands', 'trump', 'contract_team', 'contract_pts',
                 'current_player', 'trick_leader', 'current_trick',
                 'past_tricks', 'trick_scores', 'done']

    def init_from(self, env: CoincheEnv):
        self.hands          = [list(h) for h in env.hands]
        self.trump          = env.trump
        self.contract_team  = env.contract_team
        self.contract_pts   = env.contract_pts
        self.current_player = env.current_player
        self.trick_leader   = env.trick_leader
        self.current_trick  = list(env.current_trick)
        self.past_tricks    = [{'cards': list(t['cards']), 'winner': t['winner']}
                                for t in env.past_tricks]
        self.trick_scores   = list(env.trick_scores)
        self.done           = env.done

    def team_of(self, p): return 0 if p in (0, 2) else 1

    def get_legal(self):
        p       = self.current_player
        partner = (p + 2) % 4
        pw      = False
        if self.current_trick:
            w       = trick_winner_idx(self.current_trick, self.trump)
            players = [(self.trick_leader + i) % 4 for i in range(len(self.current_trick))]
            pw      = players[w] == partner
        return get_playable(self.hands[p], self.current_trick, self.trump, p, pw)

    def infoset_key(self, player):
        hand = tuple(sorted(self.hands[player]))
        # Abstract past tricks to reduce state space
        past = tuple(
            (self.team_of(t['winner']),
             min(sum(card_points(c, self.trump) for c in t['cards']) // 10, 5))
            for t in self.past_tricks
        )
        curr    = tuple(self.current_trick)
        cbucket = min(self.contract_pts // 20, 8)   # 80→4 … 160→8
        return (hand, past, curr, self.trump,
                self.team_of(player), self.contract_team, cbucket)

    def apply(self, card):
        """Play card in-place, return undo info."""
        p = self.current_player
        self.hands[p].remove(card)
        self.current_trick.append(card)
        undo = {'card': card, 'player': p, 'trick_done': False}

        if len(self.current_trick) == 4:
            players = [(self.trick_leader + i) % 4 for i in range(4)]
            w_idx   = trick_winner_idx(self.current_trick, self.trump)
            winner  = players[w_idx]
            pts     = sum(card_points(c, self.trump) for c in self.current_trick)

            undo.update({'trick_done': True, 'old_leader': self.trick_leader,
                         'trick_cards': list(self.current_trick), 'winner': winner,
                         'pts': pts, 'old_scores': list(self.trick_scores),
                         'old_done': self.done})

            self.trick_scores[self.team_of(winner)] += pts
            self.past_tricks.append({'cards': list(self.current_trick), 'winner': winner})
            self.current_trick  = []
            self.trick_leader   = winner
            self.current_player = winner

            if len(self.past_tricks) == 8:
                self.trick_scores[self.team_of(winner)] += 10
                self.done = True
        else:
            self.current_player = (p + 1) % 4

        return undo

    def undo(self, u):
        p = u['player']
        self.hands[p].append(u['card'])
        if u['trick_done']:
            self.past_tricks.pop()
            self.current_trick  = list(u['trick_cards'])
            self.trick_leader   = u['old_leader']
            self.current_player = p
            self.trick_scores   = list(u['old_scores'])
            self.done           = u['old_done']
        else:
            self.current_trick.pop()
            self.current_player = p

    def utilities(self):
        """Terminal per-player shaped utility."""
        ct   = self.contract_team
        made = self.trick_scores[ct] >= self.contract_pts
        # Base ±1 game outcome
        base = [1.0 if (made == (self.team_of(p) == ct)) else -1.0 for p in range(4)]
        # Add normalized trick contribution
        trick_contrib = [0.0] * 4
        for t in self.past_tricks:
            pts  = sum(card_points(c, self.trump) for c in t['cards'])
            wt   = self.team_of(t['winner'])
            norm = pts / 162.0
            for p in range(4):
                trick_contrib[p] += norm if self.team_of(p) == wt else -norm
        return [base[p] + 0.5 * trick_contrib[p] for p in range(4)]


# ── CFR Trainer ───────────────────────────────────────────────────────────────

class CFRTrainer:
    def __init__(self):
        self.regret_sum   = defaultdict(lambda: np.zeros(ACTION_DIM, np.float64))
        self.strategy_sum = defaultdict(lambda: np.zeros(ACTION_DIM, np.float64))
        self.iterations   = 0

    def _strategy(self, key, legal):
        """Regret matching over legal actions."""
        r    = self.regret_sum[key]
        mask = np.zeros(ACTION_DIM)
        for c in legal: mask[c] = 1.0
        pos  = np.maximum(r * mask, 0)
        tot  = pos.sum()
        return (pos / tot) if tot > 0 else (mask / mask.sum())

    def _cfr(self, state: CoincheCFREnv, reach: np.ndarray):
        """
        Outcome Sampling MCCFR — samples one action per node.
        `reach[p]` = product of all players' strategy probs along the path.
        Returns per-player utilities.
        """
        if state.done:
            return np.array(state.utilities())

        p     = state.current_player
        legal = state.get_legal()
        if not legal:
            return np.zeros(4)

        key      = state.infoset_key(p)
        strategy = self._strategy(key, legal)

        # Sample one action
        probs = np.array([strategy[a] for a in legal], dtype=np.float64)
        probs /= probs.sum()
        a     = int(np.random.choice(legal, p=probs))

        # Recurse
        new_reach      = reach.copy()
        new_reach[p]  *= strategy[a]
        undo           = state.apply(a)
        u              = self._cfr(state, new_reach)
        state.undo(undo)

        # Counterfactual reach for player p = product of OTHER players' probs
        cf_reach = reach.prod() / (reach[p] + 1e-12)

        # Regret update: opportunity cost for each legal action
        u_p = u[p]
        for a_alt in legal:
            if a_alt == a:
                self.regret_sum[key][a_alt] += cf_reach * u_p * (1.0 - strategy[a_alt])
            else:
                self.regret_sum[key][a_alt] -= cf_reach * u_p * strategy[a_alt]

        # Average strategy accumulation
        for a_alt in legal:
            self.strategy_sum[key][a_alt] += reach[p] * strategy[a_alt]

        return u

    def run_iteration(self, env: CoincheEnv):
        """One CFR iteration on a fresh game."""
        state = CoincheCFREnv()
        state.init_from(env)
        self._cfr(state, np.ones(4, dtype=np.float64))
        self.iterations += 1

    def avg_strategy(self, key, legal):
        """Average strategy (converges to Nash)."""
        s    = self.strategy_sum[key]
        mask = np.zeros(ACTION_DIM)
        for c in legal: mask[c] = 1.0
        s    = s * mask
        tot  = s.sum()
        return (s / tot) if tot > 0 else (mask / mask.sum())

    def save(self, path):
        with open(path, 'wb') as f:
            pickle.dump({'regret': dict(self.regret_sum),
                         'strategy': dict(self.strategy_sum),
                         'iterations': self.iterations}, f, protocol=4)
        size_mb = os.path.getsize(path) / 1e6
        print(f"✓ Saved {path}  ({len(self.strategy_sum):,} infosets, {size_mb:.1f} MB)")

    def load(self, path):
        with open(path, 'rb') as f:
            d = pickle.load(f)
        self.regret_sum   = defaultdict(lambda: np.zeros(ACTION_DIM, np.float64), d['regret'])
        self.strategy_sum = defaultdict(lambda: np.zeros(ACTION_DIM, np.float64), d['strategy'])
        self.iterations   = d.get('iterations', 0)
        print(f"✓ Loaded {path}  ({len(self.strategy_sum):,} infosets, "
              f"{self.iterations:,} iterations)")
