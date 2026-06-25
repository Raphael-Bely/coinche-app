"""
╔══════════════════════════════════════════════════════════════════════════════╗
║              COINCHE RL — GOOGLE COLAB NOTEBOOK                             ║
║                                                                              ║
║  Instructions:                                                               ║
║  1. Go to colab.research.google.com                                          ║
║  2. New notebook → Runtime → Change runtime type → GPU (T4)                 ║
║  3. Copy each CELL below into a separate Colab cell                          ║
║  4. Run them in order                                                        ║
╚══════════════════════════════════════════════════════════════════════════════╝
"""

# ══════════════════════════════════════════════════════════════════════════════
# CELL 1 — Mount Google Drive (to save checkpoints permanently)
# ══════════════════════════════════════════════════════════════════════════════
"""
from google.colab import drive
drive.mount('/content/drive')

import os
SAVE_DIR = '/content/drive/MyDrive/coinche_rl'
os.makedirs(SAVE_DIR, exist_ok=True)
print("Drive mounted. Checkpoints will be saved to:", SAVE_DIR)
"""

# ══════════════════════════════════════════════════════════════════════════════
# CELL 2 — Upload the Python files from your Mac
# ══════════════════════════════════════════════════════════════════════════════
"""
from google.colab import files

print("Upload coinche_env.py, model.py, train.py")
uploaded = files.upload()
# After upload, the files are in /content/
"""

# ══════════════════════════════════════════════════════════════════════════════
# CELL 3 — Verify GPU and imports
# ══════════════════════════════════════════════════════════════════════════════
"""
import torch
print("PyTorch:", torch.__version__)
print("CUDA available:", torch.cuda.is_available())
if torch.cuda.is_available():
    print("GPU:", torch.cuda.get_device_name(0))
"""

# ══════════════════════════════════════════════════════════════════════════════
# CELL 4 — Quick sanity check (play 100 random games, verify env works)
# ══════════════════════════════════════════════════════════════════════════════
"""
import sys
sys.path.insert(0, '/content')

from coinche_env import CoincheEnv
import random

env = CoincheEnv()
wins = 0
for _ in range(100):
    obs = env.reset()
    done = False
    while not done:
        legal = env.get_legal_actions()
        assert len(legal) > 0, "No legal moves!"
        card = random.choice(legal)
        obs, _, done = env.step(card)
    r = env.final_rewards()
    wins += int(r[0] > 0)

print(f"100 random games completed. Contract team win rate: {wins}%")
print("Environment OK ✓")
"""

