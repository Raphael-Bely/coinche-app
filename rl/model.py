"""
Neural network for Coinche card play.
Actor-Critic architecture:
  - Policy head  → probability over 32 cards (masked to legal moves)
  - Value head   → estimated return from current state
"""

import torch
import torch.nn as nn
import torch.nn.functional as F
from coinche_env import STATE_DIM, ACTION_DIM


class CoincheNet(nn.Module):
    def __init__(self, hidden: int = 256):
        super().__init__()
        self.shared = nn.Sequential(
            nn.Linear(STATE_DIM, hidden),
            nn.ReLU(),
            nn.Linear(hidden, hidden),
            nn.ReLU(),
            nn.Linear(hidden, hidden),
            nn.ReLU(),
        )
        self.policy_head = nn.Linear(hidden, ACTION_DIM)
        self.value_head  = nn.Linear(hidden, 1)

    def forward(self, x: torch.Tensor, mask: torch.Tensor = None):
        """
        x    : (batch, STATE_DIM)
        mask : (batch, ACTION_DIM) bool tensor — True = legal action
        Returns: probs (batch, ACTION_DIM), value (batch, 1)
        """
        h = self.shared(x)

        logits = self.policy_head(h)
        if mask is not None:
            logits = logits.masked_fill(~mask, float('-inf'))
        probs = F.softmax(logits, dim=-1)

        value = self.value_head(h)
        return probs, value

    def act(self, obs: torch.Tensor, legal_cards: list, device='cpu'):
        """
        Single-step inference.
        obs         : (STATE_DIM,) numpy or tensor
        legal_cards : list of card ids that are legal
        Returns: chosen card id (int), log_prob (tensor), value (tensor)
        """
        if not isinstance(obs, torch.Tensor):
            obs = torch.FloatTensor(obs)
        obs = obs.unsqueeze(0).to(device)

        mask = torch.zeros(1, ACTION_DIM, dtype=torch.bool, device=device)
        for c in legal_cards:
            mask[0, c] = True

        with torch.no_grad():
            probs, value = self.forward(obs, mask)

        dist   = torch.distributions.Categorical(probs)
        action = dist.sample()
        return action.item(), dist.log_prob(action), value.squeeze()
