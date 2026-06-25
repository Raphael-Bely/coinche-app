'use strict';
const { PLAIN_VALUES, TRUMP_VALUES, SA_VALUES, TA_VALUES } = require('./constants');

function cardValue(card, trump) {
  if (trump === 'SA')          return SA_VALUES[card.rank];
  if (trump === 'TA')          return TA_VALUES[card.rank];
  if (card.suit === trump)     return TRUMP_VALUES[card.rank];
  return PLAIN_VALUES[card.rank];
}

function trickPoints(tricks, trump) {
  let t0 = 0, t1 = 0;
  for (const trick of tricks) {
    const pts = trick.cards.reduce((s, { card }) => s + cardValue(card, trump), 0);
    if (trick.winner % 2 === 0) t0 += pts; else t1 += pts;
  }
  // Dix de der: +10 to the team that won the last trick
  if (tricks.length > 0) {
    if (tricks.at(-1).winner % 2 === 0) t0 += 10; else t1 += 10;
  }
  return [t0, t1];
}

/*
 * Scoring modes:
 *   net          → make: bid value; fail (chute): opponent gets 160 (or 250 for Capot)
 *   reel         → make: each team keeps their real trick pts; fail: opponent takes all pts
 *   reel_contrat → make: real pts + bid value; fail: opponent real pts + bid value
 *
 * Coinche ×2, surcoinche ×4 applied to game scores.
 * Announces and belote are NOT multiplied (per most common house rules).
 */
// Numeric ordering for comparison/scoring (must match GameRoom.BID_NUMERIC)
function bidNumeric(v) {
  if (v === 'Capot')           return 250;
  if (v === 'Capot Beloté')    return 270;
  if (v === 'Générale')        return 400;
  if (v === 'Générale Beloté') return 420;
  return Number(v);
}

function scoreRound({
  tricks, trump,
  contractTeam, contractValue, contractPlayerIdx,
  isCoinched, isSurcoinched,
  announcePts,   // [t0, t1]
  belotePts,     // [t0, t1]
  scoringMode,
}) {
  const mult = isSurcoinched ? 4 : isCoinched ? 2 : 1;

  const isCapot       = contractValue === 'Capot';
  const isCapotBelote = contractValue === 'Capot Beloté';
  const isGenerale    = contractValue === 'Générale';
  const isGenBelote   = contractValue === 'Générale Beloté';
  const isAllTricks   = isCapot || isCapotBelote || isGenerale || isGenBelote;

  const bidNum  = bidNumeric(contractValue);
  const defTeam = 1 - contractTeam;

  const [tp0, tp1] = trickPoints(tricks, trump);
  const myTrickPts  = contractTeam === 0 ? tp0 : tp1;
  const defTrickPts = contractTeam === 0 ? tp1 : tp0;

  // Determine chute (contract failure)
  let chute;
  if (isCapot || isCapotBelote) {
    chute = !tricks.every(t => t.winner % 2 === contractTeam);
    if (!chute && isCapotBelote) chute = (belotePts[contractTeam] ?? 0) === 0;
  } else if (isGenerale || isGenBelote) {
    // Contracting player must win all 8 tricks solo
    chute = contractPlayerIdx < 0
      ? !tricks.every(t => t.winner % 2 === contractTeam)
      : !tricks.every(t => t.winner === contractPlayerIdx);
    if (!chute && isGenBelote) chute = (belotePts[contractTeam] ?? 0) === 0;
  } else {
    chute = (myTrickPts + announcePts[contractTeam] + belotePts[contractTeam]) < bidNum;
  }

  // Penalty for chute
  const chuteValue = (isGenerale || isGenBelote) ? 400
                   : (isCapot   || isCapotBelote) ? 250
                   : 160;

  let t0 = 0, t1 = 0;

  if (scoringMode === 'net') {
    if (chute) {
      if (defTeam === 0) t0 = chuteValue * mult; else t1 = chuteValue * mult;
    } else {
      if (contractTeam === 0) t0 = bidNum * mult; else t1 = bidNum * mult;
    }
    t0 += announcePts[0] + belotePts[0];
    t1 += announcePts[1] + belotePts[1];

  } else if (scoringMode === 'reel') {
    if (chute) {
      const total = (tp0 + tp1 + announcePts[0] + announcePts[1] + belotePts[0] + belotePts[1]) * mult;
      if (defTeam === 0) t0 = total; else t1 = total;
    } else {
      t0 = (tp0 + announcePts[0] + belotePts[0]) * mult;
      t1 = (tp1 + announcePts[1] + belotePts[1]) * mult;
    }

  } else { // reel_contrat
    if (chute) {
      const total = (defTrickPts + bidNum + announcePts[0] + announcePts[1] + belotePts[0] + belotePts[1]) * mult;
      if (defTeam === 0) t0 = total; else t1 = total;
    } else {
      if (contractTeam === 0) {
        t0 = (myTrickPts + bidNum + announcePts[0] + belotePts[0]) * mult;
        t1 = (defTrickPts + announcePts[1] + belotePts[1]) * mult;
      } else {
        t1 = (myTrickPts + bidNum + announcePts[1] + belotePts[1]) * mult;
        t0 = (defTrickPts + announcePts[0] + belotePts[0]) * mult;
      }
    }
  }

  return {
    chute,
    team0Score: Math.round(t0),
    team1Score: Math.round(t1),
    trickPts:   [tp0, tp1],
    announcePts,
    belotePts,
    multiplier: mult,
    bidNum,
  };
}

module.exports = { cardValue, scoreRound };
