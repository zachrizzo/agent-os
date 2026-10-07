// Group rooms: an OPEN DISCUSSION, like a group chat. Pure logic, no I/O: the server injects a transport (real Gateway sessions or a fake) so the loop is unit-testable.
//   - Zach posts; every member replies in the shared thread (round 1, in parallel; each bubble lands as soon as that agent finishes).
//   - Every next round, every member sees the whole discussion so far and either replies (builds on it, disagrees, @mentions a member) or says PASS.
//   - The lead (room.captain) is a normal member that also moderates: it speaks last in each round and steers by addressing members. It does not conclude the discussion.
//   - The run ends only when a whole round is PASS (agents decide that themselves), or when Zach hits Stop. There is no round cap and no word-overlap heuristic.
//   - A message that @mentions members is a direct question: only they reply, and replies that @mention others pull those in.
//   - Still no cap: a long run does not stop, it PAUSES (soft) after N bot posts / M tokens since Zach last spoke, or when members repeat themselves or hand a point round a ring.
//     A pause holds the run until Zach clicks Continue (or writes, or Stops). A Zach message during a run is queued and joins at the next round boundary.
//   - A failed turn is not a PASS: rate limits / overload are retried (twice, jittered backoff), auth and billing errors are terminal, and every failure is shown in the thread.
//     A run never ends as "everyone passed" when a turn in that round failed: it ends as `failed`.

// Rooms ask for "PASS", not OpenClaw's NO_REPLY: in a direct session the Gateway treats an exact NO_REPLY as a failed turn and re-prompts
// the agent ("The previous attempt did not produce a user-visible answer"), which would burn a turn and force an answer. NO_REPLY is still accepted as a pass.
export const PASS_TOKEN = 'PASS';
export const MAX_MEMBERS = 16;
export const MAX_ROOMS = 50;
export const MAX_ROOM_NAME = 60;
export const MAX_MESSAGE_CHARS = 4000;
export const MAX_STORED_MESSAGES = 400;
export const MAX_PURPOSE_CHARS = 300;
const CONTEXT_MESSAGES = 6;
const CONTEXT_ITEM_CHARS = 600;
const DISCUSSION_ITEM_CHARS = 1500;
const DISCUSSION_TOTAL_CHARS = 14000;
export const YOU = 'you';

export const roomSessionKey = (agentId: string, roomId: string) => `agent:${agentId}:room-${roomId}`;
/** The small-model session behind a room's optional speak filter. */
export const judgeSessionKey = (agentId: string, roomId: string) => `${roomSessionKey(agentId, roomId)}-judge`;
/** The only session keys rooms create, message, or hand to the host. */
export const ROOM_KEY_RE = /^agent:([a-z0-9][a-z0-9_-]{0,63}):room-(r[0-9a-f]{8})(?:-judge)?$/;
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
  /** Zach wrote this while a run was active: it is in the thread but the agents have not seen it yet (it joins at the next round boundary). */
  queued?: boolean;
  /** Pinned by Zach as a decision: always shown in the Decisions shelf and quoted to every member. */
  pinned?: boolean;
  passed?: string[];
}
export type ResponderMode = 'quiet' | 'everyone' | 'mentions' | 'lead';
export const RESPONDER_MODES: readonly ResponderMode[] = ['quiet', 'everyone', 'mentions', 'lead'];
export const DEFAULT_RESPONDER_MODE: ResponderMode = 'quiet';
export interface RoomSettings {
  mentionGating: boolean;
  responderMode: ResponderMode;
  /** Soft pause after this many bot posts since Zach last spoke (or last clicked Continue). 0 = never pause on count. */
  pauseAfterPosts: number;
  /** Soft pause after this many tokens (in + out) since Zach last spoke. 0 = off. */
  pauseAfterTokens: number;
  /** Opt-in: a small model decides who has something to add in rounds 2+, instead of spending a full turn on PASS. Off by default. */
  speakFilter: boolean;
}
export interface RoomUsage { turns: number; inputTokens: number; outputTokens: number; costUsd: number; /** some turns had no usage from the Gateway and were estimated (~4 chars per token) */ estimated: boolean }
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
  /** Shared notes for the room: written by Zach, quoted to every member each turn. */
  notes?: string;
  purpose?: string;
  primed?: string[];
  /** Running total across every run in this room. */
  usage?: RoomUsage;
}
/** What one member is doing right now, for the participants strip. `waiting`: the lead is holding its turn until the others have answered. */
export interface AgentActivity { id: string; state: 'thinking' | 'tool' | 'waiting'; since: number; tool?: string; waitingOn?: string[] }
export interface PauseInfo { reason: 'posts' | 'tokens' | 'repeat' | 'ring' | 'round'; detail: string; at: number }
export interface RoomRunState {
  id: string;
  /** `paused`: a soft pause, waiting for Continue. `interrupted`: the data server restarted mid-run; the run is not replayed. */
  status: 'running' | 'paused' | 'done' | 'stopped' | 'interrupted';
  round: number;
  turnsUsed: number;
  /** Agent ids with a turn in flight right now (their typing bubbles). */
  active: string[];
  activity?: AgentActivity[];
  /** Bot posts since Zach last spoke. */
  posts?: number;
  usage?: RoomUsage;
  lastSpeaker?: string;
  pause?: PauseInfo;
  /** Turns the speak filter saved (members it said had nothing to add). */
  filtered?: number;
  /** `failed`: the run finished but a member's turn failed (shown in the thread); it is never reported as everyone passing. */
  stopReason?: 'passed' | 'cancelled' | 'complete' | 'ended' | 'interrupted' | 'failed';
  /** When Stop was pressed: replies still arriving from this run after that moment are dropped. */
  cutoffAt?: number;
  /** Late replies from this stopped run that were dropped instead of joining the thread. */
  dropped?: number;
}

