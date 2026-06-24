'use strict';
/**
 * 4 bots aléatoires pour tester la partie de bout en bout.
 * Usage: node bots.js [nbManches]   (par défaut 3 manches max ou game_over)
 */
const { io } = require('socket.io-client');

const SERVER = 'http://localhost:3001';
const NAMES  = ['Alice', 'Bob', 'Carla', 'David'];
const BID_STEPS = [80, 90, 100, 110, 120, 130, 140, 150, 160, 'Capot'];
const SUITS     = ['♠', '♥', '♦', '♣', 'SA', 'TA'];

// ── helpers ────────────────────────────────────────────────────────────────
const rand  = (arr) => arr[Math.floor(Math.random() * arr.length)];
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const delay = () => sleep(200 + Math.random() * 300);

let roomCode = null;
let roundCount = 0;
const maxRounds = Number(process.argv[2]) || 999;

// ── Bot factory ─────────────────────────────────────────────────────────────
function createBot(name, isHost) {
  const sock = io(SERVER, { autoConnect: false });
  let myIdx   = -1;
  let myState = null;  // latest game state

  const log = (...args) => console.log(`[${name}]`, ...args);

  // ── State handler ─────────────────────────────────────────────────────────
  sock.on('state', (gs) => {
    myState = gs;
    act(gs);
  });

  sock.on('notify', ({ msg }) => log('notify:', msg));
  sock.on('err',    ({ msg }) => log('ERR:', msg));

  // ── Actions ───────────────────────────────────────────────────────────────
  async function act(gs) {
    await delay();

    // WAITING: host starts once 4 players are in
    if (gs.state === 'waiting' && isHost && gs.players.length === 4) {
      log('→ start_game');
      sock.emit('start_game');
      return;
    }

    // BIDDING: my turn
    if (gs.state === 'bidding' && gs.biddingIdx === myIdx) {
      await doBid(gs);
      return;
    }

    // ANNOUNCE: submit my announces
    if (gs.state === 'announce') {
      const alreadyDeclared = gs.declaredStatus?.[myIdx];
      if (!alreadyDeclared) {
        // Submit all detected announces (for simplicity)
        const ids = (gs.myDetected || []).map(a => a.id);
        log('→ submit_announces', ids);
        sock.emit('submit_announces', { ids });
      }
      return;
    }

    // PLAYING: my turn
    if (gs.state === 'playing' && gs.currentPlayerIdx === myIdx) {
      const playable = gs.playableIds || [];
      if (playable.length > 0) {
        const cardId = rand(playable);
        log('→ play_card', cardId);
        sock.emit('play_card', { cardId });
      }
      return;
    }

    // ROUND_OVER: host triggers next round
    if (gs.state === 'round_over' && isHost) {
      roundCount++;
      log(`→ next_round (manche ${roundCount})`);
      if (roundCount >= maxRounds) {
        console.log('\n=== Limite de manches atteinte, arrêt ===');
        process.exit(0);
      }
      sock.emit('next_round');
      return;
    }

    // GAME_OVER
    if (gs.state === 'game_over' && isHost) {
      const [s0, s1] = gs.totalScores;
      console.log(`\n=== FIN DE PARTIE === Équipe 0: ${s0} | Équipe 1: ${s1}`);
      console.log(`Gagnant: Équipe ${s0 >= s1 ? 0 : 1}`);
      process.exit(0);
    }
  }

  async function doBid(gs) {
    const cur = gs.currentBid;
    const curNum = cur ? (cur.value === 'Capot' ? 999 : Number(cur.value)) : 70;

    // 60% chance to pass, but force a bid if no bid yet and we're last to speak
    const noBidYet  = !cur;
    const passCount = gs.bids ? gs.bids.filter(b => b.type === 'pass').length : 0;
    const forceBid  = noBidYet && passCount >= 3;

    if (!forceBid && Math.random() < 0.6) {
      log('→ pass');
      sock.emit('pass');
      return;
    }

    // Pick a valid step above current
    const validSteps = BID_STEPS.filter(v => {
      const n = v === 'Capot' ? 999 : Number(v);
      return n > curNum;
    });

    if (validSteps.length === 0) {
      log('→ pass (no valid step)');
      sock.emit('pass');
      return;
    }

    // Prefer low bids — pick from first half
    const half  = Math.ceil(validSteps.length / 2);
    const value = rand(validSteps.slice(0, half));
    const suit  = rand(SUITS);
    log(`→ bid ${value} ${suit}`);
    sock.emit('bid', { value, suit });
  }

  // ── Connection flow ───────────────────────────────────────────────────────
  sock.on('connect', async () => {
    log('connected');
    await delay();

    if (isHost) {
      sock.emit('create_room', {
        name,
        settings: { maxPoints: 500, scoringMode: 'net', beloteFrom: 80, countAnnounces: true },
      });
    } else {
      // Wait until host has published the code
      while (!roomCode) await sleep(100);
      sock.emit('join_room', { code: roomCode, name });
    }
  });

  sock.on('joined', ({ playerIdx, code }) => {
    myIdx    = playerIdx;
    if (code) roomCode = code;
    log(`joined as idx=${myIdx}, code=${roomCode}`);
  });

  sock.on('disconnect', () => log('disconnected'));

  return { sock, getName: () => name };
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('=== Coinche Bots — test de bout en bout ===\n');

  const bots = NAMES.map((name, i) => createBot(name, i === 0));

  // Host connects first so roomCode is set before others try to join
  bots[0].sock.connect();
  await sleep(500);
  bots.slice(1).forEach(b => b.sock.connect());

  // Watchdog: kill after 5 minutes if stuck
  setTimeout(() => {
    console.error('\n[watchdog] Timeout 5 min — partie coincée ?');
    process.exit(1);
  }, 5 * 60 * 1000);
}

main().catch(console.error);
