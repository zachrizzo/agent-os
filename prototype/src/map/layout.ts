// Deterministic fleet layout: CoS team at the origin, other teams on an orbit sized to fit them,
// agents seeded from an id hash and relaxed by a tiny per-team force sim. Positions are kept in
// team-local space so team moves/zooms ease smoothly and deltas never make dots jump.
import { COS_ID, type Agent, type Team } from '../../shared/types';

export interface P { x: number; y: number }

export interface LNode {
  id: string;
  team: string;
  agent: Agent;
  lx: number; ly: number; // team-local position (unscaled)
  vx: number; vy: number;
  fixed: boolean; // team lead / CoS pinned at the team centre
  born: number; // ms, for ease-in
  dying: number; // ms, 0 = alive
}

export interface LTeam {
  id: string;
  idx: number; // order in snapshot.teams
  team: Team;
  cx: number; cy: number; // current centre (world)
  tx: number; ty: number; // target centre
  s: number; ts: number; // current / target scale (semantic team zoom)
  rEst: number; // estimated local radius
  alpha: number; // sim heat
  members: LNode[];
  lead?: string;
  hull: P[]; // world-space smoothed outline
  top: P; // world point at the top of the hull (label anchor)
}

const D0 = 25; // min spacing between agents (local units)
const LINK = 36; // parent -> child rest length
export const HULL_PAD = 22;

export function hash(s: string, seed = 2166136261): number {
  let h = seed >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12;
  return (h >>> 0) / 4294967296;
}

export class Layout {
  nodes = new Map<string, LNode>();
  teams = new Map<string, LTeam>();
  centerTeam: string | null = null;
  private order: string[] = [];

  /** Apply a snapshot. Returns true when membership/structure changed. */
  sync(teams: Team[], agents: Agent[], now: number, initial: boolean): boolean {
    let structural = false;
    const teamList = [...teams];
    for (const a of agents) if (!teamList.some((t) => t.id === a.team)) teamList.push({ id: a.team, name: a.team, hue: '#8b95a8' });
    teamList.forEach((t, i) => {
      let lt = this.teams.get(t.id);
      if (!lt) {
        lt = { id: t.id, idx: i, team: t, cx: 0, cy: 0, tx: NaN, ty: NaN, s: 1, ts: 1, rEst: 30, alpha: 1, members: [], hull: [], top: { x: 0, y: 0 } };
        this.teams.set(t.id, lt);
        structural = true;
      }
      if (lt.idx !== i) structural = true;
      lt.idx = i;
      lt.team = t;
    });
    const cos = agents.find((a) => a.id === COS_ID);
    const center = cos ? cos.team : null;
    if (center !== this.centerTeam) { this.centerTeam = center; structural = true; }

    const seen = new Set<string>();
    const touched = new Set<string>();
    for (const a of agents) {
      seen.add(a.id);
      let n = this.nodes.get(a.id);
      if (n && n.team !== a.team) { this.nodes.delete(a.id); n = undefined; touched.add(a.team); }
      if (!n) {
        n = { id: a.id, team: a.team, agent: a, lx: 0, ly: 0, vx: 0, vy: 0, fixed: false, born: initial ? -1e9 : now, dying: 0 };
        this.nodes.set(a.id, n);
        touched.add(a.team);
        structural = true;
      } else if (n.dying) { n.dying = 0; touched.add(a.team); }
      n.agent = a;
    }
    for (const n of this.nodes.values()) if (!seen.has(n.id) && !n.dying) { n.dying = now; touched.add(n.team); structural = true; }

    if (structural || touched.size) {
      for (const lt of this.teams.values()) lt.members = [];
      for (const n of this.nodes.values()) this.teams.get(n.team)?.members.push(n);
      for (const lt of this.teams.values()) {
        const live = lt.members.filter((m) => !m.dying);
        lt.lead = lt.id === center ? COS_ID : lt.team.lead && this.nodes.get(lt.team.lead)?.team === lt.id ? lt.team.lead : live.find((m) => m.agent.role === 'lead')?.id;
        lt.rEst = 12 + 13.5 * Math.sqrt(Math.max(1, live.length));
      }
      // Seed new nodes (sorted so parents are placed before children -> deterministic).
      const fresh = [...this.nodes.values()].filter((n) => n.lx === 0 && n.ly === 0 && !n.dying).sort((a, b) => depth(a, this.nodes) - depth(b, this.nodes) || (a.id < b.id ? -1 : 1));
      for (const n of fresh) this.seed(n);
      for (const tid of touched) { const lt = this.teams.get(tid); if (lt) lt.alpha = Math.max(lt.alpha, initial ? 1 : 0.35); }
      this.order = [...this.teams.values()].filter((t) => t.members.some((m) => !m.dying)).sort((a, b) => a.idx - b.idx).map((t) => t.id);
      this.orbit(initial);
    }
    if (initial) for (let i = 0; i < 320; i++) this.relax();
    return structural;
  }

