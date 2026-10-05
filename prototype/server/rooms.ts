// Group rooms service: persistence + the open-discussion run around shared/rooms.ts. Transport-agnostic: `RoomGateway` is the real Gateway
// (live.ts, via sessions.create/sessions.send/chat.history on the CLI path the data server already uses) or a scripted fake (mock.ts).
// Each member talks through its own dedicated session agent:<id>:room-<roomId>, never its main session.
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  MAX_MEMBERS, MAX_MESSAGE_CHARS, MAX_ROOMS, MAX_ROOM_NAME, MAX_STORED_MESSAGES, RESPONDER_MODES, ROOM_KEY_RE, YOU, addUsage, emptyUsage, isExcludedAgent, migrateRoom, normalizeSettings, resolveCaptain, roomSessionKey, runDiscussion, selectResponders,
  type Room, type RoomMember, type RoomMessage, type RoomRunState, type RoomSettings, type RoomTransport, type RunOptions, type TurnProgress, type TurnResult,
} from '../shared/rooms.ts';

export interface RoomAgent { id: string; name: string; emoji?: string }
export interface RoomGateway {
  /** Agents that exist on the Gateway (unfiltered; the service removes excluded ones). */
  listAgents(): Promise<RoomAgent[]>;
  /** Idempotent: make sure the dedicated room session exists. */
  ensureSession(agentId: string, roomId: string, label: string): Promise<void>;
  /** One turn on that session: send `prompt`, wait for the run to finish, return the reply text (null if none), with the turn's token usage when the Gateway reports it. `progress` reports the tool the agent is using. There is no deadline: it ends with a reply, an error, or the signal (Stop). */
  turn(agentId: string, roomId: string, prompt: string, signal: AbortSignal, progress?: (p: TurnProgress) => void): Promise<TurnResult>;
  /** Optional: one small-model call for the room's speak filter, on a dedicated judge session. Resolve with the raw reply text; throw or return null when unavailable (everyone then speaks). */
  judge?(roomId: string, agentId: string, prompt: string, signal: AbortSignal): Promise<string | null>;
  /** Cancel that room session's in-flight run (Stop). Best effort. */
  abort?(agentId: string, roomId: string): Promise<void>;
}

export class RoomError extends Error { constructor(readonly status: number, message: string) { super(message); } }

export const ROOM_ID_RE = /^r[0-9a-f]{8}$/;
export { roomSessionKey, ROOM_KEY_RE };
export function isRoomKey(key: string) { const m = ROOM_KEY_RE.exec(key); return !!m && !isExcludedAgent(m[1]); }

export interface RoomView { room: Room; members: Array<RoomAgent>; run: RoomRunState | null }
export interface RoomSummary { id: string; name: string; members: string[]; archived: boolean; updatedAt: number; last?: { from: string; text: string; ts: number }; running: boolean; paused: boolean; captain: string }

export const MAX_NOTES_CHARS = 4000;
export const MAX_QUEUED = 5;
export const MAX_PINNED = 20;
const SETTING_KEYS = ['mentionGating', 'responderMode', 'pauseAfterPosts', 'pauseAfterTokens', 'speakFilter'] as const;
type RunEntry = { state: RoomRunState; abort: AbortController; done: Promise<void>; /** set while paused: releases the soft pause */ resume?: () => void; /** "End now" was asked */ ending: boolean };

