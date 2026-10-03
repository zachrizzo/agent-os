import assert from 'node:assert/strict';
import { test } from 'node:test';
import { councilBypass, parseDecision, parsePlan, pickContrarian, runCouncil, type CouncilHooks } from './council.ts';
import { migrateRoom, resolveCaptain, councilTurns, type Council, type Room, type RoomMember, type RoomMessage, type RoomRunState, type RoomTransport } from './rooms.ts';
import { scriptedReply } from './scripted.ts';

const M: RoomMember[] = [{ id: 'rfc-lead', name: 'RFC Lead' }, { id: 'rfc-skeptic', name: 'RFC Skeptic' }, { id: 'rfc-scribe', name: 'RFC Scribe' }];

test('parsePlan: fenced JSON, bare JSON, array, id map; unknown members and empty questions dropped; first task per member wins', () => {
  const a = parsePlan('Here you go:\n```json\n{"tasks":[{"agent":"rfc-skeptic","question":"Q1"},{"agent":"nobody","question":"x"},{"agent":"rfc-skeptic","question":"dup"}],"notes":"split"}\n```', M, 'orig');
  assert.deepEqual(a.tasks, [{ agent: 'rfc-skeptic', question: 'Q1' }]);
  assert.equal(a.fallback, false);
  assert.equal(a.note, 'split');
  assert.deepEqual(parsePlan('{"tasks":[{"agent":"@RFC Lead","question":"Q"}]} trailing words', M, 'o').tasks, [{ agent: 'rfc-lead', question: 'Q' }]);
  assert.equal(parsePlan('[{"agent":"rfc-scribe","question":"Q"}]', M, 'o').tasks[0].agent, 'rfc-scribe');
  assert.equal(parsePlan('{"rfc-lead":"A","rfc-scribe":"B"}', M, 'o').tasks.length, 2);
  assert.equal(parsePlan('{"tasks":[{"agent":"rfc-lead","question":"has } brace in \\"string\\" {"}]}', M, 'o').tasks.length, 1);
});

test('parsePlan fallback: prose, empty, malformed, no known members -> every member gets the original question', () => {
  for (const bad of ['no json here', '', null, '{"tasks": [', '{"tasks":[{"agent":"ghost","question":"x"}]}', '{"tasks":[{"agent":"rfc-lead","question":"  "}]}']) {
    const p = parsePlan(bad, M, 'the original');
    assert.equal(p.fallback, true, String(bad));
    assert.deepEqual(p.tasks.map((t) => [t.agent, t.question]), M.map((m) => [m.id, 'the original']));
  }
});

test('captain resolution + migration of an old (version 1) room', () => {
  assert.equal(resolveCaptain('rfc-skeptic', ['rfc-lead', 'rfc-skeptic']), 'rfc-skeptic');
  assert.equal(resolveCaptain(undefined, ['rfc-skeptic', 'rfc-lead']), 'rfc-lead'); // rfc-lead preferred when present
  assert.equal(resolveCaptain('gone', ['x', 'y']), 'x'); // default: first member
  assert.equal(resolveCaptain(undefined, []), '');
  const old = { id: 'rc1cabea9', name: 'RFC Council', members: ['rfc-skeptic', 'rfc-lead', 'rfc-scribe'], archived: false, createdAt: 1, updatedAt: 2, messages: [{ id: 'm1', ts: 1, from: 'you', text: 'hi' }], maxRounds: 1, maxTurns: 3, mentionGating: true } as unknown as Room;
  const m = migrateRoom(old);
  assert.equal(m.captain, 'rfc-lead');
  assert.equal(m.mode, 'council');
  assert.deepEqual(m.councils, []);
  assert.equal(m.maxTurns, councilTurns(3)); // the old default cap (= member count) is raised so a council can finish
  assert.equal(m.messages.length, 1);
  const custom = migrateRoom({ ...old, maxTurns: 20 } as Room);
  assert.equal(custom.maxTurns, 20); // an explicit larger cap is kept
  const rt = migrateRoom({ ...old, mode: 'roundtable' } as Room);
  assert.equal(rt.mode, 'roundtable');
  assert.equal(rt.maxTurns, 3);
});

test('contrarian is the last non-captain critic', () => {
  assert.equal(pickContrarian(['rfc-lead', 'rfc-skeptic', 'rfc-scribe'], 'rfc-lead'), 'rfc-scribe');
  assert.equal(pickContrarian(['rfc-lead'], 'rfc-lead'), 'rfc-lead');
});

