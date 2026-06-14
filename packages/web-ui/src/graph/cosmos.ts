/**
 * GRAPH-2: Universum-Animation (Sterne, Planeten, Sonnen, Schwarzes/Weisses Loch).
 *
 * 1:1 portiert aus synapse-graph/public/app.js — die bewaehrte Render-Logik
 * bleibt erhalten. Statt Globals + document wird alles in CosmosRenderer
 * gekapselt: bekommt die Cytoscape-Instanz, den Container + einen
 * motionEnabled()-Getter herein. Lebt im eigenen <canvas>, kollidiert nicht
 * mit React.
 */

import type { Core, NodeSingular } from 'cytoscape';
import { PLANET_BASES } from './constants';

interface Particle { a: number; r: number; w: number; tw: number; size: number; }
interface FlowParticle { t: number; off: number; speed: number; }
interface Universe { particles: Particle[]; flow: FlowParticle[]; }
interface Sun { r: number; a: number; w: number; size: number; core: string; glow: [number, number, number]; }

function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface OverviewProjectLite {
  name: string;
  files?: number | null;
  vectors?: number | null;
}

export class CosmosRenderer {
  private cy: Core;
  private container: HTMLElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private motionEnabled: () => boolean;
  private getMode: () => string;

  private universes = new Map<string, Universe>();
  private orbits = new Map<string, { r: number; a: number; w: number }>();
  private coreParticles: Array<{ a: number; r: number; w: number; size: number }>;
  private planetTextures = new Map<string, HTMLCanvasElement>();
  private planetSpins = new Map<string, { phase: number; speed: number }>();
  private planetClimate = new Map<string, { cold: number }>();
  private whitePulse = 0;
  private starsLastT = performance.now();
  private motionPauseUntil = 0;
  private rafId = 0;
  private destroyed = false;

  private readonly SUNS: Sun[] = [
    { r: 210, a: 3.8, w: 0.012, size: 50, core: '#fff3c4', glow: [255, 190, 80] },
    { r: 340, a: 0.7, w: -0.009, size: 40, core: '#eaf4ff', glow: [150, 195, 255] },
    { r: 470, a: 2.1, w: 0.016, size: 30, core: '#ffd9c4', glow: [255, 120, 60] },
  ];

  constructor(opts: {
    cy: Core;
    container: HTMLElement;
    canvas: HTMLCanvasElement;
    motionEnabled: () => boolean;
    getMode: () => string;
  }) {
    this.cy = opts.cy;
    this.container = opts.container;
    this.canvas = opts.canvas;
    this.ctx = opts.canvas.getContext('2d')!;
    this.motionEnabled = opts.motionEnabled;
    this.getMode = opts.getMode;
    this.coreParticles = Array.from({ length: 90 }, () => ({
      a: Math.random() * 2 * Math.PI,
      r: Math.random(),
      w: (0.4 + Math.random() * 0.8) * (Math.random() < 0.5 ? -1 : 1),
      size: 0.7 + Math.random() * 1.2,
    }));
    this.resize();
    this.loop = this.loop.bind(this);
    this.rafId = requestAnimationFrame(this.loop);
  }

  resize(): void {
    const rect = this.container.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.max(1, Math.round(rect.width * dpr));
    this.canvas.height = Math.max(1, Math.round(rect.height * dpr));
    this.canvas.style.width = `${rect.width}px`;
    this.canvas.style.height = `${rect.height}px`;
  }

  destroy(): void {
    this.destroyed = true;
    cancelAnimationFrame(this.rafId);
  }

  /** Orbit-Bahnen fuer die aktuell platzierten Projekte registrieren. */
  setOrbits(orbits: Map<string, { r: number; a: number; w: number }>): void {
    this.orbits = orbits;
  }

  pauseMotion(ms: number): void {
    this.motionPauseUntil = performance.now() + ms;
  }

