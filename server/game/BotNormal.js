'use strict';
const {
  PLAIN_STRENGTH, TRUMP_STRENGTH,
  PLAIN_VALUES, TRUMP_VALUES, SA_VALUES,
  CONTRACT_SUITS,
} = require('./constants');
const { getPlayableCards, trickWinner } = require('./Trick');

// ─── Card helpers ─────────────────────────────────────────────────────────────

function isTrump(card, trump) {
  return trump === 'TA' || (trump !== 'SA' && card.suit === trump);
}

function strength(card, trump) {
  if (trump === 'SA') return PLAIN_STRENGTH[card.rank];
  if (trump === 'TA' || card.suit === trump) return TRUMP_STRENGTH[card.rank];
  return PLAIN_STRENGTH[card.rank];
}

function pointValue(card, trump) {
  if (trump === 'SA') return SA_VALUES[card.rank];
  if (isTrump(card, trump)) return TRUMP_VALUES[card.rank];
  return PLAIN_VALUES[card.rank];
}

function cheapest(cards, trump) {
  return cards.reduce((min, c) => pointValue(c, trump) < pointValue(min, trump) ? c : min);
}

function strongest(cards, trump) {
  return cards.reduce((best, c) => strength(c, trump) > strength(best, trump) ? c : best);
}

// Cheapest card from `candidates` that beats `target` in the same comparative space
function cheapestWinner(candidates, target, trump) {
  const winners = candidates.filter(c => strength(c, trump) > strength(target, trump));
  if (!winners.length) return null;
  return winners.reduce((min, c) => strength(c, trump) < strength(min, trump) ? c : min);
}

// Suits where we hold exactly 2 non-trump cards and one of them is a 10.
// Dumping from these suits costs us the 10 on the next lead — protect them.
function protectedSuits(hand, trump) {
  const bySuit = {};
  for (const c of hand) {
    if (isTrump(c, trump)) continue;
    (bySuit[c.suit] = bySuit[c.suit] || []).push(c);
  }
  const result = new Set();
  for (const [suit, cards] of Object.entries(bySuit))
    if (cards.length === 2 && cards.some(c => c.rank === '10')) result.add(suit);
  return result;
}

// Partner played the Jack of trump: nothing in the deck can beat it.
function partnerPlayedJack(trick, partner, trump) {
  if (!trump || trump === 'SA' || trump === 'TA') return false;
  const pp = trick.find(t => t.playerIdx === partner);
  return pp?.card.suit === trump && pp?.card.rank === 'J';
}

// Choose the safest card to sacrifice from `playable`.
// Priority (least damaging first):
//   1. non-trump, non-A, non-10, not from a protected suit
//   2. non-trump, non-A, non-10  (protected suit: must dump something)
//   3. small trump (not J/9/A/10 of trump) — better than an Ace or plain 10
//   4. non-trump, non-A          (forced to dump a plain 10)
//   5. cheapest available        (last resort — may be an Ace)
function safeDump(playable, hand, trump) {
  const nonTr = playable.filter(c => !isTrump(c, trump));
  const prot  = protectedSuits(hand, trump);

  const s1 = nonTr.filter(c => c.rank !== 'A' && c.rank !== '10' && !prot.has(c.suit));
  if (s1.length) return cheapest(s1, trump);

  const s2 = nonTr.filter(c => c.rank !== 'A' && c.rank !== '10');
  if (s2.length) return cheapest(s2, trump);

  const smallTr = playable.filter(c =>
    isTrump(c, trump) && c.rank !== 'J' && c.rank !== '9' && c.rank !== 'A' && c.rank !== '10');
  if (smallTr.length) return cheapest(smallTr, trump);

  const s3 = nonTr.filter(c => c.rank !== 'A');
  if (s3.length) return cheapest(s3, trump);

  return cheapest(playable, trump);
}

// ─── Bidding ──────────────────────────────────────────────────────────────────

function evalHand(hand, suit) {
  let score = 0;
  for (const c of hand) {
    if (suit === 'SA') {
      // Sans-Atout: aces & tens dominate
      if      (c.rank === 'A')  score += 3.0;
      else if (c.rank === '10') score += 1.2;
      else if (c.rank === 'K')  score += 0.7;
      else if (c.rank === 'Q')  score += 0.3;
    } else if (suit === 'TA') {
      // Tout-Atout: jacks & 9s in every suit are powerful
      if      (c.rank === 'J')  score += 3.0;
      else if (c.rank === '9')  score += 2.0;
      else if (c.rank === 'A')  score += 1.2;
      else if (c.rank === 'K')  score += 0.8;
      else if (c.rank === 'Q')  score += 0.6;
      else if (c.rank === '10') score += 0.6;
    } else if (c.suit === suit) {
      // Trump cards: J (20pts) and 9 (14pts) are king
      if      (c.rank === 'J')  score += 5.0;
      else if (c.rank === '9')  score += 3.0;
      else if (c.rank === 'A')  score += 2.0;
      else if (c.rank === 'K')  score += 1.0;
      else if (c.rank === 'Q')  score += 0.5;
      else if (c.rank === '10') score += 1.0;
    } else {
      // Off-suit plain cards
      if      (c.rank === 'A')  score += 1.5;
      else if (c.rank === '10') score += 0.6;
      else if (c.rank === 'K')  score += 0.4;
      else if (c.rank === 'Q')  score += 0.2;
    }
  }
  return score;
}

