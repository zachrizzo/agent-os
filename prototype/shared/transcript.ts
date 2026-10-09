import { parseInterSession, shortSession } from './a2a.ts';
import { RELAY_PREFIX } from './route.ts';
import { sessionStateOf, type SessionState } from './sessions.ts';
import type { HistoryItem, HistoryTool } from './types.ts';

export interface SessionStatus {
  key: string;
  state: SessionState;
  running: boolean;
  model?: string;
  tokens?: number;
  costUsd?: number;
  startedAt?: number;
  updatedAt?: number;
  usagePending?: boolean;
}

export interface LiveRun { text?: string; tools: HistoryTool[] }

export interface SessionThread { items: HistoryItem[]; status?: SessionStatus; live?: LiveRun }

export interface SessionUsage { tokens: number; costUsd: number }

export interface TranscriptContext { key: string; spawnedBy?: string; redact?: (s: string) => string }

const TASK_MARK_RE = /^\[Subagent Task\][ \t]*$/m;
const CONTEXT_RE = /^\s*\[Subagent Context\]/;
const DEPTH_RE = /\(depth (\d+\/\d+)\)/;
const BEGIN_RE = /\s*Begin\. Execute the assigned task to completion\.\s*$/;
const SYSTEM_RE = /^\s*(System:|OpenClaw resumed this CLI session|\[cron:|\[OpenClaw (heartbeat|exec)|HEARTBEAT_OK|NO_REPLY)/;
const RELAY_RE = new RegExp(`^\\s*${RELAY_PREFIX.replace(/[[\]]/g, '\\$&')} Zach(?: → @([\\w.-]+))?: ([\\s\\S]*)$`);
const SESSION_LINE_RE = /\n\(session: [^)\n]+\)\s*$/;
const TOOL_CALL = new Set(['toolcall', 'toolCall', 'tool_use', 'tool-call', 'toolUse', 'function_call']);
const TOOL_RESULT = new Set(['tool_result', 'toolResult', 'tool-result']);
const SUMMARY_KEYS = ['description', 'command', 'file_path', 'path', 'pattern', 'query', 'url', 'label', 'task', 'message', 'prompt', 'skill'];
const SUMMARY_MAX = 200;
const DETAIL_MAX = 4000;

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
const oneLine = (s: string, max = SUMMARY_MAX) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
};
const capped = (s: string) => (s.length > DETAIL_MAX ? `${s.slice(0, DETAIL_MAX)}\n…` : s);

export function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((c) => c?.type === 'text' && typeof c.text === 'string').map((c) => c.text as string).join('\n\n');
}

export function parseSubagentTask(text: string): { task: string; depth?: string } | null {
  if (!CONTEXT_RE.test(text)) return null;
  const mark = TASK_MARK_RE.exec(text);
  if (!mark) return null;
  const depth = DEPTH_RE.exec(text.slice(0, mark.index))?.[1];
  return { task: text.slice(mark.index + mark[0].length).replace(BEGIN_RE, '').trim(), ...(depth ? { depth } : {}) };
}

export function parseRelay(text: string): { agent?: string; body: string } | null {
  const m = RELAY_RE.exec(text);
  if (!m) return null;
  return { ...(m[1] ? { agent: m[1] } : {}), body: m[2].replace(SESSION_LINE_RE, '').trim() };
}

function parseArgs(args: unknown): unknown {
  if (typeof args !== 'string') return args;
  try { return JSON.parse(args); } catch { return args; }
}

export function toolSummary(args: unknown): string {
  const a = parseArgs(args);
  if (typeof a === 'string') return oneLine(a);
  if (!a || typeof a !== 'object') return '';
  const o = a as Record<string, unknown>;
  for (const k of SUMMARY_KEYS) if (typeof o[k] === 'string' && (o[k] as string).trim()) return oneLine(o[k] as string);
  const first = Object.values(o).find((v): v is string => typeof v === 'string' && !!v.trim());
  return first ? oneLine(first) : '';
}

