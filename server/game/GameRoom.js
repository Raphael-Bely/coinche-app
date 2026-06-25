'use strict';
const { createDeck, shuffle, deal }              = require('./Deck');
const { detectAnnouncements, resolveAnnouncementWinner, sumAnnounces } = require('./Announce');
const { trickWinner, getPlayableCards }           = require('./Trick');
const { scoreRound, cardValue }                   = require('./Scoring');

const STATE = {
  WAITING:    'waiting',
  BIDDING:    'bidding',
  ANNOUNCE:   'announce',
  PLAYING:    'playing',
  ROUND_OVER: 'round_over',
  GAME_OVER:  'game_over',
};

class GameRoom {
  constructor(code, settings = {}) {
    this.code     = code;
    this.settings = {
      maxPoints:      Number(settings.maxPoints)  || 1000,
      scoringMode:    settings.scoringMode         || 'net',
      beloteFrom:     settings.beloteFrom === 'off' ? 'off' : (Number(settings.beloteFrom) || 80),
      countAnnounces: settings.countAnnounces      !== false,
      public:         !!settings.public,
    };

    this.players     = [];            // [{ socketId, name, idx, isBot? }]
    this.teams       = [[0, 2], [1, 3]];
    this.botIdxs     = new Set();

    this.state       = STATE.WAITING;
    this.dealerIdx   = 0;
    this.hands       = [[], [], [], []];
    this.totalScores = [0, 0];
    this.roundHistory = [];

    this._resetRound();
  }

  _resetRound() {
    this.tricks        = [];
    this.currentTrick  = [];
    this.lastTrick     = null;
    this.roundResult   = null;
    this.currentPlayerIdx = 0;

    this.bids          = [];
    this.currentBid    = null;
    this.coinched      = false;
    this.surcoinched   = false;
    this.passCount     = 0;
    this.biddingIdx    = 0;

    this.detectedAnn   = [[], [], [], []];
    this.declaredAnn   = [null, null, null, null];
    this.announceWinnerTeam = -1;

    // belotePlayed[player][suit] = { K, Q } — tracks per suit to support TA
    this.belotePlayed  = Array(4).fill(null).map(() => ({
      '♠': { K: false, Q: false },
      '♥': { K: false, Q: false },
      '♦': { K: false, Q: false },
      '♣': { K: false, Q: false },
    }));

    this.pendingTrickState = null; // set while trick is displayed before clearing
  }

  // ── Helpers ──────────────────────────────────────────────────────────
  _pidx(socketId)  { return this.players.find(p => p.socketId === socketId)?.idx ?? -1; }
  teamOf(pi)       { return this.teams[0].includes(pi) ? 0 : this.teams[1].includes(pi) ? 1 : -1; }
  partnerOf(pi)    {
    const t = this.teamOf(pi);
    return t < 0 ? -1 : (this.teams[t].find(i => i !== pi) ?? -1);
  }

  // ── Player management ────────────────────────────────────────────────
  addPlayer(socketId, name) {
    if (this.state !== STATE.WAITING) return { error: 'Partie déjà lancée' };
    if (this.players.length >= 4)     return { error: 'Salle pleine (4/4)' };
    const idx = this.players.length;
    this.players.push({ socketId, name, idx });
    return { playerIdx: idx };
  }

  removePlayer(socketId) {
    this.players = this.players.filter(p => p.socketId !== socketId);
    this.players.forEach((p, i) => { p.idx = i; });
  }

  addBot(name, level = 'random') {
    if (this.state !== STATE.WAITING) return { error: 'Partie déjà lancée' };
    if (this.players.length >= 4)     return { error: 'Salle pleine (4/4)' };
    const idx = this.players.length;
    this.players.push({ socketId: `bot:${idx}`, name, idx, isBot: true, botLevel: level });
    this.botIdxs.add(idx);
    return { playerIdx: idx };
  }

