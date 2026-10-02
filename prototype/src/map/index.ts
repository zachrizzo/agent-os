// Live fleet map: plain Canvas2D (no deps), god's-eye view of teams orbiting the Chief of Staff.
// Implements the frozen `CreateMap` contract from src/contract.ts.
import type { CreateMap, MapApi, Selection, State } from '../contract';
import { COS_ID, type Agent, type FleetEvent } from '../../shared/types';
import { Layout, hash, pointInPoly, type LTeam, type P } from './layout';
import { Pal, clip, esc, glow, mix, rgba, starTile } from './gfx';
import { onTheme } from '../theme';

const MAX_PARTICLES = 60;
const MAX_PINGS = 90;
const RATE_WINDOW = 60_000;
const BENCH = typeof location !== 'undefined' && new URLSearchParams(location.search).has('bench');
const reducedMq = typeof matchMedia !== 'undefined' ? matchMedia('(prefers-reduced-motion: reduce)') : null;

interface Seg { a: P; c: P; b: P }
interface Particle { from: string; to: string; color: string; t0: number; dur: number }
interface Ping { id: string; color: string; t0: number; dur: number; big: boolean }
interface Link { key: string; ta: string; tb: string; lead: boolean; rate: number }
interface Cam { x: number; y: number; k: number }
interface Counts { n: number; active: number; needs: number }

const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
const qpt = (s: Seg, t: number, o: P) => {
  const u = 1 - t;
  o.x = u * u * s.a.x + 2 * u * t * s.c.x + t * t * s.b.x;
  o.y = u * u * s.a.y + 2 * u * t * s.c.y + t * t * s.b.y;
  return o;
};
const segLen = (s: Seg) => (Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y) + Math.hypot(s.c.x - s.a.x, s.c.y - s.a.y) + Math.hypot(s.b.x - s.c.x, s.b.y - s.c.y)) / 2;
const rev = (s: Seg): Seg => ({ a: s.b, c: s.c, b: s.a });
function bent(a: P, b: P, bend: number): Seg {
  const dx = b.x - a.x, dy = b.y - a.y;
  return { a, b, c: { x: (a.x + b.x) / 2 - dy * bend, y: (a.y + b.y) / 2 + dx * bend } };
}