function toolDetail(args: unknown): string | undefined {
  const a = parseArgs(args);
  if (a === undefined || a === null || a === '') return undefined;
  return capped(typeof a === 'string' ? a : JSON.stringify(a, null, 2));
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => (typeof c === 'string' ? c : typeof c?.text === 'string' ? c.text : '')).filter(Boolean).join('\n');
  return '';
}

const ownerSent = (meta: Record<string, unknown>) => meta.senderId === 'gateway-owner' || typeof meta.senderName === 'string';
const isSubagentKey = (key: string) => key.includes(':subagent:');

export function toHistoryItems(msgs: readonly any[], ctx: TranscriptContext): HistoryItem[] {
  const r = ctx.redact ?? ((s: string) => s);
  const out: HistoryItem[] = [];
  const calls = new Map<string, HistoryTool>();
  const attach = (id: unknown, content: unknown, isError: unknown) => {
    const t = typeof id === 'string' ? calls.get(id) : undefined;
    if (!t) return;
    const res = r(resultText(content)).trim();
    if (res) t.result = capped(res);
    if (isError === true || isError === 'true') t.error = true;
  };

  for (const m of msgs) {
    const role = String(m?.role ?? '');
    const meta = (m?.__openclaw ?? {}) as Record<string, unknown>;
    const base = { role, ts: Number(m?.timestamp ?? 0) || 0, ...(meta.id ? { id: String(meta.id) } : {}), ...(meta.truncated ? { truncated: true } : {}) };

    if (role === 'assistant') {
      const tools: HistoryTool[] = [];
      for (const c of Array.isArray(m.content) ? m.content : []) {
        if (TOOL_CALL.has(c?.type)) {
          const t: HistoryTool = { name: String(c.name ?? 'tool'), summary: r(toolSummary(c.arguments ?? c.input ?? c.args)) };
          const detail = toolDetail(c.arguments ?? c.input ?? c.args);
          if (detail) t.detail = r(detail);
          if (typeof c.id === 'string') { t.id = c.id; calls.set(c.id, t); }
          tools.push(t);
        } else if (TOOL_RESULT.has(c?.type)) attach(c.tool_use_id ?? c.toolCallId ?? c.id, c.content, c.is_error ?? c.isError);
      }
      const text = r(textOf(m.content)).trim();
      const err = typeof m.errorMessage === 'string' ? r(m.errorMessage).trim() : '';
      if (text || tools.length) out.push({ ...base, from: ctx.key, text, ...(tools.length ? { tools } : {}) });
      else if (err) out.push({ ...base, from: ctx.key, text: err, notice: 'error' });
      continue;
    }
    if (role === 'toolResult' || role === 'tool') { attach(m.toolCallId ?? m.tool_call_id ?? m.toolUseId, m.content, m.isError ?? m.is_error); continue; }

    const raw = textOf(m?.content);
    if (role !== 'user') {
      if (m?.display === false) continue;
      const t = r(raw).trim();
      if (t) out.push({ ...base, text: t, notice: /fail|error/i.test(String(m?.customType ?? '')) ? 'error' : 'system' });
      continue;
    }

    const inter = parseInterSession(raw);
    if (inter) {
      out.push({ ...base, from: inter.from, sender: oneLine(shortSession(inter.from), 60), text: r(inter.body), a2a: { from: inter.from, ...(inter.tool ? { tool: inter.tool } : {}), routing: r(inter.routing) } });
      continue;
    }
    const task = parseSubagentTask(raw);
    if (task) {
      out.push({ ...base, ...(ctx.spawnedBy ? { from: ctx.spawnedBy } : {}), text: r(task.task), task: task.depth ? { depth: task.depth } : {} });
      continue;
    }
    const relay = parseRelay(raw);
    if (relay) {
      out.push({ ...base, from: 'zach', text: r(relay.body), ...(relay.agent ? { relay: relay.agent } : {}) });
      continue;
    }
    if (SYSTEM_RE.test(raw)) {
      out.push({ ...base, text: r(raw).trim(), notice: 'system' });
      continue;
    }
    const text = r(raw).trim() || (Array.isArray(meta.media) && meta.media.length ? '_Attachment_' : '');
    if (!text) continue;
    const senderKey = typeof m?.senderSession?.sessionKey === 'string' ? m.senderSession.sessionKey as string : undefined;
    const from = ownerSent(meta) ? 'zach' : senderKey ?? (isSubagentKey(ctx.key) ? ctx.spawnedBy : undefined);
    out.push({ ...base, ...(from ? { from } : {}), ...(typeof m?.senderLabel === 'string' ? { sender: oneLine(m.senderLabel, 60) } : {}), text });
  }
  return out;
}

