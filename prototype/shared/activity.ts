// Activity semantics: turns Gateway session history (chat.history) and session metadata (sessions.list) into honest Activity events.
// Pure functions, no I/O, so every rule is unit-tested against anonymized fixtures of real fleet shapes (shared/fixtures/).
//
// What counts as activity (and what does not):
//   Message  a real sessions_send (sender -> recipient agent), or an agent's own turn output
//   Handoff  a spawn: parent -> child agent, the task label as secondary text
//   Done / Blocked  a child's run ended (child -> parent); explicit [COO] / FORGE-REPORT tags; run failures
//   Needs you / Approval  only what truly awaits Zach: attention flag, [COO] decision tag, a reply to Zach that asks, an approval prompt
// Never activity (sys=true, hidden unless the System filter is on): heartbeat polls, NO_REPLY / silent turns, exec-completion notices,
// restart-recovery and other internal system turns, subagent completion deliveries (the child's own Done event already says it).
// The preview of an event is the agent's own outcome text, never the message that triggered the run.
import { parseInterSession } from './a2a.ts';
import { isRunning } from './liveness.ts';
import type { EventKind, FleetEvent } from './types.ts';

export interface RawMessage {
  role?: string;
  content?: unknown;
  timestamp?: number;
  stopReason?: string;
  customType?: string;
  isError?: boolean;
  toolCallId?: string;
  idempotencyKey?: string;
  provenance?: { kind?: string; sourceSessionKey?: string; sourceTool?: string };
  senderSession?: { sessionKey?: string; agentId?: string };
  __openclaw?: { id?: string; seq?: number };
}

export interface SessionMeta {
  key: string;
  agentId: string;
  kind: 'main' | 'subagent' | 'cron' | 'other';
  label?: string;
  parent?: string;
  status?: string;
  running?: boolean;
  lastRunId?: string;
  endedAt?: number;
  createdAt?: number;
  aborted?: boolean;
  attention?: boolean;
  statusNote?: string;
}

export type TriggerType = 'user' | 'inter' | 'completion' | 'task' | 'cron' | 'heartbeat' | 'exec' | 'system' | 'unknown';
export interface Trigger { type: TriggerType; from?: string; tool?: string; body: string; ts: number }

const ERROR_STATUSES = new Set(['killed', 'failed', 'error', 'aborted', 'timeout', 'timed_out', 'crashed']);
const HEARTBEAT_RE = /^\s*(\[OpenClaw heartbeat[^\]]*\]|OpenClaw resumed this CLI session|HEARTBEAT_OK\b)/i;
const EXEC_RE = /^\s*(\[OpenClaw exec[^\]]*\]|System:?\s*Exec (completed|finished|failed)|Exec (completed|finished|failed)\b)/i;
const SYSTEM_RE = /^\s*\[System\]/i;
const COMPLETION_TOOLS = /^subagent_/;
const SILENT_RE = /^(NO_REPLY|NOREPLY|HEARTBEAT_OK)[.!\s]*$/i;
const COO_TAG_RE = /^\s*\[COO\]\s*\*{0,2}\s*([A-Za-z][A-Za-z +,&/-]{1,40}?)\s*\*{0,2}\s*[:—-]\s*/;
const FORGE_RE = /\bFORGE-REPORT\b/;
const ASK_RE = /\b(decision[ _](needed|required)|needs? (your|a) (decision|approval|go-?ahead|sign-?off|input|call)|awaiting (your )?(approval|decision|input|go-?ahead)|waiting (on|for) (you|zach|your|approval)|please (approve|confirm|decide|choose|pick)|approve (this|the|deploy|merge|release)\b|your call\b|blocked on (you|zach)|want me to\b[^?]{0,140}\?|should i\b[^?]{0,140}\?|which (option|approach|one|path)\b[^?]{0,100}\?|(ok|okay) to (proceed|merge|deploy|ship|push)\?|say ["“]yes["”])/i;
const APPROVAL_RE = /(\/approve\b|approval[- ](pending|required)|awaiting (exec )?approval|needs? approval to run)/i;

