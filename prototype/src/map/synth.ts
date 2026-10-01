// Synthetic fleet for map development/benchmarking when the API is not running (or ?bench=1).
import { COS_ID, TEAM_PALETTE, type Agent, type Delta, type EventKind, type FleetEvent, type Snapshot, type Team } from '../../shared/types';

const NAMES = ['Forge', 'Main assistant', 'SonderMind ticket swarm', 'Research', 'Ops watchers', 'Personal assistants', 'Experiments', 'Billing', 'Growth', 'Infra', 'Docs', 'Evals', 'Security', 'Support'];
const ROLES = ['triage', 'resolver', 'policy', 'qa', 'memory', 'intake', 'audit', 'reply', 'sync', 'guard', 'scout', 'synth', 'probe', 'eval', 'watch', 'builder'];
const NOW = ['Routing intake', 'Reviewing context', 'Drafting response', 'Checking coverage', 'running pytest, 4m', 'reading 6 sources', 'waiting on CI', 'writing patch', 'tailing logs'];
const KINDS: EventKind[] = ['handoff', 'report', 'message', 'message', 'finding', 'check', 'event', 'steer', 'approval'];

export function synthFleet(total: number, teamCount: number, eventsPerSec: number, onDelta: (d: Delta) => void): { snapshot: Snapshot; stop(): void } {
  let s = 1234;
  const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const pick = <T>(a: readonly T[]) => a[Math.floor(rand() * a.length)];
  const now = Date.now();
  const teams: Team[] = [];
  const agents = new Map<string, Agent>();
  const mk = (id: string, name: string, team: string, role: Agent['role'], parent?: string): Agent => ({
    id, name, team, role, parent, status: role === 'worker' ? (rand() < 0.35 ? 'active' : rand() < 0.04 ? 'needs' : 'idle') : 'active',
    now: pick(NOW), costUsd: rand() * 3, tokens: Math.floor(rand() * 3e5), model: 'claude-sonnet-5-5', updatedAt: now,
  });
  for (let i = 0; i < teamCount; i++) {
    const id = i === 1 ? 'main' : `t${i}`;
    teams.push({ id, name: NAMES[i % NAMES.length] + (i >= NAMES.length ? ` ${i}` : ''), hue: TEAM_PALETTE[i % TEAM_PALETTE.length], lead: i === 1 ? COS_ID : `agent:${id}:main` });
  }
  const sizes = teams.map((_, i) => (i === 1 ? 3 : 0));
  let left = total - 3;
  for (let i = 0; left > 0; i = (i + 1) % teamCount) if (i !== 1) { const n = Math.min(left, 1 + Math.floor(rand() * 3)); sizes[i] += n; left -= n; }
  teams.forEach((t, i) => {
    const lead = mk(t.lead!, t.id === 'main' ? 'Chief of Staff' : `${t.id}-lead`, t.id, t.id === 'main' ? 'cos' : 'lead', t.id === 'main' ? undefined : COS_ID);
    agents.set(lead.id, lead);
    const subs: string[] = [];
    for (let j = 1; j < sizes[i]; j++) {
      const parent = subs.length > 2 && rand() < 0.35 ? pick(subs) : lead.id;
      const a = mk(`agent:${t.id}-${j}:subagent:${j}`, `${pick(ROLES)}-${String(j).padStart(2, '0')}`, t.id, 'worker', parent);
      agents.set(a.id, a);
      if (rand() < 0.3) subs.push(a.id);
    }
  });
  let eid = 0;
  const list = () => [...agents.values()];
  const event = (): FleetEvent | null => {
    const all = list();
    const a = pick(all);
    const r = rand();
    const pool = r < 0.6 ? all.filter((x) => x.team === a.team) : r < 0.8 ? [agents.get(a.parent ?? COS_ID) ?? agents.get(COS_ID)!] : all.filter((x) => x.role !== 'worker');
    const b = pick(pool);
    if (!b || b.id === a.id) return null;
    return { id: `s${eid++}`, ts: Date.now(), from: a.id, to: b.id, kind: pick(KINDS), text: 'synthetic' };
  };
  const seed: FleetEvent[] = [];
  for (let i = 0; i < 120; i++) { const e = event(); if (e) { e.ts = now - (120 - i) * 400; seed.push(e); } }
  const snapshot: Snapshot = { source: 'mock', ts: now, teams, agents: list(), events: seed, meters: { tokPerMin: 0, costPerHr: 0, totalCostUsd: 0 } };
  let acc = 0;
  let spawned = 0;
  const tick = setInterval(() => {
    acc += eventsPerSec / 10;
    const evs: FleetEvent[] = [];
    while (acc >= 1) { acc--; const e = event(); if (e) evs.push(e); }
    const upserts: Agent[] = [];
    if (rand() < 0.3) {
      const a = pick(list().filter((x) => x.role === 'worker'));
      a.status = a.status === 'active' ? 'idle' : 'active';
      upserts.push({ ...a });
    }
    // Occasionally spawn a new agent so ease-in is exercised.
    if (rand() < 0.02 && spawned < 12) {
      const t = pick(teams.filter((x) => x.id !== 'main'));
      const a = mk(`agent:${t.id}-new${spawned++}:subagent:x`, `spawn-${spawned}`, t.id, 'worker', t.lead);
      a.status = 'active';
      agents.set(a.id, a);
      upserts.push(a);
    }
    onDelta({ ts: Date.now(), upserts, removed: [], events: evs, meters: snapshot.meters });
  }, 100);
  return { snapshot, stop: () => clearInterval(tick) };
}
