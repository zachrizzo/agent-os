// Group rooms: an OPEN DISCUSSION, like a group chat. Pure logic, no I/O: the server injects a transport (real Gateway sessions or a fake) so the loop is unit-testable.
//   - Zach posts; every member replies in the shared thread (round 1, in parallel, as each one finishes its bubble appears).
//   - Every next round, every member sees the whole discussion so far and either replies (builds on it, disagrees, @mentions a member) or says PASS.
//   - The lead (room.captain) speaks last in each round and moderates: it can steer by addressing members, and posts the FINAL answer once the discussion has converged.
//   - The run ends when the lead posts its final answer, or after a round where nobody adds anything new (the lead then wraps up), or when Zach hits Stop.
//     A generous silent backstop (MAX_DISCUSSION_ROUNDS) keeps a runaway conversation finite; nothing about it is shown.
//   - A message that @mentions members is a direct question: only they reply, and replies that @mention others pull those in (no lead wrap-up).

// Rooms ask for "PASS", not OpenClaw's NO_REPLY: in a direct session the Gateway treats an exact NO_REPLY as a failed turn and re-prompts
// the agent ("The previous attempt did not produce a user-visible answer"), which would burn a turn and force an answer. NO_REPLY is still accepted as a pass.
export const PASS_TOKEN = 'PASS';
export const FINAL_MARK = 'FINAL:';
export const MAX_MEMBERS = 16;
export const MAX_ROOMS = 50;
export const MAX_ROOM_NAME = 60;
export const MAX_MESSAGE_CHARS = 4000;
export const MAX_STORED_MESSAGES = 400;
/** Silent backstop on discussion rounds (never shown). */
export const MAX_DISCUSSION_ROUNDS = 20;
const CONTEXT_MESSAGES = 6;
const CONTEXT_ITEM_CHARS = 600;
const DISCUSSION_ITEM_CHARS = 1500;
const DISCUSSION_TOTAL_CHARS = 14000;
export const YOU = 'you';

/** The PHI agent is never listed, joined or messaged. */
export const isExcludedAgent = (id: string) => /^phi($|[-_.])/i.test(id.trim());

export const roomSessionKey = (agentId: string, roomId: string) => `agent:${agentId}:room-${roomId}`;
/** The only session keys rooms create, message, or hand to the host. */
export const ROOM_KEY_RE = /^agent:([a-z0-9][a-z0-9_-]{0,63}):room-(r[0-9a-f]{8})$/;