function harness(settings: Partial<Room> = {}, members = M) {
  const room: Room = { id: 'r1', name: 'T', members: members.map((m) => m.id), captain: 'rfc-lead', councils: [], archived: false, createdAt: 0, updatedAt: 0, messages: [], maxRounds: 1, maxTurns: 16, maxSteps: 3, mentionGating: true, mode: 'council', memberTimeoutSec: 90, ...settings };
  let n = 0;
  const state: Partial<RoomRunState> = {};
  const hooks: CouncilHooks = {
    append: (m) => { const x = { ...m, id: `m${n++}`, ts: n } as RoomMessage; room.messages.push(x); return x; },
    save: () => {}, state: (p) => Object.assign(state, p),
  };
  const trigger = hooks.append({ from: 'you', text: '' });
  const council: Council = { id: trigger.id, captain: room.captain, phase: 'planning', startedAt: 0, agents: {}, notes: [], turnsUsed: 0, maxTurns: room.maxTurns };
  room.councils.push(council);
  const run = (text: string, transport: RoomTransport, signal = new AbortController().signal, timeoutMs = 5000) => { trigger.text = text; return runCouncil(room, members, trigger, council, transport, hooks, signal, { memberTimeoutMs: timeoutMs, maxSteps: room.maxSteps }); };
  return { room, council, run, state };
}
interface Call { id: string; role: string; t0: number; t1: number; prompt: string }
function scripted(delays: Record<string, number> = {}, calls: Call[] = []): RoomTransport & { calls: Call[]; aborts: string[] } {
  const aborts: string[] = [];
  return {
    calls, aborts,
    async turn(id, prompt, signal) {
      const c: Call = { id, role: /Council role: ([A-Z-]+)\./.exec(prompt)![1], t0: Date.now(), t1: 0, prompt };
      calls.push(c);
      await new Promise<void>((res, rej) => { const t = setTimeout(res, delays[id] ?? 20); signal.addEventListener('abort', () => { clearTimeout(t); rej(new Error('aborted')); }, { once: true }); });
      c.t1 = Date.now();
      return scriptedReply(prompt);
    },
    abort(id) { aborts.push(id); },
  };
}
const overlap = (a: Call, b: Call) => a.t0 < b.t1 && b.t0 < a.t1;

test('full flow with a critique step: plan -> parallel work -> steer(critique) -> steer -> ONE captain reply', async () => {
  const h = harness();
  const t = scripted({ 'rfc-lead': 120, 'rfc-skeptic': 120, 'rfc-scribe': 120 });
  const stop = await h.run('Should we ship the RFC? crit conflict', t);
  assert.equal(stop, 'complete');
  const roles = (r: string) => t.calls.filter((c) => c.role === r);
  assert.equal(roles('CAPTAIN-PLAN').length, 1);
  assert.equal(roles('SPECIALIST').length, 3);
  assert.equal(roles('CRITIQUE').length, 3);
  assert.equal(roles('CAPTAIN-SYNTHESIZE').length, 1);
  assert.equal(roles('CAPTAIN-STEER').length, 2); // critique, then synthesize
  assert.equal(roles('FOLLOW-UP').length, 0);
  assert.equal(h.council.turnsUsed, 10);
  assert.deepEqual(h.council.steps?.map((x) => [x.action, x.outcome]), [['critique', 'answered']]);
  const [a, b, c] = roles('SPECIALIST');
  assert.ok(overlap(a, b) && overlap(b, c) && overlap(a, c), 'specialists ran concurrently');
  const [x, y] = roles('CRITIQUE');
  assert.ok(overlap(x, y), 'critiques ran concurrently');
  assert.ok(roles('CAPTAIN-PLAN')[0].t1 <= a.t0 && roles('SPECIALIST').every((s) => s.t1 <= x.t0 + 5), 'phases are ordered');
  // The thread: Zach + exactly one captain reply (member notes live in the council, not the thread).
  const thread = h.room.messages.filter((m) => m.from !== 'system');
  assert.deepEqual(thread.map((m) => m.from), ['you', 'rfc-lead']);
  assert.equal(thread[1].council, h.council.id);
  assert.equal(h.council.finalId, thread[1].id);
  assert.match(thread[1].text, /Disagreements resolved/);
  assert.equal(h.council.phase, 'done');
  assert.equal(h.council.agents['rfc-skeptic'].status, 'done');
  assert.equal(h.council.notes.filter((n) => n.kind === 'answer').length, 3);
  assert.ok(h.council.notes.some((n) => n.kind === 'critique' && n.pass), 'PASS critiques are recorded');
  assert.ok(h.council.notes.some((n) => n.kind === 'critique' && !n.pass), 'a non-PASS critique is recorded');
  assert.equal(h.council.plan?.fallback, false);
});

