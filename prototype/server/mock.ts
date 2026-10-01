// Synthetic fleet: 60 agents in 7 teams, ~10 messages/s.
import { COS_ID, TEAM_PALETTE, type Agent, type Delta, type EventKind, type FleetEvent, type Snapshot, type Team } from '../shared/types.ts';
import type { Source } from './source.ts';

const TEAMS: Array<{ id: string; name: string; size: number; workers: string[] }> = [
  { id: 'forge', name: 'Forge', size: 6, workers: ['pm', 'builder', 'reviewer', 'adversary', 'qa', 'deploy'] },
  { id: 'main', name: 'Main assistant', size: 3, workers: ['scribe', 'heartbeat'] },
  { id: 'swarm', name: 'SonderMind ticket swarm', size: 14, workers: ['triage', 'resolver', 'resolver', 'policy', 'qa', 'handoff', 'memory', 'intake', 'audit', 'reply', 'sync', 'guard', 'archive'] },
  { id: 'research', name: 'Research', size: 8, workers: ['scout', 'scout', 'synth', 'reader', 'critic', 'librarian', 'cite'] },
  { id: 'ops', name: 'Ops watchers', size: 11, workers: ['health', 'watch', 'watch', 'pager', 'cost', 'disk', 'k8s', 'cert', 'backup', 'logs'] },
  { id: 'personal', name: 'Personal assistants', size: 10, workers: ['schedule', 'inbox', 'travel', 'mem', 'notes', 'shop', 'finance', 'health', 'news'] },
  { id: 'exp', name: 'Experiments', size: 8, workers: ['probe', 'probe', 'eval', 'eval', 'sweep', 'judge', 'canary'] },
];

const NOW_LINES = [
  'Routing intake', 'Reviewing context', 'Drafting response', 'Checking coverage', 'Validating output', 'Syncing context',
  'running pytest, 4m', 'reviewing a8413d64', 'reading 6 sources', 'summarizing thread', 'Balancing workload', 'tailing logs',
  'diffing snapshot', 'scoring eval batch', 'waiting on CI', 'writing patch',
];
const MSG: Record<EventKind, string[]> = {
  handoff: ['New intake routed with full context', 'Picked up card 51f52066', 'Escalated with transcript'],
  report: ['Patch ready · 18 checks passed', 'Run finished in 3m12s', 'Summary attached'],
  approval: ['Production gate awaiting approval', 'Response ready for your review', 'External source access requested'],
  finding: ['6 sources added to evidence set', 'Contradiction in source 3', 'Regression in eval set B'],
  message: ['Can you take the next ticket?', 'Context synced', 'ack'],
  event: ['Latency back within baseline', 'Disk 71% on node-2', 'Cert renews in 12d'],
  steer: ['Narrow scope to billing only', 'Prefer the cached result'],
  check: ['Coverage verified · no exceptions', 'Lint clean'],
};
const NEEDS = [
  ['Approve production deploy', 'forge', 5],
  ['Confirm customer reply', 'swarm', 5],
  ['Allow external source access', 'research', 1],
  ['Review memory cleanup', 'ops', 3],
  ['Confirm calendar changes', 'personal', 0],
] as const;

let rnd = 42;
const rand = () => ((rnd = (rnd * 1664525 + 1013904223) >>> 0) / 4294967296);
const pick = <T>(a: readonly T[]): T => a[Math.floor(rand() * a.length)];
let eid = 0;

