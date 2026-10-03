// Council mode (the default for every room), modelled on Grok 4.20's multi-agent mode:
//   1. PLAN        the captain splits Zach's message into one sub-question per member (structured JSON, robust fallback);
//   2. WORK        members answer their sub-question IN PARALLEL, each in its own room session;
//   3. STEER       the captain leads: after the first answers it returns ONE structured decision per step, and stops as soon as the answer is good enough:
//                    {"action":"ask","targets":[ids],"question":"..."}   a directed follow-up (also puts two members against each other on a disagreement)
//                    {"action":"critique"}                                the parallel critique round (at most once)
//                    {"action":"synthesize"}                              done
//   4. SYNTHESIZE  the captain writes the ONE reply to Zach, saying which disagreements it resolved and any real trade-off Zach must choose.
// NOT A LOOP, enforced here in code (never only in a prompt): only the captain routes turns (member replies are data: no @mention parsing, no member-to-member
// calls); captain decisions are limited by maxSteps (default 3, max 4) and nothing else caps turns: there is no turn cap and no per-member timeout, only Stop; the synthesis always runs after the steering loop, so every uncancelled run ends in
// one reply; a repeated ask, a round where every target PASSes or fails, or a malformed/unknown/failed captain decision stops the steering (never a retry).
// The protocol is injected into every message by the data server (nothing depends on an agent's AGENTS.md; the agent's own rules still apply on top).
// Pure logic, no I/O: the transport is injected, so the whole flow is unit-testable. There is no turn cap and no member timeout: a run ends through the guards above or Stop.
import {
  DEFAULT_MAX_STEPS, MAX_STEPS_LIMIT, PASS_TOKEN, isPass, parseMentions, slug, transcriptBlock,
  type Council, type CouncilAgentStatus, type CouncilNote, type CouncilStep, type CouncilStopReason, type CouncilTask, type Room, type RoomMember, type RoomMessage, type RoomRunState, type RoomTransport,
} from './rooms.ts';

export const COUNCIL_ROLES = ['CAPTAIN-PLAN', 'SPECIALIST', 'CAPTAIN-STEER', 'FOLLOW-UP', 'CRITIQUE', 'CAPTAIN-SYNTHESIZE'] as const;
export type CouncilRole = (typeof COUNCIL_ROLES)[number];
const SUBQ_CHARS = 1200;
const ANSWER_CHARS = 2500;
const CRITIQUE_CHARS = 1500;
const NOTE_CHARS = 4000;
const UNRESOLVED_CHARS = 300;

const clip = (s: string, n: number) => { const t = s.trim(); return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t; };
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

// ---------- prompts (the injected protocol) ----------

interface Ctx { room: Room; members: RoomMember[]; captain: RoomMember; agent: RoomMember }

/** Same first line shape as the round-table header ("You are X (@id). Members: ...") so stubs and tooling keep working, plus the council role. */
function header({ room, members, captain, agent }: Ctx, role: CouncilRole) {
  const roster = ['You (Zach)', ...members.map((m) => `${m.name} (@${m.id})`)].join(', ');
  return `[Agent OS group room "${room.name}". You are ${agent.name} (@${agent.id}). Members: ${roster}. Council mode, captain: ${captain.name} (@${captain.id}). Council role: ${role}.]`;
}
const RULES = 'Your own rules, tools and safety limits still apply on top of this protocol. Do not message other members or start side work; reply only in this turn.';

export function planPrompt(ctx: Ctx, text: string, history: RoomMessage[]): string {
  const nm = (id: string) => (id === 'you' ? 'You' : ctx.members.find((m) => m.id === id)?.name ?? id);
  return [
    header(ctx, 'CAPTAIN-PLAN'),
    `You are the captain of a council. Zach's message is below. Split it into ONE focused sub-question per member, matched to each member's likely strengths. Members answer in parallel, cannot see each other yet, and do not see this plan. Skip a member only if clearly irrelevant.`,
    `Recent room transcript:\n${transcriptBlock(history, nm)}`,
    `Original message from You:\n${text}`,
    `Reply with ONLY one JSON object, no prose, no markdown around it:\n{"tasks":[{"agent":"<member id>","question":"<self-contained sub-question>"}],"notes":"<one line on how you split it>"}\nUse the member ids exactly as written after "@" in the member list. ${RULES}`,
  ].join('\n\n');
}