# ══════════════════════════════════════════════════════════════════════════════
# CELL 5 — Training (this is the long one — runs for hours)
# ══════════════════════════════════════════════════════════════════════════════
"""
import os, sys
sys.path.insert(0, '/content')

import torch
import torch.optim as optim
import numpy as np
from collections import deque
from coinche_env import CoincheEnv, ACTION_DIM
from model import CoincheNet

# ── Config ────────────────────────────────────────────────────────────────────
HIDDEN       = 256
LR           = 3e-4
ENTROPY_COEF = 0.01
VALUE_COEF   = 0.5
CLIP_GRAD    = 1.0
N_EPISODES   = 1_000_000
SAVE_EVERY   = 50_000
LOG_EVERY    = 5_000
SAVE_DIR     = '/content/drive/MyDrive/coinche_rl'

device = 'cuda' if torch.cuda.is_available() else 'cpu'
print(f"Training on: {device}")

model     = CoincheNet(HIDDEN).to(device)
optimizer = optim.Adam(model.parameters(), lr=LR)
env       = CoincheEnv()

# ── Load checkpoint if resuming ───────────────────────────────────────────────
checkpoints = sorted([f for f in os.listdir(SAVE_DIR) if f.endswith('.pt')])
if checkpoints:
    latest = os.path.join(SAVE_DIR, checkpoints[-1])
    ckpt = torch.load(latest, map_location=device)
    model.load_state_dict(ckpt['model'])
    optimizer.load_state_dict(ckpt['optimizer'])
    start_ep = ckpt['episode'] + 1
    print(f"Resumed from {latest} (episode {ckpt['episode']:,}, win_rate={ckpt['win_rate']:.3f})")
else:
    start_ep = 1
    print("Starting fresh.")

# ── Helpers ───────────────────────────────────────────────────────────────────

def run_episode():
    obs  = env.reset()
    done = False
    log_probs = [[] for _ in range(4)]
    values    = [[] for _ in range(4)]
    entropies = [[] for _ in range(4)]

    while not done:
        pi    = env.current_player
        legal = env.get_legal_actions()

        obs_t = torch.FloatTensor(obs).unsqueeze(0).to(device)
        mask  = torch.zeros(1, ACTION_DIM, dtype=torch.bool, device=device)
        for c in legal:
            mask[0, c] = True

        probs, value = model(obs_t, mask)
        dist = torch.distributions.Categorical(probs)
        act  = dist.sample()

        log_probs[pi].append(dist.log_prob(act))
        values[pi].append(value.squeeze())
        entropies[pi].append(dist.entropy().squeeze())

        obs, _, done = env.step(act.item())

    return log_probs, values, entropies, env.final_rewards()

def compute_loss(log_probs, values, entropies, rewards):
    policy_loss = value_loss = entropy = torch.tensor(0., device=device)
    n = 0
    for pi in range(4):
        r = torch.tensor(rewards[pi], dtype=torch.float32, device=device)
        for lp, v, e in zip(log_probs[pi], values[pi], entropies[pi]):
            policy_loss = policy_loss - lp * (r - v.detach())
            value_loss  = value_loss  + (r - v).pow(2)
            entropy     = entropy     + e
            n          += 1
    return (policy_loss + VALUE_COEF * value_loss - ENTROPY_COEF * entropy) / max(n, 1)

# ── Training loop ─────────────────────────────────────────────────────────────
win_hist  = deque(maxlen=2000)
loss_hist = deque(maxlen=2000)

for ep in range(start_ep, N_EPISODES + 1):
    lp, v, e, rewards = run_episode()
    loss = compute_loss(lp, v, e, rewards)

    optimizer.zero_grad()
    loss.backward()
    torch.nn.utils.clip_grad_norm_(model.parameters(), CLIP_GRAD)
    optimizer.step()

    won = env.trick_scores[env.contract_team] >= env.contract_pts
    win_hist.append(float(won))
    loss_hist.append(loss.item())

    if ep % LOG_EVERY == 0:
        print(f"Ep {ep:>8,} | win={np.mean(win_hist):.3f} | "
              f"loss={np.mean(loss_hist):.4f} | "
              f"score {env.trick_scores[0]}-{env.trick_scores[1]}")

    if ep % SAVE_EVERY == 0:
        path = os.path.join(SAVE_DIR, f'coinche_{ep:08d}.pt')
        torch.save({
            'episode':  ep,
            'model':    model.state_dict(),
            'optimizer': optimizer.state_dict(),
            'win_rate': float(np.mean(win_hist)),
        }, path)
        print(f"  ✓ Saved checkpoint ep {ep:,}")

print("Done.")
"""

# ══════════════════════════════════════════════════════════════════════════════
# CELL 6 — Evaluate: RL bot vs random play
# ══════════════════════════════════════════════════════════════════════════════
"""
import random
from coinche_env import CoincheEnv

def eval_rl_vs_random(model, n_games=500, device='cuda'):
    env = CoincheEnv()
    rl_wins = 0

    for _ in range(n_games):
        obs  = env.reset()
        done = False

        # RL plays as team 0 (players 0 and 2), random plays team 1
        while not done:
            pi    = env.current_player
            legal = env.get_legal_actions()

            if env.team_of(pi) == 0:  # RL team
                card, _, _ = model.act(obs, legal, device=device)
            else:                      # Random team
                card = random.choice(legal)

            obs, _, done = env.step(card)

        if env.trick_scores[0] >= env.contract_pts:
            rl_wins += 1

    print(f"RL team win rate vs random: {rl_wins}/{n_games} = {rl_wins/n_games:.1%}")

eval_rl_vs_random(model, device=device)
"""

# ══════════════════════════════════════════════════════════════════════════════
# CELL 7 — Export to ONNX (for use in Node.js)
# ══════════════════════════════════════════════════════════════════════════════
"""
import torch
from coinche_env import STATE_DIM, ACTION_DIM
from model import CoincheNet

# Load best checkpoint
ckpt = torch.load('/content/drive/MyDrive/coinche_rl/<your_checkpoint>.pt', map_location='cpu')
model = CoincheNet()
model.load_state_dict(ckpt['model'])
model.eval()

# Dummy input for tracing
dummy_obs  = torch.zeros(1, STATE_DIM)
dummy_mask = torch.ones(1, ACTION_DIM, dtype=torch.bool)

torch.onnx.export(
    model,
    (dummy_obs, dummy_mask),
    '/content/drive/MyDrive/coinche_rl/coinche_bot.onnx',
    input_names  = ['obs', 'mask'],
    output_names = ['probs', 'value'],
    dynamic_axes = {'obs': {0: 'batch'}, 'mask': {0: 'batch'}},
    opset_version = 17,
)
print("Exported coinche_bot.onnx")

# Download to your Mac
from google.colab import files
files.download('/content/drive/MyDrive/coinche_rl/coinche_bot.onnx')
"""
