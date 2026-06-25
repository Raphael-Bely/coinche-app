"""
Self-play training loop using REINFORCE with baseline (Actor-Critic).

All 4 players share the same network — so the model always plays
against itself and coordination between partners emerges naturally.

Run locally:  python train.py
Run on Colab: use notebook.py (copy cells into Colab)
"""

import os
import torch
import torch.optim as optim
import numpy as np
from collections import deque

from coinche_env import CoincheEnv, STATE_DIM, ACTION_DIM
from model import CoincheNet

# ─── Hyperparameters ─────────────────────────────────────────────────────────
HIDDEN       = 256
LR           = 3e-4
GAMMA        = 0.99       # discount (less important here since reward is at end)
ENTROPY_COEF = 0.01       # encourage exploration
VALUE_COEF   = 0.5        # weight of value loss vs policy loss
CLIP_GRAD    = 1.0

N_EPISODES   = 500_000    # total training episodes
SAVE_EVERY   = 10_000     # save checkpoint every N episodes
LOG_EVERY    = 1_000      # print stats every N episodes
SAVE_DIR     = 'checkpoints'

# ─── Setup ───────────────────────────────────────────────────────────────────

device = (
    'cuda'  if torch.cuda.is_available() else
    'mps'   if torch.backends.mps.is_available() else  # Apple Silicon
    'cpu'
)
print(f"Device: {device}")

os.makedirs(SAVE_DIR, exist_ok=True)

model     = CoincheNet(hidden=HIDDEN).to(device)
optimizer = optim.Adam(model.parameters(), lr=LR)

env = CoincheEnv()


# ─── Episode rollout ─────────────────────────────────────────────────────────

def run_episode():
    """
    Play one full hand (8 tricks, all 4 players sharing the model).
    Returns per-player trajectories: list of (log_prob, value, entropy).
    """
    obs  = env.reset()
    done = False

    # Per-player buffers
    log_probs = [[] for _ in range(4)]
    values    = [[] for _ in range(4)]
    entropies = [[] for _ in range(4)]

    while not done:
        pi      = env.current_player
        legal   = env.get_legal_actions()

        obs_t = torch.FloatTensor(obs).unsqueeze(0).to(device)
        mask  = torch.zeros(1, ACTION_DIM, dtype=torch.bool, device=device)
        for c in legal:
            mask[0, c] = True

        probs, value = model(obs_t, mask)
        dist         = torch.distributions.Categorical(probs)
        action       = dist.sample()

        log_probs[pi].append(dist.log_prob(action))
        values[pi].append(value.squeeze())
        entropies[pi].append(dist.entropy().squeeze())

        obs, _, done = env.step(action.item())

    rewards = env.final_rewards()   # shape (4,)
    return log_probs, values, entropies, rewards


# ─── Loss computation ─────────────────────────────────────────────────────────

def compute_loss(log_probs, values, entropies, rewards):
    """REINFORCE with baseline: policy loss + value loss + entropy bonus."""
    policy_loss = torch.tensor(0.0, device=device)
    value_loss  = torch.tensor(0.0, device=device)
    entropy     = torch.tensor(0.0, device=device)
    n_actions   = 0

    for pi in range(4):
        r = torch.tensor(rewards[pi], dtype=torch.float32, device=device)
        for lp, v, e in zip(log_probs[pi], values[pi], entropies[pi]):
            advantage    = r - v.detach()
            policy_loss  = policy_loss - lp * advantage
            value_loss   = value_loss  + (r - v).pow(2)
            entropy      = entropy     + e
            n_actions   += 1

    if n_actions == 0:
        return torch.tensor(0.0, device=device)

    loss = (policy_loss + VALUE_COEF * value_loss - ENTROPY_COEF * entropy) / n_actions
    return loss


# ─── Training loop ───────────────────────────────────────────────────────────

win_history  = deque(maxlen=1000)    # 1 = contract team won
loss_history = deque(maxlen=1000)

print("Starting training...")
print(f"Episodes: {N_EPISODES:,}  |  Save every: {SAVE_EVERY:,}  |  Log every: {LOG_EVERY:,}")
print("-" * 60)

for episode in range(1, N_EPISODES + 1):
    log_probs, values, entropies, rewards = run_episode()

    loss = compute_loss(log_probs, values, entropies, rewards)

    optimizer.zero_grad()
    loss.backward()
    torch.nn.utils.clip_grad_norm_(model.parameters(), CLIP_GRAD)
    optimizer.step()

    # Track whether contract team won (player 0 is always on a contract team)
    ct  = env.contract_team
    won = env.trick_scores[ct] >= env.contract_pts
    win_history.append(float(won))
    loss_history.append(loss.item())

    if episode % LOG_EVERY == 0:
        win_rate  = np.mean(win_history)
        avg_loss  = np.mean(loss_history)
        scores    = env.trick_scores
        print(f"Ep {episode:>7,} | win_rate={win_rate:.3f} | loss={avg_loss:.4f} | "
              f"score={scores[0]}-{scores[1]}")

    if episode % SAVE_EVERY == 0:
        path = os.path.join(SAVE_DIR, f'coinche_{episode:07d}.pt')
        torch.save({
            'episode':     episode,
            'model':       model.state_dict(),
            'optimizer':   optimizer.state_dict(),
            'win_rate':    np.mean(win_history),
        }, path)
        print(f"  ✓ Saved {path}")

print("Training complete.")