test('protocol is injected: role, captain, original message; specialists get their sub-question; critics see the OTHERS answers; synth sees plan inputs', async () => {
  const h = harness();
  const t = scripted();
  await h.run('Pick a database crit', t);
  const spec = t.calls.find((c) => c.role === 'SPECIALIST' && c.id === 'rfc-skeptic')!.prompt;
  assert.match(spec, /You are RFC Skeptic \(@rfc-skeptic\)\./);
  assert.match(spec, /captain: RFC Lead \(@rfc-lead\)/);
  assert.match(spec, /Your sub-question:\nFrom the @rfc-skeptic angle: Pick a database/);
  assert.match(spec, /Your own rules, tools and safety limits still apply/);
  const crit = t.calls.find((c) => c.role === 'CRITIQUE' && c.id === 'rfc-skeptic')!.prompt;
  assert.match(crit, /Other members' answers:\nRFC Lead \(@rfc-lead\): RFC Lead: on/);
  assert.doesNotMatch(crit.split("Other members' answers:")[1], /@rfc-skeptic\)/);
  assert.match(crit, /Your own answer:\nRFC Skeptic: on/);
  const synth = t.calls.find((c) => c.role === 'CAPTAIN-SYNTHESIZE')!.prompt;
  assert.match(synth, /ONE final reply to Zach/);
  assert.match(synth, /Member answers:/);
  assert.match(synth, /Critiques:/);
});

test('contrarian: exactly one critic is told to argue against the consensus', async () => {
  const h = harness();
  const t = scripted();
  await h.run('x crit', t);
  const c = t.calls.filter((x) => x.role === 'CRITIQUE');
  assert.equal(c.filter((x) => /You are the CONTRARIAN/.test(x.prompt)).length, 1);
  assert.equal(c.find((x) => /CONTRARIAN/.test(x.prompt))!.id, 'rfc-scribe');
});

test('bad plan -> fallback: every member gets the whole question, and the council still finishes', async () => {
  const h = harness();
  const t = scripted();
  await h.run('badplan please', t);
  assert.equal(h.council.plan?.fallback, true);
  assert.equal(t.calls.filter((c) => c.role === 'SPECIALIST').length, 3);
  assert.match(t.calls.find((c) => c.role === 'SPECIALIST')!.prompt, /Your sub-question:\nbadplan please/);
  assert.equal(h.council.phase, 'done');
  assert.ok(h.council.notes.some((n) => n.kind === 'plan' && /No usable plan/.test(n.text)));
});

