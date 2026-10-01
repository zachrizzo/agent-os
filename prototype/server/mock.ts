// Synthetic fleet: ~60 agents in 7 teams (CoS at the root), ~10 events/s, spawn/finish churn, rotating "needs you".
import { COS_ID, TEAM_PALETTE, type Agent, type Delta, type EventKind, type FleetEvent, type Snapshot, type Team } from '../shared/types.ts';
import type { Source } from './source.ts';

const TEAMS: Array<{ id: string; name: string; lead: string; size: number; workers: string[] }> = [
  { id: 'cos', name: 'Chief of Staff', lead: 'Chief of Staff', size: 4, workers: ['scribe', 'heartbeat', 'memory'] },
  { id: 'forge', name: 'Forge', lead: 'Forge', size: 7, workers: ['pm', 'coder', 'coder', 'reviewer', 'adversary', 'qa'] },
  { id: 'swarm', name: 'SonderMind ticket swarm', lead: 'Swarm lead', size: 13, workers: ['triage', 'resolver', 'resolver', 'policy', 'qa', 'handoff', 'intake', 'audit', 'reply', 'sync', 'guard', 'archive'] },
  { id: 'research', name: 'Research', lead: 'Research lead', size: 8, workers: ['scout', 'scout', 'synth', 'reader', 'critic', 'librarian', 'cite'] },
  { id: 'ops', name: 'Ops watchers', lead: 'Ops lead', size: 11, workers: ['health', 'watch', 'watch', 'pager', 'cost', 'disk', 'k8s', 'cert', 'backup', 'logs'] },
  { id: 'personal', name: 'Personal assistants', lead: 'Personal lead', size: 9, workers: ['schedule', 'inbox', 'travel', 'notes', 'shop', 'finance', 'health', 'news'] },
  { id: 'exp', name: 'Experiments', lead: 'Lab lead', size: 8, workers: ['probe', 'probe', 'eval', 'eval', 'sweep', 'judge', 'canary'] },
];

const NOW_BY_ROLE: Record<string, string[]> = {
  coder: ['Writing patch for card 51f52066', 'Running pytest · 4m in', 'Fixing 2 failing tests', 'Rebasing on main'],
  reviewer: ['Reviewing a8413d64 · 312 lines', 'Second pass on redaction diff', 'Checking test coverage'],
  adversary: ['Trying to break the parser', 'Fuzzing input edge cases', 'Refuting claim 3 of 5'],
  qa: ['Running smoke suite on EE', 'Replaying flaky test x20', 'Verifying fix in staging'],
  pm: ['Splitting epic into 4 cards', 'Writing acceptance criteria'],
  triage: ['Routing 12 new tickets', 'Tagging billing issues'],
  resolver: ['Drafting reply to ticket #4821', 'Looking up account history'],
  scout: ['Reading 6 sources on vector DBs', 'Searching arXiv for evals'],
  synth: ['Merging notes into brief', 'Writing 1-page summary'],
  watch: ['Tailing gateway logs', 'Watching p95 latency', 'Diffing node metrics'],
  inbox: ['Triaging 23 unread emails', 'Drafting reply to Sam'],
  schedule: ['Finding 30 min with Priya', 'Moving Thursday 1:1'],
  eval: ['Scoring eval batch 3/8', 'Comparing opus vs sonnet'],
  probe: ['Probing tool-call latency', 'Sampling 200 prompts'],
};
const NOW_GENERIC = ['Reviewing context', 'Drafting response', 'Validating output', 'Syncing context', 'Summarizing thread', 'Waiting on CI', 'Reading docs', 'Checking coverage'];
const LEAD_NOW = ['Balancing workload', 'Reviewing worker reports', 'Planning next batch', 'Unblocking a worker'];
const MSG: Record<EventKind, string[]> = {
  handoff: ['New intake routed with full context', 'Picked up card 51f52066', 'Escalated with transcript', 'Take the flaky test, repro first'],
  report: ['Patch ready · 18 checks passed', 'Run finished in 3m12s', 'Summary attached · 4 findings', 'Verdict: APPROVED', 'Verdict: CHANGES_REQUESTED'],
  approval: ['Production gate awaiting approval', 'Response ready for your review', 'External source access requested'],
  finding: ['6 sources added to evidence set', 'Contradiction in source 3', 'Regression in eval set B', 'Null deref in parser.ts:88'],
  message: ['Can you take the next ticket?', 'Context synced', 'ack', 'On it', 'Need the repro steps'],
  event: ['Latency back within baseline', 'Disk 71% on node-2', 'Cert renews in 12d', 'Cron run: memory-dreaming'],
  steer: ['Narrow scope to billing only', 'Prefer the cached result', 'Stop, wait for review'],
  check: ['Coverage verified · no exceptions', 'Lint clean', 'Typecheck clean'],
};
const ASKS: Array<[string, string]> = [
  ['forge', 'Approve production deploy of e5330081?'],
  ['swarm', 'Confirm reply to enterprise customer'],
  ['research', 'Allow access to paywalled source?'],
  ['ops', 'Delete 14 GB of old snapshots?'],
  ['personal', 'Accept Thursday 3pm with Priya?'],
  ['exp', 'Spend $40 on a 2k-sample sweep?'],
  ['cos', 'Which team should take AIPIT-6400?'],
];

