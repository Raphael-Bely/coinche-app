'use strict';
const { SUITS, SEQ_ORDER, SEQ_ORDER_IDX, ANNOUNCE_DEFS } = require('./constants');

function detectAnnouncements(hand) {
  const announces = [];

  // ── Carrés (4 of a kind for eligible ranks) ──────────────────────
  const byRank = {};
  for (const c of hand) byRank[c.rank] = (byRank[c.rank] || 0) + 1;

  for (const [rank, count] of Object.entries(byRank)) {
    if (count === 4 && ['J', '9', 'A', '10', 'K', 'Q'].includes(rank)) {
      const key = `carre_${rank}`;
      const def = ANNOUNCE_DEFS[key];
      announces.push({
        id:          key,
        type:        key,
        pts:         def.pts,
        tier:        def.tier,
        topRankIdx:  SEQ_ORDER_IDX[rank],
        label:       def.label,
        suit:        null,
      });
    }
  }

  // ── Sequences per suit ────────────────────────────────────────────
  for (const suit of SUITS) {
    const idxs = hand
      .filter(c => c.suit === suit)
      .map(c => SEQ_ORDER_IDX[c.rank])
      .sort((a, b) => a - b);

    if (idxs.length < 3) continue;

    const runs = [];
    let run = [idxs[0]];
    for (let i = 1; i < idxs.length; i++) {
      if (idxs[i] === idxs[i - 1] + 1) run.push(idxs[i]);
      else { if (run.length >= 3) runs.push([...run]); run = [idxs[i]]; }
    }
    if (run.length >= 3) runs.push(run);

    for (const r of runs) {
      const topIdx = r[r.length - 1];
      const type   = r.length >= 5 ? 'quinte' : r.length === 4 ? 'quarte' : 'tierce';
      const def    = ANNOUNCE_DEFS[type];
      const topRank = SEQ_ORDER[topIdx];
      announces.push({
        id:         `${type}_${suit}_${topRank}`,
        type,
        pts:        def.pts,
        tier:       def.tier,
        topRankIdx: topIdx,
        label:      `${def.label} en ${suit} (${SEQ_ORDER[r[0]]}–${topRank})`,
        suit,
      });
    }
  }

  return announces;
}

function _best(list) {
  if (!list || list.length === 0) return null;
  return list.reduce((b, a) => {
    if (a.tier > b.tier) return a;
    if (a.tier === b.tier && a.topRankIdx > b.topRankIdx) return a;
    return b;
  });
}

function _cmp(a, b, trump) {
  if (a.tier !== b.tier) return a.tier - b.tier;
  if (a.topRankIdx !== b.topRankIdx) return a.topRankIdx - b.topRankIdx;
  if (a.suit === trump && b.suit !== trump) return 1;
  if (b.suit === trump && a.suit !== trump) return -1;
  return 0;
}

// Returns 0 (team 0 wins), 1 (team 1 wins), -1 (tie → nobody scores)
function resolveAnnouncementWinner(t0, t1, trump) {
  const b0 = _best(t0), b1 = _best(t1);
  if (!b0 && !b1) return -1;
  if (!b0) return 1;
  if (!b1) return 0;
  const c = _cmp(b0, b1, trump);
  if (c > 0) return 0;
  if (c < 0) return 1;
  return -1;
}

function sumAnnounces(list) {
  return (list || []).reduce((s, a) => s + a.pts, 0);
}

module.exports = { detectAnnouncements, resolveAnnouncementWinner, sumAnnounces };