// ---------- text helpers ----------
export function textOf(m: RawMessage): string {
  const c = m.content;
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  return c.map((b: any) => (b && b.type === 'text' && typeof b.text === 'string' ? b.text : b && b.type === 'input_text' && typeof b.text === 'string' ? b.text : '')).filter(Boolean).join('\n');
}

export function isSilent(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  if (SILENT_RE.test(t)) return true;
  const last = t.split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? '';
  return SILENT_RE.test(last);
}

/** First line that says something: skips markup, bare labels, wrapper boilerplate and retention notices. */
export function firstMeaningfulLine(text: string, max = 200): string {
  let t = text;
  const inter = parseInterSession(t);
  if (inter) t = inter.body;
  t = t.replace(/\[truncated-by-retention[^\]]*\]/gi, '').replace(/<\/?prompt-data>/g, '');
  const tag = COO_TAG_RE.exec(t);
  if (tag) t = t.slice(tag[0].length);
  const lines = t.split('\n').map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)]|#{1,6}|>)\s+/, '').replace(/[`*_]+/g, '').replace(/\s+/g, ' ').trim());
  const real = lines.filter((l) => /[A-Za-z0-9]{2}/.test(l) && !/^NO_REPLY$/i.test(l) && !/^```/.test(l) && !/^\[?\s*(truncated|Subagent Context)/i.test(l));
  const pick = real.find((l) => !(l.length <= 40 && /:$/.test(l)) ) ?? real[0] ?? '';
  const one = pick.length > max ? `${pick.slice(0, max - 1).trimEnd()}…` : pick;
  return one || (tag ? tag[1].trim() : '');
}

function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}
/** Same sender, recipient and words -> same id, whichever side (sender tool call or recipient inbox) we read it from. */
export function messageId(from: string, to: string, body: string): string {
  const norm = body.replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 240);
  return `msg:${from}>${to}:${hash(norm)}`;
}

const msgKey = (m: RawMessage) => m.__openclaw?.id ?? m.idempotencyKey ?? String(m.timestamp ?? 0);
const isToolName = (name: unknown, tool: string) => typeof name === 'string' && (name === tool || name.endsWith(`__${tool}`));

// ---------- classification ----------
/** Kind of an outgoing/outcome text, from explicit tags first; `askZach` enables the "this reply is a question to Zach" heuristic. */
export function classifyText(text: string, opts: { askZach?: boolean } = {}): { kind: EventKind; needsYou: boolean } {
  const tag = COO_TAG_RE.exec(text);
  if (tag) {
    const words = tag[1].toLowerCase().split(/[+,&/]|\band\b/).map((w) => w.trim());
    const has = (re: RegExp) => words.some((w) => re.test(w));
    if (has(/^(blocked|blocker|failed|error)/)) return { kind: 'blocked', needsYou: false };
    if (has(/^(decision|needs? you|needs? decision|ask|question)/)) return { kind: 'needs', needsYou: true };
    if (has(/^approval/)) return { kind: 'approval', needsYou: true };
    if (has(/^(done|complete|finished|shipped)/)) return { kind: 'done', needsYou: false };
    return { kind: 'message', needsYou: false };
  }
  if (FORGE_RE.test(text)) {
    const status = /\bstatus:\s*([\w-]+)/i.exec(text)?.[1]?.toLowerCase();
    if (status && /^(blocked|failed|error|cannot)/.test(status)) return { kind: 'blocked', needsYou: false };
    if (status && /^(done|ok|passed|complete)/.test(status)) return { kind: 'done', needsYou: false };
  }
  if (APPROVAL_RE.test(text)) return { kind: 'approval', needsYou: true };
  if (opts.askZach && ASK_RE.test(text)) return { kind: 'needs', needsYou: true };
  return { kind: 'message', needsYou: false };
}

export function classifyTrigger(m: RawMessage): Trigger | null {
  const prov = m.provenance;
  const text = textOf(m);
  const ts = Number(m.timestamp ?? 0);
  const role = m.role;
  if (role === 'toolResult' || role === 'custom' || role === 'tool') return null;
  if (role === 'assistant' && prov?.kind !== 'inter_session' && prov?.kind !== 'internal_system') return null;
  if (role === 'user' && Array.isArray(m.content) && !text && m.content.some((b: any) => b?.type === 'tool_result')) return null;

  if (prov?.kind === 'internal_system') {
    if (prov.sourceTool === 'cron' || /^\s*\[cron:/.test(text)) return { type: 'cron', tool: prov.sourceTool, body: text, ts };
    if (HEARTBEAT_RE.test(text)) return { type: 'heartbeat', body: text, ts };
    if (EXEC_RE.test(text)) return { type: 'exec', body: text, ts };
    return { type: 'system', tool: prov.sourceTool, body: text, ts };
  }
  if (prov?.kind === 'inter_session') {
    const from = prov.sourceSessionKey ?? m.senderSession?.sessionKey;
    const tool = prov.sourceTool;
    return { type: tool && COMPLETION_TOOLS.test(tool) ? 'completion' : 'inter', ...(from ? { from } : {}), ...(tool ? { tool } : {}), body: text, ts };
  }
  const inter = parseInterSession(text);
  if (inter) return { type: inter.tool && COMPLETION_TOOLS.test(inter.tool) ? 'completion' : 'inter', from: inter.from, ...(inter.tool ? { tool: inter.tool } : {}), body: inter.body, ts };
  if (HEARTBEAT_RE.test(text)) return { type: 'heartbeat', body: text, ts };
  if (EXEC_RE.test(text)) return { type: 'exec', body: text, ts };
  if (SYSTEM_RE.test(text)) return { type: 'system', body: text, ts };
  if (/^\s*\[Subagent Context\]/.test(text)) return { type: 'task', body: text, ts };
  if (/^\s*\[cron:/.test(text)) return { type: 'cron', body: text, ts };
  return { type: 'user', body: text, ts };
}

interface Turn { trigger: Trigger; msgs: RawMessage[] }

function splitTurns(msgs: RawMessage[]): Turn[] {
  const turns: Turn[] = [];
  let cur: Turn | null = null;
  for (const m of msgs) {
    const t = classifyTrigger(m);
    if (t) { cur = { trigger: t, msgs: [] }; turns.push(cur); continue; }
    if (!cur) { cur = { trigger: { type: 'unknown', body: '', ts: Number(m.timestamp ?? 0) }, msgs: [] }; turns.push(cur); }
    cur.msgs.push(m);
  }
  return turns;
}

interface ToolOutcome { isError: boolean; text: string }
function toolOutcomes(msgs: RawMessage[]): Map<string, ToolOutcome> {
  const out = new Map<string, ToolOutcome>();
  const asText = (c: unknown): string => typeof c === 'string' ? c : Array.isArray(c) ? c.map((b: any) => (typeof b === 'string' ? b : b?.text ?? '')).join('\n') : '';
  for (const m of msgs) {
    if (m.role === 'toolResult' && m.toolCallId) out.set(m.toolCallId, { isError: Boolean(m.isError), text: textOf(m) });
    if (Array.isArray(m.content)) for (const b of m.content as any[]) {
      if (b?.type === 'tool_result' && b.tool_use_id) out.set(b.tool_use_id, { isError: b.is_error === true || b.is_error === 'True', text: asText(b.content) });
    }
  }
  return out;
}
const FAILED_RE = /"status"\s*:\s*"(failed|error|forbidden|denied)"/i;

function toolCalls(m: RawMessage): Array<{ id: string; name: string; args: Record<string, unknown> }> {
  if (!Array.isArray(m.content)) return [];
  const out = [];
  for (const b of m.content as any[]) {
    if (b && (b.type === 'toolcall' || b.type === 'toolCall' || b.type === 'tool_use')) {
      out.push({ id: String(b.id ?? ''), name: String(b.name ?? ''), args: (b.arguments ?? b.input ?? {}) as Record<string, unknown> });
    }
  }
  return out;
}

const isFinalAssistant = (m: RawMessage) => m.role === 'assistant' && !classifyTriggerIsInbound(m) && !/^(tool_?use|aborted|error)$/i.test(m.stopReason ?? '') && textOf(m).trim().length > 0;
function classifyTriggerIsInbound(m: RawMessage) { return m.provenance?.kind === 'inter_session' || m.provenance?.kind === 'internal_system'; }

// ---------- derivation ----------
export interface DeriveOptions {
  /** Applied to every text that leaves this module (secret redaction). */
  redact?: (s: string) => string;
  /** Drop events older than this (epoch ms). */
  since?: number;
  /** Max clip for event text. */
  maxText?: number;
}

const SYS_TEXT: Record<string, string> = { heartbeat: 'Heartbeat poll', exec: 'Exec completion notice', system: 'System notice', completion: 'Subagent completion delivered', cron: 'Scheduled run' };

/**
 * Events for one session from its recent history. `meta` is the session's list row (status, parent, label...).
 * Returns each real event once (stable ids), oldest first.
 */
export function deriveSessionEvents(meta: SessionMeta, history: RawMessage[], opts: DeriveOptions = {}): FleetEvent[] {
  const red = opts.redact ?? ((s: string) => s);
  const maxText = opts.maxText ?? 200;
  const out: FleetEvent[] = [];
  const emitted = new Set<string>();
  const outcomes = toolOutcomes(history);
  const push = (e: Omit<FleetEvent, 'text'> & { text: string }) => {
    if (emitted.has(e.id)) return;
    if (opts.since && e.ts < opts.since) return;
    emitted.add(e.id);
    const text = red(e.text).slice(0, maxText);
    out.push({ ...e, text, ...(e.label ? { label: red(e.label).slice(0, 120) } : {}) });
  };
  const isChild = meta.kind === 'subagent' || meta.kind === 'cron';
  const toZachOk = !isChild;
  const parent = meta.kind === 'subagent' ? meta.parent ?? '' : '';
  const turns = splitTurns(history);
  const lastTurn = turns[turns.length - 1];

  for (const turn of turns) {
    const { trigger } = turn;
    const isSys = trigger.type === 'heartbeat' || trigger.type === 'exec' || trigger.type === 'system';
    const isInternal = isSys || trigger.type === 'completion';

    // 1. Inbound inter-session message: sender -> this session (the same id the sender's own tool call produces).
    if (trigger.type === 'inter' && trigger.from && trigger.from !== meta.key) {
      const body = trigger.body.replace(/^OpenClaw resumed this CLI session[^\n]*\n?/i, '').trim();
      if (body && isSilent(body)) {
        push({ id: `sys:${messageId(trigger.from, meta.key, body)}`, ts: trigger.ts, from: trigger.from, to: meta.key, kind: 'message', text: 'Inter-session message \u00b7 no reply', sys: true, session: trigger.from });
      } else if (body) {
        const c = classifyText(body);
        push({ id: messageId(trigger.from, meta.key, body), ts: trigger.ts, from: trigger.from, to: meta.key, kind: c.kind, text: firstMeaningfulLine(body, maxText), session: trigger.from, ...(c.needsYou ? { needsYou: true } : {}) });
      }
    }

    // 2. Real sends: sessions_send tool calls made during this turn.
    for (const m of turn.msgs) {
      for (const call of toolCalls(m)) {
        if (!isToolName(call.name, 'sessions_send')) continue;
        const a = call.args;
        const to = typeof a.sessionKey === 'string' ? a.sessionKey : typeof a.agentId === 'string' ? `agent:${a.agentId}:main` : '';
        const body = typeof a.message === 'string' ? a.message : '';
        if (!to || !body.trim() || to === meta.key) continue;
        const ts = Number(m.timestamp ?? turn.trigger.ts);
        const res = outcomes.get(call.id);
        if (res && (res.isError || FAILED_RE.test(res.text))) {
          push({ id: `sendfail:${call.id || hash(body)}`, ts, from: meta.key, to, kind: 'blocked', text: `Could not deliver: ${firstMeaningfulLine(body, 120)}`, session: meta.key });
          continue;
        }
        const c = classifyText(body);
        push({ id: messageId(meta.key, to, body), ts, from: meta.key, to, kind: c.kind, text: firstMeaningfulLine(body, maxText), session: meta.key, ...(c.needsYou ? { needsYou: true } : {}) });
      }
    }

    // 3. The turn's own outcome: the last real assistant text. Never the trigger.
    const finals = turn.msgs.filter(isFinalAssistant);
    const final = finals[finals.length - 1];
    const finalText = final ? textOf(final) : '';
    const err = turn.msgs.find((m) => m.role === 'custom' && m.customType === 'run-failed-before-reply');
    const aborted: RawMessage | undefined = !final ? [...turn.msgs].reverse().find((m) => m.role === 'assistant' && m.stopReason === 'aborted') : undefined;

    if (err) {
      const reason = textOf(err).replace(/^This turn ended before a reply:\s*/i, '');
      push({ id: `err:${meta.key}:${msgKey(err)}`, ts: Number(err.timestamp ?? trigger.ts), from: meta.key, to: parent, kind: 'blocked', text: `Run failed: ${firstMeaningfulLine(reason, 140)}`, session: meta.key });
    } else if (aborted) {
      const partial = firstMeaningfulLine(textOf(aborted), 120);
      push({ id: `abort:${meta.key}:${msgKey(aborted)}`, ts: Number(aborted.timestamp ?? trigger.ts), from: meta.key, to: parent, kind: 'blocked', text: partial ? `Run aborted: ${partial}` : 'Run aborted', session: meta.key });
    }
    if (!final) {
      if (isInternal && !err) push({ id: `sys:${meta.key}:${trigger.ts}`, ts: trigger.ts, from: meta.key, to: '', kind: 'message', text: SYS_TEXT[trigger.type] ?? 'System turn', sys: true, session: meta.key });
      continue;
    }

    const ts = Number(final.timestamp ?? trigger.ts);
    const fid = msgKey(final);
    if (isSilent(finalText) || isSys) {
      push({ id: `sys:${meta.key}:${fid}`, ts, from: meta.key, to: '', kind: 'message', text: isSilent(finalText) ? `${SYS_TEXT[trigger.type] ?? 'Silent turn'} · no reply` : `${SYS_TEXT[trigger.type]} · ${firstMeaningfulLine(finalText, 120)}`, sys: true, session: meta.key });
      continue;
    }

    if (isChild) {
      // One outcome per child run, emitted once the run has ended; it is the child's report to its parent.
      if (turn !== lastTurn || meta.running) continue;
      const failed = meta.aborted || ERROR_STATUSES.has(String(meta.status ?? ''));
      const c = classifyText(finalText);
      const kind: EventKind = failed ? 'blocked' : c.kind === 'message' ? 'done' : c.kind;
      push({ id: `done:${meta.key}:${meta.lastRunId ?? fid}`, ts, from: meta.key, to: parent, kind, text: firstMeaningfulLine(finalText, maxText), session: meta.key, ...(meta.label ? { label: meta.label } : {}), ...(c.needsYou ? { needsYou: true } : {}) });
      continue;
    }

    const toZach = trigger.type === 'user' && toZachOk;
    const awaiting = toZach && turn === lastTurn && !meta.running;
    const c = classifyText(finalText, { askZach: awaiting });
    push({ id: `turn:${meta.key}:${fid}`, ts, from: meta.key, to: toZach ? 'zach' : '', kind: c.kind, text: firstMeaningfulLine(finalText, maxText), session: meta.key, ...(c.needsYou ? { needsYou: true } : {}) });
  }

  // A subagent that failed without producing any text still ended: say so once.
  if (isChild && !meta.running && meta.lastRunId && (meta.aborted || ERROR_STATUSES.has(String(meta.status ?? ''))) && !out.some((e) => e.kind === 'blocked' && !e.sys)) {
    push({ id: `done:${meta.key}:${meta.lastRunId}`, ts: meta.endedAt ?? Date.now(), from: meta.key, to: parent, kind: 'blocked', text: meta.aborted ? 'Aborted' : String(meta.status), session: meta.key, ...(meta.label ? { label: meta.label } : {}) });
  }
  return out.sort((a, b) => a.ts - b.ts);
}

/** Spawn: parent -> child agent, as a Handoff, from the session list alone (no history read). */
export function spawnEvent(meta: SessionMeta, opts: DeriveOptions = {}): FleetEvent | null {
  if (meta.kind !== 'subagent' || !meta.parent || !meta.createdAt) return null;
  if (opts.since && meta.createdAt < opts.since) return null;
  const red = opts.redact ?? ((s: string) => s);
  const label = meta.label ? red(meta.label).slice(0, 120) : '';
  return { id: `spawn:${meta.key}`, ts: meta.createdAt, from: meta.parent, to: meta.key, kind: 'handoff', text: label || 'Spawned a subagent', ...(label ? { label } : {}), session: meta.key };
}

/** The session explicitly flagged for attention (statusNote + attention): awaits Zach. */
export function attentionEvent(meta: SessionMeta, ts: number, opts: DeriveOptions = {}): FleetEvent | null {
  if (!meta.attention || !meta.statusNote) return null;
  const red = opts.redact ?? ((s: string) => s);
  const text = red(firstMeaningfulLine(meta.statusNote, 140));
  return { id: `needs:${meta.key}:${hash(text)}`, ts, from: meta.key, to: 'zach', kind: APPROVAL_RE.test(meta.statusNote) ? 'approval' : 'needs', text, needsYou: true, session: meta.key };
}

/** Insert `add` into the ring keeping it sorted by ts and free of duplicate ids; trims the oldest beyond `max`. */
export function mergeEvents(ring: FleetEvent[], add: FleetEvent[], max = 600): FleetEvent[] {
  const ids = new Set(ring.map((e) => e.id));
  const fresh = add.filter((e) => (ids.has(e.id) ? false : (ids.add(e.id), true)));
  if (!fresh.length) return [];
  ring.push(...fresh);
  ring.sort((a, b) => a.ts - b.ts);
  if (ring.length > max) ring.splice(0, ring.length - max);
  return fresh;
}

/** Open "Needs you" items: per sender -> recipient thread only the latest event counts, and it must still ask. */
export function openNeedsOf(events: FleetEvent[], now: number, maxAgeMs = 24 * 3600_000): FleetEvent[] {
  const latest = new Map<string, FleetEvent>();
  for (const e of events) if (!e.sys && e.from !== 'zach') latest.set(`${e.from}>${e.to}`, e);
  return [...latest.values()].filter((e) => e.needsYou && now - e.ts <= maxAgeMs).sort((a, b) => b.ts - a.ts);
}

/** Session key -> kind ("agent:x:main" main, ":subagent:" subagent, ":cron:" cron, else other). */
export function keyKind(key: string): SessionMeta['kind'] {
  const rest = /^agent:[^:]+:(.*)$/.exec(key)?.[1] ?? key;
  return rest === 'main' ? 'main' : rest.startsWith('subagent:') ? 'subagent' : rest.startsWith('cron:') ? 'cron' : 'other';
}

/** A Gateway sessions.list row -> the fields derivation reads. */
export function sessionMetaOf(row: any): SessionMeta {
  const key = String(row.key);
  const agentId = String(row.agentId ?? /^agent:([^:]+):/.exec(key)?.[1] ?? 'unknown');
  const parent = row.parentSessionKey ?? row.spawnedBy;
  const note = row.statusNote ?? row.sidebar?.statusNote;
  return {
    key, agentId, kind: keyKind(key),
    ...(row.label ? { label: String(row.label).replace(/^Automation:\s*/, '') } : {}),
    ...(parent && parent !== key ? { parent: String(parent) } : {}),
    ...(row.status ? { status: String(row.status) } : {}),
    running: isRunning(row),
    ...(row.lastRunId ? { lastRunId: String(row.lastRunId) } : {}),
    ...(row.endedAt ? { endedAt: Number(row.endedAt) } : {}),
    ...(row.createdAt ? { createdAt: Number(row.createdAt) } : {}),
    ...(row.abortedLastRun ? { aborted: true } : {}),
    ...((row.attention || row.sidebar?.attention) && note ? { attention: true, statusNote: String(note) } : {}),
  };
}