let rnd = 42;
const rand = () => ((rnd = (rnd * 1664525 + 1013904223) >>> 0) / 4294967296);
const pick = <T>(a: readonly T[]): T => a[Math.floor(rand() * a.length)];
const hex = (n: number) => Array.from({ length: n }, () => Math.floor(rand() * 16).toString(16)).join('');
let eid = 0;

export function createMockSource(): Source {
  const teams: Team[] = TEAMS.map((t, i) => ({ id: t.id, name: t.name, hue: TEAM_PALETTE[i], lead: t.id === 'cos' ? COS_ID : `agent:${t.id}:main` }));
  const agents = new Map<string, Agent>();
  const now = Date.now();
  const nowFor = (w: string) => pick(NOW_BY_ROLE[w] ?? NOW_GENERIC);

  function spawnWorker(teamId: string, w: string, ts: number): Agent {
    const lead = teams.find((t) => t.id === teamId)!.lead!;
    const id = `agent:${teamId === 'cos' ? 'main' : `${teamId}-${w}`}:subagent:${hex(8)}-${hex(4)}`;
    const a: Agent = {
      id, name: `${w}-${id.slice(-4)}`, team: teamId, role: 'worker', parent: lead, status: rand() < 0.45 ? 'active' : 'idle',
      now: nowFor(w), costUsd: rand() * 1.5, tokens: Math.floor(rand() * 2e5), model: pick(['claude-sonnet-5-5', 'claude-haiku-4-5', 'claude-opus-5-5', 'gpt-6-sol']),
      updatedAt: ts, agentId: teamId === 'cos' ? 'main' : `${teamId}-${w}`, kind: 'subagent', label: `${teamId} ${hex(8)} ${w}`,
    };
    agents.set(id, a);
    return a;
  }

  for (const t of TEAMS) {
    const leadId = t.id === 'cos' ? COS_ID : `agent:${t.id}:main`;
    agents.set(leadId, {
      id: leadId, name: t.lead, team: t.id, role: t.id === 'cos' ? 'cos' : 'lead', parent: t.id === 'cos' ? undefined : COS_ID,
      status: 'active', now: t.id === 'cos' ? `Coordinating ${TEAMS.length} teams` : pick(LEAD_NOW),
      costUsd: 1 + rand() * 4, tokens: Math.floor(2e5 + rand() * 4e5), model: 'claude-opus-5-5', updatedAt: now,
      agentId: t.id === 'cos' ? 'main' : t.id, kind: 'main',
    });
    t.workers.slice(0, t.size - 1).forEach((w) => spawnWorker(t.id, w, now));
  }

  const events: FleetEvent[] = [];
  const listeners = new Set<(d: Delta) => void>();
  let pending: FleetEvent[] = [];
  let changed = new Set<string>();
  let removed: string[] = [];
  const all = () => [...agents.values()];
  const push = (e: Omit<FleetEvent, 'id'>) => { const x = { id: `m${eid++}`, ...e }; pending.push(x); return x; };
  const workerOf = (a: Agent) => a.label?.split(' ').pop() ?? 'worker';

  function raiseNeed(ts: number) {
    const [teamId, text] = pick(ASKS);
    const cands = all().filter((a) => a.team === teamId && a.role === 'worker' && a.status !== 'needs');
    if (!cands.length) return;
    const a = pick(cands);
    a.status = 'needs'; a.ask = text; a.now = `Needs you: ${text}`.slice(0, 60); a.updatedAt = ts;
    changed.add(a.id);
    push({ ts, from: a.id, to: 'zach', kind: 'approval', text, needsYou: true });
  }
  // Seed a few "Needs you" items, then backfill a minute of history so a fresh client has context.
  for (let i = 0; i < 4; i++) raiseNeed(now - (4 - i) * 45_000);

  function emit(ts: number) {
    const list = all();
    const active = list.filter((a) => a.status === 'active');
    const src = rand() < 0.8 && active.length ? pick(active) : pick(list);
    const roll = rand();
    let to: Agent | undefined;
    if (roll < 0.55) to = pick(list.filter((a) => a.team === src.team && a.id !== src.id));
    else if (roll < 0.85) to = agents.get(src.parent ?? COS_ID);
    else to = pick(list.filter((a) => (a.role === 'lead' || a.role === 'cos') && a.id !== src.id));
    if (!to || to.id === src.id) return;
    const kind = src.role !== 'worker' && rand() < 0.4 ? pick<EventKind>(['handoff', 'steer'])
      : to.id === src.parent ? pick<EventKind>(['report', 'report', 'finding', 'check', 'message'])
      : pick<EventKind>(['message', 'message', 'handoff', 'finding', 'event', 'check']);
    push({ ts, from: src.id, to: to.id, kind, text: pick(MSG[kind]) });
    src.updatedAt = ts;
    src.tokens += Math.floor(500 + rand() * 3000);
    src.costUsd += 0.002 + rand() * 0.01;
    changed.add(src.id);
    if (rand() < 0.12) { // status / now-line churn
      const a = pick(list.filter((x) => x.status !== 'needs'));
      if (a.role === 'worker') {
        const r = rand();
        a.status = r < 0.03 ? 'error' : a.status === 'active' ? 'idle' : 'active';
        a.now = a.status === 'error' ? 'Aborted · tool timeout' : a.status === 'idle' ? `Done · ${pick(MSG.report)}`.slice(0, 60) : nowFor(workerOf(a));
      } else a.now = a.role === 'cos' ? pick([`Coordinating ${TEAMS.length} teams`, 'Reading team reports', 'Drafting your daily brief']) : pick(LEAD_NOW);
      a.updatedAt = ts;
      changed.add(a.id);
    }
  }

  function churn(ts: number) {
    // A worker finishes and leaves; its lead spawns a replacement (keeps the fleet ~60).
    const done = all().filter((a) => a.role === 'worker' && a.status === 'idle');
    if (done.length) {
      const a = pick(done);
      push({ ts, from: a.id, to: a.parent ?? COS_ID, kind: 'report', text: `Finished · ${pick(MSG.report)}` });
      agents.delete(a.id); changed.delete(a.id); removed.push(a.id);
      const b = spawnWorker(a.team, workerOf(a), ts);
      b.status = 'active';
      push({ ts, from: b.parent!, to: b.id, kind: 'handoff', text: `Spawned ${b.name}: ${pick(MSG.handoff)}` });
      changed.add(b.id);
    }
    // Resolve the oldest need, sometimes raise a new one.
    const needs = all().filter((a) => a.status === 'needs').sort((x, y) => x.updatedAt - y.updatedAt);
    if (needs.length > 2 && rand() < 0.5) {
      const a = needs[0];
      a.status = 'active'; delete a.ask; a.now = nowFor(workerOf(a)); a.updatedAt = ts;
      push({ ts, from: COS_ID, to: a.id, kind: 'steer', text: 'Zach approved · proceed' });
      changed.add(a.id);
    }
    if (needs.length < 6 && rand() < 0.5) raiseNeed(ts);
  }

  for (let i = 600; i > 0; i--) emit(now - i * 100); // ~1 min of backfill
  ringPush(events, pending);
  pending = [];
  changed = new Set();

  const t1 = setInterval(() => { const ts = Date.now(); emit(ts); if (rand() < 0.1) emit(ts); }, 100); // ~10 events/s
  const t2 = setInterval(() => churn(Date.now()), 4000);
  const t3 = setInterval(() => {
    const d: Delta = {
      ts: Date.now(), upserts: [...changed].map((id) => agents.get(id)!).filter(Boolean), removed, events: pending, meters: meters(),
    };
    ringPush(events, pending);
    pending = []; changed = new Set(); removed = [];
    for (const l of listeners) l(d);
  }, 250);

  function meters() {
    const list = all();
    const active = list.filter((a) => a.status === 'active').length;
    return {
      tokPerMin: 250_000 + active * 3500 + Math.floor(rand() * 20000),
      costPerHr: Math.round((12 + active * 0.12 + rand()) * 100) / 100,
      totalCostUsd: Math.round(list.reduce((s, a) => s + a.costUsd, 0) * 100) / 100,
    };
  }

  return {
    snapshot(): Snapshot {
      return { source: 'mock', ts: Date.now(), teams, agents: all(), events: events.slice(-200), meters: meters() };
    },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    async history(key) {
      const a = agents.get(key);
      if (!a) return [];
      const t = Date.now();
      return [
        { role: 'user', ts: t - 180_000, text: `Brief: ${pick(MSG.handoff)}`, sender: a.parent ? agents.get(a.parent)?.name : 'Zach' },
        { role: 'assistant', ts: t - 120_000, text: `${a.now}…` },
        { role: 'assistant', ts: t - 60_000, text: `⚙ exec · ${pick(MSG.check)}` },
        { role: 'assistant', ts: t - 5_000, text: a.ask ?? pick(MSG.report) },
      ];
    },
    close() { clearInterval(t1); clearInterval(t2); clearInterval(t3); },
  };
}

// Recent event ring shared by both sources, so a fresh client gets context.
export function ringPush(ring: FleetEvent[], evs: FleetEvent[], max = 300) {
  ring.push(...evs);
  if (ring.length > max) ring.splice(0, ring.length - max);
}