  setTeams(teams) {
    if (this.state !== STATE.WAITING) return { error: 'Impossible maintenant' };
    if (!Array.isArray(teams[0]) || !Array.isArray(teams[1]))
      return { error: 'Équipes invalides' };

    const allIdxs = [...teams[0], ...teams[1]];
    const maxIdx  = this.players.length - 1;
    if (allIdxs.some(i => typeof i !== 'number' || i < 0 || i > maxIdx))
      return { error: 'Équipes invalides' };
    if (new Set(allIdxs).size !== allIdxs.length)
      return { error: 'Équipes invalides (doublons)' };

    // With exactly 2+2 players: remap seats so partners sit diagonal (seats 0&2 vs 1&3)
    if (teams[0].length === 2 && teams[1].length === 2) {
      const [a, b] = teams[0];
      const [c, d] = teams[1];
      const newOrder   = [a, c, b, d];
      const oldPlayers = [...this.players];
      this.players = newOrder.map((oldIdx, newIdx) => ({ ...oldPlayers[oldIdx], idx: newIdx }));
      this.teams   = [[0, 2], [1, 3]];
      this.botIdxs = new Set(this.players.filter(p => p.isBot).map(p => p.idx));

      const remapped = {};
      newOrder.forEach((oldIdx, newIdx) => {
        const sid = oldPlayers[oldIdx].socketId;
        if (sid) remapped[sid] = newIdx;
      });
      return { remapped };
    }

    // Partial teams (< 4 players): store as-is without remap
    this.teams = [teams[0].slice(), teams[1].slice()];
    return { remapped: {} };
  }

  // ── Game start ───────────────────────────────────────────────────────
  startGame(socketId) {
    const pi = this._pidx(socketId);
    if (pi !== 0) return { error: 'Seul le créateur peut lancer la partie' };
    if (this.players.length !== 4) return { error: 'Il faut 4 joueurs' };
    this.dealerIdx = Math.floor(Math.random() * 4);
    this._startRound();
    return {};
  }

  restartGame() {
    if (this.state !== STATE.GAME_OVER) return { error: 'Pas de fin de partie' };
    this.totalScores  = [0, 0];
    this.roundHistory = [];
    this.dealerIdx    = Math.floor(Math.random() * 4);
    this._startRound();
    return {};
  }

  _startRound() {
    this._resetRound();
    const deck    = shuffle(createDeck());
    this.hands    = deal(deck);
    for (let i = 0; i < 4; i++)
      this.detectedAnn[i] = detectAnnouncements(this.hands[i]);
    this.biddingIdx = (this.dealerIdx + 1) % 4;
    this.state = STATE.BIDDING;
  }

  // ── Bidding ──────────────────────────────────────────────────────────
  static _bidOrd(v) {
    if (v === 'Capot')           return 250;
    if (v === 'Capot Beloté')    return 270;
    if (v === 'Générale')        return 400;
    if (v === 'Générale Beloté') return 420;
    return Number(v);
  }

  placeBid(socketId, value, suit) {
    const pi = this._pidx(socketId);
    if (this.state !== STATE.BIDDING)  return { error: 'Pas en phase de mise' };
    if (pi !== this.biddingIdx)        return { error: "Ce n'est pas ton tour" };

    const validSuits  = ['♠', '♥', '♦', '♣', 'SA', 'TA'];
    const validValues = new Set(['80','90','100','110','120','130','140','150','160',
                                 'Capot','Capot Beloté','Générale','Générale Beloté']);
    if (!validSuits.includes(suit))        return { error: 'Couleur invalide' };
    if (!validValues.has(String(value)))   return { error: 'Valeur invalide' };

    const num    = GameRoom._bidOrd(value);
    const curNum = this.currentBid ? GameRoom._bidOrd(this.currentBid.value) : 70;

    if (num <= curNum) return { error: 'Doit surenchérir' };
    if (num < 80)      return { error: 'Mise minimum : 80' };

    this.currentBid  = { playerIdx: pi, value, suit };
    this.coinched    = false;
    this.surcoinched = false;
    this.passCount   = 0;
    this.bids.push({ playerIdx: pi, type: 'bid', value, suit });
    this._nextBidder();
    return {};
  }

  passBid(socketId) {
    const pi = this._pidx(socketId);
    if (this.state !== STATE.BIDDING) return { error: 'Pas en phase de mise' };
    if (pi !== this.biddingIdx)       return { error: "Ce n'est pas ton tour" };

    this.bids.push({ playerIdx: pi, type: 'pass' });
    this.passCount++;

    if (!this.currentBid && this.passCount >= 4) {
      this._startRound();
      return { redeal: true };
    }
    // After coinche: contracting team's pass → end immediately (no need for 3 passes)
    if (this.coinched && this.currentBid
        && this.teamOf(pi) === this.teamOf(this.currentBid.playerIdx)) {
      this._endBidding();
      return {};
    }
    if (this.currentBid && this.passCount >= 3) {
      this._endBidding();
      return {};
    }
    this._nextBidder();
    return {};
  }

