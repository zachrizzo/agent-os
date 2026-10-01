import type { Delta, HistoryItem, Snapshot } from '../shared/types.ts';

export interface Source {
  snapshot(): Snapshot;
  subscribe(fn: (d: Delta) => void): () => void;
  history(sessionKey: string): Promise<HistoryItem[]>;
  close(): void;
}
