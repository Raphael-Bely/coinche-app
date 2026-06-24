'use strict';
const { PLAIN_STRENGTH, TRUMP_STRENGTH } = require('./constants');

function _str(card, trump) {
  if (trump === 'SA')                        return PLAIN_STRENGTH[card.rank];
  if (trump === 'TA' || card.suit === trump) return TRUMP_STRENGTH[card.rank];
  return PLAIN_STRENGTH[card.rank];
}

// Returns playerIdx of trick winner
function trickWinner(trick, trump) {
  if (!trick.length) return null;
  const led = trick[0].card.suit;
  let w = trick[0];

  for (let i = 1; i < trick.length; i++) {
    const { card } = trick[i];
    const wc = w.card;

    if (trump === 'SA' || trump === 'TA') {
      // Only led-suit cards can win (other suits are powerless)
      if (card.suit === led && _str(card, trump) > _str(wc, trump)) w = trick[i];
    } else {
      if (card.suit === wc.suit) {
        if (_str(card, trump) > _str(wc, trump)) w = trick[i];
      } else if (card.suit === trump && wc.suit !== trump) {
        w = trick[i]; // trump overtakes non-trump
      }
    }
  }
  return w.playerIdx;
}

function _currentWinner(trick, trump) {
  return trickWinner(trick, trump);
}

// Returns the subset of hand the player is ALLOWED to play
function getPlayableCards(hand, trick, trump, playerIdx, partnerIdx) {
  if (!trick.length) return hand; // lead: anything goes

  const led = trick[0].card.suit;
  const winnerIdx = _currentWinner(trick, trump);
  const partnerWinning = winnerIdx === partnerIdx;

  // ── SA: no trump, must follow suit ──────────────────────────────────
  if (trump === 'SA') {
    const follow = hand.filter(c => c.suit === led);
    return follow.length ? follow : hand;
  }

  // ── TA: all suits are trump; must follow led suit and overstump ─────
  if (trump === 'TA') {
    const follow = hand.filter(c => c.suit === led);
    if (!follow.length) return hand; // can't follow → discard (won't win)
    const wc = trick.find(t => t.playerIdx === winnerIdx).card;
    const higher = follow.filter(c => _str(c, 'TA') > _str(wc, 'TA'));
    return higher.length ? higher : follow;
  }

  // ── Normal game with a trump suit ────────────────────────────────────
  const hasSuit = hand.some(c => c.suit === led);

  if (hasSuit) {
    const follow = hand.filter(c => c.suit === led);
    if (led === trump) {
      // Following trump suit: must overstump if possible
      const wc = trick.find(t => t.playerIdx === winnerIdx).card;
      const higher = follow.filter(c => _str(c, trump) > _str(wc, trump));
      return higher.length ? higher : follow;
    }
    return follow;
  }

  // Can't follow led suit
  const trumpCards = hand.filter(c => c.suit === trump);
  if (!trumpCards.length) return hand; // no trumps → free discard

  if (partnerWinning) return hand; // partner winning → no obligation to cut

  // Must cut; overstump current trump winner if possible
  const wc = trick.find(t => t.playerIdx === winnerIdx)?.card;
  if (wc && wc.suit === trump) {
    const higher = trumpCards.filter(c => _str(c, trump) > _str(wc, trump));
    return higher.length ? higher : trumpCards;
  }
  return trumpCards;
}

module.exports = { trickWinner, getPlayableCards };
