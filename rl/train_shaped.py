"""
PPO with dense reward shaping.
Run on Colab GPU — warm-starts from the latest checkpoint if available.

Reward per step:
  - Each completed trick : ±trick_pts/162  (TRICK_W weight)
  - Game outcome         : ±1.0            (FINAL_W weight)
  Discounted backward with GAMMA so earlier actions credit trick rewards.
"""

import os, glob
import torch
import torch.optim as optim
import numpy as np
from collections import deque

from coinche_env import CoincheEnv, STATE_DIM, ACTION_DIM, card_points
from model import CoincheNet

# ── Hyperparameters ────────────────────────────────────────────────────────────
HIDDEN       = 256
LR           = 2e-4
GAMMA        = 0.97        # stronger discount than before (reward at every trick)
ENTROPY_COEF = 0.03        # higher → more exploration
VALUE_COEF   = 0.5
CLIP_GRAD    = 1.0
TRICK_W      = 0.6         # weight of per-trick reward
FINAL_W      = 1.0         # weight of game-outcome reward

N_EPISODES   = 2_000_000
SAVE_EVERY   = 25_000
LOG_EVERY    = 2_000
SAVE_DIR     = '/content/drive/MyDrive/coinche_rl_shaped'   # Colab Drive

device = 'cuda' if torch.cuda.is_available() else 'mps' if torch.backends.mps.is_available() else 'cpu'
print(f"Device: {device}")

os.makedirs(SAVE_DIR, exist_ok=True)

model     = CoincheNet(hidden=HIDDEN).to(device)
optimizer = optim.Adam(model.parameters(), lr=LR)
start_ep  = 1

# ── Warm-start from latest checkpoint ─────────────────────────────────────────
ckpts = sorted(glob.glob(os.path.join(SAVE_DIR, 'shaped_*.pt')))
if not ckpts:
    # Try the base checkpoint (ep 1M from original training)
    base = sorted(glob.glob('checkpoints/coinche_*.pt'))
    if base:
        ckpts = [base[-1]]
if ckpts:
    ckpt = torch.load(ckpts[-1], map_location=device, weights_only=True)
    model.load_state_dict(ckpt['model'])
    if 'optimizer' in ckpt and os.path.basename(ckpts[-1]).startswith('shaped_'):
        optimizer.load_state_dict(ckpt['optimizer'])
    start_ep = ckpt.get('episode', 0) + 1
    print(f"Resumed from {ckpts[-1]}  (ep {start_ep-1:,})")
else:
    print("Starting fresh.")

env = CoincheEnv()

# ── Episode rollout ────────────────────────────────────────────────────────────
def run_episode():
    obs  = env.reset()
    done = False

    log_probs = [[] for _ in range(4)]
    values    = [[] for _ in range(4)]
    entropies = [[] for _ in range(4)]
    # Each action → which trick index it belongs to (0-7)
    trick_idx = [[] for _ in range(4)]
    prev_tricks = 0
    t_count = 0

    while not done:
        pi    = env.current_player
        legal = env.get_legal_actions()

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
        trick_idx[pi].append(t_count)

        obs, _, done = env.step(action.item())

        if len(env.past_tricks) > prev_tricks:
            t_count    += 1
            prev_tricks = len(env.past_tricks)

    # ── Build shaped returns ───────────────────────────────────────────────────
    final_r = env.final_rewards()   # (4,)

    shaped_returns = []
    for pi in range(4):
        team_pi = 0 if pi in [0, 2] else 1
        n = len(log_probs[pi])
        rets = np.zeros(n, dtype=np.float32)

        G = final_r[pi] * FINAL_W
        for t in reversed(range(n)):
            ti = trick_idx[pi][t]
            if ti < len(env.past_tricks):
                trick = env.past_tricks[ti]
                pts   = sum(card_points(c, env.trump) for c in trick['cards'])
                wteam = 0 if trick['winner'] in [0, 2] else 1
                tr    = TRICK_W * (pts / 162.0) * (1 if wteam == team_pi else -1)
            else:
                tr = 0.0
            G = tr + GAMMA * G
            rets[t] = G

        shaped_returns.append(rets)

    return log_probs, values, entropies, shaped_returns

# ── Loss ───────────────────────────────────────────────────────────────────────
def compute_loss(log_probs, values, entropies, shaped_returns):
    policy_loss = torch.tensor(0.0, device=device)
    value_loss  = torch.tensor(0.0, device=device)
    entropy     = torch.tensor(0.0, device=device)
    n_actions   = 0

    for pi in range(4):
        rets = shaped_returns[pi]
        for t, (lp, v, e) in enumerate(zip(log_probs[pi], values[pi], entropies[pi])):
            r         = torch.tensor(rets[t], dtype=torch.float32, device=device)
            advantage = r - v.detach()
            policy_loss = policy_loss - lp * advantage
            value_loss  = value_loss  + (r - v).pow(2)
            entropy     = entropy     + e
            n_actions  += 1

    if n_actions == 0:
        return torch.tensor(0.0, device=device)
    return (policy_loss + VALUE_COEF * value_loss - ENTROPY_COEF * entropy) / n_actions

# ── Training loop ──────────────────────────────────────────────────────────────
win_history  = deque(maxlen=2000)
loss_history = deque(maxlen=2000)

print(f"Training {N_EPISODES:,} episodes | save every {SAVE_EVERY:,} | log every {LOG_EVERY:,}")
print("-" * 70)

for episode in range(start_ep, N_EPISODES + 1):
    log_probs, values, entropies, shaped_returns = run_episode()

    loss = compute_loss(log_probs, values, entropies, shaped_returns)
    optimizer.zero_grad()
    loss.backward()
    torch.nn.utils.clip_grad_norm_(model.parameters(), CLIP_GRAD)
    optimizer.step()

    ct  = env.contract_team
    won = env.trick_scores[ct] >= env.contract_pts
    win_history.append(float(won))
    loss_history.append(loss.item())

    if episode % LOG_EVERY == 0:
        print(f"Ep {episode:>8,} | win={np.mean(win_history):.3f} | "
              f"loss={np.mean(loss_history):.4f} | "
              f"scores={env.trick_scores[0]}-{env.trick_scores[1]}")

    if episode % SAVE_EVERY == 0:
        path = os.path.join(SAVE_DIR, f'shaped_{episode:08d}.pt')
        torch.save({'episode': episode, 'model': model.state_dict(),
                    'optimizer': optimizer.state_dict(),
                    'win_rate': np.mean(win_history)}, path)
        print(f"  ✓ {path}")

print("Done.")