test('timeout: a slow member is cut off, its run aborted, the captain proceeds and names who timed out', async () => {
  const h = harness();
  const t = scripted({ 'rfc-skeptic': 5000 });
  const t0 = Date.now();
  await h.run('x crit', t, undefined, 150);
  assert.ok(Date.now() - t0 < 2500, 'did not wait for the slow member');
  assert.equal(h.council.agents['rfc-skeptic'].status, 'timeout');
  assert.ok(t.aborts.includes('rfc-skeptic'), 'the slow member run was aborted on the Gateway');
  assert.equal(h.council.notes.filter((n) => n.kind === 'answer').length, 2);
  assert.equal(t.calls.filter((c) => c.role === 'CRITIQUE').length, 2); // only the two that answered critique
  assert.match(t.calls.find((c) => c.role === 'CAPTAIN-SYNTHESIZE')!.prompt, /No input from: RFC Skeptic \(@rfc-skeptic\) \(timed out/);
  assert.equal(h.room.messages.filter((m) => m.council).length, 1);
});

test('captain synthesis failure still yields ONE reply (built from the member answers)', async () => {
  const h = harness();
  const base = scripted();
  const t: RoomTransport = { abort: base.abort, async turn(id, p, s) { if (/CAPTAIN-SYNTHESIZE/.test(p)) throw new Error('boom'); return base.turn(id, p, s); } };
  await h.run('x', t);
  const finals = h.room.messages.filter((m) => m.council);
  assert.equal(finals.length, 1);
  assert.match(finals[0].text, /could not write the summary \(boom\)/);
  assert.match(finals[0].text, /RFC Skeptic: RFC Skeptic: on/);
});

test('Stop: aborts every in-flight run, marks agents stopped, no final reply', async () => {
  const h = harness();
  const ac = new AbortController();
  const t = scripted({ 'rfc-lead': 20, 'rfc-skeptic': 5000, 'rfc-scribe': 5000 });
  setTimeout(() => ac.abort(), 250);
  const stop = await h.run('x', t, ac.signal, 60_000);
  assert.equal(stop, 'cancelled');
  assert.deepEqual([...t.aborts].sort(), ['rfc-scribe', 'rfc-skeptic']);
  assert.equal(h.council.phase, 'stopped');
  assert.equal(h.council.agents['rfc-skeptic'].status, 'stopped');
  assert.equal(h.room.messages.filter((m) => m.council).length, 0);
  assert.ok(h.room.messages.some((m) => m.from === 'system' && /council was cancelled/.test(m.text)));
});

test('@mention bypass: a mention skips the council (gating on); @all, no mention, or gating off run it', () => {
  const room = harness().room;
  assert.deepEqual(councilBypass(room, M, '@rfc-skeptic what do you think?'), ['rfc-skeptic']);
  assert.equal(councilBypass(room, M, 'what do you think?'), null);
  assert.equal(councilBypass(room, M, '@all what do you think?'), null);
  assert.equal(councilBypass({ ...room, mentionGating: false }, M, '@rfc-skeptic hi'), null);
});

// ---------- captain-led steering: the "not a loop" guarantees, one test each ----------

const rolesOf = (t: { calls: Call[] }) => t.calls.map((c) => c.role);
const count = (t: { calls: Call[] }, r: string) => t.calls.filter((c) => c.role === r).length;
const oneReply = (h: ReturnType<typeof harness>) => assert.equal(h.room.messages.filter((m) => m.council).length, 1, 'exactly one captain reply');
/** A transport whose CAPTAIN-STEER turns come from `decide(step)`; every other turn is the deterministic scripted reply. */
function steered(decide: (step: number, prompt: string) => string | Promise<string>, intercept?: (id: string, prompt: string, signal: AbortSignal) => Promise<string | null> | undefined) {
  const base = scripted();
  const t: RoomTransport & { calls: Call[]; aborts: string[] } = {
    calls: base.calls, aborts: base.aborts, abort: base.abort,
    async turn(id, prompt, signal) {
      if (/Council role: CAPTAIN-STEER/.test(prompt)) { base.calls.push({ id, role: 'CAPTAIN-STEER', t0: Date.now(), t1: Date.now(), prompt }); return decide(Number(/This is step (\d+) of/.exec(prompt)![1]), prompt); }
      return intercept?.(id, prompt, signal) ?? base.turn(id, prompt, signal);
    },
  };
  return t;
}
const ask = (targets: string[], question: string) => JSON.stringify({ action: 'ask', targets, question });

test('G3 parseDecision: strict JSON with a known action; everything else is invalid', () => {
  assert.deepEqual(parseDecision('{"action":"synthesize"}', M), { action: 'synthesize' });
  assert.deepEqual(parseDecision('```json\n{"action":"critique"}\n```', M), { action: 'critique' });
  assert.deepEqual(parseDecision('{"action":"ask","targets":["@RFC Scribe","rfc-lead","ghost","rfc-lead"],"question":" Who owns   rollback? ","unresolved":"owner"}', M),
    { action: 'ask', targets: ['rfc-lead', 'rfc-scribe'], question: 'Who owns rollback?', unresolved: 'owner' }); // member order, deduped, unknown dropped
  assert.equal(parseDecision('{"action":"ask","target":"rfc-scribe","question":"q"}', M).action, 'ask');
  for (const bad of ['', null, 'PASS', 'let us wrap up', '{"action":', '{"action":"dance"}', '{"action":"ask","targets":["ghost"],"question":"q"}', '{"action":"ask","targets":["rfc-lead"],"question":"  "}', '{"targets":["rfc-lead"]}', '{"action":7}']) {
    assert.equal(parseDecision(bad as never, M).action, 'invalid', String(bad));
  }
});

test('G-early finish: the captain stops right after the first answers; no follow-up, no critique, one reply', async () => {
  const h = harness();
  const t = scripted();
  assert.equal(await h.run('Should we ship? (no cue)', t), 'complete');
  assert.deepEqual(rolesOf(t), ['CAPTAIN-PLAN', 'SPECIALIST', 'SPECIALIST', 'SPECIALIST', 'CAPTAIN-STEER', 'CAPTAIN-SYNTHESIZE']);
  assert.equal(h.council.turnsUsed, 6);
  assert.deepEqual(h.council.stop, { reason: 'done' });
  assert.deepEqual(h.council.steps, []);
  assert.ok(h.council.notes.some((n) => n.kind === 'system' && /Captain is done/.test(n.text)));
  oneReply(h);
  assert.equal(h.council.phase, 'done');
});

test('G-follow-up: the captain asks chosen members a directed question; only they run; the synthesis sees their replies', async () => {
  const h = harness();
  const t = scripted();
  assert.equal(await h.run('Ship it? conflict', t), 'complete');
  const fu = t.calls.filter((c) => c.role === 'FOLLOW-UP');
  assert.deepEqual(fu.map((c) => c.id).sort(), ['rfc-lead', 'rfc-skeptic']); // rfc-scribe was not asked
  assert.ok(overlap(fu[0], fu[1]), 'directed follow-ups run in parallel');
  assert.match(fu[0].prompt, /The captain's question:\n@rfc-lead and @rfc-skeptic disagree on shipping as is: settle it\./);
  assert.match(fu.find((c) => c.id === 'rfc-lead')!.prompt, /Earlier answers from the other member\(s\) the captain is also asking:\nRFC Skeptic/); // head to head
  assert.deepEqual(h.council.steps, [{ step: 1, action: 'ask', targets: ['rfc-lead', 'rfc-skeptic'], question: '@rfc-lead and @rfc-skeptic disagree on shipping as is: settle it.', unresolved: 'whether to ship as is', outcome: 'answered' }]);
  assert.ok(h.council.notes.some((n) => n.kind === 'decision' && /^Step 1: asked RFC Lead, RFC Skeptic about: .*\nStill unresolved: whether to ship as is$/.test(n.text)));
  assert.equal(h.council.notes.filter((n) => n.kind === 'followup').length, 2);
  assert.match(t.calls.find((c) => c.role === 'CAPTAIN-SYNTHESIZE')!.prompt, /Follow-ups you asked for:\nRFC Lead \(@rfc-lead\), asked/);
  assert.deepEqual(h.council.stop, { reason: 'done' });
  assert.equal(h.council.turnsUsed, 9);
  oneReply(h);
});

test('G4 repeat: the same targets and question twice forces synthesis; the repeat is never sent', async () => {
  const h = harness();
  const t = scripted();
  assert.equal(await h.run('repeat', t), 'complete');
  assert.equal(count(t, 'FOLLOW-UP'), 1, 'asked once, the repeat was not run');
  assert.equal(count(t, 'CAPTAIN-STEER'), 2);
  assert.equal(t.calls.at(-1)!.role, 'CAPTAIN-SYNTHESIZE');
  assert.equal(h.council.stop?.reason, 'noProgress');
  assert.match(h.council.stop!.detail!, /repeated the same targets and question/);
  assert.equal(h.council.steps![1].outcome, 'repeat');
  assert.match(t.calls.at(-1)!.prompt, /ended before you finished \(No progress/);
  oneReply(h);
  // re-worded punctuation/case is still the same question; a different question or different targets is not
  const h2 = harness();
  const t2 = steered((step) => (step === 1 ? ask(['rfc-skeptic', 'rfc-lead'], 'Is the rollback SAFE?') : step === 2 ? ask(['rfc-lead', 'rfc-skeptic'], 'is the rollback safe') : '{"action":"synthesize"}'));
  await h2.run('x', t2);
  assert.equal(h2.council.stop?.reason, 'noProgress');
  const h3 = harness();
  const t3 = steered((step) => (step === 1 ? ask(['rfc-lead'], 'Is it safe?') : step === 2 ? ask(['rfc-skeptic'], 'Is it safe?') : '{"action":"synthesize"}'));
  await h3.run('x', t3);
  assert.deepEqual(h3.council.stop, { reason: 'done' });
  assert.equal(count(t3, 'FOLLOW-UP'), 2);
});

test('G4 no progress: every target replies PASS -> synthesis; every target times out or fails -> synthesis; a second critique request -> synthesis', async () => {
  const hp = harness();
  const tp = scripted();
  await hp.run('allpass', tp);
  assert.equal(hp.council.stop?.reason, 'noProgress');
  assert.match(hp.council.stop!.detail!, /every target replied PASS/);
  assert.equal(hp.council.steps![0].outcome, 'allPass');
  assert.equal(count(tp, 'CAPTAIN-STEER'), 1, 'no further steering after an all-PASS round');
  assert.equal(tp.calls.at(-1)!.role, 'CAPTAIN-SYNTHESIZE');
  oneReply(hp);

  const hf = harness();
  const tf = steered(() => ask(['rfc-skeptic', 'rfc-scribe'], 'What did you miss?'), (_id, p) => { if (/FOLLOW-UP/.test(p)) throw new Error('gateway down'); return undefined; });
  await hf.run('x', tf);
  assert.equal(hf.council.stop?.reason, 'noProgress');
  assert.match(hf.council.stop!.detail!, /every target timed out or failed/);
  assert.equal(hf.council.steps![0].outcome, 'failed');
  assert.equal(count(tf, 'CAPTAIN-STEER'), 1);
  assert.equal(tf.calls.at(-1)!.role, 'CAPTAIN-SYNTHESIZE');
  oneReply(hf);

  const ht = harness();
  const slowSkeptic = scripted({ 'rfc-skeptic': 5000 });
  const tt = steered(() => ask(['rfc-skeptic'], 'Anything?'), (id, p, s) => (/FOLLOW-UP/.test(p) ? slowSkeptic.turn(id, p, s) : undefined));
  const t0 = Date.now();
  await ht.run('x', tt, undefined, 150);
  assert.ok(Date.now() - t0 < 2500);
  assert.equal(ht.council.stop?.reason, 'noProgress'); // the follow-up target timed out
  assert.equal(ht.council.agents['rfc-skeptic'].status, 'timeout');
  assert.ok(tt.aborts.includes('rfc-skeptic'), 'the timed-out run was aborted');
  oneReply(ht);

  const hc = harness();
  const tc = steered((step) => (step <= 2 ? '{"action":"critique"}' : '{"action":"synthesize"}'));
  await hc.run('x', tc);
  assert.equal(count(tc, 'CRITIQUE'), 3, 'the critique round runs once');
  assert.equal(hc.council.stop?.reason, 'noProgress');
  assert.match(hc.council.stop!.detail!, /second critique/);
  oneReply(hc);
});

test('G2 step limit: maxSteps bounds captain decisions (default 3, max 4); hitting it forces synthesis without asking again', async () => {
  for (const [maxSteps, want] of [[1, 1], [2, 2], [3, 3], [4, 4], [9, 4]] as const) {
    const h = harness({ maxSteps, maxTurns: 32 });
    const t = scripted();
    const stop = await h.run('endless', t);
    assert.equal(count(t, 'FOLLOW-UP'), want, `maxSteps ${maxSteps}`);
    assert.equal(count(t, 'CAPTAIN-STEER'), want, 'the captain is not asked again once the limit is reached');
    assert.equal(h.council.steps!.length, want);
    assert.equal(h.council.stop?.reason, 'stepLimit');
    assert.equal(h.council.maxSteps, want);
    assert.equal(stop, 'complete', 'a step limit is a normal end, not a cap');
    assert.equal(t.calls.at(-1)!.role, 'CAPTAIN-SYNTHESIZE');
    assert.ok(h.council.notes.some((n) => /Step limit reached/.test(n.text)));
    oneReply(h);
  }
});

test('G3 cap: hitting maxTurns mid-conversation still synthesizes; never exceeds maxTurns; one reply', async () => {
  for (let cap = 1; cap <= 10; cap++) {
    const h = harness({ maxTurns: cap, maxSteps: 4 });
    h.council.maxTurns = cap;
    const t = scripted();
    const stop = await h.run('endless', t);
    assert.ok(t.calls.length <= cap, `cap ${cap}: ${t.calls.length} turns`);
    assert.equal(h.council.turnsUsed, t.calls.length);
    assert.equal(t.calls.at(-1)!.role, 'CAPTAIN-SYNTHESIZE', `cap ${cap}`);
    assert.equal(stop, 'maxTurns', `cap ${cap}`);
    oneReply(h);
    assert.ok(h.room.messages.some((m) => m.from === 'system' && /Turn cap reached/.test(m.text)));
  }
  const h = harness({ maxTurns: 7, maxSteps: 4 });
  h.council.maxTurns = 7;
  await h.run('endless', scripted());
  assert.equal(h.council.stop?.reason, 'cap');
  assert.ok(h.council.notes.some((n) => /Turn cap reached/.test(n.text)));
  const roomy = harness({ maxTurns: 11 });
  assert.equal(await roomy.run('endless', scripted()), 'complete'); // plenty of turns: the step limit, not the cap, ends it
});

test('G5 malformed / unknown / failed captain decision: synthesize, exactly one decision turn, no retry', async () => {
  const cases: Array<[string, (step: number) => string | Promise<string>]> = [
    ['prose', () => 'Honestly we are fine, wrap up.'],
    ['broken json', () => '{"action":"ask","targets":['],
    ['unknown action', () => '{"action":"delegate","targets":["rfc-lead"]}'],
    ['ask with an unknown member', () => ask(['ghost'], 'q')],
    ['ask without a question', () => JSON.stringify({ action: 'ask', targets: ['rfc-lead'] })],
    ['empty reply', () => 'PASS'],
  ];
  for (const [name, decide] of cases) {
    const h = harness();
    const t = steered(decide);
    assert.equal(await h.run('x', t), 'complete', name);
    assert.equal(count(t, 'CAPTAIN-STEER'), 1, `${name}: no retry`);
    assert.equal(count(t, 'FOLLOW-UP') + count(t, 'CRITIQUE'), 0, name);
    assert.equal(t.calls.at(-1)!.role, 'CAPTAIN-SYNTHESIZE', name);
    assert.equal(h.council.stop?.reason, 'malformed', name);
    oneReply(h);
  }
  const hb = harness();
  const tb = scripted();
  await hb.run('badsteer', tb);
  assert.equal(hb.council.stop?.reason, 'malformed');
  // the captain's own turn failing is the same: synthesize, no retry
  const hf = harness();
  const tf = steered(() => { throw new Error('boom'); });
  await hf.run('x', tf);
  assert.equal(count(tf, 'CAPTAIN-STEER'), 1);
  assert.deepEqual(hf.council.stop, { reason: 'captainFailed', detail: 'boom' });
  assert.equal(tf.calls.at(-1)!.role, 'CAPTAIN-SYNTHESIZE');
  oneReply(hf);
});

test('G2/G3 sweep: whatever the captain does, turns <= maxTurns, the last turn is the synthesis, and there is exactly one reply', async () => {
  const cues = ['x', 'endless', 'repeat', 'conflict', 'crit', 'allpass', 'badsteer', 'routeme conflict'];
  for (const cue of cues) {
    for (const maxTurns of [1, 2, 3, 4, 5, 6, 8, 9, 12, 16, 32]) {
      for (const maxSteps of [1, 3, 4]) {
        const h = harness({ maxTurns, maxSteps });
        h.council.maxTurns = maxTurns;
        const t = scripted();
        await h.run(cue, t);
        const ctx = `cue=${cue} maxTurns=${maxTurns} maxSteps=${maxSteps}`;
        assert.ok(t.calls.length <= maxTurns, `${ctx}: ${t.calls.length} turns`);
        assert.equal(h.council.turnsUsed, t.calls.length, ctx);
        assert.equal(t.calls.at(-1)!.role, 'CAPTAIN-SYNTHESIZE', ctx);
        assert.ok(count(t, 'CAPTAIN-STEER') >= h.council.steps!.length, ctx);
        assert.ok(h.council.steps!.length <= maxSteps, ctx);
        assert.ok(count(t, 'CAPTAIN-STEER') <= maxSteps + 1, ctx);
        assert.equal(h.room.messages.filter((m) => m.council).length, 1, ctx);
        assert.ok(h.council.stop, ctx);
        assert.equal(h.council.phase, 'done', ctx);
      }
    }
  }
});

test('G1 members cannot route: @mentions in member replies start nothing; only the captain\'s decision starts a follow-up, and only for its targets', async () => {
  const h = harness();
  const t = scripted();
  await h.run('routeme', t); // every specialist reply says "@<other member> please weigh in."
  assert.ok(h.council.notes.filter((n) => n.kind === 'answer').every((n) => /@rfc-/.test(n.text)), 'the replies do contain @mentions');
  assert.deepEqual(rolesOf(t), ['CAPTAIN-PLAN', 'SPECIALIST', 'SPECIALIST', 'SPECIALIST', 'CAPTAIN-STEER', 'CAPTAIN-SYNTHESIZE'], 'no extra turns from the mentions');
  assert.equal(t.calls.filter((c) => c.role === 'SPECIALIST').length, 3);
  oneReply(h);
  // follow-up replies mention a member too: still nothing extra, and the mentioned member was not in the captain's targets
  const h2 = harness();
  const t2 = steered((step) => (step === 1 ? ask(['rfc-skeptic'], 'One question for you.') : '{"action":"synthesize"}'));
  await h2.run('routeme', t2);
  const fu = t2.calls.filter((c) => c.role === 'FOLLOW-UP');
  assert.deepEqual(fu.map((c) => c.id), ['rfc-skeptic']);
  assert.ok(h2.council.notes.some((n) => n.kind === 'followup' && /@rfc-lead/.test(n.text)));
  assert.equal(count(t2, 'SPECIALIST'), 3);
  assert.equal(t2.calls.filter((c) => c.id === 'rfc-lead' && c.role !== 'CAPTAIN-PLAN' && c.role !== 'SPECIALIST' && c.role !== 'CAPTAIN-STEER' && c.role !== 'CAPTAIN-SYNTHESIZE').length, 0, 'rfc-lead was never asked a follow-up');
  assert.equal(count(t2, 'CAPTAIN-STEER'), 2);
  // prompts never invite member-to-member routing
  assert.ok(t2.calls.filter((c) => c.role === 'SPECIALIST' || c.role === 'FOLLOW-UP').every((c) => /Do not message other members/.test(c.prompt)));
  // the decision parser has no notion of mentions: a decision that hides a target in prose is invalid
  assert.equal(parseDecision('{"action":"ask","question":"hi @rfc-lead"}', M).action, 'invalid');
});

test('G6 Stop during a follow-up aborts the in-flight runs and ends cancelled, no reply; the per-member timeout still cuts a slow follow-up', async () => {
  const h = harness();
  const ac = new AbortController();
  const slow = scripted({ 'rfc-skeptic': 5000, 'rfc-lead': 5000 });
  const t = steered((step) => (step === 1 ? ask(['rfc-skeptic', 'rfc-lead'], 'Settle this.') : '{"action":"synthesize"}'), (id, p, s) => (/FOLLOW-UP/.test(p) ? slow.turn(id, p, s) : undefined));
  setTimeout(() => ac.abort(), 300);
  const stop = await h.run('x', t, ac.signal, 60_000);
  assert.equal(stop, 'cancelled');
  assert.deepEqual([...t.aborts].sort(), ['rfc-lead', 'rfc-skeptic']);
  assert.equal(h.council.phase, 'stopped');
  assert.equal(h.council.stop?.reason, 'cancelled');
  assert.equal(h.room.messages.filter((m) => m.council).length, 0);
  assert.equal(count(t, 'CAPTAIN-SYNTHESIZE'), 0);
  assert.ok(h.room.messages.some((m) => m.from === 'system' && /council was cancelled/.test(m.text)));
});

test('a follow-up from a member that missed the first round counts as an answer', async () => {
  const h = harness();
  const base = scripted({ 'rfc-scribe': 5000 });
  const t = steered((step) => (step === 1 ? ask(['rfc-scribe'], 'Now that the rest answered, your take?') : '{"action":"synthesize"}'), (id, p, s) => (/SPECIALIST/.test(p) && id === 'rfc-scribe' ? base.turn(id, p, s) : undefined));
  await h.run('x', t, undefined, 150);
  assert.equal(h.council.agents['rfc-scribe'].status, 'done');
  assert.doesNotMatch(t.calls.find((c) => c.role === 'CAPTAIN-SYNTHESIZE')!.prompt, /No input from: RFC Scribe/);
  assert.equal(h.council.stop?.reason, 'done');
});
