import { COS_ID, type Agent, type FleetEvent } from './types.ts';

export type WorkState = 'needs' | 'blocked' | 'working' | 'done';
export type MilestoneKind = 'merge' | 'review' | 'security' | 'push' | 'mr' | 'qa' | 'commit';

export interface Milestone {
  kind: MilestoneKind;
  label: string;
  text: string;
  ts: number;
  by: string;
  bad?: boolean;
}

export interface WorkRow {
  key: string;
  ticket?: string;
  mrs: string[];
  title: string;
  state: WorkState;
  lead: string;
  leadName: string;
  session: string;
  milestone?: Milestone;
  blocker?: string;
  now?: string;
  startedAt: number;
  updatedAt: number;
  automation: boolean;
  sessions: string[];
}

export const STATE_ORDER: Record<WorkState, number> = { needs: 0, blocked: 1, working: 2, done: 3 };
export const STATE_LABEL: Record<WorkState, string> = { needs: 'Needs Zach', blocked: 'Blocked', working: 'Working', done: 'Done' };
export const IDLE_AFTER_MS = 4 * 3600_000;
const RECENT_EVENT_MS = 3 * 60_000;

const NOT_PROJECTS = new Set(['UTF', 'SHA', 'ISO', 'RFC', 'PEP', 'CVE', 'CWE', 'GHSA', 'GPT', 'HTTP', 'TLS', 'SSL', 'AES', 'RSA', 'ECMA', 'IPV', 'COVID', 'OWASP', 'ES', 'MP', 'TS', 'PR']);
const TICKET_RE = /\b([A-Z][A-Z0-9]{1,9})-(\d{1,6})\b/g;
const MR_RE = /(?:^|[^\w!&])!(\d{2,6})\b/g;

