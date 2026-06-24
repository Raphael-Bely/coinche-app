'use strict';
const { SUITS, RANKS } = require('./constants');

function createDeck() {
  const deck = [];
  for (const suit of SUITS)
    for (const rank of RANKS)
      deck.push({ suit, rank, id: `${rank}${suit}` });
  return deck;
}

function shuffle(deck) {
  const d = [...deck];
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

// Classic coinche deal: 3-2-3 to each of 4 players = 8 cards each
function deal(deck) {
  const hands = [[], [], [], []];
  let idx = 0;
  for (const g of [3, 2, 3])
    for (let p = 0; p < 4; p++)
      for (let c = 0; c < g; c++)
        hands[p].push(deck[idx++]);
  return hands;
}

module.exports = { createDeck, shuffle, deal };