  syncUniverses(projekte: OverviewProjectLite[]): void {
    const names = new Set<string>();
    for (const p of projekte) {
      names.add(p.name);
      const inhalt = (p.files ?? 0) + (p.vectors ?? 0) / 10;
      const want = Math.max(6, Math.min(220, Math.round(Math.sqrt(inhalt) * 4)));
      const u = this.universes.get(p.name);
      if (!u || u.particles.length !== want) {
        this.universes.set(p.name, {
          particles: Array.from({ length: want }, () => ({
            a: Math.random() * 2 * Math.PI,
            r: 0.15 + Math.random() * 0.72,
            w: (0.2 + Math.random() * 0.6) * (Math.random() < 0.5 ? -1 : 1),
            tw: Math.random() * 2 * Math.PI,
            size: 0.6 + Math.random() * 1.1,
          })),
          flow: Array.from({ length: 3 }, () => ({
            t: Math.random(),
            off: Math.random() * 2 * Math.PI,
            speed: 0.25 + Math.random() * 0.3,
          })),
        });
      }
    }
    for (const k of [...this.universes.keys()]) if (!names.has(k)) this.universes.delete(k);
  }

  private sunRendered(s: Sun, dpr: number) {
    const zoom = this.cy.zoom();
    const pan = this.cy.pan();
    const mx = Math.cos(s.a) * s.r;
    const my = Math.sin(s.a) * s.r;
    return { x: (mx * zoom + pan.x) * dpr, y: (my * zoom + pan.y) * dpr, r: s.size * zoom * dpr };
  }

  private planetSpin(name: string) {
    let s = this.planetSpins.get(name);
    if (!s) {
      const rnd = mulberry32(hashStr(name) ^ 0x9e3779b9);
      s = { phase: rnd(), speed: (0.012 + rnd() * 0.03) * (rnd() < 0.5 ? -1 : 1) };
      this.planetSpins.set(name, s);
    }
    return s;
  }

  private planetTexture(name: string): HTMLCanvasElement {
    let tex = this.planetTextures.get(name);
    if (tex) return tex;
    const rnd = mulberry32(hashStr(name));
    const size = 128;
    const c = document.createElement('canvas');
    c.width = size;
    c.height = size;
    const x = c.getContext('2d')!;
    x.fillStyle = PLANET_BASES[Math.floor(rnd() * PLANET_BASES.length)];
    x.fillRect(0, 0, size, size);
    const bands = 2 + Math.floor(rnd() * 3);
    for (let i = 0; i < bands; i++) {
      x.globalAlpha = 0.1 + rnd() * 0.12;
      x.fillStyle = rnd() < 0.5 ? '#000000' : '#ffffff';
      x.fillRect(0, rnd() * size, size, 6 + rnd() * 18);
    }
    const spots = 5 + Math.floor(rnd() * 7);
    for (let i = 0; i < spots; i++) {
      x.globalAlpha = 0.12 + rnd() * 0.2;
      x.fillStyle = rnd() < 0.5 ? '#ffffff' : '#0a0f1e';
      const fx = rnd() * size;
      const fy = rnd() * size;
      const rw = 6 + rnd() * 22;
      const rh = 4 + rnd() * 14;
      const rot = rnd() * Math.PI;
      for (const ox of [-size, 0, size]) {
        x.beginPath();
        x.ellipse(fx + ox, fy, rw, rh, rot, 0, 2 * Math.PI);
        x.fill();
      }
    }
    x.globalAlpha = 1;
    this.planetTextures.set(name, c);
    return c;
  }