export function ticketsIn(text: string | undefined): string[] {
  const out: string[] = [];
  for (const m of (text ?? '').matchAll(TICKET_RE)) {
    if (NOT_PROJECTS.has(m[1]) || /^\d+$/.test(m[1])) continue;
    const id = `${m[1]}-${m[2]}`;
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

export function mrsIn(text: string | undefined): string[] {
  const out: string[] = [];
  for (const m of (text ?? '').matchAll(MR_RE)) if (!out.includes(`!${m[1]}`)) out.push(`!${m[1]}`);
  return out;
}

const agentOf = (key: string) => /^agent:([^:]+):/.exec(key)?.[1] ?? '';
const isLeadAgent = (id: string) => /-lead$/.test(id);

const NEGATION = /\b(?:not|never|no|nothing(?: is| was)?|without|nor)\b[^.]{0,24}$|n't(?: been| yet| be)?\s*$/i;
const negated = (text: string, at: number) => NEGATION.test(text.slice(Math.max(0, at - 32), at));

function firstHit(text: string, re: RegExp): RegExpExecArray | null {
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  for (let m = g.exec(text); m; m = g.exec(text)) if (!negated(text, m.index)) return m;
  return null;
}

const VERDICT_RE = /\b(CHANGES[_ ]?REQUESTED|APPROVED|LGTM|CLEAN)\b/;
const SECURITY_RE = /^\s*(PASS|FAIL(?:ED)?|BLOCK(?:ED)?)\b|\b(PASS|FAIL)\b/;

export function milestoneOf(e: Pick<FleetEvent, 'text' | 'ts' | 'from' | 'label'>): Omit<Milestone, 'by'> | null {
  const text = e.text ?? '';
  const agent = agentOf(e.from);
  const base = { text, ts: e.ts };
  if (firstHit(text, /\b(?:MR|merge request|!\d+)\b[^.]{0,60}?\bmerged\b|\bmerged (?:in)?to (?:main|master|develop)\b/i)) return { ...base, kind: 'merge', label: 'MR merged' };
  const verdict = VERDICT_RE.exec(text);
  if (verdict && (/review/i.test(agent) || /review/i.test(e.label ?? '') || verdict.index < 40)) {
    const v = verdict[1].replace(/[_ ]/g, '').toUpperCase();
    const bad = v === 'CHANGESREQUESTED';
    return { ...base, kind: 'review', label: `Review: ${bad ? 'changes requested' : v === 'CLEAN' ? 'clean' : 'approved'}`, ...(bad ? { bad } : {}) };
  }
  const sec = agent === 'security' || /security/i.test(e.label ?? '') ? SECURITY_RE.exec(text) : null;
  if (sec) {
    const v = (sec[1] ?? sec[2]).toUpperCase();
    const bad = !v.startsWith('PASS');
    return { ...base, kind: 'security', label: `Security: ${bad ? 'fail' : 'pass'}`, ...(bad ? { bad } : {}) };
  }
  if (firstHit(text, /\b(?:force-)?pushed\b/i)) return { ...base, kind: 'push', label: 'Pushed' };
  if (firstHit(text, /\b(?:opened|created|raised|filed)\b[^.]{0,20}\b(?:MR|merge request)\b/i)) return { ...base, kind: 'mr', label: 'MR opened' };
  const qaFail = firstHit(text, /\bQA\b[^.]{0,40}\bfail(?:ed|s)?\b|\b\d[\d,]*\s+failed\b/i);
  if (qaFail) return { ...base, kind: 'qa', label: 'QA: failing', bad: true };
  const qa = firstHit(text, /\bQA\b[^.]{0,40}\b(?:pass(?:ed|es)?|green)\b|\b\d[\d,]*\s+passed\b|\b(?:tests?|suite|gate)\b[^.]{0,30}\b(?:pass(?:ed|es)?|green)\b/i);
  if (qa) return { ...base, kind: 'qa', label: 'QA: tests passed' };
  if (firstHit(text, /\bcommit(?:ted)?\b|\bnew commit\b|\bamended\b/i)) return { ...base, kind: 'commit', label: 'Committed' };
  return null;
}

const MILESTONE_KINDS: ReadonlySet<FleetEvent['kind']> = new Set(['done', 'blocked', 'message', 'needs']);

function titleOf(label: string | undefined): string {
  const t = (label ?? '')
    .replace(/\[([^\]]*)\]\([^)]*\)?/g, '$1')
    .replace(/\]\([^)\s]*\)?|https?:\/\/\S+|[[\]`*_]/g, ' ')
    .replace(TICKET_RE, ' ')
    .replace(MR_RE, ' ')
    .replace(/\bMR\b/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s:–—\-·|]+|[\s:–—\-·|]+$/g, '')
    .trim();
  return t;
}

function titleNear(key: string, texts: readonly string[]): string {
  for (const t of texts) {
    const at = t.indexOf(key);
    if (at < 0) continue;
    const after = titleOf(t.slice(at + key.length).split(/(?<=[.!?])\s/)[0]).replace(/[.!?]+$/, '');
    if (after.length >= 4) return after.slice(0, 80);
  }
  return '';
}

export interface WorkInput {
  agents: readonly Agent[];
  events: readonly FleetEvent[];
  openNeeds: readonly FleetEvent[];
  now: number;
}

interface Bucket {
  key: string;
  owned: Agent[];
  events: FleetEvent[];
  needs: FleetEvent[];
  mrs: Set<string>;
}

export function deriveWork({ agents, events, openNeeds, now }: WorkInput): WorkRow[] {
  const byId = new Map(agents.map((a) => [a.id, a]));
  const mrTicket = new Map<string, string>();
  const learn = (text: string | undefined) => {
    const t = ticketsIn(text)[0];
    if (t) for (const mr of mrsIn(text)) if (!mrTicket.has(mr)) mrTicket.set(mr, t);
  };
  for (const a of agents) { learn(a.label); learn(a.name); }
  for (const e of events) { learn(e.label); learn(e.text); }
  const canon = (k: string | undefined) => (k && k.startsWith('!') ? mrTicket.get(k) ?? k : k);
  const keyOfText = (text: string | undefined) => canon(ticketsIn(text)[0] ?? mrsIn(text)[0]);

  const buckets = new Map<string, Bucket>();
  const bucket = (key: string) => {
    let b = buckets.get(key);
    if (!b) buckets.set(key, (b = { key, owned: [], events: [], needs: [], mrs: new Set() }));
    return b;
  };
  const sessionKey = new Map<string, string>();
  for (const a of agents) {
    const k = keyOfText(a.label) ?? (a.kind === 'subagent' || a.kind === 'cron' ? keyOfText(a.name) : undefined);
    if (!k) continue;
    sessionKey.set(a.id, k);
    const b = bucket(k);
    b.owned.push(a);
    for (const mr of [...mrsIn(a.label), ...mrsIn(a.name)]) b.mrs.add(mr);
  }

  const eventKey = (e: FleetEvent) =>
    keyOfText(e.label) ?? sessionKey.get(e.session ?? e.from) ?? sessionKey.get(e.from) ?? (e.to ? sessionKey.get(e.to) : undefined) ?? keyOfText(e.text);
  for (const e of events) {
    if (e.sys || e.from === 'zach') continue;
    const k = eventKey(e);
    if (!k) continue;
    const b = bucket(k);
    b.events.push(e);
    for (const mr of [...mrsIn(e.label), ...mrsIn(e.text)]) if (canon(mr) === k || mrTicket.get(mr) === k) b.mrs.add(mr);
  }

  const needsBySession = new Map<string, FleetEvent>();
  for (const e of openNeeds) {
    const k = eventKey(e);
    if (k) bucket(k).needs.push(e);
    else needsBySession.set(e.session ?? e.from, e);
  }
  for (const a of agents) {
    if (sessionKey.has(a.id) || a.retired) continue;
    const loose = a.status === 'needs' || needsBySession.has(a.id) || (a.status === 'active' && a.kind === 'subagent' && !!a.label);
    if (!loose) continue;
    const b = bucket(`session:${a.id}`);
    b.owned.push(a);
    const n = needsBySession.get(a.id);
    if (n) b.needs.push(n);
    b.events.push(...events.filter((e) => !e.sys && (e.session ?? e.from) === a.id));
  }

  const nameOfAgent = (agentId: string) => {
    if (agentId === 'main') return 'Chief of Staff';
    const main = byId.get(`agent:${agentId}:main`);
    const any = main ?? agents.find((a) => a.agentId === agentId);
    return any?.agentName ?? (any?.kind === 'main' ? any.name : undefined) ?? agentId;
  };

  const rows: WorkRow[] = [];
  for (const b of buckets.values()) {
    if (!b.owned.length && !b.events.length && !b.needs.length) continue;
    const evs = [...b.events].sort((x, y) => x.ts - y.ts);
    const live = b.owned.filter((a) => !a.retired);
    const senders = new Set<string>([...b.owned.map((a) => a.id), ...evs.map((e) => e.from)]);

    const votes = new Map<string, number>();
    const vote = (id: string, w: number) => { if (id) votes.set(id, (votes.get(id) ?? 0) + w); };
    const ownedIds = new Set(b.owned.map((a) => a.id));
    for (const a of b.owned) {
      const id = a.agentId ?? agentOf(a.id);
      if (isLeadAgent(id)) vote(id, 3);
      if (a.parent && isLeadAgent(agentOf(a.parent))) vote(agentOf(a.parent), 2);
    }
    for (const e of evs) {
      const from = agentOf(e.from);
      if (e.kind === 'handoff' && ownedIds.has(e.to) && from !== 'main') vote(from, isLeadAgent(from) ? 2 : 1);
      else if (isLeadAgent(from)) vote(from, 1);
      if (e.to && isLeadAgent(agentOf(e.to))) vote(agentOf(e.to), 1);
    }
    let lead = [...votes.entries()].sort((x, y) => y[1] - x[1])[0]?.[0] ?? '';
    if (!lead) {
      const latest = [...b.owned].sort((x, y) => y.updatedAt - x.updatedAt)[0];
      lead = latest ? (latest.kind === 'subagent' && latest.parent ? agentOf(latest.parent) : latest.agentId ?? agentOf(latest.id)) : agentOf(evs[evs.length - 1]?.from ?? COS_ID);
    }
    const leadSession = byId.has(`agent:${lead}:main`) ? `agent:${lead}:main` : '';

    let milestone: Milestone | undefined;
    for (let i = evs.length - 1; i >= 0 && !milestone; i--) {
      const e = evs[i];
      if (!MILESTONE_KINDS.has(e.kind)) continue;
      const m = milestoneOf(e);
      if (m) milestone = { ...m, by: e.from };
    }

    const working = live.some((a) => a.status === 'active') || evs.some((e) => now - e.ts < RECENT_EVENT_MS && e.kind !== 'handoff' && agentOf(e.from) !== 'main');
    const needsAgent = live.find((a) => a.status === 'needs');
    const needs = b.needs[b.needs.length - 1];
    const outcome = [...evs].reverse().find((e) => e.kind === 'done' || e.kind === 'blocked');
    const latestOwned = [...b.owned].sort((x, y) => y.updatedAt - x.updatedAt)[0];
    const errored = latestOwned?.status === 'error' && (!outcome || latestOwned.updatedAt >= outcome.ts) ? latestOwned : undefined;
    const openFinding = milestone?.bad ? milestone : undefined;

    let state: WorkState = 'done';
    let blocker: string | undefined;
    if (needs || needsAgent) {
      state = 'needs';
      blocker = needs?.text ?? needsAgent?.ask ?? needsAgent?.now;
    } else if (working) {
      state = 'working';
      if (openFinding) blocker = openFinding.label;
    } else if (outcome?.kind === 'blocked') {
      state = 'blocked';
      blocker = outcome.text;
    } else if (errored) {
      state = 'blocked';
      blocker = `${errored.agentName ?? errored.name}: ${errored.now}`;
    } else if (openFinding) {
      state = 'blocked';
      blocker = `${openFinding.label}: ${openFinding.text}`;
    }

    const active = live.filter((a) => a.status === 'active').sort((x, y) => y.updatedAt - x.updatedAt)[0];
    const ticket = b.key.startsWith('session:') ? undefined : b.key.startsWith('!') ? undefined : b.key;
    const activeFirst = (a: Agent) => (!a.retired && a.status === 'active' ? 1 : 0);
    const titled = [...b.owned].sort((x, y) => activeFirst(y) - activeFirst(x) || y.updatedAt - x.updatedAt).map((a) => titleOf(a.label ?? a.name)).find(Boolean)
      ?? evs.map((e) => titleOf(e.label)).reverse().find(Boolean)
      ?? (titleNear(b.key, evs.map((e) => e.text)) || titleOf(evs[evs.length - 1]?.text).slice(0, 80));
    const times = [...b.owned.map((a) => a.updatedAt), ...evs.map((e) => e.ts), ...b.needs.map((e) => e.ts)].filter((t) => t > 0);
    const automation = senders.size > 0 && [...senders].every((id) => byId.get(id)?.kind === 'cron');
    const session = needs?.session ?? needs?.from ?? needsAgent?.id ?? active?.id ?? (leadSession || latestOwned?.id || evs[evs.length - 1]?.session || evs[evs.length - 1]?.from || COS_ID);
    rows.push({
      key: b.key,
      ...(ticket ? { ticket } : {}),
      mrs: [...b.mrs].sort(),
      title: titled || b.key,
      state,
      lead,
      leadName: nameOfAgent(lead),
      session,
      ...(milestone ? { milestone } : {}),
      ...(blocker ? { blocker } : {}),
      ...(active && state !== 'done' ? { now: `${active.agentName ?? active.name}: ${active.now}` } : {}),
      startedAt: times.length ? Math.min(...times) : now,
      updatedAt: times.length ? Math.max(...times) : now,
      automation,
      sessions: b.owned.map((a) => a.id),
    });
  }
  return rows;
}

export function isHiddenByDefault(r: WorkRow, now: number): boolean {
  if (r.state === 'needs') return false;
  if (r.automation) return true;
  return r.state === 'done' && now - r.updatedAt > IDLE_AFTER_MS;
}

export function visibleWork(rows: readonly WorkRow[], showAll: boolean, now: number): { rows: WorkRow[]; hidden: number } {
  const shown = showAll ? [...rows] : rows.filter((r) => !isHiddenByDefault(r, now));
  shown.sort((x, y) => STATE_ORDER[x.state] - STATE_ORDER[y.state] || y.updatedAt - x.updatedAt);
  return { rows: shown, hidden: rows.length - shown.length };
}
