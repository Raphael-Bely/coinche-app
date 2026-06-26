import React, { useState, useEffect, useRef } from 'react';
import socket from '../socket';
import Card from './Card';
import Badge from './Badge';
import VoiceChat from './VoiceChat';
import VideoPanel from './VideoPanel';

const BID_STEPS    = [80, 90, 100, 110, 120, 130, 140, 150, 160, 'Capot', 'Capot Beloté', 'Générale', 'Générale Beloté'];
const SUIT_BUTTONS = ['♠', '♥', '♦', '♣', 'SA', 'TA'];
const EMOJIS = ['👍','❤️','😂','😮','😠','🔥','💪','🎉'];

function bidOrd(v) {
  if (v === 'Capot')           return 250;
  if (v === 'Capot Beloté')    return 270;
  if (v === 'Générale')        return 400;
  if (v === 'Générale Beloté') return 420;
  return Number(v) || 0;
}
const RPOS         = ['bottom', 'right', 'top', 'left'];
const CARDINAL     = { bottom: 'S', right: 'E', top: 'N', left: 'O' };

// Always show partner at top (N); right/left follow seat-order so all players
// see the same counter-clockwise rotation (pi+1 is always to the right).
function playerAtPos(pi, pos, teams) {
  const myTeam  = teams[0].includes(pi) ? teams[0] : teams[1];
  const partner = myTeam.find(i => i !== pi) ?? -1;
  const right   = (pi + 1) % 4;
  const left    = (pi + 3) % 4;
  const map     = { bottom: pi, top: partner, right, left };
  return map[pos] ?? -1;
}

const TRUMP_RANK = { J: 0, 9: 1, A: 2, 10: 3, K: 4, Q: 5, 8: 6, 7: 7 };
const PLAIN_RANK = { A: 0, 10: 1, K: 2, Q: 3, J: 4, 9: 5, 8: 6, 7: 7 };
const SUIT_ORDER = ['♠', '♥', '♣', '♦'];

const SUIT_NAMES = {
  '♠': 'pique', '♥': 'coeur', '♦': 'carreau', '♣': 'trèfle',
  'SA': 'Sans-Atout', 'TA': 'Tout-Atout',
};
function suitLabel(suit) {
  if (!suit) return '';
  const name = SUIT_NAMES[suit];
  return name ? `${name} ${suit}` : suit;
}

function sortHand(hand, trump) {
  const isTrump = (c) => trump === 'TA' || (trump !== 'SA' && c.suit === trump);
  const suitPri = (c) => {
    if (trump && trump !== 'SA' && trump !== 'TA' && c.suit === trump) return -1;
    return SUIT_ORDER.indexOf(c.suit);
  };
  const rankPri = (c) => isTrump(c) ? (TRUMP_RANK[c.rank] ?? 8) : (PLAIN_RANK[c.rank] ?? 8);
  return [...hand].sort((a, b) => {
    const sd = suitPri(a) - suitPri(b);
    return sd !== 0 ? sd : rankPri(a) - rankPri(b);
  });
}

