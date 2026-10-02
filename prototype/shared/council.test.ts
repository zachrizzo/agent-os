import assert from 'node:assert/strict';
import { test } from 'node:test';
import { councilBypass, parsePlan, pickContrarian, runCouncil, type CouncilHooks } from './council.ts';
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
  const room: Room = { id: 'r1', name: 'T', members: members.map((m) => m.id), captain: 'rfc-lead', councils: [], archived: false, createdAt: 0, updatedAt: 0, messages: [], maxRounds: 1, maxTurns: 16, mentionGating: true, mode: 'council', memberTimeoutSec: 90, ...settings };
  let n = 0;
  const state: Partial<RoomRunState> = {};
  const hooks: CouncilHooks = {
    append: (m) => { const x = { ...m, id: `m${n++}`, ts: n } as RoomMessage; room.messages.push(x); return x; },
    save: () => {}, state: (p) => Object.assign(state, p),
  };
  const trigger = hooks.append({ from: 'you', text: '' });
  const council: Council = { id: trigger.id, captain: room.captain, phase: 'planning', startedAt: 0, agents: {}, notes: [], turnsUsed: 0, maxTurns: room.maxTurns };
  room.councils.push(council);
  const run = (text: string, transport: RoomTransport, signal = new AbortController().signal, timeoutMs = 5000) => { trigger.text = text; return runCouncil(room, members, trigger, council, transport, hooks, signal, { memberTimeoutMs: timeoutMs }); };
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

test('full flow: plan -> parallel work -> parallel critique -> ONE captain reply; turns = 2n+2', async () => {
  const h = harness();
  const t = scripted({ 'rfc-lead': 120, 'rfc-skeptic': 120, 'rfc-scribe': 120 });
  const stop = await h.run('Should we ship the RFC? conflict', t);
  assert.equal(stop, 'complete');
  const roles = (r: string) => t.calls.filter((c) => c.role === r);
  assert.equal(roles('CAPTAIN-PLAN').length, 1);
  assert.equal(roles('SPECIALIST').length, 3);
  assert.equal(roles('CRITIQUE').length, 3);
  assert.equal(roles('CAPTAIN-SYNTHESIZE').length, 1);
  assert.equal(h.council.turnsUsed, 8);
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
  await h.run('Pick a database', t);
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
  await h.run('x', t);
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
  await h.run('x', t, undefined, 150);
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

test('maxTurns is a hard cap across all phases', async () => {
  for (const cap of [1, 2, 3, 4, 5, 6, 7]) {
    const h = harness({ maxTurns: cap });
    const t = scripted();
    h.council.maxTurns = cap;
    const stop = await h.run('x', t);
    assert.ok(t.calls.length <= cap, `cap ${cap}: ${t.calls.length} turns`);
    assert.equal(h.council.turnsUsed, t.calls.length);
    assert.equal(h.room.messages.filter((m) => m.council).length, 1, `cap ${cap}: still one reply`);
    assert.equal(stop, 'maxTurns');
    assert.equal(t.calls.at(-1)!.role, 'CAPTAIN-SYNTHESIZE');
    assert.ok(h.room.messages.some((m) => m.from === 'system' && /Turn cap reached/.test(m.text)));
  }
  const full = harness({ maxTurns: 8 });
  assert.equal(await full.run('x', scripted()), 'complete');
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
