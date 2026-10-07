import { scopeParams, type SessionRow, type SessionScope } from '../shared/sessions';
import type { Source } from './store';

export function createSessionsApi(source: Source) {
  return {
    async list(scope: SessionScope): Promise<SessionRow[]> {
      const q = scopeParams(scope);
      if (!q) return [];
      const r = await fetch(new URL(`api/sessions?source=${source}&${q}`, document.baseURI));
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return ((await r.json()) as { items: SessionRow[] }).items;
    },
  };
}
export type SessionsApi = ReturnType<typeof createSessionsApi>;
