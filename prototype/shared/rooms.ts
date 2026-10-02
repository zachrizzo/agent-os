// Group rooms: one thread, several agents. Semantics mirror OpenClaw broadcast groups (channels/broadcast-groups.md):
//   - @mention gating: explicit @mentions pick the round-1 responders; no match (or @all) picks everyone;
//   - maxRounds 1-4 (default 1) including the first round; maxTurns caps agent runs started per Zach message;
//   - a follow-up round runs only for members that replied or were @mentioned in the previous round, and "NO_REPLY" passes.
// Pure logic, no I/O: the server injects a transport (real Gateway sessions or a fake) so the loop is unit-testable.

export const PASS_TOKEN = 'NO_REPLY';
export const MAX_MEMBERS = 16;
export const MAX_ROOMS = 50;
export const MAX_ROOM_NAME = 60;
export const MAX_MESSAGE_CHARS = 4000;
export const MAX_STORED_MESSAGES = 400;
export const TRANSCRIPT_MESSAGES = 12;
const TRANSCRIPT_ITEM_CHARS = 1200;
const TRANSCRIPT_TOTAL_CHARS = 8000;
export const YOU = 'you';

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
export interface RoomSettings { maxRounds: number; maxTurns: number; mentionGating: boolean }
export interface Room extends RoomSettings {
  id: string;
  name: string;
  members: string[]; // agent ids, join order
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
  maxTurns: number;
  maxRounds: number;
  current?: string; // agent id with a turn in flight
  stopReason?: 'maxRounds' | 'maxTurns' | 'passed' | 'cancelled' | 'complete';
}

export const clampInt = (v: unknown, min: number, max: number, dflt: number) => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.trunc(n))) : dflt;
};

/** Defaults: 1 round, maxTurns = member count (as in OpenClaw broadcast groups), mention gating on. */
export function normalizeSettings(raw: Partial<RoomSettings> | undefined, memberCount: number): RoomSettings {
  const maxRounds = clampInt(raw?.maxRounds, 1, 4, 1);
  const maxTurns = clampInt(raw?.maxTurns, 1, 32, Math.max(1, Math.min(32, memberCount)));
  return { maxRounds, maxTurns, mentionGating: raw?.mentionGating !== false };
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');

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
  return !t || new RegExp(`^${PASS_TOKEN}[.!]?$`, 'i').test(t);
};

const clipText = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

export function transcriptBlock(messages: RoomMessage[], nameOf: (id: string) => string): string {
  const lines: string[] = [];
  let total = 0;
  for (const m of messages.filter((x) => x.from !== 'system').slice(-TRANSCRIPT_MESSAGES).reverse()) {
    const line = `${nameOf(m.from)}: ${clipText(m.text.replace(/\s+/g, ' ').trim(), TRANSCRIPT_ITEM_CHARS)}`;
    if (total + line.length > TRANSCRIPT_TOTAL_CHARS) break;
    total += line.length;
    lines.unshift(line);
  }
  return lines.length ? lines.join('\n') : '(no earlier messages)';
}

interface PromptCtx { room: Room; members: RoomMember[]; agent: RoomMember; history: RoomMessage[] }
const nameFor = (members: RoomMember[]) => (id: string) => (id === YOU ? 'You' : members.find((m) => m.id === id)?.name ?? id);

function header({ room, members, agent }: PromptCtx) {
  const roster = ['You (Zach)', ...members.map((m) => `${m.name} (@${m.id})`)].join(', ');
  return `[Agent OS group room "${room.name}". You are ${agent.name} (@${agent.id}). Members: ${roster}.]`;
}
const FOOTER = `Write only your own reply to the room. Use @id to hand a point to a specific member. If you have nothing new to add, reply exactly ${PASS_TOKEN}.`;

/** Round 1: the new message plus the recent room transcript, so each agent sees the others' replies. */
export function firstRoundPrompt(ctx: PromptCtx, text: string): string {
  const nm = nameFor(ctx.members);
  return [header(ctx), 'Recent room transcript:', transcriptBlock(ctx.history, nm), `New message from You:\n${text}`, FOOTER].join('\n\n');
}

