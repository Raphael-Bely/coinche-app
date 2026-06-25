'use strict';
const express     = require('express');
const { createServer } = require('http');
const { Server }  = require('socket.io');
const cors        = require('cors');
const path        = require('path');
const fs          = require('fs');
const { GameRoom } = require('./game/GameRoom');
const { normalPlay, chooseBid, chooseBidClassique } = require('./game/BotNormal');
const { rlPlay } = require('./game/BotRL');
const stats = require('./stats');

const app  = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

const http = createServer(app);
const io   = new Server(http, { cors: { origin: '*' } });

const rooms      = new Map(); // code → GameRoom
const playerRoom = new Map(); // socketId → code
const playerUuid = new Map(); // socketId → uuid
const voiceRooms = new Map();
const videoRooms = new Map();

function makeMediaRoom(map, code) {
  if (!map.has(code)) map.set(code, new Map());
  return map.get(code);
}
function broadcastMediaUsers(map, code, event) {
  const vr = map.get(code);
  if (!vr) return;
  const users = [...vr.values()].map(({ playerIdx, name, socketId }) => ({ playerIdx, name, socketId }));
  io.to(code).emit(event, users);
}
function leaveMediaRoom(map, broadcastEvent, peerLeftEvent, socketId) {
  const code = playerRoom.get(socketId);
  if (!code) return;
  const vr = map.get(code);
  if (!vr || !vr.has(socketId)) return;
  vr.delete(socketId);
  for (const { socketId: sid } of vr.values())
    io.to(sid).emit(peerLeftEvent, { socketId });
  broadcastMediaUsers(map, code, broadcastEvent);
}

function leaveVoiceRoom(sid) { leaveMediaRoom(voiceRooms, 'voice_users', 'voice_peer_left', sid); }
function leaveVideoRoom(sid) { leaveMediaRoom(videoRooms, 'video_users', 'video_peer_left', sid); }

function genCode() {
  let c;
  do { c = Math.random().toString(36).substring(2, 7).toUpperCase(); } while (rooms.has(c));
  return c;
}

function broadcast(room) {
  for (const p of room.players)
    if (!p.isBot) io.to(p.socketId).emit('state', room.publicState(p.idx));
}

function notify(room, msg) {
  io.to(room.code).emit('notify', msg);
}

// ── Bot logic ────────────────────────────────────────────────────────────────
const BOT_NAMES_RANDOM    = ['Bot-Renard', 'Bot-Aigle', 'Bot-Loup'];
const BOT_NAMES_NORMAL    = ['Bot-Expert', 'Bot-Malin', 'Bot-Sage'];
const BOT_NAMES_CLASSIQUE = ['Bot-As', 'Bot-Roi', 'Bot-Dame'];
const BOT_NAMES_RL        = ['Bot-Alpha', 'Bot-Neural', 'Bot-Omega'];
const BOT_SUITS  = ['♠', '♥', '♦', '♣', 'SA', 'TA'];
const BOT_STEPS  = [80, 90, 100, 110, 120, 130, 140, 150, 160, 'Capot'];

function botLevel(room, pi) {
  return room.players[pi]?.botLevel || 'random';
}

function broadcastAndBotAct(room) {
  broadcast(room);
  scheduleBotActions(room);
}

function recordRoundStats(room) {
  const rr = room.roundResult;
  if (!rr) return;
  const winTeam  = rr.chute ? 1 - rr.contractTeam : rr.contractTeam;
  const gameOver = room.state === 'game_over';
  for (const p of room.players) {
    if (p.isBot) continue;
    const uuid = playerUuid.get(p.socketId);
    if (!uuid) continue;
    const pTeam    = room.teamOf(p.idx);
    const roundPts = pTeam === 0 ? rr.team0Score : rr.team1Score;
    stats.recordRound(uuid, p.name, pTeam === winTeam, roundPts);
    if (gameOver) {
      const gameWon = room.totalScores[pTeam] > room.totalScores[1 - pTeam];
      stats.recordGame(uuid, p.name, gameWon);
    }
    io.to(p.socketId).emit('stats_update', stats.getStats(uuid));
  }
}

