// Wire contract between prototype/server and the browser. Read-only view model.

export type AgentStatus = 'active' | 'idle' | 'needs' | 'error';
export type AgentRole = 'cos' | 'lead' | 'worker';
export type EventKind = 'handoff' | 'report' | 'approval' | 'finding' | 'message' | 'event' | 'steer' | 'check';

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
}

export interface Team {
  id: string;
  name: string;
  hue: string; // css color
  lead?: string; // agent id
}

export interface FleetEvent {
  id: string;
  ts: number;
  from: string; // agent id
  to: string; // agent id or 'zach'
  kind: EventKind;
  text: string;
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
}

export const COS_ID = 'agent:main:main';

export const TEAM_PALETTE = ['#f5a524', '#3ad1f0', '#a35cff', '#34d399', '#ff5c8a', '#3b9cff', '#22d3c5', '#e879f9', '#facc15', '#fb7185'];