  coinche(socketId) {
    const pi = this._pidx(socketId);
    if (this.state !== STATE.BIDDING) return { error: 'Pas en phase de mise' };
    if (!this.currentBid)             return { error: 'Rien à coincher' };
    if (this.coinched)                return { error: 'Déjà coinché' };
    if (this.teamOf(pi) === this.teamOf(this.currentBid.playerIdx))
      return { error: "Ne peux pas coincher son équipe" };

    this.coinched  = true;
    this.passCount = 0;
    this.bids.push({ playerIdx: pi, type: 'coinche' });
    // After coinche, contracting team gets next turn (for surcoinche or pass)
    this.biddingIdx = this.currentBid.playerIdx;
    return {};
  }

  surcoinche(socketId) {
    const pi = this._pidx(socketId);
    if (this.state !== STATE.BIDDING) return { error: 'Pas en phase de mise' };
    if (!this.coinched)               return { error: 'Pas encore coinché' };
    if (this.surcoinched)             return { error: 'Déjà surcoinché' };
    if (this.teamOf(pi) !== this.teamOf(this.currentBid.playerIdx))
      return { error: "Seule l'équipe du contrat peut surcoincher" };

    this.surcoinched = true;
    this.bids.push({ playerIdx: pi, type: 'surcoinche' });
    this._endBidding();
    return {};
  }

  _nextBidder() { this.biddingIdx = (this.biddingIdx + 1) % 4; }

  _endBidding() {
    if (!this.currentBid) { this._startRound(); return; }

    const hasAnn = this.settings.countAnnounces
      && this.detectedAnn.some(a => a.length > 0);

    if (hasAnn) {
      // Auto-submit empty declares for players with no announces
      for (let i = 0; i < 4; i++)
        if (this.detectedAnn[i].length === 0) this.declaredAnn[i] = [];
      this.state = STATE.ANNOUNCE;
      // If all already auto-submitted, skip to playing
      if (this.declaredAnn.every(d => d !== null)) {
        this._resolveAnnounces();
        this._startPlaying();
      }
    } else {
      this._startPlaying();
    }
  }

  // ── Announces ────────────────────────────────────────────────────────
  submitAnnounces(socketId, selectedIds) {
    const pi = this._pidx(socketId);
    if (this.state !== STATE.ANNOUNCE)    return { error: "Pas en phase d'annonces" };
    if (this.declaredAnn[pi] !== null)    return { error: 'Déjà soumis' };

    this.declaredAnn[pi] = this.detectedAnn[pi].filter(a => selectedIds.includes(a.id));

    if (this.declaredAnn.every(d => d !== null)) {
      this._resolveAnnounces();
      this._startPlaying();
    }
    return {};
  }

  _resolveAnnounces() {
    const trump = this.currentBid.suit;
    const t0Ann = [...(this.declaredAnn[this.teams[0][0]] || []), ...(this.declaredAnn[this.teams[0][1]] || [])];
    const t1Ann = [...(this.declaredAnn[this.teams[1][0]] || []), ...(this.declaredAnn[this.teams[1][1]] || [])];
    this.announceWinnerTeam = resolveAnnouncementWinner(t0Ann, t1Ann, trump);
  }

  _startPlaying() {
    this.state = STATE.PLAYING;
    this.currentTrick = [];
    this.currentPlayerIdx = (this.dealerIdx + 1) % 4;
  }