function doAdvanceTrick(room) {
  const r2 = room.advanceTrick();
  if (r2?.error) return;
  if (room.state === 'round_over' || room.state === 'game_over') recordRoundStats(room);
  broadcastAndBotAct(room);
}

function scheduleBotActions(room) {
  const { state, biddingIdx, currentPlayerIdx, botIdxs, declaredAnn } = room;

  if (state === 'bidding' && botIdxs.has(biddingIdx)) {
    const snap = biddingIdx;
    // Long delay so human can read the bid and coinche if wanted
    // After coinche: short delay so game starts quickly; otherwise long to allow human to coinche
    const bidDelay = room.coinched ? 1000 + Math.random() * 600 : 4000 + Math.random() * 1500;
    setTimeout(() => {
      if (room.state !== 'bidding' || room.biddingIdx !== snap) return;
      const r = botDoBid(room, snap);
      if (r.redeal) notify(room, '🃏 Tout le monde a passé — redonne !');
      broadcastAndBotAct(room);
    }, bidDelay);

  } else if (state === 'announce') {
    for (let i = 0; i < 4; i++) {
      if (botIdxs.has(i) && declaredAnn[i] === null) {
        const snap = i;
        setTimeout(() => {
          if (room.state !== 'announce' || room.declaredAnn[snap] !== null) return;
          const ids = (room.detectedAnn[snap] || []).map(a => a.id);
          room.submitAnnounces(bsid(room, snap), ids);
          broadcastAndBotAct(room);
        }, 600 + Math.random() * 600);
        break;
      }
    }

  } else if (state === 'playing' && botIdxs.has(currentPlayerIdx) && !room.pendingTrickState) {
    const snap = currentPlayerIdx;
    setTimeout(async () => {
      if (room.state !== 'playing' || room.currentPlayerIdx !== snap || room.pendingTrickState) return;
      const r = await botDoPlay(room, snap);
      if (r?.beloteMsg) {
        notify(room, r.beloteMsg);
        io.to(room.code).emit('belote_flash', {
          playerIdx: snap,
          type: r.beloteMsg.includes('Rebelote') ? 'rebelote' : 'belote',
        });
      }
      broadcast(room); // show the card immediately
      if (r?.trickDisplayed) {
        setTimeout(() => {
          doAdvanceTrick(room);
        }, 1300);
      } else {
        scheduleBotActions(room);
      }
    }, 700 + Math.random() * 600);
  }
}

function bsid(room, pi) { return room.players[pi]?.socketId ?? `bot:${pi}`; }

function botDoBid(room, pi) {
  if (room.coinched) return room.passBid(bsid(room, pi));
  const lv = botLevel(room, pi);
  if (lv === 'classique') return botDoBidClassique(room, pi);
  if (lv === 'normal')    return botDoBidNormal(room, pi);
  return botDoBidRandom(room, pi);
}

function botDoBidClassique(room, pi) {
  const sid = bsid(room, pi);
  const partner    = room.partnerOf(pi);
  const partnerBid = partner >= 0
    ? (room.bids.filter(b => b.playerIdx === partner && b.type === 'bid').at(-1) ?? null)
    : null;
  const mustBid = !room.currentBid && room.passCount >= 3;
  const bid = chooseBidClassique(room.hands[pi], room.currentBid, partnerBid);
  if (!bid && mustBid) return botDoBidRandom(room, pi);
  if (!bid) return room.passBid(sid);
  return room.placeBid(sid, bid.value, bid.suit);
}

function bidOrd(v) {
  if (!v) return 70;
  if (v === 'Capot')           return 250;
  if (v === 'Capot Beloté')    return 270;
  if (v === 'Générale')        return 400;
  if (v === 'Générale Beloté') return 420;
  return Number(v) || 0;
}

