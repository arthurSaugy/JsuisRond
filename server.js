/*
 * Cercle Vicieux — serveur en ligne.
 * Sert les fichiers du jeu (dossier public/) et héberge les salons via WebSocket sur /ws.
 * La simulation tourne ici (serveur autoritaire) avec le même moteur que le mode solo.
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const Engine = require('./public/engine.js');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC = path.join(__dirname, 'public');
const MAX_PLAYERS = 12;
const TICK = 1 / 60;          // simulation à 60 Hz
const SNAP_EVERY = 2;         // un état envoyé tous les 2 ticks (30 Hz)

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.json': 'application/json',
};

// ---------- fichiers statiques ----------
const server = http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
  let urlPath;
  try { urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname); }
  catch (e) { res.writeHead(400); return res.end(); }
  if (urlPath === '/health') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('ok'); }
  if (urlPath.endsWith('/')) urlPath += 'index.html';
  const file = path.join(PUBLIC, path.normalize(urlPath));
  if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(403); return res.end(); }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('Introuvable'); }
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] || 'application/octet-stream',
      'content-length': st.size,
      'cache-control': 'no-cache',
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
});

// ---------- salons ----------
const rooms = new Map();
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // sans I ni O pour éviter les confusions
const BOT_NAMES = ['Bip', 'Rouage', 'Pixel', 'Tic-Tac', 'Boulon', 'Volt', 'Écrou', 'Diode', 'Ressort', 'Turbo', 'Puce'];

function newCode() {
  for (let tries = 0; tries < 1000; tries++) {
    let c = '';
    for (let i = 0; i < 4; i++) c += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
    if (!rooms.has(c)) return c;
  }
  throw new Error('plus de codes disponibles');
}
function cleanName(n) {
  const s = String(n || '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 16);
  return s || 'Joueur';
}
function send(ws, msg) { if (ws.readyState === 1) ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg)); }

class Room {
  constructor(code) {
    this.code = code;
    this.clients = new Map(); // id → client
    this.host = null;
    this.settings = Engine.defaultSettings();
    this.state = 'lobby';
    this.game = null;
    this.meta = null;
    this.loop = null;
  }

  humans() { return [...this.clients.values()]; }

  freeColor() {
    const used = new Set(this.humans().map((c) => c.color));
    return Engine.COLORS.find((c) => !used.has(c)) || Engine.COLORS[this.clients.size % Engine.COLORS.length];
  }

  lobbyPlayers() {
    const list = this.humans().map((c) => ({ id: c.id, name: c.name, color: c.color, bot: null }));
    const used = new Set(list.map((p) => p.color));
    const free = Engine.COLORS.filter((c) => !used.has(c));
    const nb = Math.min(this.settings.bots, MAX_PLAYERS - list.length);
    for (let i = 0; i < nb; i++) {
      list.push({ id: 'bot' + i, name: BOT_NAMES[i % BOT_NAMES.length], color: free[i % Math.max(1, free.length)] || '#ffffff',
        bot: this.settings.botLevel });
    }
    return list;
  }

  roomMsg() {
    return { t: 'room', code: this.code, host: this.host, state: this.state, settings: this.settings, players: this.lobbyPlayers() };
  }
  broadcast(msg) {
    const s = typeof msg === 'string' ? msg : JSON.stringify(msg);
    for (const c of this.clients.values()) send(c.ws, s);
  }
  broadcastRoom() { this.broadcast(this.roomMsg()); }

  add(client) {
    client.room = this;
    client.color = this.freeColor();
    client.lastSeq = 0;
    this.clients.set(client.id, client);
    if (!this.host) this.host = client.id;
    // trop de bots pour la place restante : on en retire
    this.settings.bots = Math.min(this.settings.bots, MAX_PLAYERS - this.clients.size);
    this.broadcastRoom();
    if (this.state === 'game' && this.game) {
      // arrivé en cours de manche : il regarde, et jouera la suivante
      send(client.ws, { t: 'start', meta: this.meta, settings: this.game.s });
    }
  }

  remove(client) {
    this.clients.delete(client.id);
    client.room = null;
    if (this.game) this.game.forfeit(client.id);
    if (this.clients.size === 0) { this.stop(); rooms.delete(this.code); return; }
    if (this.host === client.id) this.host = this.clients.keys().next().value;
    this.broadcastRoom();
  }

  start(byClient) {
    if (byClient.id !== this.host) return send(byClient.ws, { t: 'error', msg: 'Seul l\'hôte peut lancer la partie.' });
    const roster = this.lobbyPlayers();
    if (roster.length < 2) return send(byClient.ws, { t: 'error', msg: 'Il faut au moins 2 joueurs (ajoute un bot si besoin).' });
    this.stop();
    this.meta = roster;
    this.game = new Engine.Game(roster, this.settings, crypto.randomInt(2 ** 32));
    this.state = 'game';
    for (const c of this.clients.values()) c.lastSeq = 0;
    this.broadcastRoom();
    this.broadcast({ t: 'start', meta: this.meta, settings: this.game.s });
    this.run();
  }

  run() {
    let last = performance.now(), acc = 0, tick = 0, overAt = null;
    this.loop = setInterval(() => {
      const now = performance.now();
      acc += Math.min(250, now - last) / 1000;
      last = now;
      while (acc >= TICK) {
        this.game.step(TICK);
        acc -= TICK;
        tick++;
        if (tick % SNAP_EVERY === 0) this.snapshot();
      }
      if (this.game.phase === 'over') {
        if (overAt == null) overAt = now;
        else if (now - overAt > 3000) this.stop(); // fin : on garde l'écran des scores
      }
    }, 1000 / 120);
  }

  snapshot() {
    const base = JSON.stringify(this.game.view());
    for (const c of this.clients.values()) {
      if (c.ws.bufferedAmount > 256 * 1024) continue; // client trop lent : on saute un état
      send(c.ws, '{"t":"s","a":' + c.lastSeq + ',"v":' + base + '}');
    }
  }

  stop() { if (this.loop) { clearInterval(this.loop); this.loop = null; } }

  toLobby(byClient) {
    if (byClient.id !== this.host) return;
    this.stop();
    this.game = null;
    this.state = 'lobby';
    this.broadcastRoom();
  }

  setSettings(byClient, s) {
    if (byClient.id !== this.host || this.state !== 'lobby') return;
    const clean = Engine.sanitizeSettings(s);
    clean.bots = Math.min(clean.bots, MAX_PLAYERS - this.clients.size);
    this.settings = clean;
    this.broadcastRoom();
  }
}

// ---------- WebSocket ----------
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 4096 });
let nextId = 1;

wss.on('connection', (ws) => {
  const client = { id: 'p' + (nextId++), ws, name: 'Joueur', color: '#fff', room: null, lastSeq: 0,
    budget: { t: Date.now(), n: 0 } };
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  send(ws, { t: 'welcome', id: client.id });

  ws.on('message', (data) => {
    // limite grossière : 400 messages par seconde
    const now = Date.now();
    if (now - client.budget.t > 1000) { client.budget.t = now; client.budget.n = 0; }
    if (++client.budget.n > 400) return;
    let m;
    try { m = JSON.parse(data); } catch (e) { return; }
    if (!m || typeof m !== 'object') return;
    const room = client.room;

    switch (m.t) {
      case 'in': {
        if (!room || !room.game) return;
        const s = Number(m.s), dx = Number(m.dx), dy = Number(m.dy);
        if (!Number.isInteger(s) || s <= client.lastSeq || !Number.isFinite(dx) || !Number.isFinite(dy)) return;
        client.lastSeq = s;
        room.game.applyInput(client.id, dx, dy);
        return;
      }
      case 'create': {
        if (room) room.remove(client);
        client.name = cleanName(m.name);
        const r = new Room(newCode());
        rooms.set(r.code, r);
        r.add(client);
        return;
      }
      case 'join': {
        const code = String(m.code || '').toUpperCase().slice(0, 4);
        const r = rooms.get(code);
        if (!r) return send(ws, { t: 'error', msg: 'Aucun salon avec le code ' + code + '.' });
        if (r === room) return;
        if (r.clients.size >= MAX_PLAYERS) return send(ws, { t: 'error', msg: 'Ce salon est complet.' });
        if (room) room.remove(client);
        client.name = cleanName(m.name);
        r.add(client);
        return;
      }
      case 'settings': if (room) room.setSettings(client, m.settings); return;
      case 'start': if (room) room.start(client); return;
      case 'lobby': if (room) room.toLobby(client); return;
      case 'leave': if (room) room.remove(client); return;
    }
  });

  ws.on('close', () => { if (client.room) client.room.remove(client); });
  ws.on('error', () => {});
});

// connexions mortes (onglet fermé brutalement, réseau coupé)
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000).unref();

server.listen(PORT, HOST, () => {
  console.log('Cercle Vicieux sur http://' + (HOST === '0.0.0.0' ? 'localhost' : HOST) + ':' + PORT);
});
