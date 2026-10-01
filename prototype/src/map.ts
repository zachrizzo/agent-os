// Canvas 2D fleet map. Canvas (not SVG) so 500 nodes + particles stay at 60 fps with no deps.
import { COS_ID, type Agent, type EventKind, type FleetEvent, type Team } from '../shared/types.ts';
import type { Store } from './store.ts';

export const KIND_COLOR: Record<EventKind, string> = {
  handoff: '#a78bfa', report: '#60a5fa', approval: '#f5c542', finding: '#34d399', message: '#cbd5e1', event: '#f472b6', steer: '#fb923c', check: '#22d3ee',
};

interface P { x: number; y: number }
interface Particle { from: string; to: string; kind: EventKind; t0: number; dur: number; bend: number }
interface TeamLayout { c: P; r: number; hull: P[] }

const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;
const MAX_PARTICLES = 140;

export class FleetMap {
  cam = { x: 0, y: 0, k: 1 };
  target = { x: 0, y: 0, k: 1 };
  labels = true;
  zoomLevel: 'fleet' | 'team' | 'agent' = 'fleet';
  focusTeam: string | null = null;
  focusAgent: string | null = null;
  onAgentClick: (id: string) => void = () => {};
  onTeamClick: (id: string) => void = () => {};
  onZoom: () => void = () => {};

  private ctx: CanvasRenderingContext2D;
  private pos = new Map<string, P>();
  private teamLayout = new Map<string, TeamLayout>();
  private order = new Map<string, number>(); // stable per-agent slot
  private particles: Particle[] = [];
  private flashes = new Map<string, number>();
  private stars: Array<[number, number, number]> = [];
  private layoutKey = '';
  private hover: string | null = null;
  private w = 0;
  private h = 0;
  private dpr = 1;
  private fitted = false;

  constructor(private canvas: HTMLCanvasElement, private mini: HTMLCanvasElement, private store: Store) {
    this.ctx = canvas.getContext('2d')!;
    for (let i = 0; i < 260; i++) this.stars.push([Math.random(), Math.random(), Math.random()]);
    new ResizeObserver(() => this.resize()).observe(canvas);
    this.resize();
    this.bindInput();
    requestAnimationFrame(this.frame);
  }

  private resize() {
    this.dpr = devicePixelRatio || 1;
    this.w = this.canvas.clientWidth;
    this.h = this.canvas.clientHeight;
    this.canvas.width = this.w * this.dpr;
    this.canvas.height = this.h * this.dpr;
    if (this.fitted) this.fit(this.zoomLevel, false);
  }