function botDoBidRandom(room, pi) {
  const sid    = bsid(room, pi);
  const cur    = room.currentBid;
  const curNum = bidOrd(cur?.value);
  const noBid  = !cur;
  const passes = room.bids.filter(b => b.type === 'pass').length;

  if (!(noBid && passes >= 3) && Math.random() < 0.55) {
    return room.passBid(sid);
  }
  const valid = BOT_STEPS.filter(v => bidOrd(v) > curNum);
  if (!valid.length) return room.passBid(sid);

  const value = valid[Math.floor(Math.random() * Math.ceil(valid.length / 2))];
  const suit  = BOT_SUITS[Math.floor(Math.random() * BOT_SUITS.length)];
  return room.placeBid(sid, value, suit);
}

function botDoBidNormal(room, pi) {
  const sid = bsid(room, pi);
  const mustBid = !room.currentBid && room.passCount >= 3;
  const bid = chooseBid(room.hands[pi], room.currentBid);
  if (!bid && mustBid) return botDoBidRandom(room, pi);
  if (!bid) return room.passBid(sid);
  return room.placeBid(sid, bid.value, bid.suit);
}

function botDoPlay(room, pi) {
  const lv = botLevel(room, pi);
  if (lv === 'rl')                           return rlPlay(room, pi);  // async
  if (lv === 'classique' || lv === 'normal') return normalPlay(room, pi);
  return botDoPlayRandom(room, pi);
}

function botDoPlayRandom(room, pi) {
  const { getPlayableCards } = require('./game/Trick');
  const trump    = room.currentBid?.suit;
  const partner  = room.partnerOf(pi);
  const playable = getPlayableCards(room.hands[pi], room.currentTrick, trump, pi, partner);
  if (!playable.length) return {};
  const card = playable[Math.floor(Math.random() * playable.length)];
  return room.playCard(bsid(room, pi), card.id);
}

