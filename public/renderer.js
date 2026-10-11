/* Cercle Vicieux — rendu Canvas 2D. Ne connaît que l'état « vue » produit par Engine.Game#view(). */
(function () {
  'use strict';
  const { R0, PR } = Engine;
  const TAU = Math.PI * 2;
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const easeOut = (u) => 1 - Math.pow(1 - clamp(u, 0, 1), 3);

  const C = {
    bg: '#0a0b14', grid: 'rgba(141,147,187,0.09)', arena: 'rgba(141,147,187,0.22)',
    zone: '#eceefe', accent: '#4cc9f0', danger: '#ff4d6d', warn: '#ffb703',
    wind: '#8ecae6', hole: '#b388ff', push: '#ff9e3d', invert: '#f15bb5',
  };

  function create(canvas) {
    const ctx = canvas.getContext('2d');
    let W = 0, H = 0, dpr = 1, scale = 1, cx = 0, cy = 0, bx = 0, by = 0;
    let stripes = null;
    const particles = [];
    const seenExplosions = new Set();
    const lastAlive = new Map();
    let lastT = null;

    function makeStripes() {
      const s = document.createElement('canvas');
      s.width = s.height = 18 * dpr;
      const g = s.getContext('2d');
      g.strokeStyle = 'rgba(255,77,109,0.16)';
      g.lineWidth = 5 * dpr;
      g.beginPath();
      for (let i = -1; i <= 2; i++) { g.moveTo(i * 18 * dpr, 18 * dpr); g.lineTo((i + 1) * 18 * dpr, 0); }
      g.stroke();
      stripes = ctx.createPattern(s, 'repeat');
    }

    function resize() {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      W = canvas.clientWidth; H = canvas.clientHeight;
      canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
      scale = Math.min(W, H) / (2 * R0 * 1.1);
      bx = cx = W / 2; by = cy = H / 2 + Math.min(18, H * 0.02);
      makeStripes();
    }

    const toScreen = (x, y) => ({ x: cx + x * scale, y: cy + y * scale });
    const toWorld = (sx, sy) => ({ x: (sx - cx) / scale, y: (sy - cy) / scale });
    function world() { ctx.setTransform(dpr * scale, 0, 0, dpr * scale, dpr * cx, dpr * cy); }
    function screen() { ctx.setTransform(dpr, 0, 0, dpr, 0, 0); }
    const px = (n) => n / scale; // n pixels écran en unités monde

    function label(text, x, y, color, size, weight) {
      const p = toScreen(x, y);
      screen();
      ctx.font = (weight || 500) + ' ' + (size || 13) + 'px Rubik, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const w = ctx.measureText(text).width;
      ctx.fillStyle = 'rgba(10,11,20,0.75)';
      roundRect(p.x - w / 2 - 7, p.y - (size || 13) / 2 - 5, w + 14, (size || 13) + 10, 7);
      ctx.fill();
      ctx.fillStyle = color;
      ctx.fillText(text, p.x, p.y + 1);
      world();
    }
    function roundRect(x, y, w, h, r) {
      ctx.beginPath();
      ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
    }
    function arrow(x, y, ang, len, width, color, alpha) {
      ctx.save();
      ctx.translate(x, y); ctx.rotate(ang);
      ctx.globalAlpha = alpha;
      ctx.fillStyle = color;
      const hw = width / 2, head = Math.min(len * 0.45, width * 1.6);
      ctx.beginPath();
      ctx.moveTo(-len / 2, -hw * 0.45); ctx.lineTo(len / 2 - head, -hw * 0.45); ctx.lineTo(len / 2 - head, -hw);
      ctx.lineTo(len / 2, 0); ctx.lineTo(len / 2 - head, hw); ctx.lineTo(len / 2 - head, hw * 0.45);
      ctx.lineTo(-len / 2, hw * 0.45); ctx.closePath();
      ctx.fill();
      ctx.restore();
    }

    function spawn(n, x, y, color, speed, life, size) {
      for (let i = 0; i < n; i++) {
        const a = Math.random() * TAU, s = speed * (0.3 + Math.random() * 0.9);
        particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life, max: life, color, size: size * (0.5 + Math.random()), kind: 'dot' });
      }
    }

    function updateParticles(v, t, dt) {
      // vent : traînées dans la direction du vent
      if (v.w && v.w.st === 'active' && v.w.f > 1) {
        const n = v.w.f * dt * 0.22;
        const count = Math.floor(n) + (Math.random() < n % 1 ? 1 : 0);
        for (let i = 0; i < count; i++) {
          const a = Math.random() * TAU, d = Math.sqrt(Math.random()) * R0 * 1.15;
          const sp = 260 + v.w.f * 1.4;
          particles.push({ x: Math.cos(a) * d, y: Math.sin(a) * d, vx: Math.cos(v.w.a) * sp, vy: Math.sin(v.w.a) * sp,
            life: 0.55, max: 0.55, color: C.wind, size: 1.6, kind: 'streak' });
        }
      }
      // trou noir / répulseur
      if (v.h && v.h.st === 'active') {
        for (let i = 0; i < 2; i++) {
          const a = Math.random() * TAU;
          if (v.h.k === 'pull') {
            const d = v.h.R * (0.7 + Math.random() * 0.3);
            const x = v.h.x + Math.cos(a) * d, y = v.h.y + Math.sin(a) * d;
            particles.push({ x, y, vx: -Math.cos(a) * 160 - Math.sin(a) * 90, vy: -Math.sin(a) * 160 + Math.cos(a) * 90,
              life: 0.9, max: 0.9, color: C.hole, size: 2, kind: 'dot' });
          } else {
            particles.push({ x: v.h.x, y: v.h.y, vx: Math.cos(a) * 240, vy: Math.sin(a) * 240,
              life: 0.7, max: 0.7, color: C.push, size: 2, kind: 'dot' });
          }
        }
      }
      for (const e of v.ex) {
        const key = e.x + ':' + e.y + ':' + e.t;
        if (seenExplosions.has(key)) continue;
        seenExplosions.add(key);
        spawn(26, e.x, e.y, C.warn, e.r * 3.2, 0.55, 3);
        spawn(14, e.x, e.y, C.danger, e.r * 2, 0.7, 4);
      }
      if (seenExplosions.size > 200) seenExplosions.clear();
      for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        p.life -= dt;
        if (p.life <= 0) { particles.splice(i, 1); continue; }
        p.x += p.vx * dt; p.y += p.vy * dt;
        if (p.kind === 'dot') { p.vx *= 0.95; p.vy *= 0.95; }
      }
      if (particles.length > 900) particles.splice(0, particles.length - 900);
    }

    function drawParticles() {
      for (const p of particles) {
        const u = p.life / p.max;
        ctx.globalAlpha = p.kind === 'streak' ? Math.sin(u * Math.PI) * 0.55 : u;
        if (p.kind === 'streak') {
          ctx.strokeStyle = p.color;
          ctx.lineWidth = px(p.size);
          const sp = Math.hypot(p.vx, p.vy) || 1;
          const len = px(34) + sp * 0.06;
          ctx.beginPath();
          ctx.moveTo(p.x, p.y); ctx.lineTo(p.x - (p.vx / sp) * len, p.y - (p.vy / sp) * len);
          ctx.stroke();
        } else {
          ctx.fillStyle = p.color;
          ctx.beginPath(); ctx.arc(p.x, p.y, px(p.size), 0, TAU); ctx.fill();
        }
      }
      ctx.globalAlpha = 1;
    }

    /**
     * @param {{v:object,t:number,meta:Object,meId:string,collisions:boolean,shake?:{x:number,y:number}}} s
     */
    function draw(s) {
      const v = s.v, t = s.t;
      const dt = lastT == null ? 0 : clamp(t - lastT, 0, 0.1);
      lastT = t;
      const now = performance.now() / 1000;

      screen();
      ctx.fillStyle = C.bg;
      ctx.fillRect(0, 0, W, H);
      if (!v) return;

      cx = bx + (s.shake ? s.shake.x : 0);
      cy = by + (s.shake ? s.shake.y : 0);
      ctx.save();
      world();

      // grille de points
      ctx.fillStyle = C.grid;
      const step = 30;
      for (let gx = -R0 * 1.4; gx <= R0 * 1.4; gx += step) {
        for (let gy = -R0 * 1.4; gy <= R0 * 1.4; gy += step) ctx.fillRect(gx - px(1), gy - px(1), px(2), px(2));
      }
      // bord de l'arène
      ctx.strokeStyle = C.arena; ctx.lineWidth = px(1); ctx.setLineDash([px(3), px(7)]);
      ctx.beginPath(); ctx.arc(0, 0, R0, 0, TAU); ctx.stroke(); ctx.setLineDash([]);

      const z = v.z;
      // hors zone : hachures rouges
      ctx.beginPath();
      ctx.rect(-W / scale, -H / scale, (W / scale) * 2, (H / scale) * 2);
      ctx.arc(z.x, z.y, z.r, 0, TAU, true);
      ctx.fillStyle = 'rgba(255,77,109,0.07)';
      ctx.fill('evenodd');
      if (stripes) {
        ctx.save(); screen(); ctx.fillStyle = stripes;
        ctx.beginPath(); ctx.rect(0, 0, W, H);
        const zs = toScreen(z.x, z.y);
        ctx.arc(zs.x, zs.y, z.r * scale, 0, TAU, true);
        ctx.fill('evenodd'); ctx.restore(); world();
      }
      // intérieur
      const grad = ctx.createRadialGradient(z.x, z.y, 0, z.x, z.y, z.r);
      grad.addColorStop(0, 'rgba(76,201,240,0.07)');
      grad.addColorStop(1, 'rgba(76,201,240,0.02)');
      ctx.fillStyle = grad;
      ctx.beginPath(); ctx.arc(z.x, z.y, z.r, 0, TAU); ctx.fill();

      // prochaine zone
      if (v.nz) {
        const nz = v.nz;
        // la bande qui va disparaître
        ctx.beginPath(); ctx.arc(z.x, z.y, z.r, 0, TAU); ctx.arc(nz.x, nz.y, nz.r, 0, TAU, true);
        ctx.fillStyle = nz.st === 'warn' ? 'rgba(255,77,109,' + (0.06 + 0.05 * Math.sin(now * 8)) + ')' : 'rgba(255,77,109,0.12)';
        ctx.fill('evenodd');
        ctx.strokeStyle = '#ffffff';
        ctx.globalAlpha = nz.st === 'warn' ? 0.65 + 0.35 * Math.sin(now * 8) : 0.5;
        ctx.lineWidth = px(2.5);
        ctx.setLineDash([px(10), px(8)]);
        ctx.lineDashOffset = -now * px(40);
        ctx.beginPath(); ctx.arc(nz.x, nz.y, nz.r, 0, TAU); ctx.stroke();
        ctx.setLineDash([]); ctx.globalAlpha = 1;
        if (nz.st === 'warn') {
          const rem = Math.max(0, nz.ts - t);
          label('Rétrécit dans ' + rem.toFixed(1) + ' s', nz.x, nz.y - nz.r - px(16), '#ffffff', 13, 500);
        }
      }

      // bord de zone
      ctx.save();
      ctx.shadowColor = C.accent; ctx.shadowBlur = 18 * dpr;
      ctx.strokeStyle = C.zone; ctx.lineWidth = px(3);
      ctx.beginPath(); ctx.arc(z.x, z.y, z.r, 0, TAU); ctx.stroke();
      ctx.restore();

      // dérive
      if (v.d) {
        const sp = Math.hypot(v.d.vx, v.d.vy);
        if (sp > 2) {
          const a = Math.atan2(v.d.vy, v.d.vx);
          const L = Math.min(z.r * 0.5, 40 + sp * 1.6);
          arrow(z.x + Math.cos(a) * (z.r + px(26)), z.y + Math.sin(a) * (z.r + px(26)), a, px(34), px(18), C.accent, 0.85);
          ctx.globalAlpha = 0.18;
          arrow(z.x, z.y, a, L, px(22), C.accent, 0.18);
          ctx.globalAlpha = 1;
        }
      }

      // trou noir / répulseur
      if (v.h) {
        const h = v.h, col = h.k === 'pull' ? C.hole : C.push;
        if (h.st === 'warn') {
          const rem = Math.max(0, h.ts - t);
          ctx.strokeStyle = col; ctx.lineWidth = px(2); ctx.globalAlpha = 0.6 + 0.4 * Math.sin(now * 9);
          ctx.setLineDash([px(6), px(6)]); ctx.lineDashOffset = now * px(30) * (h.k === 'pull' ? 1 : -1);
          ctx.beginPath(); ctx.arc(h.x, h.y, h.R, 0, TAU); ctx.stroke(); ctx.setLineDash([]);
          ctx.fillStyle = col; ctx.globalAlpha = 0.07; ctx.fill(); ctx.globalAlpha = 1;
          const phase = (now * 1.2) % 1;
          for (let i = 0; i < 8; i++) {
            const a = (i / 8) * TAU + 0.2;
            const d = h.k === 'pull' ? h.R * (0.9 - phase * 0.5) : h.R * (0.35 + phase * 0.5);
            arrow(h.x + Math.cos(a) * d, h.y + Math.sin(a) * d, h.k === 'pull' ? a + Math.PI : a, px(24), px(13), col, 0.8);
          }
          label((h.k === 'pull' ? 'Trou noir' : 'Répulseur') + ' dans ' + rem.toFixed(1) + ' s', h.x, h.y, col, 13, 700);
        } else {
          const g2 = ctx.createRadialGradient(h.x, h.y, 0, h.x, h.y, h.R);
          if (h.k === 'pull') {
            g2.addColorStop(0, 'rgba(8,4,20,0.95)'); g2.addColorStop(0.25, 'rgba(90,40,170,0.45)'); g2.addColorStop(1, 'rgba(179,136,255,0)');
          } else {
            g2.addColorStop(0, 'rgba(255,210,150,0.6)'); g2.addColorStop(0.3, 'rgba(255,158,61,0.3)'); g2.addColorStop(1, 'rgba(255,158,61,0)');
          }
          ctx.fillStyle = g2;
          ctx.beginPath(); ctx.arc(h.x, h.y, h.R, 0, TAU); ctx.fill();
          ctx.strokeStyle = col; ctx.lineWidth = px(2);
          const rot = now * (h.k === 'pull' ? 2.2 : -1.6);
          for (let arm = 0; arm < 4; arm++) {
            ctx.globalAlpha = 0.55;
            ctx.beginPath();
            for (let i = 0; i <= 30; i++) {
              const u = i / 30, a = rot + arm * (TAU / 4) + u * 3.2, d = h.R * (0.08 + u * 0.88);
              const x = h.x + Math.cos(a) * d, y = h.y + Math.sin(a) * d;
              if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
            }
            ctx.stroke();
          }
          ctx.globalAlpha = 0.5; ctx.setLineDash([px(4), px(8)]);
          ctx.beginPath(); ctx.arc(h.x, h.y, h.R, 0, TAU); ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1;
        }
      }

      // bombes
      for (const b of v.b) {
        const u = clamp((t - b.t0) / (b.t1 - b.t0), 0, 1);
        ctx.fillStyle = 'rgba(255,77,109,' + (0.1 + 0.2 * u) + ')';
        ctx.beginPath(); ctx.arc(b.x, b.y, b.r, 0, TAU); ctx.fill();
        ctx.fillStyle = 'rgba(255,77,109,0.22)';
        ctx.beginPath(); ctx.arc(b.x, b.y, b.r * u, 0, TAU); ctx.fill();
        ctx.strokeStyle = C.danger; ctx.lineWidth = px(1.5); ctx.globalAlpha = 0.7;
        ctx.beginPath(); ctx.arc(b.x, b.y, b.r, 0, TAU); ctx.stroke();
        ctx.globalAlpha = 1; ctx.lineWidth = px(4);
        ctx.beginPath(); ctx.arc(b.x, b.y, b.r, -Math.PI / 2, -Math.PI / 2 + u * TAU); ctx.stroke();
        // la bombe
        ctx.fillStyle = '#1b1d2e';
        ctx.beginPath(); ctx.arc(b.x, b.y, px(10), 0, TAU); ctx.fill();
        ctx.strokeStyle = '#ffffff'; ctx.lineWidth = px(1.5); ctx.stroke();
        const blink = Math.sin(now * (8 + u * 30)) > 0;
        ctx.fillStyle = blink ? C.warn : C.danger;
        ctx.beginPath(); ctx.arc(b.x + px(6), b.y - px(7), px(3.2), 0, TAU); ctx.fill();
      }
      // explosions
      for (const e of v.ex) {
        const a = t - e.t;
        if (a < 0) continue;
        const u = clamp(a / 0.55, 0, 1);
        ctx.globalAlpha = (1 - u) * 0.9;
        ctx.strokeStyle = C.warn; ctx.lineWidth = px(6 * (1 - u) + 1);
        ctx.beginPath(); ctx.arc(e.x, e.y, e.r * (0.35 + 0.85 * easeOut(u)), 0, TAU); ctx.stroke();
        if (a < 0.14) {
          ctx.globalAlpha = (1 - a / 0.14) * 0.55;
          ctx.fillStyle = '#fff4d6';
          ctx.beginPath(); ctx.arc(e.x, e.y, e.r, 0, TAU); ctx.fill();
        }
        ctx.globalAlpha = 1;
      }

      // vent : annonce
      if (v.w && v.w.st === 'warn') {
        const rem = Math.max(0, v.w.ts - t);
        const pulse = 0.45 + 0.35 * Math.sin(now * 8);
        arrow(z.x, z.y, v.w.a, Math.min(z.r * 1.3, px(260)), px(46), C.wind, pulse);
        label('Vent dans ' + rem.toFixed(1) + ' s', z.x, z.y - px(46), C.wind, 13, 700);
      }

      updateParticles(v, t, dt);
      drawParticles();

      // joueurs
      const meta = s.meta || {};
      const ordered = v.p.slice().sort((a, b) => (a.id === s.meId) - (b.id === s.meId));
      for (const p of ordered) {
        const m = meta[p.id] || { name: '?', color: '#fff' };
        const was = lastAlive.get(p.id);
        if (was && !p.a) { spawn(30, p.x, p.y, m.color, 520, 0.8, 3.5); spawn(10, p.x, p.y, '#ffffff', 300, 0.5, 2); }
        lastAlive.set(p.id, !!p.a);
        if (!p.a) continue;
        const me = p.id === s.meId;
        const r = Math.max(PR, px(7));
        if (p.ht != null && t - p.ht < 0.35 && t >= p.ht) {
          const u = (t - p.ht) / 0.35;
          ctx.strokeStyle = '#ffffff'; ctx.globalAlpha = 1 - u; ctx.lineWidth = px(2);
          ctx.beginPath(); ctx.arc(p.x, p.y, r + px(4) + u * px(24), 0, TAU); ctx.stroke(); ctx.globalAlpha = 1;
        }
        ctx.save();
        ctx.shadowColor = m.color; ctx.shadowBlur = (me ? 22 : 12) * dpr;
        ctx.fillStyle = m.color;
        ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, TAU); ctx.fill();
        ctx.restore();
        // petit curseur dessiné dans le pion
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.scale(r / 12, r / 12);
        if (v.iv && v.iv.st === 'active') ctx.rotate(Math.PI);
        ctx.fillStyle = 'rgba(10,11,20,0.85)';
        ctx.beginPath();
        ctx.moveTo(-3.5, -7); ctx.lineTo(-3.5, 6); ctx.lineTo(-0.5, 3); ctx.lineTo(2, 8); ctx.lineTo(4, 7);
        ctx.lineTo(1.6, 2.2); ctx.lineTo(5.5, 2.2); ctx.closePath(); ctx.fill();
        ctx.restore();
        if (me) {
          ctx.strokeStyle = '#ffffff'; ctx.lineWidth = px(2.5);
          ctx.beginPath(); ctx.arc(p.x, p.y, r + px(5), 0, TAU); ctx.stroke();
        } else if (s.collisions) {
          ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.lineWidth = px(1);
          ctx.beginPath(); ctx.arc(p.x, p.y, r + px(1.5), 0, TAU); ctx.stroke();
        }
        if (v.p.length > 1) {
          const n = me ? m.name + ' (toi)' : m.name + (m.bot ? ' · bot' : '');
          label(n, p.x, p.y - r - px(20), me ? '#ffffff' : m.color, 12, me ? 700 : 500);
        }
      }

      ctx.restore();
      cx = bx; cy = by;
      screen();
      // inversion : cadre coloré
      if (v.iv) {
        const active = v.iv.st === 'active';
        const a = active ? 0.55 + 0.25 * Math.sin(now * 6) : 0.25 + 0.25 * Math.sin(now * 10);
        const g3 = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.max(W, H) * 0.75);
        g3.addColorStop(0, 'rgba(241,91,181,0)');
        g3.addColorStop(1, 'rgba(241,91,181,' + a + ')');
        ctx.fillStyle = g3; ctx.fillRect(0, 0, W, H);
      }
    }

    resize();
    return { draw, resize, toWorld, toScreen, get scale() { return scale; } };
  }

  window.Renderer = { create };
})();
