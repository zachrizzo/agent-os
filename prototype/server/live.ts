// Live fleet from the local Gateway via `openclaw gateway call`: READ methods, plus one write, sessions.send ("Message agent").
// The CLI resolves Gateway auth itself; no token ever passes through this process or the browser.
// At most one CLI call is in flight at a time; slow calls (>2s) back the poll interval off.
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { COS_ID, TEAM_PALETTE, type Agent, type AgentStatus, type Delta, type EventKind, type FleetEvent, type HistoryItem, type Meters, type Snapshot, type Team } from '../shared/types.ts';
import { parseInterSession, shortSession } from '../shared/a2a.ts';
import { attentionEvent, deriveSessionEvents, mergeEvents, sessionMetaOf, spawnEvent, openNeedsOf, type RawMessage } from '../shared/activity.ts';
import { classifySession, isRunning } from '../shared/liveness.ts';
import { BOARDS, normalizeCard, type BoardCard } from '../shared/board.ts';
import { isExcludedAgent, judgeSessionKey, type TurnProgress, type TurnResult } from '../shared/rooms.ts';
import { toolInFlight, usageFromMessages } from '../shared/turn-usage.ts';
import { nowFromProgress, progressOf, type RunProgress } from '../shared/progress.ts';
import { routeMessage, type Routed } from '../shared/route.ts';
import { scopedRows, sessionTree, toSessionRow, type SessionRow, type SessionScope } from '../shared/sessions.ts';
import { redact } from './redact.ts';
import { createRoomsService, isRoomKey, listAgentsWithFallback, roomSessionKey, type RoomAgent, type RoomGateway } from './rooms.ts';
import type { Source } from './source.ts';

const READ_METHODS = new Set(['sessions.list', 'agents.list', 'chat.history', 'usage.cost', 'workboard.cards.list']);
const SEND_METHOD = 'sessions.send';
const CREATE_METHOD = 'sessions.create'; // only for dedicated room sessions (agent:<id>:room-<roomId>), see call()
const ABORT_METHOD = 'chat.abort'; // Stop / member timeout: only for dedicated room sessions, see call()
const ROOM_POLL_MS = 1200;
const JUDGE_MODEL = process.env.AGENT_OS_JUDGE_MODEL ?? 'anthropic/claude-haiku-4-5'; // the speak filter's small model (opt-in per room)
const agentOfKey = (key: unknown) => String(key ?? '').match(/^agent:([^:]+):/)?.[1] ?? '';
const MAX_MESSAGE_CHARS = 4000;
const HIST_PER_POLL = 2; // chat.history reads per poll (single-flight CLI; main's history is ~3 MB)
const HIST_MESSAGES = 120;
const PROGRESS_PER_POLL = 2;
const PROGRESS_EVERY_MS = 8000;
const RING_MAX = 600;
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
  if (!READ_METHODS.has(method) && method !== SEND_METHOD && method !== CREATE_METHOD && method !== ABORT_METHOD) return Promise.reject(new Error(`method not allowed: ${method}`));
  if (method === CREATE_METHOD && !isRoomKey(String(params.key))) return Promise.reject(new Error('sessions.create is only allowed for room sessions'));
  if (method === ABORT_METHOD && !isRoomKey(String(params.sessionKey))) return Promise.reject(new Error('chat.abort is only allowed for room sessions'));
  if (method === SEND_METHOD && isExcludedAgent(agentOfKey(params.key))) return Promise.reject(new Error('unknown session')); // the PHI agent is never messaged
  if (method === 'chat.history' && isExcludedAgent(agentOfKey(params.sessionKey))) return Promise.reject(new Error('unknown session')); // ...nor read
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

/** `openclaw agents list --json`: the fallback when the Gateway's agents.list response is too big for `gateway call`. Output includes avatar data URLs, so the buffer is generous; stderr is never echoed. */
const agentsViaCli = () => new Promise<unknown>((resolve, reject) => {
  execFile(OPENCLAW, ['agents', 'list', '--json'], { maxBuffer: 64 * 1024 * 1024, timeout: 30_000, env: CHILD_ENV }, (err, stdout) => {
    if (err) return reject(new Error('agents list failed'));
    try { resolve(JSON.parse(stdout)); } catch { reject(new Error('agents list: bad JSON')); }
  });
});

