'use strict';
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const FILE = path.join(__dirname, 'accounts.json');

function load() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); }
  catch { return {}; }
}

function save(data) {
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
}

function hashPin(pin, salt) {
  return crypto.createHmac('sha256', salt).update(String(pin)).digest('hex');
}

function create(name, pin, uuid) {
  const n = String(name).trim().slice(0, 20);
  if (n.length < 2)                     return { error: 'Nom trop court (min 2 caractères)' };
  if (!/^\d{4}$/.test(String(pin)))     return { error: 'PIN : 4 chiffres requis' };
  if (!uuid)                             return { error: 'UUID manquant' };
  const data = load();
  if (data[n])                           return { error: 'Ce nom est déjà pris' };
  const salt    = crypto.randomBytes(16).toString('hex');
  const pinHash = hashPin(String(pin), salt);
  data[n] = { uuid, pinHash, salt };
  save(data);
  return { ok: true, name: n, uuid };
}

function login(name, pin) {
  const n    = String(name).trim();
  const data = load();
  const acc  = data[n];
  if (!acc) return { error: 'Compte introuvable' };
  if (hashPin(String(pin), acc.salt) !== acc.pinHash) return { error: 'PIN incorrect' };
  return { ok: true, name: n, uuid: acc.uuid };
}

function getAll() {
  return load();
}

module.exports = { create, login, getAll };
