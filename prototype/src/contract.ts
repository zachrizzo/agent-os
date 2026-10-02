// Frozen browser-side contract between the shell (store + UI) and the map renderer.
// Owner: CoS. Change only by agreement; additive fields are OK.
import type { Agent, Delta, FleetEvent, Snapshot, Team } from '../shared/types';

export type Zoom = 'fleet' | 'team' | 'agent';

export type Selection =
  | { type: 'none' }
  | { type: 'team'; id: string }
  | { type: 'agent'; id: string }
  | { type: 'event'; id: string };

export interface State {
  snapshot: Snapshot;          // latest full view model (deltas already applied)
  agentsById: Map<string, Agent>;
  teamsById: Map<string, Team>;
  selection: Selection;
  zoom: Zoom;
  hiddenTeams: Set<string>;    // teams toggled off in the rail
  connected: boolean;
}

export interface Store {
  get(): State;
  /** Called after every snapshot/delta/selection change. `fresh` = events that just arrived (for particles). */
  subscribe(fn: (s: State, fresh: FleetEvent[]) => void): () => void;
  select(sel: Selection): void;
  setZoom(z: Zoom): void;
  toggleTeam(id: string): void;
}

export interface MapApi {
  /** Re-fit camera to current zoom/selection (e.g. after rail click). */
  focus(sel: Selection): void;
  resize(): void;
  destroy(): void;
}

/** Implemented in src/map/index.ts. Renders into `el` (fills it), reads/writes selection & zoom via `store`. */
export type CreateMap = (el: HTMLElement, store: Store) => MapApi;

export type { Agent, Delta, FleetEvent, Snapshot, Team };
