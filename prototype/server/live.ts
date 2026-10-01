// Live fleet from the local Gateway via `openclaw gateway call` (READ methods only).
// The CLI resolves Gateway auth itself; no token ever passes through this process or the browser.
// At most one CLI call is in flight at a time; slow calls (>2s) back the poll interval off.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { COS_ID, TEAM_PALETTE, type Agent, type AgentStatus, type Delta, type EventKind, type FleetEvent, type HistoryItem, type Meters, type Snapshot, type Team } from '../shared/types.ts';
import { ringPush } from './mock.ts';
import { redact } from './redact.ts';
import type { Source } from './source.ts';

const READ_METHODS = new Set(['sessions.list', 'agents.list', 'chat.history', 'usage.cost']);
const POLL_MS = 2500;
const MAX_POLL_MS = 30_000;
const SLOW_CALL_MS = 2000;
const ACTIVE_MS = 2 * 60_000;
const WINDOW_HOURS = Number(process.env.AGENT_OS_WINDOW_HOURS ?? 24) || 24;
const DEFAULT_BIN = `${process.env.HOME ?? ''}/.openclaw/tools/node-v24.21.0/bin/openclaw`;
const OPENCLAW = process.env.OPENCLAW_BIN ?? (existsSync(DEFAULT_BIN) ? DEFAULT_BIN : 'openclaw');
// `openclaw` is a `#!/usr/bin/env node` script: make sure a node is on PATH even under nohup.
const CHILD_ENV = { ...process.env, PATH: [dirname(process.execPath), OPENCLAW.includes('/') ? dirname(OPENCLAW) : '', process.env.PATH ?? ''].filter(Boolean).join(':') };

// ---------- single-flight CLI queue ----------
let chain: Promise<unknown> = Promise.resolve();
let slowSince = 0; // set when any call exceeds SLOW_CALL_MS; read+cleared by the poll loop

function call(method: string, params: Record<string, unknown> = {}, timeoutMs = 10_000): Promise<any> {
  if (!READ_METHODS.has(method)) return Promise.reject(new Error(`method not allowed: ${method}`));
  const run = () => new Promise((resolve, reject) => {
    const t0 = Date.now();
    execFile(OPENCLAW, ['gateway', 'call', method, '--json', '--params', JSON.stringify(params), '--timeout', String(timeoutMs)],
      { maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs + 5000, env: CHILD_ENV }, (err, stdout) => {
        if (Date.now() - t0 > SLOW_CALL_MS) slowSince = Date.now();
        if (err) return reject(new Error(`${method} failed`)); // never echo stderr: it may carry config details
        try { resolve(JSON.parse(stdout)); } catch { reject(new Error(`${method}: bad JSON`)); }
      });
  });
  const p = chain.then(run, run);
  chain = p.catch(() => undefined);
  return p;
}

