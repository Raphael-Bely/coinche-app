'use strict';
const path = require('path');
const { getPlayableCards } = require('./Trick');
const { normalPlay, chooseBid } = require('./BotNormal');

// ─── Card encoding (must match coinche_env.py exactly) ────────────────────────
// SUITS = ['S'='♠', 'H'='♥', 'D'='♦', 'C'='♣']
// RANKS = ['7','8','9','10','J','Q','K','A'] → indices 0-7
// card_id = suit_index * 8 + rank_index

const SUIT_IDX  = { '♠': 0, '♥': 1, '♦': 2, '♣': 3 };
const RANK_IDX  = { '7': 0, '8': 1, '9': 2, '10': 3, 'J': 4, 'Q': 5, 'K': 6, 'A': 7 };
const TRUMP_IDX = { '♠': 0, '♥': 1, '♦': 2, '♣': 3, 'SA': 4, 'TA': 5 };

const STATE_DIM  = 205;
const ACTION_DIM = 32;

function cardId(card) {
  const si = SUIT_IDX[card.suit];
  const ri = RANK_IDX[card.rank];
  return (si !== undefined && ri !== undefined) ? si * 8 + ri : -1;
}

// ─── Point values for running score ───────────────────────────────────────────
const PLAIN_PTS = { '7': 0, '8': 0, '9': 0, '10': 10, 'J': 2, 'Q': 3, 'K': 4, 'A': 11 };
const TRUMP_PTS = { '7': 0, '8': 0, '9': 14, '10': 10, 'J': 20, 'Q': 3, 'K': 4, 'A': 11 };
const SA_PTS    = { '7': 0, '8': 0, '9': 0, '10': 10, 'J': 2, 'Q': 3, 'K': 4, 'A': 19 };

function pts(card, trump) {
  if (trump === 'SA') return SA_PTS[card.rank] ?? 0;
  if (trump === 'TA' || card.suit === trump) return TRUMP_PTS[card.rank] ?? 0;
  return PLAIN_PTS[card.rank] ?? 0;
}

// ─── State vector builder ─────────────────────────────────────────────────────
// Mirrors CoincheEnv._observe() in coinche_env.py
function buildState(room, pi) {
  const obs   = new Float32Array(STATE_DIM);
  const trump = room.currentBid?.suit;

  // [0:32]   my hand (one-hot)
  for (const card of room.hands[pi]) {
    const cid = cardId(card);
    if (cid >= 0) obs[cid] = 1.0;
  }

  // [32:64]  cards seen in completed tricks (one-hot)
  for (const trick of room.tricks) {
    for (const { card } of trick.cards) {
      const cid = cardId(card);
      if (cid >= 0) obs[32 + cid] = 1.0;
    }
  }

  // [64:192] current trick, slot i = i-th card played this trick
  for (let i = 0; i < room.currentTrick.length; i++) {
    const cid = cardId(room.currentTrick[i].card);
    if (cid >= 0) obs[64 + i * 32 + cid] = 1.0;
  }

  // [192:198] trump one-hot
  const tidx = TRUMP_IDX[trump];
  if (tidx !== undefined) obs[192 + tidx] = 1.0;

  // [198:202] position one-hot
  if (pi >= 0 && pi < 4) obs[198 + pi] = 1.0;

  // [202]    tricks done / 8
  obs[202] = room.tricks.length / 8.0;

  // [203:205] running trick scores (my team, opponents), normalised to [0,1]
  const myTeam = room.teamOf(pi);
  const scores = [0, 0];
  for (const trick of room.tricks) {
    const team = room.teamOf(trick.winner);
    for (const { card } of trick.cards) scores[team] += pts(card, trump);
  }
  obs[203] = scores[myTeam]     / 162.0;
  obs[204] = scores[1 - myTeam] / 162.0;

  return obs;
}

// ─── ONNX session (loaded once at startup) ────────────────────────────────────
let session      = null;
let onnxReady    = false;
let loadAttempted = false;

const MODEL_PATH = path.join(__dirname, '../../rl/coinche_bot.onnx');

async function loadModel() {
  if (loadAttempted) return;
  loadAttempted = true;
  try {
    const ort = require('onnxruntime-node');
    session   = await ort.InferenceSession.create(MODEL_PATH);
    onnxReady = true;
    console.log('[BotRL] ONNX model loaded —', MODEL_PATH);
  } catch (e) {
    // Model or onnxruntime-node not available — silent fallback to normalPlay
    const reason = e.code === 'MODULE_NOT_FOUND'
      ? 'onnxruntime-node not installed (run: cd server && npm install)'
      : `model not found at ${MODEL_PATH}`;
    console.log(`[BotRL] Fallback to normalPlay — ${reason}`);
  }
}

loadModel();

// ─── Inference ────────────────────────────────────────────────────────────────
async function rlPlay(room, pi) {
  if (!onnxReady || !session) return normalPlay(room, pi);

  const trump   = room.currentBid?.suit;
  const partner = room.partnerOf(pi);
  const playable = getPlayableCards(room.hands[pi], room.currentTrick, trump, pi, partner);
  if (!playable.length) return {};
  if (playable.length === 1) return room.playCard(room.players[pi]?.socketId, playable[0].id);

  try {
    const ort = require('onnxruntime-node');

    const obs  = buildState(room, pi);
    const mask = new Uint8Array(ACTION_DIM);
    const legalSet = new Set(playable.map(cardId));
    for (const cid of legalSet) if (cid >= 0) mask[cid] = 1;

    const result = await session.run({
      obs:  new ort.Tensor('float32', obs,  [1, STATE_DIM]),
      mask: new ort.Tensor('bool',    mask, [1, ACTION_DIM]),
    });

    const probs = result.probs.data;
    let bestCid = -1, bestProb = -1;
    for (const cid of legalSet) {
      if (cid >= 0 && probs[cid] > bestProb) { bestProb = probs[cid]; bestCid = cid; }
    }

    const chosen = bestCid >= 0 ? playable.find(c => cardId(c) === bestCid) : null;
    if (chosen) return room.playCard(room.players[pi]?.socketId, chosen.id);
  } catch (e) {
    console.error('[BotRL] Inference error:', e.message);
  }

  return normalPlay(room, pi);
}

module.exports = { rlPlay, chooseBid };
