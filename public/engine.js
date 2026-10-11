/*
 * Cercle Vicieux — moteur de jeu partagé.
 * Le même fichier tourne dans le navigateur (mode solo) et dans Node (serveur en ligne).
 * Unités : le monde est centré en (0,0), l'arène fait R0 de rayon.
 * Temps : g.t en secondes, négatif pendant le compte à rebours.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Engine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const R0 = 450;            // rayon de l'arène et de la zone de départ
  const PR = 12;             // rayon d'un joueur
  const MIN_R = 80;          // rayon minimal de la zone
  const MAX_SPEED = 760;     // vitesse max que la souris peut donner (unités/s)
  const FRICTION = 4.2;      // amortissement des poussées (1/s)
  const COUNTDOWN = 3;
  const TAU = Math.PI * 2;

  const COLORS = ['#4cc9f0', '#f72585', '#b5e48c', '#ffb703', '#9d4edd', '#ff6b35',
                  '#2ec4b6', '#f15bb5', '#e9ff70', '#ff8fa3', '#70d6ff', '#c77dff'];

  const PACE = { calme: 1.35, normal: 1, chaos: 0.65 };
  const EVENTS = ['shrink', 'bombs', 'wind', 'hole', 'drift', 'invert'];
  const BOT_LEVELS = {
    facile:    { react: 0.45, speed: 0.62, comp: 0.35, invDelay: 0.8, jitter: 32, bombSense: 0.55 },
    normal:    { react: 0.24, speed: 0.82, comp: 0.75, invDelay: 0.4, jitter: 14, bombSense: 0.85 },
    difficile: { react: 0.09, speed: 0.97, comp: 1.0,  invDelay: 0.15, jitter: 4, bombSense: 1 },
  };

  function defaultSettings() {
    return {
      collisions: true,
      pace: 'normal',
      events: { shrink: true, bombs: true, wind: true, hole: true, drift: true, invert: true },
      bots: 0,
      botLevel: 'normal',
    };
  }

  function sanitizeSettings(s) {
    const d = defaultSettings();
    if (!s || typeof s !== 'object') return d;
    const out = {
      collisions: typeof s.collisions === 'boolean' ? s.collisions : d.collisions,
      pace: PACE[s.pace] ? s.pace : d.pace,
      events: {},
      bots: Math.max(0, Math.min(11, Math.floor(Number(s.bots) || 0))),
      botLevel: BOT_LEVELS[s.botLevel] ? s.botLevel : d.botLevel,
    };
    for (const e of EVENTS) {
      out.events[e] = s.events && typeof s.events[e] === 'boolean' ? s.events[e] : d.events[e];
    }
    return out;
  }

  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, u) => a + (b - a) * u;
  const easeInOut = (u) => (u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2);
  const r1 = (v) => Math.round(v * 10) / 10;
  const r2 = (v) => Math.round(v * 100) / 100;

  class Game {
    /**
     * @param {Array<{id:string,name:string,color:string,bot?:string|null}>} roster
     * @param {object} settings
     * @param {number} seed
     */
    constructor(roster, settings, seed) {
      this.s = sanitizeSettings(settings);
      this.P = PACE[this.s.pace];
      this.rng = mulberry32(seed || (Math.random() * 2 ** 32));
      this.t = -COUNTDOWN;
      this.phase = 'countdown';
      this.ann = [];
      this.annId = 0;
      this.introduced = {};
      this.results = null;
      this.pairCd = new Map();

      const P = this.P;
      this.zone = { x: 0, y: 0, r: R0, ox: 0, oy: 0 };
      this.shrink = { state: 'idle', next: 5 * P, from: null, to: null, tStart: 0, tEnd: 0 };
      this.bombs = [];
      this.bombId = 0;
      this.nextBomb = 14 * P;
      this.explosions = [];
      this.wind = { state: 'idle', next: 28 * P, angle: 0, str: 0, tStart: 0, tEnd: 0, fx: 0, fy: 0 };
      this.hole = { state: 'idle', next: 42 * P, x: 0, y: 0, R: 0, str: 0, kind: 'pull', tStart: 0, tEnd: 0 };
      this.drift = { active: false, start: 55 * P, vx: 0, vy: 0, tvx: 0, tvy: 0, nextTurn: 0 };
      this.inv = { state: 'idle', next: 63 * P, tStart: 0, tEnd: 0 };

      const a0 = this.rng() * TAU;
      const n = roster.length;
      this.players = roster.map((m, i) => {
        const a = a0 + (i / Math.max(1, n)) * TAU;
        const rad = n === 1 ? 0 : R0 * 0.42;
        return {
          id: m.id, name: m.name, color: m.color, idx: i,
          x: Math.cos(a) * rad, y: Math.sin(a) * rad,
          vx: 0, vy: 0, cdx: 0, cdy: 0, mvx: 0, mvy: 0,
          budget: 0, alive: true, deathT: null, place: null,
          bot: m.bot && BOT_LEVELS[m.bot]
            ? { cfg: BOT_LEVELS[m.bot], timer: 0, tx: 0, ty: 0, phase: Math.random() * TAU }
            : null,
        };
      });
      for (const p of this.players) if (p.bot) { p.bot.tx = p.x; p.bot.ty = p.y; }
    }

    // ---------- utilitaires ----------
    zoneCenter() { return { x: this.zone.x + this.zone.ox, y: this.zone.y + this.zone.oy }; }
    rand(a, b) { return a + (b - a) * this.rng(); }
    k() { return clamp(this.t / 130, 0, 1); } // montée en intensité sur ~2 min
    say(text, kind) {
      this.ann.push({ id: ++this.annId, t: r2(this.t), text, kind: kind || 'info' });
      if (this.ann.length > 8) this.ann.shift();
    }
    intro(key, text, kind) {
      if (this.introduced[key]) return;
      this.introduced[key] = true;
      this.say(text, kind);
    }
    getPlayer(id) { return this.players.find((p) => p.id === id); }
    randomPointInZone(margin) {
      const c = this.zoneCenter();
      const a = this.rng() * TAU;
      const d = Math.sqrt(this.rng()) * Math.max(0, this.zone.r - margin);
      return { x: c.x + Math.cos(a) * d, y: c.y + Math.sin(a) * d };
    }

    /**
     * Mouvement venant de la souris (ou d'un bot), en unités du monde.
     * Plafonné par un « budget » de vitesse, et inversé si l'événement d'inversion est actif.
     */
    applyInput(id, dx, dy) {
      const p = typeof id === 'object' ? id : this.getPlayer(id);
      if (!p || !p.alive || this.phase !== 'playing') return;
      if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
      const len = Math.hypot(dx, dy);
      if (len > p.budget) {
        const f = p.budget / len;
        dx *= f; dy *= f;
      }
      p.budget -= Math.min(len, p.budget);
      if (this.inv.state === 'active') { dx = -dx; dy = -dy; }
      p.cdx += dx; p.cdy += dy;
    }

    // ---------- boucle ----------
    step(dt) {
      this.t += dt;
      const t = this.t;
      this.explosions = this.explosions.filter((e) => t - e.t < 0.8);
      if (this.phase === 'over') return;
      if (t < 0) {
        this.phase = 'countdown';
        for (const p of this.players) { p.cdx = p.cdy = 0; }
        return;
      }
      if (this.phase === 'countdown') {
        this.phase = 'playing';
        this.say('Partez ! Restez dans le cercle', 'go');
      }

      const ev = this.s.events;
      if (ev.shrink) this.updateShrink(t);
      if (ev.drift) this.updateDrift(t, dt);
      if (ev.bombs) this.updateBombs(t);
      if (ev.wind) this.updateWind(t);
      if (ev.hole) this.updateHole(t);
      if (ev.invert) this.updateInvert(t);

      for (const p of this.players) {
        if (p.alive && p.bot) this.botThink(p, dt);
      }
      this.movePlayers(dt);
      if (this.s.collisions) this.collide(t);
      this.checkEliminations(t);
      // le budget se recharge ici : il plafonne le mouvement de souris du prochain tick
      for (const p of this.players) p.budget = Math.min(p.budget + MAX_SPEED * dt, MAX_SPEED * 0.12);
    }

    updateShrink(t) {
      const S = this.shrink, z = this.zone;
      if (S.state === 'idle' && t >= S.next && z.r > MIN_R + 1) {
        const r2_ = Math.max(MIN_R, z.r * this.rand(0.79, 0.86));
        const maxOff = (z.r - r2_) * 0.85;
        const a = this.rng() * TAU, d = Math.sqrt(this.rng()) * maxOff;
        S.from = { x: z.x, y: z.y, r: z.r };
        S.to = { x: z.x + Math.cos(a) * d, y: z.y + Math.sin(a) * d, r: r2_ };
        S.state = 'warn';
        S.tStart = t + 3.5;
        S.tEnd = S.tStart + 2.5;
        this.intro('shrink', 'La zone va rétrécir : rejoins le cercle en pointillés !', 'shrink');
      }
      if (S.state === 'warn' && t >= S.tStart) S.state = 'shrinking';
      if (S.state === 'shrinking') {
        const u = clamp((t - S.tStart) / (S.tEnd - S.tStart), 0, 1);
        const e = easeInOut(u);
        z.x = lerp(S.from.x, S.to.x, e);
        z.y = lerp(S.from.y, S.to.y, e);
        z.r = lerp(S.from.r, S.to.r, e);
        if (u >= 1) {
          S.state = 'idle';
          S.next = t + (9.5 - 3 * this.k()) * this.P;
          if (z.r <= MIN_R + 1) this.say('Zone minimale atteinte !', 'shrink');
        }
      }
    }

    updateDrift(t, dt) {
      const D = this.drift, z = this.zone;
      if (!D.active) {
        if (t < D.start) return;
        D.active = true;
        D.nextTurn = t;
        this.say('La zone se met à dériver : suis la flèche !', 'drift');
      }
      if (t >= D.nextTurn) {
        // nouvelle destination pour le centre, en gardant la zone dans l'arène
        const lim = Math.max(0, R0 - z.r - 10);
        const a = this.rng() * TAU, d = Math.sqrt(this.rng()) * lim;
        const c = this.zoneCenter();
        const tx = Math.cos(a) * d - c.x, ty = Math.sin(a) * d - c.y;
        const len = Math.hypot(tx, ty) || 1;
        const sp = 24 + 26 * this.k();
        D.tvx = (tx / len) * sp; D.tvy = (ty / len) * sp;
        D.nextTurn = t + this.rand(4, 6.5);
      }
      const f = 1 - Math.exp(-1.6 * dt); // virage progressif : la flèche annonce la direction
      D.vx += (D.tvx - D.vx) * f;
      D.vy += (D.tvy - D.vy) * f;
      z.ox += D.vx * dt; z.oy += D.vy * dt;
      const c = this.zoneCenter();
      const dist = Math.hypot(c.x, c.y), lim = R0 - z.r;
      if (dist > lim && dist > 0) {
        const k = lim / dist;
        z.ox = c.x * k - z.x; z.oy = c.y * k - z.y;
      }
    }

    updateBombs(t) {
      if (t >= this.nextBomb) {
        const k = this.k();
        const count = 1 + (k > 0.35 ? 1 : 0) + (k > 0.75 ? 1 : 0);
        const alive = this.players.filter((p) => p.alive);
        const c = this.zoneCenter();
        for (let i = 0; i < count; i++) {
          let pos;
          if (alive.length && this.rng() < 0.55) {
            const tgt = alive[Math.floor(this.rng() * alive.length)];
            const a = this.rng() * TAU, d = this.rng() * 70;
            pos = { x: tgt.x + Math.cos(a) * d, y: tgt.y + Math.sin(a) * d };
          } else {
            pos = this.randomPointInZone(10);
          }
          const dd = Math.hypot(pos.x - c.x, pos.y - c.y);
          if (dd > this.zone.r) {
            pos.x = c.x + ((pos.x - c.x) / dd) * this.zone.r * 0.9;
            pos.y = c.y + ((pos.y - c.y) / dd) * this.zone.r * 0.9;
          }
          const warn = 1.75 - 0.45 * k;
          this.bombs.push({
            id: ++this.bombId, x: pos.x, y: pos.y,
            r: Math.min(this.rand(68, 112) + 28 * k, this.zone.r * 0.72),
            t0: t, t1: t + warn + i * 0.25,
            power: 1350 + 250 * k,
          });
        }
        this.intro('bombs', 'Bombes ! Sors des cercles rouges avant l\'explosion', 'bomb');
        this.nextBomb = t + (3.3 - 1.6 * k) * this.P * this.rand(0.8, 1.2);
      }
      const keep = [];
      for (const b of this.bombs) {
        if (t >= b.t1) this.explode(b, t);
        else keep.push(b);
      }
      this.bombs = keep;
    }

    explode(b, t) {
      this.explosions.push({ x: b.x, y: b.y, r: b.r, t });
      for (const p of this.players) {
        if (!p.alive) continue;
        let dx = p.x - b.x, dy = p.y - b.y;
        let d = Math.hypot(dx, dy);
        if (d > b.r + PR) continue;
        if (d < 0.001) { const a = this.rng() * TAU; dx = Math.cos(a); dy = Math.sin(a); d = 1; }
        const f = b.power * (0.45 + 0.55 * (1 - clamp(d / (b.r + PR), 0, 1)));
        p.vx += (dx / d) * f;
        p.vy += (dy / d) * f;
        p.hitT = t;
      }
    }

    updateWind(t) {
      const W = this.wind;
      if (W.state === 'idle' && t >= W.next) {
        W.state = 'warn';
        W.angle = this.rng() * TAU;
        W.str = 170 + 210 * this.k() + this.rand(0, 40);
        W.tStart = t + 2.5;
        W.tEnd = W.tStart + this.rand(4, 6.5);
        this.intro('wind', 'Le vent se lève ! Regarde la flèche et résiste', 'wind');
      }
      if (W.state === 'warn' && t >= W.tStart) W.state = 'active';
      if (W.state === 'active') {
        const ramp = Math.min(1, (t - W.tStart) / 0.6, (W.tEnd - t) / 0.6);
        const gust = 1 + 0.18 * Math.sin(t * 3.1) + 0.08 * Math.sin(t * 7.7);
        const f = W.str * clamp(ramp, 0, 1) * gust;
        W.fx = Math.cos(W.angle) * f; W.fy = Math.sin(W.angle) * f;
        if (t >= W.tEnd) {
          W.state = 'idle'; W.fx = W.fy = 0;
          W.next = t + this.rand(4.5, 8) * this.P;
        }
      }
    }

    updateHole(t) {
      const H = this.hole;
      if (H.state === 'idle' && t >= H.next) {
        const pos = this.randomPointInZone(this.zone.r * 0.4);
        H.x = pos.x; H.y = pos.y;
        H.kind = this.rng() < 0.6 ? 'pull' : 'push';
        H.R = 150 + 70 * this.k();
        H.str = 330 + 170 * this.k();
        H.state = 'warn';
        H.tStart = t + 2.6;
        H.tEnd = H.tStart + this.rand(4.5, 6);
        this.intro('hole_' + H.kind, H.kind === 'pull'
          ? 'Trou noir ! Il aspire tout ce qui passe près de lui'
          : 'Répulseur ! Il repousse tout autour de lui', 'hole');
      }
      if (H.state === 'warn' && t >= H.tStart) H.state = 'active';
      if (H.state === 'active' && t >= H.tEnd) {
        H.state = 'idle';
        H.next = t + this.rand(8, 13) * this.P;
      }
    }

    holeForce(p) {
      const H = this.hole;
      if (H.state !== 'active') return { x: 0, y: 0 };
      const dx = H.x - p.x, dy = H.y - p.y, d = Math.hypot(dx, dy);
      if (d > H.R || d < 1) return { x: 0, y: 0 };
      const ramp = Math.min(1, (this.t - H.tStart) / 0.5, (H.tEnd - this.t) / 0.5);
      const f = H.str * Math.pow(1 - d / H.R, 0.55) * clamp(ramp, 0, 1) * (H.kind === 'pull' ? 1 : -1.15);
      return { x: (dx / d) * f, y: (dy / d) * f };
    }

    updateInvert(t) {
      const I = this.inv;
      if (I.state === 'idle' && t >= I.next) {
        I.state = 'warn';
        I.tStart = t + 3;
        I.tEnd = I.tStart + 3.5;
        this.say('Contrôles inversés dans 3 secondes !', 'invert');
      }
      if (I.state === 'warn' && t >= I.tStart) I.state = 'active';
      if (I.state === 'active' && t >= I.tEnd) {
        I.state = 'idle';
        I.next = t + this.rand(12, 18) * this.P;
        this.say('Contrôles rétablis', 'invert');
      }
    }

    externalVel(p) {
      const h = this.holeForce(p);
      return { x: p.vx + this.wind.fx + h.x, y: p.vy + this.wind.fy + h.y };
    }

    movePlayers(dt) {
      const fr = Math.exp(-FRICTION * dt);
      for (const p of this.players) {
        if (!p.alive) { p.cdx = p.cdy = 0; continue; }
        const ext = this.externalVel(p);
        const mx = p.cdx + ext.x * dt, my = p.cdy + ext.y * dt;
        p.x += mx; p.y += my;
        p.mvx = mx / dt; p.mvy = my / dt;
        p.cdx = p.cdy = 0;
        p.vx *= fr; p.vy *= fr;
        if (Math.abs(p.vx) < 0.5) p.vx = 0;
        if (Math.abs(p.vy) < 0.5) p.vy = 0;
      }
    }

    collide(t) {
      const ps = this.players;
      for (let i = 0; i < ps.length; i++) {
        const a = ps[i];
        if (!a.alive) continue;
        for (let j = i + 1; j < ps.length; j++) {
          const b = ps[j];
          if (!b.alive) continue;
          let dx = b.x - a.x, dy = b.y - a.y;
          let d = Math.hypot(dx, dy);
          if (d >= PR * 2) continue;
          if (d < 0.001) { dx = 1; dy = 0; d = 1; }
          const nx = dx / d, ny = dy / d;
          const overlap = PR * 2 - d;
          a.x -= nx * overlap / 2; a.y -= ny * overlap / 2;
          b.x += nx * overlap / 2; b.y += ny * overlap / 2;
          // celui qui fonce dans l'autre l'envoie valser
          const key = a.idx * 64 + b.idx;
          if ((this.pairCd.get(key) || -1) > t) continue;
          const rel = (a.mvx - b.mvx) * nx + (a.mvy - b.mvy) * ny;
          if (rel > 60) {
            const j2 = Math.min(rel * 0.95, 1000);
            const aFast = (a.mvx * nx + a.mvy * ny) >= -(b.mvx * nx + b.mvy * ny);
            const toB = aFast ? 1 : 0.4, toA = aFast ? 0.4 : 1;
            b.vx += nx * j2 * toB; b.vy += ny * j2 * toB;
            a.vx -= nx * j2 * toA; a.vy -= ny * j2 * toA;
            this.pairCd.set(key, t + 0.2);
            a.bumpT = b.bumpT = t;
          }
        }
      }
    }

    checkEliminations(t) {
      const c = this.zoneCenter();
      const dying = [];
      for (const p of this.players) {
        if (!p.alive) continue;
        if (Math.hypot(p.x - c.x, p.y - c.y) > this.zone.r) dying.push(p);
      }
      if (dying.length) {
        const aliveBefore = this.players.filter((p) => p.alive).length;
        for (const p of dying) {
          p.alive = false; p.deathT = t;
          p.place = aliveBefore - dying.length + 1; // égalité si plusieurs sortent au même instant
          if (this.players.length > 1) this.say(p.name + ' est éliminé', 'elim');
        }
      }
      const alive = this.players.filter((p) => p.alive);
      const solo = this.players.length === 1;
      if ((solo && alive.length === 0) || (!solo && alive.length <= 1)) this.finish(t, alive);
    }

    /** Un joueur quitte en cours de partie : il est éliminé sur place. */
    forfeit(id) {
      const p = this.getPlayer(id);
      if (!p || !p.alive || this.phase === 'over') return;
      const aliveBefore = this.players.filter((q) => q.alive).length;
      p.alive = false; p.deathT = Math.max(0, this.t); p.place = aliveBefore;
      this.say(p.name + ' a quitté la partie', 'elim');
      const alive = this.players.filter((q) => q.alive);
      if (alive.length <= 1 && this.players.length > 1) this.finish(Math.max(0, this.t), alive);
    }

    finish(t, alive) {
      this.phase = 'over';
      for (const p of alive) p.place = 1;
      const ranking = this.players.slice().sort((a, b) => a.place - b.place || (b.deathT || 0) - (a.deathT || 0));
      this.results = {
        duration: r2(t),
        winner: alive.length === 1 ? alive[0].id : null,
        ranking: ranking.map((p) => ({ id: p.id, name: p.name, color: p.color, place: p.place,
          time: r2(p.alive ? t : p.deathT), bot: !!p.bot })),
      };
      if (this.players.length > 1) {
        this.say(alive.length === 1 ? alive[0].name + ' remporte la manche !' : 'Égalité !', 'win');
      }
    }

    // ---------- IA ----------
    botThink(p, dt) {
      const b = p.bot, cfg = b.cfg;
      b.timer -= dt;
      if (b.timer <= 0) {
        b.timer = cfg.react * this.rand(0.7, 1.3);
        this.botChoose(p);
      }
      let dx = b.tx - p.x, dy = b.ty - p.y;
      const d = Math.hypot(dx, dy);
      const vmax = MAX_SPEED * cfg.speed;
      const sp = Math.min(vmax, d * 7);
      let vx = d > 0.5 ? (dx / d) * sp : 0, vy = d > 0.5 ? (dy / d) * sp : 0;
      // compenser ce qui pousse (vent, trou noir, explosions)
      const ext = this.externalVel(p);
      vx -= ext.x * cfg.comp; vy -= ext.y * cfg.comp;
      const v = Math.hypot(vx, vy);
      if (v > vmax) { vx *= vmax / v; vy *= vmax / v; }
      // inversion : les bots mettent un moment à s'adapter
      if (this.inv.state === 'active') {
        if (this.t - this.inv.tStart > cfg.invDelay) { vx = -vx; vy = -vy; }
        else { vx *= 0.3; vy *= 0.3; } // surpris : il hésite, comme un humain
      }
      this.applyInput(p, vx * dt, vy * dt);
    }

    botChoose(p) {
      const cfg = p.bot.cfg;
      const z = this.zone, c = this.zoneCenter();
      const S = this.shrink;
      let tz = { x: c.x, y: c.y, r: z.r };
      if (S.state !== 'idle') tz = { x: S.to.x + z.ox, y: S.to.y + z.oy, r: S.to.r };
      const urgent = S.state === 'shrinking' || (S.state === 'warn' && S.tStart - this.t < 1.5);
      // la dérive : viser là où la zone sera
      if (this.drift.active) {
        tz.x += this.drift.vx * 0.8; tz.y += this.drift.vy * 0.8;
      }
      const cands = [{ x: p.x, y: p.y }, { x: tz.x, y: tz.y }];
      for (let i = 0; i < 18; i++) {
        const a = Math.random() * TAU, dd = Math.sqrt(Math.random()) * tz.r * 0.85;
        cands.push({ x: tz.x + Math.cos(a) * dd, y: tz.y + Math.sin(a) * dd });
      }
      const W = this.wind, H = this.hole;
      const windOn = W.state !== 'idle';
      const wdx = Math.cos(W.angle), wdy = Math.sin(W.angle);
      let best = cands[0], bestS = -Infinity;
      for (const q of cands) {
        let s = 0;
        const dz = Math.hypot(q.x - c.x, q.y - c.y);
        if (dz > z.r - 28) s -= (dz - (z.r - 28)) * 8;
        s -= Math.max(0, dz - z.r * 0.55) * 0.6;
        const dt_ = Math.hypot(q.x - tz.x, q.y - tz.y), allow = tz.r - 30;
        if (dt_ > allow) s -= (dt_ - allow) * (urgent ? 12 : 4);
        for (const bm of this.bombs) {
          // les bots faciles ne remarquent pas toutes les bombes
          if (((bm.id * 2654435761 + p.idx * 97) % 1000) / 1000 > cfg.bombSense) continue;
          const db = Math.hypot(q.x - bm.x, q.y - bm.y);
          if (db < bm.r + 35) s -= (bm.r + 35 - db) * 7;
        }
        if (H.state !== 'idle') {
          const dh = Math.hypot(q.x - H.x, q.y - H.y);
          if (dh < H.R + 20) s -= (H.R + 20 - dh) * (H.kind === 'push' ? 3 : 1.2);
        }
        if (windOn) s += ((q.x - c.x) * -wdx + (q.y - c.y) * -wdy) * 0.3;
        s -= Math.hypot(q.x - p.x, q.y - p.y) * 0.12;
        if (this.s.collisions) {
          for (const o of this.players) {
            if (o === p || !o.alive) continue;
            const doo = Math.hypot(q.x - o.x, q.y - o.y);
            if (doo < 70) s -= (70 - doo) * 0.8;
          }
        }
        if (s > bestS) { bestS = s; best = q; }
      }
      const ja = Math.random() * TAU, jd = Math.random() * cfg.jitter;
      p.bot.tx = best.x + Math.cos(ja) * jd;
      p.bot.ty = best.y + Math.sin(ja) * jd;
    }

    // ---------- état sérialisable (rendu + réseau) ----------
    view() {
      const z = this.zone, c = this.zoneCenter(), S = this.shrink, W = this.wind, H = this.hole, I = this.inv;
      return {
        t: r2(this.t),
        ph: this.phase,
        z: { x: r1(c.x), y: r1(c.y), r: r1(z.r) },
        nz: S.state === 'idle' ? null : {
          x: r1(S.to.x + z.ox), y: r1(S.to.y + z.oy), r: r1(S.to.r),
          ts: r2(S.tStart), te: r2(S.tEnd), st: S.state,
        },
        b: this.bombs.map((b) => ({ id: b.id, x: r1(b.x), y: r1(b.y), r: r1(b.r), t0: r2(b.t0), t1: r2(b.t1) })),
        ex: this.explosions.map((e) => ({ x: r1(e.x), y: r1(e.y), r: r1(e.r), t: r2(e.t) })),
        w: W.state === 'idle' ? null : { st: W.state, a: r2(W.angle), s: r1(W.str), ts: r2(W.tStart), te: r2(W.tEnd),
          f: r1(Math.hypot(W.fx, W.fy)) },
        h: H.state === 'idle' ? null : { st: H.state, x: r1(H.x), y: r1(H.y), R: r1(H.R), k: H.kind,
          ts: r2(H.tStart), te: r2(H.tEnd) },
        d: this.drift.active ? { vx: r1(this.drift.vx), vy: r1(this.drift.vy) } : null,
        iv: I.state === 'idle' ? null : { st: I.state, ts: r2(I.tStart), te: r2(I.tEnd) },
        p: this.players.map((p) => ({ id: p.id, x: r1(p.x), y: r1(p.y), a: p.alive ? 1 : 0,
          ht: p.hitT != null ? r2(p.hitT) : null })),
        an: this.ann.slice(-5),
        res: this.results,
      };
    }
  }

  return {
    R0, PR, MIN_R, MAX_SPEED, COUNTDOWN, COLORS, PACE, EVENTS, BOT_LEVELS,
    defaultSettings, sanitizeSettings, Game,
  };
});
