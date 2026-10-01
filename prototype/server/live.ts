// Live fleet from the local Gateway via `openclaw gateway call` (READ methods only).
// The CLI resolves Gateway auth itself; no token ever passes through this process or the browser.
import { execFile } from 'node:child_process';
import { COS_ID, TEAM_PALETTE, type Agent, type AgentStatus, type Delta, type FleetEvent, type HistoryItem, type Meters, type Snapshot, type Team } from '../shared/types.ts';
import { ringPush } from './mock.ts';
import type { Source } from './source.ts';

const READ_METHODS = new Set(['sessions.list', 'agents.list', 'chat.history']);
const POLL_MS = 2500;

function call(method: string, params: Record<string, unknown> = {}, timeoutMs = 10_000): Promise<any> {
  if (!READ_METHODS.has(method)) return Promise.reject(new Error(`method not allowed: ${method}`));
  return new Promise((resolve, reject) => {
    execFile('openclaw', ['gateway', 'call', method, '--json', '--params', JSON.stringify(params), '--timeout', String(timeoutMs)],
      { maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs + 5000 }, (err, stdout) => {
        if (err) return reject(new Error(`${method} failed`)); // never echo stderr: it may carry config details
        try { resolve(JSON.parse(stdout)); } catch { reject(new Error(`${method}: bad JSON`)); }
      });
  });
}