// ---------- text helpers ----------
const oneLine = (s: unknown) => redact(String(s ?? '').replace(/[`*#>]+/g, '').replace(/\s+/g, ' ').trim());
const clip = (s: unknown, n: number) => { const t = oneLine(s); return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t; };
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

const ASK_RE = /\b(decision[ _](needed|required)|needs? (your|a) (decision|approval|go-?ahead|sign-?off|input|call)|awaiting (your )?(approval|decision|input|go-?ahead)|waiting (on|for) (you|zach|your|approval)|please (approve|confirm|decide|choose|pick)|approve (this|the|deploy|merge|release)\b|your call\b|blocked on (you|zach)|want me to\b[^?]{0,140}\?|should i\b[^?]{0,140}\?|which (option|approach|one|path)\b[^?]{0,100}\?|(ok|okay) to (proceed|merge|deploy|ship|push)\?|status:\s*blocked)/i;
const ERROR_STATUSES = new Set(['killed', 'failed', 'error', 'aborted', 'timeout', 'timed_out', 'crashed']);
const INTER_RE = /^\[Inter-session message\]\s+sourceSession=(\S+)/;
const CRON_RE = /^\[cron:\S+\s+([^\]]+)\]\s*/;

function parseKey(key: string): { agentId: string; kind: Agent['kind']; tail: string } {
  const m = key.match(/^agent:([^:]+):(.*)$/);
  const agentId = m?.[1] ?? 'unknown';
  const rest = m?.[2] ?? key;
  const kind = rest === 'main' ? 'main' : rest.startsWith('subagent:') ? 'subagent' : rest.startsWith('cron:') ? 'cron' : 'other';
  return { agentId, kind, tail: rest.split(':').pop() ?? '' };
}

/** Team = agent-id prefix family. CoS + all `main` sessions form the "cos" team. */
function teamOf(agentId: string): { id: string; name: string; lead: string } {
  if (agentId === 'main') return { id: 'cos', name: 'Chief of Staff', lead: COS_ID };
  const fam = agentId.split(/[-_]/)[0] || agentId;
  return { id: fam, name: cap(fam), lead: `agent:${fam}:main` };
}

/** Short human gist of a last-message preview. */
function gist(preview: string, n = 60): string {
  if (!preview) return '';
  const inter = preview.match(INTER_RE);
  if (inter) return `Message from ${shortKey(inter[1])}`;
  const cron = preview.match(CRON_RE);
  if (cron) return `Cron: ${clip(cron[1], n - 6)}`;
  if (/FORGE-REPORT/.test(preview)) {
    const f = (k: string) => preview.match(new RegExp(`\\b${k}:\\s*([\\w-]+)`))?.[1];
    const card = f('card')?.slice(0, 8);
    return clip(`${f('role') ?? 'report'} ${(f('verdict') ?? f('status') ?? 'done').replace(/_/g, ' ')}${card ? ` · ${card}` : ''}`, n);
  }
  const first = oneLine(preview).split(/(?<=[.!?])\s/)[0];
  return clip(first, n);
}

function shortKey(key: string): string {
  if (key === COS_ID) return 'Chief of Staff';
  const { agentId, kind } = parseKey(key);
  return kind === 'main' ? agentId : `${agentId} ${kind}`;
}

function needsAsk(s: any, running: boolean): string | undefined {
  const note = s.statusNote ?? s.sidebar?.statusNote;
  if (note && (s.attention || s.sidebar?.attention)) return clip(note, 80);
  const p = String(s.lastMessagePreview ?? '');
  if (running || !p || p.startsWith('[')) return undefined; // inter-session / cron previews are not asks to Zach
  return ASK_RE.test(p) ? clip(p, 80) : undefined;
}

// ---------- source ----------
export function createLiveSource(): Source {
  const listeners = new Set<(d: Delta) => void>();
  const agents = new Map<string, Agent>();
  const raw = new Map<string, any>();
  const teams = new Map<string, Team>();
  const ring: FleetEvent[] = [];
  const identities = new Map<string, string>(); // agentId -> display name
  let lastError: string | undefined;
  let eid = 0;
  let first = true;
  let usageCostToday = 0;
  const usageSamples: Array<{ t: number; tok: number }> = []; // fleet-wide token counter from usage.cost
  let lastAgentsList = 0;
  let lastUsage = 0;
  const samples: Array<{ t: number; tok: number; cost: number }> = [];
  const startedAt = Date.now();
  const FIXED_HUES: Record<string, number> = { cos: 0, forge: 1, coordinator: 2 };

  function ensureTeam(id: string, name: string): Team {
    let t = teams.get(id);
    if (!t) {
      const used = new Set([...teams.values()].map((x) => x.hue));
      const fixed = FIXED_HUES[id];
      const hue = fixed !== undefined ? TEAM_PALETTE[fixed] : TEAM_PALETTE.find((h, i) => !used.has(h) && !Object.values(FIXED_HUES).includes(i)) ?? TEAM_PALETTE[teams.size % TEAM_PALETTE.length];
      teams.set(id, (t = { id, name, hue }));
    }
    return t;
  }

  function meters(): Meters {
    const t = Date.now();
    while (samples.length && t - samples[0].t > 15 * 60_000) samples.shift();
    const span = (ms: number) => Math.max(Math.min(ms, t - startedAt), 30_000) / 60_000;
    const tok5 = samples.filter((x) => t - x.t <= 5 * 60_000).reduce((s, x) => s + x.tok, 0);
    const cost15 = samples.reduce((s, x) => s + x.cost, 0);
    const sum = [...agents.values()].reduce((s, a) => s + a.costUsd, 0);
    const u0 = usageSamples[0];
    const u1 = usageSamples[usageSamples.length - 1];
    const usageRate = u0 && u1 && u1.t - u0.t >= 50_000 ? (u1.tok - u0.tok) / ((u1.t - u0.t) / 60_000) : 0;
    return {
      tokPerMin: Math.round(Math.max(tok5 / span(5 * 60_000), usageRate)),
      costPerHr: Math.round((cost15 / span(15 * 60_000)) * 60 * 100) / 100,
      totalCostUsd: Math.round(Math.max(usageCostToday, sum) * 100) / 100,
    };
  }

  const ev = (ts: number, from: string, to: string, kind: EventKind, text: string, needsYou?: boolean): FleetEvent =>
    ({ id: `l${eid++}`, ts, from, to, kind, text: clip(text, 140), ...(needsYou ? { needsYou: true } : {}) });

  async function refreshAux() {
    const t = Date.now();
    if (t - lastAgentsList > 5 * 60_000) {
      lastAgentsList = t;
      try {
        const r = await call('agents.list');
        for (const a of r.agents ?? []) if (a?.id) identities.set(a.id, String(a.identity?.name ?? a.name ?? a.id));
      } catch { /* optional */ }
    }
    if (t - lastUsage > 60_000) {
      lastUsage = t;
      try {
        const r = await call('usage.cost', { days: 1 });
        usageCostToday = Number(r?.totals?.totalCost ?? 0) || 0;
        const tok = Number(r?.totals?.totalTokens ?? 0) || 0;
        if (usageSamples.length && tok < usageSamples[usageSamples.length - 1].tok) usageSamples.length = 0; // day rollover
        usageSamples.push({ t, tok });
        while (usageSamples.length > 2 && t - usageSamples[0].t > 10 * 60_000) usageSamples.shift();
      } catch { /* optional: falls back to per-session estimates */ }
    }
  }

  async function fetchSessions(): Promise<any[]> {
    const out: any[] = [];
    let offset = 0;
    for (let page = 0; page < 5; page++) {
      const r = await call('sessions.list', { limit: 200, offset, includeLastMessage: true });
      out.push(...(r.sessions ?? []));
      if (!r.hasMore || typeof r.nextOffset !== 'number') break;
      offset = r.nextOffset;
    }
    return out;
  }

  async function poll() {
    let all: any[];
    try {
      await refreshAux();
      all = await fetchSessions();
      lastError = undefined;
    } catch (e) {
      lastError = `gateway unavailable (${(e as Error).message})`;
      broadcast({ ts: Date.now(), upserts: [], removed: [], events: [], meters: meters(), error: lastError });
      return;
    }
    const t = Date.now();
    const cutoff = t - WINDOW_HOURS * 3600_000;
    const live = all.filter((s) => s?.key && !s.archived);
    const recent = live.filter((s) => s.key === COS_ID || s.hasActiveRun || Number(s.updatedAt ?? 0) >= cutoff);
    // Team leads anchor their teams: keep a lead visible whenever any of its members is.
    const leadsNeeded = new Set(recent.map((s) => teamOf(s.agentId ?? parseKey(s.key).agentId).lead));
    const visible = live.filter((s) => recent.includes(s) || leadsNeeded.has(s.key));
    const visibleKeys = new Set(visible.map((s) => s.key));

    const teamsBefore = JSON.stringify([...teams.values()]);
    const upserts: Agent[] = [];
    const events: FleetEvent[] = [];
    let dTok = 0;
    let dCost = 0;

    // Active children per parent, for CoS/lead "now" lines.
    const activeKids = new Map<string, number>();
    for (const s of visible) {
      const p = s.parentSessionKey ?? s.spawnedBy;
      if (p && (s.hasActiveRun || s.status === 'running')) activeKids.set(p, (activeKids.get(p) ?? 0) + 1);
    }

    for (const s of visible) {
      const { agentId: keyAgent, kind, tail } = parseKey(s.key);
      const agentId: string = s.agentId ?? keyAgent;
      const tm = teamOf(agentId);
      const team = ensureTeam(tm.id, tm.name);
      if (visibleKeys.has(tm.lead)) team.lead = tm.lead; else delete team.lead;
      const isCos = s.key === COS_ID;
      const role: Agent['role'] = isCos ? 'cos' : s.key === tm.lead ? 'lead' : 'worker';

      let parent: string | undefined = isCos ? undefined : (s.parentSessionKey ?? s.spawnedBy);
      if (!isCos && (!parent || !visibleKeys.has(parent) || parent === s.key)) {
        parent = role === 'lead' || !visibleKeys.has(tm.lead) ? COS_ID : tm.lead;
      }

      const running = Boolean(s.hasActiveRun || s.status === 'running' || s.subagentRunState === 'active');
      const updatedAt = Number(s.updatedAt ?? s.lastActivityAt ?? 0);
      const errored = Boolean(s.abortedLastRun) || ERROR_STATUSES.has(String(s.status ?? ''));
      const ask = errored ? undefined : needsAsk(s, running);
      const status: AgentStatus = errored ? 'error' : ask ? 'needs' : running || t - updatedAt < ACTIVE_MS ? 'active' : 'idle';

      const label = s.label ? clip(String(s.label).replace(/^Automation:\s*/, ''), 48) : undefined;
      const name = isCos ? 'Chief of Staff'
        : kind === 'main' ? (identities.get(agentId) ?? agentId)
        : label ? clip(label, 28) : `${agentId}-${tail.slice(0, 6)}`;
      const preview = String(s.lastMessagePreview ?? '');
      const g = gist(preview);
      const now = clip(
        status === 'error' ? `${s.abortedLastRun ? 'Aborted' : cap(String(s.status))}${label ? ` · ${label}` : ''}`
        : status === 'needs' ? `Needs you: ${ask}`
        : isCos && running ? 'Working with Zach'
        : role !== 'worker' && !running && activeKids.get(s.key) ? `Overseeing ${activeKids.get(s.key)} active ${activeKids.get(s.key) === 1 ? 'worker' : 'workers'}`
        : isCos ? (s.status === 'done' ? 'Waiting for Zach' : 'Idle')
        : running ? (g && !g.startsWith('Message from') && !g.startsWith('Cron:') ? g : label ? `Working: ${label}` : 'Working')
        : s.status === 'done' ? `Done · ${g || label || 'finished'}`
        : g || label || 'Idle', 60);

      const tokens = Number(s.totalTokens ?? (Number(s.inputTokens ?? 0) + Number(s.outputTokens ?? 0))) || 0;
      const costUsd = Number(s.estimatedCostUsd ?? 0) || 0;
      const a: Agent = {
        id: s.key, name, team: tm.id, role, ...(parent ? { parent } : {}), status, now, costUsd, tokens,
        ...(s.model ? { model: String(s.model) } : {}), updatedAt, agentId, kind,
        ...(label ? { label } : {}), ...(ask ? { ask } : {}),
      };

      const prev = raw.get(s.key);
      const prevA = agents.get(s.key);
      if (prevA) { dTok += Math.max(0, tokens - prevA.tokens); dCost += Math.max(0, costUsd - prevA.costUsd); }
      const to = a.parent ?? 'zach';

      if (first) {
        // Seed the stream with recent history so a fresh client has context.
        const created = Number(s.createdAt ?? 0);
        if (kind === 'subagent' && created >= cutoff) events.push(ev(created, to, a.id, 'handoff', `Spawned ${name}${label && label !== name ? `: ${label}` : ''}`));
        const inter = preview.match(INTER_RE);
        const at = Number(s.lastActivityAt ?? updatedAt);
        if (inter && visibleKeys.has(inter[1])) events.push(ev(at, inter[1], a.id, 'message', `Message to ${name}`));
        else if (preview && !isCos && !preview.startsWith('[')) events.push(ev(at, a.id, to, /FORGE-REPORT/.test(preview) || s.status === 'done' ? 'report' : 'message', g));
        if (ask) events.push(ev(at, a.id, 'zach', 'approval', ask, true));
      } else if (!prev) {
        if (kind === 'subagent') events.push(ev(t, to, a.id, 'handoff', `Spawned ${name}${label && label !== name ? `: ${label}` : ''}`));
        else events.push(ev(t, a.id, to, 'event', kind === 'cron' ? `Cron run: ${label ?? name}` : `${name} came online`));
        if (ask) events.push(ev(t, a.id, 'zach', 'approval', ask, true));
      } else {
        const prevPreview = String(prev.lastMessagePreview ?? '');
        if (preview && preview !== prevPreview) {
          const inter = preview.match(INTER_RE);
          if (inter) {
            events.push(ev(t, inter[1], a.id, 'message', `Message to ${name}`));
          } else if (!isCos && !preview.startsWith('[')) {
            const kindE: EventKind = /FORGE-REPORT/.test(preview) || s.status === 'done' ? 'report' : 'message';
            const asksCos = to === COS_ID && ASK_RE.test(preview);
            events.push(ev(t, a.id, to, kindE, g, asksCos || undefined));
          }
        } else if (prev.status !== s.status && s.status && s.status !== 'running') {
          events.push(ev(t, a.id, to, status === 'error' ? 'event' : 'report', status === 'error' ? `${name}: ${s.abortedLastRun ? 'aborted' : s.status}` : `${name} finished${g ? ` · ${g}` : ''}`));
        }
        if (ask && prevA?.ask !== ask) events.push(ev(t, a.id, 'zach', 'approval', ask, true));
      }

      raw.set(s.key, s);
      if (!prevA || JSON.stringify(prevA) !== JSON.stringify(a)) upserts.push(a);
      agents.set(s.key, a);
    }

    const removed = [...agents.keys()].filter((k) => !visibleKeys.has(k));
    for (const k of removed) { agents.delete(k); raw.delete(k); }
    const liveTeams = new Set([...agents.values()].map((a) => a.team));
    for (const id of [...teams.keys()]) if (!liveTeams.has(id)) teams.delete(id);
    if (!first) samples.push({ t, tok: dTok, cost: dCost });

    events.sort((x, y) => x.ts - y.ts);
    ringPush(ring, first ? events.slice(-200) : events);
    const teamsChanged = JSON.stringify([...teams.values()]) !== teamsBefore;
    first = false;
    broadcast({ ts: t, upserts, removed, events: events.slice(-200), meters: meters(), ...(teamsChanged ? { teams: [...teams.values()] } : {}) });
  }

  function broadcast(d: Delta) { for (const l of listeners) l(d); }

  let stopped = false;
  let interval = POLL_MS;
  const ready = poll();
  (async function loop() {
    await ready;
    while (!stopped) {
      await new Promise((r) => setTimeout(r, interval));
      if (stopped) break;
      slowSince = 0;
      await poll();
      // Back off while the Gateway is slow or failing; recover gradually.
      interval = slowSince || lastError ? Math.min(interval * 2, MAX_POLL_MS) : Math.max(POLL_MS, Math.round(interval / 2));
    }
  })();

  return {
    snapshot(): Snapshot {
      return { source: 'live', ts: Date.now(), teams: [...teams.values()], agents: [...agents.values()], events: ring.slice(-200), meters: meters(), windowHours: WINDOW_HOURS, ...(lastError ? { error: lastError } : {}) };
    },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    async history(key): Promise<HistoryItem[]> {
      if (!agents.has(key)) return [];
      const res = await call('chat.history', { sessionKey: key, limit: 40 }, 15_000);
      const msgs: any[] = (res.messages ?? []).slice(-40);
      return msgs.map((m) => {
        const body = typeof m.content === 'string' ? m.content : Array.isArray(m.content)
          ? m.content.map((c: any) => (c?.type === 'text' ? c.text : c?.type === 'toolCall' || c?.type === 'tool_use' ? `⚙ ${c.name ?? 'tool'}` : '')).filter(Boolean).join(' ')
          : '';
        const sender = m.senderLabel ?? (m.senderSession?.sessionKey ? shortKey(m.senderSession.sessionKey) : undefined);
        return { role: String(m.role ?? '?'), ts: Number(m.timestamp ?? 0), ...(sender ? { sender: clip(sender, 60) } : {}), text: clip(body, 600) };
      }).filter((m) => m.text);
    },
    close() { stopped = true; },
    ready,
  } as Source & { ready: Promise<void> };
}
