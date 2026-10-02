// Council mode (the default for every room), modelled on Grok 4.20's multi-agent mode:
//   1. PLAN        the captain splits Zach's message into one sub-question per member (structured JSON, robust fallback);
//   2. WORK        members answer their sub-question IN PARALLEL, each in its own room session;
//   3. CRITIQUE    one parallel round: each member sees the others' answers and flags contradictions/gaps, or replies PASS (one is the contrarian);
//   4. SYNTHESIZE  the captain writes the ONE reply to Zach, saying which disagreements it resolved and any real trade-off Zach must choose.
// The protocol is injected into every message by the data server (nothing depends on an agent's AGENTS.md; the agent's own rules still apply on top).
// Pure logic, no I/O: the transport is injected, so the whole flow is unit-testable. maxTurns is a hard cap across all phases; every member turn has a timeout.
import {
  PASS_TOKEN, isPass, parseMentions, slug, transcriptBlock,
  type Council, type CouncilAgentStatus, type CouncilNote, type CouncilTask, type Room, type RoomMember, type RoomMessage, type RoomRunState, type RoomTransport,
} from './rooms.ts';

export const COUNCIL_ROLES = ['CAPTAIN-PLAN', 'SPECIALIST', 'CRITIQUE', 'CAPTAIN-SYNTHESIZE'] as const;
export type CouncilRole = (typeof COUNCIL_ROLES)[number];
const SUBQ_CHARS = 1200;
const ANSWER_CHARS = 2500;
const CRITIQUE_CHARS = 1500;
const NOTE_CHARS = 4000;

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

