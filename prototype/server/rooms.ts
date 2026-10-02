// Group rooms service: persistence + the run loop around shared/rooms.ts. Transport-agnostic: `RoomGateway` is the real Gateway
// (live.ts, via sessions.create/sessions.send/chat.history on the CLI path the data server already uses) or a scripted fake (mock.ts).
// Each member talks through its own dedicated session agent:<id>:room-<roomId>, never its main session.
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  MAX_COUNCILS, MAX_MEMBERS, MAX_MESSAGE_CHARS, MAX_ROOMS, MAX_ROOM_NAME, MAX_STORED_MESSAGES, YOU, clampInt, isExcludedAgent, migrateRoom, normalizeSettings, resolveCaptain, runRound,
  type Council, type Room, type RoomMember, type RoomMessage, type RoomRunState, type RoomSettings, type RoomTransport,
} from '../shared/rooms.ts';
import { councilBypass, runCouncil } from '../shared/council.ts';

export interface RoomAgent { id: string; name: string; emoji?: string }
export interface RoomGateway {
  /** Agents that exist on the Gateway (unfiltered; the service removes excluded ones). */
  listAgents(): Promise<RoomAgent[]>;
  /** Idempotent: make sure the dedicated room session exists. */
  ensureSession(agentId: string, roomId: string, label: string): Promise<void>;
  /** One turn on that session: send `prompt`, wait for the run to finish, return the reply text (null if none). `timeoutMs` is a backstop deadline for the wait. */
  turn(agentId: string, roomId: string, prompt: string, signal: AbortSignal, timeoutMs?: number): Promise<string | null>;
  /** Cancel that room session's in-flight run (Stop, member timeout). Best effort. */
  abort?(agentId: string, roomId: string): Promise<void>;
}

export class RoomError extends Error { constructor(readonly status: number, message: string) { super(message); } }

export const ROOM_ID_RE = /^r[0-9a-f]{8}$/;
export const roomSessionKey = (agentId: string, roomId: string) => `agent:${agentId}:room-${roomId}`;
/** The only session keys the data server may create or message on behalf of rooms. */
export const ROOM_KEY_RE = /^agent:([a-z0-9][a-z0-9_-]{0,63}):room-(r[0-9a-f]{8})$/;
export function isRoomKey(key: string) { const m = ROOM_KEY_RE.exec(key); return !!m && !isExcludedAgent(m[1]); }

export interface RoomView { room: Room; members: Array<RoomAgent>; run: RoomRunState | null }
export interface RoomSummary { id: string; name: string; members: string[]; archived: boolean; updatedAt: number; last?: { from: string; text: string; ts: number }; running: boolean; maxRounds: number; maxTurns: number; mode: Room['mode']; captain: string }

