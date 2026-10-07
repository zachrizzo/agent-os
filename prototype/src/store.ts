// Shell store: owns the SSE connection and the view model. Implements the frozen `Store` contract
// plus a few shell-only extras (search, filters, history toggle, send).
import { visibleView } from '../shared/liveness';
import { COS_ID } from '../shared/types';
import type { Agent, Delta, FleetEvent, Selection, Snapshot, State, Store, Team, Zoom } from './contract';

export type Source = 'live' | 'mock';
export type Filter = 'all' | 'needs' | 'blocked' | 'handoffs' | 'approvals' | 'system';
export type View = 'work' | 'fleet';
export interface SendResult { to: string; relayed: boolean; agent: string }

export interface ShellState extends State {
  loaded: boolean;        // first snapshot received
  reconnecting: boolean;  // lost the stream after having data
  query: string;
  filter: Filter;
  showHistory: boolean;   // History toggle: reveal retired (finished/aborted/archived/stale) sessions
  view: View;
  showAllWork: boolean;
  liveCount: number;      // live agents; the headline "agents" number
  historyCount: number;   // retired sessions the toggle would reveal (or is revealing)
  agentsAll: Map<string, Agent>; // every retained session, incl. hidden ones (name/team lookups for old events)
}

export interface ShellStore extends Store {
  readonly source: Source;
  get(): ShellState;
  /** Full recent event ring (newest last), larger than snapshot.events. */
  events(): FleetEvent[];
  setQuery(q: string): void;
  setFilter(f: Filter): void;
  setShowHistory(on: boolean): void;
  setView(v: View): void;
  setShowAllWork(on: boolean): void;
  sendMessage(sessionKey: string, text: string, direct?: boolean): Promise<SendResult>;
  connect(): void;
  close(): void;
}

const RING = 3000;

const emptySnapshot = (source: Source): Snapshot => ({
  source, ts: 0, teams: [], agents: [], events: [], meters: { tokPerMin: 0, costPerHr: 0, totalCostUsd: 0 },
});