  // ---------- layout ----------
  private relayout() {
    const { teams, agents } = this.store;
    const key = `${[...teams.keys()].join(',')}|${agents.size}`;
    if (key === this.layoutKey) return;
    this.layoutKey = key;
    const byTeam = new Map<string, Agent[]>();
    for (const a of agents.values()) {
      if (!this.order.has(a.id)) this.order.set(a.id, this.order.size);
      (byTeam.get(a.team) ?? byTeam.set(a.team, []).get(a.team)!).push(a);
    }
    const others = [...teams.values()].filter((t) => t.id !== 'main' && byTeam.get(t.id)?.length);
    const radius = (n: number) => 46 + Math.sqrt(n) * 30;
    const ring = Math.max(300, 160 + others.reduce((s, t) => s + radius(byTeam.get(t.id)!.length), 0) / 2.2);
    const centers = new Map<string, P>();
    centers.set('main', { x: 0, y: 0 });
    others.forEach((t, i) => {
      const a = -Math.PI * 0.75 + (i / others.length) * Math.PI * 2;
      centers.set(t.id, { x: Math.cos(a) * ring * 1.45, y: Math.sin(a) * ring * 0.95 });
    });
    this.teamLayout.clear();
    for (const [tid, list] of byTeam) {
      const c = centers.get(tid) ?? { x: 0, y: 0 };
      const team = teams.get(tid);
      const r = radius(list.length);
      list.sort((a, b) => this.order.get(a.id)! - this.order.get(b.id)!);
      const lead = list.find((a) => a.id === (tid === 'main' ? COS_ID : team?.lead)) ?? null;
      const rest = list.filter((a) => a !== lead);
      if (lead) this.pos.set(lead.id, { ...c });
      rest.forEach((a, i) => {
        const ang = i * 2.39996 + (tid.length * 0.7);
        const d = r * 0.82 * Math.sqrt((i + (lead ? 1 : 0.4)) / (rest.length + 0.5));
        // squash into an organic blob, not a perfect disc
        this.pos.set(a.id, { x: c.x + Math.cos(ang) * d * 1.25, y: c.y + Math.sin(ang) * d * 0.85 });
      });
      const pts: P[] = [];
      for (const a of list) {
        const p = this.pos.get(a.id)!;
        for (let k = 0; k < 10; k++) pts.push({ x: p.x + Math.cos((k / 10) * Math.PI * 2) * 34, y: p.y + Math.sin((k / 10) * Math.PI * 2) * 30 });
      }
      this.teamLayout.set(tid, { c, r, hull: convexHull(pts) });
    }
    for (const id of [...this.pos.keys()]) if (!agents.has(id)) this.pos.delete(id);
    if (!this.fitted && agents.size) { this.fitted = true; this.fit('fleet', false); }
  }

