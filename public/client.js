/* Cercle Vicieux — interface, sessions locale et en ligne, entrées souris, sons. */
(function () {
  'use strict';
  const { Game, COLORS, MAX_SPEED, defaultSettings, sanitizeSettings, BOT_LEVELS } = Engine;
  const $ = (id) => document.getElementById(id);
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

  // ---------- stockage local (peut être indisponible) ----------
  const store = {
    get(k, d) { try { const v = localStorage.getItem('cv_' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('cv_' + k, JSON.stringify(v)); } catch (e) { /* ignoré */ } },
  };

  // ---------- sons (synthétisés, aucun fichier) ----------
  const Sfx = {
    ac: null, muted: store.get('muted', false),
    ensure() {
      if (this.ac) return this.ac;
      try { this.ac = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { this.ac = null; }
      return this.ac;
    },
    tone(freq, dur, type, vol, slideTo, delay) {
      const ac = this.ensure();
      if (!ac || this.muted) return;
      const t0 = ac.currentTime + (delay || 0);
      const o = ac.createOscillator(), g = ac.createGain();
      o.type = type || 'sine';
      o.frequency.setValueAtTime(freq, t0);
      if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(vol || 0.15, t0 + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      o.connect(g).connect(ac.destination);
      o.start(t0); o.stop(t0 + dur + 0.02);
    },
    noise(dur, vol, freq) {
      const ac = this.ensure();
      if (!ac || this.muted) return;
      const n = Math.floor(ac.sampleRate * dur);
      const buf = ac.createBuffer(1, n, ac.sampleRate), d = buf.getChannelData(0);
      for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, 2);
      const src = ac.createBufferSource(), f = ac.createBiquadFilter(), g = ac.createGain();
      src.buffer = buf; f.type = 'lowpass'; f.frequency.value = freq || 900; g.gain.value = vol || 0.3;
      src.connect(f).connect(g).connect(ac.destination);
      src.start();
    },
    count() { this.tone(520, 0.12, 'square', 0.06); },
    go() { this.tone(880, 0.25, 'square', 0.07); },
    bomb() { this.tone(1200, 0.05, 'square', 0.03); },
    boom(near) { this.noise(near ? 0.7 : 0.45, near ? 0.55 : 0.22, near ? 1400 : 700); this.tone(120, 0.35, 'sine', near ? 0.3 : 0.12, 40); },
    elim() { this.tone(500, 0.35, 'sawtooth', 0.07, 90); },
    warn() { this.tone(660, 0.1, 'triangle', 0.08); this.tone(880, 0.12, 'triangle', 0.08, null, 0.12); },
    wind() { this.noise(1.2, 0.08, 500); },
    hole() { this.tone(90, 0.8, 'sine', 0.18, 50); },
    invert() { [880, 660, 440].forEach((f, i) => this.tone(f, 0.12, 'triangle', 0.08, null, i * 0.1)); },
    win() { [523, 659, 784, 1047].forEach((f, i) => this.tone(f, 0.18, 'square', 0.06, null, i * 0.11)); },
  };
  function syncMute() { $('mute').classList.toggle('off', Sfx.muted); }
  $('mute').addEventListener('click', () => { Sfx.muted = !Sfx.muted; store.set('muted', Sfx.muted); syncMute(); });
  syncMute();

  // ---------- réglages (UI réutilisée en solo, bots et en ligne) ----------
  const EVENT_LABELS = { shrink: 'Zone qui rétrécit', bombs: 'Bombes', wind: 'Vent', hole: 'Trou noir', drift: 'Dérive', invert: 'Inversion' };
  const PACE_LABELS = { calme: 'Calme', normal: 'Normal', chaos: 'Chaos' };
  const LEVEL_LABELS = { facile: 'Facile', normal: 'Normal', difficile: 'Difficile' };

  function seg(options, value, onPick) {
    const el = document.createElement('div');
    el.className = 'seg';
    for (const [k, lbl] of Object.entries(options)) {
      const b = document.createElement('button');
      b.type = 'button'; b.textContent = lbl;
      if (String(k) === String(value)) b.classList.add('on');
      b.addEventListener('click', () => onPick(k));
      el.appendChild(b);
    }
    return el;
  }
  function row(labelText, control) {
    const r = document.createElement('div');
    r.className = 'set-row';
    const l = document.createElement('label'); l.textContent = labelText;
    r.append(l, control);
    return r;
  }

  /** opts: { editable, collisions, bots: {min,max}|null, onChange(settings) } */
  function renderSettings(el, settings, opts) {
    const s = sanitizeSettings(settings);
    el.innerHTML = '';
    el.classList.toggle('readonly', !opts.editable);
    const change = (mut) => { mut(s); opts.onChange(sanitizeSettings(s)); };
    el.appendChild(row('Rythme', seg(PACE_LABELS, s.pace, (k) => change((x) => { x.pace = k; }))));
    if (opts.collisions) {
      el.appendChild(row('Collisions entre joueurs', seg({ true: 'Oui', false: 'Non' }, s.collisions,
        (k) => change((x) => { x.collisions = k === 'true'; }))));
    }
    if (opts.bots) {
      const st = document.createElement('div');
      st.className = 'stepper';
      const minus = document.createElement('button'); minus.type = 'button'; minus.textContent = '−';
      const out = document.createElement('output'); out.textContent = s.bots;
      const plus = document.createElement('button'); plus.type = 'button'; plus.textContent = '+';
      minus.addEventListener('click', () => change((x) => { x.bots = Math.max(opts.bots.min, x.bots - 1); }));
      plus.addEventListener('click', () => change((x) => { x.bots = Math.min(opts.bots.max, x.bots + 1); }));
      st.append(minus, out, plus);
      el.appendChild(row('Bots', st));
      if (s.bots > 0 || opts.bots.min > 0) {
        el.appendChild(row('Niveau des bots', seg(LEVEL_LABELS, s.botLevel, (k) => change((x) => { x.botLevel = k; }))));
      }
    }
    const chips = document.createElement('div');
    chips.className = 'chips';
    for (const e of Engine.EVENTS) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'chip' + (s.events[e] ? ' on' : '');
      b.textContent = EVENT_LABELS[e];
      b.addEventListener('click', () => change((x) => { x.events[e] = !x.events[e]; }));
      chips.appendChild(b);
    }
    const evRow = document.createElement('div');
    const l = document.createElement('label'); l.textContent = 'Événements'; l.className = 'muted';
    l.style.display = 'block'; l.style.marginBottom = '6px';
    evRow.append(l, chips);
    el.appendChild(evRow);
  }

  // ---------- écrans ----------
  const screens = ['menu', 'lobby', 'results'];
  function show(name) {
    for (const s of screens) $(s).classList.toggle('hidden', s !== name);
    $('hud').classList.toggle('hidden', name !== 'game');
    if (name !== 'game') { $('center-msg').classList.add('hidden'); unlock(); }
  }

  // ---------- canvas, rendu, entrées ----------
  const cv = $('cv');
  const renderer = Renderer.create(cv);
  window.addEventListener('resize', () => renderer.resize());

  const input = { locked: false, abs: store.get('abs', false), sens: store.get('sens', 1), ax: 0, ay: 0, mx: innerWidth / 2, my: innerHeight / 2, lockFailed: false };
  $('abs-mode').checked = input.abs;
  $('abs-mode').addEventListener('change', (e) => { input.abs = e.target.checked; store.set('abs', input.abs); });
  $('sens').value = input.sens; $('sens-out').textContent = Number(input.sens).toFixed(2);
  $('sens').addEventListener('input', (e) => {
    input.sens = Number(e.target.value); store.set('sens', input.sens);
    $('sens-out').textContent = input.sens.toFixed(2);
  });

  function useAbs() { return input.abs || input.lockFailed; }
  // Capture de la souris (Pointer Lock). On tente d'abord le mouvement brut (sans accélération de l'OS),
  // puis le mode normal. Un échec hors clic (pas de geste utilisateur) n'est pas grave : on redemandera
  // au prochain clic. Deux échecs sur clic = le navigateur refuse : on passe en mode curseur libre.
  let lockTry = null, clickFails = 0;
  function requestLock(fromClick) {
    if (useAbs() || input.locked || lockTry) return;
    lockTry = { stage: 1, fromClick: !!fromClick };
    let r;
    try { r = cv.requestPointerLock({ unadjustedMovement: true }); } catch (e) { return plainLock(); }
    if (r && r.then) { lockTry.promise = true; r.then(lockOk, plainLock); }
  }
  function plainLock() {
    if (!lockTry) return;
    lockTry.stage = 2;
    let r;
    try { r = cv.requestPointerLock(); } catch (e) { return lockError(); }
    if (r && r.then) { lockTry.promise = true; r.then(lockOk, lockError); }
  }
  function lockOk() { lockTry = null; clickFails = 0; }
  function lockError() {
    const t = lockTry;
    lockTry = null;
    if (!t || !t.fromClick) return;
    // Chrome refuse une recapture juste après Échap : ce n'est pas un vrai échec
    if (performance.now() - (input.unlockedAt || 0) < 2000) return;
    if (++clickFails >= 2) {
      input.lockFailed = true;
      toast('Ce navigateur refuse de capturer la souris : passage en mode curseur libre', 'info');
    }
  }
  // navigateurs sans promesse : seul l'événement signale le résultat
  document.addEventListener('pointerlockerror', () => {
    if (!lockTry || lockTry.promise) return;
    if (lockTry.stage === 1) plainLock(); else lockError();
  });
  function unlock() { if (document.pointerLockElement) document.exitPointerLock(); }
  document.addEventListener('pointerlockchange', () => {
    input.locked = document.pointerLockElement === cv;
    if (input.locked && lockTry && !lockTry.promise) lockOk();
    input.skipNext = input.locked;
    if (!input.locked) input.unlockedAt = performance.now();
    document.body.classList.toggle('locked', input.locked);
    input.ax = input.ay = 0;
  });
  document.addEventListener('mousemove', (e) => {
    if (input.locked) {
      // le premier événement après la capture et les pics aberrants (bug connu de Chrome) sont ignorés
      if (input.skipNext) { input.skipNext = false; return; }
      if (Math.abs(e.movementX) > 400 || Math.abs(e.movementY) > 400) return;
      input.ax += e.movementX; input.ay += e.movementY;
    }
    else { input.mx = e.clientX; input.my = e.clientY; }
  });
  cv.addEventListener('mousedown', () => { Sfx.ensure(); if (session && session.wantsLock()) requestLock(true); });
  $('center-msg').addEventListener('click', () => { Sfx.ensure(); if (session && session.wantsLock()) requestLock(true); });
  window.addEventListener('keydown', (e) => {
    if (e.target && e.target.tagName === 'INPUT') return;
    if (e.key === 'm' || e.key === 'M') { Sfx.muted = !Sfx.muted; store.set('muted', Sfx.muted); syncMute(); }
  });

  /**
   * Mouvement voulu ce frame, en unités du monde.
   * @param {{x:number,y:number}} pos position actuelle du pion
   * @param {object} v vue courante (pour l'inversion en mode curseur libre)
   */
  function takeInput(pos, v, dt) {
    if (useAbs()) {
      let tg = renderer.toWorld(input.mx, input.my);
      let dx = tg.x - pos.x, dy = tg.y - pos.y;
      if (v && v.iv && v.iv.st === 'active') {
        // inversé : la cible est le reflet de la souris par rapport au centre de la zone,
        // et on pré-inverse car le moteur inverse à son tour
        tg = { x: 2 * v.z.x - tg.x, y: 2 * v.z.y - tg.y };
        dx = -(tg.x - pos.x); dy = -(tg.y - pos.y);
      }
      const max = MAX_SPEED * Math.min(dt, 0.05);
      const l = Math.hypot(dx, dy);
      if (l > max) { dx *= max / l; dy *= max / l; }
      return { x: dx, y: dy };
    }
    if (!input.locked) { input.ax = input.ay = 0; return { x: 0, y: 0 }; }
    const k = input.sens / renderer.scale;
    const d = { x: input.ax * k, y: input.ay * k };
    input.ax = input.ay = 0;
    return d;
  }

  // ---------- session locale (solo / bots) ----------
  class LocalSession {
    constructor(params) {
      this.kind = 'local';
      this.params = params;
      const name = params.name || 'Toi';
      const roster = [{ id: 'me', name, color: COLORS[0] }];
      for (let i = 0; i < params.bots; i++) {
        roster.push({ id: 'bot' + i, name: BOT_NAMES[i % BOT_NAMES.length], color: COLORS[(i + 1) % COLORS.length], bot: params.settings.botLevel });
      }
      this.meta = {};
      for (const r of roster) this.meta[r.id] = { name: r.name, color: r.color, bot: !!r.bot };
      this.game = new Game(roster, params.settings, (Math.random() * 2 ** 32) >>> 0);
      this.meId = 'me';
      this.acc = 0;
      this.paused = false;
      this.v = this.game.view();
    }
    wantsLock() { return !useAbs() && this.game.phase !== 'over' && this.me().alive; }
    me() { return this.game.getPlayer('me'); }
    frame(dt) {
      // en mode capture, le jeu solo se met en pause quand la souris est libérée
      this.paused = !useAbs() && !input.locked && this.game.phase !== 'over' && this.me().alive;
      if (this.paused) { input.ax = input.ay = 0; return; }
      const me = this.me();
      const d = takeInput(me, this.v, dt);
      this.game.applyInput('me', d.x, d.y);
      this.acc += Math.min(dt, 0.1);
      const STEP = 1 / 60;
      while (this.acc >= STEP) { this.game.step(STEP); this.acc -= STEP; }
      this.v = this.game.view();
    }
    state() {
      return { v: this.v, t: this.game.t, meta: this.meta, meId: 'me', collisions: this.game.s.collisions };
    }
  }
  const BOT_NAMES = ['Bip', 'Rouage', 'Pixel', 'Tic-Tac', 'Boulon', 'Volt', 'Écrou', 'Diode', 'Ressort', 'Turbo', 'Puce'];

  // ---------- session en ligne ----------
  class NetSession {
    constructor(net, start) {
      this.kind = 'net';
      this.net = net;
      this.meId = net.id;
      this.meta = {};
      for (const m of start.meta) this.meta[m.id] = { name: m.name, color: m.color, bot: !!m.bot };
      this.spectator = !this.meta[this.meId];
      this.settings = start.settings;
      this.snaps = [];
      this.pending = [];
      this.seq = 0;
      this.pred = null;
      this.corr = { x: 0, y: 0 };
      this.v = null;
    }
    latest() { return this.snaps.length ? this.snaps[this.snaps.length - 1] : null; }
    meAlive() {
      const L = this.latest();
      if (!L || this.spectator) return false;
      const me = L.v.p.find((p) => p.id === this.meId);
      return !!(me && me.a);
    }
    wantsLock() { const L = this.latest(); return !useAbs() && L && L.v.ph !== 'over' && this.meAlive(); }
    onSnap(v, ack) {
      const recv = performance.now();
      this.snaps.push({ v, recv });
      if (this.snaps.length > 30) this.snaps.shift();
      if (this.spectator) return;
      const me = v.p.find((p) => p.id === this.meId);
      if (!me) return;
      const oldDisplay = this.pred ? { x: this.pred.x + this.corr.x, y: this.pred.y + this.corr.y } : null;
      this.pending = this.pending.filter((p) => p.s > ack);
      let x = me.x, y = me.y;
      for (const p of this.pending) { x += p.x; y += p.y; }
      this.pred = { x, y };
      if (oldDisplay && me.a) {
        const ex = oldDisplay.x - x, ey = oldDisplay.y - y;
        if (Math.hypot(ex, ey) > 140) this.corr = { x: 0, y: 0 };
        else this.corr = { x: ex, y: ey };
      } else this.corr = { x: 0, y: 0 };
    }
    serverTime() {
      const L = this.latest();
      if (!L) return 0;
      return L.v.t + Math.min(0.25, (performance.now() - L.recv) / 1000);
    }
    frame(dt) {
      const L = this.latest();
      const decay = Math.exp(-14 * dt);
      this.corr.x *= decay; this.corr.y *= decay;
      if (!L || !this.pred || L.v.ph !== 'playing' || !this.meAlive()) { input.ax = input.ay = 0; return; }
      const disp = { x: this.pred.x + this.corr.x, y: this.pred.y + this.corr.y };
      const d = takeInput(disp, L.v, dt);
      const max = MAX_SPEED * Math.min(dt, 0.05) * 1.05;
      const l = Math.hypot(d.x, d.y);
      if (l > max) { d.x *= max / l; d.y *= max / l; }
      if (d.x === 0 && d.y === 0) return;
      this.seq++;
      this.net.send({ t: 'in', s: this.seq, dx: Math.round(d.x * 100) / 100, dy: Math.round(d.y * 100) / 100 });
      const inv = L.v.iv && L.v.iv.st === 'active' && this.serverTime() < L.v.iv.te;
      const ax = inv ? -d.x : d.x, ay = inv ? -d.y : d.y;
      this.pending.push({ s: this.seq, x: ax, y: ay });
      this.pred.x += ax; this.pred.y += ay;
    }
    state() {
      const L = this.latest();
      if (!L) return { v: null, t: 0, meta: this.meta, meId: this.meId };
      // les autres joueurs sont interpolés ~100 ms dans le passé, le mien est prédit
      const rt = performance.now() - 100;
      let a = null, b = null;
      for (let i = this.snaps.length - 1; i >= 1; i--) {
        if (this.snaps[i - 1].recv <= rt) { a = this.snaps[i - 1]; b = this.snaps[i]; break; }
      }
      const v = Object.assign({}, L.v);
      const byId = {};
      if (a && b) {
        const u = clamp((rt - a.recv) / Math.max(1, b.recv - a.recv), 0, 1);
        for (const p of b.v.p) byId[p.id] = p;
        const pa = {};
        for (const p of a.v.p) pa[p.id] = p;
        v.p = L.v.p.map((p) => {
          const p0 = pa[p.id], p1 = byId[p.id];
          if (!p0 || !p1 || !p.a) return p;
          return Object.assign({}, p, { x: p0.x + (p1.x - p0.x) * u, y: p0.y + (p1.y - p0.y) * u });
        });
      }
      if (this.pred && !this.spectator) {
        v.p = v.p.map((p) => (p.id === this.meId && p.a
          ? Object.assign({}, p, { x: this.pred.x + this.corr.x, y: this.pred.y + this.corr.y }) : p));
      }
      return { v, t: this.serverTime(), meta: this.meta, meId: this.meId, collisions: this.settings.collisions };
    }
  }

  // ---------- connexion au serveur ----------
  function defaultServerUrl() {
    if (location.protocol === 'http:' || location.protocol === 'https:') {
      return (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';
    }
    return '';
  }
  $('server-url').value = store.get('server', '') || defaultServerUrl();
  $('server-url').addEventListener('change', (e) => store.set('server', e.target.value.trim()));

  const net = {
    ws: null, id: null, room: null, onOpen: null,
    connect(then) {
      const url = $('server-url').value.trim();
      if (!url) { $('online-error').textContent = 'Indique l\'adresse du serveur (onglet « Serveur »).'; return; }
      if (this.ws && this.ws.readyState === 1) { then(); return; }
      $('online-error').textContent = 'Connexion…';
      let ws;
      try { ws = new WebSocket(url); } catch (e) { $('online-error').textContent = 'Adresse de serveur invalide.'; return; }
      this.ws = ws;
      ws.onopen = () => { $('online-error').textContent = ''; then(); };
      ws.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch (_) { return; } onNet(m); };
      ws.onclose = () => {
        const was = this.room;
        this.ws = null; this.room = null; this.id = null;
        if (session && session.kind === 'net') { session = null; }
        if (was) { show('menu'); selectTab('online'); }
        $('online-error').textContent = was ? 'Connexion au serveur perdue.' : 'Serveur injoignable à cette adresse.';
      };
    },
    send(m) { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(m)); },
    leave() { if (this.ws) { this.room = null; this.ws.close(); } },
  };

  function onNet(m) {
    switch (m.t) {
      case 'welcome': net.id = m.id; break;
      case 'error':
        if (!$('lobby').classList.contains('hidden')) $('lobby-error').textContent = m.msg;
        else $('online-error').textContent = m.msg;
        break;
      case 'room':
        net.room = m;
        if (m.state === 'lobby') { session = null; show('lobby'); }
        renderLobby();
        break;
      case 'start':
        session = new NetSession(net, m);
        newRound();
        show('game');
        if (!useAbs() && !session.spectator) requestLock();
        break;
      case 's':
        if (session && session.kind === 'net') session.onSnap(m.v, m.a || 0);
        break;
    }
  }

  // ---------- salon ----------
  function isHost() { return net.room && net.room.host === net.id; }
  function renderLobby() {
    const r = net.room;
    if (!r) return;
    $('room-code').textContent = r.code;
    $('lobby-error').textContent = '';
    const ul = $('player-list');
    ul.innerHTML = '';
    for (const p of r.players) {
      const li = document.createElement('li');
      const dot = document.createElement('span'); dot.className = 'dot'; dot.style.background = p.color; dot.style.color = p.color;
      const n = document.createElement('span'); n.textContent = p.name + (p.id === net.id ? ' (toi)' : '');
      const tag = document.createElement('span'); tag.className = 'tag';
      tag.textContent = p.id === r.host ? 'hôte' : p.bot ? 'bot ' + p.bot : '';
      li.append(dot, n, tag);
      ul.appendChild(li);
    }
    const humans = r.players.filter((p) => !p.bot).length;
    renderSettings($('settings-online'), r.settings, {
      editable: isHost(), collisions: true, bots: { min: 0, max: Math.max(0, 12 - humans) },
      onChange: (s) => net.send({ t: 'settings', settings: s }),
    });
    $('host-note').textContent = isHost() ? '' : '(choisis par l\'hôte)';
    $('start-room').classList.toggle('hidden', !isHost());
    $('start-room').disabled = r.players.length < 2;
    $('start-room').title = r.players.length < 2 ? 'Il faut au moins 2 joueurs (ou ajoute un bot)' : '';
  }
  $('start-room').addEventListener('click', () => { Sfx.ensure(); net.send({ t: 'start' }); });
  $('leave-room').addEventListener('click', () => { net.leave(); show('menu'); });
  $('copy-link').addEventListener('click', async () => {
    const url = location.origin + location.pathname + '?room=' + (net.room ? net.room.code : '');
    try { await navigator.clipboard.writeText(url); $('copy-link').textContent = 'Lien copié !'; }
    catch (e) { $('copy-link').textContent = url; }
    setTimeout(() => { $('copy-link').textContent = 'Copier le lien'; }, 2000);
  });

  // ---------- menu ----------
  function playerName() {
    const n = $('name').value.trim().slice(0, 16);
    return n || 'Joueur';
  }
  $('name').value = store.get('name', '');
  $('name').addEventListener('change', () => store.set('name', $('name').value.trim()));

  function selectTab(name) {
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
    document.querySelectorAll('.tab-body').forEach((b) => b.classList.toggle('hidden', b.dataset.body !== name));
  }
  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => selectTab(t.dataset.tab)));

  let soloSettings = sanitizeSettings(store.get('solo', defaultSettings()));
  let botSettings = sanitizeSettings(store.get('botset', Object.assign(defaultSettings(), { bots: 3 })));
  if (botSettings.bots < 1) botSettings.bots = 3;
  function drawMenuSettings() {
    renderSettings($('settings-solo'), soloSettings, { editable: true, collisions: false, bots: null,
      onChange: (s) => { soloSettings = s; store.set('solo', s); drawMenuSettings(); } });
    renderSettings($('settings-bots'), botSettings, { editable: true, collisions: true, bots: { min: 1, max: 11 },
      onChange: (s) => { botSettings = s; store.set('botset', s); drawMenuSettings(); } });
    const best = store.get('best', 0);
    $('best').textContent = best ? 'Record : ' + fmt(best) : '';
  }
  drawMenuSettings();

  function startLocal(params) {
    Sfx.ensure();
    session = new LocalSession(params);
    newRound();
    show('game');
    requestLock(true);
  }
  $('play-solo').addEventListener('click', () => {
    store.set('name', $('name').value.trim());
    startLocal({ name: playerName(), bots: 0, settings: Object.assign({}, soloSettings, { bots: 0 }) });
  });
  $('play-bots').addEventListener('click', () => {
    store.set('name', $('name').value.trim());
    startLocal({ name: playerName(), bots: botSettings.bots, settings: botSettings });
  });
  $('create-room').addEventListener('click', () => {
    store.set('name', $('name').value.trim());
    net.connect(() => net.send({ t: 'create', name: playerName() }));
  });
  $('join-room').addEventListener('click', () => {
    store.set('name', $('name').value.trim());
    const code = $('join-code').value.trim().toUpperCase();
    if (code.length !== 4) { $('online-error').textContent = 'Le code fait 4 lettres.'; return; }
    net.connect(() => net.send({ t: 'join', name: playerName(), code }));
  });
  $('join-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('join-room').click(); });
  const qRoom = new URLSearchParams(location.search).get('room');
  if (qRoom) { selectTab('online'); $('join-code').value = qRoom.toUpperCase().slice(0, 4); }

  // ---------- résultats ----------
  function showResults(res) {
    const meId = session.meId;
    const mine = res.ranking.find((r) => r.id === meId);
    const list = $('res-list');
    list.innerHTML = '';
    const solo = res.ranking.length === 1;
    if (solo) {
      const best = store.get('best', 0);
      const isRecord = res.duration > best;
      if (isRecord) store.set('best', res.duration);
      $('res-title').textContent = 'Tenu ' + fmt(res.duration);
      $('res-sub').textContent = isRecord ? 'Nouveau record !' : 'Record : ' + fmt(best);
    } else {
      const won = mine && mine.place === 1 && res.winner === meId;
      const winner = res.ranking.find((r) => r.id === res.winner);
      $('res-title').textContent = won ? 'Victoire !' : winner ? winner.name + ' gagne' : 'Égalité';
      $('res-sub').textContent = mine ? (won ? 'Dernier dans le cercle après ' + fmt(res.duration)
        : 'Tu termines ' + ordinal(mine.place) + ' sur ' + res.ranking.length) : 'Manche de ' + fmt(res.duration);
      if (won) Sfx.win();
      for (const r of res.ranking) {
        const li = document.createElement('li');
        if (r.id === meId) li.classList.add('me');
        const pl = document.createElement('span'); pl.className = 'place'; pl.textContent = r.place;
        const dot = document.createElement('span'); dot.className = 'dot'; dot.style.background = r.color; dot.style.color = r.color;
        const n = document.createElement('span'); n.textContent = r.name + (r.bot ? ' · bot' : '') + (r.id === meId ? ' (toi)' : '');
        const tm = document.createElement('span'); tm.className = 'time'; tm.textContent = fmt(r.time);
        li.append(pl, dot, n, tm);
        list.appendChild(li);
      }
    }
    const again = $('res-again'), menu = $('res-menu');
    if (session.kind === 'local') {
      again.classList.remove('hidden'); again.textContent = 'Rejouer';
      menu.textContent = 'Menu';
    } else {
      again.classList.toggle('hidden', !isHost());
      again.textContent = 'Rejouer';
      menu.textContent = isHost() ? 'Retour au salon' : 'Quitter';
      $('res-sub').textContent += isHost() ? '' : ' · en attente de l\'hôte';
    }
    show('results');
  }
  $('res-again').addEventListener('click', () => {
    if (!session) return;
    if (session.kind === 'local') startLocal(session.params);
    else net.send({ t: 'start' });
  });
  $('res-menu').addEventListener('click', () => {
    if (session && session.kind === 'net') {
      if (isHost()) net.send({ t: 'lobby' });
      else { net.leave(); session = null; show('menu'); }
      return;
    }
    session = null;
    drawMenuSettings();
    show('menu');
  });

  // ---------- HUD, annonces, sons ----------
  function fmt(s) {
    s = Math.max(0, s);
    const m = Math.floor(s / 60), r = Math.floor(s % 60);
    return m + ':' + String(r).padStart(2, '0');
  }
  function ordinal(n) { return n === 1 ? '1er' : n + 'e'; }
  function toast(text, kind) {
    const el = document.createElement('div');
    el.className = 'toast ' + (kind || '');
    el.textContent = text;
    $('toasts').appendChild(el);
    setTimeout(() => el.remove(), 3700);
    while ($('toasts').children.length > 3) $('toasts').firstChild.remove();
  }

  let round = null;
  function newRound() {
    round = { seenAnn: new Set(), lastCount: null, bombs: new Set(), ex: new Set(), prev: {}, myHit: null,
      shake: 0, resultsShown: false, overAt: null, deadToast: false, hudAt: 0 };
    $('toasts').innerHTML = '';
  }

  const EV_INFO = [
    { key: 'nz', label: 'Rétrécissement', color: '#eceefe', ic: '◎' },
    { key: 'w', label: 'Vent', color: '#8ecae6', ic: '➜' },
    { key: 'h', label: 'Trou noir', color: '#b388ff', ic: '◉' },
    { key: 'iv', label: 'Inversion', color: '#f15bb5', ic: '⇄' },
  ];

  function updateHud(st) {
    const v = st.v;
    if (!v) return;
    const nowMs = performance.now();
    // sons et annonces
    for (const a of v.an) {
      if (round.seenAnn.has(a.id)) continue;
      round.seenAnn.add(a.id);
      toast(a.text, a.kind);
      if (a.kind === 'elim') Sfx.elim();
      if (a.kind === 'invert' && /dans/.test(a.text)) Sfx.invert();
    }
    if (v.t < 0) {
      const c = Math.ceil(-v.t);
      if (c !== round.lastCount) { round.lastCount = c; Sfx.count(); }
    } else if (round.lastCount !== 0) { round.lastCount = 0; Sfx.go(); }
    for (const b of v.b) if (!round.bombs.has(b.id)) { round.bombs.add(b.id); Sfx.bomb(); }
    const meP = v.p.find((p) => p.id === st.meId);
    for (const e of v.ex) {
      const k = e.x + ':' + e.y + ':' + e.t;
      if (round.ex.has(k)) continue;
      round.ex.add(k);
      const near = meP && Math.hypot(meP.x - e.x, meP.y - e.y) < e.r + 40;
      Sfx.boom(near);
    }
    const pv = round.prev;
    if (v.w && v.w.st === 'warn' && (!pv.w || pv.w.st !== 'warn')) Sfx.warn();
    if (v.w && v.w.st === 'active' && (!pv.w || pv.w.st !== 'active')) Sfx.wind();
    if (v.h && v.h.st === 'warn' && !pv.h) Sfx.warn();
    if (v.h && v.h.st === 'active' && (!pv.h || pv.h.st !== 'active')) Sfx.hole();
    if (v.nz && v.nz.st === 'warn' && !pv.nz) Sfx.warn();
    round.prev = { w: v.w, h: v.h, nz: v.nz, iv: v.iv };
    if (meP && meP.ht != null && meP.ht !== round.myHit) {
      if (round.myHit !== null || v.t - meP.ht < 0.3) round.shake = 1;
      round.myHit = meP.ht;
    }
    round.shake = Math.max(0, round.shake - 0.06);

    // message central
    const cm = $('center-msg');
    const meAlive = !!(meP && meP.a);
    cm.className = '';
    if (v.ph === 'countdown') {
      cm.classList.add('big'); cm.textContent = Math.ceil(-v.t);
    } else if (session.wantsLock() && !input.locked && v.ph === 'playing') {
      cm.classList.add('click');
      cm.innerHTML = (session.kind === 'local' ? 'Pause' : 'Souris libérée') +
        '<span class="sub">Clique pour capturer ta souris et jouer</span>';
    } else {
      cm.classList.add('hidden');
    }
    if (v.ph === 'countdown' && session.wantsLock() && !input.locked) {
      cm.className = 'click';
      cm.innerHTML = Math.ceil(-v.t) + '<span class="sub">Clique pour capturer ta souris</span>';
    }
    if (!meAlive && v.ph === 'playing' && v.p.length > 1 && !round.deadToast && !(session.spectator)) {
      round.deadToast = true;
      toast('Éliminé ! Tu regardes la fin de la manche', 'elim');
      unlock();
    }

    // HUD (DOM) rafraîchi 10 fois par seconde
    if (nowMs - round.hudAt > 100) {
      round.hudAt = nowMs;
      $('hud-time').textContent = fmt(v.t);
      const alive = v.p.filter((p) => p.a).length;
      $('hud-alive').textContent = v.p.length > 1 ? alive + ' / ' + v.p.length + ' en jeu' : (meAlive ? 'En vie' : 'Éliminé');
      $('hud-alive').classList.toggle('hidden', false);
      const box = $('hud-events');
      const parts = [];
      for (const e of EV_INFO) {
        const x = v[e.key];
        if (!x) continue;
        const warn = x.st === 'warn';
        let lbl = e.label, cd = '';
        let col = e.color;
        if (e.key === 'h') { lbl = x.k === 'pull' ? 'Trou noir' : 'Répulseur'; if (x.k !== 'pull') col = '#ff9e3d'; }
        if (warn) cd = 'dans ' + Math.max(0, x.ts - st.t).toFixed(1) + ' s';
        else if (x.te) cd = Math.max(0, x.te - st.t).toFixed(1) + ' s';
        const rot = e.key === 'w' ? ' style="transform:rotate(' + x.a + 'rad)"' : '';
        parts.push('<div class="ev' + (warn ? ' warn' : '') + '"><span class="ic" style="background:' + col + '"><span' + rot + '>' + e.ic +
          '</span></span>' + lbl + ' <span class="cd">' + cd + '</span></div>');
      }
      if (v.b.length) parts.push('<div class="ev warn"><span class="ic" style="background:#ff4d6d">' + v.b.length + '</span>Bombe' + (v.b.length > 1 ? 's' : '') + '</div>');
      box.innerHTML = parts.join('');
    }

    // fin de manche
    if (v.ph === 'over' && v.res && !round.resultsShown) {
      if (round.overAt == null) round.overAt = nowMs;
      unlock();
      if (nowMs - round.overAt > 1400) { round.resultsShown = true; showResults(v.res); }
    }
  }

  // ---------- boucle ----------
  let session = null;
  let last = performance.now();
  // écran d'accueil : une partie de bots tourne en fond
  const demo = new LocalSession({ name: 'Démo', bots: 5, settings: Object.assign(defaultSettings(), { bots: 5, botLevel: 'difficile', pace: 'chaos' }) });
  demo.meId = null;
  demo.game.players.shift();
  demo.game.players.forEach((p, i) => { p.idx = i; });

  function loop(now) {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    const inGame = !$('hud').classList.contains('hidden') || !$('results').classList.contains('hidden');
    if (session && inGame) {
      session.frame(dt);
      const st = session.state();
      if (!$('hud').classList.contains('hidden')) updateHud(st);
      const sh = round ? round.shake : 0;
      st.shake = sh > 0 ? { x: (Math.random() - 0.5) * 18 * sh, y: (Math.random() - 0.5) * 18 * sh } : null;
      renderer.draw(st);
    } else {
      demo.acc += dt;
      while (demo.acc >= 1 / 60) { demo.game.step(1 / 60); demo.acc -= 1 / 60; }
      if (demo.game.phase === 'over' && demo.game.t - demo.game.results.duration > 2) {
        const g = new Game(demo.game.players.map((p, i) => ({ id: p.id, name: p.name, color: p.color, bot: 'difficile' })),
          demo.game.s, (Math.random() * 2 ** 32) >>> 0);
        demo.game = g;
      }
      renderer.draw({ v: demo.game.view(), t: demo.game.t, meta: demo.meta, meId: null, collisions: true });
    }
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
  show('menu');
  // accès console pour bidouiller : cercle.session().game, etc.
  window.cercle = { session: () => session, demo };
})();
