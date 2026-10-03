// Group rooms: an OPEN DISCUSSION, like a group chat. Pure logic, no I/O: the server injects a transport (real Gateway sessions or a fake) so the loop is unit-testable.
//   - Zach posts; every member replies in the shared thread (round 1, in parallel; each bubble lands as soon as that agent finishes).
//   - Every next round, every member sees the whole discussion so far and either replies (builds on it, disagrees, @mentions a member) or says PASS.
//   - The lead (room.captain) is a normal member that also moderates: it speaks last in each round and steers by addressing members. It does not conclude the discussion.
//   - The run ends only when a whole round is PASS (agents decide that themselves), or when Zach hits Stop. There is no round cap and no word-overlap heuristic.
//   - A message that @mentions members is a direct question: only they reply, and replies that @mention others pull those in.

// Rooms ask for "PASS", not OpenClaw's NO_REPLY: in a direct session the Gateway treats an exact NO_REPLY as a failed turn and re-prompts
// the agent ("The previous attempt did not produce a user-visible answer"), which would burn a turn and force an answer. NO_REPLY is still accepted as a pass.
export const PASS_TOKEN = 'PASS';
export const MAX_MEMBERS = 16;
export const MAX_ROOMS = 50;
export const MAX_ROOM_NAME = 60;
export const MAX_MESSAGE_CHARS = 4000;
export const MAX_STORED_MESSAGES = 400;
const CONTEXT_MESSAGES = 6;
const CONTEXT_ITEM_CHARS = 600;
const DISCUSSION_ITEM_CHARS = 1500;
const DISCUSSION_TOTAL_CHARS = 14000;
export const YOU = 'you';

export const roomSessionKey = (agentId: string, roomId: string) => `agent:${agentId}:room-${roomId}`;
/** The only session keys rooms create, message, or hand to the host. */
export const ROOM_KEY_RE = /^agent:([a-z0-9][a-z0-9_-]{0,63}):room-(r[0-9a-f]{8})$/;
/** The PHI agent is never listed, joined or messaged. */
export const isExcludedAgent = (id: string) => /^phi($|[-_.])/i.test(id.trim());


export interface RoomMember { id: string; name: string }
export interface RoomMessage {
  id: string;
  ts: number;
  /** "you", an agent id, or "system" for stop/failure notes. */
  from: string;
  text: string;
  round?: number;
}
export interface RoomSettings { mentionGating: boolean }
export interface Room extends RoomSettings {
  id: string;
  name: string;
  members: string[]; // agent ids, join order
  /** The lead who moderates (a normal member otherwise): always one of `members` (or '' for an empty room). */
  captain: string;
  archived: boolean;
  createdAt: number;
  updatedAt: number;
  messages: RoomMessage[];
}
export interface RoomRunState {
  id: string;
  status: 'running' | 'done' | 'stopped';
  round: number;
  turnsUsed: number;
  /** Agent ids with a turn in flight right now (their typing bubbles). */
  active: string[];
  stopReason?: 'passed' | 'cancelled' | 'complete';
}

export const clampInt = (v: unknown, min: number, max: number, dflt: number) => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.trunc(n))) : dflt;
};

export function normalizeSettings(raw: Partial<RoomSettings> | undefined): RoomSettings {
  return { mentionGating: raw?.mentionGating !== false };
}

/** The lead is always a member. A saved lead that is still a member wins; otherwise `rfc-lead` when present, else the first member. */
export function resolveCaptain(saved: unknown, members: string[]): string {
  if (typeof saved === 'string' && members.includes(saved)) return saved;
  return members.includes('rfc-lead') ? 'rfc-lead' : members[0] ?? '';
}

/**
 * Load a stored room from any earlier version. The captain-led pipeline's fields (mode, maxRounds, maxSteps, councils, turn/timeout caps) and the
 * per-message council/final flags are dropped: every message is a normal bubble. Nothing is written until the room's next normal save.
 */
export function migrateRoom(r: Room): Room {
  const { maxTurns: _t, memberTimeoutSec: _m, noLimitMigrated: _n, maxRounds: _r, maxSteps: _s, mode: _mode, councils: _c, ...rest } =
    r as Room & { maxTurns?: number; memberTimeoutSec?: number; noLimitMigrated?: boolean; maxRounds?: number; maxSteps?: number; mode?: string; councils?: unknown };
  const messages = (r.messages ?? []).map((m) => {
    const { council: _c, final: _f, ...msg } = m as RoomMessage & { council?: string; final?: boolean };
    return msg;
  });
  return { ...rest, ...normalizeSettings(r), captain: resolveCaptain(r.captain, r.members), messages };
}

