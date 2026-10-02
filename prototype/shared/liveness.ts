// Which sessions count as "live" agents. One rule, applied uniformly to every agent/team:
// the server classifies each Gateway session (`classifySession`), the browser filters by that flag
// (`visibleView`). Pure functions, no I/O; covered by shared/liveness.test.ts.
import type { Agent, Team } from './types.ts';

/**
 * "Recently active" window: a non-running, non-finished session still counts as live while it was
 * updated within this long. Past it, the session is retained history (hidden unless History is on).
 */
export const RECENT_ACTIVITY_MS = 15 * 60_000;

/** Session `status` values that mean the run is over (checked lower-cased; both spellings of cancel). */
export const FINISHED_STATUSES: ReadonlySet<string> = new Set([
  'done', 'aborted', 'timeout', 'timed_out', 'killed', 'failed', 'cancelled', 'canceled', 'error', 'crashed',
]);

/** The Gateway `sessions.list` row fields the classifier reads. */
export interface SessionLike {
  status?: unknown;
  hasActiveRun?: unknown;
  subagentRunState?: unknown;
  abortedLastRun?: unknown;
  archived?: unknown;
  updatedAt?: unknown;
  lastActivityAt?: unknown;
}

export type SessionLiveness = 'running' | 'recent' | 'finished';

export const isRunning = (s: SessionLike): boolean =>
  Boolean(s.hasActiveRun) || s.status === 'running' || s.subagentRunState === 'active';

/**
 * running  — any active run; always live, whatever else the row says.
 * finished — archived, aborted, or a terminal status; hidden by default.
 * recent   — otherwise, updated within RECENT_ACTIVITY_MS; live.
 * Anything else (idle and stale) is `finished`: retained history, not a live agent.
 */
export function classifySession(s: SessionLike, now: number): SessionLiveness {
  if (isRunning(s)) return 'running';
  if (s.archived || s.abortedLastRun || FINISHED_STATUSES.has(String(s.status ?? '').toLowerCase())) return 'finished';
  const at = Number(s.updatedAt ?? s.lastActivityAt ?? 0);
  return now - at <= RECENT_ACTIVITY_MS ? 'recent' : 'finished';
}

export const isRetired = (a: Pick<Agent, 'retired'>): boolean => a.retired === true;

export interface FleetView {
  agents: Agent[];
  teams: Team[];
  /** Live agents (never includes retired ones, even when history is shown). */
  liveCount: number;
  /** Retired sessions: the number the History toggle reveals. */
  historyCount: number;
}

/**
 * Apply the History toggle. Retired agents are dropped unless `showHistory`; survivors whose parent
 * or team lead was dropped are re-parented to `rootId` so the tree stays connected; teams with no
 * remaining members are dropped.
 */
export function visibleView(all: readonly Agent[], teams: readonly Team[], showHistory: boolean, rootId: string): FleetView {
  const retired = all.filter(isRetired);
  const kept = showHistory ? all : all.filter((a) => !isRetired(a));
  const keptIds = new Set(kept.map((a) => a.id));
  const agents = kept.map((a) => (a.parent && !keptIds.has(a.parent) ? { ...a, parent: a.id === rootId ? undefined : rootId } : a));
  const used = new Set(agents.map((a) => a.team));
  const outTeams = teams.filter((t) => used.has(t.id)).map((t) => {
    if (!t.lead || keptIds.has(t.lead)) return t;
    const { lead: _drop, ...rest } = t;
    return rest;
  });
  return { agents, teams: outTeams, liveCount: all.length - retired.length, historyCount: retired.length };
}