  private seed(n: LNode) {
    const lt = this.teams.get(n.team)!;
    n.fixed = n.id === lt.lead;
    if (n.fixed) { n.lx = n.ly = 0; return; }
    const h1 = hash(n.id), h2 = hash(n.id, 0x9e3779b9);
    const ang = h1 * Math.PI * 2;
    const p = n.agent.parent ? this.nodes.get(n.agent.parent) : undefined;
    if (p && p.team === n.team && !p.fixed && (p.lx || p.ly)) {
      n.lx = p.lx + Math.cos(ang) * LINK; n.ly = p.ly + Math.sin(ang) * LINK;
    } else {
      const r = lt.rEst * (0.35 + 0.6 * Math.sqrt(h2));
      n.lx = Math.cos(ang) * r; n.ly = Math.sin(ang) * r;
    }
    if (!n.lx && !n.ly) n.lx = 1;
  }

  /** Target team centres on an (x-stretched) orbit around the CoS team. */
  orbit(snap = false) {
    const ring = this.order.filter((t) => t !== this.centerTeam).map((t) => this.teams.get(t)!);
    const c = this.centerTeam ? this.teams.get(this.centerTeam) : undefined;
    const re = (t: LTeam) => (t.rEst + HULL_PAD + 18) * t.ts;
    const gap = 64;
    if (c) { c.tx = 0; c.ty = 0; }
    const n = ring.length;
    if (n) {
      const w = ring.map((t) => re(t) + gap / 2);
      const W = w.reduce((s, x) => s + x, 0);
      const spans = w.map((x) => (x / W) * Math.PI * 2);
      let R = (c ? re(c) : 0) + Math.max(...ring.map(re)) + gap;
      if (n > 1) for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const d = (spans[i] + spans[j]) / 2;
        R = Math.max(R, (re(ring[i]) + re(ring[j]) + gap) / (2 * Math.sin(Math.min(Math.PI / 2, d / 2))));
      }
      let a = -Math.PI / 2 - spans[0] / 2 - (n > 2 ? Math.PI / n : 0);
      ring.forEach((t, i) => {
        const th = a + spans[i] / 2;
        a += spans[i];
        t.tx = Math.cos(th) * R * 1.3;
        t.ty = Math.sin(th) * R;
      });
    }
    for (const t of this.teams.values()) {
      if (Number.isNaN(t.tx)) { t.tx = 0; t.ty = 0; }
      if (snap || (t.cx === 0 && t.cy === 0 && t.id !== this.centerTeam)) { t.cx = t.tx; t.cy = t.ty; }
    }
  }

  setScale(tid: string, s: number): boolean {
    const t = this.teams.get(tid);
    if (!t || t.ts === s) return false;
    t.ts = s;
    return true;
  }

  /** One sim tick for every warm team. */
  relax() {
    for (const t of this.teams.values()) {
      if (t.alpha < 0.004) continue;
      const a = t.alpha;
      const m = t.members;
      for (const n of m) {
        if (n.fixed || n.dying) continue;
        n.vx -= n.lx * 0.014 * a; n.vy -= n.ly * 0.014 * a;
        const p = n.agent.parent ? this.nodes.get(n.agent.parent) : undefined;
        if (p && p.team === n.team && !p.dying) {
          const dx = p.lx - n.lx, dy = p.ly - n.ly, d = Math.hypot(dx, dy) || 1;
          const k = ((d - LINK) / d) * 0.03 * a;
          n.vx += dx * k; n.vy += dy * k;
        }
      }
      for (let i = 0; i < m.length; i++) {
        const p = m[i];
        if (p.dying) continue;
        for (let j = i + 1; j < m.length; j++) {
          const q = m[j];
          if (q.dying) continue;
          let dx = q.lx - p.lx, dy = q.ly - p.ly;
          const d2 = dx * dx + dy * dy;
          if (d2 >= D0 * D0) continue;
          if (d2 < 1e-4) { dx = hash(p.id + q.id) - 0.5; dy = 0.3; }
          const d = Math.sqrt(dx * dx + dy * dy);
          const f = ((D0 - d) / d) * 0.32;
          const wp = p.fixed ? 0 : q.fixed ? 1 : 0.5, wq = q.fixed ? 0 : p.fixed ? 1 : 0.5;
          p.vx -= dx * f * wp; p.vy -= dy * f * wp;
          q.vx += dx * f * wq; q.vy += dy * f * wq;
        }
      }
      for (const n of m) {
        if (n.fixed) { n.lx = n.ly = n.vx = n.vy = 0; continue; }
        n.lx += n.vx; n.ly += n.vy;
        n.vx *= 0.55; n.vy *= 0.55;
      }
      t.alpha *= 0.985;
    }
  }

  /** Ease team centres/scales, relax, drop faded nodes. dt in seconds. */
  step(dt: number, now: number, instant: boolean) {
    const e = instant ? 1 : 1 - Math.exp(-dt * 5);
    for (const t of this.teams.values()) {
      t.cx += (t.tx - t.cx) * e; t.cy += (t.ty - t.cy) * e;
      t.s += (t.ts - t.s) * e;
      if (Math.abs(t.tx - t.cx) < 0.05) t.cx = t.tx;
      if (Math.abs(t.ty - t.cy) < 0.05) t.cy = t.ty;
      if (Math.abs(t.ts - t.s) < 0.001) t.s = t.ts;
    }
    this.relax();
    let gone = false;
    for (const n of this.nodes.values()) if (n.dying && now - n.dying > 600) { this.nodes.delete(n.id); gone = true; }
    if (gone) {
      for (const t of this.teams.values()) t.members = t.members.filter((m) => this.nodes.has(m.id));
      const before = this.order.join();
      this.order = [...this.teams.values()].filter((t) => t.members.length).sort((a, b) => a.idx - b.idx).map((t) => t.id);
      if (before !== this.order.join()) this.orbit();
    }
  }

  world(id: string, out: P = { x: 0, y: 0 }): P | null {
    const n = this.nodes.get(id);
    if (!n) return null;
    const t = this.teams.get(n.team)!;
    out.x = t.cx + n.lx * t.s; out.y = t.cy + n.ly * t.s;
    return out;
  }

  /** Recompute smoothed hull outlines (world space). `time` animates a gentle wobble. */
  hulls(time: number) {
    const pts: P[] = [];
    for (const t of this.teams.values()) {
      pts.length = 0;
      const pad = HULL_PAD * Math.sqrt(t.s);
      const k = 10;
      for (const n of t.members) {
        if (n.dying) continue;
        const x = t.cx + n.lx * t.s, y = t.cy + n.ly * t.s;
        for (let i = 0; i < k; i++) { const a = (i / k) * Math.PI * 2; pts.push({ x: x + Math.cos(a) * pad, y: y + Math.sin(a) * pad * 0.92 }); }
      }
      if (pts.length < 3) { t.hull = []; continue; }
      const hull = convexHull(pts);
      const res = resample(hull, 48);
      let mx = 0, my = 0;
      for (const p of res) { mx += p.x; my += p.y; }
      mx /= res.length; my /= res.length;
      const ph = hash(t.id) * 6.28, ph2 = hash(t.id, 7) * 6.28;
      let top = res[0];
      for (const p of res) {
        const a = Math.atan2(p.y - my, p.x - mx);
        const f = 1 + 0.055 * Math.sin(3 * a + ph + time * 0.35) + 0.035 * Math.sin(5 * a + ph2 - time * 0.22);
        p.x = mx + (p.x - mx) * f; p.y = my + (p.y - my) * f;
        if (p.y < top.y) top = p;
      }
      t.hull = res;
      t.top = { x: t.cx, y: top.y };
    }
  }
}

