// Wire contract between prototype/server and the browser. Read-only view model.

export type AgentStatus = 'active' | 'idle' | 'needs' | 'error';
export type AgentRole = 'cos' | 'lead' | 'worker';
/** Small, honest set. Derived from real signals (tool calls, run status, explicit [COO] tags), never from "a run finished". */
export type EventKind = 'message' | 'handoff' | 'done' | 'blocked' | 'needs' | 'approval';

export interface Agent {
  id: string; // session key
  name: string;
  team: string; // team id
  role: AgentRole;
  parent?: string; // parent session key
  status: AgentStatus;
  now: string; // one-line "now" sentence
  costUsd: number;
  tokens: number;
  model?: string;
  updatedAt: number;
  agentId?: string; // OpenClaw agent id (e.g. "forge-coder")
  kind?: 'main' | 'subagent' | 'cron' | 'other'; // session kind from the key
  label?: string; // session label / task title
  agentName?: string; // the agent's own display name (identity), e.g. "Spark"; `name` is the session's name (a subagent's task label)
  ask?: string; // when status === 'needs': what Zach is being asked
  retired?: boolean; // finished/aborted/archived or stale session: hidden unless History is on (see liveness.ts)
}

export interface Team {
  id: string;
  name: string;
  hue: string; // css color
  lead?: string; // agent id
}

export interface FleetEvent {
  id: string; // stable per real event (run / message / spawn), so re-deriving never duplicates
  ts: number;
  from: string; // session key
  to: string; // session key, 'zach' (only a real reply to Zach), or '' when nothing was addressed (e.g. a finished cron run)
  kind: EventKind;
  text: string; // the outcome: first meaningful line of the agent's own words
  label?: string; // secondary text: the task label (e.g. a spawned subagent's task)
  session?: string; // session whose thread a click opens (defaults to the sender)
  sys?: boolean; // heartbeat / silent / exec-completion / internal turn: hidden unless the System filter is on
  needsYou?: boolean;
}

export interface Meters {
  tokPerMin: number;
  costPerHr: number;
  totalCostUsd: number;
}

export interface Snapshot {
  source: 'mock' | 'live';
  ts: number;
  teams: Team[];
  agents: Agent[];
  events: FleetEvent[]; // recent, newest last
  meters: Meters;
  error?: string;
  windowHours?: number; // live: sessions older than this are hidden
}

export interface Delta {
  ts: number;
  upserts: Agent[];
  removed: string[];
  teams?: Team[];
  events: FleetEvent[];
  meters: Meters;
  error?: string;
}

export interface HistoryItem {
  role: string;
  ts: number;
  text: string;
  sender?: string;
  /** Present when the message was routed from another session (sessions_send etc.); `text` is then the sender's own words. */
  a2a?: { from: string; tool?: string; routing: string };
}

export const COS_ID = 'agent:main:main';

export const TEAM_PALETTE = ['#f5a524', '#3ad1f0', '#a35cff', '#34d399', '#ff5c8a', '#3b9cff', '#22d3c5', '#e879f9', '#facc15', '#fb7185'];