export const emptyUsage = (): RoomUsage => ({ turns: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, estimated: false });
export const totalTokens = (u: Pick<RoomUsage, 'inputTokens' | 'outputTokens'>) => u.inputTokens + u.outputTokens;
export interface TurnUsage { inputTokens: number; outputTokens: number; costUsd?: number; estimated?: boolean }
export const addUsage = (u: RoomUsage, t: TurnUsage): RoomUsage => ({
  turns: u.turns + 1, inputTokens: u.inputTokens + t.inputTokens, outputTokens: u.outputTokens + t.outputTokens, costUsd: u.costUsd + (t.costUsd ?? 0), estimated: u.estimated || !!t.estimated,
});
/** ~4 characters per token: only used when the Gateway reports no usage for a turn. */
export const estimateUsage = (prompt: string, reply: string | null): TurnUsage => ({ inputTokens: Math.ceil(prompt.length / 4), outputTokens: Math.ceil((reply ?? '').length / 4), estimated: true });

export const clampInt = (v: unknown, min: number, max: number, dflt: number) => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.trunc(n))) : dflt;
};

export const DEFAULT_PAUSE_POSTS = 24;
export function normalizeSettings(raw: Partial<RoomSettings> | undefined): RoomSettings {
  return {
    mentionGating: raw?.mentionGating !== false,
    responderMode: RESPONDER_MODES.includes(raw?.responderMode as ResponderMode) ? raw!.responderMode! : DEFAULT_RESPONDER_MODE,
    pauseAfterPosts: clampInt(raw?.pauseAfterPosts, 0, 500, DEFAULT_PAUSE_POSTS),
    pauseAfterTokens: clampInt(raw?.pauseAfterTokens, 0, 50_000_000, 0),
    speakFilter: raw?.speakFilter === true,
  };
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

export type MentionIntent = 'ask' | 'cc' | 'no-reply' | 'negation' | 'reference';

const MENTION_LIST = String.raw`(?:(?:@[\w.-]+|and|&)[\s,]*)*`;
const CC_BEFORE = new RegExp(String.raw`(?:^|[^\w])(?:b?cc|cc'?ing|fyi|copying)\b[\s:,'-]*${MENTION_LIST}$`, 'i');
const FYI_AFTER = /^[\s,:;—–-]*(?:just\s+)?fyi\b/i;
const STAND_DOWN_BEFORE = new RegExp(String.raw`\b(?:stand\s+down|hold\s+off)[\s,:—–-]*${MENTION_LIST}$`, 'i');
const NEGATION_AFTER = /^[\s,:;—–-]*(?:(?:please|pls)\s+|you\s+(?:can\s+|should\s+|may\s+)?)?(?:don'?t|dont|do\s+not|never|stand\s+down|hold\s+off|no\s+need|needn'?t|shouldn'?t|should\s+not|mustn'?t|must\s+not)\b/i;
const NO_REPLY = new RegExp([
  String.raw`no\s+need\s+(?:for\s+you\s+)?to\s+(?:reply|respond|answer|ack(?:nowledge)?|chime\s+in|weigh\s+in|comment|do\s+anything|act)`,
  String.raw`no\s+(?:reply|response|answer|action|ack(?:nowledg?ement)?)\s+(?:is\s+)?(?:needed|required|necessary|expected)`,
  String.raw`(?:don'?t|do\s+not|needn'?t)\s+(?:need\s+to\s+)?(?:reply|respond|answer|ack(?:nowledge)?|do\s+anything)`,
  String.raw`nothing\s+(?:needed|required)\s+from\s+you`,
  String.raw`for\s+(?:your\s+)?(?:awareness|visibility|information|reference)`,
].map((p) => `\\b${p}\\b`).join('|'), 'i');
const REFERENCE_BEFORE = /\b(?:as|per)\s+$/i;
const REFERENCE_AFTER = /^(?:'s\b|\s+(?:said|says|noted|mentioned|suggested|pointed\s+out|wrote|already\s+(?:said|noted|covered))\b)/i;
const MENTION_RE = /(?:^|[^\w@])@([A-Za-z0-9][\w.-]*)/g;

interface Sentence { start: number; end: number; question: boolean; text: string }
function sentencesOf(text: string): Sentence[] {
  const out: Sentence[] = [];
  let start = 0;
  for (const b of text.matchAll(/[.!?;]+(?=\s|$)|\n/g)) {
    const end = b.index! + b[0].length;
    out.push({ start, end, question: b[0].includes('?'), text: text.slice(start, end) });
    start = end;
  }
  if (start < text.length) out.push({ start, end: text.length, question: false, text: text.slice(start) });
  return out;
}

function intentAt(text: string, sentences: Sentence[], at: number, nameEnd: number): MentionIntent {
  const i = sentences.findIndex((s) => at >= s.start && at < s.end);
  const s = sentences[i];
  const before = text.slice(s.start, at);
  const after = text.slice(nameEnd, s.end);
  if (CC_BEFORE.test(before) || FYI_AFTER.test(after)) return 'cc';
  if (REFERENCE_BEFORE.test(before) || REFERENCE_AFTER.test(after)) return 'reference';
  const next = sentences[i + 1];
  if (NO_REPLY.test(s.text) || (next && !next.text.includes('@') && NO_REPLY.test(next.text))) return 'no-reply';
  if (!s.question && (NEGATION_AFTER.test(after) || STAND_DOWN_BEFORE.test(before))) return 'negation';
  return 'ask';
}

export function mentionIntents(text: string, members: RoomMember[]): Array<{ id: string; intent: MentionIntent }> {
  const clean = text.replace(/[‘’]/g, "'");
  const sentences = sentencesOf(clean);
  const out: Array<{ id: string; intent: MentionIntent }> = [];
  for (const m of clean.matchAll(MENTION_RE)) {
    const name = m[1].replace(/[.-]+$/, '');
    const member = members.find((x) => slug(x.id) === slug(name) || slug(x.name) === slug(name));
    if (!member) continue;
    const at = m.index! + m[0].length - m[1].length - 1;
    out.push({ id: member.id, intent: intentAt(clean, sentences, at, at + 1 + name.length) });
  }
  return out;
}

export function handedMentions(text: string, members: RoomMember[]): string[] {
  if (parseMentions(text, members) === null) return [];
  const asked = new Set(mentionIntents(text, members).filter((x) => x.intent === 'ask').map((x) => x.id));
  return members.filter((m) => asked.has(m.id)).map((m) => m.id);
}

/**
 * Round-1 responders. @all always means everyone. With mention gating on (or in `mentions` mode), @mentioned members answer alone; a message with no mention goes to
 * everyone (`everyone`), only the lead (`lead`), or nobody (`mentions`). Gating off (outside `mentions` mode): everyone, always.
 */
export function selectResponders(text: string, members: RoomMember[], gating: boolean, mode: ResponderMode = DEFAULT_RESPONDER_MODE, leadId = ''): string[] {
  const everyone = members.map((m) => m.id);
  if (!gating && mode !== 'mentions' && mode !== 'quiet') return everyone;
  const hit = parseMentions(text, members);
  if (hit === null) return everyone;
  if (hit.length) return hit;
  if (mode === 'quiet') return everyone.includes(leadId) ? [leadId] : everyone.slice(0, 1);
  if (mode === 'mentions') return [];
  if (mode === 'lead' && members.length > 1 && everyone.includes(leadId)) return [leadId];
  return everyone;
}

export const isPass = (reply: string | null | undefined) => {
  const t = (reply ?? '').trim();
  return !t || /^(PASS|NO_REPLY)[.!]?$/i.test(t);
};

const clipText = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();
const nameFor = (members: RoomMember[]) => (id: string) => (id === YOU ? 'You' : members.find((m) => m.id === id)?.name ?? id);
const NOTES_CHARS = 3000;
const PINNED_MAX = 10;
const PINNED_ITEM_CHARS = 400;

/** The thread as one agent reads it: a little earlier context, then Zach's message, then the whole discussion since (newest kept when it is long). Queued Zach messages are not shown until they join. */
export function discussionBlock(messages: RoomMessage[], trigger: RoomMessage, nameOf: (id: string) => string): { context: string; discussion: string } {
  const real = messages.filter((m) => m.from !== 'system' && !m.queued);
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

/** The room's shared memory beyond the capped transcript: Zach's notes and the messages he pinned as decisions. */
export function sharedMemoryBlock(room: Pick<Room, 'notes' | 'messages'>, nameOf: (id: string) => string): string {
  const notes = (room.notes ?? '').trim();
  const pinned = room.messages.filter((m) => m.pinned && m.from !== 'system').slice(-PINNED_MAX);
  return [
    notes ? `Room notes (kept by Zach):\n${clipText(notes, NOTES_CHARS)}` : '',
    pinned.length ? `Pinned decisions:\n${pinned.map((m) => `- ${nameOf(m.from)}: ${clipText(oneLine(m.text), PINNED_ITEM_CHARS)}`).join('\n')}` : '',
  ].filter(Boolean).join('\n\n');
}

interface PromptCtx { room: Room; members: RoomMember[]; agent: RoomMember; lead: RoomMember; trigger: RoomMessage; round: number; directed: boolean; followUp?: boolean }

/** Zach has posted again since the message that started this run (and it has joined the discussion). */
export const hasFollowUp = (messages: RoomMessage[], trigger: RoomMessage) => {
  const at = messages.findIndex((m) => m.id === trigger.id);
  return at >= 0 && messages.slice(at + 1).some((m) => m.from === YOU && !m.queued);
};

function promptHead(c: PromptCtx): string {
  const roster = ['You (Zach)', ...c.members.map((m) => `${m.name} (@${m.id})`)].join(', ');
  const lead = c.directed ? '' : ` Lead: ${c.lead.name} (@${c.lead.id}).`;
  const nameOf = nameFor(c.members);
  const { context, discussion } = discussionBlock(c.room.messages, c.trigger, nameOf);
  return [
    `[Agent OS group room "${c.room.name}". You are ${c.agent.name} (@${c.agent.id}). Members: ${roster}.${lead}]`,
    sharedMemoryBlock(c.room, nameOf),
    context ? `Earlier in the room:\n${context}` : '',
    `Zach's message:\n${c.trigger.text}\n\nDiscussion so far:\n${discussion}`,
  ].filter(Boolean).join('\n\n');
}
const REPLY_RULE = `Reply only if you were asked a direct question, were given an action, have new information, or disagree with something that matters. Otherwise reply exactly ${PASS_TOKEN}. Acknowledgements, thanks, agreement and restating what was said are all ${PASS_TOKEN}. Being cc'd, told FYI or told no reply is needed is ${PASS_TOKEN}. If you were told not to do something or to stand down, reply ${PASS_TOKEN} unless you actually disagree.`;
const TALK = `Write only your own reply, as one message in a group chat: short and conversational, no headings. Hand a point to someone with @id.`;

/** What a member (or the lead) is asked each round. Round 1 is the first reaction; later rounds are a reply-or-PASS check against the whole discussion. */
export function memberPrompt(c: PromptCtx): string {
  const isLead = !c.directed && c.agent.id === c.lead.id && c.members.length > 1;
  const follow = c.followUp ? ` Zach has posted again in the discussion (the "You:" lines): answer his latest message if it is for you or for the room.` : '';
  const body = c.round === 1
    ? `It is round 1. The others are answering at the same time and have not seen your reply yet. ${REPLY_RULE}`
    : `It is round ${c.round}. You have now seen what everyone said.${follow} ${REPLY_RULE} The discussion ends when everyone passes in the same round.`;
  const lead = isLead
    ? ` You are the lead: you moderate this discussion, as a member who also takes part. Keep it moving: address members with @id when someone should dig in, point out where two members disagree, ask for what is missing. You do not conclude the discussion; when there is nothing left to steer, reply exactly ${PASS_TOKEN}. If Zach asks for a summary, write it as a normal message.`
    : '';
  return [promptHead(c), `${body}${lead}`, TALK].join('\n\n');
}

const MODE_RULE: Record<ResponderMode, string> = {
  quiet: 'Only members Zach @mentions answer; when he mentions nobody, only the lead answers. One reply per round: the room waits for Zach to press Continue before anyone speaks again.',
  everyone: 'Every member answers and the discussion runs in rounds until everyone passes.',
  mentions: 'Only members Zach @mentions answer.',
  lead: 'The lead answers first; others join when @mentioned or handed a point.',
};

export function contextNote(c: { room: Pick<Room, 'id' | 'name' | 'purpose' | 'captain'> & Partial<Pick<Room, 'responderMode'>>; members: RoomMember[]; files: string[] }): string {
  const lead = c.members.find((m) => m.id === c.room.captain);
  const purpose = (c.room.purpose ?? '').trim() || c.room.name;
  return [
    `[Agent OS room context: read once, then answer the message below]`,
    `Room: "${c.room.name}" (${c.room.id}). Purpose: ${clipText(oneLine(purpose), MAX_PURPOSE_CHARS)}`,
    `Room members: Zach, ${c.members.map((m) => `${m.name} (@${m.id})`).join(', ')}.${lead ? ` The lead is ${lead.name} (@${lead.id}).` : ''}`,
    `How it works: ${MODE_RULE[c.room.responderMode ?? DEFAULT_RESPONDER_MODE]} This session is your seat in the room, separate from your main chat.`,
    c.files.length ? `Relevant files (read only what you need):\n${c.files.map((f) => `- ${f}`).join('\n')}` : '',
  ].filter(Boolean).join('\n');
}

// ---- safety: repeats and rings (a soft pause, never a stop)

const wordSet = (t: string) => new Set(t.toLowerCase().match(/[\p{L}\p{N}_@'-]+/gu) ?? []);
const norm = (t: string) => t.toLowerCase().replace(/\s+/g, ' ').trim();
/** 1 for identical text, else the word-set overlap (Jaccard). Very short texts only match when identical. */
export function similarity(a: string, b: string): number {
  if (norm(a) === norm(b)) return 1;
  const x = wordSet(a), y = wordSet(b);
  if (x.size < 4 || y.size < 4) return 0;
  let both = 0;
  for (const w of x) if (y.has(w)) both++;
  return both / (x.size + y.size - both);
}
export interface LoopHit { kind: 'repeat' | 'ring'; agents: string[] }
const REPEAT_SIM = 0.9;
const RING_SIM = 0.7;
const RING_CYCLES = 3;
/**
 * Bot posts since Zach last spoke, in order. `repeat`: a member (among posts from `fromIndex` on) says what it already said. `ring`: the last 3 laps of an A→B→C→A cycle,
 * each post close to the one a lap earlier. Two members legitimately going back and forth with new content is not a ring.
 */
export function detectLoop(posts: ReadonlyArray<{ from: string; text: string }>, fromIndex = 0): LoopHit | null {
  for (let i = Math.max(0, fromIndex); i < posts.length; i++) {
    for (let j = 0; j < i; j++) if (posts[j].from === posts[i].from && similarity(posts[j].text, posts[i].text) >= REPEAT_SIM) return { kind: 'repeat', agents: [posts[i].from] };
  }
  for (let period = 2; period <= 6; period++) {
    const n = period * RING_CYCLES;
    if (posts.length < n) continue;
    const tail = posts.slice(-n);
    if (new Set(tail.slice(-period).map((p) => p.from)).size < 2) continue;
    if (tail.every((p, k) => k < period || (p.from === tail[k - period].from && similarity(p.text, tail[k - period].text) >= RING_SIM))) return { kind: 'ring', agents: tail.slice(-period).map((p) => p.from) };
  }
  return null;
}

// ---- hand-offs: "A → B" when a reply @mentions members

export interface Handoff { from: string; to: string[]; /** 1 for a first hand-off after Zach spoke, 2 when the member handed it on after being handed one, ... */ hop: number }
/** Hand-offs per message id. Zach speaking resets the chain. */
export function handoffsOf(messages: ReadonlyArray<RoomMessage>, members: RoomMember[]): Map<string, Handoff> {
  const out = new Map<string, Handoff>();
  let pending = new Map<string, number>(); // member -> hop of the latest hand-off to it
  for (const m of messages) {
    if (m.from === 'system' || m.queued) continue;
    if (m.from === YOU) { pending = new Map(); continue; }
    const incoming = pending.get(m.from) ?? 0;
    pending.delete(m.from);
    const to = handedMentions(m.text, members.filter((x) => x.id !== m.from));
    if (!to.length) continue;
    const hop = incoming + 1;
    for (const t of to) pending.set(t, Math.max(pending.get(t) ?? 0, hop));
    out.set(m.id, { from: m.from, to, hop });
  }
  return out;
}

// ---- the optional speak filter (#9): one cheap model call decides who has something to add in a later round

export function judgePrompt(c: { room: Pick<Room, 'name' | 'notes' | 'messages'>; members: RoomMember[]; candidates: RoomMember[]; trigger: RoomMessage; round: number }): string {
  const nameOf = nameFor(c.members);
  const { discussion } = discussionBlock(c.room.messages, c.trigger, nameOf);
  return [
    `You are a quiet moderator for a group chat named "${c.room.name}". Decide which members have something NEW to add after this round. Do not write the replies.`,
    `Zach's message:\n${c.trigger.text}\n\nDiscussion so far (latest last):\n${discussion}`,
    `Candidates: ${c.candidates.map((m) => `${m.name} (@${m.id})`).join(', ')}.`,
    `A candidate should speak when they can add a new point, disagree, answer an open question, or were asked something. They should stay silent when they would only repeat or agree. When unsure, include them.`,
    `Reply with JSON only, no other text: {"speak":["id", ...]} using the ids above (an empty list when nobody has anything to add). This is round ${c.round}.`,
  ].join('\n\n');
}
/** The ids the judge picked, or null when its reply cannot be read (the caller then lets everyone speak). */
export function parseJudge(reply: string | null | undefined, candidates: string[]): string[] | null {
  const m = /\{[\s\S]*\}/.exec(reply ?? '');
  if (!m) return null;
  try {
    const speak = (JSON.parse(m[0]) as { speak?: unknown }).speak;
    if (!Array.isArray(speak) || speak.some((x) => typeof x !== 'string')) return null;
    const keys = new Map(candidates.map((id) => [slug(id), id]));
    return (speak as string[]).map((x) => keys.get(slug(x.replace(/^@/, '')))).filter((x): x is string => !!x);
  } catch { return null; }
}

// ---- failures: transient ones are retried, terminal ones are not, none of them is a PASS

export type FailureKind = 'transient' | 'terminal' | 'unknown';
export interface Failure { kind: FailureKind; /** short human label, e.g. "rate limit" */ label: string }
/**
 * Billing and auth are checked first: a 429 "insufficient_quota" is a billing problem, not a throttle. Only clear provider-side rejections (rate limit, overload) are transient:
 * a timeout or a dropped connection may follow an accepted send, so retrying could run a turn twice (agents can call tools with side effects). Those stay `unknown` and are not retried.
 */
export function classifyFailure(e: unknown): Failure {
  const o = (e && typeof e === 'object' ? e : {}) as { message?: unknown; status?: unknown; code?: unknown };
  const t = `${o.status ?? ''} ${o.code ?? ''} ${typeof e === 'string' ? e : o.message ?? ''}`;
  if (/\b402\b|billing|payment required|credit balance|out of credits|insufficient[_ -]?(quota|funds|credits?)|quota (exceeded|exhausted)|usage limit/i.test(t)) return { kind: 'terminal', label: 'billing' };
  if (/\b40[13]\b|unauthori[sz]ed|forbidden|authenticat|invalid[_ -]?(api[_ -]?)?(key|token)|permission denied|token (expired|revoked)/i.test(t)) return { kind: 'terminal', label: 'auth' };
  if (/overloaded|\b529\b|\b503\b|service unavailable/i.test(t)) return { kind: 'transient', label: 'overloaded' };
  if (/\b429\b|rate[_ -]?limit|too many requests|throttl/i.test(t)) return { kind: 'transient', label: 'rate limit' };
  return { kind: 'unknown', label: '' };
}
export const MAX_TURN_RETRIES = 2;
const RETRY_BASE_MS = 1000;
const RETRY_CAP_MS = 8000;
/** Exponential backoff (1s, 2s, ... capped) with +-25% jitter, so members that hit the same limit do not retry in lockstep. */
export const retryDelayMs = (attempt: number, rand: () => number = Math.random) => Math.round(Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** attempt) * (0.75 + rand() * 0.5));
export interface RunOptions { maxRetries?: number; retryDelayMs?: (attempt: number) => number }
const sleepUnlessAborted = (ms: number, signal: AbortSignal) => new Promise<void>((resolve) => {
  const done = () => { clearTimeout(t); signal.removeEventListener('abort', done); resolve(); };
  const t = setTimeout(done, ms);
  signal.addEventListener('abort', done, { once: true });
});

// ---- the run

export type TurnResult = string | null | { text: string | null; usage?: TurnUsage };
export interface TurnProgress { /** The tool the agent is using right now, when the Gateway shows it. */ tool?: string }
export interface RoomTransport {
  /** One agent turn on that agent's dedicated room session. Resolve with the reply text (or `{ text, usage }`), or null when it passed / produced nothing. */
  turn(agentId: string, prompt: string, signal: AbortSignal, progress?: (p: TurnProgress) => void): Promise<TurnResult>;
  /** Best effort: cancel that agent's in-flight run on the Gateway (Stop). Never throws. */
  abort?(agentId: string): void;
  /** Optional small-model call for the speak filter: the raw reply text, or null when unavailable. Throwing or null means everyone speaks. */
  judge?(prompt: string, signal: AbortSignal): Promise<string | null>;
}
export interface RunHooks {
  append(msg: Omit<RoomMessage, 'id' | 'ts'>): RoomMessage;
  state(patch: Partial<RoomRunState>): void;
  /** Soft pause: resolves when Zach clicks Continue or writes; settles on Stop (the signal). Absent: the run never pauses. */
  waitForContinue?(signal: AbortSignal): Promise<void>;
  /** Zach messages written while this run was active, oldest first. Taking them marks them delivered. */
  takeQueued?(): RoomMessage[];
  /** True once "End now" was asked: in-flight turns finish, no new turn starts. */
  ended?(): boolean;
  /** One finished turn's usage, for the room's running total. */
  usage?(agentId: string, usage: TurnUsage): void;
}
const normalizeTurn = (raw: TurnResult, prompt: string): { text: string | null; usage: TurnUsage } => {
  const text = typeof raw === 'string' || raw === null ? raw : raw.text;
  const given = raw && typeof raw === 'object' ? raw.usage : undefined;
  return { text, usage: given ?? estimateUsage(prompt, text) };
};

/** One Zach message -> an open discussion. Never throws for an agent failure: it becomes a system note (after retries, for transient errors) and is NOT a pass. */
export async function runDiscussion(room: Room, members: RoomMember[], trigger: RoomMessage, transport: RoomTransport, hooks: RunHooks, signal: AbortSignal, opts: RunOptions = {}): Promise<RoomRunState['stopReason']> {
  if (!members.length) return 'complete';
  const lead = members.find((m) => m.id === room.captain) ?? members[0];
  const byId = new Map(members.map((m) => [m.id, m]));
  const order = members.map((m) => m.id);
  const mode = room.responderMode ?? DEFAULT_RESPONDER_MODE;
  const quiet = mode === 'quiet';
  const gating = room.mentionGating !== false;
  /** A message that names members, or (lead-first mode) names nobody: only those answer it, and hand-offs pull others in. */
  const isDirected = (text: string) => {
    if (quiet) return true;
    if (members.length < 2 && mode !== 'mentions') return false;
    const hit = gating || mode === 'mentions' ? parseMentions(text, members) : null;
    return !!hit?.length || (gating && mode === 'lead' && members.length > 1 && hit?.length === 0);
  };
  let directed = isDirected(trigger.text);
  let open = !directed && members.length > 1;
  let targets = selectResponders(trigger.text, members, gating, mode, lead.id);
  let turnsUsed = 0;
  let usage = emptyUsage();
  let lastSpeaker: string | undefined;
  let filtered = 0;
  const active = new Set<string>();
  const activity = new Map<string, AgentActivity>();
  const waiting = new Map<string, AgentActivity>();
  const publish = () => hooks.state({ turnsUsed, active: [...active], activity: [...activity.values(), ...waiting.values()], usage: { ...usage }, ...(lastSpeaker ? { lastSpeaker } : {}), filtered });

  // Soft-pause bookkeeping: counted since Zach last spoke or last clicked Continue.
  let sincePosts = 0;
  let sinceTokens = 0;
  let runPosts: Array<{ from: string; text: string }> = [];
  let loopFrom = 0;
  let prevRoundPosts: Array<{ id: string; text: string }> = [];
  let freshHuman = false; // the round right after a queued Zach message joined: everyone targeted answers it, the filter stays out of it
  const ended = () => hooks.ended?.() === true;
  const maxRetries = opts.maxRetries ?? MAX_TURN_RETRIES;
  const backoff = opts.retryDelayMs ?? ((attempt: number) => retryDelayMs(attempt));
  let failures = 0; // failed turns so far in this run
  const benched = new Set<string>(); // members whose turn failed terminally (auth/billing): not asked again in this run

  /** One turn. A transient failure is retried; any failure becomes a system note and `ok: false` (never a pass); Stop propagates as 'cancelled'. */
  async function ask(agentId: string, prompt: string, round: number): Promise<{ ok: boolean; text: string | null }> {
    const agent = byId.get(agentId)!;
    turnsUsed++; active.add(agentId); waiting.delete(agentId);
    activity.set(agentId, { id: agentId, state: 'thinking', since: Date.now() });
    publish();
    const onAbort = () => transport.abort?.(agentId); // Stop reaches the Gateway run, not just this loop
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          const turn = normalizeTurn(await transport.turn(agentId, prompt, signal, (p) => {
            const a = activity.get(agentId);
            if (!a) return;
            const tool = p.tool?.trim();
            if (tool && !(a.state === 'tool' && a.tool === tool)) { a.state = 'tool'; a.tool = tool.slice(0, 60); a.since = Date.now(); publish(); }
            else if (!tool && a.state === 'tool') { a.state = 'thinking'; delete a.tool; a.since = Date.now(); publish(); }
          }), prompt);
          usage = addUsage(usage, turn.usage);
          sinceTokens += totalTokens(turn.usage);
          lastSpeaker = agentId;
          hooks.usage?.(agentId, turn.usage);
          return { ok: true, text: turn.text };
        } catch (e) {
          if (signal.aborted) throw new Error('cancelled');
          const f = classifyFailure(e);
          if (f.kind === 'transient' && attempt < maxRetries) {
            await sleepUnlessAborted(backoff(attempt), signal);
            if (signal.aborted) throw new Error('cancelled');
            continue;
          }
          failures++;
          const why = clipText(oneLine((e as Error)?.message ?? String(e)), 300);
          if (f.kind === 'terminal') benched.add(agentId);
          hooks.append({
            from: 'system', round,
            text: f.kind === 'unknown' ? `${agent.name} did not answer: ${why}`
              : f.kind === 'terminal' ? `${agent.name} could not answer (${f.label} error, not retried): ${why}`
              : `${agent.name} could not answer (${f.label}, still failing after ${attempt} ${attempt === 1 ? 'retry' : 'retries'}): ${why}`,
          });
          return { ok: false, text: null };
        }
      }
    } finally {
      signal.removeEventListener('abort', onAbort); active.delete(agentId); activity.delete(agentId);
      const w = waiting.get(lead.id);
      if (w?.waitingOn) w.waitingOn = w.waitingOn.filter((id) => id !== agentId);
      publish();
    }
  }
  const ctxFor = (agentId: string, round: number): PromptCtx => ({ room, members, agent: byId.get(agentId)!, lead, trigger, round, directed, followUp: hasFollowUp(room.messages, trigger) });
  const recordPost = (from: string, text: string) => { sincePosts++; runPosts.push({ from, text }); hooks.state({ posts: sincePosts }); };

  /** The speak filter: drop members the small model says have nothing to add. Members who were handed a point always answer; any trouble lets everyone speak. */
  async function narrow(ids: string[], round: number): Promise<string[]> {
    if (!room.speakFilter || !transport.judge || round < 2 || freshHuman) return ids;
    const pulled = new Set<string>();
    for (const p of prevRoundPosts) for (const m of handedMentions(p.text, members.filter((x) => x.id !== p.id))) pulled.add(m);
    const cands = ids.filter((id) => !pulled.has(id));
    if (!cands.length) return ids;
    let reply: string | null = null;
    try { reply = await transport.judge(judgePrompt({ room, members, candidates: cands.map((id) => byId.get(id)!), trigger, round }), signal); } catch { if (signal.aborted) throw new Error('cancelled'); }
    const verdict = parseJudge(reply, cands);
    if (!verdict) return ids;
    const keep = ids.filter((id) => pulled.has(id) || verdict.includes(id));
    filtered += ids.length - keep.length;
    publish();
    return keep;
  }

  function pauseReason(): PauseInfo | null {
    const names = (ids: string[]) => ids.map((id) => byId.get(id)?.name ?? id).join(', ');
    const loop = detectLoop(runPosts, loopFrom);
    loopFrom = runPosts.length;
    if (loop?.kind === 'repeat') return { reason: 'repeat', detail: `${names(loop.agents)} repeated an earlier reply`, at: Date.now() };
    if (loop?.kind === 'ring') return { reason: 'ring', detail: `${names(loop.agents)} are passing the same point round in a circle`, at: Date.now() };
    if (room.pauseAfterPosts > 0 && sincePosts >= room.pauseAfterPosts) return { reason: 'posts', detail: `${sincePosts} replies since you last wrote`, at: Date.now() };
    if (room.pauseAfterTokens > 0 && sinceTokens >= room.pauseAfterTokens) return { reason: 'tokens', detail: `${sinceTokens.toLocaleString('en-US')} tokens since you last wrote`, at: Date.now() };
    return null;
  }

  /** Queued Zach messages join: they reset the pause counters and decide who answers next. */
  function join(msgs: RoomMessage[]) {
    sincePosts = 0; sinceTokens = 0; runPosts = []; loopFrom = 0; hooks.state({ posts: 0 });
    const next = new Set(msgs.flatMap((m) => selectResponders(m.text, members, gating, mode, lead.id)));
    if (!next.size) return; // addresses nobody (mentions-only room): it is context for the discussion already under way
    targets = order.filter((id) => next.has(id));
    directed = msgs.every((m) => isDirected(m.text));
    open = !directed && members.length > 1;
    freshHuman = true;
  }

  try {
    for (let round = 1; ; round++) {
      hooks.state({ round });
      if (signal.aborted) return 'cancelled';
      if (ended()) return 'ended';
      if (!targets.length) return 'complete'; // mentions-only room and nobody was addressed
      targets = targets.filter((id) => !benched.has(id));
      if (!targets.length) return 'failed'; // everyone left to ask failed terminally (auth/billing) earlier in this run
      const failuresBefore = failures;
      targets = await narrow(targets, round);
      const others = targets.filter((id) => !(open && id === lead.id));
      const leadTurn = open && targets.includes(lead.id);
      if (leadTurn && others.length) { waiting.set(lead.id, { id: lead.id, state: 'waiting', since: Date.now(), waitingOn: [...others] }); publish(); }
      // Everyone but the lead answers at once; each bubble lands as soon as that agent finishes. The lead then answers having read them.
      const posted: Array<{ id: string; text: string }> = [];
      const passed: string[] = [];
      await Promise.all(others.map(async (id) => {
        const reply = await ask(id, memberPrompt(ctxFor(id, round)), round);
        if (!reply.ok) return;
        if (isPass(reply.text)) { passed.push(id); return; }
        const text = reply.text!.trim();
        hooks.append({ from: id, text, round });
        recordPost(id, text);
        posted.push({ id, text });
      }));
      if (signal.aborted) return 'cancelled';
      if (leadTurn && !ended()) {
        const reply = await ask(lead.id, memberPrompt(ctxFor(lead.id, round)), round);
        if (reply.ok && isPass(reply.text)) passed.push(lead.id);
        else if (reply.ok) {
          const text = reply.text!.trim();
          hooks.append({ from: lead.id, text, round });
          recordPost(lead.id, text);
          posted.push({ id: lead.id, text });
        }
      }
      waiting.delete(lead.id); publish();
      if (signal.aborted) return 'cancelled';
      if (passed.length) {
        const ids = order.filter((id) => passed.includes(id));
        hooks.append({ from: 'system', text: `${ids.map((id) => byId.get(id)!.name).join(', ')} passed`, round, passed: ids });
      }
      prevRoundPosts = posted; freshHuman = false;
      if (ended()) return 'ended';

      // Zach wrote while this round ran: his message joins now, before any end or pause decision.
      const queued = hooks.takeQueued?.() ?? [];
      if (queued.length) { join(queued); continue; }

      // Soft pause (never a stop): hold the run until Zach clicks Continue, writes, or Stops.
      const why = posted.length && !quiet ? pauseReason() : null;
      if (why && hooks.waitForContinue) {
        hooks.state({ status: 'paused', pause: why });
        await hooks.waitForContinue(signal);
        if (signal.aborted) return 'cancelled';
        hooks.state({ status: 'running', pause: undefined });
        if (ended()) return 'ended';
        sincePosts = 0; sinceTokens = 0; hooks.state({ posts: 0 });
        if (why.reason === 'repeat' || why.reason === 'ring') { runPosts = []; loopFrom = 0; }
        const late = hooks.takeQueued?.() ?? [];
        if (late.length) { join(late); continue; }
      }

      const troubled = failures > failuresBefore || benched.size > 0; // a turn failed this round, or a member was already benched: not a clean ending
      if (quiet && posted.length) {
        const handed = new Set<string>();
        for (const p of posted) for (const m of handedMentions(p.text, members.filter((x) => x.id !== p.id))) handed.add(m);
        if (!hooks.waitForContinue) return troubled ? 'failed' : 'complete';
        const names = (ids: Iterable<string>) => [...ids].map((id) => byId.get(id)?.name ?? id).join(', ');
        hooks.state({ status: 'paused', pause: { reason: 'round', detail: handed.size ? `${names(posted.map((p) => p.id))} replied and handed a point to ${names(handed)}` : `${names(posted.map((p) => p.id))} replied`, at: Date.now() } });
        await hooks.waitForContinue(signal);
        if (signal.aborted) return 'cancelled';
        hooks.state({ status: 'running', pause: undefined });
        if (ended()) return 'ended';
        sincePosts = 0; sinceTokens = 0; hooks.state({ posts: 0 });
        const late = hooks.takeQueued?.() ?? [];
        if (late.length) { join(late); continue; }
        targets = order.filter((id) => (handed.size ? handed : new Set(posted.map((p) => p.id))).has(id));
        continue;
      }
      if (!posted.length) {
        if (!troubled) return 'passed'; // a whole round of PASS: the discussion is over
        hooks.append({ from: 'system', text: `Not treated as everyone passing: ${failures} turn${failures === 1 ? '' : 's'} failed in this discussion (see above). Fix the cause and write again.`, round });
        return 'failed';
      }
      if (directed) {
        const mentioned = new Set<string>();
        for (const p of posted) for (const m of handedMentions(p.text, members.filter((x) => x.id !== p.id))) mentioned.add(m);
        if (!mentioned.size) return troubled ? 'failed' : 'complete'; // answered, nobody was handed anything
        const next = new Set([...posted.map((p) => p.id), ...mentioned]);
        targets = order.filter((id) => next.has(id));
        continue;
      }
      if (!open) return troubled ? 'failed' : 'complete'; // a one-member room: one reply
      targets = order;
    }
  } catch (e) {
    if (signal.aborted) return 'cancelled';
    throw e;
  }
}