export default function GameBoard({ gs, myInfo, onLeave }) {
  const pi     = myInfo.playerIdx;
  const myTeam = gs.teams[0].includes(pi) ? 0 : 1;

  const [bidValue,     setBidValue]     = useState(null);
  const [bidSuit,      setBidSuit]      = useState(null);
  const [selAnn,       setSelAnn]       = useState(null);
  const [beloteFlash,  setBeloteFlash]  = useState({}); // { [playerIdx]: 'belote'|'rebelote' }
  const [playerEmojis, setPlayerEmojis] = useState({}); // { [playerIdx]: { emoji, seq } }
  const emojiSeq = useRef(0);

  useEffect(() => {
    if (gs.state === 'announce' && selAnn === null)
      setSelAnn(gs.myDetected.map(a => a.id));
    if (gs.state !== 'announce') setSelAnn(null);
  }, [gs.state]); // eslint-disable-line

  // Belote flash badge
  useEffect(() => {
    function handler({ playerIdx, type }) {
      setBeloteFlash(prev => ({ ...prev, [playerIdx]: type }));
      setTimeout(() => setBeloteFlash(prev => {
        const copy = { ...prev }; delete copy[playerIdx]; return copy;
      }), 3500);
    }
    socket.on('belote_flash', handler);
    return () => socket.off('belote_flash', handler);
  }, []);

  // Auto-play last card (8th trick) so user doesn't have to click the obvious move
  useEffect(() => {
    if (gs.state === 'playing' && gs.currentPlayerIdx === pi &&
        gs.hand.length === 1 && gs.playableIds.length === 1) {
      const tid = setTimeout(() => socket.emit('play_card', { cardId: gs.hand[0].id }), 350);
      return () => clearTimeout(tid);
    }
  }, [gs.state, gs.currentPlayerIdx, pi, gs.hand.length, gs.playableIds.length]);

  // Preload all 32 card images so the first render is instant (no image lag)
  useEffect(() => {
    const SUITS = ['S','H','D','C'];
    const RANKS = ['7','8','9','0','J','Q','K','A'];
    SUITS.forEach(s => RANKS.forEach(r => { const img = new window.Image(); img.src = `/cards/${r}${s}.png`; }));
  }, []);

  // Emoji reactions
  useEffect(() => {
    function handler({ playerIdx, emoji }) {
      const seq = ++emojiSeq.current;
      setPlayerEmojis(prev => ({ ...prev, [playerIdx]: { emoji, seq } }));
      setTimeout(() => setPlayerEmojis(prev => {
        if (prev[playerIdx]?.seq !== seq) return prev;
        const copy = { ...prev }; delete copy[playerIdx]; return copy;
      }), 3500);
    }
    socket.on('emoji_show', handler);
    return () => socket.off('emoji_show', handler);
  }, []);

  const teamName = (t) => gs.teams[t].map(i => gs.players[i]?.name || '?').join(' & ');

  const isMyBidTurn   = gs.state === 'bidding' && gs.biddingIdx === pi;
  const canCoinche    = gs.state === 'bidding' && gs.currentBid && !gs.coinched
    && !gs.teams[myTeam].includes(gs.currentBid.playerIdx);
  const canSurcoinche = gs.state === 'bidding' && gs.coinched && !gs.surcoinched
    && gs.currentBid && gs.teams[myTeam].includes(gs.currentBid.playerIdx);

  const curBidNum = gs.currentBid ? bidOrd(gs.currentBid.value) : 70;

  function doPlayCard(cardId) {
    if (gs.state !== 'playing' || gs.currentPlayerIdx !== pi) return;
    if (!gs.playableIds.includes(cardId)) return;
    socket.emit('play_card', { cardId });
  }

  function doBid() {
    if (!bidValue || !bidSuit) return;
    socket.emit('bid', { value: bidValue, suit: bidSuit });
    setBidValue(null); setBidSuit(null);
  }

  const isGameActive  = gs.state !== 'waiting';
  const trump         = gs.currentBid?.suit;
  const sortedHand    = sortHand(gs.hand, trump);
  const isMyPlayTurn  = gs.state === 'playing' && gs.currentPlayerIdx === pi;
  const coincheBy     = gs.coinched    ? gs.bids?.find(b => b.type === 'coinche')?.playerIdx    : null;
  const surcoincheBy  = gs.surcoinched ? gs.bids?.find(b => b.type === 'surcoinche')?.playerIdx : null;

  return (
    <div className="game-board">

      {/* ── Top bar ─────────────────────────────────────────────────── */}
      <div className="room-bar">
        <button className="btn-leave" onClick={onLeave} title="Quitter la partie">✕ Quitter</button>
        <span className="room-code">🃏 {gs.code}</span>
        {isGameActive && (
          <div className="nous-eux-panel">
            <div className="ne-block">
              <span className="ne-label">NOUS</span>
              <span className="ne-val nous-val">{gs.totalScores[myTeam]}</span>
            </div>
            <span className="ne-sep">—</span>
            <div className="ne-block">
              <span className="ne-label">EUX</span>
              <span className="ne-val eux-val">{gs.totalScores[1-myTeam]}</span>
            </div>
            <span className="ne-max">/{gs.settings.maxPoints}</span>
          </div>
        )}
      </div>

      {gs.state === 'waiting' && <WaitingArea gs={gs} pi={pi} />}

      {/* ── Active game ──────────────────────────────────────────────── */}
      {isGameActive && (
        <div className="game-main">

          {/* Table + right panel side by side */}
          <div className="table-and-panel">

            {/* ── Felt table ──────────────────────────────────────── */}
            <div className="table-wrap">
              <div className="table-felt">

                {/* Opponent player spots */}
                {['left', 'top', 'right'].map(pos => {
                  const absIdx = playerAtPos(pi, pos, gs.teams);
                  const p      = gs.players[absIdx];
                  if (!p) return null;
                  const pTeam      = gs.teams[0].includes(absIdx) ? 0 : 1;
                  const isDealer   = gs.dealerIdx === absIdx;
                  const isActive   = gs.currentPlayerIdx === absIdx
                                  || (gs.state === 'bidding' && gs.biddingIdx === absIdx);
                  const isPartner  = pTeam === myTeam;
                  const playerTricks = gs.tricksByPlayer?.[absIdx] ?? 0;
                  const lastBid    = gs.bids?.filter(b => b.playerIdx === absIdx).at(-1);
                  const card       = CARDINAL[pos];

                  return (
                    <div key={pos} className={`player-area pa-${pos}`}>
                      <div className={`ps-spot ${isPartner ? 'ps-partner' : 'ps-opponent'} ${isActive ? 'ps-active' : ''}`}>
                        {isDealer && <div className="dealer-token" title="Donneur">D</div>}
                        <span className="ps-cardinal">{card}</span>
                        {p.badge != null && <Badge tier={p.badge} size="sm" />}
                        <span className="ps-name">{p.name}</span>
                        {playerEmojis[absIdx] && (
                          <span key={`e-${absIdx}-${playerEmojis[absIdx].seq}`} className="player-emoji">{playerEmojis[absIdx].emoji}</span>
                        )}
                        {gs.state === 'bidding' && gs.biddingIdx === absIdx && <span className="thinking">…</span>}
                        {beloteFlash[absIdx] && (
                          <span className="belote-flash">{beloteFlash[absIdx] === 'rebelote' ? 'Rebelote !' : 'Belote !'}</span>
                        )}
                      </div>

                      {/* Contract tag */}
                      {gs.currentBid && gs.currentBid.playerIdx === absIdx && (
                        <div className={`contract-tag ${gs.surcoinched ? 'sur' : gs.coinched ? 'co' : ''}`}>
                          {gs.currentBid.value} {suitLabel(gs.currentBid.suit)}
                          {gs.surcoinched ? ' ×4' : gs.coinched ? ' ×2' : ''}
                        </div>
                      )}

                      {/* Bid bubble during bidding */}
                      {gs.state === 'bidding' && lastBid && (
                        <div className={`bid-bubble bb-${lastBid.type}`}>
                          {lastBid.type === 'pass'       ? 'Passe'
                            : lastBid.type === 'coinche'    ? '⚡ Coinche!'
                            : lastBid.type === 'surcoinche' ? '⚡⚡ Surcoinche!'
                            : `${lastBid.value} ${suitLabel(lastBid.suit)}`}
                        </div>
                      )}

                      {/* Announce badges */}
                      {gs.resolvedAnn?.[absIdx]?.length > 0 && (
                        <div className="player-ann-badges">
                          {gs.resolvedAnn[absIdx].map(a => (
                            <span key={a.id}
                              className={`ann-badge ${gs.announceWinnerTeam === pTeam ? 'win' : 'lose'}`}>
                              {a.label}
                            </span>
                          ))}
                        </div>
                      )}

                      {/* Personal trick count */}
                      {playerTricks > 0 && gs.state === 'playing' && (
                        <div className="tricks-pile">
                          <div className="tricks-stack">
                            {Array(Math.min(playerTricks, 3)).fill(0).map((_,i) => <div key={i} className="trick-mini-card"/>)}
                          </div>
                          <span className="tricks-count">{playerTricks}</span>
                        </div>
                      )}

                      {/* Card backs */}
                      <div className={`opp-hand ${pos !== 'top' ? 'h-sideways' : ''}`}>
                        {Array(Math.min(gs.handSizes[absIdx], 6)).fill(0).map((_, i) => (
                          <div key={i} className="card-back-sm" />
                        ))}
                      </div>
                      {gs.handSizes[absIdx] > 0 && (
                        <span className="card-count">{gs.handSizes[absIdx]}</span>
                      )}
                    </div>
                  );
                })}

                {/* Center: trick cards only */}
                {(() => {
                  const trickComplete = gs.currentTrick.length === 4;
                  const winnerAbs     = trickComplete ? gs.currentPlayerIdx : -1;
                  return (
                    <div className={`trick-center${trickComplete ? ' trick-completing' : ''}`}>
                      {RPOS.map(pos => {
                        const absIdx = playerAtPos(pi, pos, gs.teams);
                        const played = gs.currentTrick.find(t => t.playerIdx === absIdx);
                        const isWinner = absIdx === winnerAbs;
                        return (
                          <div key={pos} className={`trick-slot ts-${pos}${isWinner ? ' ts-winner' : ''}`}>
                            {played && <Card key={played.card.id} card={played.card} small />}
                          </div>
                        );
                      })}
                      <div className="trick-info">
                        {gs.tricksDone > 0 && `${gs.tricksDone}/8`}
                      </div>
                    </div>
                  );
                })()}

              </div>{/* .table-felt */}
            </div>{/* .table-wrap */}

            {/* ── Right info panel ────────────────────────────────── */}
            <GameRightPanel gs={gs} myTeam={myTeam} pi={pi} />

          </div>{/* .table-and-panel */}

          {/* ── Bottom area ─────────────────────────────────────────── */}
          <div className="bottom-area">

            {gs.state === 'bidding' && (
              <BiddingPanel
                gs={gs} pi={pi}
                isMyTurn={isMyBidTurn}
                canCoinche={canCoinche}
                canSurcoinche={canSurcoinche}
                curBidNum={curBidNum}
                bidValue={bidValue} setBidValue={setBidValue}
                bidSuit={bidSuit}   setBidSuit={setBidSuit}
                onBid={doBid}
              />
            )}

            {gs.state === 'announce' && (
              <AnnouncePanel gs={gs} pi={pi} selAnn={selAnn || []} setSelAnn={setSelAnn} />
            )}

            {gs.state === 'playing' && (
              <div className={`play-bar${isMyPlayTurn ? ' play-bar-my-turn' : ''}`}>
                {isMyPlayTurn
                  ? <span className="my-turn-badge">⬆ À toi de jouer — clique une carte</span>
                  : <span className="wait-badge">
                      ⏳ <strong>{gs.players[gs.currentPlayerIdx]?.name}</strong> joue…
                    </span>
                }
                {(gs.coinched || gs.surcoinched) && (
                  <span className="coinche-live-badge">
                    {gs.surcoinched ? '⚡⚡' : '⚡'}&nbsp;
                    {gs.players[surcoincheBy ?? coincheBy]?.name} a {gs.surcoinched ? 'surcoinché ×4' : 'coinché ×2'}
                  </span>
                )}
              </div>
            )}

            {(gs.state === 'round_over' || gs.state === 'game_over') && gs.roundResult && (
              <div className="round-modal-overlay">
                <RoundModal gs={gs} myTeam={myTeam} teamName={teamName} />
              </div>
            )}

            {/* ── Media + Chat ────────────────────────────────────── */}
            <div className="media-chat-row">
              <div className="media-stack">
                <VoiceChat myInfo={myInfo} />
                <VideoPanel myInfo={myInfo} />
              </div>
              <ChatPanel pi={pi} />
            </div>

            {/* My hand */}
            {(gs.state === 'playing' || gs.state === 'bidding' || gs.state === 'announce') && (
              <div className="my-area">
                <div className="my-name-bar">
                  {gs.dealerIdx === pi && <div className="dealer-token my" title="Donneur">D</div>}
                  <span className="ps-cardinal my-cardinal">S</span>
                  {gs.players[pi]?.badge != null && <Badge tier={gs.players[pi].badge} size="sm" />}
                  <span className="my-ps-name">{gs.players[pi]?.name} (moi)</span>
                  {playerEmojis[pi] && (
                    <span key={`e-${pi}-${playerEmojis[pi].seq}`} className="player-emoji">{playerEmojis[pi].emoji}</span>
                  )}
                  {gs.state === 'bidding' && gs.biddingIdx === pi && <span className="thinking"> …</span>}
                  {beloteFlash[pi] && (
                    <span className="belote-flash">{beloteFlash[pi] === 'rebelote' ? 'Rebelote !' : 'Belote !'}</span>
                  )}

                  {gs.currentBid && gs.currentBid.playerIdx === pi && (
                    <div className={`contract-tag ${gs.surcoinched ? 'sur' : gs.coinched ? 'co' : ''}`}>
                      {gs.currentBid.value} {suitLabel(gs.currentBid.suit)}
                      {gs.surcoinched ? ' ×4' : gs.coinched ? ' ×2' : ''}
                    </div>
                  )}

                  {gs.state === 'bidding' && (() => {
                    const myLastBid = gs.bids?.filter(b => b.playerIdx === pi).at(-1);
                    return myLastBid ? (
                      <div className={`bid-bubble bb-${myLastBid.type}`}>
                        {myLastBid.type === 'pass'       ? 'Passe'
                          : myLastBid.type === 'coinche'    ? '⚡ Coinche!'
                          : myLastBid.type === 'surcoinche' ? '⚡⚡ Surcoinche!'
                          : `${myLastBid.value} ${suitLabel(myLastBid.suit)}`}
                      </div>
                    ) : null;
                  })()}

                  {gs.resolvedAnn?.[pi]?.length > 0 && (
                    <div className="player-ann-badges inline">
                      {gs.resolvedAnn[pi].map(a => (
                        <span key={a.id}
                          className={`ann-badge ${gs.announceWinnerTeam === myTeam ? 'win' : 'lose'}`}>
                          {a.label}
                        </span>
                      ))}
                    </div>
                  )}

                  {(gs.tricksByPlayer?.[pi] ?? 0) > 0 && gs.state === 'playing' && (
                    <div className="tricks-pile">
                      <div className="tricks-stack">
                        {Array(Math.min(gs.tricksByPlayer[pi], 3)).fill(0).map((_,i) => <div key={i} className="trick-mini-card"/>)}
                      </div>
                      <span className="tricks-count">{gs.tricksByPlayer[pi]}</span>
                    </div>
                  )}
                </div>

                <div className="emoji-tray">
                  {EMOJIS.map(e => (
                    <button key={e} className="emoji-btn" onClick={() => socket.emit('emoji_react', { emoji: e })}>{e}</button>
                  ))}
                </div>

                <div className={`hand-cards${isMyPlayTurn ? ' hand-my-turn' : ''}`}>
                  {sortedHand.map((card, i) => {
                    const isBlocked = isMyPlayTurn && !gs.playableIds.includes(card.id);
                    const showGap      = i > 0 && sortedHand[i-1].suit !== card.suit;
                    return (
                      <React.Fragment key={card.id}>
                        {showGap && <div className="suit-gap" />}
                        <Card
                          card={card}
                          playable={!isBlocked}
                          onClick={isMyPlayTurn ? () => doPlayCard(card.id) : undefined}
                        />
                      </React.Fragment>
                    );
                  })}
                </div>
              </div>
            )}
          </div>{/* .bottom-area */}
        </div>
      )}
    </div>
  );
}

