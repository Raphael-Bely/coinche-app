"""
CFR training + behavioral cloning export.
Run on Kaggle (CPU-only, no GPU needed).

Phase 1: train CFR  → cfr_checkpoints/cfr_XXXXXXX.pkl
Phase 2: BC export  → coinche_bot_cfr.onnx  (same pipeline as PPO bot)

Usage:
  python train_cfr.py            # full run
  python train_cfr.py --bc-only  # skip training, export ONNX from latest checkpoint
"""

import os, sys, glob, time, pickle
import numpy as np
import torch
import torch.nn as nn
import torch.optim as optim
from collections import deque

from coinche_env import CoincheEnv, STATE_DIM, ACTION_DIM, card_points
from model import CoincheNet
from cfr import CFRTrainer, CoincheCFREnv

# ── Config ────────────────────────────────────────────────────────────────────
CFR_ITERATIONS = 2_000_000
SAVE_EVERY     = 100_000
LOG_EVERY      = 10_000
SAVE_DIR       = 'cfr_checkpoints'

BC_GAMES       = 200_000     # games to generate for behavioral cloning
BC_EPOCHS      = 30
BC_LR          = 1e-3
BC_BATCH       = 512
OUT_ONNX       = 'coinche_bot_cfr.onnx'

os.makedirs(SAVE_DIR, exist_ok=True)

# ═════════════════════════════════════════════════════════════════════════════
# PHASE 1 — CFR TRAINING
# ═════════════════════════════════════════════════════════════════════════════
def train_cfr():
    env     = CoincheEnv()
    trainer = CFRTrainer()

    # Resume if checkpoint exists
    ckpts = sorted(glob.glob(os.path.join(SAVE_DIR, 'cfr_*.pkl')))
    if ckpts:
        trainer.load(ckpts[-1])

    start = trainer.iterations
    t0    = time.time()

    print(f"CFR training — {CFR_ITERATIONS:,} iterations")
    print("-" * 60)

    for it in range(start + 1, CFR_ITERATIONS + 1):
        env.reset()
        trainer.run_iteration(env)

        if it % LOG_EVERY == 0:
            elapsed = time.time() - t0 + 1e-9
            speed   = (it - start) / elapsed
            left_h  = (CFR_ITERATIONS - it) / speed / 3600
            print(f"  iter {it:>9,} | infosets={len(trainer.strategy_sum):>7,} | "
                  f"{speed:,.0f} it/s | ~{left_h:.1f}h left")

        if it % SAVE_EVERY == 0:
            path = os.path.join(SAVE_DIR, f'cfr_{it:08d}.pkl')
            trainer.save(path)

    return trainer


# ═════════════════════════════════════════════════════════════════════════════
# PHASE 2 — BEHAVIORAL CLONING → ONNX
# ═════════════════════════════════════════════════════════════════════════════
def generate_bc_data(trainer: CFRTrainer, n_games: int):
    """
    Play n_games using the CFR average strategy.
    Collect (observation, cfr_action_probs) pairs.
    """
    env  = CoincheEnv()
    game = CoincheCFREnv()

    obs_list  = []
    prob_list = []

    print(f"Generating {n_games:,} BC games…")
    t0 = time.time()

    for i in range(n_games):
        obs  = env.reset()
        game.init_from(env)
        done = False

        while not done:
            p     = env.current_player
            legal = env.get_legal_actions()

            key      = game.infoset_key(p)
            strategy = trainer.avg_strategy(key, legal)

            obs_list.append(obs.copy())
            prob_list.append(strategy.copy())

            # Sample action from CFR strategy
            probs = np.array([strategy[a] for a in legal], dtype=np.float64)
            probs /= probs.sum()
            a     = int(np.random.choice(legal, p=probs))

            undo = game.apply(a)
            obs, _, done = env.step(a)

        if (i + 1) % 20_000 == 0:
            elapsed = time.time() - t0
            print(f"  {i+1:>7,} games | {len(obs_list):,} samples | {elapsed:.0f}s")

    X = np.array(obs_list,  dtype=np.float32)
    Y = np.array(prob_list, dtype=np.float32)
    print(f"Dataset: {X.shape[0]:,} samples")
    return X, Y


def train_bc(X, Y, device):
    """Train a CoincheNet to imitate CFR action probabilities (cross-entropy)."""
    model     = CoincheNet(hidden=256).to(device)
    optimizer = optim.Adam(model.parameters(), lr=BC_LR)
    scheduler = optim.lr_scheduler.CosineAnnealingLR(optimizer, T_max=BC_EPOCHS)

    n        = X.shape[0]
    idx      = np.arange(n)
    best_loss = float('inf')
    best_sd   = None

    print(f"\nBehavioral cloning — {BC_EPOCHS} epochs, batch {BC_BATCH}")
    for epoch in range(1, BC_EPOCHS + 1):
        np.random.shuffle(idx)
        total_loss = 0.0
        steps      = 0

        for start in range(0, n, BC_BATCH):
            batch_idx = idx[start:start + BC_BATCH]
            x_b = torch.FloatTensor(X[batch_idx]).to(device)
            y_b = torch.FloatTensor(Y[batch_idx]).to(device)

            # Create mask: non-zero entries in y_b are legal actions
            mask = (y_b > 1e-9)

            probs, _ = model(x_b, mask)

            # Cross-entropy loss: -sum(y_cfr * log(network_prob))
            log_p = torch.log(probs + 1e-9)
            loss  = -(y_b * log_p).sum(dim=1).mean()

            optimizer.zero_grad()
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            optimizer.step()

            total_loss += loss.item()
            steps      += 1

        avg_loss = total_loss / steps
        scheduler.step()
        print(f"  Epoch {epoch:>3} | loss={avg_loss:.4f}")

        if avg_loss < best_loss:
            best_loss = avg_loss
            best_sd   = {k: v.clone() for k, v in model.state_dict().items()}

    model.load_state_dict(best_sd)
    return model


def export_onnx(model, path, device):
    model.eval()
    dummy_obs  = torch.zeros(1, STATE_DIM,  dtype=torch.float32).to(device)
    dummy_mask = torch.ones (1, ACTION_DIM, dtype=torch.bool).to(device)

    scripted = torch.jit.trace(model, (dummy_obs, dummy_mask))
    torch.onnx.export(
        scripted, (dummy_obs, dummy_mask), path,
        input_names=['obs', 'mask'], output_names=['probs', 'value'],
        opset_version=11, dynamo=False,
    )
    size_kb = os.path.getsize(path) / 1024
    print(f"\n✓ ONNX exported → {path}  ({size_kb:.1f} KB)")
    print(f"  Deploy: copy to rl/coinche_bot_cfr.onnx and update BotRL.js MODEL_PATH")


# ═════════════════════════════════════════════════════════════════════════════
# MAIN
# ═════════════════════════════════════════════════════════════════════════════
if __name__ == '__main__':
    bc_only = '--bc-only' in sys.argv
    device  = 'cpu'

    if bc_only:
        ckpts = sorted(glob.glob(os.path.join(SAVE_DIR, 'cfr_*.pkl')))
        if not ckpts:
            print("No CFR checkpoint found. Run training first.")
            sys.exit(1)
        trainer = CFRTrainer()
        trainer.load(ckpts[-1])
    else:
        trainer = train_cfr()

    # Behavioral cloning
    X, Y = generate_bc_data(trainer, BC_GAMES)
    model = train_bc(X, Y, device)
    export_onnx(model, OUT_ONNX, device)