export function createMockSource(): Source {
  const teams: Team[] = TEAMS.map((t, i) => ({ id: t.id, name: t.name, hue: TEAM_PALETTE[i] }));
  const agents = new Map<string, Agent>();
  const now = Date.now();
  for (const t of TEAMS) {
    const team = teams.find((x) => x.id === t.id)!;
    const leadId = t.id === 'main' ? COS_ID : `agent:${t.id}:main`;
    team.lead = leadId;
    agents.set(leadId, {
      id: leadId, name: t.id === 'main' ? 'Chief of Staff' : `${t.id === 'swarm' ? 'lead' : t.id}-lead`, team: t.id,
      role: t.id === 'main' ? 'cos' : 'lead', parent: t.id === 'main' ? undefined : COS_ID,
      status: 'active', now: t.id === 'main' ? 'Coordinating 7 teams' : 'Balancing workload',
      costUsd: rand() * 4, tokens: Math.floor(rand() * 4e5), model: 'claude-opus-5-5', updatedAt: now,
    });
    t.workers.slice(0, t.size - 1).forEach((w, i) => {
      const id = `agent:${t.id}-${w}:subagent:${String(i + 1).padStart(2, '0')}`;
      agents.set(id, {
        id, name: `${w}-${String(i + 1).padStart(2, '0')}`, team: t.id, role: 'worker', parent: leadId,
        status: rand() < 0.35 ? 'active' : 'idle', now: pick(NOW_LINES),
        costUsd: rand() * 1.5, tokens: Math.floor(rand() * 2e5), model: pick(['claude-sonnet-5-5', 'claude-haiku-4-5', 'gpt-6.1']), updatedAt: now,
      });
    });
  }
  // Seed "Needs you" items.
  const events: FleetEvent[] = [];
  NEEDS.forEach(([text, team, idx], i) => {
    const members = [...agents.values()].filter((a) => a.team === team && a.role === 'worker');
    const a = members[Math.min(idx as number, members.length - 1)];
    a.status = 'needs';
    a.now = 'Awaiting approval';
    events.push({ id: `m${eid++}`, ts: now - (5 - i) * 60_000, from: a.id, to: 'zach', kind: 'approval', text, needsYou: true });
  });

  const listeners = new Set<(d: Delta) => void>();
  let pending: FleetEvent[] = [];
  let changed = new Set<string>();

  const all = () => [...agents.values()];
  function emit() {
    const list = all();
    const active = list.filter((a) => a.status === 'active');
    const src = rand() < 0.8 && active.length ? pick(active) : pick(list);
    const roll = rand();
    let to: Agent | undefined;
    if (roll < 0.6) to = pick(list.filter((a) => a.team === src.team && a.id !== src.id));
    else if (roll < 0.85) to = agents.get(src.parent ?? COS_ID) ?? agents.get(COS_ID);
    else to = pick(list.filter((a) => a.role === 'lead' || a.role === 'cos'));
    if (!to || to.id === src.id) return;
    const kind = pick<EventKind>(['handoff', 'report', 'message', 'message', 'finding', 'check', 'event', 'steer', 'report']);
    const ev: FleetEvent = { id: `m${eid++}`, ts: Date.now(), from: src.id, to: to.id, kind, text: pick(MSG[kind]) };
    pending.push(ev);
    src.updatedAt = ev.ts;
    src.tokens += Math.floor(rand() * 3000);
    src.costUsd += 0.002 + rand() * 0.01;
    changed.add(src.id);
    if (rand() < 0.08) {
      const a = pick(list.filter((x) => x.role === 'worker' && x.status !== 'needs'));
      a.status = a.status === 'active' ? 'idle' : 'active';
      a.now = a.status === 'idle' ? 'Idle' : pick(NOW_LINES);
      changed.add(a.id);
    }
  }

  const tickMs = 100; // ~10 msg/s
  const t1 = setInterval(() => { emit(); if (rand() < 0.1) emit(); }, tickMs);
  const t2 = setInterval(() => {
    if (!pending.length && !changed.size) return;
    const d: Delta = {
      ts: Date.now(), upserts: [...changed].map((id) => agents.get(id)!).filter(Boolean), removed: [], events: pending, meters: meters(),
    };
    ringPush(events, pending);
    pending = [];
    changed = new Set();
    for (const l of listeners) l(d);
  }, 250);

  function meters() {
    const list = all();
    const active = list.filter((a) => a.status === 'active').length;
    return { tokPerMin: 250_000 + active * 3500 + Math.floor(rand() * 20000), costPerHr: 12 + active * 0.12 + rand(), totalCostUsd: list.reduce((s, a) => s + a.costUsd, 0) };
  }

  return {
    snapshot(): Snapshot {
      return { source: 'mock', ts: Date.now(), teams, agents: all(), events: events.slice(-200), meters: meters() };
    },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    async history(key) {
      const a = agents.get(key);
      if (!a) return [];
      return [
        { role: 'user', ts: Date.now() - 120_000, text: `Brief from ${a.parent ?? 'Zach'}: ${pick(MSG.handoff)}`, sender: a.parent },
        { role: 'assistant', ts: Date.now() - 60_000, text: `${a.now}…` },
        { role: 'assistant', ts: Date.now() - 5_000, text: pick(MSG.report) },
      ];
    },
    close() { clearInterval(t1); clearInterval(t2); },
  };
}

// Keep the recent event ring on the mock side too, so a fresh client gets context.
export function ringPush(ring: FleetEvent[], evs: FleetEvent[], max = 300) {
  ring.push(...evs);
  if (ring.length > max) ring.splice(0, ring.length - max);
}