function bidOrd(v) {
  if (!v) return 70;
  if (v === 'Capot')           return 250;
  if (v === 'Capot Beloté')    return 270;
  if (v === 'Générale')        return 400;
  if (v === 'Générale Beloté') return 420;
  return Number(v);
}

// Returns { value, suit } to bid, or null to pass
function chooseBid(hand, currentBid) {
  const curNum = bidOrd(currentBid?.value);

  const BID_STEPS = [80, 90, 100, 110, 120, 130, 140, 150, 160];

  let best = null;
  for (const suit of CONTRACT_SUITS) {
    const score = evalHand(hand, suit);
    // Small randomness so bots don't always pick the same suit/value
    const adj = score + (Math.random() * 0.8 - 0.2);
    // score 5 → 80 minimum, each additional point adds ~10
    const rawBid = 70 + (Math.round(adj) - 4) * 10;
    const cap    = Math.min(rawBid, 160);
    const step   = [...BID_STEPS].filter(v => v > curNum && v <= cap).at(-1);
    if (!step) continue;
    if (!best || adj > best.adj) best = { suit, adj, value: step };
  }
  return best; // null → pass
}

// ─── Playing ──────────────────────────────────────────────────────────────────

// True if opponents still hold at least one trump card (bot can see all hands)
function opponentsHaveTrump(room, pi, trump) {
  if (!trump || trump === 'SA' || trump === 'TA') return false;
  const partner = room.partnerOf(pi);
  return [0,1,2,3].filter(i => i !== pi && i !== partner)
    .some(i => room.hands[i].some(c => c.suit === trump));
}

// True if this card is the highest remaining card in its suit
function isHighestRemaining(room, card, trump) {
  const all = room.hands.flat().concat(room.currentTrick.map(t => t.card));
  return all.filter(c => c.suit === card.suit)
    .every(c => strength(c, trump) <= strength(card, trump));
}

// Suit that partner last led (signal of preference)
function partnerPreferredSuit(room, pi, trump) {
  const partner = room.partnerOf(pi);
  for (const trick of [...room.tricks].reverse()) {
    const lead = trick.cards[0];
    if (lead.playerIdx === partner && lead.card.suit !== trump) return lead.card.suit;
  }
  return null;
}

function bestLead(room, pi, playable, trump) {
  // ── Trump pulling: J → 9 → continue if team is winning ──
  if (trump && trump !== 'SA' && trump !== 'TA') {
    const myTrumps = playable.filter(c => c.suit === trump);
    if (myTrumps.length && opponentsHaveTrump(room, pi, trump)) {
      const J = myTrumps.find(c => c.rank === 'J');
      if (J) return J;
      const nine = myTrumps.find(c => c.rank === '9');
      if (nine) return nine;
      // Continue pulling if master, or partner won a recent trick (team dominant)
      const partnerWonRecently = room.tricks.slice(-3, -1).some(t => t.winner === partner);
      if (isHighestRemaining(room, strongest(myTrumps, trump), trump) || partnerWonRecently)
        return strongest(myTrumps, trump);
    }
  }

  // ── Winning cards: guaranteed-win leads ──
  const winners = playable.filter(c =>
    (!isTrump(c, trump) || trump === 'TA') && isHighestRemaining(room, c, trump));
  if (winners.length) {
    // Prefer non-trump winners; prefer aces
    const aces = winners.filter(c => c.rank === 'A');
    if (aces.length) return aces[0];
    return winners[0];
  }

  // ── Aces (probably winning even if not verified) ──
  const aces = playable.filter(c => c.rank === 'A' && !isTrump(c, trump));
  if (aces.length) return aces[0];

  // ── Lead partner's preferred suit ──
  const prefSuit = partnerPreferredSuit(room, pi, trump);
  if (prefSuit) {
    const pref = playable.filter(c => c.suit === prefSuit);
    if (pref.length) return strongest(pref, trump);
  }

  // ── Short suit: lead singleton/cheap doubleton to void and ruff later ──
  if (trump && trump !== 'SA' && trump !== 'TA') {
    const nonTr = playable.filter(c => !isTrump(c, trump));
    if (nonTr.length) {
      const bySuit = {};
      for (const c of nonTr) (bySuit[c.suit] = bySuit[c.suit] || []).push(c);
      const suits = Object.values(bySuit).sort((a, b) => a.length - b.length);
      for (const s of suits) {
        if (s.length > 2) break;
        if (s.length === 1) return s[0];
        if (!s.some(c => c.rank === 'A' || c.rank === '10'))
          return cheapest(s, trump);
      }
    }
  }

  return strongest(playable, trump);
}

