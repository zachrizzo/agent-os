import { isRunning } from './liveness.ts';

export type SessionKind = 'main' | 'subagent' | 'automation' | 'room' | 'dashboard' | 'other';
export type SessionState = 'running' | 'needs' | 'error' | 'done' | 'idle';

export interface SessionRow {
  key: string;
  agentId: string;
  kind: SessionKind;
  label: string;
  state: SessionState;
  updatedAt: number;
  parent?: string;
  model?: string;
  preview?: string;
}

export interface SessionNode {
  row: SessionRow;
  depth: number;
}

export const SESSION_KIND_LABEL: Record<SessionKind, string> = {
  main: 'Main', subagent: 'Subagent', automation: 'Automation', room: 'Room', dashboard: 'Dashboard', other: 'Other',
};
export const SESSION_STATE_LABEL: Record<SessionState, string> = {
  running: 'Running', needs: 'Needs Zach', error: 'Failed', done: 'Done', idle: 'Idle',
};

const ERROR_STATUSES = new Set(['killed', 'failed', 'error', 'aborted', 'timeout', 'timed_out', 'crashed']);

export const sessionAgentOf = (key: string) => /^agent:([^:]+):/.exec(key)?.[1] ?? '';

export function sessionKindOf(key: string): SessionKind {
  const rest = /^agent:[^:]+:(.*)$/.exec(key)?.[1] ?? '';
  if (rest === 'main') return 'main';
  if (rest.startsWith('subagent:')) return 'subagent';
  if (rest.startsWith('cron:')) return 'automation';
  if (rest.startsWith('room-')) return 'room';
  if (rest.startsWith('dashboard:')) return 'dashboard';
  return 'other';
}

export function sessionStateOf(s: { status?: unknown; hasActiveRun?: unknown; subagentRunState?: unknown; abortedLastRun?: unknown; attention?: unknown; sidebar?: { attention?: unknown } }): SessionState {
  if (isRunning(s)) return 'running';
  if (s.abortedLastRun || ERROR_STATUSES.has(String(s.status ?? '').toLowerCase())) return 'error';
  if (s.attention || s.sidebar?.attention) return 'needs';
  if (String(s.status ?? '').toLowerCase() === 'done') return 'done';
  return 'idle';
}

const shortId = (key: string) => key.split(':').pop()?.slice(0, 8) ?? key;

function labelOf(kind: SessionKind, raw: { label?: unknown; displayName?: unknown }, key: string): string {
  const given = String(raw.label ?? raw.displayName ?? '').replace(/^Automation:\s*/, '').trim();
  if (given) return given;
  if (kind === 'main') return 'Main session';
  return `${SESSION_KIND_LABEL[kind]} ${shortId(key)}`;
}

export function toSessionRow(raw: Record<string, any>): SessionRow {
  const key = String(raw.key ?? '');
  const kind = sessionKindOf(key);
  const parent = raw.parentSessionKey ?? raw.spawnedBy;
  return {
    key,
    agentId: String(raw.agentId ?? sessionAgentOf(key)),
    kind,
    label: labelOf(kind, raw, key),
    state: sessionStateOf(raw),
    updatedAt: Number(raw.updatedAt ?? raw.lastActivityAt ?? 0) || 0,
    ...(typeof parent === 'string' && parent !== key ? { parent } : {}),
    ...(raw.model ? { model: String(raw.model) } : {}),
  };
}

const MAX_DEPTH = 6;

export function sessionTree(rows: readonly SessionRow[]): SessionNode[] {
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const children = new Map<string, SessionRow[]>();
  const roots: SessionRow[] = [];
  for (const r of rows) {
    if (r.parent && byKey.has(r.parent)) {
      const list = children.get(r.parent) ?? [];
      list.push(r);
      children.set(r.parent, list);
    } else roots.push(r);
  }
  const newestFirst = (a: SessionRow, b: SessionRow) => b.updatedAt - a.updatedAt || a.key.localeCompare(b.key);
  const out: SessionNode[] = [];
  const seen = new Set<string>();
  const walk = (r: SessionRow, depth: number) => {
    if (seen.has(r.key)) return;
    seen.add(r.key);
    out.push({ row: r, depth: Math.min(depth, MAX_DEPTH) });
    for (const c of (children.get(r.key) ?? []).sort(newestFirst)) walk(c, depth + 1);
  };
  for (const r of roots.sort(newestFirst)) walk(r, 0);
  for (const r of [...rows].sort(newestFirst)) walk(r, 0);
  return out;
}

export interface SessionScope { agent?: string; team?: string }

export function teamOfAgent(agentId: string): string {
  if (agentId === 'main') return 'cos';
  return agentId.split(/[-_]/)[0] || agentId;
}

export const inScope = (agentId: string, scope: SessionScope) =>
  scope.agent ? agentId === scope.agent : scope.team ? teamOfAgent(agentId) === scope.team : false;

export function scopeParams(scope: SessionScope): string {
  return scope.agent ? `agent=${encodeURIComponent(scope.agent)}` : scope.team ? `team=${encodeURIComponent(scope.team)}` : '';
}

export function ageShort(ts: number, now: number): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return 'now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}