export function liveRunOf(inFlight: unknown, known: ReadonlySet<string>, redact: (s: string) => string = (s) => s): LiveRun | undefined {
  if (!inFlight || typeof inFlight !== 'object') return undefined;
  const run = inFlight as { text?: unknown; events?: unknown };
  const tools = new Map<string, HistoryTool>();
  for (const e of Array.isArray(run.events) ? run.events : []) {
    const stream = (e as { stream?: unknown })?.stream;
    const d = (e as { data?: Record<string, unknown> })?.data;
    if (!d || typeof d.name !== 'string') continue;
    const id = String(d.toolCallId ?? d.itemId ?? d.name);
    if (known.has(id)) continue;
    const prev = tools.get(id);
    if (stream === 'item' && d.kind === 'tool') {
      const title = typeof d.title === 'string' ? d.title.replace(new RegExp(`^${d.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*`), '') : '';
      const status = String(d.status ?? '');
      tools.set(id, { id, name: d.name, summary: redact(oneLine(title || prev?.summary || '')), ...(/fail|error/.test(status) ? { error: true } : {}), ...(d.phase !== 'end' ? { running: true } : {}) });
    } else if (stream === 'tool') {
      if (d.phase === 'start' && !prev) tools.set(id, { id, name: d.name, summary: '', running: true });
      else if (prev && (d.phase === 'result' || d.phase === 'end' || d.phase === 'error')) {
        delete prev.running;
        if (d.phase === 'error') prev.error = true;
      }
    }
  }
  const text = typeof run.text === 'string' ? redact(run.text).trim() : '';
  if (!text && !tools.size) return undefined;
  return { ...(text ? { text } : {}), tools: [...tools.values()] };
}

export function sessionStatusOf(key: string, row: Record<string, any> | undefined, usage?: SessionUsage): SessionStatus {
  const s = row ?? {};
  const state = sessionStateOf(s);
  const running = state === 'running';
  const tokens = num(s.totalTokens) || num(Number(s.inputTokens ?? 0) + Number(s.outputTokens ?? 0)) || num(usage?.tokens);
  const costUsd = num(s.estimatedCostUsd) || num(usage?.costUsd);
  const startedAt = num(s.startedAt);
  const updatedAt = num(s.updatedAt) || num(s.lastActivityAt);
  return {
    key, state, running,
    ...(s.model ? { model: String(s.model) } : {}),
    ...(tokens ? { tokens } : {}),
    ...(costUsd ? { costUsd } : {}),
    ...(startedAt ? { startedAt } : {}),
    ...(updatedAt ? { updatedAt } : {}),
    ...(running && !tokens ? { usagePending: true } : {}),
  };
}

export function needsUsageLookup(row: Record<string, any> | undefined): boolean {
  return !!row && !num(row.totalTokens) && !num(row.estimatedCostUsd);
}

export function usageFromSessionsUsage(res: unknown): SessionUsage | undefined {
  const u = (res as { sessions?: Array<{ usage?: Record<string, unknown> | null }> })?.sessions?.[0]?.usage;
  if (!u || typeof u !== 'object') return undefined;
  const tokens = num(u.totalTokens);
  const costUsd = num(u.totalCost);
  return tokens || costUsd ? { tokens, costUsd } : undefined;
}