  // ── Playing ──────────────────────────────────────────────────────────
  playCard(socketId, cardId) {
    const pi = this._pidx(socketId);
    if (this.state !== STATE.PLAYING)      return { error: 'Pas en phase de jeu' };
    if (this.pendingTrickState)            return { error: 'Pli en cours de résolution' };
    if (pi !== this.currentPlayerIdx)      return { error: "Ce n'est pas ton tour" };

    const hand    = this.hands[pi];
    const cardIdx = hand.findIndex(c => c.id === cardId);
    if (cardIdx === -1)                    return { error: 'Carte introuvable' };

    const trump  = this.currentBid.suit;
    const partner = this.partnerOf(pi);
    const legal  = getPlayableCards(hand, this.currentTrick, trump, pi, partner);
    if (!legal.some(c => c.id === cardId)) return { error: 'Carte non jouable' };

    const card = hand.splice(cardIdx, 1)[0];

    // Belote / Rebelote detection
    let beloteMsg = null;
    const beloteOff = this.settings.beloteFrom === 'off';
    if (!beloteOff && trump !== 'SA' && (card.rank === 'K' || card.rank === 'Q')) {
      // In TA: K+Q of any suit; in normal: K+Q of the trump suit only
      const beloteSuit = trump === 'TA' ? card.suit : trump;
      if (card.suit === beloteSuit) {
        const bp = this.belotePlayed[pi][beloteSuit];
        bp[card.rank] = true;
        if (bp.K && bp.Q) {
          beloteMsg = `${this.players[pi].name} : Rebelote !`;
        } else {
          const other = card.rank === 'K' ? 'Q' : 'K';
          if (hand.some(c => c.suit === beloteSuit && c.rank === other)) {
            beloteMsg = `${this.players[pi].name} : Belote !`;
          }
        }
      }
    }

    this.currentTrick.push({ playerIdx: pi, card });

    if (this.currentTrick.length === 4) return this._completeTrick(beloteMsg, pi);

    this.currentPlayerIdx = (this.currentPlayerIdx + 1) % 4;
    return { beloteMsg, belotePlayerIdx: pi };
  }

  _completeTrick(beloteMsg, belotePlayerIdx = -1) {
    const trump  = this.currentBid.suit;
    const winner = trickWinner(this.currentTrick, trump);
    this.tricks.push({ cards: [...this.currentTrick], winner });
    this.lastTrick = { cards: [...this.currentTrick], winner };
    // Keep currentTrick populated for 1.3s display; cleared by advanceTrick()
    this.currentPlayerIdx = winner;
    this.pendingTrickState = {
      winner,
      beloteMsg,
      belotePlayerIdx,
      isLastTrick: this.hands[0].length === 0,
    };
    return { trickDisplayed: true, beloteMsg, belotePlayerIdx };
  }

  advanceTrick() {
    if (!this.pendingTrickState) return { error: 'Pas de pli en attente' };
    const { winner, beloteMsg, belotePlayerIdx, isLastTrick } = this.pendingTrickState;
    this.pendingTrickState = null;
    this.currentTrick = [];
    if (isLastTrick) return this._endRound(beloteMsg);
    this.currentPlayerIdx = winner;
    return { trickDone: true, winner };
  }

  _endRound(beloteMsg) {
    const trump        = this.currentBid.suit;
    const contractTeam = this.teamOf(this.currentBid.playerIdx);
    const bidNum       = this.currentBid.value === 'Capot' ? 250 : Number(this.currentBid.value);

    // Announce points (only winning announce team scores)
    const announcePts = [0, 0];
    if (this.settings.countAnnounces && this.announceWinnerTeam >= 0) {
      const wt = this.announceWinnerTeam;
      const list = [
        ...(this.declaredAnn[this.teams[wt][0]] || []),
        ...(this.declaredAnn[this.teams[wt][1]] || []),
      ];
      announcePts[wt] = sumAnnounces(list);
    }

    // Belote points (+20 per K+Q pair of trump suit per player)
    const belotePts = [0, 0];
    const beloteOff = this.settings.beloteFrom === 'off';
    const beloteActive = !beloteOff && trump !== 'SA'
      && (trump === 'TA' || bidNum >= this.settings.beloteFrom);
    if (beloteActive) {
      for (let i = 0; i < 4; i++) {
        const bp = this.belotePlayed[i];
        const team = this.teamOf(i);
        if (trump === 'TA') {
          for (const suit of ['♠', '♥', '♦', '♣']) {
            if (bp[suit].K && bp[suit].Q) belotePts[team] += 20;
          }
        } else {
          if (bp[trump].K && bp[trump].Q) belotePts[team] += 20;
        }
      }
    }

    const result = scoreRound({
      tricks: this.tricks, trump,
      contractTeam,
      contractValue:     this.currentBid.value,
      contractPlayerIdx: this.currentBid.playerIdx,
      isCoinched:        this.coinched,
      isSurcoinched:     this.surcoinched,
      announcePts, belotePts,
      scoringMode:       this.settings.scoringMode,
    });

    this.totalScores[0] += result.team0Score;
    this.totalScores[1] += result.team1Score;

    this.roundResult = {
      ...result,
      contractTeam,
      contractValue: this.currentBid.value,
      contractSuit:  this.currentBid.suit,
      coinched:      this.coinched,
      surcoinched:   this.surcoinched,
      totalAfter:    [...this.totalScores],
      // For display: which announces each team declared
      announceWinnerTeam: this.announceWinnerTeam,
      declaredAnn:   this.declaredAnn.map(d => d || []),
    };

    this.roundHistory.push({ ...this.roundResult });

    const gameOver = this.totalScores[0] >= this.settings.maxPoints
                  || this.totalScores[1] >= this.settings.maxPoints;

    this.dealerIdx = (this.dealerIdx + 1) % 4;
    this.state = gameOver ? STATE.GAME_OVER : STATE.ROUND_OVER;
    return { roundDone: true, beloteMsg };
  }