// Conservative redaction for anything that leaves the server.
const SECRET_RES = [
  /\b(sk|pk|rk|ghp|gho|glpat|xox[abpr])[-_][A-Za-z0-9_\-]{12,}\b/g,
  /\b(bearer|token|api[_-]?key|password|secret)\b(\s*[:=]\s*|\s+)["']?[^\s"']{6,}/gi,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g,
];
export function redact(s: string): string {
  let out = s;
  for (const re of SECRET_RES) out = out.replace(re, (m, a) => (typeof a === 'string' && /^(bearer|token|api|password|secret)/i.test(a) ? `${a}=[redacted]` : '[redacted]'));
  return out;
}
const clip = (s: unknown, n = 160) => redact(String(s ?? '').replace(/\s+/g, ' ').trim()).slice(0, n);

function teamOf(agentId: string): { id: string; name: string } {
  if (agentId === 'main') return { id: 'main', name: 'Main assistant' };
  if (agentId.startsWith('forge')) return { id: 'forge', name: 'Forge' };
  const base = agentId.split(/[-_]/)[0];
  return { id: base, name: base.charAt(0).toUpperCase() + base.slice(1) };
}

function statusOf(s: any): AgentStatus {
  const prev = String(s.lastMessagePreview ?? '');
  if (s.status === 'killed' || s.status === 'failed' || s.status === 'error') return 'error';
  if (/decision_needed|status:\s*blocked|waiting (on|for) (you|approval)|needs approval/i.test(prev)) return 'needs';
  if (s.hasActiveRun || s.status === 'running') return 'active';
  return 'idle';
}

function nowLine(s: any, st: AgentStatus): string {
  if (st === 'needs') return 'Needs you';
  const p = clip(s.lastMessagePreview, 80);
  if (st === 'active') return p || 'running';
  if (s.status === 'done') return p ? `done · ${p}` : 'done';
  return p || (s.status ?? 'idle');
}

function shortName(s: any): string {
  const key: string = s.key;
  if (key === COS_ID) return 'Chief of Staff';
  const m = key.match(/^agent:([^:]+):(.*)$/);
  const agent = m?.[1] ?? key;
  const rest = m?.[2] ?? '';
  if (rest === 'main') return agent;
  const tail = rest.split(':').pop()?.slice(0, 6) ?? '';
  const kind = rest.startsWith('cron') ? 'cron' : rest.startsWith('subagent') ? '' : rest.split(':')[0];
  return `${agent.replace(/^forge-/, '')}${kind ? `-${kind}` : ''}-${tail}`;
}

export function createLiveSource(): Source {
  const listeners = new Set<(d: Delta) => void>();
  const agents = new Map<string, Agent>();
  const raw = new Map<string, any>();
  const teams = new Map<string, Team>();
  const ring: FleetEvent[] = [];
  let lastError: string | undefined;
  let eid = 0;
  let first = true;
  const costSamples: Array<{ t: number; cost: number; tok: number }> = [];

  function ensureTeam(id: string, name: string) {
    if (!teams.has(id)) teams.set(id, { id, name, hue: TEAM_PALETTE[teams.size % TEAM_PALETTE.length] });
    return teams.get(id)!;
  }
  ensureTeam('main', 'Main assistant').lead = COS_ID;

  function meters(): Meters {
    const list = [...agents.values()];
    const total = list.reduce((s, a) => s + a.costUsd, 0);
    const tok = list.reduce((s, a) => s + a.tokens, 0);
    const t = Date.now();
    costSamples.push({ t, cost: total, tok });
    while (costSamples.length > 2 && t - costSamples[0].t > 10 * 60_000) costSamples.shift();
    const a = costSamples[0];
    const dtMin = Math.max((t - a.t) / 60_000, 1 / 60);
    return { tokPerMin: Math.max(0, Math.round((tok - a.tok) / dtMin)), costPerHr: Math.max(0, ((total - a.cost) / dtMin) * 60), totalCostUsd: total };
  }

  async function poll() {
    let res: any;
    try {
      res = await call('sessions.list', { limit: 200, includeLastMessage: true });
      lastError = undefined;
    } catch (e) {
      lastError = (e as Error).message;
      broadcast({ ts: Date.now(), upserts: [], removed: [], events: [], meters: meters(), error: lastError });
      return;
    }
    const sessions: any[] = (res.sessions ?? []).filter((s: any) => !s.archived);
    const seen = new Set<string>();
    const upserts: Agent[] = [];
    const events: FleetEvent[] = [];
    const teamCountBefore = teams.size;

    for (const s of sessions) {
      seen.add(s.key);
      const t = teamOf(s.agentId ?? 'unknown');
      const team = ensureTeam(t.id, t.name);
      const leadKey = t.id === 'main' ? COS_ID : `agent:${t.id}:main`;
      if (s.key === leadKey) team.lead = leadKey;
      const fallback = s.key === COS_ID ? undefined : s.key === leadKey ? COS_ID : leadKey;
      const parent: string | undefined = s.parentSessionKey ?? s.spawnedBy ?? fallback;
      const st = statusOf(s);
      const a: Agent = {
        id: s.key, name: shortName(s), team: t.id, role: s.key === COS_ID ? 'cos' : s.key === team.lead ? 'lead' : 'worker',
        parent: s.key === COS_ID ? undefined : parent, status: st, now: nowLine(s, st),
        costUsd: Number(s.estimatedCostUsd ?? 0), tokens: Number(s.totalTokens ?? 0), model: s.model,
        updatedAt: Number(s.updatedAt ?? s.lastActivityAt ?? 0),
      };
      const prev = raw.get(s.key);
      const prevA = agents.get(s.key);
      if (!first) {
        if (!prev) {
          events.push({ id: `l${eid++}`, ts: Date.now(), from: a.parent ?? COS_ID, to: a.id, kind: 'handoff', text: `spawned ${a.name}` });
        } else if ((prev.lastMessagePreview ?? '') !== (s.lastMessagePreview ?? '') && s.lastMessagePreview) {
          const text = clip(s.lastMessagePreview, 120);
          const kind = /FORGE-REPORT/.test(text) ? 'report' : st === 'needs' ? 'approval' : 'message';
          events.push({ id: `l${eid++}`, ts: Date.now(), from: a.id, to: st === 'needs' ? 'zach' : (a.parent ?? COS_ID), kind, text, needsYou: st === 'needs' || undefined });
        } else if (prev.status !== s.status) {
          events.push({ id: `l${eid++}`, ts: Date.now(), from: a.id, to: a.parent ?? COS_ID, kind: 'event', text: `${prev.status ?? '?'} → ${s.status ?? '?'}` });
        }
      } else if (st === 'needs') {
        events.push({ id: `l${eid++}`, ts: a.updatedAt || Date.now(), from: a.id, to: 'zach', kind: 'approval', text: clip(s.lastMessagePreview, 120), needsYou: true });
      }
      raw.set(s.key, s);
      if (!prevA || JSON.stringify(prevA) !== JSON.stringify(a)) upserts.push(a);
      agents.set(s.key, a);
    }
    // Seed initial stream with recent last messages so the panel is not empty.
    if (first) {
      const recent = [...agents.values()].filter((a) => a.updatedAt && raw.get(a.id)?.lastMessagePreview).sort((x, y) => x.updatedAt - y.updatedAt).slice(-40);
      for (const a of recent) {
        const text = clip(raw.get(a.id).lastMessagePreview, 120);
        events.push({ id: `l${eid++}`, ts: a.updatedAt, from: a.id, to: a.parent ?? COS_ID, kind: /FORGE-REPORT/.test(text) ? 'report' : 'message', text });
      }
      events.sort((x, y) => x.ts - y.ts);
    }
    const removed = [...agents.keys()].filter((k) => !seen.has(k));
    for (const k of removed) { agents.delete(k); raw.delete(k); }
    ringPush(ring, events);
    first = false;
    if (upserts.length || removed.length || events.length || teams.size !== teamCountBefore) {
      broadcast({ ts: Date.now(), upserts, removed, events, meters: meters(), teams: [...teams.values()] });
    }
  }

  function broadcast(d: Delta) { for (const l of listeners) l(d); }

  let stopped = false;
  const ready = poll();
  (async function loop() {
    await ready;
    while (!stopped) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      if (!stopped) await poll();
    }
  })();

  return {
    snapshot(): Snapshot {
      return { source: 'live', ts: Date.now(), teams: [...teams.values()], agents: [...agents.values()], events: ring.slice(-200), meters: meters(), error: lastError };
    },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    async history(key): Promise<HistoryItem[]> {
      if (!agents.has(key)) return [];
      const res = await call('chat.history', { sessionKey: key, limit: 40 }, 15_000);
      const msgs: any[] = (res.messages ?? []).slice(-40);
      return msgs.map((m) => ({
        role: String(m.role ?? '?'), ts: Number(m.timestamp ?? 0), sender: m.senderLabel ? clip(m.senderLabel, 60) : undefined,
        text: clip(typeof m.content === 'string' ? m.content : Array.isArray(m.content)
          ? m.content.map((c: any) => (c?.type === 'text' ? c.text : c?.type === 'toolCall' || c?.type === 'tool_use' ? `⚙ ${c.name ?? 'tool'}` : '')).filter(Boolean).join(' ')
          : '', 600),
      })).filter((m) => m.text);
    },
    close() { stopped = true; },
    ready,
  } as Source & { ready: Promise<void> };
}