/** Rounds 2+: an attributed digest of the previous round's replies, with the original ask for context. */
export function followUpPrompt(ctx: PromptCtx, original: string, round: number, digest: RoomMessage[]): string {
  const nm = nameFor(ctx.members);
  const lines = digest.filter((d) => d.from !== ctx.agent.id).map((d) => `${nm(d.from)}: ${clipText(d.text.replace(/\s+/g, ' ').trim(), TRANSCRIPT_ITEM_CHARS)}`);
  return [
    header(ctx), `Follow-up round ${round}. Original message from You:\n${original}`,
    `Replies from other members last round:\n${lines.join('\n') || '(none)'}`,
    `Reply only if you are adding something new; otherwise reply exactly ${PASS_TOKEN}.`, FOOTER,
  ].join('\n\n');
}

export interface RoomTransport {
  /** One agent turn on that agent's dedicated room session. Resolve with the reply text, or null when it passed / produced nothing. */
  turn(agentId: string, prompt: string, signal: AbortSignal): Promise<string | null>;
}
export interface RunHooks {
  append(msg: Omit<RoomMessage, 'id' | 'ts'>): RoomMessage;
  state(patch: Partial<RoomRunState>): void;
}

/** One Zach message -> bounded rounds of agent turns. Never throws for an agent failure: it becomes a system note and the turn is spent. */
export async function runRound(room: Room, members: RoomMember[], trigger: RoomMessage, transport: RoomTransport, hooks: RunHooks, signal: AbortSignal): Promise<RoomRunState['stopReason']> {
  const order = members.map((m) => m.id);
  const byId = new Map(members.map((m) => [m.id, m]));
  let turnsUsed = 0;
  let targets = selectResponders(trigger.text, members, room.mentionGating);
  let digest: RoomMessage[] = [];
  for (let round = 1; round <= room.maxRounds; round++) {
    const replies: RoomMessage[] = [];
    const mentioned = new Set<string>();
    hooks.state({ round });
    for (const id of targets) {
      if (signal.aborted) return 'cancelled';
      if (turnsUsed >= room.maxTurns) { hooks.append({ from: 'system', text: `Stopped: turn cap reached (${room.maxTurns} turns for this message).`, round }); return 'maxTurns'; }
      const agent = byId.get(id)!;
      turnsUsed++;
      hooks.state({ turnsUsed, current: id });
      // Prompt history = the room as it stands, minus the triggering message (passed separately), so later agents see earlier replies.
      const ctx: PromptCtx = { room, members, agent, history: room.messages.filter((m) => m.id !== trigger.id) };
      const prompt = round === 1 ? firstRoundPrompt(ctx, trigger.text) : followUpPrompt(ctx, trigger.text, round, digest);
      let reply: string | null = null;
      try { reply = await transport.turn(id, prompt, signal); } catch (e) {
        if (signal.aborted) return 'cancelled';
        hooks.append({ from: 'system', text: `${agent.name} did not answer: ${(e as Error).message}`, round });
        continue;
      }
      if (isPass(reply)) continue;
      replies.push(hooks.append({ from: id, text: reply!.trim(), round }));
      for (const m of parseMentions(reply!, members.filter((x) => x.id !== id)) ?? []) mentioned.add(m);
    }
    hooks.state({ current: undefined });
    if (!replies.length) return round === 1 && !turnsUsed ? 'complete' : 'passed';
    const next = new Set([...replies.map((r) => r.from), ...mentioned]);
    targets = order.filter((id) => next.has(id));
    digest = replies;
    if (round === room.maxRounds) {
      if (!targets.length || room.maxRounds === 1) return 'complete'; // a single-round room has no follow-up to cut off
      hooks.append({ from: 'system', text: `Stopped: round cap reached (${room.maxRounds} rounds).`, round });
      return 'maxRounds';
    }
  }
  return 'complete';
}