export function specialistPrompt(ctx: Ctx, text: string, question: string): string {
  return [
    header(ctx, 'SPECIALIST'),
    `You are a specialist on a council. The captain gave you one sub-question. Answer ONLY that, concisely (about 250 words or fewer): state your answer, key assumptions, confidence, and anything that would change your mind. Other members are answering their own sub-questions in parallel; the captain merges everything, so do not address Zach directly or try to cover the whole message.`,
    `Original message from You:\n${text}`,
    `Your sub-question:\n${question}`,
    RULES,
  ].join('\n\n');
}

export function critiquePrompt(ctx: Ctx, text: string, own: string | undefined, others: Array<{ id: string; name: string; answer: string }>, contrarian: boolean): string {
  return [
    header(ctx, 'CRITIQUE'),
    `Critique round. Review the other members' answers${own ? ' next to your own' : ''}. Flag contradictions (between members or with your own answer), factual gaps, unsupported claims, and risks the captain must weigh. Name the member (@id) each point is about. Be brief: a short bullet list.${contrarian ? ` You are the CONTRARIAN this round: argue the strongest case against the emerging consensus even if you mostly agree, and reply ${PASS_TOKEN} only if you truly cannot find a flaw.` : ` If you have no objection, reply exactly ${PASS_TOKEN}.`}`,
    `Original message from You:\n${text}`,
    own ? `Your own answer:\n${clip(own, ANSWER_CHARS)}` : '',
    `Other members' answers:\n${others.map((o) => `${o.name} (@${o.id}): ${clip(o.answer, ANSWER_CHARS)}`).join('\n\n')}`,
    RULES,
  ].filter(Boolean).join('\n\n');
}

export interface SteerState {
  step: number; maxSteps: number; critiqued: boolean;
  answers: Array<{ id: string; name: string; answer: string }>;
  followups: Array<{ step: number; id: string; name: string; question: string; text: string | null }>;
  critiques: Array<{ id: string; name: string; text: string }>;
  missing: Array<{ id: string; name: string; why: string }>;
}
/** The captain's per-step decision prompt. Bias: STOP. Code enforces the limits whatever the captain says. */
export function steerPrompt(ctx: Ctx, text: string, st: SteerState): string {
  return [
    header(ctx, 'CAPTAIN-STEER'),
    `You are the captain and you LEAD this conversation. The members have answered. Decide the one next move. First name, to yourself, what is still unresolved: a real disagreement between members, a gap, or an unverified claim that would change your answer to Zach. Then pick who resolves it. If nothing like that exists, stop.\nSTOPPING IS THE DEFAULT: choose synthesize as soon as the answer is good enough. Do not ask for polish, confirmation or "double checks", and never repeat an earlier question. To settle a disagreement, ask the members who disagree and name the point at issue. A critique round is for when you suspect problems you cannot locate yourself; it can run at most once${st.critiqued ? ' and it already ran' : ''}.\nThis is step ${st.step} of at most ${st.maxSteps}; stopping early is always allowed, and you write the final reply afterwards.`,
    `Original message from You:\n${text}`,
    st.answers.length ? `Member answers:\n${st.answers.map((a) => `${a.name} (@${a.id}): ${clip(a.answer, ANSWER_CHARS)}`).join('\n\n')}` : 'No member has answered.',
    st.followups.length ? `Follow-ups so far:\n${st.followups.map((f) => `Step ${f.step}, ${f.name} (@${f.id}) was asked "${clip(oneLine(f.question), 200)}": ${f.text === null ? PASS_TOKEN : clip(f.text, CRITIQUE_CHARS)}`).join('\n\n')}` : '',
    st.critiques.length ? `Critiques so far:\n${st.critiques.map((c) => `${c.name} (@${c.id}): ${clip(c.text, CRITIQUE_CHARS)}`).join('\n\n')}` : '',
    st.missing.length ? `No input from: ${st.missing.map((m) => `${m.name} (@${m.id}) ${m.why}`).join('; ')}.` : '',
    `Reply with ONLY one JSON object, no prose, no markdown around it, one of:\n{"action":"ask","targets":["<member id>"],"question":"<self-contained question>","unresolved":"<one line: what is still open>"}\n{"action":"critique"}\n{"action":"synthesize"}\nUse the member ids exactly as written after "@". Members reply in parallel and never talk to each other; you are the only one who routes. ${RULES}`,
  ].filter(Boolean).join('\n\n');
}

