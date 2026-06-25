'use strict';
const fs   = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'stats.json');

function load() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); }
  catch { return {}; }
}

function save(data) {
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
}

const blank = () => ({
  name: '', gamesPlayed: 0, gamesWon: 0,
  roundsPlayed: 0, roundsWon: 0, pointsScored: 0,
});

function getStats(uuid) {
  return load()[uuid] ?? null;
}

function recordRound(uuid, name, won, points) {
  const data = load();
  if (!data[uuid]) data[uuid] = blank();
  data[uuid].name = name || data[uuid].name;
  data[uuid].roundsPlayed++;
  if (won) data[uuid].roundsWon++;
  data[uuid].pointsScored += Math.round(points);
  save(data);
}

function recordGame(uuid, name, won) {
  const data = load();
  if (!data[uuid]) data[uuid] = blank();
  data[uuid].name = name || data[uuid].name;
  data[uuid].gamesPlayed++;
  if (won) data[uuid].gamesWon++;
  save(data);
}

module.exports = { getStats, recordRound, recordGame };
