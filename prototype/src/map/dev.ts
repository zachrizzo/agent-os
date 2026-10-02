// Standalone harness for the map: a tiny fake Store fed by /api/stream?source=mock, or a synthetic
// fleet when the API is down. Query params:
//   ?bench=1            500 agents, 50 events/s, logs fps to the console (+ window.__mapStats)
//   ?synth=1            force the synthetic fleet (agents=N, teams=N, eps=N to tune)
//   ?zoom=team&team=ID  start zoomed into a team;  ?zoom=agent&agent=ID
import type { Selection, State, Store, Zoom } from '../contract';
import type { Delta, FleetEvent, Snapshot } from '../../shared/types';
import { createMap } from './index';
import { synthFleet } from './synth';

const q = new URLSearchParams(location.search);
const bench = q.has('bench');
const listeners = new Set<(s: State, fresh: FleetEvent[]) => void>();
let state: State | null = null;

function fromSnapshot(snap: Snapshot): State {
  return {
    snapshot: snap,
    agentsById: new Map(snap.agents.map((a) => [a.id, a])),
    teamsById: new Map(snap.teams.map((t) => [t.id, t])),
    selection: state?.selection ?? initialSel(snap),
    zoom: state?.zoom ?? ((q.get('zoom') as Zoom) || 'fleet'),
    hiddenTeams: state?.hiddenTeams ?? new Set(),
    connected: true,
  };
}
function initialSel(snap: Snapshot): Selection {
  if (q.get('agent')) return { type: 'agent', id: q.get('agent')! };
  if (q.get('team')) return { type: 'team', id: q.get('team')! };
  if (q.get('zoom') === 'agent') { const a = snap.agents.find((x) => x.status === 'needs') ?? snap.agents[0]; return { type: 'agent', id: a.id }; }
  return { type: 'none' };
}
function emit(fresh: FleetEvent[]) { if (state) for (const l of listeners) l(state, fresh); }
function applyDelta(d: Delta) {
  if (!state) return;
  const agents = new Map(state.agentsById);
  for (const a of d.upserts) agents.set(a.id, a);
  for (const id of d.removed) agents.delete(id);
  const teams = d.teams ?? state.snapshot.teams;
  const events = state.snapshot.events.concat(d.events).slice(-300);
  const snapshot: Snapshot = { ...state.snapshot, ts: d.ts, agents: [...agents.values()], teams, events, meters: d.meters };
  state = { ...state, snapshot, agentsById: agents, teamsById: new Map(teams.map((t) => [t.id, t])) };
  emit(d.events);
}

const store: Store = {
  get: () => state!,
  subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  select(sel) { if (!state) return; state = { ...state, selection: sel }; sync(); emit([]); },
  setZoom(z) { if (!state) return; state = { ...state, zoom: z }; sync(); emit([]); },
  toggleTeam(id) {
    if (!state) return;
    const h = new Set(state.hiddenTeams);
    if (h.has(id)) h.delete(id); else h.add(id);
    state = { ...state, hiddenTeams: h };
    emit([]);
  },
};

const bar = document.getElementById('bar')!;
const info = document.getElementById('info')!;
bar.addEventListener('click', (e) => {
  const z = (e.target as HTMLElement).dataset.z as Zoom | undefined;
  if (!z || !state) return;
  if (z === 'team' && state.selection.type === 'none') store.select({ type: 'team', id: state.snapshot.teams.find((t) => t.id !== 'main')?.id ?? 'main' });
  if (z === 'agent' && state.selection.type !== 'agent') {
    const a = state.snapshot.agents.find((x) => x.status === 'needs') ?? state.snapshot.agents[0];
    store.select({ type: 'agent', id: a.id });
  }
  store.setZoom(z);
});
function sync() {
  if (!state) return;
  for (const b of bar.querySelectorAll('button')) b.classList.toggle('on', b.dataset.z === state.zoom);
  const s = state.selection;
  info.textContent = `${state.snapshot.source} · ${state.snapshot.agents.length} agents · ${s.type === 'none' ? 'no selection' : `${s.type}: ${s.id}`}`;
}

let started = false;
function start(snap: Snapshot) {
  if (started) return;
  started = true;
  state = fromSnapshot(snap);
  sync();
  const map = createMap(document.getElementById('map')!, store);
  (window as unknown as { __map: unknown; __store: Store }).__map = map;
  (window as unknown as { __store: Store }).__store = store;
}

function startSynth() {
  const n = Number(q.get('agents') ?? (bench ? 500 : 80));
  const teams = Number(q.get('teams') ?? (bench ? 14 : 8));
  const eps = Number(q.get('eps') ?? (bench ? 50 : 12));
  const fleet = synthFleet(n, teams, eps, (d) => { if (started) applyDelta(d); });
  start(fleet.snapshot);
}

if (bench || q.has('synth')) startSynth();
else {
  const es = new EventSource('/api/stream?source=mock');
  const fallback = setTimeout(() => { es.close(); startSynth(); }, 2500);
  es.addEventListener('snapshot', (e) => {
    clearTimeout(fallback);
    const snap = JSON.parse((e as MessageEvent).data) as Snapshot;
    if (!started) start(snap);
    else { state = fromSnapshot(snap); emit([]); }
  });
  es.addEventListener('delta', (e) => applyDelta(JSON.parse((e as MessageEvent).data) as Delta));
  es.onerror = () => { if (!started) { clearTimeout(fallback); es.close(); startSynth(); } };
}
