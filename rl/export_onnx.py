"""
Export the latest PyTorch checkpoint → coinche_bot.onnx
Run from the rl/ directory: python export_onnx.py
"""

import os
import glob
import torch
from model import CoincheNet
from coinche_env import STATE_DIM, ACTION_DIM

SAVE_DIR = 'checkpoints'
OUT_PATH = 'coinche_bot.onnx'

# ── Find latest checkpoint ─────────────────────────────────────────────────
ckpts = sorted(glob.glob(os.path.join(SAVE_DIR, 'coinche_*.pt')))
if not ckpts:
    raise FileNotFoundError(f'No checkpoints found in {SAVE_DIR}/')

latest = ckpts[-1]
print(f'Loading : {latest}')

ckpt  = torch.load(latest, map_location='cpu', weights_only=True)
model = CoincheNet()
model.load_state_dict(ckpt['model'])
model.eval()
print(f'Episode : {ckpt["episode"]:,}  |  win_rate : {ckpt["win_rate"]:.3f}')

# ── Export ─────────────────────────────────────────────────────────────────
dummy_obs  = torch.zeros(1, STATE_DIM,  dtype=torch.float32)
dummy_mask = torch.ones (1, ACTION_DIM, dtype=torch.bool)

traced = torch.jit.trace(model, (dummy_obs, dummy_mask))
torch.onnx.export(
    traced,
    (dummy_obs, dummy_mask),
    OUT_PATH,
    input_names   = ['obs', 'mask'],
    output_names  = ['probs', 'value'],
    opset_version = 11,
    dynamo        = False,
)

size_kb = os.path.getsize(OUT_PATH) / 1024
ep = ckpt['episode']
print(f'✓ Exported → {OUT_PATH}  ({size_kb:.1f} KB)')
print(f'  Commit with: git add rl/coinche_bot.onnx && git commit -m "add RL bot model ep{ep}"')