  bounds(teamId?: string | null) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [tid, tl] of this.teamLayout) {
      if (teamId && tid !== teamId) continue;
      for (const p of tl.hull) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
    }
    if (!isFinite(x0)) return { x0: -100, y0: -100, x1: 100, y1: 100 };
    return { x0, y0: y0 - 40, x1, y1 };
  }

  fit(level: 'fleet' | 'team' | 'agent', animate = true) {
    this.zoomLevel = level;
    let b;
    if (level === 'agent' && this.focusAgent && this.pos.has(this.focusAgent)) {
      const p = this.pos.get(this.focusAgent)!;
      b = { x0: p.x - 120, y0: p.y - 90, x1: p.x + 120, y1: p.y + 90 };
    } else if (level !== 'fleet' && this.focusTeam) b = this.bounds(this.focusTeam);
    else b = this.bounds();
    const padTop = 110, padBottom = 70, pad = 40;
    const k = Math.min((this.w - pad * 2) / (b.x1 - b.x0), (this.h - padTop - padBottom) / (b.y1 - b.y0), level === 'fleet' ? 1.6 : 3);
    this.target = { x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 - (padTop - padBottom) / 2 / k, k };
    if (!animate) this.cam = { ...this.target };
    this.onZoom();
  }

  zoomBy(f: number) { this.target.k = Math.max(0.2, Math.min(6, this.target.k * f)); this.onZoom(); }

  // ---------- events ----------
  pushEvents(evs: FleetEvent[]) {
    const now = performance.now();
    for (const e of evs) {
      const to = e.to === 'zach' ? COS_ID : e.to;
      if (!this.store.agents.has(e.from) || !this.store.agents.has(to)) continue;
      if (REDUCED) { this.flashes.set(e.from, now); this.flashes.set(to, now); continue; }
      if (this.particles.length >= MAX_PARTICLES) { this.flashes.set(to, now); continue; } // aggregate under load
      const a = this.pos.get(e.from), b = this.pos.get(to);
      const dist = a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 200;
      this.particles.push({ from: e.from, to, kind: e.kind, t0: now + Math.random() * 120, dur: Math.min(900, 400 + dist * 0.6), bend: (Math.random() - 0.5) * 0.5 });
    }
  }

  // ---------- input ----------
  private toWorld(sx: number, sy: number): P {
    return { x: (sx - this.w / 2) / this.cam.k + this.cam.x, y: (sy - this.h / 2) / this.cam.k + this.cam.y };
  }
  private pick(sx: number, sy: number): string | null {
    const w = this.toWorld(sx, sy);
    let best: string | null = null, bd = (12 / this.cam.k) ** 2;
    for (const [id, p] of this.pos) {
      const d = (p.x - w.x) ** 2 + (p.y - w.y) ** 2;
      if (d < bd) { bd = d; best = id; }
    }
    return best;
  }
  private pickTeam(sx: number, sy: number): string | null {
    const w = this.toWorld(sx, sy);
    for (const [tid, tl] of this.teamLayout) if (pointInPoly(w, tl.hull)) return tid;
    return null;
  }
  private bindInput() {
    const c = this.canvas;
    let drag: { x: number; y: number; cx: number; cy: number; moved: boolean } | null = null;
    c.addEventListener('mousedown', (e) => { drag = { x: e.offsetX, y: e.offsetY, cx: this.target.x, cy: this.target.y, moved: false }; });
    addEventListener('mouseup', (e) => {
      if (drag && !drag.moved && e.target === c) {
        const id = this.pick(e.offsetX, e.offsetY);
        if (id) this.onAgentClick(id);
        else { const t = this.pickTeam(e.offsetX, e.offsetY); if (t) this.onTeamClick(t); }
      }
      drag = null; c.classList.remove('dragging');
    });
    c.addEventListener('mousemove', (e) => {
      if (drag) {
        const dx = e.offsetX - drag.x, dy = e.offsetY - drag.y;
        if (Math.abs(dx) + Math.abs(dy) > 3) { drag.moved = true; c.classList.add('dragging'); }
        this.target.x = drag.cx - dx / this.cam.k; this.target.y = drag.cy - dy / this.cam.k;
        this.cam.x = this.target.x; this.cam.y = this.target.y;
      }
      this.hover = this.pick(e.offsetX, e.offsetY);
      const tip = document.getElementById('tooltip')!;
      const a = this.hover ? this.store.agents.get(this.hover) : null;
      if (a) {
        tip.hidden = false;
        tip.style.left = `${e.offsetX + 14}px`; tip.style.top = `${e.offsetY + 10}px`;
        tip.innerHTML = `<b>${esc(a.name)}</b> <span class="m">· ${esc(this.store.teams.get(a.team)?.name ?? a.team)} · ${a.role}</span><div>${esc(a.now)}</div><div class="m">$${a.costUsd.toFixed(2)} · ${fmtK(a.tokens)} tok${a.model ? ` · ${esc(a.model)}` : ''}</div>`;
      } else tip.hidden = true;
      c.style.cursor = a ? 'pointer' : '';
    });
    c.addEventListener('mouseleave', () => { this.hover = null; document.getElementById('tooltip')!.hidden = true; });
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const before = this.toWorld(e.offsetX, e.offsetY);
      const k = Math.max(0.2, Math.min(6, this.cam.k * Math.exp(-e.deltaY * 0.0015)));
      this.cam.k = this.target.k = k;
      const after = this.toWorld(e.offsetX, e.offsetY);
      this.cam.x = this.target.x += before.x - after.x;
      this.cam.y = this.target.y += before.y - after.y;
      this.onZoom();
    }, { passive: false });
  }

  // ---------- render ----------
  private frame = (t: number) => {
    requestAnimationFrame(this.frame);
    this.relayout();
    const cam = this.cam, tg = this.target;
    const e = REDUCED ? 1 : 0.14;
    cam.x += (tg.x - cam.x) * e; cam.y += (tg.y - cam.y) * e; cam.k += (tg.k - cam.k) * e;
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);
    this.drawStars(ctx);
    ctx.save();
    ctx.translate(this.w / 2, this.h / 2);
    ctx.scale(cam.k, cam.k);
    ctx.translate(-cam.x, -cam.y);
    this.drawCrossLinks(ctx, t);
    this.drawHulls(ctx);
    this.drawIntraEdges(ctx);
    this.drawParticles(ctx, t);
    this.drawNodes(ctx, t);
    ctx.restore();
    this.drawLabels(ctx);
    this.drawMini();
  };

  private drawStars(ctx: CanvasRenderingContext2D) {
    for (const [x, y, s] of this.stars) {
      ctx.fillStyle = `rgba(150,170,220,${0.08 + s * 0.25})`;
      ctx.fillRect(x * this.w, y * this.h, s > 0.9 ? 1.6 : 1, s > 0.9 ? 1.6 : 1);
    }
  }

  private teamHue(tid: string) { return this.store.teams.get(tid)?.hue ?? '#8899aa'; }

  private drawCrossLinks(ctx: CanvasRenderingContext2D, t: number) {
    const cos = this.pos.get(COS_ID) ?? { x: 0, y: 0 };
    const rates = this.store.teamRates();
    for (const [tid, tl] of this.teamLayout) {
      if (tid === 'main') continue;
      const hue = this.teamHue(tid);
      const a = cos, b = tl.c;
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      const nx = -(b.y - a.y) * 0.18, ny = (b.x - a.x) * 0.18;
      const cp = { x: mx + nx, y: my + ny };
      // dotted luminous arc
      const n = Math.max(10, Math.floor(Math.hypot(b.x - a.x, b.y - a.y) / 16));
      const flow = (t / 2200) % 1;
      for (let i = 0; i <= n; i++) {
        const u = i / n;
        const p = qbez(a, cp, b, u);
        const glow = Math.max(0, 1 - Math.abs(((u - flow + 1) % 1) - 0.5) * 6);
        ctx.globalAlpha = 0.35 + glow * 0.5;
        ctx.fillStyle = mix('#7aa2ff', hue, u);
        ctx.beginPath(); ctx.arc(p.x, p.y, (1.3 + glow * 1.4) / Math.sqrt(this.cam.k), 0, Math.PI * 2); ctx.fill();
      }
      ctx.globalAlpha = 0.12;
      ctx.strokeStyle = hue; ctx.lineWidth = 1 / this.cam.k;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.quadraticCurveTo(cp.x, cp.y, b.x, b.y); ctx.stroke();
      ctx.globalAlpha = 1;
      const r = rates.get(tid) ?? 0;
      if (r > 0 && this.labels) {
        const m = qbez(a, cp, b, 0.5);
        this.queueLabel(m, `${r} msg/min`, '#9fb4e6', 11, 'center');
      }
    }
  }

  private drawHulls(ctx: CanvasRenderingContext2D) {
    for (const [tid, tl] of this.teamLayout) {
      const hue = this.teamHue(tid);
      const dim = this.focusTeam && this.zoomLevel !== 'fleet' && tid !== this.focusTeam ? 0.35 : 1;
      ctx.save();
      smoothPath(ctx, tl.hull);
      const g = ctx.createRadialGradient(tl.c.x, tl.c.y, 0, tl.c.x, tl.c.y, tl.r * 1.6);
      g.addColorStop(0, withA(hue, 0.13 * dim)); g.addColorStop(1, withA(hue, 0.04 * dim));
      ctx.fillStyle = g; ctx.fill();
      ctx.shadowColor = hue; ctx.shadowBlur = 16;
      ctx.strokeStyle = withA(hue, 0.85 * dim); ctx.lineWidth = 1.6 / Math.sqrt(this.cam.k);
      ctx.stroke();
      ctx.restore();
    }
  }

  private drawIntraEdges(ctx: CanvasRenderingContext2D) {
    ctx.lineWidth = 0.8 / this.cam.k;
    for (const a of this.store.agents.values()) {
      const p = this.pos.get(a.id);
      const parentId = a.parent && this.store.agents.get(a.parent)?.team === a.team ? a.parent : this.store.teams.get(a.team)?.lead;
      const q = parentId && parentId !== a.id ? this.pos.get(parentId) : undefined;
      if (!p || !q) continue;
      ctx.strokeStyle = withA(this.teamHue(a.team), a.status === 'idle' ? 0.12 : 0.3);
      ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); ctx.stroke();
    }
  }

  private drawParticles(ctx: CanvasRenderingContext2D, t: number) {
    const keep: Particle[] = [];
    for (const pt of this.particles) {
      const u = (t - pt.t0) / pt.dur;
      if (u > 1) { this.flashes.set(pt.to, t); continue; }
      keep.push(pt);
      if (u < 0) continue;
      const a = this.pos.get(pt.from), b = this.pos.get(pt.to);
      if (!a || !b) continue;
      const cp = { x: (a.x + b.x) / 2 - (b.y - a.y) * pt.bend, y: (a.y + b.y) / 2 + (b.x - a.x) * pt.bend };
      const e = u < 0.5 ? 2 * u * u : 1 - (-2 * u + 2) ** 2 / 2;
      const col = KIND_COLOR[pt.kind];
      const s = 1 / Math.sqrt(this.cam.k);
      for (let i = 4; i >= 0; i--) { // short trail
        const p = qbez(a, cp, b, Math.max(0, e - i * 0.025));
        ctx.globalAlpha = i === 0 ? 1 : 0.35 - i * 0.06;
        ctx.fillStyle = col;
        ctx.beginPath(); ctx.arc(p.x, p.y, (i === 0 ? 2.6 : 1.8) * s, 0, Math.PI * 2); ctx.fill();
      }
      const p = qbez(a, cp, b, e);
      ctx.globalAlpha = 0.25; ctx.beginPath(); ctx.arc(p.x, p.y, 7 * s, 0, Math.PI * 2); ctx.fill();
      if (pt.kind === 'approval' || pt.kind === 'steer') { // shape cue, not color alone
        ctx.globalAlpha = 1; ctx.strokeStyle = col; ctx.lineWidth = 1 * s;
        ctx.strokeRect(p.x - 4 * s, p.y - 4 * s, 8 * s, 8 * s);
      }
      ctx.globalAlpha = 1;
    }
    this.particles = keep;
  }

  private drawNodes(ctx: CanvasRenderingContext2D, t: number) {
    const s = 1 / Math.sqrt(this.cam.k);
    for (const a of this.store.agents.values()) {
      const p = this.pos.get(a.id);
      if (!p) continue;
      const hue = this.teamHue(a.team);
      const r = (a.role === 'cos' ? 9 : a.role === 'lead' ? 7 : 5) * Math.max(0.7, s);
      const col = a.status === 'needs' ? '#f5c542' : a.status === 'error' ? '#ff5c6c' : a.status === 'active' ? hue : '#566074';
      const fl = this.flashes.get(a.id);
      const flash = fl ? Math.max(0, 1 - (t - fl) / 500) : 0;
      if (a.status === 'active' || a.status === 'needs' || flash) {
        const pulse = REDUCED ? 0.5 : (Math.sin(t / 420 + (this.order.get(a.id) ?? 0)) + 1) / 2;
        ctx.globalAlpha = 0.18 + pulse * 0.15 + flash * 0.4;
        ctx.fillStyle = col;
        ctx.beginPath(); ctx.arc(p.x, p.y, r * (2.3 + pulse * 0.5 + flash), 0, Math.PI * 2); ctx.fill();
      }
      ctx.globalAlpha = a.status === 'idle' ? 0.75 : 1;
      ctx.fillStyle = '#0a0f1b';
      ctx.beginPath(); ctx.arc(p.x, p.y, r + 1.5 * s, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = col;
      ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = a.status === 'idle' ? '#8a93a6' : '#ffffff';
      ctx.globalAlpha = 0.85;
      ctx.beginPath(); ctx.arc(p.x, p.y, r * 0.38, 0, Math.PI * 2); ctx.fill();
      if (a.status === 'needs' || a.role === 'cos') {
        ctx.globalAlpha = 1; ctx.strokeStyle = a.role === 'cos' ? '#e8eefc' : '#f5c542'; ctx.lineWidth = 1.5 * s;
        ctx.beginPath(); ctx.arc(p.x, p.y, r + 5 * s, 0, Math.PI * 2); ctx.stroke();
      }
      if (a.id === this.focusAgent || a.id === this.hover) {
        ctx.globalAlpha = 1; ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1.2 * s;
        ctx.beginPath(); ctx.arc(p.x, p.y, r + 9 * s, 0, Math.PI * 2); ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
  }

  // Labels are drawn in screen space so text stays crisp at any zoom.
  private labelQueue: Array<{ p: P; text: string; color: string; size: number; align: CanvasTextAlign; bold?: boolean; box?: boolean }> = [];
  private queueLabel(p: P, text: string, color: string, size: number, align: CanvasTextAlign, bold = false, box = false) {
    this.labelQueue.push({ p, text, color, size, align, bold, box });
  }
  private toScreen(p: P): P { return { x: (p.x - this.cam.x) * this.cam.k + this.w / 2, y: (p.y - this.cam.y) * this.cam.k + this.h / 2 }; }

  private drawLabels(ctx: CanvasRenderingContext2D) {
    const k = this.cam.k;
    for (const [tid, tl] of this.teamLayout) {
      const team = this.store.teams.get(tid);
      if (!team) continue;
      let top = Infinity, cx = 0;
      for (const p of tl.hull) if (p.y < top) { top = p.y; cx = p.x; }
      const s = this.toScreen({ x: tl.c.x - tl.r * 0.55, y: top });
      void cx;
      const members = this.store.byTeam(tid);
      const active = members.filter((a) => a.status === 'active' || a.status === 'needs').length;
      ctx.font = `600 ${15}px ${getComputedStyle(document.body).fontFamily}`;
      ctx.fillStyle = team.hue; ctx.shadowColor = team.hue; ctx.shadowBlur = 8;
      ctx.beginPath(); ctx.arc(s.x, s.y - 16, 5, 0, Math.PI * 2); ctx.fill();
      ctx.shadowBlur = 0;
      ctx.fillStyle = '#eef2fb'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillText(tid === 'main' ? 'Main assistant · Chief of Staff' : team.name, s.x + 12, s.y - 16);
      ctx.font = `12px ${getComputedStyle(document.body).fontFamily}`;
      ctx.fillStyle = '#8b96ad';
      const t1 = `${members.length} agents  ·  `;
      ctx.fillText(t1, s.x + 12, s.y + 2);
      ctx.fillStyle = team.hue;
      ctx.fillText(`${active} active`, s.x + 12 + ctx.measureText(t1).width, s.y + 2);
    }
    const showAll = this.labels && k >= 1.15;
    const font = getComputedStyle(document.body).fontFamily;
    for (const a of this.store.agents.values()) {
      const p = this.pos.get(a.id);
      if (!p) continue;
      const imp = a.role === 'cos' || a.status === 'needs' || a.id === this.focusAgent;
      if (!showAll && !(imp && this.labels)) continue;
      if (!showAll && a.role !== 'cos' && k < 0.7) continue;
      const s = this.toScreen(p);
      if (s.x < -50 || s.y < -20 || s.x > this.w + 50 || s.y > this.h + 20) continue;
      ctx.font = `${a.role === 'worker' ? 11 : 12}px ${font}`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      ctx.fillStyle = a.status === 'idle' ? '#7f8aa0' : '#dfe6f5';
      ctx.fillText(a.role === 'cos' ? 'Chief of Staff' : a.name, s.x, s.y + 11);
      if (a.status === 'needs') {
        const txt = `${a.name} · waiting for approval`;
        ctx.font = `11px ${font}`;
        const w = ctx.measureText(txt).width + 14;
        ctx.fillStyle = 'rgba(10,14,24,.92)'; ctx.strokeStyle = '#5b4b1f'; ctx.lineWidth = 1;
        roundRect(ctx, s.x + 12, s.y - 30, w, 20, 4); ctx.fill(); ctx.stroke();
        ctx.fillStyle = '#e9d8a6'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
        ctx.fillText(txt, s.x + 19, s.y - 20);
      }
    }
    for (const l of this.labelQueue) {
      const s = this.toScreen(l.p);
      ctx.font = `${l.bold ? 600 : 400} ${l.size}px ${font}`;
      ctx.textAlign = l.align; ctx.textBaseline = 'middle';
      ctx.fillStyle = l.color; ctx.fillText(l.text, s.x, s.y - 8);
    }
    this.labelQueue = [];
  }

  private drawMini() {
    const m = this.mini, ctx = m.getContext('2d')!;
    ctx.clearRect(0, 0, m.width, m.height);
    const b = this.bounds();
    const sc = Math.min((m.width - 16) / (b.x1 - b.x0), (m.height - 16) / (b.y1 - b.y0));
    const tx = (x: number) => 8 + (x - b.x0) * sc, ty = (y: number) => 8 + (y - b.y0) * sc;
    for (const a of this.store.agents.values()) {
      const p = this.pos.get(a.id); if (!p) continue;
      ctx.fillStyle = a.status === 'idle' ? '#3a4356' : this.teamHue(a.team);
      ctx.fillRect(tx(p.x) - 1, ty(p.y) - 1, 2, 2);
    }
    const v0 = this.toWorld(0, 0), v1 = this.toWorld(this.w, this.h);
    ctx.strokeStyle = '#c9d4ee'; ctx.setLineDash([3, 2]); ctx.lineWidth = 1;
    ctx.strokeRect(tx(v0.x), ty(v0.y), (v1.x - v0.x) * sc, (v1.y - v0.y) * sc);
    ctx.setLineDash([]);
  }
}

// ---------- geometry helpers ----------
function qbez(a: P, c: P, b: P, u: number): P {
  const v = 1 - u;
  return { x: v * v * a.x + 2 * v * u * c.x + u * u * b.x, y: v * v * a.y + 2 * v * u * c.y + u * u * b.y };
}
function convexHull(pts: P[]): P[] {
  const p = [...pts].sort((a, b) => a.x - b.x || a.y - b.y);
  if (p.length < 3) return p;
  const cross = (o: P, a: P, b: P) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lo: P[] = [], hi: P[] = [];
  for (const q of p) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  for (const q of p.reverse()) { while (hi.length >= 2 && cross(hi[hi.length - 2], hi[hi.length - 1], q) <= 0) hi.pop(); hi.push(q); }
  return lo.slice(0, -1).concat(hi.slice(0, -1));
}
function smoothPath(ctx: CanvasRenderingContext2D, pts: P[]) {
  ctx.beginPath();
  const n = pts.length;
  if (n < 3) return;
  const mid = (a: P, b: P) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  let m = mid(pts[n - 1], pts[0]);
  ctx.moveTo(m.x, m.y);
  for (let i = 0; i < n; i++) {
    const p = pts[i], q = pts[(i + 1) % n];
    m = mid(p, q);
    ctx.quadraticCurveTo(p.x, p.y, m.x, m.y);
  }
  ctx.closePath();
}
function pointInPoly(p: P, poly: P[]) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}
function hex(c: string) { const n = parseInt(c.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
export function withA(c: string, a: number) { const [r, g, b] = hex(c); return `rgba(${r},${g},${b},${a})`; }
function mix(c1: string, c2: string, u: number) {
  const a = hex(c1), b = hex(c2);
  return `rgb(${a.map((v, i) => Math.round(v + (b[i] - v) * u)).join(',')})`;
}
export function esc(s: string) { return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`); }
export function fmtK(n: number) { return n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(Math.round(n)); }
export type { Team };