export const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');

/** Member ids explicitly @mentioned in `text`, by agent id or display name (spaces ignored), in member order. `@all`/`@everyone` returns null. */
export function parseMentions(text: string, members: RoomMember[]): string[] | null {
  const tokens = [...text.matchAll(/(?:^|[^\w@])@([A-Za-z0-9][\w.-]*)/g)].map((m) => slug(m[1].replace(/[.-]+$/, '')));
  if (tokens.some((t) => t === 'all' || t === 'everyone' || t === 'room')) return null;
  const hit = new Set<string>();
  for (const m of members) {
    const keys = new Set([slug(m.id), slug(m.name)]);
    if (tokens.some((t) => keys.has(t))) hit.add(m.id);
  }
  return members.filter((m) => hit.has(m.id)).map((m) => m.id);
}

/** Round-1 responders. Gating on: mentioned members, or everyone when none match. Gating off: everyone. */
export function selectResponders(text: string, members: RoomMember[], gating: boolean): string[] {
  if (!gating) return members.map((m) => m.id);
  const hit = parseMentions(text, members);
  return hit && hit.length ? hit : members.map((m) => m.id);
}

export const isPass = (reply: string | null | undefined) => {
  const t = (reply ?? '').trim();
  return !t || /^(PASS|NO_REPLY)[.!]?$/i.test(t);
};

const clipText = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();
const nameFor = (members: RoomMember[]) => (id: string) => (id === YOU ? 'You' : members.find((m) => m.id === id)?.name ?? id);

/** The thread as one agent reads it: a little earlier context, then Zach's message, then the whole discussion since (newest kept when it is long). */
export function discussionBlock(messages: RoomMessage[], trigger: RoomMessage, nameOf: (id: string) => string): { context: string; discussion: string } {
  const real = messages.filter((m) => m.from !== 'system');
  const at = real.findIndex((m) => m.id === trigger.id);
  const before = (at < 0 ? real : real.slice(0, at)).slice(-CONTEXT_MESSAGES);
  const after = at < 0 ? [] : real.slice(at + 1);
  const context = before.map((m) => `${nameOf(m.from)}: ${clipText(oneLine(m.text), CONTEXT_ITEM_CHARS)}`).join('\n');
  const lines: string[] = [];
  let total = 0;
  for (const m of [...after].reverse()) {
    const line = `${nameOf(m.from)}: ${clipText(oneLine(m.text), DISCUSSION_ITEM_CHARS)}`;
    if (total + line.length > DISCUSSION_TOTAL_CHARS) { lines.unshift('(earlier replies trimmed)'); break; }
    total += line.length;
    lines.unshift(line);
  }
  return { context, discussion: lines.join('\n') || '(nobody has replied yet)' };
}

interface PromptCtx { room: Room; members: RoomMember[]; agent: RoomMember; lead: RoomMember; trigger: RoomMessage; round: number; directed: boolean }

function promptHead(c: PromptCtx): string {
  const roster = ['You (Zach)', ...c.members.map((m) => `${m.name} (@${m.id})`)].join(', ');
  const lead = c.directed ? '' : ` Lead: ${c.lead.name} (@${c.lead.id}).`;
  const { context, discussion } = discussionBlock(c.room.messages, c.trigger, nameFor(c.members));
  return [
    `[Agent OS group room "${c.room.name}". You are ${c.agent.name} (@${c.agent.id}). Members: ${roster}.${lead}]`,
    context ? `Earlier in the room:\n${context}` : '',
    `Zach's message:\n${c.trigger.text}\n\nDiscussion so far:\n${discussion}`,
  ].filter(Boolean).join('\n\n');
}
const TALK = `Write only your own reply, as one message in a group chat: short and conversational, no headings. Hand a point to someone with @id.`;

/** What a member (or the lead) is asked each round. Round 1 is the first reaction; later rounds are a reply-or-PASS check against the whole discussion. */
export function memberPrompt(c: PromptCtx): string {
  const isLead = !c.directed && c.agent.id === c.lead.id && c.members.length > 1;
  const body = c.round === 1
    ? `It is round 1. Give your own take on Zach's message. The others are answering at the same time and have not seen your reply yet.`
    : `It is round ${c.round}. You have now seen what everyone said. Reply if you can add something: build on a point, disagree with someone, answer a question, or hand something to a member with @id. If you have nothing to add, reply exactly ${PASS_TOKEN}. Do not repeat or just agree with what is already said: the discussion ends when everyone passes in the same round.`;
  const lead = isLead
    ? ` You are the lead: you moderate this discussion, as a member who also takes part. Keep it moving: address members with @id when someone should dig in, point out where two members disagree, ask for what is missing. You do not conclude the discussion; when there is nothing left to steer, reply exactly ${PASS_TOKEN}. If Zach asks for a summary, write it as a normal message.`
    : '';
  return [promptHead(c), `${body}${lead}`, TALK].join('\n\n');
}