function normalPlay(room, pi) {
  const trump    = room.currentBid?.suit;
  const partner  = room.partnerOf(pi);
  const sid      = room.players[pi]?.socketId;
  const playable = getPlayableCards(room.hands[pi], room.currentTrick, trump, pi, partner);
  if (!playable.length) return {};
  if (playable.length === 1) return room.playCard(sid, playable[0].id);

  const trick = room.currentTrick;

  // Leading
  if (!trick.length) {
    return room.playCard(sid, bestLead(room, pi, playable, trump).id);
  }

  // Following: is partner currently winning?
  const winnerIdx   = trickWinner(trick, trump);
  const partnerWins = winnerIdx === partner;
  const isLast      = trick.length === 3;

  if (partnerWins) {
    // Secure win: last to play, or partner played the Jack of trump (unbeatable)
    const secure = isLast || partnerPlayedJack(trick, partner, trump);
    if (secure) {
      // Give our highest-value card — every point counts for the team
      const nonTrump = playable.filter(c => !isTrump(c, trump));
      const pool = nonTrump.length ? nonTrump : playable;
      const best = pool.reduce((max, c) => pointValue(c, trump) > pointValue(max, trump) ? c : max);
      return room.playCard(sid, best.id);
    }
    // Opponent still to play — dump safely: protect Aces, 10s and vulnerable suits
    return room.playCard(sid, safeDump(playable, room.hands[pi], trump).id);
  }

  // Opponent winning — try to beat
  const winCard = trick.find(t => t.playerIdx === winnerIdx).card;
  const over = cheapestWinner(playable, winCard, trump);
  if (over) return room.playCard(sid, over.id);

  // Can't beat — dump safely (protect Aces, 10s and protected suits)
  return room.playCard(sid, safeDump(playable, room.hands[pi], trump).id);
}

// ─── Classic bidding heuristic ───────────────────────────────────────────────
// Rules per user spec: J+9 → 80, 4 trumps with J+9 → 100,
// +10 per off-suit ace or coupe franche, partner support bonuses.

const PLAIN_SUITS = ['♠', '♥', '♦', '♣'];

function chooseBidClassique(hand, currentBid, partnerBid) {
  const curNum = bidOrd(currentBid?.value);

  const BID_STEPS = [80, 90, 100, 110, 120, 130, 140, 150, 160];

  function clamp(val) {
    return BID_STEPS.filter(v => v > curNum && v <= Math.min(val, 160)).at(-1) ?? null;
  }

  const candidates = [];

  // Normal trump suits
  for (const suit of PLAIN_SUITS) {
    const trumps = hand.filter(c => c.suit === suit);
    const hasJ   = trumps.some(c => c.rank === 'J');
    const has9   = trumps.some(c => c.rank === '9');

    if (!hasJ) continue; // J required to open a suit

    // Base value: J+9 = 80, J alone = 60 (needs aces to reach 80)
    let val = has9 ? 80 : 60;

    // 3+ trumps with J+9 → push up
    if (has9 && trumps.length >= 4) val = 100;
    else if (has9 && trumps.length === 3) val = 90;

    const offSuits = PLAIN_SUITS.filter(s => s !== suit);

    // +10 per off-suit ace
    for (const s of offSuits) {
      if (hand.some(c => c.suit === s && c.rank === 'A')) val += 10;
    }

    // +10 per coupe franche (void or singleton in non-trump suit)
    for (const s of offSuits) {
      if (hand.filter(c => c.suit === s).length <= 1) val += 10;
    }

    // Partner support: +20 with J, +10 with 9, +10 per ace held
    if (partnerBid && partnerBid.suit === suit) {
      if (hasJ) val += 20;
      if (has9) val += 10;
      for (const c of hand) if (c.rank === 'A') val += 10;
    }

    const step = clamp(val);
    if (step) candidates.push({ suit, val, value: step });
  }

  // SA: aces/tens win tricks, each A=20, 10=10, K=5
  {
    let val = 0;
    for (const c of hand) {
      if (c.rank === 'A') val += 20;
      if (c.rank === '10') val += 10;
      if (c.rank === 'K') val += 5;
    }
    if (partnerBid?.suit === 'SA') val += 20;
    const step = clamp(val);
    if (step) candidates.push({ suit: 'SA', val, value: step });
  }

  // TA: every J is a master (25pts each), 9s are strong (15pts each)
  {
    const js    = hand.filter(c => c.rank === 'J').length;
    const nines = hand.filter(c => c.rank === '9').length;
    let val = js * 25 + nines * 15;
    for (const c of hand) if (c.rank === 'A') val += 5;
    if (partnerBid?.suit === 'TA') val += 20;
    const step = clamp(val);
    if (step) candidates.push({ suit: 'TA', val, value: step });
  }

  if (!candidates.length) return null;
  return candidates.reduce((best, c) => c.val > best.val ? c : best);
}

module.exports = { normalPlay, chooseBid, chooseBidClassique };