// ---------- text helpers ----------
const oneLine = (s: unknown) => redact(String(s ?? '').replace(/[`*#>]+/g, '').replace(/\s+/g, ' ').trim());
const clip = (s: unknown, n: number) => { const t = oneLine(s); return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t; };
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

const ERROR_STATUSES = new Set(['killed', 'failed', 'error', 'aborted', 'timeout', 'timed_out', 'crashed']);
const INTERNAL_PREVIEW_RE = /^\s*(\[OpenClaw (heartbeat|exec)[^\]]*\]|NO_REPLY|HEARTBEAT_OK)/i;
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
  if (!preview || INTERNAL_PREVIEW_RE.test(preview)) return '';
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
  if (key === COS_ID || parseKey(key).agentId === 'main') return 'Chief of Staff';
  const { agentId, kind } = parseKey(key);
  return kind === 'main' ? agentId : `${agentId} ${kind}`;
}

/** Only an explicit attention flag + note from the session means it awaits Zach; reply-text heuristics live in shared/activity.ts and are scoped to real replies to Zach. */
function needsAsk(s: any): string | undefined {
  const note = s.statusNote ?? s.sidebar?.statusNote;
  return note && (s.attention || s.sidebar?.attention) ? clip(note, 80) : undefined;
}

// ---------- source ----------
export function createLiveSource(): Source {
  const listeners = new Set<(d: Delta) => void>();
  const agents = new Map<string, Agent>();
  const raw = new Map<string, any>();
  let everySession: any[] = [];
  const teams = new Map<string, Team>();
  const ring: FleetEvent[] = [];
  const identities = new Map<string, string>(); // agentId -> display name
  const histSig = new Map<string, string>(); // session key -> run-state signature last read from history
  const progress = new Map<string, { at: number; p?: RunProgress }>();
  const agentLabel = (agentId: string, isCos: boolean) => (isCos || agentId === 'main' ? 'Chief of Staff' : identities.get(agentId) ?? cap(agentId));
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
    everySession = all.filter((s) => s?.key && !isExcludedAgent(agentOfKey(s.key)));
    const t = Date.now();
    const cutoff = t - WINDOW_HOURS * 3600_000;
    // Archived/finished sessions stay in the feed flagged `retired`; the browser hides them behind History.
    // Group-room sessions (agent:<id>:room-<roomId>) belong to the Rooms view; keeping them off the map/Activity leaves main and Forge views untouched.
    const live = all.filter((s) => s?.key && !isRoomKey(s.key) && !isExcludedAgent(agentOfKey(s.key)));
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

    const evOpts = { redact, since: cutoff };
    const openAsk = new Map<string, string>(); // session -> what it is asking Zach, from its latest real reply
    for (const e of openNeedsOf(ring, t)) if (e.to === 'zach') openAsk.set(e.from, clip(e.text, 80));
    const histDue: Array<{ s: any; meta: ReturnType<typeof sessionMetaOf>; sig: string; at: number }> = [];

    const runningKeys = new Set(visible.filter((s) => isRunning(s)).map((s) => s.key));
    for (const k of [...progress.keys()]) if (!runningKeys.has(k)) progress.delete(k);
    const progressDue = [...runningKeys].filter((k) => t - (progress.get(k)?.at ?? 0) >= PROGRESS_EVERY_MS)
      .sort((x, y) => (progress.get(x)?.at ?? 0) - (progress.get(y)?.at ?? 0)).slice(0, PROGRESS_PER_POLL);
    for (const k of progressDue) {
      try {
        const h = await call('chat.history', { sessionKey: k, limit: 1 }, 10_000);
        progress.set(k, { at: t, p: progressOf(h?.inFlightRun) });
      } catch { progress.set(k, { at: t, p: progress.get(k)?.p }); }
    }
    const lastOwn = new Map<string, string>();
    for (const e of ring) if (!e.sys && e.kind !== 'handoff' && e.from !== 'zach') lastOwn.set(e.from, e.text);

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

      const running = isRunning(s);
      const retired = !isCos && classifySession(s, t) === 'finished';
      const updatedAt = Number(s.updatedAt ?? s.lastActivityAt ?? 0);
      const errored = Boolean(s.abortedLastRun) || ERROR_STATUSES.has(String(s.status ?? ''));
      const ask = errored || retired ? undefined : needsAsk(s) ?? openAsk.get(s.key);
      const status: AgentStatus = errored ? 'error' : ask ? 'needs' : running || t - updatedAt < ACTIVE_MS ? 'active' : 'idle';

      const label = s.label ? clip(String(s.label).replace(/^Automation:\s*/, ''), 48) : undefined;
      const name = isCos ? 'Chief of Staff'
        : kind === 'main' ? (identities.get(agentId) ?? agentId)
        : label ? clip(label, 28) : `${agentId}-${tail.slice(0, 6)}`;
      const preview = String(s.lastMessagePreview ?? '');
      const g = gist(preview);
      const own = g && !g.startsWith('Message from') && !g.startsWith('Cron:') ? g : '';
      const outcome = lastOwn.get(s.key) ?? own;
      const doing = progress.get(s.key)?.p;
      const now = clip(
        status === 'error' ? `${s.abortedLastRun ? 'Aborted' : cap(String(s.status))}${label ? ` · ${label}` : ''}`
        : status === 'needs' ? `Needs you: ${ask}`
        : isCos && running ? nowFromProgress(doing, 'Working with Zach')
        : role !== 'worker' && !running && activeKids.get(s.key) ? `Overseeing ${activeKids.get(s.key)} active ${activeKids.get(s.key) === 1 ? 'worker' : 'workers'}`
        : isCos ? (s.status === 'done' ? 'Waiting for Zach' : 'Idle')
        : running ? nowFromProgress(doing, own || (label ? `Working: ${label}` : 'Working'))
        : s.status === 'done' ? `Done · ${outcome || label || 'finished'}`
        : outcome ? `Idle · ${outcome}` : label || 'Idle', 80);

      const tokens = Number(s.totalTokens ?? (Number(s.inputTokens ?? 0) + Number(s.outputTokens ?? 0))) || 0;
      const costUsd = Number(s.estimatedCostUsd ?? 0) || 0;
      const a: Agent = {
        id: s.key, name, agentName: agentLabel(agentId, isCos), team: tm.id, role, ...(parent ? { parent } : {}), status, now, costUsd, tokens,
        ...(s.model ? { model: String(s.model) } : {}), updatedAt, agentId, kind,
        ...(label ? { label } : {}), ...(ask ? { ask } : {}), ...(retired ? { retired: true } : {}),
      };

      const prevA = agents.get(s.key);
      if (prevA) { dTok += Math.max(0, tokens - prevA.tokens); dCost += Math.max(0, costUsd - prevA.costUsd); }

      // Activity: a spawn is a Handoff (parent -> child agent, task label secondary); needs-you comes from the session's own attention flag.
      const meta = sessionMetaOf(s);
      const sp = spawnEvent({ ...meta, ...(a.parent ? { parent: a.parent } : {}) }, evOpts);
      if (sp) events.push(sp);
      const at = attentionEvent(meta, updatedAt || t, evOpts);
      if (at) events.push(at);
      // Everything else (messages, outcomes, Done/Blocked) is read from the session's history, never from the list preview.
      const sig = [s.lastRunId, s.status, s.endedAt, s.hasActiveRun ? 1 : 0, s.abortedLastRun ? 1 : 0].join('|');
      if (!retired || updatedAt >= cutoff) if (histSig.get(s.key) !== sig) histDue.push({ s, meta: { ...meta, ...(a.parent && meta.kind === 'subagent' ? { parent: a.parent } : {}) }, sig, at: updatedAt });

      raw.set(s.key, s);
      if (!prevA || JSON.stringify(prevA) !== JSON.stringify(a)) upserts.push(a);
      agents.set(s.key, a);
    }

    // Read history for sessions whose run state changed: newest first, a couple per poll so the backfill never starves the poll loop.
    histDue.sort((x, y) => y.at - x.at);
    for (const d of histDue.slice(0, HIST_PER_POLL)) {
      try {
        const h = await call('chat.history', { sessionKey: d.s.key, limit: 80 }, 15_000);
        const msgs = ((h.messages ?? []) as RawMessage[]).slice(-HIST_MESSAGES);
        events.push(...deriveSessionEvents(d.meta, msgs, evOpts));
        histSig.set(d.s.key, d.sig);
      } catch { /* retried next poll; the list-derived events above still stand */ }
    }

    const removed = [...agents.keys()].filter((k) => !visibleKeys.has(k));
    for (const k of removed) { agents.delete(k); raw.delete(k); }
    const liveTeams = new Set([...agents.values()].map((a) => a.team));
    for (const id of [...teams.keys()]) if (!liveTeams.has(id)) teams.delete(id);
    if (!first) samples.push({ t, tok: dTok, cost: dCost });

    const fresh = mergeEvents(ring, events, RING_MAX);
    const teamsChanged = JSON.stringify([...teams.values()]) !== teamsBefore;
    first = false;
    broadcast({ ts: t, upserts, removed, events: fresh, meters: meters(), ...(teamsChanged ? { teams: [...teams.values()] } : {}) });
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

  // ---------- group rooms ----------
  const createdRoomSessions = new Set<string>();
  const roomGateway: RoomGateway = {
    listAgents: (): Promise<RoomAgent[]> => listAgentsWithFallback(() => call('agents.list'), agentsViaCli),
    async ensureSession(agentId, roomId, label) {
      const key = roomSessionKey(agentId, roomId);
      if (createdRoomSessions.has(key)) return;
      try { await call(CREATE_METHOD, { key, label: label.slice(0, 80) }, 20_000); } catch (e) {
        // Already exists (restart / second run) is fine; anything else surfaces on the first send.
        try { await call('chat.history', { sessionKey: key, limit: 1 }, 10_000); } catch { throw e; }
      }
      createdRoomSessions.add(key);
    },
    async abort(agentId, roomId) {
      await call(ABORT_METHOD, { sessionKey: roomSessionKey(agentId, roomId) }, 15_000);
    },
    async turn(agentId, roomId, prompt, signal, progress) {
      return turnOn(roomSessionKey(agentId, roomId), prompt, signal, progress);
    },
    /** The speak filter's call: a dedicated session on a small model (sessions.create `model`). Any failure throws and the room lets everyone speak. */
    async judge(roomId, agentId, prompt, signal) {
      const key = judgeSessionKey(agentId, roomId);
      if (!createdRoomSessions.has(key)) {
        try { await call(CREATE_METHOD, { key, label: `Room judge ${roomId}`, model: JUDGE_MODEL }, 20_000); } catch (e) {
          try { await call('chat.history', { sessionKey: key, limit: 1 }, 10_000); } catch { throw e; }
        }
        createdRoomSessions.add(key);
      }
      return (await turnOn(key, prompt, signal)).text;
    },
  };
  /** One turn on a room session: send, poll the transcript until the run is idle, return the last reply with the turn's usage (when the Gateway reports it). */
  async function turnOn(key: string, prompt: string, signal: AbortSignal, progress?: (p: TurnProgress) => void): Promise<Extract<TurnResult, object>> {
    const seqOf = (m: any) => Number(m?.__openclaw?.seq ?? 0);
    const peek = async () => { const h = await call('chat.history', { sessionKey: key, limit: 60 }, 15_000); return { msgs: (h.messages ?? []) as any[], active: Boolean(h.sessionInfo?.hasActiveRun) }; };
    const base = Math.max(0, ...(await peek()).msgs.map(seqOf));
    await call(SEND_METHOD, { key, message: prompt, idempotencyKey: randomUUID() }, 20_000);
    let sawUser = false;
    let quiet = 0;
    for (;;) { // no deadline: a reply, an error, or Stop (signal) ends it
      if (signal.aborted) throw new Error('cancelled');
      await new Promise((r) => setTimeout(r, ROOM_POLL_MS));
      const { msgs, active } = await peek();
      const fresh = msgs.filter((m) => seqOf(m) > base);
      sawUser ||= fresh.some((m) => m.role === 'user');
      const text = (m: any) => (typeof m.content === 'string' ? m.content : Array.isArray(m.content) ? m.content.filter((c: any) => c?.type === 'text').map((c: any) => c.text).join('\n') : '');
      // Only assistant text after our own prompt: a late reply from a run that was stopped earlier on this session must not be taken for this turn's answer.
      const userSeq = Math.min(...fresh.filter((m) => m.role === 'user').map(seqOf));
      const replies = fresh.filter((m) => m.role === 'assistant' && text(m).trim() && seqOf(m) > userSeq);
      if (sawUser && active) progress?.({ tool: toolInFlight(fresh) });
      if (sawUser && !active) {
        if (replies.length) return { text: redact(text(replies[replies.length - 1]).trim()), usage: usageFromMessages(fresh) };
        if (++quiet >= 3) { // the Gateway records a failed model call as an assistant message with an error: surface it so the room can tell a rate limit from an auth failure
          const err = fresh.filter((m) => m.role === 'assistant' && typeof m.errorMessage === 'string' && m.errorMessage.trim()).map((m) => clip(m.errorMessage, 240)).pop();
          throw new Error(err ? `the run ended without a reply: ${err}` : 'the run ended without a reply (model unavailable?)');
        }
      } else quiet = 0;
    }
  }
  const roomsFile = process.env.AGENT_OS_ROOMS_FILE ?? `${process.env.HOME ?? ''}/.openclaw/agent-os/rooms.json`;
  const rooms = createRoomsService({ gateway: roomGateway, file: roomsFile });

  return {
    rooms,
    snapshot(): Snapshot {
      return { source: 'live', ts: Date.now(), teams: [...teams.values()], agents: [...agents.values()], events: ring.slice(-400), meters: meters(), windowHours: WINDOW_HOURS, ...(lastError ? { error: lastError } : {}) };
    },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    async sessions(scope: SessionScope): Promise<SessionRow[]> {
      const rows = everySession.map((s) => {
        const row = toSessionRow(s);
        const preview = gist(String(s.lastMessagePreview ?? ''), 90);
        return { ...row, label: clip(row.label, 80), ...(preview ? { preview } : {}) };
      });
      return sessionTree(scopedRows(rows, scope)).map((n) => n.row);
    },
    async history(key, limit = 40): Promise<HistoryItem[]> {
      if (!agents.has(key) && !everySession.some((s) => s.key === key)) return [];
      const res = await call('chat.history', { sessionKey: key, limit }, 15_000);
      const msgs: any[] = (res.messages ?? []).slice(-limit);
      return msgs.map((m): HistoryItem => {
        const raw = typeof m.content === 'string' ? m.content : Array.isArray(m.content)
          ? m.content.map((c: any) => (c?.type === 'text' ? c.text : c?.type === 'toolCall' || c?.type === 'tool_use' ? `⚙ ${c.name ?? 'tool'}` : '')).filter(Boolean).join(' ')
          : '';
        const role = String(m.role ?? '?');
        const ts = Number(m.timestamp ?? 0);
        // Agent-to-agent traffic: show "sender → this session: body" and keep the wrapper out of the way. Display only; the transcript is untouched.
        const inter = role === 'user' ? parseInterSession(raw) : null;
        if (inter) return { role, ts, sender: clip(shortSession(inter.from), 60), text: clip(inter.body, 600), a2a: { from: inter.from, ...(inter.tool ? { tool: inter.tool } : {}), routing: clip(inter.routing, 400) } };
        const sender = m.senderLabel ?? (m.senderSession?.sessionKey ? shortKey(m.senderSession.sessionKey) : undefined);
        return { role, ts, ...(sender ? { sender: clip(sender, 60) } : {}), text: clip(raw, 600) };
      }).filter((m) => m.text);
    },
    async send(key, text, direct): Promise<Routed> {
      const message = String(text ?? '').trim();
      if (!message) throw new Error('empty message');
      if (message.length > MAX_MESSAGE_CHARS) throw new Error(`message too long (max ${MAX_MESSAGE_CHARS} chars)`);
      if (!agents.has(key)) throw new Error('unknown session');
      const routed = routeMessage(key, message, direct);
      if (!agents.has(routed.key)) throw new Error('unknown session');
      await call(SEND_METHOD, { key: routed.key, message: routed.message, idempotencyKey: randomUUID() }, 20_000);
      const e = { ...ev(Date.now(), 'zach', routed.key, 'message', routed.relayed ? `@${routed.agent}: ${message}` : message), session: routed.key };
      mergeEvents(ring, [e], RING_MAX);
      broadcast({ ts: e.ts, upserts: [], removed: [], events: [e], meters: meters() });
      return routed;
    },
    async board(): Promise<BoardCard[]> {
      const lists = await Promise.all(BOARDS.map(async (b) => ((await call('workboard.cards.list', { boardId: b }, 15_000)).cards ?? []).map((c: unknown) => normalizeCard(c, b))));
      return lists.flat().filter((c): c is BoardCard => !!c);
    },
    close() { stopped = true; rooms.close(); },
    ready,
  } as Source & { ready: Promise<void> };
}