// ── Chat panel ─────────────────────────────────────────────────────────────
function ChatPanel({ pi }) {
  const [msgs,  setMsgs]  = useState([]);
  const [input, setInput] = useState('');
  const endRef = useRef(null);

  useEffect(() => {
    function handler(msg) {
      setMsgs(prev => [...prev.slice(-99), msg]);
    }
    socket.on('chat_msg', handler);
    return () => socket.off('chat_msg', handler);
  }, []);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [msgs]);

  function send() {
    const text = input.trim();
    if (!text) return;
    socket.emit('chat_msg', { text });
    setInput('');
  }

  return (
    <div className="chat-panel">
      <div className="chat-messages">
        {msgs.length === 0 && <span className="chat-empty">Pas encore de message…</span>}
        {msgs.map((m, i) => (
          <div key={i} className={`chat-msg ${m.playerIdx === pi ? 'chat-mine' : ''}`}>
            <span className="chat-name">{m.name}</span>
            <span className="chat-text">{m.text}</span>
          </div>
        ))}
        <div ref={endRef} />
      </div>
      <div className="chat-input-row">
        <input
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && send()}
          placeholder="Message…"
          maxLength={200}
        />
        <button onClick={send}>↑</button>
      </div>
    </div>
  );
}

// ── Right info panel ───────────────────────────────────────────────────────
function GameRightPanel({ gs, myTeam, pi }) {
  const isPlaying = gs.state === 'playing';
  const hasContract = !!gs.currentBid;

  return (
    <div className="game-right-panel">

      {/* Contract block */}
      {hasContract && (
        <div className="grp-section">
          <div className="grp-label">Contrat</div>
          <div className="grp-contract">
            <span className="grp-bidder">{gs.players[gs.currentBid.playerIdx]?.name}</span>
            <span className="grp-bid-num">{gs.currentBid.value}</span>
            <span className="grp-bid-suit">{suitLabel(gs.currentBid.suit)}</span>
            {gs.surcoinched && <span className="grp-mult sur">×4</span>}
            {!gs.surcoinched && gs.coinched && <span className="grp-mult co">×2</span>}
          </div>
        </div>
      )}

      {/* Running trick points — shown during play */}
      {isPlaying && gs.runningTrickPts && (
        <div className="grp-section">
          <div className="grp-label">Points manche</div>
          {[myTeam, 1-myTeam].map((t, i) => (
            <div key={t} className="grp-pts-row">
              <span className="grp-pts-label">{i === 0 ? 'NOUS' : 'EUX'}</span>
              <div style={{display:'flex', flexDirection:'column', alignItems:'flex-end'}}>
                <span className={`grp-pts-val ${i === 0 ? 'nous-val' : 'eux-val'}`}>
                  {gs.runningTrickPts[t]}
                </span>
                {(gs.runningBelotePts?.[t] ?? 0) > 0 && (
                  <span className="grp-belote">(+{gs.runningBelotePts[t]} bel.)</span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Last trick */}
      {isPlaying && gs.lastTrick && (
        <div className="grp-section">
          <div className="grp-label">Dernier pli</div>
          <div className="grp-winner-name">{gs.players[gs.lastTrick.winner]?.name} ✓</div>
          <div className="grp-trick-grid">
            {RPOS.map(pos => {
              const absIdx = playerAtPos(pi, pos, gs.teams);
              const entry  = gs.lastTrick.cards.find(c => c.playerIdx === absIdx);
              const isWon  = entry?.playerIdx === gs.lastTrick.winner;
              return (
                <div key={pos} className={`gtg-slot gtg-${pos} ${isWon ? 'gtg-won' : ''}`}>
                  {entry && <Card card={entry.card} tiny />}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ── WaitingArea ────────────────────────────────────────────────────────────
function WaitingArea({ gs, pi }) {
  const isHost = pi === 0;

  function movePlayer(pIdx, toTeam) {
    // Filter out phantom indices (players not yet joined)
    const real = new Set(gs.players.map(p => p.idx));
    const nt = gs.teams.map(t => t.filter(i => real.has(i) && i !== pIdx));
    nt[toTeam] = [...nt[toTeam], pIdx];
    socket.emit('set_teams', { teams: nt });
  }

  const readyToStart = gs.players.length === 4
    && gs.teams[0].length === 2 && gs.teams[1].length === 2;

  return (
    <div className="waiting-room">
      <div className="wr-code">
        <span>Partagez ce code :</span>
        <strong className="big-code">{gs.code}</strong>
        <span className="player-count">{gs.players.length}/4 joueurs</span>
      </div>
      <div className="teams-display">
        {[0, 1].map(t => (
          <div key={t} className={`team-col team-col-${t}`}>
            <h3>Équipe {t + 1}</h3>
            {(gs.teams[t] || []).map(pIdx => {
              const p = gs.players[pIdx];
              if (!p) return null;
              return (
                <div key={pIdx} className="team-player-row">
                  <span className="tp-name">
                    {p.isBot ? (p.botLevel === 'classique' ? '⭐ ' : p.botLevel === 'normal' ? '🧠 ' : p.botLevel === 'rl' ? '🤖 ' : '🎲 ') : ''}
                    {p.name}
                    {pIdx === pi ? ' (toi)' : ''}
                    {p.isBot && <span className={`bot-level-badge blb-${p.botLevel}`}>{p.botLevel === 'classique' ? 'classique' : p.botLevel === 'normal' ? 'normal' : p.botLevel === 'rl' ? 'RL' : 'aléatoire'}</span>}
                  </span>
                  {isHost && (
                    <button className="btn-swap" onClick={() => movePlayer(pIdx, 1 - t)}>
                      → Éq.{2 - t}
                    </button>
                  )}
                </div>
              );
            })}
            {(gs.teams[t] || []).length === 0 && <div className="tp-empty">En attente…</div>}
          </div>
        ))}
      </div>
      {isHost && gs.players.length < 4 && (
        <div className="bot-btns">
          <button className="btn-bot btn-bot-classique" onClick={() => socket.emit('add_bot', { level: 'classique' })}>
            ⭐ Bot classique
          </button>
          <button className="btn-bot btn-bot-normal" onClick={() => socket.emit('add_bot', { level: 'normal' })}>
            🧠 Bot normal
          </button>
          <button className="btn-bot btn-bot-random" onClick={() => socket.emit('add_bot', { level: 'random' })}>
            🎲 Bot aléatoire
          </button>
          <button className="btn-bot btn-bot-rl" onClick={() => socket.emit('add_bot', { level: 'rl' })}>
            🤖 Bot RL
          </button>
        </div>
      )}
      {isHost && (
        <button className="btn-primary large" disabled={!readyToStart}
          onClick={() => socket.emit('start_game')}>
          {readyToStart ? 'Lancer la partie !' : `En attente des joueurs (${gs.players.length}/4)`}
        </button>
      )}
      {!isHost && <p className="wr-wait">En attente du créateur pour lancer la partie…</p>}
    </div>
  );
}

// ── BiddingPanel ───────────────────────────────────────────────────────────
function BiddingPanel({ gs, pi, isMyTurn, canCoinche, canSurcoinche, curBidNum,
                        bidValue, setBidValue, bidSuit, setBidSuit, onBid }) {
  const playerName = (idx) => gs.players[idx]?.name || `J${idx}`;

  return (
    <div className="bidding-panel">
      <div className="bid-history">
        {gs.bids.map((b, i) => {
          const tag = b.type === 'pass'       ? 'Passe'
                    : b.type === 'coinche'    ? '⚡ Coinche!'
                    : b.type === 'surcoinche' ? '⚡⚡ Surcoinche!'
                    : `${b.value} ${suitLabel(b.suit)}`;
          return (
            <span key={i} className={`bid-chip ${b.type} ${b.playerIdx === pi ? 'mine' : ''}`}>
              <em>{playerName(b.playerIdx)}</em> {tag}
            </span>
          );
        })}
      </div>

      {(canCoinche || canSurcoinche) && (
        <div className="coinche-banner">
          <span className="coinche-banner-label">
            {canSurcoinche ? '⚡ Tu peux Surcoincher ×4 !' : '⚡ Tu peux Coincher ×2 !'}
          </span>
          {canCoinche && (
            <button className="btn-coinche" onClick={() => socket.emit('coinche')}>COINCHE ×2</button>
          )}
          {canSurcoinche && (
            <button className="btn-surcoinche" onClick={() => socket.emit('surcoinche')}>SURCOINCHE ×4</button>
          )}
        </div>
      )}

      {isMyTurn ? (
        <div className="bid-popup">
          <div className="bpop-values">
            {BID_STEPS.map(v => {
              const disabled = bidOrd(v) <= curBidNum;
              return (
                <button key={v}
                  className={`bpv ${bidValue === v ? 'sel' : ''} ${disabled ? 'dis' : ''}`}
                  disabled={disabled}
                  onClick={() => !disabled && setBidValue(v)}>
                  {v}
                </button>
              );
            })}
          </div>
          <div className="bpop-suits">
            {SUIT_BUTTONS.map(s => (
              <button key={s}
                className={`bps ${bidSuit === s ? 'sel' : ''} ${['♥','♦'].includes(s) ? 'red' : ''}`}
                onClick={() => setBidSuit(s)}>
                {s}
              </button>
            ))}
            <button className="bps bps-passer" onClick={() => socket.emit('pass')}>Passer</button>
          </div>
          {bidValue && bidSuit && (
            <button className="bpop-confirm" onClick={onBid}>
              Miser {bidValue} {suitLabel(bidSuit)}
            </button>
          )}
        </div>
      ) : (
        <div className="bid-waiting">
          {gs.coinched
            ? `⏳ En attente de la réponse de ${playerName(gs.biddingIdx)}…`
            : `⏳ ${playerName(gs.biddingIdx)} réfléchit…`}
        </div>
      )}
    </div>
  );
}

// ── AnnouncePanel ──────────────────────────────────────────────────────────
function AnnouncePanel({ gs, pi, selAnn, setSelAnn }) {
  const submitted = gs.myDeclared !== null;
  const waiting   = gs.declaredStatus.filter(Boolean).length;

  function toggle(id) {
    setSelAnn(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  }

  return (
    <div className="announce-panel">
      <h3>Vos annonces</h3>
      {!submitted ? (
        <>
          {gs.myDetected.length === 0
            ? <p className="no-ann">Vous n'avez pas d'annonces.</p>
            : (
              <div className="ann-list">
                {gs.myDetected.map(a => (
                  <label key={a.id} className={`ann-item ${selAnn.includes(a.id) ? 'checked' : ''}`}>
                    <input type="checkbox" checked={selAnn.includes(a.id)} onChange={() => toggle(a.id)} />
                    <span className="ann-label">{a.label}</span>
                    <span className="ann-pts">{a.pts} pts</span>
                  </label>
                ))}
              </div>
            )
          }
          <button className="btn-primary"
            onClick={() => socket.emit('submit_announces', { selectedIds: selAnn })}>
            Confirmer
          </button>
        </>
      ) : (
        <div className="ann-submitted">
          ✅ Annonces soumises — en attente ({waiting}/{gs.declaredStatus.length})
        </div>
      )}
    </div>
  );
}

// ── RoundModal ────────────────────────────────────────────────────────────
function RoundModal({ gs, myTeam, teamName }) {
  const r = gs.roundResult;
  if (!r) return null;
  const winTeam = r.chute ? 1 - r.contractTeam : r.contractTeam;

  return (
    <div className={`round-modal${gs.state === 'game_over' ? ' game-over-modal' : ''}`}>
      <div className={`round-result-badge ${r.chute ? 'chute' : 'ok'}`}>
        {r.chute ? '💥 Chute !' : '✅ Contrat réussi !'}
      </div>
      <div className="round-contract-info">
        <strong>{teamName(r.contractTeam)}</strong> avait annoncé{' '}
        <strong>{r.contractValue} {suitLabel(r.contractSuit)}</strong>
        {r.surcoinched && <span className="badge-mult">Surcoinché ×4</span>}
        {!r.surcoinched && r.coinched && <span className="badge-mult">Coinché ×2</span>}
      </div>
      <div className="score-table">
        {[0, 1].map(t => (
          <div key={t} className={`score-row ${t === winTeam ? 'winner-row' : ''}`}>
            <span className="sr-name">{teamName(t)}</span>
            <span className="sr-detail">Plis: {r.trickPts[t]}</span>
            {r.announcePts[t] > 0 && <span className="sr-detail">Annonces: +{r.announcePts[t]}</span>}
            {r.belotePts[t]   > 0 && <span className="sr-detail">Belote: +{r.belotePts[t]}</span>}
            {r.multiplier > 1 && <span className="sr-detail">×{r.multiplier}</span>}
            <span className="sr-score">+{t === 0 ? r.team0Score : r.team1Score} pts</span>
          </div>
        ))}
        <div className="plis-total">
          Total plis : {r.trickPts[0] + r.trickPts[1]} pts
          {r.contractSuit === 'TA' && ' (TA)'}
          {r.contractSuit === 'SA' && ' (SA)'}
        </div>
      </div>
      <div className="round-totals">
        <span>{teamName(0)}: <strong>{r.totalAfter[0]}</strong></span>
        <span className="tot-sep">|</span>
        <span>{teamName(1)}: <strong>{r.totalAfter[1]}</strong></span>
        <span className="tot-max">/{gs.settings.maxPoints}</span>
      </div>
      {gs.state === 'round_over' && (
        <button className="btn-primary" onClick={() => socket.emit('next_round')}>
          Manche suivante →
        </button>
      )}
      {gs.state === 'game_over' && (
        <div className="game-over-banner">
          <div className="go-trophy">🏆</div>
          <h2>{teamName(winTeam)} remporte la partie !</h2>

          {gs.roundHistory?.length > 0 && (
            <div className="game-summary">
              <div className="gs-title">Résumé · {gs.roundHistory.length} manche{gs.roundHistory.length > 1 ? 's' : ''}</div>

              <div className="gs-row gs-header">
                <span>#</span>
                <span>Contrat</span>
                <span></span>
                <span>NOUS</span>
                <span>EUX</span>
              </div>

              {gs.roundHistory.map((rh, i) => {
                const bidder  = gs.players[rh.contractPlayerIdx];
                const hasAnn  = (rh.announcePts?.[0] ?? 0) > 0 || (rh.announcePts?.[1] ?? 0) > 0;
                const nousScore = rh[`team${myTeam}Score`];
                const euxScore  = rh[`team${1 - myTeam}Score`];
                return (
                  <React.Fragment key={i}>
                    <div className={`gs-row${rh.chute ? ' gs-chute' : ' gs-ok'}`}>
                      <span className="gs-num">{i + 1}</span>
                      <span className="gs-contract">
                        {bidder && <strong>{bidder.name}</strong>}
                        {bidder && ' · '}
                        {rh.contractValue} {suitLabel(rh.contractSuit)}
                        {rh.surcoinched ? ' ⚡⚡×4' : rh.coinched ? ' ⚡×2' : ''}
                      </span>
                      <span className="gs-icon">{rh.chute ? '💥' : '✅'}</span>
                      <span className="gs-pts gs-nous">{nousScore > 0 ? `+${nousScore}` : '—'}</span>
                      <span className="gs-pts">{euxScore > 0 ? `+${euxScore}` : '—'}</span>
                    </div>
                    {hasAnn && rh.announceWinnerTeam >= 0 && (() => {
                      const parts = gs.teams[rh.announceWinnerTeam]
                        .flatMap(pIdx => {
                          const anns = rh.declaredAnn?.[pIdx];
                          if (!anns?.length) return [];
                          return [`${gs.players[pIdx]?.name} : ${anns.map(a => `${a.label} (${a.pts}pts)`).join(', ')}`];
                        });
                      return parts.length > 0 ? (
                        <div className="gs-ann-row">{parts.join(' · ')}</div>
                      ) : null;
                    })()}
                  </React.Fragment>
                );
              })}

              <div className="gs-row gs-total">
                <span></span>
                <span className="gs-total-label">Score final</span>
                <span></span>
                <span className="gs-pts gs-nous gs-total-val">{r.totalAfter[myTeam]}</span>
                <span className="gs-pts gs-total-val">{r.totalAfter[1 - myTeam]}</span>
              </div>
            </div>
          )}

          <button className="btn-primary go-replay-btn" onClick={() => socket.emit('restart_game')}>
            🔄 Rejouer
          </button>
        </div>
      )}
    </div>
  );
}