  private drawCore(node: NodeSingular, dpr: number, dt: number): void {
    const ctx = this.ctx;
    const pos = node.renderedPosition();
    const R = (node.renderedWidth() / 2) * 1.9;
    if (R < 8) return;
    const hole = node.data('hole');
    const cx = pos.x * dpr;
    const cyy = pos.y * dpr;
    const Rn = (node.renderedWidth() / 2) * dpr;

    if (hole === 'white') {
      this.whitePulse += dt;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const flick = 0.9 + 0.1 * Math.sin(this.whitePulse * 7) * Math.sin(this.whitePulse * 3.1);
      const g = ctx.createRadialGradient(cx, cyy, 0, cx, cyy, Rn * 3.2);
      g.addColorStop(0, `rgba(255,255,255,${(0.9 * flick).toFixed(3)})`);
      g.addColorStop(0.18, 'rgba(220,235,255,0.5)');
      g.addColorStop(0.45, 'rgba(160,200,255,0.16)');
      g.addColorStop(1, 'rgba(140,180,255,0)');
      ctx.globalAlpha = 1;
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(cx, cyy, Rn * 3.2, 0, 2 * Math.PI);
      ctx.fill();
      ctx.globalAlpha = 0.85;
      ctx.strokeStyle = '#ffffff';
      const pw = Math.sin(this.whitePulse * 2.4);
      ctx.lineWidth = (1.2 + 0.8 * pw * pw) * dpr;
      ctx.beginPath();
      ctx.arc(cx, cyy, Rn * 1.12, 0, 2 * Math.PI);
      ctx.stroke();
      for (let k = 0; k < 3; k++) {
        const ph = (this.whitePulse * 0.3 + k / 3) % 1;
        ctx.globalAlpha = (1 - ph) * 0.3;
        ctx.strokeStyle = '#dcebff';
        ctx.lineWidth = 1.5 * dpr;
        ctx.beginPath();
        ctx.ellipse(cx, cyy, Rn * (1.1 + ph * 2.4), Rn * (1.1 + ph * 2.4) * 0.55, 0, 0, 2 * Math.PI);
        ctx.stroke();
      }
      for (const dir of [-1, 1]) {
        const jl = Rn * 3.0;
        const ja = 0.35 * (0.7 + 0.3 * Math.sin(this.whitePulse * 9 + dir));
        const jg = ctx.createLinearGradient(cx, cyy, cx, cyy + dir * jl);
        jg.addColorStop(0, `rgba(255,255,255,${ja.toFixed(3)})`);
        jg.addColorStop(0.4, `rgba(170,210,255,${(ja * 0.5).toFixed(3)})`);
        jg.addColorStop(1, 'rgba(150,195,255,0)');
        ctx.globalAlpha = 1;
        ctx.fillStyle = jg;
        ctx.beginPath();
        ctx.moveTo(cx - Rn * 0.22, cyy);
        ctx.lineTo(cx - Rn * 0.5, cyy + dir * jl);
        ctx.lineTo(cx + Rn * 0.5, cyy + dir * jl);
        ctx.lineTo(cx + Rn * 0.22, cyy);
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();
    }

    for (const p of this.coreParticles) {
      if (hole === 'black') {
        p.r -= dt * (0.12 + (1 - p.r) * 0.45);
        p.a += p.w * dt * (2.2 - p.r);
        if (p.r < 0.08) { p.r = 1; p.a = Math.random() * 2 * Math.PI; }
      } else {
        p.r += dt * (0.1 + p.r * 0.5);
        p.a += p.w * dt * (0.6 + (1 - p.r) * 2);
        if (p.r > 1) { p.r = 0.08; p.a = Math.random() * 2 * Math.PI; }
      }
      const x = (pos.x + Math.cos(p.a) * p.r * R) * dpr;
      const y = (pos.y + Math.sin(p.a) * p.r * R * 0.55) * dpr;
      let alpha = 0.2 + 0.55 * (1 - p.r);
      if (hole === 'white') alpha *= 0.75 + 0.45 * Math.cos(p.a);
      ctx.globalAlpha = Math.max(0.05, Math.min(1, alpha));
      ctx.fillStyle = hole === 'black' ? '#ffb74d' : '#cfe2ff';
      ctx.beginPath();
      ctx.arc(x, y, p.size * dpr, 0, 2 * Math.PI);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  private moveOrbits(dt: number, coreExpanded: boolean): void {
    if (!this.motionEnabled() || performance.now() < this.motionPauseUntil || !coreExpanded) return;
    this.cy.batch(() => {
      for (const [name, o] of this.orbits) {
        const n = this.cy.getElementById(name);
        if (!n.length || n.grabbed()) continue;
        o.a += o.w * dt;
        n.position({ x: Math.cos(o.a) * o.r, y: Math.sin(o.a) * o.r });
      }
    });
  }

  private drawSuns(dpr: number, dt: number): void {
    const ctx = this.ctx;
    if (this.motionEnabled()) for (const s of this.SUNS) s.a += s.w * dt;
    const projs: Array<{ n: NodeSingular; px: number; py: number }> = [];
    this.cy.nodes('[type = "project"]').forEach((n) => {
      const p = n.renderedPosition();
      projs.push({ n, px: p.x * dpr, py: p.y * dpr });
    });
    ctx.globalCompositeOperation = 'lighter';
    for (const s of this.SUNS) {
      const sp = this.sunRendered(s, dpr);
      if (sp.r < 2) continue;
      const [gr, gg, gb] = s.glow;
      const g = ctx.createRadialGradient(sp.x, sp.y, sp.r * 0.2, sp.x, sp.y, sp.r * 2.6);
      g.addColorStop(0, `rgba(${gr},${gg},${gb},0.9)`);
      g.addColorStop(0.3, `rgba(${gr},${gg},${gb},0.45)`);
      g.addColorStop(1, `rgba(${gr},${gg},${gb},0)`);
      ctx.globalAlpha = 1;
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(sp.x, sp.y, sp.r * 2.6, 0, 2 * Math.PI);
      ctx.fill();
      ctx.fillStyle = s.core;
      ctx.beginPath();
      ctx.arc(sp.x, sp.y, sp.r * 0.8, 0, 2 * Math.PI);
      ctx.fill();
      const near = projs
        .map((p) => ({ ...p, d: Math.hypot(p.px - sp.x, p.py - sp.y) }))
        .sort((x, y) => x.d - y.d)
        .slice(0, 3);
      for (const { n, px, py } of near) {
        const lg = ctx.createLinearGradient(sp.x, sp.y, px, py);
        lg.addColorStop(0, `rgba(${gr},${gg},${gb},0.32)`);
        lg.addColorStop(1, `rgba(${gr},${gg},${gb},0.02)`);
        ctx.strokeStyle = lg;
        ctx.lineWidth = Math.max(1.5, (n.renderedWidth() / 3) * dpr * 0.3);
        ctx.beginPath();
        ctx.moveTo(sp.x, sp.y);
        ctx.lineTo(px, py);
        ctx.stroke();
      }
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  private planetShadowed(px: number, py: number, sun: { x: number; y: number }, dpr: number, selfId: string): boolean {
    const dx = sun.x - px;
    const dy = sun.y - py;
    const len2 = dx * dx + dy * dy || 1;
    let shadowed = false;
    this.cy.nodes('[type = "project"], node[type = "center"]').forEach((n) => {
      if (shadowed || n.id() === selfId) return;
      const p = n.renderedPosition();
      const vx = p.x * dpr - px;
      const vy = p.y * dpr - py;
      const t = (vx * dx + vy * dy) / len2;
      if (t <= 0.05 || t >= 0.95) return;
      const cxp = px + dx * t;
      const cyp = py + dy * t;
      const dist = Math.hypot(p.x * dpr - cxp, p.y * dpr - cyp);
      if (dist < (n.renderedWidth() / 2) * dpr * 0.9) shadowed = true;
    });
    return shadowed;
  }

  private drawPlanet(node: NodeSingular, dpr: number, t: number, dt: number): void {
    const ctx = this.ctx;
    const pos = node.renderedPosition();
    const R = node.renderedWidth() / 2;
    if (R < 4) return;
    const x = pos.x * dpr;
    const y = pos.y * dpr;
    const Rp = R * dpr;
    ctx.globalAlpha = 1;
    const spin = this.planetSpin(node.id());
    if (this.motionEnabled()) spin.phase = (spin.phase + dt * spin.speed) % 1;
    const off = (((spin.phase % 1) + 1) % 1) * Rp * 2;
    const tex = this.planetTexture(node.id());
    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, Rp, 0, 2 * Math.PI);
    ctx.clip();
    ctx.drawImage(tex, x - Rp - off, y - Rp, Rp * 2, Rp * 2);
    ctx.drawImage(tex, x - Rp - off + Rp * 2, y - Rp, Rp * 2, Rp * 2);
    ctx.restore();
    let vx = 0;
    let vy = 0;
    let total = 0;
    const zoom = this.cy.zoom();
    for (const cand of this.SUNS) {
      const sp = this.sunRendered(cand, dpr);
      const d = Math.hypot(sp.x - x, sp.y - y);
      const modelDist = d / dpr / zoom;
      let intensity = 1 / (1 + (modelDist / 240) * (modelDist / 240));
      if (this.planetShadowed(x, y, sp, dpr, node.id())) intensity *= 0.15;
      total += intensity;
      if (d > 0.001) {
        vx += ((sp.x - x) / d) * intensity;
        vy += ((sp.y - y) / d) * intensity;
      }
    }
    const light = Math.min(1, total);
    const directionality = total > 0 ? Math.min(1, Math.hypot(vx, vy) / total) : 1;
    const ang = Math.atan2(vy, vx);
    const targetCold = Math.max(0, Math.min(1, (0.85 - total) / 0.85));
    let clim = this.planetClimate.get(node.id());
    if (!clim) {
      clim = { cold: targetCold };
      this.planetClimate.set(node.id(), clim);
    }
    clim.cold += (targetCold - clim.cold) * Math.min(1, dt * 0.4);
    const cold = clim.cold;
    if (cold > 0.04) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(x, y, Rp, 0, 2 * Math.PI);
      ctx.clip();
      ctx.globalCompositeOperation = 'saturation';
      ctx.globalAlpha = Math.min(1, cold * 1.1);
      ctx.fillStyle = '#808080';
      ctx.fillRect(x - Rp, y - Rp, Rp * 2, Rp * 2);
      ctx.globalCompositeOperation = 'screen';
      ctx.globalAlpha = 0.45 * cold;
      ctx.fillStyle = '#9fc8ef';
      ctx.fillRect(x - Rp, y - Rp, Rp * 2, Rp * 2);
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
      const capH = Rp * (0.18 + 0.62 * cold);
      for (const dir of [-1, 1]) {
        const g2 = ctx.createLinearGradient(
          x, y + dir * (Rp - capH) - dir * Rp * 0.15,
          x, y + dir * Rp,
        );
        g2.addColorStop(0, 'rgba(240,250,255,0)');
        g2.addColorStop(0.35, `rgba(240,250,255,${(0.75 * cold).toFixed(3)})`);
        g2.addColorStop(1, `rgba(255,255,255,${Math.min(0.95, cold * 1.2).toFixed(3)})`);
        ctx.fillStyle = g2;
        ctx.fillRect(x - Rp, y - Rp, Rp * 2, Rp * 2);
      }
      ctx.restore();
      ctx.globalAlpha = 1;
    }
    const lx = x + Math.cos(ang) * Rp * 0.45;
    const ly = y + Math.sin(ang) * Rp * 0.45;
    const g = ctx.createRadialGradient(lx, ly, Rp * 0.1, x, y, Rp * 1.05);
    g.addColorStop(0, `rgba(255,250,235,${(0.32 * light).toFixed(3)})`);
    g.addColorStop(0.55, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, Rp, 0, 2 * Math.PI);
    ctx.fill();
    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, Rp, 0, 2 * Math.PI);
    ctx.clip();
    const off2 = Rp * (0.5 + 0.45 * (1 - light));
    const sx = x - Math.cos(ang) * off2;
    const sy = y - Math.sin(ang) * off2;
    const shadowAlpha = (0.78 - 0.3 * light) * directionality;
    const sg = ctx.createRadialGradient(sx, sy, Rp * 0.15, sx, sy, Rp * 1.35);
    sg.addColorStop(0, `rgba(2,4,14,${shadowAlpha.toFixed(3)})`);
    sg.addColorStop(0.7, `rgba(2,4,14,${(shadowAlpha * 0.7).toFixed(3)})`);
    sg.addColorStop(1, 'rgba(2,4,14,0)');
    ctx.fillStyle = sg;
    ctx.fillRect(x - Rp, y - Rp, Rp * 2, Rp * 2);
    ctx.restore();
    if (node.data('running')) {
      ctx.globalAlpha = 0.55 + 0.35 * Math.sin(t / 300);
      ctx.strokeStyle = '#3ddc84';
      ctx.lineWidth = 2.5 * dpr;
      ctx.shadowColor = '#3ddc84';
      ctx.shadowBlur = 14 * dpr;
      ctx.beginPath();
      ctx.arc(x, y, Rp + 3 * dpr, 0, 2 * Math.PI);
      ctx.stroke();
      ctx.shadowBlur = 0;
      ctx.globalAlpha = 1;
    } else if (node.data('enabled')) {
      ctx.globalAlpha = 0.7;
      ctx.strokeStyle = '#5b8cff';
      ctx.lineWidth = 1.5 * dpr;
      ctx.beginPath();
      ctx.arc(x, y, Rp + 2 * dpr, 0, 2 * Math.PI);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }

  private drawFlows(core: NodeSingular, dpr: number, dt: number): void {
    const ctx = this.ctx;
    const cpos = core.renderedPosition();
    for (const [name, u] of this.universes) {
      const node = this.cy.getElementById(name);
      if (!node.length) continue;
      const pos = node.renderedPosition();
      const dx = pos.x - cpos.x;
      const dy = pos.y - cpos.y;
      const dist = Math.hypot(dx, dy);
      if (dist < 30) continue;
      const ux = dx / dist;
      const uy = dy / dist;
      const nx = -uy;
      const ny = ux;
      for (const f of u.flow ?? []) {
        f.t += dt * f.speed;
        if (f.t > 1) f.t -= 1;
        const wob = Math.sin(f.t * Math.PI * 4 + f.off) * 6;
        const x = (cpos.x + ux * dist * f.t + nx * wob) * dpr;
        const y = (cpos.y + uy * dist * f.t + ny * wob) * dpr;
        ctx.globalAlpha = 0.1 + 0.55 * (1 - f.t);
        ctx.fillStyle = '#bfd5ff';
        ctx.beginPath();
        ctx.arc(x, y, (0.8 + (1 - f.t) * 0.8) * dpr, 0, 2 * Math.PI);
        ctx.fill();
      }
    }
  }

  private loop(t: number): void {
    if (this.destroyed) return;
    const dt = Math.min(0.05, (t - this.starsLastT) / 1000);
    this.starsLastT = t;
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (this.getMode() === 'overview') {
      const dpr = window.devicePixelRatio || 1;
      const core = this.cy.getElementById('__synapse__');
      const coreExpanded = core.length ? core.data('hole') === 'white' : false;
      if (core.length) this.drawCore(core, dpr, dt);
      if (core.length && core.data('hole') === 'white') this.drawFlows(core, dpr, dt);
      this.moveOrbits(dt, coreExpanded);
      this.drawSuns(dpr, dt);
      for (const [name, u] of this.universes) {
        const node = this.cy.getElementById(name);
        if (!node.length) continue;
        this.drawPlanet(node, dpr, t, dt);
        const pos = node.renderedPosition();
        const R = (node.renderedWidth() / 2) * 0.85;
        if (R < 6) continue;
        const visible = Math.min(u.particles.length, Math.max(4, Math.round((R * R) / 60)));
        for (const p of u.particles.slice(0, visible)) {
          p.a += p.w * dt;
          p.tw += dt * 3;
          const x = (pos.x + Math.cos(p.a) * p.r * R) * dpr;
          const y = (pos.y + Math.sin(p.a) * p.r * R * 0.9) * dpr;
          ctx.globalAlpha = 0.35 + 0.45 * (0.5 + 0.5 * Math.sin(p.tw));
          ctx.fillStyle = '#eaf2ff';
          ctx.beginPath();
          ctx.arc(x, y, p.size * dpr * Math.min(1.4, R / 24), 0, 2 * Math.PI);
          ctx.fill();
        }
      }
      ctx.globalAlpha = 1;
    }
    this.rafId = requestAnimationFrame(this.loop);
  }
}