export function createRoomsService(opts: { gateway: RoomGateway; file?: string; agentTtlMs?: number; /** turn retry policy (tests shorten the backoff) */ retry?: RunOptions }) {
  const { gateway } = opts;
  const rooms = new Map<string, Room>();
  const runs = new Map<string, RunEntry>();
  const lastRuns = new Map<string, RoomRunState>();
  /** Abort cutoffs: run id -> when Stop was pressed and how many late replies from that run were dropped since. A stopped run's agents may still answer (the Gateway run, or a turn that ignores the signal): those replies must not land in the thread. */
  const cutoffs = new Map<string, { at: number; dropped: number; from: Set<string>; noteId?: string }>();
  let agentCache: { at: number; list: RoomAgent[] } | null = null;
  let seq = 0;

  if (opts.file) {
    try {
      const parsed = JSON.parse(readFileSync(opts.file, 'utf8')) as { rooms?: Room[]; runs?: Record<string, RoomRunState> };
      // Older files (captain-led council, version 1-2): migrateRoom drops the retired pipeline fields in memory; the file is rewritten on the room's next save.
      for (const r of parsed.rooms ?? []) if (ROOM_ID_RE.test(r.id) && Array.isArray(r.members)) rooms.set(r.id, migrateRoom(r));
      let dirty = false;
      for (const r of rooms.values()) {
        const st = parsed.runs?.[r.id];
        const wasLive = !!st && (st.status === 'running' || st.status === 'paused');
        // A restart drops the in-memory run. Show it as interrupted and never replay it: its tools may already have had side effects.
        if (st && typeof st === 'object') lastRuns.set(r.id, wasLive ? { ...st, status: 'interrupted', stopReason: 'interrupted', active: [], activity: [], pause: undefined } : st);
        const lost = r.messages.filter((m) => m.queued);
        for (const m of lost) delete m.queued;
        if (wasLive || lost.length) {
          r.messages.push({ id: `m${Date.now().toString(36)}${(seq++).toString(36)}`, ts: Date.now(), from: 'system', text: `${wasLive ? 'The last discussion was interrupted by a restart and was not replayed.' : ''}${lost.length ? `${wasLive ? ' ' : ''}${lost.length} queued message${lost.length === 1 ? ' was' : 's were'} never delivered to the agents: send ${lost.length === 1 ? 'it' : 'them'} again.` : ''}` });
          dirty = true;
        }
      }
      if (dirty) setTimeout(() => persist(), 0);
    } catch { /* first run or unreadable: start empty */ }
  }
  function persist() {
    if (!opts.file) return;
    try {
      mkdirSync(dirname(opts.file), { recursive: true });
      const tmp = `${opts.file}.${process.pid}.tmp`;
      const states: Record<string, RoomRunState> = {};
      for (const id of rooms.keys()) { const st = runs.get(id)?.state ?? lastRuns.get(id); if (st) states[id] = st; }
      writeFileSync(tmp, JSON.stringify({ version: 4, rooms: [...rooms.values()], runs: states }, null, 1), { mode: 0o600 });
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
  /** `runId`: the run that produced the message. Once that run has a cutoff the message is dropped (returned, never stored). */
  const add = (r: Room, m: Omit<RoomMessage, 'id' | 'ts'>, runId?: string): RoomMessage => {
    const msg = { ...m, id: `m${Date.now().toString(36)}${(seq++).toString(36)}`, ts: Date.now() };
    const cut = runId ? cutoffs.get(runId) : undefined;
    if (cut) { dropLate(r, runId!, cut, m.from); return msg; }
    r.messages.push(msg);
    while (r.messages.length > MAX_STORED_MESSAGES) { // pinned decisions and queued messages outlive the cap
      const at = r.messages.findIndex((x) => !x.pinned && !x.queued);
      if (at < 0) break;
      r.messages.splice(at, 1);
    }
    touch(r);
    persist();
    return msg;
  };

  /** A late reply from a stopped run: not stored. The count goes on the run's state and one note in the thread says so (it may arrive after the run itself has finished). */
  function dropLate(r: Room, runId: string, cut: { dropped: number; from: Set<string>; noteId?: string }, from: string) {
    cut.dropped++;
    if (from !== 'system') cut.from.add(from);
    for (const st of [runs.get(r.id)?.state, lastRuns.get(r.id)]) if (st?.id === runId) st.dropped = cut.dropped;
    const text = `Stopped: ${cut.dropped} late repl${cut.dropped === 1 ? 'y' : 'ies'} from the stopped discussion ${cut.dropped === 1 ? 'was' : 'were'} dropped${cut.from.size ? ` (${[...cut.from].join(', ')})` : ''}.`;
    const note = cut.noteId ? r.messages.find((x) => x.id === cut.noteId) : undefined;
    if (note) note.text = text;
    else { const n = { id: `m${Date.now().toString(36)}${(seq++).toString(36)}`, ts: Date.now(), from: 'system', text }; r.messages.push(n); cut.noteId = n.id; }
    touch(r);
    persist();
  }

  const summary = (r: Room): RoomSummary => {
    const last = [...r.messages].reverse().find((m) => m.from !== 'system');
    return { id: r.id, name: r.name, members: r.members, archived: r.archived, updatedAt: r.updatedAt, running: runs.has(r.id), paused: runs.get(r.id)?.state.status === 'paused', captain: r.captain, ...(last ? { last: { from: last.from, text: last.text.slice(0, 120), ts: last.ts } } : {}) };
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
      const room: Room = { id: `r${randomBytes(4).toString('hex')}`, name: cleanName(body.name), members, captain: resolveCaptain(body.captain, members), archived: false, createdAt: now, updatedAt: now, messages: [], ...normalizeSettings(body) };
      rooms.set(room.id, room);
      persist();
      return this.get(room.id);
    },
    async update(id: string, patch: { name?: unknown; addMembers?: unknown; removeMembers?: unknown; archived?: unknown; captain?: unknown; notes?: unknown } & Partial<RoomSettings>): Promise<RoomView> {
      const r = mustGet(id);
      if (patch.responderMode !== undefined && !RESPONDER_MODES.includes(patch.responderMode)) throw new RoomError(400, `responderMode must be one of: ${RESPONDER_MODES.join(', ')}`);
      if (patch.notes !== undefined && (typeof patch.notes !== 'string' || patch.notes.length > MAX_NOTES_CHARS)) throw new RoomError(400, `notes must be text of at most ${MAX_NOTES_CHARS} characters`);
      if (runs.has(id) && (patch.addMembers || patch.removeMembers)) throw new RoomError(409, 'room is busy: stop the run before changing members');
      if (patch.name !== undefined) r.name = cleanName(patch.name);
      if (patch.addMembers !== undefined) r.members = await validMembers([...r.members, ...(Array.isArray(patch.addMembers) ? patch.addMembers : [patch.addMembers])]);
      if (patch.removeMembers !== undefined) {
        const drop = new Set(Array.isArray(patch.removeMembers) ? patch.removeMembers : [patch.removeMembers]);
        r.members = r.members.filter((m) => !drop.has(m));
      }
      if (patch.captain !== undefined) {
        if (typeof patch.captain !== 'string' || !r.members.includes(patch.captain)) throw new RoomError(400, 'the lead must be a member of the room');
        if (runs.has(id)) throw new RoomError(409, 'room is busy: stop the run before changing the lead');
        r.captain = patch.captain;
      }
      r.captain = resolveCaptain(r.captain, r.members); // members changed: the lead stays a member (rfc-lead, else the first)
      const set = Object.fromEntries(SETTING_KEYS.filter((k) => patch[k] !== undefined).map((k) => [k, patch[k]]));
      if (Object.keys(set).length) Object.assign(r, normalizeSettings({ ...r, ...set })); // the running discussion reads the pause limits and the speak filter live
      if (typeof patch.notes === 'string') r.notes = patch.notes.trim();
      if (typeof patch.archived === 'boolean') {
        if (patch.archived) stopRun(id);
        r.archived = patch.archived;
      }
      touch(r);
      persist();
      return this.get(id);
    },
    /**
     * Adds Zach's message. Idle room: starts the discussion in the background and returns at once (poll get() for replies). Busy room: the message is queued (shown as
     * queued, hidden from the agents) and joins at the next round boundary; a soft-paused run wakes up because Zach wrote.
     */
    async send(id: string, text: unknown): Promise<RoomView> {
      const r = mustGet(id);
      const msg = String(text ?? '').trim();
      if (!msg) throw new RoomError(400, 'empty message');
      if (msg.length > MAX_MESSAGE_CHARS) throw new RoomError(400, `message too long (max ${MAX_MESSAGE_CHARS} chars)`);
      if (r.archived) throw new RoomError(409, 'room is archived');
      if (!r.members.length) throw new RoomError(400, 'add at least one agent to the room first');
      const list = await agents(); // the only await: check for a running discussion and start one in the same tick, so two quick sends cannot start two runs
      const entry = runs.get(id);
      if (entry) {
        if (r.messages.filter((m) => m.queued).length >= MAX_QUEUED) throw new RoomError(409, `${MAX_QUEUED} messages are already queued: wait for the agents or press Stop`);
        add(r, { from: YOU, text: msg, queued: true });
        entry.resume?.();
        return this.get(id);
      }
      const trigger = add(r, { from: YOU, text: msg });
      const members: RoomMember[] = r.members.filter((m) => !isExcludedAgent(m)).map((m) => ({ id: m, name: info(list, m).name }));
      if (!selectResponders(msg, members, r.mentionGating, r.responderMode, r.captain).length) {
        add(r, { from: 'system', text: 'Nobody was addressed. This room only answers @mentions: mention an agent, or @all.' });
        return this.get(id);
      }
      startRun(r, trigger, members);
      return this.get(id);
    },
    /** "Ask lead to summarize": a normal message to the lead, consistent with a discussion that has no special wrap-up phase. */
    async wrapUp(id: string): Promise<RoomView> {
      const r = mustGet(id);
      if (!r.captain) throw new RoomError(400, 'the room has no lead');
      return this.send(id, `@${r.captain} Please wrap up: summarize where the discussion landed, the decisions made, and what is still open.`);
    },
    /** Hard stop: aborts every in-flight member run. */
    async stop(id: string): Promise<RoomView> {
      mustGet(id);
      stopRun(id);
      return this.get(id);
    },
    /** Soft stop ("End now"): turns already in flight finish and post; nothing new starts. Also releases a soft pause. */
    async end(id: string): Promise<RoomView> {
      mustGet(id);
      const e = runs.get(id);
      if (e) { e.ending = true; e.resume?.(); }
      return this.get(id);
    },
    /** The Continue button: release a soft pause (no cap: the run carries on until the agents pass or Zach stops it). */
    async resume(id: string): Promise<RoomView> {
      mustGet(id);
      runs.get(id)?.resume?.();
      return this.get(id);
    },
    /** Pin a message as a decision (or unpin it). Pinned messages are quoted to every member and survive the transcript cap. */
    async pin(id: string, messageId: unknown, pinned: unknown): Promise<RoomView> {
      const r = mustGet(id);
      const m = typeof messageId === 'string' ? r.messages.find((x) => x.id === messageId && x.from !== 'system') : undefined;
      if (!m) throw new RoomError(404, 'unknown message');
      const on = pinned !== false;
      if (on && !m.pinned && r.messages.filter((x) => x.pinned).length >= MAX_PINNED) throw new RoomError(409, `at most ${MAX_PINNED} pinned decisions: unpin one first`);
      if (on) m.pinned = true; else delete m.pinned;
      touch(r);
      persist();
      return this.get(id);
    },
    /** Test hook: resolves when the room's current run (and any run it chains into) finished. */
    async idle(id: string) { for (let e = runs.get(id); e; e = runs.get(id)) await e.done; },
    close() { for (const id of [...runs.keys()]) stopRun(id); },
  };

  /** Stop: record the cutoff for the run (so its late replies are dropped), then abort it and its Gateway runs. */
  function stopRun(roomId: string) {
    const e = runs.get(roomId);
    if (!e) return;
    if (!cutoffs.has(e.state.id)) {
      cutoffs.set(e.state.id, { at: Date.now(), dropped: 0, from: new Set() });
      while (cutoffs.size > 100) cutoffs.delete(cutoffs.keys().next().value!);
    }
    e.state.cutoffAt = cutoffs.get(e.state.id)!.at;
    e.abort.abort();
  }

  /** One discussion run for `trigger` (already in the thread). Chains into the next queued message if the run ends with one still waiting. */
  function startRun(r: Room, trigger: RoomMessage, members: RoomMember[]) {
    const id = r.id;
    delete trigger.queued;
    const abort = new AbortController();
    const state: RoomRunState = { id: `run${trigger.id}`, status: 'running', round: 1, turnsUsed: 0, active: [], activity: [], posts: 0, usage: emptyUsage(), filtered: 0 };
    const entry: RunEntry = { state, abort, done: Promise.resolve(), ending: false };
    const transport: RoomTransport = {
      async turn(agentId, prompt, signal, progress) {
        await gateway.ensureSession(agentId, id, `Room: ${r.name}`);
        return gateway.turn(agentId, id, prompt, signal, progress);
      },
      abort(agentId) { void gateway.abort?.(agentId, id).catch(() => undefined); },
      ...(gateway.judge ? { judge: (prompt: string, signal: AbortSignal) => gateway.judge!(id, r.captain, prompt, signal) } : {}),
    };
    const hooks = {
      append: (m: Omit<RoomMessage, 'id' | 'ts'>) => add(r, m, state.id),
      state: (p: Partial<RoomRunState>) => { Object.assign(state, p); if (p.status || 'pause' in p) persist(); },
      waitForContinue: (signal: AbortSignal) => new Promise<void>((resolve) => {
        entry.resume = () => { entry.resume = undefined; resolve(); };
        signal.addEventListener('abort', () => resolve(), { once: true });
      }),
      takeQueued: () => {
        const q = r.messages.filter((m) => m.queued);
        for (const m of q) delete m.queued;
        if (q.length) { touch(r); persist(); }
        return q;
      },
      ended: () => entry.ending,
      usage: (_agent: string, u: Parameters<typeof addUsage>[1]) => { r.usage = addUsage(r.usage ?? emptyUsage(), u); },
    };
    const flow = runDiscussion(r, members, trigger, transport, hooks, abort.signal, opts.retry);
    entry.done = flow
      .then((reason) => { state.stopReason = reason; state.status = reason === 'cancelled' ? 'stopped' : 'done'; }, (e) => {
        state.stopReason = 'cancelled'; state.status = 'stopped';
        add(r, { from: 'system', text: `Run failed: ${(e as Error).message}` });
      })
      .finally(() => {
        state.active = []; state.activity = []; delete state.pause; entry.resume = undefined;
        // Messages still queued: a stopped or ended run drops them (with a note); otherwise (a message that raced the run's last boundary) they start the next run.
        const waiting = r.messages.filter((m) => m.queued);
        let next: RoomMessage | undefined;
        if (waiting.length) {
          if (state.stopReason === 'cancelled' || state.stopReason === 'ended') {
            for (const m of waiting) delete m.queued;
            add(r, { from: 'system', text: `${waiting.length} queued message${waiting.length === 1 ? ' was' : 's were'} not sent to the agents because the discussion was ${state.stopReason === 'ended' ? 'ended' : 'stopped'}.` });
          } else next = waiting[0];
        }
        lastRuns.set(id, { ...state }); runs.delete(id); touch(r); persist();
        if (next && !r.archived) {
          const list = r.members.filter((m) => !isExcludedAgent(m)).map((m) => ({ id: m, name: info(agentCache?.list ?? [], m).name }));
          startRun(r, next, list);
        }
      });
    runs.set(id, entry);
    persist(); // a crash before the first reply must still leave a running run on disk, so the restart can show it as interrupted
  }
}
export type RoomsService = ReturnType<typeof createRoomsService>;