function depth(n: LNode, nodes: Map<string, LNode>): number {
  let d = 0, p = n.agent.parent;
  while (p && d < 12) { d++; p = nodes.get(p)?.agent.parent; }
  return d;
}

function convexHull(pts: P[]): P[] {
  const s = pts.slice().sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (o: P, a: P, b: P) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lo: P[] = [], hi: P[] = [];
  for (const p of s) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
  for (let i = s.length - 1; i >= 0; i--) { const p = s[i]; while (hi.length >= 2 && cross(hi[hi.length - 2], hi[hi.length - 1], p) <= 0) hi.pop(); hi.push(p); }
  hi.pop(); lo.pop();
  return lo.concat(hi);
}

function resample(poly: P[], n: number): P[] {
  const L: number[] = [0];
  for (let i = 0; i < poly.length; i++) { const a = poly[i], b = poly[(i + 1) % poly.length]; L.push(L[i] + Math.hypot(b.x - a.x, b.y - a.y)); }
  const total = L[poly.length];
  const out: P[] = [];
  let seg = 0;
  for (let i = 0; i < n; i++) {
    const d = (i / n) * total;
    while (L[seg + 1] < d) seg++;
    const a = poly[seg], b = poly[(seg + 1) % poly.length];
    const t = (d - L[seg]) / (L[seg + 1] - L[seg] || 1);
    out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  }
  return out;
}

export function pointInPoly(p: P, poly: P[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