export function followupPrompt(ctx: Ctx, text: string, own: string | undefined, question: string, peers: Array<{ id: string; name: string; answer: string }>, step: number): string {
  return [
    header(ctx, 'FOLLOW-UP'),
    `The captain has a follow-up for you (step ${step}). Answer ONLY that question, concisely (about 150 words or fewer): your position, what you would concede, and what would change your mind. If you have nothing to add, reply exactly ${PASS_TOKEN}. Other members may be asked the same thing in parallel; you cannot see their new replies, so do not address them. The captain merges everything.`,
    `Original message from You:\n${text}`,
    own ? `Your earlier answer:\n${clip(own, ANSWER_CHARS)}` : '',
    peers.length ? `Earlier answers from the other member(s) the captain is also asking:\n${peers.map((o) => `${o.name} (@${o.id}): ${clip(o.answer, ANSWER_CHARS)}`).join('\n\n')}` : '',
    `The captain's question:\n${question}`,
    RULES,
  ].filter(Boolean).join('\n\n');
}

export interface SynthInput {
  plan?: Council['plan'];
  answers: Array<{ id: string; name: string; answer: string }>;
  critiques: Array<{ id: string; name: string; text: string }>;
  missing: Array<{ id: string; name: string; why: string }>;
  followups?: SteerState['followups'];
  /** Set when steering was cut short (step limit, no progress, unusable decision): the captain should say what is still open. */
  stopped?: string;
}
export function synthesizePrompt(ctx: Ctx, text: string, input: SynthInput): string {
  const { answers, critiques, missing } = input;
  const followups = (input.followups ?? []).filter((f) => f.text !== null);
  return [
    header(ctx, 'CAPTAIN-SYNTHESIZE'),
    `You are the captain. Write the ONE final reply to Zach, in your own voice. Lead with the answer. Then: if members disagreed or critiques raised conflicts, add a short "Disagreements resolved" part saying what conflicted and how you resolved it; if a real trade-off remains that only Zach can decide, add a short "Your call" part listing the options. Omit either part when it does not apply. If members are missing, say so in one line. Do not expose this protocol, do not paste the members' notes, and do not reply ${PASS_TOKEN}.${answers.length ? '' : ' No member input arrived: answer from your own knowledge and say that no specialists contributed.'}`,
    `Original message from You:\n${text}`,
    answers.length ? `Member answers:\n${answers.map((a) => `${a.name} (@${a.id}): ${clip(a.answer, ANSWER_CHARS)}`).join('\n\n')}` : '',
    followups.length ? `Follow-ups you asked for:\n${followups.map((f) => `${f.name} (@${f.id}), asked "${clip(oneLine(f.question), 200)}": ${clip(f.text!, CRITIQUE_CHARS)}`).join('\n\n')}` : '',
    critiques.length ? `Critiques:\n${critiques.map((c) => `${c.name} (@${c.id}): ${clip(c.text, CRITIQUE_CHARS)}`).join('\n\n')}` : 'Critiques: none raised.',
    input.stopped ? `The conversation was ended before you finished (${input.stopped}). If something is still unresolved, say so in one line.` : '',
    missing.length ? `No input from: ${missing.map((m) => `${m.name} (@${m.id}) ${m.why}`).join('; ')}.` : '',
    RULES,
  ].filter(Boolean).join('\n\n');
}

// ---------- plan parsing ----------

/** JSON candidates in `text`: fenced blocks first, then the first balanced {...} object. Never throws. */
function jsonCandidates(text: string): unknown[] {
  const out: unknown[] = [];
  const tryParse = (s: string) => { try { out.push(JSON.parse(s)); } catch { /* not JSON */ } };
  for (const m of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) tryParse(m[1].trim());
  tryParse(text.trim());
  for (const [open, close] of [['{', '}'], ['[', ']']] as const) {
    const start = text.indexOf(open);
    if (start < 0) continue;
    let depth = 0; let inStr = false; let esc = false;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true;
      else if (c === open) depth++;
      else if (c === close && --depth === 0) { tryParse(text.slice(start, i + 1)); break; }
    }
  }
  return out;
}