export function createStore(source: Source): ShellStore {
  const state: ShellState = {
    snapshot: emptySnapshot(source),
    agentsById: new Map(),
    teamsById: new Map(),
    selection: { type: 'none' },
    zoom: 'fleet',
    hiddenTeams: new Set(),
    connected: false,
    loaded: false,
    reconnecting: false,
    query: '',
    filter: 'all',
    showHistory: false,
    view: 'work',
    showAllWork: false,
    liveCount: 0,
    historyCount: 0,
    agentsAll: new Map(),
  };
  let rawTeams: Team[] = [];
  const subs = new Set<(s: State, fresh: FleetEvent[]) => void>();
  let ring: FleetEvent[] = [];
  const seen = new Set<string>();

  // Coalesce notifications into one per animation frame; `fresh` accumulates in between.
  let fresh: FleetEvent[] = [];
  let scheduled = false;
  function notify() {
    if (scheduled) return;
    scheduled = true;
    const run = () => {
      scheduled = false;
      const f = fresh.length > 600 ? fresh.slice(-600) : fresh;
      fresh = [];
      for (const fn of subs) fn(state, f);
    };
    // rAF stalls in background tabs; fall back to a timer so state never goes stale.
    if (document.visibilityState === 'visible') requestAnimationFrame(run);
    else setTimeout(run, 250);
  }

  function ingest(evs: FleetEvent[], live: boolean) {
    const added: FleetEvent[] = [];
    for (const e of evs) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      added.push(e);
    }
    if (!added.length) return;
    const last = ring.length ? ring[ring.length - 1].ts : 0;
    ring.push(...added);
    if (added.some((e) => e.ts < last)) ring.sort((a, b) => a.ts - b.ts); // history-derived events arrive out of order
    if (ring.length > RING) {
      for (const e of ring.splice(0, ring.length - RING)) seen.delete(e.id);
    }
    if (live) fresh.push(...added);
  }

  // Everything downstream (map, rail, counts) reads the filtered view; `agentsAll` keeps the rest.
  function rebuild(teams: Team[], extra: Partial<Snapshot>) {
    rawTeams = teams;
    const v = visibleView([...state.agentsAll.values()], teams, state.showHistory, COS_ID);
    state.agentsById = new Map(v.agents.map((a) => [a.id, a]));
    state.teamsById = new Map(v.teams.map((t) => [t.id, t]));
    state.liveCount = v.liveCount;
    state.historyCount = v.historyCount;
    state.snapshot = {
      ...state.snapshot,
      ...extra,
      teams: v.teams,
      agents: v.agents,
      events: ring.slice(-300),
    };
  }

  function applySnapshot(s: Snapshot) {
    state.agentsAll = new Map(s.agents.map((a) => [a.id, a]));
    ring = [];
    seen.clear();
    ingest(s.events, false);
    rebuild(s.teams, { source: s.source, ts: s.ts, meters: s.meters, error: s.error });
    state.loaded = true;
    state.connected = true;
    state.reconnecting = false;
    notify();
  }

  function applyDelta(d: Delta) {
    for (const a of d.upserts) state.agentsAll.set(a.id, a as Agent);
    for (const id of d.removed) state.agentsAll.delete(id);
    ingest(d.events, true);
    rebuild(d.teams ?? rawTeams, { ts: d.ts, meters: d.meters, error: d.error });
    notify();
  }

  // --- SSE with exponential backoff; keeps last data while reconnecting.
  let es: EventSource | null = null;
  let retry = 0;
  let timer: number | undefined;
  const api = (path: string) => new URL(`api/${path}`, document.baseURI).toString();

  function connect() {
    clearTimeout(timer);
    es?.close();
    es = new EventSource(api(`stream?source=${source}`));
    es.addEventListener('snapshot', (m) => {
      retry = 0;
      try { applySnapshot(JSON.parse((m as MessageEvent).data)); } catch (e) { console.warn('[agent-os] bad snapshot', e); }
    });
    es.addEventListener('delta', (m) => {
      try { applyDelta(JSON.parse((m as MessageEvent).data)); } catch (e) { console.warn('[agent-os] bad delta', e); }
    });
    es.onerror = () => {
      es?.close();
      es = null;
      state.connected = false;
      state.reconnecting = state.loaded;
      notify();
      const wait = Math.min(15_000, 600 * 2 ** retry++) + Math.random() * 300;
      timer = window.setTimeout(connect, wait);
    };
  }

  const store: ShellStore = {
    source,
    get: () => state,
    subscribe(fn) { subs.add(fn); return () => { subs.delete(fn); }; },
    select(sel: Selection) {
      const cur = state.selection;
      if (cur.type === sel.type && (cur as { id?: string }).id === (sel as { id?: string }).id) return;
      state.selection = sel;
      notify();
    },
    setZoom(z: Zoom) { if (state.zoom !== z) { state.zoom = z; notify(); } },
    toggleTeam(id: string) {
      const h = new Set(state.hiddenTeams);
      if (h.has(id)) h.delete(id); else h.add(id);
      state.hiddenTeams = h;
      notify();
    },
    events: () => ring,
    setQuery(q) { if (q !== state.query) { state.query = q; notify(); } },
    setFilter(f) { if (f !== state.filter) { state.filter = f; notify(); } },
    setShowHistory(on) {
      if (on === state.showHistory) return;
      state.showHistory = on;
      rebuild(rawTeams, {});
      notify();
    },
    setView(v) { if (v !== state.view) { state.view = v; notify(); } },
    setShowAllWork(on) { if (on !== state.showAllWork) { state.showAllWork = on; notify(); } },
    async sendMessage(sessionKey, text, direct = false) {
      const r = await fetch(api(`send?source=${source}`), {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-agent-os-send': '1' },
        body: JSON.stringify({ key: sessionKey, message: text, ...(direct ? { direct: true } : {}) }),
      });
      const j = await r.json().catch(() => ({})) as { error?: string; to?: string; relayed?: boolean; agent?: string };
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      return { to: j.to ?? sessionKey, relayed: j.relayed === true, agent: j.agent ?? '' };
    },
    connect,
    close() { clearTimeout(timer); es?.close(); es = null; },
  };
  return store;
}

export async function resolveSource(): Promise<Source> {
  const p = new URLSearchParams(location.search).get('source');
  if (p === 'live' || p === 'mock') return p;
  try {
    const r = await fetch(new URL('api/config', document.baseURI));
    const c = (await r.json()) as { defaultSource?: Source };
    if (c.defaultSource === 'live' || c.defaultSource === 'mock') return c.defaultSource;
  } catch { /* API down: default to live; the stream will retry. */ }
  return 'live';
}