export function createRoomsService(opts: { gateway: RoomGateway; file?: string; agentTtlMs?: number }) {
  const { gateway } = opts;
  const rooms = new Map<string, Room>();
  const runs = new Map<string, { state: RoomRunState; abort: AbortController; done: Promise<void> }>();
  const lastRuns = new Map<string, RoomRunState>();
  let agentCache: { at: number; list: RoomAgent[] } | null = null;
  let seq = 0;

  if (opts.file) {
    try {
      const parsed = JSON.parse(readFileSync(opts.file, 'utf8')) as { rooms?: Room[] };
      // Older files (version 1) have no mode/captain/councils: migrateRoom fills them in memory; the file is rewritten on the room's next save.
      for (const r of parsed.rooms ?? []) if (ROOM_ID_RE.test(r.id) && Array.isArray(r.members)) {
        const room = migrateRoom(r);
        // A council that was mid-run when the data server went down will never finish: show it as stopped, not as forever "working".
        for (const c of room.councils) if (c.phase !== 'done' && c.phase !== 'stopped') {
          c.phase = 'stopped'; c.endedAt ??= Date.now();
          for (const a of Object.values(c.agents)) if (['planning', 'working', 'critiquing', 'synthesizing'].includes(a.status)) a.status = 'stopped';
        }
        rooms.set(r.id, room);
      }
    } catch { /* first run or unreadable: start empty */ }
  }
  function persist() {
    if (!opts.file) return;
    try {
      mkdirSync(dirname(opts.file), { recursive: true });
      const tmp = `${opts.file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ version: 2, rooms: [...rooms.values()] }, null, 1), { mode: 0o600 });
      chmodSync(tmp, 0o600);
      renameSync(tmp, opts.file);
    } catch (e) { console.warn('[agent-os rooms] could not persist:', (e as Error).message); }
  }

  async function agents(force = false): Promise<RoomAgent[]> {
    if (!force && agentCache && Date.now() - agentCache.at < (opts.agentTtlMs ?? 30_000)) return agentCache.list;
    const list = (await gateway.listAgents()).filter((a) => a.id && !isExcludedAgent(a.id));
    agentCache = { at: Date.now(), list };
    return list;
  }
  const info = (list: RoomAgent[], id: string): RoomAgent => list.find((a) => a.id === id) ?? { id, name: id };

  function mustGet(id: string): Room {
    const r = ROOM_ID_RE.test(id) ? rooms.get(id) : undefined;
    if (!r) throw new RoomError(404, 'unknown room');
    return r;
  }
  const cleanName = (v: unknown) => {
    const n = typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '';
    if (!n) throw new RoomError(400, 'room name is required');
    return n.slice(0, MAX_ROOM_NAME);
  };
  async function validMembers(ids: unknown): Promise<string[]> {
    if (!Array.isArray(ids) || ids.some((x) => typeof x !== 'string')) throw new RoomError(400, 'members must be a list of agent ids');
    const live = new Set((await agents()).map((a) => a.id));
    const out: string[] = [];
    for (const id of ids as string[]) {
      if (isExcludedAgent(id)) throw new RoomError(400, `agent ${id} cannot join rooms`);
      if (!live.has(id)) throw new RoomError(400, `unknown agent: ${id}`);
      if (!out.includes(id)) out.push(id);
    }
    if (out.length > MAX_MEMBERS) throw new RoomError(400, `a room holds at most ${MAX_MEMBERS} agents`);
    return out;
  }
  const touch = (r: Room) => { r.updatedAt = Date.now(); };
  const add = (r: Room, m: Omit<RoomMessage, 'id' | 'ts'>): RoomMessage => {
    const msg = { ...m, id: `m${Date.now().toString(36)}${(seq++).toString(36)}`, ts: Date.now() };
    r.messages.push(msg);
    if (r.messages.length > MAX_STORED_MESSAGES) r.messages.splice(0, r.messages.length - MAX_STORED_MESSAGES);
    touch(r);
    persist();
    return msg;
  };

  const summary = (r: Room): RoomSummary => {
    const last = [...r.messages].reverse().find((m) => m.from !== 'system');
    return { id: r.id, name: r.name, members: r.members, archived: r.archived, updatedAt: r.updatedAt, running: runs.has(r.id), maxRounds: r.maxRounds, maxTurns: r.maxTurns, mode: r.mode, captain: r.captain, ...(last ? { last: { from: last.from, text: last.text.slice(0, 120), ts: last.ts } } : {}) };
  };

  return {
    async list(): Promise<{ rooms: RoomSummary[]; agents: RoomAgent[] }> {
      return { rooms: [...rooms.values()].sort((a, b) => b.updatedAt - a.updatedAt).map(summary), agents: await agents().catch(() => []) };
    },
    async get(id: string): Promise<RoomView> {
      const r = mustGet(id);
      const list = await agents().catch(() => [] as RoomAgent[]);
      return { room: r, members: r.members.map((m) => info(list, m)), run: runs.get(id)?.state ?? lastRuns.get(id) ?? null };
    },
    async create(body: { name?: unknown; members?: unknown; captain?: unknown } & Partial<RoomSettings>): Promise<RoomView> {
      if (rooms.size >= MAX_ROOMS) throw new RoomError(400, `at most ${MAX_ROOMS} rooms`);
      const members = await validMembers(body.members ?? []);
      const now = Date.now();
      const room: Room = { id: `r${randomBytes(4).toString('hex')}`, name: cleanName(body.name), members, captain: resolveCaptain(body.captain, members), councils: [], archived: false, createdAt: now, updatedAt: now, messages: [], ...normalizeSettings(body, members.length) };
      rooms.set(room.id, room);
      persist();
      return this.get(room.id);
    },
    async update(id: string, patch: { name?: unknown; addMembers?: unknown; removeMembers?: unknown; archived?: unknown; captain?: unknown } & Partial<RoomSettings>): Promise<RoomView> {
      const r = mustGet(id);
      if (runs.has(id) && (patch.addMembers || patch.removeMembers)) throw new RoomError(409, 'room is busy: stop the run before changing members');
      if (patch.name !== undefined) r.name = cleanName(patch.name);
      if (patch.addMembers !== undefined) r.members = await validMembers([...r.members, ...(Array.isArray(patch.addMembers) ? patch.addMembers : [patch.addMembers])]);
      if (patch.removeMembers !== undefined) {
        const drop = new Set(Array.isArray(patch.removeMembers) ? patch.removeMembers : [patch.removeMembers]);
        r.members = r.members.filter((m) => !drop.has(m));
      }
      if (patch.captain !== undefined) {
        if (typeof patch.captain !== 'string' || !r.members.includes(patch.captain)) throw new RoomError(400, 'the captain must be a member of the room');
        if (runs.has(id)) throw new RoomError(409, 'room is busy: stop the run before changing the captain');
        r.captain = patch.captain;
      }
      if (patch.mode !== undefined) {
        if (patch.mode !== 'council' && patch.mode !== 'roundtable') throw new RoomError(400, 'mode must be council or roundtable');
        r.mode = patch.mode;
      }
      if (patch.memberTimeoutSec !== undefined) r.memberTimeoutSec = clampInt(patch.memberTimeoutSec, 1, 600, r.memberTimeoutSec);
      r.captain = resolveCaptain(r.captain, r.members); // members changed: the captain stays a member (rfc-lead, else the first)
      if (patch.maxRounds !== undefined) r.maxRounds = clampInt(patch.maxRounds, 1, 4, r.maxRounds);
      if (patch.maxTurns !== undefined) r.maxTurns = clampInt(patch.maxTurns, 1, 32, r.maxTurns);
      if (typeof patch.mentionGating === 'boolean') r.mentionGating = patch.mentionGating;
      if (typeof patch.archived === 'boolean') {
        if (patch.archived) runs.get(id)?.abort.abort();
        r.archived = patch.archived;
      }
      touch(r);
      persist();
      return this.get(id);
    },
    /** Adds Zach's message and starts the bounded run in the background; returns at once. Poll get() for replies. */
    async send(id: string, text: unknown): Promise<RoomView> {
      const r = mustGet(id);
      const msg = String(text ?? '').trim();
      if (!msg) throw new RoomError(400, 'empty message');
      if (msg.length > MAX_MESSAGE_CHARS) throw new RoomError(400, `message too long (max ${MAX_MESSAGE_CHARS} chars)`);
      if (r.archived) throw new RoomError(409, 'room is archived');
      if (!r.members.length) throw new RoomError(400, 'add at least one agent to the room first');
      if (runs.has(id)) throw new RoomError(409, 'room is busy: agents are still answering the last message');
      const list = await agents();
      const members: RoomMember[] = r.members.filter((m) => !isExcludedAgent(m)).map((m) => ({ id: m, name: info(list, m).name }));
      const trigger = add(r, { from: YOU, text: msg });
      const abort = new AbortController();
      const state: RoomRunState = { id: `run${trigger.id}`, status: 'running', round: 1, turnsUsed: 0, maxTurns: r.maxTurns, maxRounds: r.maxRounds, mode: r.mode };
      const transport: RoomTransport = {
        async turn(agentId, prompt, signal) {
          await gateway.ensureSession(agentId, id, `Room: ${r.name}`);
          return gateway.turn(agentId, id, prompt, signal);
        },
      };
      const hooks = { append: (m: Omit<RoomMessage, 'id' | 'ts'>) => add(r, m), state: (p: Partial<RoomRunState>) => Object.assign(state, p) };
      // Council is the default. A message that @mentions a member (mention gating on), a room in round-table mode, or a one-member room skips it.
      const bypass = r.mode === 'council' ? councilBypass(r, members, msg) : null;
      const useCouncil = r.mode === 'council' && !bypass && members.length >= 2;
      let flow: Promise<RoomRunState['stopReason']>;
      if (useCouncil) {
        const captain = members.some((m) => m.id === r.captain) ? r.captain : members[0].id;
        const council: Council = { id: trigger.id, captain, phase: 'planning', startedAt: Date.now(), agents: {}, notes: [], turnsUsed: 0, maxTurns: r.maxTurns };
        r.councils.push(council);
        if (r.councils.length > MAX_COUNCILS) r.councils.splice(0, r.councils.length - MAX_COUNCILS);
        state.phase = 'planning';
        const ctransport: RoomTransport = {
          async turn(agentId, prompt, signal) {
            await gateway.ensureSession(agentId, id, `Room: ${r.name}`);
            return gateway.turn(agentId, id, prompt, signal, r.memberTimeoutSec * 1000 + 15_000);
          },
          abort(agentId) { void gateway.abort?.(agentId, id).catch(() => undefined); },
        };
        flow = runCouncil(r, members, trigger, council, ctransport, { ...hooks, save: () => { touch(r); persist(); } }, abort.signal, { memberTimeoutMs: r.memberTimeoutSec * 1000 });
      } else {
        // Round-table loop; a bypass runs it for just the @mentioned members.
        flow = runRound(r, members, trigger, transport, hooks, abort.signal);
      }
      const done = flow
        .then((reason) => { state.stopReason = reason; state.status = reason === 'cancelled' ? 'stopped' : 'done'; }, (e) => {
          state.stopReason = 'cancelled'; state.status = 'stopped';
          const c = r.councils.find((x) => x.id === trigger.id);
          if (c && c.phase !== 'done') { c.phase = 'stopped'; c.endedAt = Date.now(); }
          add(r, { from: 'system', text: `Run failed: ${(e as Error).message}` });
        })
        .finally(() => { state.current = undefined; lastRuns.set(id, { ...state }); runs.delete(id); touch(r); persist(); });
      runs.set(id, { state, abort, done });
      return this.get(id);
    },
    async stop(id: string): Promise<RoomView> {
      mustGet(id);
      runs.get(id)?.abort.abort();
      return this.get(id);
    },
    /** Test hook: resolves when the room's current run finished. */
    async idle(id: string) { await runs.get(id)?.done; },
    close() { for (const r of runs.values()) r.abort.abort(); },
  };
}
export type RoomsService = ReturnType<typeof createRoomsService>;
