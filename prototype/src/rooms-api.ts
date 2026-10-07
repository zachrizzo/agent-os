// Browser client for group rooms (data server /api/rooms*). Writes carry the same header as "Message agent".
import type { Room, RoomRunState } from '../shared/rooms';
import type { RoomAgent, RoomSummary } from '../server/rooms';
import type { Source } from './store';

export type { Room, RoomAgent, RoomRunState, RoomSummary };
export interface RoomView { room: Room; members: RoomAgent[]; run: RoomRunState | null }
export interface RoomList { rooms: RoomSummary[]; agents: RoomAgent[] }

export function createRoomsApi(source: Source) {
  const url = (path: string) => new URL(`api/${path}${path.includes('?') ? '&' : '?'}source=${source}`, document.baseURI).toString();
  async function call<T>(path: string, body?: unknown): Promise<T> {
    const r = await fetch(url(path), body === undefined ? undefined : {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-agent-os-send': '1' }, body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({})) as T & { error?: string };
    if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
    return j;
  }
  return {
    list: () => call<RoomList>('rooms'),
    get: (id: string) => call<RoomView>(`rooms/${id}`),
    create: (b: { name: string; members: string[]; captain?: string; purpose?: string }) => call<RoomView>('rooms', b),
    update: (id: string, b: Record<string, unknown>) => call<RoomView>(`rooms/${id}`, b),
    send: (id: string, message: string) => call<RoomView>(`rooms/${id}/send`, { message }),
    stop: (id: string) => call<RoomView>(`rooms/${id}/stop`, {}),
    end: (id: string) => call<RoomView>(`rooms/${id}/end`, {}),
    resume: (id: string) => call<RoomView>(`rooms/${id}/continue`, {}),
    wrapUp: (id: string) => call<RoomView>(`rooms/${id}/wrapup`, {}),
    pin: (id: string, messageId: string, pinned: boolean) => call<RoomView>(`rooms/${id}/pin`, { messageId, pinned }),
  };
}
export type RoomsApi = ReturnType<typeof createRoomsApi>;