const memberFor = (members: RoomMember[], ref: unknown): RoomMember | undefined => {
  const k = slug(String(ref ?? '').replace(/^@/, ''));
  return k ? members.find((m) => slug(m.id) === k || slug(m.name) === k) : undefined;
};

export interface ParsedPlan { tasks: CouncilTask[]; fallback: boolean; reason?: string; note?: string }

/** Robust: accepts {"tasks":[{agent,question}]}, an array, or {"<id>":"question"}; unknown members and empty questions are dropped, first task per member wins. */
export function parsePlan(reply: string | null | undefined, members: RoomMember[], original: string): ParsedPlan {
  const fallback = (reason: string): ParsedPlan => ({ tasks: members.map((m) => ({ agent: m.id, question: clip(original, SUBQ_CHARS) })), fallback: true, reason });
  if (isPass(reply)) return fallback('the captain returned no plan');
  for (const c of jsonCandidates(reply!)) {
    const obj = c as Record<string, unknown> | unknown[];
    const raw: unknown[] = Array.isArray(obj) ? obj : Array.isArray((obj as any)?.tasks) ? (obj as any).tasks : Array.isArray((obj as any)?.assignments) ? (obj as any).assignments
      : obj && typeof obj === 'object' ? Object.entries(obj).filter(([k, v]) => typeof v === 'string' && memberFor(members, k)).map(([agent, question]) => ({ agent, question })) : [];
    const tasks: CouncilTask[] = [];
    for (const t of raw) {
      const o = t as Record<string, unknown>;
      const m = memberFor(members, o?.agent ?? o?.id ?? o?.member);
      const q = oneLine(String(o?.question ?? o?.task ?? o?.sub_question ?? ''));
      if (m && q && !tasks.some((x) => x.agent === m.id)) tasks.push({ agent: m.id, question: clip(q, SUBQ_CHARS) });
    }
    if (tasks.length) {
      const note = !Array.isArray(obj) && typeof (obj as any).notes === 'string' ? clip(oneLine((obj as any).notes), 300) : undefined;
      return { tasks, fallback: false, ...(note ? { note } : {}) };
    }
  }
  return fallback('the plan was not valid JSON with known members');
}

export type Decision =
  | { action: 'ask'; targets: string[]; question: string; unresolved?: string }
  | { action: 'critique' }
  | { action: 'synthesize' }
  | { action: 'invalid'; reason: string };

/** Strict: one JSON object with a known action. Anything else (prose, no JSON, unknown action, ask with no known target or no question) is `invalid`, which the run treats as "synthesize". Never throws. */
export function parseDecision(reply: string | null | undefined, members: RoomMember[]): Decision {
  if (isPass(reply)) return { action: 'invalid', reason: 'the captain returned nothing' };
  for (const c of jsonCandidates(reply!)) {
    const o = c as Record<string, unknown>;
    if (!o || typeof o !== 'object' || Array.isArray(o) || typeof o.action !== 'string') continue;
    const action = o.action.trim().toLowerCase();
    if (action === 'synthesize') return { action: 'synthesize' };
    if (action === 'critique') return { action: 'critique' };
    if (action === 'ask') {
      const raw = Array.isArray(o.targets) ? o.targets : o.target !== undefined ? [o.target] : o.agent !== undefined ? [o.agent] : [];
      const targets: string[] = [];
      for (const t of raw) { const m = memberFor(members, t); if (m && !targets.includes(m.id)) targets.push(m.id); }
      const question = clip(oneLine(String(o.question ?? '')), SUBQ_CHARS);
      if (!targets.length) return { action: 'invalid', reason: 'ask named no known member' };
      if (!question) return { action: 'invalid', reason: 'ask had no question' };
      const unresolved = typeof o.unresolved === 'string' && o.unresolved.trim() ? clip(oneLine(o.unresolved), UNRESOLVED_CHARS) : undefined;
      return { action: 'ask', targets: members.map((m) => m.id).filter((id) => targets.includes(id)), question, ...(unresolved ? { unresolved } : {}) };
    }
    return { action: 'invalid', reason: `unknown action "${clip(o.action, 40)}"` };
  }
  return { action: 'invalid', reason: 'not a JSON decision' };
}

