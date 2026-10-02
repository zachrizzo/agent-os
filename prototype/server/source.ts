import type { Delta, HistoryItem, Snapshot } from '../shared/types.ts';

export interface Source {
  snapshot(): Snapshot;
  subscribe(fn: (d: Delta) => void): () => void;
  history(sessionKey: string): Promise<HistoryItem[]>;
  /** "Message agent": deliver `text` to the session `key` as Zach and record it in the activity ring. Throws on unknown key / empty / too long / Gateway error. */
  send(sessionKey: string, text: string): Promise<void>;
  close(): void;
}