io.on('connection', socket => {
  // ── Create room ──────────────────────────────────────────────────────
  socket.on('create_room', ({ name, settings, uuid }) => {
    if (uuid) playerUuid.set(socket.id, uuid);
    const code = genCode();
    const room = new GameRoom(code, settings || {});
    rooms.set(code, room);

    const r = room.addPlayer(socket.id, name || 'Joueur');
    if (r.error) return socket.emit('err', r.error);

    playerRoom.set(socket.id, code);
    socket.join(code);
    socket.emit('joined', { code, playerIdx: r.playerIdx });
    broadcast(room);
  });

  // ── Join room ────────────────────────────────────────────────────────
  socket.on('join_room', ({ name, code, uuid }) => {
    if (uuid) playerUuid.set(socket.id, uuid);
    const c    = (code || '').toUpperCase().trim();
    const room = rooms.get(c);
    if (!room) return socket.emit('err', 'Salle introuvable');

    const r = room.addPlayer(socket.id, name || 'Joueur');
    if (r.error) return socket.emit('err', r.error);

    playerRoom.set(socket.id, c);
    socket.join(c);
    socket.emit('joined', { code: c, playerIdx: r.playerIdx });
    broadcast(room);
  });

  // ── Waiting room: set teams ──────────────────────────────────────────
  socket.on('set_teams', ({ teams }) => {
    const room = rooms.get(playerRoom.get(socket.id));
    if (!room) return;
    const r = room.setTeams(teams);
    if (r?.error) return socket.emit('err', r.error);
    // Notify each player of their (possibly new) index so client can sync
    if (r?.remapped) {
      for (const [sid, newIdx] of Object.entries(r.remapped)) {
        io.to(sid).emit('reindexed', { playerIdx: newIdx });
      }
    }
    broadcast(room);
  });

  // ── List public rooms ────────────────────────────────────────────────
  socket.on('list_rooms', () => {
    const list = [...rooms.values()]
      .filter(r => r.settings.public && r.state === 'waiting' && r.players.length < 4)
      .map(r => ({
        code:        r.code,
        hostName:    r.players[0]?.name ?? r.code,
        players:     r.players.length,
        maxPoints:   r.settings.maxPoints,
        scoringMode: r.settings.scoringMode,
      }));
    socket.emit('rooms_list', list);
  });

  // ── Add bot ──────────────────────────────────────────────────────────
  socket.on('add_bot', ({ level } = {}) => {
    const room = rooms.get(playerRoom.get(socket.id));
    if (!room) return;
    const lv    = level === 'classique' ? 'classique' : level === 'normal' ? 'normal' : level === 'rl' ? 'rl' : 'random';
    const idx   = room.botIdxs.size;
    const names = lv === 'classique' ? BOT_NAMES_CLASSIQUE : lv === 'normal' ? BOT_NAMES_NORMAL : lv === 'rl' ? BOT_NAMES_RL : BOT_NAMES_RANDOM;
    const name  = names[idx % names.length];
    const r     = room.addBot(name, lv);
    if (r.error) return socket.emit('err', { msg: r.error });
    broadcast(room);
  });

  // ── Start game ───────────────────────────────────────────────────────
  socket.on('start_game', () => {
    const room = rooms.get(playerRoom.get(socket.id));
    if (!room) return;
    const r = room.startGame(socket.id);
    if (r.error) return socket.emit('err', r.error);
    broadcastAndBotAct(room);
  });

  // ── Bidding ──────────────────────────────────────────────────────────
  socket.on('bid', ({ value, suit }) => {
    const room = rooms.get(playerRoom.get(socket.id));
    if (!room) return;
    const r = room.placeBid(socket.id, value, suit);
    if (r.error) return socket.emit('err', r.error);
    if (r.redeal) notify(room, '🃏 Tout le monde a passé — redonne !');
    broadcastAndBotAct(room);
  });

  socket.on('pass', () => {
    const room = rooms.get(playerRoom.get(socket.id));
    if (!room) return;
    const r = room.passBid(socket.id);
    if (r.error) return socket.emit('err', r.error);
    if (r.redeal) notify(room, '🃏 Tout le monde a passé — redonne !');
    broadcastAndBotAct(room);
  });

  socket.on('coinche', () => {
    const room = rooms.get(playerRoom.get(socket.id));
    if (!room) return;
    const r = room.coinche(socket.id);
    if (r.error) return socket.emit('err', r.error);
    broadcastAndBotAct(room);
  });

  socket.on('surcoinche', () => {
    const room = rooms.get(playerRoom.get(socket.id));
    if (!room) return;
    const r = room.surcoinche(socket.id);
    if (r.error) return socket.emit('err', r.error);
    broadcastAndBotAct(room);
  });

  // ── Announces ────────────────────────────────────────────────────────
  socket.on('submit_announces', ({ selectedIds }) => {
    const room = rooms.get(playerRoom.get(socket.id));
    if (!room) return;
    const r = room.submitAnnounces(socket.id, selectedIds || []);
    if (r.error) return socket.emit('err', r.error);
    broadcastAndBotAct(room);
  });

  // ── Play card ────────────────────────────────────────────────────────
  socket.on('play_card', ({ cardId }) => {
    const room = rooms.get(playerRoom.get(socket.id));
    if (!room) return;
    const r = room.playCard(socket.id, cardId);
    if (r.error) return socket.emit('err', r.error);
    if (r.beloteMsg) {
      notify(room, r.beloteMsg);
      io.to(room.code).emit('belote_flash', {
        playerIdx: r.belotePlayerIdx ?? -1,
        type: r.beloteMsg.includes('Rebelote') ? 'rebelote' : 'belote',
      });
    }
    broadcast(room); // show card immediately
    if (r.trickDisplayed) {
      setTimeout(() => {
        const r2 = room.advanceTrick();
        if (r2?.error) return;
        broadcastAndBotAct(room);
      }, 1300);
    } else {
      scheduleBotActions(room);
    }
  });

  // ── Next round ───────────────────────────────────────────────────────
  socket.on('next_round', () => {
    const room = rooms.get(playerRoom.get(socket.id));
    if (!room) return;
    const r = room.nextRound();
    if (r.error) return socket.emit('err', r.error);
    broadcastAndBotAct(room);
  });

  // ── Chat ─────────────────────────────────────────────────────────────
  socket.on('emoji_react', ({ emoji } = {}) => {
    const code = playerRoom.get(socket.id);
    const room = rooms.get(code);
    if (!room) return;
    const pi = room._pidx(socket.id);
    if (pi < 0) return;
    const ALLOWED = new Set(['👍','❤️','😂','😮','😠','🔥','💪','🎉','😭','🤦']);
    if (!ALLOWED.has(String(emoji))) return;
    io.to(code).emit('emoji_show', { playerIdx: pi, emoji });
  });

  socket.on('chat_msg', ({ text }) => {
    const code = playerRoom.get(socket.id);
    const room = rooms.get(code);
    if (!room) return;
    const pi = room._pidx(socket.id);
    const player = room.players[pi];
    if (!player || !text) return;
    io.to(code).emit('chat_msg', {
      playerIdx: pi,
      name:      player.name,
      text:      String(text).trim().slice(0, 200),
    });
  });

  // ── Stats ────────────────────────────────────────────────────────────
  socket.on('my_stats', ({ uuid } = {}) => {
    if (!uuid) return;
    playerUuid.set(socket.id, uuid);
    socket.emit('stats_update', stats.getStats(uuid) ?? {
      name: '', gamesPlayed: 0, gamesWon: 0, roundsPlayed: 0, roundsWon: 0, pointsScored: 0,
    });
  });

  // ── Voice + Video chat ───────────────────────────────────────────────
  function handleMediaJoin(map, broadcastEvent, peerJoinedEvent) {
    const code = playerRoom.get(socket.id);
    const room = rooms.get(code);
    if (!room) return;
    const pi     = room._pidx(socket.id);
    const player = room.players[pi];
    if (!player) return;
    const vr       = makeMediaRoom(map, code);
    const existing = [...vr.values()];
    socket.emit(broadcastEvent.replace('_users', '_peers'), existing);
    for (const { socketId } of existing)
      io.to(socketId).emit(peerJoinedEvent, { socketId: socket.id, playerIdx: pi, name: player.name });
    vr.set(socket.id, { socketId: socket.id, playerIdx: pi, name: player.name });
    broadcastMediaUsers(map, code, broadcastEvent);
  }

  socket.on('voice_join',   () => handleMediaJoin(voiceRooms, 'voice_users', 'voice_peer_joined'));
  socket.on('video_join',   () => handleMediaJoin(videoRooms, 'video_users', 'video_peer_joined'));
  socket.on('voice_leave',  () => leaveVoiceRoom(socket.id));
  socket.on('video_leave',  () => leaveVideoRoom(socket.id));
  socket.on('voice_signal', ({ to, signal }) => io.to(to).emit('voice_signal', { from: socket.id, signal }));
  socket.on('video_signal', ({ to, signal }) => io.to(to).emit('video_signal', { from: socket.id, signal }));

  // ── Next round / Restart ─────────────────────────────────────────────
  socket.on('restart_game', () => {
    const room = rooms.get(playerRoom.get(socket.id));
    if (!room) return;
    const r = room.restartGame();
    if (r.error) return socket.emit('err', r.error);
    broadcastAndBotAct(room);
  });

  // ── Disconnect ───────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    leaveVoiceRoom(socket.id);
    leaveVideoRoom(socket.id);
    const code = playerRoom.get(socket.id);
    if (!code) return;
    const room = rooms.get(code);
    if (room) {
      room.removePlayer(socket.id);
      // Delete room if no human player remains (prevents ghost bot-only rooms)
      const hasHuman = room.players.some(p => !p.isBot);
      if (!hasHuman) rooms.delete(code);
      else broadcast(room);
    }
    playerRoom.delete(socket.id);
  });
});

// Serve built React frontend in production
const distDir = path.join(__dirname, '../client/dist');
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
  app.get('*', (_req, res) => res.sendFile(path.join(distDir, 'index.html')));
}

const PORT = process.env.PORT || 3001;
http.listen(PORT, () => console.log(`🃏 Coinche server → http://localhost:${PORT}`));