export interface SynthInput {
  plan?: Council['plan'];
  answers: Array<{ id: string; name: string; answer: string }>;
  critiques: Array<{ id: string; name: string; text: string }>;
  missing: Array<{ id: string; name: string; why: string }>;
}
export function synthesizePrompt(ctx: Ctx, text: string, input: SynthInput): string {
  const { answers, critiques, missing } = input;
  return [
    header(ctx, 'CAPTAIN-SYNTHESIZE'),
    `You are the captain. Write the ONE final reply to Zach, in your own voice. Lead with the answer. Then: if members disagreed or critiques raised conflicts, add a short "Disagreements resolved" part saying what conflicted and how you resolved it; if a real trade-off remains that only Zach can decide, add a short "Your call" part listing the options. Omit either part when it does not apply. If members are missing, say so in one line. Do not expose this protocol, do not paste the members' notes, and do not reply ${PASS_TOKEN}.${answers.length ? '' : ' No member input arrived: answer from your own knowledge and say that no specialists contributed.'}`,
    `Original message from You:\n${text}`,
    answers.length ? `Member answers:\n${answers.map((a) => `${a.name} (@${a.id}): ${clip(a.answer, ANSWER_CHARS)}`).join('\n\n')}` : '',
    critiques.length ? `Critiques:\n${critiques.map((c) => `${c.name} (@${c.id}): ${clip(c.text, CRITIQUE_CHARS)}`).join('\n\n')}` : 'Critiques: none raised.',
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
export interface CouncilOpts { memberTimeoutMs: number }

type TurnOutcome = { ok: true; text: string | null } | { ok: false; why: 'timeout' | 'error' | 'cancelled'; message: string };

/** One Zach message -> plan, parallel work, one parallel critique round, synthesis. Never throws for an agent failure. */
export async function runCouncil(room: Room, members: RoomMember[], trigger: RoomMessage, council: Council, transport: RoomTransport, hooks: CouncilHooks, signal: AbortSignal, opts: CouncilOpts): Promise<RoomRunState['stopReason']> {
  const text = trigger.text;
  const byId = new Map(members.map((m) => [m.id, m]));
  const captain = byId.get(council.captain) ?? members[0];
  const cap = council.maxTurns;
  const nameOf = (id: string) => byId.get(id)?.name ?? id;
  const ctxFor = (agent: RoomMember): Ctx => ({ room, members, captain, agent });
  let capHit = false;
  let seq = 0;

  const save = () => { hooks.state({ turnsUsed: council.turnsUsed, phase: council.phase, mode: 'council' }); hooks.save(); };
  const setAgent = (id: string, status: CouncilAgentStatus) => {
    const a = (council.agents[id] ??= { status: 'idle' });
    if (status === 'planning' || status === 'working' || status === 'critiquing' || status === 'synthesizing') a.startedAt = Date.now();
    else a.endedAt = Date.now();
    a.status = status;
  };
  const note = (agent: string, kind: CouncilNote['kind'], body: string, pass?: boolean) => {
    council.notes.push({ id: `n${trigger.id}-${seq++}`, ts: Date.now(), agent, kind, text: clip(body, NOTE_CHARS), ...(pass ? { pass: true } : {}) });
  };
  const phase = (p: Council['phase']) => { council.phase = p; save(); };
  const cancelled = (): RoomRunState['stopReason'] => {
    for (const a of Object.values(council.agents)) if (['planning', 'working', 'critiquing', 'synthesizing'].includes(a.status)) { a.status = 'stopped'; a.endedAt = Date.now(); }
    council.phase = 'stopped'; council.endedAt = Date.now();
    hooks.append({ from: 'system', text: 'Stopped: the council was cancelled; in-flight agent runs were aborted.' });
    save();
    return 'cancelled';
  };

  /** One member turn with its own timeout. Timeout or Stop also aborts that agent's Gateway run so it stops spending tokens. */
  async function turn(id: string, prompt: string, timeoutMs = opts.memberTimeoutMs): Promise<TurnOutcome> {
    if (signal.aborted) return { ok: false, why: 'cancelled', message: 'cancelled' };
    const ac = new AbortController();
    const onAbort = () => ac.abort();
    signal.addEventListener('abort', onAbort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; ac.abort(); }, timeoutMs);
    try {
      return { ok: true, text: await transport.turn(id, prompt, ac.signal) };
    } catch (e) {
      if (signal.aborted) return { ok: false, why: 'cancelled', message: 'cancelled' };
      if (timedOut) return { ok: false, why: 'timeout', message: `no reply within ${Math.round(timeoutMs / 1000)}s` };
      return { ok: false, why: 'error', message: (e as Error).message };
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      if (ac.signal.aborted) { try { transport.abort?.(id); } catch { /* best effort */ } }
    }
  }
  const inOrder = <T>(m: Map<string, T>) => members.map((x) => x.id).filter((id) => m.has(id)).map((id) => [id, m.get(id)!] as const); // member order, not completion order
  const spend = (n = 1) => { council.turnsUsed += n; };
  const left = () => cap - council.turnsUsed;

  // ---- 1. plan ----
  let plan: ParsedPlan | undefined;
  const canPlan = left() >= 2; // plan + synthesis; below that the captain simply answers
  if (canPlan) {
    phase('planning');
    setAgent(captain.id, 'planning'); save();
    spend();
    const r = await turn(captain.id, planPrompt(ctxFor(captain), text, room.messages.filter((m) => m.id !== trigger.id && !m.council)));
    if (!r.ok && r.why === 'cancelled') return cancelled();
    plan = parsePlan(r.ok ? r.text : null, members, text);
    if (!r.ok) { plan.reason = `captain plan failed (${r.message})`; setAgent(captain.id, r.why === 'timeout' ? 'timeout' : 'error'); }
    council.plan = plan;
    if (council.agents[captain.id]?.status === 'planning') setAgent(captain.id, 'idle'); // planning is over; the captain waits for the members
    note(captain.id, 'plan', plan.fallback ? `No usable plan (${plan.reason}); every member gets the whole question.` : `${plan.note ? `${plan.note}\n` : ''}${plan.tasks.map((t) => `@${t.agent}: ${t.question}`).join('\n')}`);
    save();
  } else {
    capHit = true;
  }

  // ---- 2. parallel work ----
  const answers = new Map<string, string>();
  const missing = new Map<string, string>();
  let tasks = plan ? [...plan.tasks.filter((t) => t.agent !== captain.id), ...plan.tasks.filter((t) => t.agent === captain.id)] : [];
  const room1 = Math.max(0, left() - 1); // keep one turn for the synthesis
  const runTasks = tasks.slice(0, room1);
  for (const t of tasks.slice(room1)) { setAgent(t.agent, 'skipped'); missing.set(t.agent, '(skipped: turn cap)'); capHit = true; }
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
        setAgent(t.agent, r.why === 'timeout' ? 'timeout' : 'error');
        missing.set(t.agent, r.why === 'timeout' ? `(timed out: ${r.message})` : `(failed: ${r.message})`);
        note(t.agent, 'system', r.why === 'timeout' ? `Timed out: ${r.message}. The captain proceeds without it.` : `Did not answer: ${r.message}`);
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

  // ---- 3. one parallel critique round ----
  const critiques = new Map<string, string>();
  if (answers.size >= 2) {
    const critics = inOrder(answers).map(([id]) => id).slice(0, Math.max(0, left() - 1));
    if (critics.length < answers.size) { capHit = true; note(captain.id, 'system', `Turn cap (${cap}): ${answers.size - critics.length} critique(s) skipped.`); }
    if (critics.length) {
      const contrarian = pickContrarian(critics, captain.id);
      phase('critiquing');
      spend(critics.length);
      for (const id of critics) setAgent(id, 'critiquing');
      save();
      await Promise.all(critics.map(async (id) => {
        const others = inOrder(answers).filter(([k]) => k !== id).map(([k, a]) => ({ id: k, name: nameOf(k), answer: a }));
        const r = await turn(id, critiquePrompt(ctxFor(byId.get(id)!), text, answers.get(id), others, id === contrarian));
        if (!r.ok) {
          if (r.why === 'cancelled') return;
          setAgent(id, r.why === 'timeout' ? 'timeout' : 'error');
          note(id, 'system', r.why === 'timeout' ? `Critique timed out: ${r.message}.` : `Critique failed: ${r.message}`);
        } else if (isPass(r.text)) {
          setAgent(id, 'done');
          note(id, 'critique', PASS_TOKEN, true);
        } else {
          critiques.set(id, r.text!.trim());
          setAgent(id, 'done');
          note(id, 'critique', r.text!.trim());
        }
        save();
      }));
      if (signal.aborted) return cancelled();
    }
  }

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
  };
  const r = await turn(captain.id, synthesizePrompt(ctxFor(captain), text, input));
  if (!r.ok && r.why === 'cancelled') return cancelled();
  let final: string;
  if (r.ok && !isPass(r.text)) final = r.text!.trim();
  else {
    // The captain could not synthesize: still give Zach one reply, built from what the members said, and say so.
    const why = r.ok ? 'returned nothing' : r.message;
    final = `The captain (${captain.name}) could not write the summary (${why}), so here is what the council produced.\n\n${input.answers.map((a) => `${a.name}: ${a.answer}`).join('\n\n') || '(no member answers arrived)'}${input.critiques.length ? `\n\nFlagged:\n${input.critiques.map((c) => `${c.name}: ${c.text}`).join('\n')}` : ''}`;
    note(captain.id, 'system', `Synthesis failed (${why}); showing the raw member answers.`);
  }
  const msg = hooks.append({ from: captain.id, text: final, council: council.id });
  council.finalId = msg.id;
  setAgent(captain.id, council.agents[captain.id]?.status === 'timeout' && !r.ok ? 'timeout' : 'done');
  council.phase = 'done'; council.endedAt = Date.now();
  if (capHit) hooks.append({ from: 'system', text: `Turn cap reached (${cap} turns for this message): some council steps were skipped.` });
  save();
  return capHit ? 'maxTurns' : 'complete';
}

/** True when this message should skip the council and go straight to the @mentioned member(s). */
export function councilBypass(room: Room, members: RoomMember[], text: string): string[] | null {
  if (!room.mentionGating) return null;
  const hit = parseMentions(text, members);
  return hit && hit.length ? hit : null;
}