export const createMap: CreateMap = (el, store) => {
  // ---------- DOM ----------
  const root = document.createElement('div');
  root.className = 'aos-map';
  
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;touch-action:none;outline:none;';
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', 'Live fleet map');
  const mini = document.createElement('canvas');
  mini.className = 'aos-mini';
  const tip = document.createElement('div');
  tip.className = 'aos-tip';
  root.append(canvas, mini, tip);
  el.appendChild(root);
  const ctx = canvas.getContext('2d', { alpha: false })!;
  const mctx = mini.getContext('2d')!;

  // ---------- state ----------
  const layout = new Layout();
  let st: State = store.get();
  let w = 1, h = 1, dpr = 1;
  let stars: CanvasPattern | null = null;
  let starDpr = 0;
  let starMode = Pal.mode;
  const cam: Cam = { x: 0, y: 0, k: 0.8 };
  const target: Cam = { x: 0, y: 0, k: 0.8 };
  let autoFit = true;
  let fitSel: Selection | null = null;
  let firstFrame = true;
  let hover: string | null = null;
  let hoverTeam: string | null = null;
  let mouse: P | null = null;
  let particles: Particle[] = [];
  let pings: Ping[] = [];
  const surge = new Map<string, number>();
  const rateLog: Array<{ t: number; key: string }> = [];
  let rateStart = Date.now();
  let links: Link[] = [];
  let linksAt = 0;
  const counts = new Map<string, Counts>();
  let related = new Set<string>();
  let lastSnap: unknown = null;
  let lastZoom = st.zoom;
  let lastSelKey = '';
  const labelRects: Array<{ tid: string; x0: number; y0: number; x1: number; y1: number }> = [];
  let raf = 0;
  let alive = true;
  let lastT = performance.now();
  // bench
  let frames = 0, benchT0 = performance.now(), drawMs = 0, evCount = 0;

  const reduced = () => !!reducedMq?.matches;
  const selKey = (s: Selection) => (s.type === 'none' ? 'none' : `${s.type}:${s.id}`);
  const hidden = (tid: string) => st.hiddenTeams.has(tid);

  function focusTeam(sel: Selection = fitSel ?? st.selection): string | null {
    if (sel.type === 'team') return sel.id;
    if (sel.type === 'agent') return st.agentsById.get(sel.id)?.team ?? layout.nodes.get(sel.id)?.team ?? null;
    if (sel.type === 'event') {
      const ev = st.snapshot.events.find((e) => e.id === sel.id);
      return ev ? st.agentsById.get(ev.from)?.team ?? null : null;
    }
    return null;
  }
  function selectedAgent(): string | null {
    const s = fitSel ?? st.selection;
    if (s.type === 'agent') return s.id;
    if (s.type === 'event') return st.snapshot.events.find((e) => e.id === s.id)?.from ?? null;
    return null;
  }

  // ---------- ingest ----------
  function ingest(s: State, fresh: FleetEvent[]) {
    st = s;
    const now = performance.now();
    const initial = lastSnap === null;
    if (s.snapshot !== lastSnap) {
      layout.sync(s.snapshot.teams, s.snapshot.agents, now, initial);
      lastSnap = s.snapshot;
      counts.clear();
      for (const a of s.snapshot.agents) {
        let c = counts.get(a.team);
        if (!c) counts.set(a.team, (c = { n: 0, active: 0, needs: 0 }));
        c.n++;
        if (a.status === 'active') c.active++;
        if (a.status === 'needs') c.needs++;
      }
      if (initial) {
        const ref = s.snapshot.ts || Date.now();
        for (const e of s.snapshot.events) if (ref - e.ts < RATE_WINDOW) logRate(e, Date.now() - (ref - e.ts));
        rateStart = Date.now() - Math.min(RATE_WINDOW, Math.max(0, ...s.snapshot.events.map((e) => ref - e.ts)));
      }
    }
    const sk = selKey(s.selection);
    if (s.zoom !== lastZoom || sk !== lastSelKey) {
      lastZoom = s.zoom;
      lastSelKey = sk;
      fitSel = null;
      autoFit = true;
    }
    applyScales();
    computeRelated();
    if (fresh.length) launch(fresh, now);
  }

  function applyScales() {
    const ft = st.zoom === 'fleet' ? null : focusTeam();
    let changed = false;
    for (const t of layout.teams.values()) changed = layout.setScale(t.id, t.id === ft ? (st.zoom === 'team' ? 2.2 : 1.6) : 1) || changed;
    if (changed) layout.orbit();
  }

  function computeRelated() {
    related = new Set();
    const id = selectedAgent();
    if (!id) return;
    related.add(id);
    const a = st.agentsById.get(id);
    if (a?.parent) related.add(a.parent);
    for (const b of st.snapshot.agents) if (b.parent === id) related.add(b.id);
    const evs = st.snapshot.events;
    for (let i = evs.length - 1, n = 0; i >= 0 && n < 120; i--, n++) {
      const e = evs[i];
      if (e.from === id && e.to !== 'zach') related.add(e.to);
      else if (e.to === id) related.add(e.from);
    }
  }

  function pairKey(from: string, to: string): string | null {
    const ta = layout.nodes.get(from)?.team, tb = layout.nodes.get(to)?.team;
    if (!ta || !tb || ta === tb) return null;
    const c = layout.centerTeam;
    if (ta === c) return `L:${tb}`;
    if (tb === c) return `L:${ta}`;
    return ta < tb ? `A:${ta}|${tb}` : `A:${tb}|${ta}`;
  }
  function logRate(e: FleetEvent, t: number) {
    const k = pairKey(e.from, e.to === 'zach' ? COS_ID : e.to);
    if (k) rateLog.push({ t, key: k });
  }

  function launch(fresh: FleetEvent[], now: number) {
    evCount += fresh.length;
    const red = reduced();
    const tNow = Date.now();
    fresh.forEach((e, i) => {
      logRate(e, tNow);
      const to = e.to === 'zach' ? COS_ID : e.to;
      const fa = layout.nodes.get(e.from), fb = layout.nodes.get(to);
      if (!fa || !fb || hidden(fa.team) || hidden(fb.team)) return;
      const color = Pal.kind[e.kind] ?? Pal.kind.message;
      if (red || particles.length >= MAX_PARTICLES || fresh.length - i > MAX_PARTICLES) {
        // Aggregate: flash the endpoints + brighten the carrying link instead of another particle.
        const k = pairKey(e.from, to);
        if (k) surge.set(k, Math.min(1, (surge.get(k) ?? 0) + 0.12));
        if (red || pings.length < MAX_PINGS) pushPing({ id: to, color, t0: now, dur: red ? 900 : 500, big: false });
        if (red && pings.length < MAX_PINGS) pushPing({ id: e.from, color, t0: now, dur: 900, big: false });
        return;
      }
      const segs = route(e.from, to);
      const len = segs ? segs.reduce((s, x) => s + segLen(x), 0) * cam.k : 300;
      particles.push({ from: e.from, to, color, t0: now + (i % 6) * 40, dur: Math.max(500, Math.min(900, 420 + len * 0.9)) });
    });
  }
  function pushPing(p: Ping) {
    if (pings.length >= MAX_PINGS) pings.shift();
    pings.push(p);
  }

  // ---------- geometry ----------
  const tmpA: P = { x: 0, y: 0 };
  function pos(id: string): P | null { return layout.world(id, { x: 0, y: 0 }); }
  function cosP(): P { return pos(COS_ID) ?? { x: 0, y: 0 }; }
  function leadP(t: LTeam): P { return (t.lead && pos(t.lead)) || { x: t.cx, y: t.cy }; }
  function leadSeg(tid: string): Seg | null {
    const t = layout.teams.get(tid);
    if (!t) return null;
    const a = leadP(t), b = cosP();
    return bent(a, b, (t.idx % 2 ? 1 : -1) * 0.1);
  }
  function arcSeg(ta: string, tb: string): Seg | null {
    const A = layout.teams.get(ta), B = layout.teams.get(tb);
    if (!A || !B) return null;
    const flip = ta > tb;
    const [p, q] = flip ? [B, A] : [A, B];
    const mx = (p.cx + q.cx) / 2, my = (p.cy + q.cy) / 2;
    const dist = Math.hypot(q.cx - p.cx, q.cy - p.cy) || 1;
    let nx = mx, ny = my, nl = Math.hypot(nx, ny);
    if (nl < 1e-3) { nx = -(q.cy - p.cy); ny = q.cx - p.cx; nl = dist; }
    nx /= nl; ny /= nl;
    const c = layout.centerTeam ? layout.teams.get(layout.centerTeam) : undefined;
    const rc = c ? (c.rEst + 40) * c.s : 0;
    const bend = dist * 0.16 + Math.max(0, rc * 1.6 - nl);
    const ctrl = { x: mx + nx * bend, y: my + ny * bend };
    const edge = (t: LTeam) => {
      const dx = ctrl.x - t.cx, dy = ctrl.y - t.cy, d = Math.hypot(dx, dy) || 1;
      const r = (t.rEst + 16) * t.s;
      return { x: t.cx + (dx / d) * r, y: t.cy + (dy / d) * r };
    };
    const s = { a: edge(p), c: ctrl, b: edge(q) };
    return flip ? rev(s) : s;
  }
  function route(from: string, to: string): Seg[] | null {
    const A = pos(from), B = pos(to);
    const na = layout.nodes.get(from), nb = layout.nodes.get(to);
    if (!A || !B || !na || !nb) return null;
    const ta = na.team, tb = nb.team, c = layout.centerTeam;
    if (ta === tb) return [bent(A, B, 0.16)];
    const out: Seg[] = [];
    const tA = layout.teams.get(ta)!, tB = layout.teams.get(tb)!;
    if (ta === c || tb === c) {
      const far = ta === c ? tB : tA;
      const ls = leadSeg(far.id)!; // lead -> CoS
      const cos = cosP();
      const lp = ls.a;
      if (ta === c) {
        if (from !== COS_ID) out.push(bent(A, cos, 0.1));
        out.push(rev(ls));
        if (to !== far.lead) out.push(bent(lp, B, 0.12));
      } else {
        if (from !== far.lead) out.push(bent(A, lp, 0.12));
        out.push(ls);
        if (to !== COS_ID) out.push(bent(cos, B, 0.1));
      }
      return out;
    }
    const arc = arcSeg(ta, tb)!;
    out.push(bent(A, arc.a, 0.08), arc, bent(arc.b, B, 0.08));
    return out;
  }

  function rebuildLinks() {
    const now = Date.now();
    let i = 0;
    while (i < rateLog.length && now - rateLog[i].t > RATE_WINDOW) i++;
    if (i) rateLog.splice(0, i);
    const elapsed = Math.min(RATE_WINDOW, Math.max(10_000, now - rateStart));
    const per = new Map<string, number>();
    for (const r of rateLog) per.set(r.key, (per.get(r.key) ?? 0) + 1);
    const scale = 60_000 / elapsed;
    const out: Link[] = [];
    const c = layout.centerTeam;
    for (const t of layout.teams.values()) {
      if (t.id === c || !t.members.length) continue;
      out.push({ key: `L:${t.id}`, ta: t.id, tb: c ?? '', lead: true, rate: (per.get(`L:${t.id}`) ?? 0) * scale });
    }
    const arcs: Link[] = [];
    for (const [k, n] of per) {
      if (!k.startsWith('A:')) continue;
      const [ta, tb] = k.slice(2).split('|');
      if (!layout.teams.has(ta) || !layout.teams.has(tb)) continue;
      arcs.push({ key: k, ta, tb, lead: false, rate: n * scale });
    }
    arcs.sort((a, b) => b.rate - a.rate);
    links = out.concat(arcs.filter((a) => a.rate >= 2).slice(0, 5));
  }

  // ---------- camera ----------
  function bounds(tids: string[]): { x0: number; y0: number; x1: number; y1: number } | null {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const tid of tids) {
      const t = layout.teams.get(tid);
      if (!t) continue;
      // Use target geometry so the fit doesn't chase easing.
      let ext = 0;
      for (const n of t.members) if (!n.dying) ext = Math.max(ext, Math.hypot(n.lx, n.ly));
      const r = (Math.max(ext, 12) + 34) * t.ts * 1.06;
      x0 = Math.min(x0, t.tx - r); x1 = Math.max(x1, t.tx + r);
      y0 = Math.min(y0, t.ty - r); y1 = Math.max(y1, t.ty + r);
    }
    return isFinite(x0) ? { x0, y0, x1, y1 } : null;
  }
  function fitTarget(): Cam | null {
    const z = st.zoom;
    const visible = [...layout.teams.values()].filter((t) => t.members.length && !hidden(t.id)).map((t) => t.id);
    const padT = 92, padB = 64, padX = 48;
    const fit = (b: { x0: number; y0: number; x1: number; y1: number }, kMax: number): Cam => {
      const k = Math.max(0.12, Math.min(kMax, (w - padX * 2) / (b.x1 - b.x0), (h - padT - padB) / (b.y1 - b.y0)));
      return { x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 - (padT - padB) / 2 / k, k };
    };
    const sa = selectedAgent();
    if (z === 'agent' && sa && layout.nodes.has(sa)) {
      const n = layout.nodes.get(sa)!;
      const t = layout.teams.get(n.team)!;
      const p = { x: t.tx + n.lx * t.ts, y: t.ty + n.ly * t.ts };
      const b = bounds([n.team]);
      const k = b ? Math.min(2.6, Math.max(1.1, fit(b, 3).k * 0.9)) : 1.6;
      return { x: p.x, y: p.y, k };
    }
    const ft = z === 'team' ? focusTeam() : null;
    if (ft && layout.teams.has(ft)) {
      const b = bounds([ft]);
      if (b) {
        const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2, hw = (b.x1 - b.x0) * 0.56, hh = (b.y1 - b.y0) * 0.56;
        return fit({ x0: cx - hw, x1: cx + hw, y0: cy - hh, y1: cy + hh }, 2.4);
      }
    }
    const b = bounds(visible);
    return b ? fit(b, 1.35) : null;
  }

  // ---------- frame ----------
  function frame(t: number) {
    if (!alive) return;
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.1, (t - lastT) / 1000);
    lastT = t;
    const red = reduced();
    const t0 = performance.now();
    layout.step(dt, t, red || firstFrame);
    if (t - linksAt > 500) { rebuildLinks(); linksAt = t; }
    if (autoFit) {
      const ft = fitTarget();
      if (ft) Object.assign(target, ft);
    }
    const e = red || firstFrame ? 1 : 1 - Math.exp(-dt * 7);
    cam.x += (target.x - cam.x) * e;
    cam.y += (target.y - cam.y) * e;
    cam.k = Math.exp(Math.log(cam.k) + (Math.log(target.k) - Math.log(cam.k)) * e);
    firstFrame = false;
    layout.hulls(red ? 0 : t / 1000);
    draw(t, red);
    if ((frames & 3) === 0) drawMini();
    drawMs += performance.now() - t0;
    frames++;
    if (BENCH && t - benchT0 > 2000) {
      const fps = (frames * 1000) / (t - benchT0);
      const stats = { fps: +fps.toFixed(1), frameMs: +(drawMs / frames).toFixed(2), agents: layout.nodes.size, particles: particles.length, evPerSec: +((evCount * 1000) / (t - benchT0)).toFixed(1) };
      (window as unknown as { __mapStats: unknown }).__mapStats = stats;
      console.log(`[map bench] fps=${stats.fps} frame=${stats.frameMs}ms agents=${stats.agents} particles=${stats.particles} events/s=${stats.evPerSec}`);
      frames = 0; drawMs = 0; evCount = 0; benchT0 = t;
    }
  }

  function draw(now: number, red: boolean) {
    const k = cam.k;
    const zoom = st.zoom;
    const ft = zoom === 'fleet' ? (st.selection.type === 'team' ? st.selection.id : null) : focusTeam();
    const sa = selectedAgent();
    const agentMode = zoom === 'agent' && !!sa;
    const time = now / 1000;

    // background
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.fillStyle = Pal.bg;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const bg = ctx.createRadialGradient(canvas.width / 2, canvas.height * 0.48, 0, canvas.width / 2, canvas.height * 0.48, Math.max(canvas.width, canvas.height) * 0.65);
    bg.addColorStop(0, Pal.glowA);
    bg.addColorStop(0.55, Pal.glowB);
    bg.addColorStop(1, rgba(Pal.bg, 0)); // same hue at alpha 0: a transparent-black end would grey the fade
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (stars) {
      const tile = 480 * dpr;
      const ox = ((-cam.x * k * 0.05 * dpr) % tile + tile) % tile, oy = ((-cam.y * k * 0.05 * dpr) % tile + tile) % tile;
      stars.setTransform(new DOMMatrix([1, 0, 0, 1, ox, oy]));
      ctx.fillStyle = stars;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }

    // world transform
    ctx.setTransform(dpr * k, 0, 0, dpr * k, dpr * (w / 2 - cam.x * k), dpr * (h / 2 - cam.y * k));
    const px = 1 / k; // one screen pixel in world units
    const teams = [...layout.teams.values()].filter((t) => t.members.length && !hidden(t.id) && t.hull.length);
    const teamAlpha = (t: LTeam) => (agentMode ? (t.id === ft ? 0.75 : 0.28) : zoom === 'team' && ft && t.id !== ft ? 0.55 : 1);

    // hull fills
    for (const t of teams) {
      const hue = t.team.hue, ta = teamAlpha(t);
      const R = (t.rEst + 40) * t.s;
      const g = ctx.createRadialGradient(t.cx, t.cy, 0, t.cx, t.cy, R);
      g.addColorStop(0, rgba(hue, 0.16 * ta));
      g.addColorStop(1, rgba(hue, 0.045 * ta));
      ctx.fillStyle = g;
      hullPath(t.hull);
      ctx.fill();
    }

    // links (CoS spokes + bundled cross-team arcs)
    ctx.lineCap = 'round';
    const dashT = red ? 0 : now * 0.03;
    for (const L of links) {
      if (hidden(L.ta) || (L.tb && hidden(L.tb))) continue;
      const s = L.lead ? leadSeg(L.ta) : arcSeg(L.ta, L.tb);
      if (!s) continue;
      const A = layout.teams.get(L.ta)!, B = L.tb ? layout.teams.get(L.tb) : undefined;
      const ca = A.team.hue, cb = L.lead ? Pal.cos : B?.team.hue ?? Pal.idle;
      const sg = surge.get(L.key) ?? 0;
      const focusHit = !ft || L.ta === ft || L.tb === ft;
      const la = (agentMode ? (focusHit ? 0.55 : 0.12) : focusHit ? 1 : 0.4) * (L.lead ? 0.85 : 1);
      const wpx = L.lead ? 1.1 + Math.min(2.2, Math.log2(1 + L.rate) * 0.45) : 1.4 + Math.min(4, Math.log2(1 + L.rate) * 0.85);
      const grad = ctx.createLinearGradient(s.a.x, s.a.y, s.b.x, s.b.y);
      grad.addColorStop(0, rgba(ca, (0.16 + sg * 0.3) * la));
      grad.addColorStop(1, rgba(cb, (0.16 + sg * 0.3) * la));
      ctx.strokeStyle = grad;
      ctx.lineWidth = (wpx + 4) * px;
      ctx.beginPath(); ctx.moveTo(s.a.x, s.a.y); ctx.quadraticCurveTo(s.c.x, s.c.y, s.b.x, s.b.y); ctx.stroke();
      const g2 = ctx.createLinearGradient(s.a.x, s.a.y, s.b.x, s.b.y);
      g2.addColorStop(0, rgba(mix(ca, Pal.hot, 0.25), 0.85 * la));
      g2.addColorStop(1, rgba(mix(cb, Pal.hot, 0.25), 0.85 * la));
      ctx.strokeStyle = g2;
      ctx.lineWidth = Math.max(1.6, wpx * 0.8) * px;
      ctx.setLineDash([0.01, (L.lead ? 7 : 9) * px]);
      ctx.lineDashOffset = (L.lead ? dashT : -dashT) * px;
      ctx.stroke();
      ctx.setLineDash([]);
      if (sg) surge.set(L.key, sg * 0.96 < 0.01 ? 0 : sg * 0.96);
    }

    // intra-team edges (parent -> child)
    ctx.lineWidth = 0.9 * px;
    for (const t of teams) {
      ctx.strokeStyle = rgba(t.team.hue, 0.32 * teamAlpha(t));
      ctx.beginPath();
      for (const n of t.members) {
        const par = n.agent.parent;
        if (!par || n.dying) continue;
        const pn = layout.nodes.get(par);
        if (!pn || pn.team !== t.id) continue;
        ctx.moveTo(t.cx + pn.lx * t.s, t.cy + pn.ly * t.s);
        ctx.lineTo(t.cx + n.lx * t.s, t.cy + n.ly * t.s);
      }
      ctx.stroke();
    }

    // hull strokes
    for (const t of teams) {
      const hue = t.team.hue, ta = teamAlpha(t);
      const hot = t.id === hoverTeam || t.id === ft;
      hullPath(t.hull);
      ctx.strokeStyle = rgba(hue, 0.07 * ta);
      ctx.lineWidth = 9 * px; ctx.stroke();
      ctx.strokeStyle = rgba(hue, 0.16 * ta);
      ctx.lineWidth = 3.5 * px; ctx.stroke();
      ctx.strokeStyle = rgba(mix(hue, Pal.hot, 0.15), (hot ? 0.95 : 0.7) * ta);
      ctx.lineWidth = (hot ? 1.8 : 1.25) * px; ctx.stroke();
    }

    // agent-mode highlight edges
    if (agentMode && sa) {
      const sp = pos(sa);
      if (sp) {
        ctx.strokeStyle = Pal.linkHi;
        ctx.lineWidth = 1.4 * px;
        ctx.beginPath();
        for (const id of related) {
          if (id === sa) continue;
          const segs = route(sa, id);
          if (!segs) continue;
          for (const s of segs) { ctx.moveTo(s.a.x, s.a.y); ctx.quadraticCurveTo(s.c.x, s.c.y, s.b.x, s.b.y); }
        }
        ctx.stroke();
      }
    }

    // agents
    const rs = Math.min(1.7, Math.max(0.75, Math.sqrt(k)));
    const cores = new Map<string, number[]>();
    const rings = new Map<string, number[]>();
    const addTo = (m: Map<string, number[]>, key: string, x: number, y: number, r: number) => {
      let a = m.get(key);
      if (!a) m.set(key, (a = []));
      a.push(x, y, r);
    };
    ctx.globalCompositeOperation = Pal.blend;
    for (const t of teams) {
      const hue = t.team.hue;
      const ta = teamAlpha(t);
      for (const n of t.members) {
        const a = n.agent;
        const x = t.cx + n.lx * t.s, y = t.cy + n.ly * t.s;
        const age = n.born < 0 ? 1 : Math.min(1, (now - n.born) / 650);
        const fade = n.dying ? Math.max(0, 1 - (now - n.dying) / 600) : age * age * (3 - 2 * age);
        if (fade <= 0.01) continue;
        let al = fade * (agentMode ? (related.has(a.id) ? 1 : 0.16) : ta < 1 ? 0.6 + ta * 0.4 : 1);
        if (a.retired) al *= 0.4; // History view: finished sessions recede
        const isCos = a.id === COS_ID, isLead = a.role === 'lead' || n.fixed;
        const base = isCos ? 7.5 : isLead ? 4.6 : 3.4;
        const r = base * rs * (0.5 + 0.5 * fade) * px;
        const st2 = a.status;
        const col = isCos ? Pal.cos : st2 === 'needs' ? Pal.amber : st2 === 'error' ? Pal.red : st2 === 'active' ? hue : mix(Pal.idle, hue, 0.18);
        const bright = st2 !== 'idle' || isCos;
        if (bright) {
          const gs = (isCos ? 64 : isLead ? 34 : 26) * rs * px;
          ctx.globalAlpha = al * (st2 === 'needs' ? 1 : 0.85);
          ctx.drawImage(glow(col), x - gs / 2, y - gs / 2, gs, gs);
        } else al *= 0.75;
        const q = Math.round(al * 10) / 10;
        addTo(cores, `${bright ? mix(col, Pal.hot, isCos ? 0.5 : 0.22) : col}|${q}`, x, y, r);
        // rings
        if (st2 === 'needs') {
          addTo(rings, `${Pal.amber}|${Math.round(q * 9) / 10}|1.6`, x, y, r + 3.2 * px);
          if (!red) { const ph = (time * 0.7 + hash(a.id)) % 1; addTo(rings, `${Pal.amber}|${Math.round((1 - ph) * q * 6) / 10}|1.2`, x, y, r + (3 + ph * 9) * px); }
        } else if (st2 === 'error') addTo(rings, `${Pal.red}|${q}|1.4`, x, y, r + 3 * px);
        else if (st2 === 'active' || isCos) {
          if (red) addTo(rings, `${col}|${Math.round(q * 5) / 10}|1`, x, y, r + 3 * px);
          else { const ph = (time / 1.8 + hash(a.id)) % 1; addTo(rings, `${col}|${Math.round((1 - ph) * q * 6) / 10}|1.1`, x, y, r + (2 + ph * 8) * px); }
          if (isLead || isCos) addTo(rings, `${col}|${Math.round(q * 6) / 10}|1.2`, x, y, r + 3 * px);
        } else addTo(rings, `${col}|${Math.round(q * 4) / 10}|0.9`, x, y, r + 2.2 * px);
      }
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    for (const [key, arr] of rings) {
      const [c, a, lw] = key.split('|');
      if (+a <= 0) continue;
      ctx.strokeStyle = rgba(c, +a);
      ctx.lineWidth = +lw * px;
      ctx.beginPath();
      for (let i = 0; i < arr.length; i += 3) { ctx.moveTo(arr[i] + arr[i + 2], arr[i + 1]); ctx.arc(arr[i], arr[i + 1], arr[i + 2], 0, Math.PI * 2); }
      ctx.stroke();
    }
    for (const [key, arr] of cores) {
      const [c, a] = key.split('|');
      ctx.fillStyle = rgba(c, +a);
      ctx.beginPath();
      for (let i = 0; i < arr.length; i += 3) { ctx.moveTo(arr[i] + arr[i + 2], arr[i + 1]); ctx.arc(arr[i], arr[i + 1], arr[i + 2], 0, Math.PI * 2); }
      ctx.fill();
    }

    // selection / hover rings
    const ringAt = (id: string, color: string, extra: number, lw: number) => {
      const p = pos(id); const n = layout.nodes.get(id);
      if (!p || !n || hidden(n.team)) return;
      const base = id === COS_ID ? 7.5 : n.fixed ? 4.6 : 3.4;
      ctx.strokeStyle = color; ctx.lineWidth = lw * px;
      ctx.beginPath(); ctx.arc(p.x, p.y, (base * rs + extra) * px, 0, Math.PI * 2); ctx.stroke();
    };
    if (sa) ringAt(sa, Pal.ring, 6, 1.8);
    if (hover && hover !== sa) ringAt(hover, Pal.ringHover, 5, 1.2);

    // pings (arrivals / reduced-motion flashes)
    pings = pings.filter((p) => now - p.t0 < p.dur);
    for (const p of pings) {
      const q = pos(p.id);
      if (!q) continue;
      const u = Math.max(0, (now - p.t0) / p.dur);
      ctx.strokeStyle = rgba(p.color, (1 - u) * 0.8);
      ctx.lineWidth = 1.4 * px;
      ctx.beginPath();
      ctx.arc(q.x, q.y, (red ? 9 : 4 + u * 12) * px, 0, Math.PI * 2);
      ctx.stroke();
    }

    // particles
    ctx.globalCompositeOperation = Pal.blend;
    const keep: Particle[] = [];
    for (const p of particles) {
      const u = (now - p.t0) / p.dur;
      if (u < 0) { keep.push(p); continue; }
      if (u >= 1) { pushPing({ id: p.to, color: p.color, t0: now, dur: 450, big: false }); continue; }
      const n1 = layout.nodes.get(p.from), n2 = layout.nodes.get(p.to);
      if (!n1 || !n2 || hidden(n1.team) || hidden(n2.team)) continue;
      const segs = route(p.from, p.to);
      if (!segs) continue;
      keep.push(p);
      const lens = segs.map(segLen);
      const total = lens.reduce((s, x) => s + x, 0) || 1;
      const at = (v: number) => {
        let d = Math.max(0, Math.min(1, v)) * total, i = 0;
        while (i < segs.length - 1 && d > lens[i]) { d -= lens[i]; i++; }
        return qpt(segs[i], lens[i] ? d / lens[i] : 0, tmpA);
      };
      const spr = glow(p.color, 0.6);
      const dim = agentMode && !(related.has(p.from) && related.has(p.to)) ? 0.25 : 1;
      for (let j = 4; j >= 0; j--) {
        const v = easeInOut(Math.max(0, u - j * 0.035));
        const q = at(v);
        const s = (j === 0 ? 16 : 12 - j * 1.6) * px * Math.min(1.4, Math.max(0.8, rs));
        ctx.globalAlpha = (j === 0 ? 1 : 0.5 - j * 0.09) * dim;
        ctx.drawImage(spr, q.x - s / 2, q.y - s / 2, s, s);
      }
    }
    particles = keep;
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';

    // ---------- screen-space labels ----------
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const toS = (p: P) => ({ x: (p.x - cam.x) * k + w / 2, y: (p.y - cam.y) * k + h / 2 });
    ctx.textBaseline = 'alphabetic';

    // team labels
    labelRects.length = 0;
    for (const t of teams) {
      const c = counts.get(t.id) ?? { n: 0, active: 0, needs: 0 };
      const big = (zoom === 'team' || zoom === 'agent') && t.id === ft;
      const ta = agentMode && t.id !== ft ? 0.45 : 1;
      const top = toS(t.top);
      const y = top.y - 12;
      const nameFont = `600 ${big ? 17 : 14.5}px ${Pal.font}`;
      const subFont = `400 ${big ? 12.5 : 11.5}px ${Pal.font}`;
      const name = t.team.name;
      const subA = `${c.n} agent${c.n === 1 ? '' : 's'}  ·  `, subB = `${c.active} active`, subC = c.needs ? `  ·  ${c.needs} needs you` : '';
      ctx.font = nameFont; const nw = ctx.measureText(name).width;
      ctx.font = subFont; const sw = ctx.measureText(subA).width, sbw = ctx.measureText(subB).width, scw = subC ? ctx.measureText(subC).width : 0;
      const icon = big ? 22 : 19;
      const totalW = Math.max(nw + icon, sw + sbw + scw + icon);
      const x0 = top.x - totalW / 2;
      const lh = big ? 19 : 17;
      // icon: ring + dot
      const ix = x0 + 6, iy = y - lh - 5;
      ctx.globalAlpha = ta;
      ctx.fillStyle = rgba(t.team.hue, 0.25);
      ctx.beginPath(); ctx.arc(ix, iy, 7, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = rgba(t.team.hue, 0.9); ctx.lineWidth = 1.3;
      ctx.beginPath(); ctx.arc(ix, iy, 7, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = t.team.hue;
      ctx.beginPath(); ctx.arc(ix, iy, 3.2, 0, Math.PI * 2); ctx.fill();
      ctx.textAlign = 'left';
      ctx.font = nameFont;
      shadowText(name, x0 + icon, y - lh, Pal.fg);
      ctx.font = subFont;
      shadowText(subA, x0 + icon, y, Pal.muted);
      shadowText(subB, x0 + icon + sw, y, mix(t.team.hue, Pal.hot, 0.15));
      if (subC) shadowText(subC, x0 + icon + sw + sbw, y, Pal.amber);
      ctx.globalAlpha = 1;
      labelRects.push({ tid: t.id, x0: x0 - 4, y0: iy - 10, x1: x0 + totalW + 4, y1: y + 5 });
    }

    // link rate labels (top 5)
    const labeled = links.filter((l) => l.rate >= 1 && !hidden(l.ta) && !(l.tb && hidden(l.tb))).sort((a, b) => b.rate - a.rate).slice(0, 5);
    ctx.font = `500 11px ${Pal.font}`;
    ctx.textAlign = 'center';
    for (const L of labeled) {
      if (agentMode && L.ta !== ft && L.tb !== ft) continue;
      const s = L.lead ? leadSeg(L.ta) : arcSeg(L.ta, L.tb);
      if (!s) continue;
      const m = toS(qpt(s, 0.5, { x: 0, y: 0 }));
      const txt = `${Math.round(L.rate)} msg/min`;
      const tw = ctx.measureText(txt).width;
      if (labelRects.some((r) => m.x + tw / 2 + 7 > r.x0 && m.x - tw / 2 - 7 < r.x1 && m.y + 2 > r.y0 && m.y - 16 < r.y1)) continue;
      ctx.fillStyle = Pal.chipBg;
      roundRect(m.x - tw / 2 - 7, m.y - 16, tw + 14, 18, 9);
      ctx.fill();
      ctx.fillStyle = Pal.chipText;
      ctx.fillText(txt, m.x, m.y - 3);
    }

    // agent names (semantic zoom)
    for (const t of teams) {
      const showAll = ((zoom === 'team' || zoom === 'agent') && t.id === ft) || k * t.s >= 1.9;
      const showNow = showAll && t.members.length <= 26 && zoom !== 'agent';
      for (const n of t.members) {
        if (n.dying) continue;
        const a = n.agent;
        const isCos = a.id === COS_ID;
        const isHover = a.id === hover;
        if (!showAll && !isCos && !isHover && !(agentMode && related.has(a.id))) continue;
        if (agentMode && a.id === sa) continue; // callout below
        const p = toS({ x: t.cx + n.lx * t.s, y: t.cy + n.ly * t.s });
        if (p.x < -60 || p.x > w + 60 || p.y < -30 || p.y > h + 30) continue;
        const base = isCos ? 7.5 : n.fixed ? 4.6 : 3.4;
        const dy = base * rs + 13;
        ctx.textAlign = 'center';
        const dimmed = agentMode && !related.has(a.id);
        ctx.globalAlpha = dimmed ? 0.3 : 1;
        ctx.font = isCos ? `600 12.5px ${Pal.font}` : `500 11px ${Pal.font}`;
        shadowText(isCos ? 'Chief of Staff' : a.name, p.x, p.y + dy, isCos ? mix(Pal.cos, Pal.fg, 0.35) : Pal.fg);
        if ((showNow || isHover) && a.now && !isCos) {
          ctx.font = `400 10px ${Pal.font}`;
          shadowText(clip(a.now, 30), p.x, p.y + dy + 12.5, a.status === 'needs' ? Pal.amber : Pal.muted);
        }
        ctx.globalAlpha = 1;
      }
    }

    // agent-mode callout
    if (agentMode && sa) {
      const a = st.agentsById.get(sa) ?? layout.nodes.get(sa)?.agent;
      const wp = pos(sa);
      if (a && wp) {
        const p = toS(wp);
        callout(a, p.x + 18, p.y - 30);
      }
    }
  }

  function callout(a: Agent, x: number, y: number) {
    const team = layout.teams.get(a.team)?.team;
    const l1 = a.id === COS_ID ? 'Chief of Staff' : a.name;
    const l2 = `${team?.name ?? a.team} · ${a.status}`;
    const l3 = clip(a.now || '—', 44);
    ctx.font = `600 13px ${Pal.font}`; const w1 = ctx.measureText(l1).width;
    ctx.font = `400 11px ${Pal.font}`; const w2 = Math.max(ctx.measureText(l2).width, ctx.measureText(l3).width);
    const bw = Math.max(w1, w2) + 22, bh = 58;
    const bx = Math.min(x, w - bw - 8), by = Math.max(8, y - bh / 2);
    ctx.fillStyle = rgba(Pal.tipBg, 0.96);
    roundRect(bx, by, bw, bh, 8); ctx.fill();
    ctx.strokeStyle = team ? rgba(team.hue, 0.55) : Pal.tipBorder; ctx.lineWidth = 1; ctx.stroke();
    ctx.textAlign = 'left';
    ctx.font = `600 13px ${Pal.font}`; ctx.fillStyle = Pal.fg; ctx.fillText(l1, bx + 11, by + 19);
    ctx.font = `400 11px ${Pal.font}`;
    ctx.fillStyle = a.status === 'needs' ? Pal.amber : a.status === 'error' ? Pal.red : Pal.muted; ctx.fillText(l2, bx + 11, by + 35);
    ctx.fillStyle = Pal.fg2; ctx.fillText(l3, bx + 11, by + 50);
  }

  function shadowText(s: string, x: number, y: number, color: string) {
    ctx.lineWidth = 3;
    ctx.lineJoin = 'round';
    ctx.strokeStyle = Pal.halo;
    ctx.strokeText(s, x, y);
    ctx.fillStyle = color;
    ctx.fillText(s, x, y);
  }
  function roundRect(x: number, y: number, ww: number, hh: number, r: number) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + ww, y, x + ww, y + hh, r);
    ctx.arcTo(x + ww, y + hh, x, y + hh, r);
    ctx.arcTo(x, y + hh, x, y, r);
    ctx.arcTo(x, y, x + ww, y, r);
    ctx.closePath();
  }
  function hullPath(pts: P[]) {
    const n = pts.length;
    ctx.beginPath();
    const m0x = (pts[n - 1].x + pts[0].x) / 2, m0y = (pts[n - 1].y + pts[0].y) / 2;
    ctx.moveTo(m0x, m0y);
    for (let i = 0; i < n; i++) {
      const p = pts[i], q = pts[(i + 1) % n];
      ctx.quadraticCurveTo(p.x, p.y, (p.x + q.x) / 2, (p.y + q.y) / 2);
    }
    ctx.closePath();
  }

  // ---------- minimap ----------
  let miniView = { x0: 0, y0: 0, s: 1, ox: 0, oy: 0 };
  function drawMini() {
    const mw = 176, mh = 112;
    const md = dpr;
    if (mini.width !== mw * md) { mini.width = mw * md; mini.height = mh * md; }
    mctx.setTransform(md, 0, 0, md, 0, 0);
    mctx.clearRect(0, 0, mw, mh);
    const b = bounds([...layout.teams.values()].filter((t) => t.members.length).map((t) => t.id));
    if (!b) return;
    const s = Math.min((mw - 16) / (b.x1 - b.x0), (mh - 16) / (b.y1 - b.y0));
    const ox = (mw - (b.x1 - b.x0) * s) / 2, oy = (mh - (b.y1 - b.y0) * s) / 2;
    miniView = { x0: b.x0, y0: b.y0, s, ox, oy };
    const M = (x: number, y: number) => [ox + (x - b.x0) * s, oy + (y - b.y0) * s] as const;
    for (const t of layout.teams.values()) {
      if (!t.members.length || hidden(t.id)) continue;
      if (t.hull.length) {
        mctx.beginPath();
        t.hull.forEach((p, i) => { const [x, y] = M(p.x, p.y); if (i) mctx.lineTo(x, y); else mctx.moveTo(x, y); });
        mctx.closePath();
        mctx.fillStyle = rgba(t.team.hue, 0.12); mctx.fill();
        mctx.strokeStyle = rgba(t.team.hue, 0.45); mctx.lineWidth = 0.8; mctx.stroke();
      }
      for (const n of t.members) {
        if (n.dying) continue;
        const [x, y] = M(t.cx + n.lx * t.s, t.cy + n.ly * t.s);
        const on = n.agent.status !== 'idle';
        mctx.fillStyle = n.agent.status === 'needs' ? Pal.amber : on ? t.team.hue : Pal.miniIdle;
        mctx.fillRect(x - (on ? 1 : 0.6), y - (on ? 1 : 0.6), on ? 2 : 1.2, on ? 2 : 1.2);
      }
    }
    // viewport
    const [vx0, vy0] = M(cam.x - w / 2 / cam.k, cam.y - h / 2 / cam.k);
    const [vx1, vy1] = M(cam.x + w / 2 / cam.k, cam.y + h / 2 / cam.k);
    mctx.setLineDash([3, 2]);
    mctx.strokeStyle = Pal.miniView;
    mctx.lineWidth = 1;
    mctx.strokeRect(Math.max(1, vx0), Math.max(1, vy0), Math.min(mw - 2, vx1) - Math.max(1, vx0), Math.min(mh - 2, vy1) - Math.max(1, vy0));
    mctx.setLineDash([]);
  }

  // ---------- picking ----------
  const toWorld = (sx: number, sy: number): P => ({ x: (sx - w / 2) / cam.k + cam.x, y: (sy - h / 2) / cam.k + cam.y });
  function pickAgent(sx: number, sy: number): string | null {
    const wp = toWorld(sx, sy);
    const rs = Math.min(1.7, Math.max(0.75, Math.sqrt(cam.k)));
    let best: string | null = null, bd = Infinity;
    for (const t of layout.teams.values()) {
      if (hidden(t.id)) continue;
      for (const n of t.members) {
        if (n.dying) continue;
        const dx = t.cx + n.lx * t.s - wp.x, dy = t.cy + n.ly * t.s - wp.y;
        const d = dx * dx + dy * dy;
        const base = n.id === COS_ID ? 7.5 : n.fixed ? 4.6 : 3.4;
        const hitR = (base * rs + 6) / cam.k;
        if (d < hitR * hitR && d < bd) { bd = d; best = n.id; }
      }
    }
    return best;
  }
  function pickTeam(sx: number, sy: number): string | null {
    for (const r of labelRects) if (sx >= r.x0 && sx <= r.x1 && sy >= r.y0 && sy <= r.y1) return r.tid;
    const wp = toWorld(sx, sy);
    for (const t of layout.teams.values()) if (!hidden(t.id) && t.members.length && t.hull.length && pointInPoly(wp, t.hull)) return t.id;
    return null;
  }

  function showTip(id: string | null, sx: number, sy: number) {
    const a = id ? st.agentsById.get(id) ?? layout.nodes.get(id)?.agent : undefined;
    if (!a) { tip.style.display = 'none'; return; }
    const team = layout.teams.get(a.team)?.team;
    const sc = a.status === 'needs' ? 'var(--amber)' : a.status === 'error' ? 'var(--red)' : a.status === 'active' ? team?.hue ?? 'var(--green)' : 'var(--idle)';
    tip.innerHTML =
      `<div style="display:flex;align-items:center;gap:7px;margin-bottom:3px"><span style="width:8px;height:8px;border-radius:50%;background:${sc};box-shadow:0 0 8px ${sc}"></span>` +
      `<b style="font-weight:600;font-size:12.5px">${esc(a.id === COS_ID ? 'Chief of Staff' : a.name)}</b>` +
      `<span class="tip-st" style="--c:${sc}">${esc(a.status === 'needs' ? 'needs you' : a.status)}</span></div>` +
      `<div class="tip-sub"><span style="color:${team?.hue ?? 'var(--muted)'}">●</span> ${esc(team?.name ?? a.team)} · ${esc(a.role)}${a.model ? ` · ${esc(a.model)}` : ''}</div>` +
      `<div class="tip-now">${esc(a.now || '—')}</div>`;
    tip.style.display = 'block';
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    tip.style.left = `${Math.min(w - tw - 8, sx + 14)}px`;
    tip.style.top = `${sy + th + 24 > h ? sy - th - 12 : sy + 16}px`;
  }

  // ---------- input ----------
  let drag: { sx: number; sy: number; cx: number; cy: number; moved: boolean; id: number } | null = null;
  const local = (e: PointerEvent | WheelEvent | MouseEvent) => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  function onDown(e: PointerEvent) {
    if (e.button !== 0) return;
    const p = local(e);
    drag = { sx: p.x, sy: p.y, cx: target.x, cy: target.y, moved: false, id: e.pointerId };
    canvas.setPointerCapture(e.pointerId);
  }
  function onMove(e: PointerEvent) {
    const p = local(e);
    mouse = p;
    if (drag) {
      const dx = p.x - drag.sx, dy = p.y - drag.sy;
      if (!drag.moved && Math.abs(dx) + Math.abs(dy) > 4) { drag.moved = true; autoFit = false; canvas.style.cursor = 'grabbing'; }
      if (drag.moved) {
        target.x = cam.x = drag.cx - dx / target.k;
        target.y = cam.y = drag.cy - dy / target.k;
        tip.style.display = 'none';
        return;
      }
    }
    hover = pickAgent(p.x, p.y);
    hoverTeam = hover ? null : pickTeam(p.x, p.y);
    canvas.style.cursor = hover || hoverTeam ? 'pointer' : 'default';
    showTip(hover, p.x, p.y);
  }
  function onUp(e: PointerEvent) {
    if (!drag) return;
    const d = drag;
    drag = null;
    try { canvas.releasePointerCapture(d.id); } catch { /* already released */ }
    canvas.style.cursor = 'default';
    if (d.moved) return;
    const p = local(e);
    const id = pickAgent(p.x, p.y);
    if (id) return store.select({ type: 'agent', id });
    const tid = pickTeam(p.x, p.y);
    if (tid) return store.select({ type: 'team', id: tid });
    store.select({ type: 'none' });
  }
  function onDbl(e: MouseEvent) {
    const p = local(e);
    const id = pickAgent(p.x, p.y);
    if (id) { store.select({ type: 'agent', id }); store.setZoom('agent'); return; }
    const tid = pickTeam(p.x, p.y);
    if (tid) { store.select({ type: 'team', id: tid }); store.setZoom('team'); return; }
    store.setZoom('fleet');
  }
  function onWheel(e: WheelEvent) {
    e.preventDefault();
    const p = local(e);
    const wp = { x: (p.x - w / 2) / target.k + target.x, y: (p.y - h / 2) / target.k + target.y };
    const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    const nk = Math.max(0.12, Math.min(8, target.k * Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.0018))));
    target.k = nk;
    target.x = wp.x - (p.x - w / 2) / nk;
    target.y = wp.y - (p.y - h / 2) / nk;
    autoFit = false;
  }
  function onLeave() { hover = null; hoverTeam = null; mouse = null; tip.style.display = 'none'; }
  let miniDrag = false;
  function miniPan(e: PointerEvent) {
    const r = mini.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    const v = miniView;
    target.x = v.x0 + (mx - v.ox) / v.s;
    target.y = v.y0 + (my - v.oy) / v.s;
    autoFit = false;
  }
  const onMiniDown = (e: PointerEvent) => { miniDrag = true; mini.setPointerCapture(e.pointerId); miniPan(e); e.stopPropagation(); };
  const onMiniMove = (e: PointerEvent) => { if (miniDrag) miniPan(e); };
  const onMiniUp = () => { miniDrag = false; };

  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp);
  canvas.addEventListener('dblclick', onDbl);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('pointerleave', onLeave);
  mini.addEventListener('pointerdown', onMiniDown);
  mini.addEventListener('pointermove', onMiniMove);
  mini.addEventListener('pointerup', onMiniUp);

  // ---------- resize ----------
  function resize() {
    const r = root.getBoundingClientRect();
    w = Math.max(1, r.width); h = Math.max(1, r.height);
    dpr = Math.min(3, window.devicePixelRatio || 1);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    if (starDpr !== dpr || starMode !== Pal.mode) { stars = ctx.createPattern(starTile(dpr), 'repeat'); starDpr = dpr; starMode = Pal.mode; }
  }
  const ro = new ResizeObserver(() => resize());
  ro.observe(root);
  resize();
  const offTheme = onTheme(() => resize()); // light/dark switch: rebuild the star tile in the new palette (the frame loop picks up the rest)

  // ---------- wire up ----------
  ingest(st, []);
  const unsub = store.subscribe((s, fresh) => ingest(s, fresh));
  raf = requestAnimationFrame((t) => { lastT = t; frame(t); });
  void mouse;

  const api: MapApi = {
    focus(sel: Selection) {
      fitSel = sel.type === 'none' ? null : sel;
      autoFit = true;
      applyScales();
      computeRelated();
    },
    resize() { resize(); },
    destroy() {
      alive = false;
      cancelAnimationFrame(raf);
      unsub();
      offTheme();
      ro.disconnect();
      root.remove();
    },
  };
  return api;
};

export default createMap;