export interface RoomMember { id: string; name: string }
export interface RoomMessage {
  id: string;
  ts: number;
  /** "you", an agent id, or "system" for stop/failure notes. */
  from: string;
  text: string;
  round?: number;
  /** The lead's final answer: the discussion converged (or went quiet) and this is the answer for Zach. */
  final?: boolean;
}
export interface RoomSettings { mentionGating: boolean }
export interface Room extends RoomSettings {
  id: string;
  name: string;
  members: string[]; // agent ids, join order
  /** The lead who moderates and posts the final answer: always one of `members` (or '' for an empty room). */
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
 * Load a stored room from any earlier version. The captain-led pipeline's fields (mode, maxRounds, maxSteps, councils, turn/timeout caps) are dropped, and
 * a former council answer becomes a normal final bubble. Nothing is written until the room's next normal save.
 */
export function migrateRoom(r: Room): Room {
  const { maxTurns: _t, memberTimeoutSec: _m, noLimitMigrated: _n, maxRounds: _r, maxSteps: _s, mode: _mode, councils: _c, ...rest } =
    r as Room & { maxTurns?: number; memberTimeoutSec?: number; noLimitMigrated?: boolean; maxRounds?: number; maxSteps?: number; mode?: string; councils?: unknown };
  const messages = (r.messages ?? []).map((m) => {
    const { council, ...msg } = m as RoomMessage & { council?: string };
    return council ? { ...msg, final: true } : msg;
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

/** A reply that starts with "FINAL:" is the lead's final answer. Returns the text without the marker. */
export function parseFinal(reply: string): { final: boolean; text: string } {
  const m = /^\s*FINAL:\s*/i.exec(reply);
  return m ? { final: true, text: reply.slice(m[0].length).trim() } : { final: false, text: reply.trim() };
}

const words = (s: string) => new Set(s.toLowerCase().match(/[a-z0-9']{3,}/g) ?? []);
/** "Adds nothing new": a bare acknowledgement, or a reply whose words were nearly all already said in the discussion. */
export function addsNothingNew(reply: string, prior: string[]): boolean {
  const mine = words(reply);
  if (mine.size <= 5) return true;
  const seen = new Set<string>();
  for (const p of prior) for (const w of words(p)) seen.add(w);
  let known = 0;
  for (const w of mine) if (seen.has(w)) known++;
  return known / mine.size >= 0.85;
}

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
    : `It is round ${c.round}. You have now seen what everyone said. Reply if you can add something: build on a point, disagree with someone, answer a question, or hand something to a member with @id. If you have nothing new to add, reply exactly ${PASS_TOKEN}.`;
  const lead = isLead
    ? c.round === 1
      ? ` You are the lead: you moderate this discussion. For now just give your take.`
      : ` You are the lead: you moderate this discussion. Steer it by addressing members with @id when someone should dig in. When the discussion has converged, post the final answer for Zach: start your reply with ${FINAL_MARK} and write the answer in full, folding in the members' points and any disagreement that remains. Do not post ${FINAL_MARK} while members are still mid-exchange.`
    : '';
  return [promptHead(c), `${body}${lead}`, TALK].join('\n\n');
}

/** The discussion went quiet: the lead posts the answer. */
export function wrapUpPrompt(c: PromptCtx): string {
  return [promptHead(c), `The discussion has gone quiet. WRAP-UP: post the final answer for Zach now. Start your reply with ${FINAL_MARK}, then write the answer in full, folding in the members' points and noting any disagreement that remains.`].join('\n\n');
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
export interface DiscussionOpts { maxRounds?: number }

/** One Zach message -> an open discussion. Never throws for an agent failure: it becomes a system note and the turn is spent. */
export async function runDiscussion(room: Room, members: RoomMember[], trigger: RoomMessage, transport: RoomTransport, hooks: RunHooks, signal: AbortSignal, opts: DiscussionOpts = {}): Promise<RoomRunState['stopReason']> {
  if (!members.length) return 'complete';
  const maxRounds = opts.maxRounds ?? MAX_DISCUSSION_ROUNDS;
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
  const priorTexts = () => room.messages.filter((m) => m.from !== 'system' && m.id !== trigger.id).map((m) => m.text);

  /** The lead's closing answer. */
  async function wrapUp(round: number): Promise<void> {
    const reply = await ask(lead.id, wrapUpPrompt(ctxFor(lead.id, round)), round);
    if (isPass(reply)) { hooks.append({ from: 'system', text: `${lead.name} could not wrap up the discussion.`, round }); return; }
    hooks.append({ from: lead.id, text: parseFinal(reply!).text, round, final: true });
  }

  try {
    let targets = directed ? mentionedByZach! : order;
    for (let round = 1; round <= maxRounds; round++) {
      hooks.state({ round });
      if (signal.aborted) return 'cancelled';
      const others = targets.filter((id) => !(open && id === lead.id));
      // Everyone but the lead answers at once; each bubble lands as soon as that agent finishes. The lead then answers having read them.
      const posted: Array<{ id: string; text: string; fresh: boolean }> = [];
      const prior = priorTexts();
      await Promise.all(others.map(async (id) => {
        const reply = await ask(id, memberPrompt(ctxFor(id, round)), round);
        if (isPass(reply)) return;
        const text = parseFinal(reply!).text; // only the lead's FINAL means anything; strip a stray marker from a member
        hooks.append({ from: id, text, round });
        posted.push({ id, text, fresh: !addsNothingNew(text, prior) });
      }));
      if (signal.aborted) return 'cancelled';

      let leadSteered = false;
      if (open && targets.includes(lead.id)) {
        const reply = await ask(lead.id, memberPrompt(ctxFor(lead.id, round)), round);
        if (!isPass(reply)) {
          const f = parseFinal(reply!);
          if (f.final && round >= 2) { hooks.append({ from: lead.id, text: f.text, round, final: true }); return 'complete'; }
          hooks.append({ from: lead.id, text: f.text, round });
          leadSteered = (parseMentions(f.text, members.filter((m) => m.id !== lead.id))?.length ?? 0) > 0;
        }
      }
      if (signal.aborted) return 'cancelled';

      if (directed) {
        const mentioned = new Set<string>();
        for (const p of posted) for (const m of parseMentions(p.text, members.filter((x) => x.id !== p.id)) ?? []) mentioned.add(m);
        const next = new Set([...posted.map((p) => p.id), ...mentioned]);
        targets = order.filter((id) => next.has(id));
        if (!posted.length) return 'passed';
        if (!mentioned.size) return 'complete'; // answered, nobody was handed anything
        continue;
      }
      if (!open) return 'complete'; // a one-member room: one reply
      const quiet = !posted.some((p) => p.fresh) && !leadSteered;
      if (quiet || round === maxRounds) { await wrapUp(round); return 'complete'; }
      targets = order;
    }
    return 'complete';
  } catch (e) {
    if (signal.aborted) return 'cancelled';
    throw e;
  }
}