export interface RoomTransport {
  /** One agent turn on that agent's dedicated room session. Resolve with the reply text, or null when it passed / produced nothing. */
  turn(agentId: string, prompt: string, signal: AbortSignal): Promise<string | null>;
  /** Best effort: cancel that agent's in-flight run on the Gateway (Stop). Never throws. */
  abort?(agentId: string): void;
}
export interface RunHooks {
  append(msg: Omit<RoomMessage, 'id' | 'ts'>): RoomMessage;
  state(patch: Partial<RoomRunState>): void;
}
/** One Zach message -> an open discussion. Never throws for an agent failure: it becomes a system note and counts as a pass. */
export async function runDiscussion(room: Room, members: RoomMember[], trigger: RoomMessage, transport: RoomTransport, hooks: RunHooks, signal: AbortSignal): Promise<RoomRunState['stopReason']> {
  if (!members.length) return 'complete';
  const lead = members.find((m) => m.id === room.captain) ?? members[0];
  const byId = new Map(members.map((m) => [m.id, m]));
  const order = members.map((m) => m.id);
  const mentionedByZach = room.mentionGating ? parseMentions(trigger.text, members) : null;
  const directed = !!mentionedByZach?.length;
  const open = !directed && members.length > 1;
  let turnsUsed = 0;
  const active = new Set<string>();
  const publish = () => hooks.state({ turnsUsed, active: [...active] });

  /** One turn. A failure becomes a system note and counts as a pass; Stop propagates as 'cancelled'. */
  async function ask(agentId: string, prompt: string, round: number): Promise<string | null> {
    const agent = byId.get(agentId)!;
    turnsUsed++; active.add(agentId); publish();
    const onAbort = () => transport.abort?.(agentId); // Stop reaches the Gateway run, not just this loop
    signal.addEventListener('abort', onAbort, { once: true });
    try { return await transport.turn(agentId, prompt, signal); } catch (e) {
      if (signal.aborted) throw new Error('cancelled');
      hooks.append({ from: 'system', text: `${agent.name} did not answer: ${(e as Error).message}`, round });
      return null;
    } finally { signal.removeEventListener('abort', onAbort); active.delete(agentId); publish(); }
  }
  const ctxFor = (agentId: string, round: number): PromptCtx => ({ room, members, agent: byId.get(agentId)!, lead, trigger, round, directed });

  try {
    let targets = directed ? mentionedByZach! : order;
    for (let round = 1; ; round++) {
      hooks.state({ round });
      if (signal.aborted) return 'cancelled';
      const others = targets.filter((id) => !(open && id === lead.id));
      // Everyone but the lead answers at once; each bubble lands as soon as that agent finishes. The lead then answers having read them.
      const posted: Array<{ id: string; text: string }> = [];
      await Promise.all(others.map(async (id) => {
        const reply = await ask(id, memberPrompt(ctxFor(id, round)), round);
        if (isPass(reply)) return;
        const text = reply!.trim();
        hooks.append({ from: id, text, round });
        posted.push({ id, text });
      }));
      if (signal.aborted) return 'cancelled';
      if (open && targets.includes(lead.id)) {
        const reply = await ask(lead.id, memberPrompt(ctxFor(lead.id, round)), round);
        if (!isPass(reply)) {
          const text = reply!.trim();
          hooks.append({ from: lead.id, text, round });
          posted.push({ id: lead.id, text });
        }
      }
      if (signal.aborted) return 'cancelled';

      if (!posted.length) return 'passed'; // a whole round of PASS: the discussion is over
      if (directed) {
        const mentioned = new Set<string>();
        for (const p of posted) for (const m of parseMentions(p.text, members.filter((x) => x.id !== p.id)) ?? []) mentioned.add(m);
        if (!mentioned.size) return 'complete'; // answered, nobody was handed anything
        const next = new Set([...posted.map((p) => p.id), ...mentioned]);
        targets = order.filter((id) => next.has(id));
        continue;
      }
      if (!open) return 'complete'; // a one-member room: one reply
      targets = order;
    }
  } catch (e) {
    if (signal.aborted) return 'cancelled';
    throw e;
  }
}