  nextRound() {
    if (this.state !== STATE.ROUND_OVER) return { error: 'Pas de nouvelle manche disponible' };
    this._startRound();
    return {};
  }

  _runningBelotePts() {
    const trump = this.currentBid?.suit;
    if (!trump || this.settings.beloteFrom === 'off' || trump === 'SA') return [0, 0];
    const pts = [0, 0];
    for (let i = 0; i < 4; i++) {
      const bp = this.belotePlayed[i];
      const team = this.teamOf(i);
      if (trump === 'TA') {
        for (const suit of ['♠', '♥', '♦', '♣']) {
          if (bp[suit]?.K && bp[suit]?.Q) pts[team] += 20;
        }
      } else {
        if (bp[trump]?.K && bp[trump]?.Q) pts[team] += 20;
      }
    }
    return pts;
  }

  // ── Public state snapshot (per player) ───────────────────────────────
  publicState(playerIdx) {
    const pi      = playerIdx;
    const hand    = this.hands[pi] || [];
    const trump   = this.currentBid?.suit;
    const partner = this.partnerOf(pi);

    let playableIds = [];
    if (this.state === STATE.PLAYING && this.currentPlayerIdx === pi && !this.pendingTrickState) {
      playableIds = getPlayableCards(hand, this.currentTrick, trump, pi, partner)
        .map(c => c.id);
    }

    // Running trick points (no "10 de der" during play)
    const runningTrickPts = (() => {
      if (!this.currentBid || this.state === 'bidding' || this.state === 'announce') return [0, 0];
      const t = this.currentBid.suit;
      const pts = [0, 0];
      for (const trick of this.tricks) {
        const team = this.teamOf(trick.winner);
        for (const { card } of trick.cards) pts[team] += cardValue(card, t);
      }
      return pts;
    })();

    return {
      code:             this.code,
      state:            this.state,
      settings:         this.settings,
      players:          this.players.map(p => ({ name: p.name, idx: p.idx, isBot: !!p.isBot, botLevel: p.botLevel || null })),
      teams:            this.teams,
      dealerIdx:        this.dealerIdx,
      // Cards
      hand,
      handSizes:        this.hands.map(h => h.length),
      playableIds,
      // Trick
      currentTrick:     this.currentTrick,
      currentPlayerIdx: this.currentPlayerIdx,
      lastTrick:        this.lastTrick,
      tricksDone:       this.tricks.length,
      // Bidding
      bids:             this.bids,
      currentBid:       this.currentBid,
      coinched:         this.coinched,
      surcoinched:      this.surcoinched,
      biddingIdx:       this.biddingIdx,
      // Announces
      myDetected:       this.detectedAnn[pi] || [],
      myDeclared:       this.declaredAnn[pi],
      declaredStatus:   this.declaredAnn.map(d => d !== null),
      announceWinnerTeam: this.announceWinnerTeam,
      // Resolved announces visible to all after announce phase
      resolvedAnn: (this.state !== 'waiting' && this.state !== 'bidding' && this.state !== 'announce')
        ? this.declaredAnn.map(d => d || [])
        : null,
      // Scores & history
      totalScores:      this.totalScores,
      runningTrickPts,
      runningBelotePts: this._runningBelotePts(),
      tricksByTeam:     [
        this.tricks.filter(t => this.teamOf(t.winner) === 0).length,
        this.tricks.filter(t => this.teamOf(t.winner) === 1).length,
      ],
      tricksByPlayer:   Array.from({length: 4}, (_, i) =>
        this.tricks.filter(t => t.winner === i).length
      ),
      roundResult:      this.roundResult,
      roundHistory:     this.roundHistory,
    };
  }
}

module.exports = { GameRoom, STATE };
