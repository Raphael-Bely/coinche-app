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

// Returns { value, suit } to bid, or null to pass
function chooseBid(hand, currentBid) {
  const curNum = currentBid
    ? (currentBid.value === 'Capot' ? 999 : Number(currentBid.value))
    : 70;

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

function bestLead(playable, trump) {
  // If holding trump J or 9, lead trump to pull opponent's trumps
  if (trump !== 'SA' && trump !== 'TA') {
    const trumps = playable.filter(c => c.suit === trump);
    if (trumps.some(c => c.rank === 'J' || c.rank === '9')) {
      return strongest(trumps, trump);
    }
  }
  // Lead an ace (safe trick)
  const aces = playable.filter(c => c.rank === 'A');
  if (aces.length) return aces[0];

  // Lead highest card in the longest suit
  const bySuit = {};
  for (const c of playable) {
    if (!bySuit[c.suit]) bySuit[c.suit] = [];
    bySuit[c.suit].push(c);
  }
  const longest = Object.values(bySuit).reduce((a, b) => a.length >= b.length ? a : b);
  return strongest(longest, trump);
}

function normalPlay(room, pi) {
  const trump    = room.currentBid?.suit;
  const partner  = room.partnerOf(pi);
  const playable = getPlayableCards(room.hands[pi], room.currentTrick, trump, pi, partner);
  if (!playable.length) return {};
  if (playable.length === 1) return room.playCard(`bot:${pi}`, playable[0].id);

  const trick = room.currentTrick;

  // Leading
  if (!trick.length) {
    return room.playCard(`bot:${pi}`, bestLead(playable, trump).id);
  }

  // Following: is partner currently winning?
  const winnerIdx    = trickWinner(trick, trump);
  const partnerWins  = winnerIdx === partner;

  if (partnerWins) {
    // Don't waste — dump cheapest card
    return room.playCard(`bot:${pi}`, cheapest(playable, trump).id);
  }

  // Opponent winning — try to beat with cheapest winning card
  const winCard = trick.find(t => t.playerIdx === winnerIdx).card;
  const winner  = cheapestWinner(playable, winCard, trump);
  if (winner) {
    return room.playCard(`bot:${pi}`, winner.id);
  }

  // Can't win — dump cheapest
  return room.playCard(`bot:${pi}`, cheapest(playable, trump).id);
}

module.exports = { normalPlay, chooseBid };