/** The contrarian is the last non-captain critic (deterministic), or the last critic when only the captain is left. */
export function pickContrarian(critics: string[], captain: string): string | undefined {
  return [...critics].reverse().find((id) => id !== captain) ?? critics[critics.length - 1];
}

// ---------- the run ----------

export interface CouncilHooks {
  append(msg: Omit<RoomMessage, 'id' | 'ts'>): RoomMessage;
  /** Persist the (mutated) council. Called after every visible change. */
  save(): void;
  state(patch: Partial<RoomRunState>): void;
}
export interface CouncilOpts { /** Captain decisions allowed (1-4, default 3). */ maxSteps?: number }

type TurnOutcome = { ok: true; text: string | null } | { ok: false; why: 'error' | 'cancelled'; message: string };

/** One Zach message -> plan, parallel work, captain-steered follow-ups (bounded), synthesis. Never throws for an agent failure. */
export async function runCouncil(room: Room, members: RoomMember[], trigger: RoomMessage, council: Council, transport: RoomTransport, hooks: CouncilHooks, signal: AbortSignal, opts: CouncilOpts): Promise<RoomRunState['stopReason']> {
  const text = trigger.text;
  const byId = new Map(members.map((m) => [m.id, m]));
  const captain = byId.get(council.captain) ?? members[0];
  const nameOf = (id: string) => byId.get(id)?.name ?? id;
  const ctxFor = (agent: RoomMember): Ctx => ({ room, members, captain, agent });
  const maxSteps = Math.max(1, Math.min(MAX_STEPS_LIMIT, Math.trunc(opts.maxSteps ?? council.maxSteps ?? DEFAULT_MAX_STEPS) || DEFAULT_MAX_STEPS));
  council.maxSteps = maxSteps;
  const steps: CouncilStep[] = (council.steps = []);
  let seq = 0;

  const save = () => { hooks.state({ turnsUsed: council.turnsUsed, phase: council.phase, mode: 'council', steps: steps.length, maxSteps }); hooks.save(); };
  const setAgent = (id: string, status: CouncilAgentStatus) => {
    const a = (council.agents[id] ??= { status: 'idle' });
    if (status === 'planning' || status === 'working' || status === 'steering' || status === 'critiquing' || status === 'synthesizing') a.startedAt = Date.now();
    else a.endedAt = Date.now();
    a.status = status;
  };
  const note = (agent: string, kind: CouncilNote['kind'], body: string, pass?: boolean) => {
    council.notes.push({ id: `n${trigger.id}-${seq++}`, ts: Date.now(), agent, kind, text: clip(body, NOTE_CHARS), ...(pass ? { pass: true } : {}) });
  };
  const phase = (p: Council['phase']) => { council.phase = p; save(); };
  const cancelled = (): RoomRunState['stopReason'] => {
    for (const a of Object.values(council.agents)) if (['planning', 'working', 'steering', 'critiquing', 'synthesizing'].includes(a.status)) { a.status = 'stopped'; a.endedAt = Date.now(); }
    council.phase = 'stopped'; council.endedAt = Date.now(); council.stop = { reason: 'cancelled' };
    hooks.append({ from: 'system', text: 'Stopped: the council was cancelled; in-flight agent runs were aborted.' });
    save();
    return 'cancelled';
  };

  /** One member turn. There is no timeout: it ends by replying, failing, or Stop (which also aborts that agent's Gateway run so it stops spending tokens). */
  async function turn(id: string, prompt: string): Promise<TurnOutcome> {
    if (signal.aborted) return { ok: false, why: 'cancelled', message: 'cancelled' };
    const ac = new AbortController();
    const onAbort = () => ac.abort();
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      return { ok: true, text: await transport.turn(id, prompt, ac.signal) };
    } catch (e) {
      if (signal.aborted) return { ok: false, why: 'cancelled', message: 'cancelled' };
      return { ok: false, why: 'error', message: (e as Error).message };
    } finally {
      signal.removeEventListener('abort', onAbort);
      if (ac.signal.aborted) { try { transport.abort?.(id); } catch { /* best effort */ } }
    }
  }
  const inOrder = <T>(m: Map<string, T>) => members.map((x) => x.id).filter((id) => m.has(id)).map((id) => [id, m.get(id)!] as const); // member order, not completion order
  const spend = (n = 1) => { council.turnsUsed += n; };

  // ---- 1. plan ----
  let plan: ParsedPlan | undefined;
  {
    phase('planning');
    setAgent(captain.id, 'planning'); save();
    spend();
    const r = await turn(captain.id, planPrompt(ctxFor(captain), text, room.messages.filter((m) => m.id !== trigger.id && !m.council)));
    if (!r.ok && r.why === 'cancelled') return cancelled();
    plan = parsePlan(r.ok ? r.text : null, members, text);
    if (!r.ok) { plan.reason = `captain plan failed (${r.message})`; setAgent(captain.id, 'error'); }
    council.plan = plan;
    if (council.agents[captain.id]?.status === 'planning') setAgent(captain.id, 'idle'); // planning is over; the captain waits for the members
    note(captain.id, 'plan', plan.fallback ? `No usable plan (${plan.reason}); every member gets the whole question.` : `${plan.note ? `${plan.note}\n` : ''}${plan.tasks.map((t) => `@${t.agent}: ${t.question}`).join('\n')}`);
    save();
  }

  // ---- 2. parallel work ----
  const answers = new Map<string, string>();
  const missing = new Map<string, string>();
  let tasks = plan ? [...plan.tasks.filter((t) => t.agent !== captain.id), ...plan.tasks.filter((t) => t.agent === captain.id)] : [];
  const runTasks = tasks;
  for (const m of members) if (!council.agents[m.id]) council.agents[m.id] = { status: 'idle' };
  if (runTasks.length) {
    phase('working');
    spend(runTasks.length);
    for (const t of runTasks) setAgent(t.agent, 'working');
    save();
    await Promise.all(runTasks.map(async (t) => {
      const agent = byId.get(t.agent)!;
      const r = await turn(t.agent, specialistPrompt(ctxFor(agent), text, t.question));
      if (!r.ok) {
        if (r.why === 'cancelled') return;
        setAgent(t.agent, 'error');
        missing.set(t.agent, `(failed: ${r.message})`);
        note(t.agent, 'system', `Did not answer: ${r.message}`);
      } else if (isPass(r.text)) {
        setAgent(t.agent, 'done');
        note(t.agent, 'answer', 'No answer given.', true);
      } else {
        answers.set(t.agent, r.text!.trim());
        setAgent(t.agent, 'done');
        note(t.agent, 'answer', r.text!.trim());
      }
      save();
    }));
    if (signal.aborted) return cancelled();
  }

  // ---- 3. captain-steered conversation ----
  // The captain returns one decision per step. Everything below that bounds the loop is code: only this loop starts turns, a decision is never retried,
  // and every exit falls through to the synthesis, which always has a turn reserved (an action needs decide + 1 target + synthesis = 3 turns left).
  const critiques = new Map<string, string>();
  const followups: SteerState['followups'] = [];
  const seenAsks = new Set<string>();
  const norm = (q: string) => q.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  let critiqued = false;
  let stop: { reason: CouncilStopReason; detail?: string } = { reason: 'done' };
  const outcomeOf = (ok: number, pass: number, failed: number): CouncilStep['outcome'] => (ok ? 'answered' : failed >= pass + failed ? 'failed' : 'allPass');

  /** The existing parallel critique round; returns [replied, passed, failed]. */
  async function critiqueRound(critics: string[]): Promise<[number, number, number]> {
    const contrarian = pickContrarian(critics, captain.id);
    phase('critiquing');
    spend(critics.length);
    for (const id of critics) setAgent(id, 'critiquing');
    save();
    let ok = 0; let pass = 0; let failed = 0;
    await Promise.all(critics.map(async (id) => {
      const others = inOrder(answers).filter(([k]) => k !== id).map(([k, a]) => ({ id: k, name: nameOf(k), answer: a }));
      const r = await turn(id, critiquePrompt(ctxFor(byId.get(id)!), text, answers.get(id), others, id === contrarian));
      if (!r.ok) {
        if (r.why === 'cancelled') return;
        failed++;
        setAgent(id, 'error');
        note(id, 'system', `Critique failed: ${r.message}`);
      } else if (isPass(r.text)) {
        pass++;
        setAgent(id, 'done');
        note(id, 'critique', PASS_TOKEN, true);
      } else {
        ok++;
        critiques.set(id, r.text!.trim());
        setAgent(id, 'done');
        note(id, 'critique', r.text!.trim());
      }
      save();
    }));
    return [ok, pass, failed];
  }

  for (;;) {
    if (!answers.size) { stop = { reason: 'noProgress', detail: 'no member answered, so there is nothing to steer' }; break; }
    if (steps.length >= maxSteps) { stop = { reason: 'stepLimit', detail: `${maxSteps} captain decision${maxSteps === 1 ? '' : 's'} used` }; break; }
    const stepNo = steps.length + 1;

    // The captain decides. A failed, empty, malformed or unknown decision means "synthesize": there is no retry.
    phase('steering');
    setAgent(captain.id, 'steering');
    spend();
    save();
    const d = await turn(captain.id, steerPrompt(ctxFor(captain), text, {
      step: stepNo, maxSteps, critiqued,
      answers: inOrder(answers).map(([id, answer]) => ({ id, name: nameOf(id), answer })),
      followups, critiques: inOrder(critiques).map(([id, t]) => ({ id, name: nameOf(id), text: t })),
      missing: inOrder(missing).map(([id, why]) => ({ id, name: nameOf(id), why })),
    }));
    if (!d.ok && d.why === 'cancelled') return cancelled();
    setAgent(captain.id, d.ok ? 'idle' : 'error');
    if (!d.ok) { stop = { reason: 'captainFailed', detail: d.message }; break; }
    const dec = parseDecision(d.text, members);
    if (dec.action === 'synthesize') { stop = { reason: 'done' }; break; }
    if (dec.action === 'invalid') { stop = { reason: 'malformed', detail: dec.reason }; break; }

    if (dec.action === 'critique') {
      if (critiqued || answers.size < 2) { stop = { reason: 'noProgress', detail: critiqued ? 'the captain asked for a second critique round' : 'fewer than two answers to critique' }; break; }
      critiqued = true;
      const critics = inOrder(answers).map(([id]) => id);
      note(captain.id, 'decision', `Step ${stepNo}: called a critique round (${critics.map((id) => nameOf(id)).join(', ')}).`);
      const step: CouncilStep = { step: stepNo, action: 'critique', targets: critics };
      steps.push(step);
      const [ok, pass, failed] = await critiqueRound(critics);
      if (signal.aborted) return cancelled();
      step.outcome = outcomeOf(ok, pass, failed);
      if (!ok) { stop = { reason: 'noProgress', detail: failed >= critics.length ? 'every critic timed out or failed' : 'every critic replied PASS' }; break; }
      continue;
    }

    // ask: a directed follow-up to one or more members (two of them against each other on a disagreement)
    const key = `${[...dec.targets].sort().join(',')}|${norm(dec.question)}`;
    if (seenAsks.has(key)) {
      note(captain.id, 'decision', `Step ${stepNo}: repeated an earlier question to ${dec.targets.map((id) => nameOf(id)).join(', ')}; not asked again.`);
      steps.push({ step: stepNo, action: 'ask', targets: dec.targets, question: dec.question, outcome: 'repeat' });
      stop = { reason: 'noProgress', detail: 'the captain repeated the same targets and question' };
      break;
    }
    seenAsks.add(key);
    const targets = dec.targets;
    const step: CouncilStep = { step: stepNo, action: 'ask', targets, question: dec.question, ...(dec.unresolved ? { unresolved: dec.unresolved } : {}) };
    steps.push(step);
    note(captain.id, 'decision', `Step ${stepNo}: asked ${targets.map((id) => nameOf(id)).join(', ')} about: ${dec.question}${dec.unresolved ? `\nStill unresolved: ${dec.unresolved}` : ''}`);
    phase('working');
    spend(targets.length);
    for (const id of targets) setAgent(id, 'working');
    save();
    let ok = 0; let pass = 0; let failed = 0;
    await Promise.all(targets.map(async (id) => {
      const peers = inOrder(answers).filter(([k]) => k !== id && targets.includes(k)).map(([k, a]) => ({ id: k, name: nameOf(k), answer: a }));
      const r = await turn(id, followupPrompt(ctxFor(byId.get(id)!), text, answers.get(id), dec.question, peers, stepNo));
      if (!r.ok) {
        if (r.why === 'cancelled') return;
        failed++;
        setAgent(id, 'error');
        note(id, 'system', `Follow-up failed: ${r.message}`);
      } else if (isPass(r.text)) {
        pass++;
        setAgent(id, 'done');
        followups.push({ step: stepNo, id, name: nameOf(id), question: dec.question, text: null });
        note(id, 'followup', 'Nothing to add.', true);
      } else {
        ok++;
        const t = r.text!.trim();
        setAgent(id, 'done');
        followups.push({ step: stepNo, id, name: nameOf(id), question: dec.question, text: t });
        if (!answers.has(id)) { answers.set(id, t); missing.delete(id); } // a member that missed the first round and now answers counts as having answered
        note(id, 'followup', t);
      }
      save();
    }));
    if (signal.aborted) return cancelled();
    step.outcome = outcomeOf(ok, pass, failed);
    if (!ok) { stop = { reason: 'noProgress', detail: failed >= targets.length ? 'every target timed out or failed' : 'every target replied PASS' }; break; }
  }
  council.stop = stop;
  const STOP_TEXT: Record<CouncilStopReason, string> = {
    done: 'Captain is done: the answer is good enough.',
    stepLimit: `Step limit reached${stop.detail ? ` (${stop.detail})` : ''}: moving to the answer.`,
    cap: 'Moving to the answer.', // legacy: recorded by councils from before the turn cap was removed; never produced now
    noProgress: `No progress${stop.detail ? `: ${stop.detail}` : ''}: moving to the answer.`,
    malformed: `The captain's decision was unusable${stop.detail ? ` (${stop.detail})` : ''}: moving to the answer.`,
    captainFailed: `The captain could not decide${stop.detail ? ` (${stop.detail})` : ''}: moving to the answer.`,
    cancelled: 'Cancelled.',
  };
  note(captain.id, 'system', STOP_TEXT[stop.reason]);

  // ---- 4. synthesis ----
  phase('synthesizing');
  setAgent(captain.id, 'synthesizing');
  spend();
  save();
  const input: SynthInput = {
    plan,
    answers: inOrder(answers).map(([id, answer]) => ({ id, name: nameOf(id), answer })),
    critiques: inOrder(critiques).map(([id, t]) => ({ id, name: nameOf(id), text: t })),
    missing: inOrder(missing).map(([id, why]) => ({ id, name: nameOf(id), why })),
    followups,
    ...(stop.reason === 'done' ? {} : { stopped: STOP_TEXT[stop.reason].replace(/: moving to the answer\.$/, '') }),
  };
  const r = await turn(captain.id, synthesizePrompt(ctxFor(captain), text, input));
  if (!r.ok && r.why === 'cancelled') return cancelled();
  let final: string;
  if (r.ok && !isPass(r.text)) final = r.text!.trim();
  else {
    // The captain could not synthesize: still give Zach one reply, built from what the members said, and say so.
    const why = r.ok ? 'returned nothing' : r.message;
    final = `The captain (${captain.name}) could not write the summary (${why}), so here is what the council produced.\n\n${input.answers.map((a) => `${a.name}: ${a.answer}`).join('\n\n') || '(no member answers arrived)'}${followups.filter((f) => f.text).length ? `\n\nFollow-ups:\n${followups.filter((f) => f.text).map((f) => `${f.name}: ${f.text}`).join('\n')}` : ''}${input.critiques.length ? `\n\nFlagged:\n${input.critiques.map((c) => `${c.name}: ${c.text}`).join('\n')}` : ''}`;
    note(captain.id, 'system', `Synthesis failed (${why}); showing the raw member answers.`);
  }
  const msg = hooks.append({ from: captain.id, text: final, council: council.id });
  council.finalId = msg.id;
  setAgent(captain.id, 'done');
  council.phase = 'done'; council.endedAt = Date.now();
  save();
  return 'complete';
}

/** True when this message should skip the council and go straight to the @mentioned member(s). */
export function councilBypass(room: Room, members: RoomMember[], text: string): string[] | null {
  if (!room.mentionGating) return null;
  const hit = parseMentions(text, members);
  return hit && hit.length ? hit : null;
}
