import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  classifyFailure, discussionBlock, isExcludedAgent, isPass, memberPrompt, migrateRoom, normalizeSettings, parseMentions, retryDelayMs, runDiscussion, selectResponders,
  type Room, type RoomMember, type RoomMessage, type RoomRunState, type RoomTransport,
} from './rooms.ts';
import { scriptedReply } from './scripted.ts';

const M: RoomMember[] = [{ id: 'alpha', name: 'Alpha' }, { id: 'bravo', name: 'Bravo' }, { id: 'forge-coder', name: 'Forge Coder' }];

test('mentions: by id or display name, case-insensitive, member order; @all means everyone', () => {
  assert.deepEqual(parseMentions('hey @bravo and @ALPHA', M), ['alpha', 'bravo']);
  assert.deepEqual(parseMentions('@forgecoder please', M), ['forge-coder']);
  assert.deepEqual(parseMentions('mail me at a@bravo.com', M), []);
  assert.equal(parseMentions('@all status?', M), null);
});

test('gating: no mention = everyone, mention = only those, gating off = everyone', () => {
  assert.deepEqual(selectResponders('status?', M, true), ['alpha', 'bravo', 'forge-coder']);
  assert.deepEqual(selectResponders('@bravo status?', M, true), ['bravo']);
  assert.deepEqual(selectResponders('@bravo status?', M, false), ['alpha', 'bravo', 'forge-coder']);
});

const DEFAULTS = { mentionGating: true, responderMode: 'everyone', pauseAfterPosts: 24, pauseAfterTokens: 0, speakFilter: false };
test('settings: mention gating, responder mode, soft-pause limits and the opt-in speak filter; the pipeline settings are gone', () => {
  assert.deepEqual(normalizeSettings(undefined), DEFAULTS);
  assert.deepEqual(normalizeSettings({ mentionGating: false }), { ...DEFAULTS, mentionGating: false });
  assert.deepEqual(normalizeSettings({ maxSteps: 3, mode: 'council', maxRounds: 4 } as never), DEFAULTS);
  assert.deepEqual(normalizeSettings({ responderMode: 'lead', pauseAfterPosts: 0, pauseAfterTokens: 5000, speakFilter: true }), { ...DEFAULTS, responderMode: 'lead', pauseAfterPosts: 0, pauseAfterTokens: 5000, speakFilter: true });
  assert.deepEqual(normalizeSettings({ responderMode: 'bogus', pauseAfterPosts: -4, speakFilter: 'yes' } as never), { ...DEFAULTS, pauseAfterPosts: 0 }, 'bad values fall back; the speak filter is on only for a real true');
});

test('phi is excluded, near-misses are not', () => {
  for (const id of ['phi', 'PHI', 'phi-gateway']) assert.ok(isExcludedAgent(id), id);
  for (const id of ['phil', 'sophie', 'alpha']) assert.ok(!isExcludedAgent(id), id);
});

test('pass detection', () => {
  for (const r of ['PASS', ' pass. ', 'NO_REPLY', '', null]) assert.ok(isPass(r), String(r));
  assert.ok(!isPass('PASS on that, but here is why'));
});

test('migrateRoom: retired pipeline fields dropped, the council and final flags on messages are dropped', () => {
  const old = { id: 'r00000001', name: 'x', members: ['a', 'b'], mode: 'council', maxRounds: 2, maxSteps: 3, councils: [{ id: 'm1' }], maxTurns: 6, captain: 'b', archived: false, createdAt: 1, updatedAt: 1,
    messages: [{ id: 'm1', ts: 1, from: 'you', text: 'q' }, { id: 'm2', ts: 2, from: 'b', text: 'answer', council: 'm1' }] } as unknown as Room;
  const r = migrateRoom(old) as Room & Record<string, unknown>;
  for (const k of ['mode', 'maxRounds', 'maxSteps', 'councils', 'maxTurns']) assert.ok(!(k in r), k);
  assert.equal(r.captain, 'b');
  assert.deepEqual(r.messages[1], { id: 'm2', ts: 2, from: 'b', text: 'answer' });
  assert.deepEqual(migrateRoom({ ...old, councils: [], messages: [{ id: 'm3', ts: 3, from: 'b', text: 'x', final: true } as never] } as Room).messages, [{ id: 'm3', ts: 3, from: 'b', text: 'x' }]);
});

// ---- the discussion loop, against a scripted transport

function setup(text: string, members = M, captain = 'alpha', extra: Partial<Room> = {}) {
  const room: Room = { id: 'r00000001', name: 'Test', members: members.map((m) => m.id), captain, ...normalizeSettings(undefined), archived: false, createdAt: 0, updatedAt: 0, messages: [], ...extra };
  let n = 0;
  const hooks = {
    append(m: Omit<RoomMessage, 'id' | 'ts'>) { const msg = { ...m, id: `m${n++}`, ts: n }; room.messages.push(msg); return msg; },
    state(p: Partial<RoomRunState>) { Object.assign(state, p); },
  };
  const state = { round: 1, turnsUsed: 0, active: [] as string[] } as RoomRunState;
  const trigger = hooks.append({ from: 'you', text });
  return { room, hooks, trigger, state };
}
const scripted: RoomTransport = { async turn(_agent, prompt) { return scriptedReply(prompt); } };
const who = (room: Room) => room.messages.filter((m) => m.from !== 'system').map((m) => m.from);
const run = (s: ReturnType<typeof setup>, t: RoomTransport = scripted, members = M) => runDiscussion(s.room, members, s.trigger, t, s.hooks, new AbortController().signal);

test('open discussion: everyone replies, members build on each other, and it ends when a whole round is PASS: no final answer, no wrap-up', async () => {
  const s = setup('Should we ship Thursday?');
  const prompts: string[] = [];
  const reason = await run(s, { async turn(a, p) { prompts.push(p); return scriptedReply(p); } });
  assert.equal(reason, 'passed');
  // round 1: bravo + forge-coder (in parallel), then the lead alpha; round 2: bravo builds on forge-coder; round 3: all pass
  assert.equal(who(s.room)[0], 'you');
  assert.deepEqual(new Set(who(s.room).slice(1, 3)), new Set(['bravo', 'forge-coder']));
  assert.equal(who(s.room)[3], 'alpha');
  assert.ok(s.room.messages.some((m) => m.from === 'bravo' && /Building on/.test(m.text)), 'a member replies to another member in the open');
  assert.equal(who(s.room).length, 5, 'nothing is posted after the last real reply');
  assert.ok(!s.room.messages.some((m) => 'final' in m), 'no final bubble');
  assert.ok(!prompts.some((p) => /FINAL|WRAP-UP/i.test(p)), 'no prompt asks for a final answer');
  assert.equal(Math.max(...prompts.map((p) => Number(/It is round (\d+)\./.exec(p)?.[1] ?? 1))), 3);
});

test('every member sees the whole discussion so far, and is told to PASS when it has nothing to add; the lead moderates instead of concluding', async () => {
  const prompts: string[] = [];
  const t: RoomTransport = { async turn(_a, p) { prompts.push(p); return scriptedReply(p); } };
  await run(setup('Should we ship Thursday?'), t);
  const round2 = prompts.find((p) => /It is round 2\./.test(p) && /You are Forge Coder/.test(p))!;
  assert.match(round2, /Alpha: Alpha here/);
  assert.match(round2, /Bravo: Bravo here/);
  assert.match(round2, /Reply if you can add something/);
  assert.match(round2, /reply exactly PASS/);
  assert.match(round2, /ends when everyone passes/);
  const lead = prompts.find((p) => /It is round 2\./.test(p) && /You are Alpha/.test(p))!;
  assert.match(lead, /You are the lead: you moderate this discussion/);
  assert.match(lead, /You do not conclude the discussion/);
  assert.ok(!/You are the lead/.test(round2), 'members do not get the lead instructions');
});

test('a quiet round of short acknowledgements is NOT cut off: only PASS ends it', async () => {
  let round2 = 0;
  const t: RoomTransport = { async turn(a, p) { const r = Number(/It is round (\d+)\./.exec(p)?.[1] ?? 1); if (r === 2) round2++; return r <= 3 ? (a === 'alpha' ? 'PASS' : 'Agreed.') : 'PASS'; } };
  const s = setup('ship?');
  assert.equal(await run(s, t), 'passed');
  assert.ok(round2 >= 2, 'round 2 still ran: "Agreed." is a reply');
  assert.ok(s.room.messages.filter((m) => m.text === 'Agreed.').length >= 6, 'rounds 1-3 each had two agreeing replies');
});

test('there is no round cap: a long discussion keeps going until a round of PASS', async () => {
  let rounds = 0;
  const t: RoomTransport = { async turn(a, p) { const r = Number(/It is round (\d+)\./.exec(p)?.[1] ?? 1); rounds = Math.max(rounds, r); return r < 60 ? `${a} point number ${r}` : 'PASS'; } };
  const s = setup('long one');
  assert.equal(await run(s, t), 'passed');
  assert.equal(rounds, 60);
  assert.ok(!s.room.messages.some((m) => m.from === 'system'), 'no cap note');
});

test('the lead may steer by @mention and a steering lead keeps the discussion going; a lead that summarises on request is a normal message', async () => {
  const t: RoomTransport = { async turn(a, p) {
    const r = Number(/It is round (\d+)\./.exec(p)?.[1] ?? 1);
    if (a === 'alpha') return r === 1 ? 'My take is to ship.' : r === 2 ? '@bravo can you size the rollback?' : r === 3 ? 'Summary for Zach: ship Thursday behind the flag, bravo owns rollback.' : 'PASS';
    return r === 1 ? 'Take.' : r === 3 ? 'Rollback is a day of work.' : 'PASS';
  } };
  const s = setup('ship? summary please');
  assert.equal(await run(s, t), 'passed');
  const sum = s.room.messages.find((m) => /Summary for Zach/.test(m.text))!;
  assert.equal(sum.from, 'alpha');
  assert.ok(!('final' in sum));
});

test("an @mention in Zach's message is a direct question: only they reply, handoffs pull others in", async () => {
  const s = setup('@bravo status?');
  assert.equal(await run(s), 'complete');
  assert.deepEqual(who(s.room), ['you', 'bravo']);
  const hand: RoomTransport = { async turn(a, p) { return a === 'bravo' && /round 1/.test(p) ? '@forge-coder can you check?' : a === 'forge-coder' ? 'Checked: fine.' : 'PASS'; } };
  const h = setup('@bravo status?');
  await run(h, hand);
  assert.deepEqual(who(h.room), ['you', 'bravo', 'forge-coder']);
});

const FAST = { retryDelayMs: () => 1 };
const runFast = (s: ReturnType<typeof setup>, t: RoomTransport, members = M) => runDiscussion(s.room, members, s.trigger, t, s.hooks, new AbortController().signal, FAST);
const sysNotes = (room: Room) => room.messages.filter((m) => m.from === 'system').map((m) => m.text);

test('classifyFailure: rate limit and overload are transient; auth and billing are terminal (billing wins over a 429); timeouts and unknowns are not retried', () => {
  for (const m of ['429 Too Many Requests', 'rate_limit_error: slow down', 'HTTP 529 overloaded_error', '503 Service Unavailable']) assert.equal(classifyFailure(new Error(m)).kind, 'transient', m);
  assert.equal(classifyFailure(new Error('429 rate limit')).label, 'rate limit');
  assert.equal(classifyFailure(new Error('overloaded')).label, 'overloaded');
  for (const m of ['401 Unauthorized', 'invalid api key', '403 Forbidden', 'OAuth token expired']) assert.deepEqual(classifyFailure(new Error(m)), { kind: 'terminal', label: 'auth' }, m);
  for (const m of ['402 payment required', 'Your credit balance is too low', '429 insufficient_quota', 'billing hard limit reached']) assert.deepEqual(classifyFailure(new Error(m)), { kind: 'terminal', label: 'billing' }, m);
  for (const m of ['chat.send failed', 'the run ended without a reply (model unavailable?)', 'ETIMEDOUT', 'socket hang up']) assert.equal(classifyFailure(new Error(m)).kind, 'unknown', m);
  assert.equal(classifyFailure({ status: 429 }).kind, 'transient');
  assert.equal(classifyFailure('overloaded').kind, 'transient');
  assert.equal(classifyFailure(undefined).kind, 'unknown');
});

test('retry backoff doubles, is capped, and is jittered +-25%', () => {
  assert.equal(retryDelayMs(0, () => 0.5), 1000);
  assert.equal(retryDelayMs(1, () => 0.5), 2000);
  assert.equal(retryDelayMs(10, () => 0.5), 8000);
  assert.equal(retryDelayMs(0, () => 0), 750);
  assert.equal(retryDelayMs(0, () => 1), 1250);
});

test('a transient failure is retried and the member then answers normally: no failure note, no extra post', async () => {
  const calls: Record<string, number> = {};
  const t: RoomTransport = { async turn(a, p) { calls[a] = (calls[a] ?? 0) + 1; if (a === 'bravo' && calls[a] <= 2) throw new Error('429 rate limit exceeded'); return scriptedReply(p); } };
  const s = setup('ship?');
  assert.equal(await runFast(s, t), 'passed');
  assert.ok(who(s.room).includes('bravo'), 'bravo replied after two retries');
  assert.deepEqual(sysNotes(s.room), []);
  assert.equal(calls.bravo > 2, true);
});

test('a transient failure that keeps failing stops after two retries, shows in the room, and the run is "failed", never "passed"', async () => {
  let bravo = 0;
  const t: RoomTransport = { async turn(a) { if (a === 'bravo') { bravo++; throw new Error('529 overloaded'); } return 'PASS'; } };
  const s = setup('ship?');
  assert.equal(await runFast(s, t), 'failed');
  assert.ok(bravo >= 3 && bravo <= 3 * 2, `bravo tried 1 + 2 retries per failed round, got ${bravo}`);
  assert.ok(sysNotes(s.room).some((n) => /Bravo could not answer \(overloaded, still failing after 2 retries\)/.test(n)), sysNotes(s.room).join(' | '));
  assert.ok(sysNotes(s.room).some((n) => /Not treated as everyone passing/.test(n)));
});

test('auth and billing failures are terminal: one try, a note, the member is not asked again, and the run is "failed"', async () => {
  for (const [msg, label] of [['401 unauthorized: invalid api key', 'auth'], ['402 credit balance is too low', 'billing']]) {
    let bravo = 0;
    const t: RoomTransport = { async turn(a, p) { if (a === 'bravo') { bravo++; throw new Error(msg); } return scriptedReply(p); } };
    const s = setup('ship?');
    assert.equal(await runFast(s, t), 'failed', msg);
    assert.equal(bravo, 1, `${label}: never retried, never asked again`);
    assert.ok(sysNotes(s.room).some((n) => new RegExp(`Bravo could not answer \\(${label} error, not retried\\)`).test(n)), sysNotes(s.room).join(' | '));
    assert.ok(who(s.room).includes('alpha') && who(s.room).includes('forge-coder'), 'the others still talked');
  }
});

test('an unclassified failure is not retried, shows in the room, and is not a pass', async () => {
  let bravo = 0;
  const t: RoomTransport = { async turn(a, p) { if (a === 'bravo') { bravo++; throw new Error('boom'); } return scriptedReply(p); } };
  const s = setup('ship?');
  assert.equal(await runFast(s, t), 'failed');
  assert.equal(bravo >= 1, true);
  assert.ok(sysNotes(s.room).some((n) => /Bravo did not answer: boom/.test(n)));
  const down: RoomTransport = { async turn() { throw new Error('down'); } };
  assert.equal(await runFast(setup('ship?'), down), 'failed', 'everyone failing is not everyone passing');
});

test('a round where the others PASS but one turn failed does not end the run as "passed"', async () => {
  const t: RoomTransport = { async turn(a) { if (a === 'bravo') throw new Error('chat.send failed'); return 'PASS'; } };
  const s = setup('ship?');
  assert.equal(await runFast(s, t), 'failed');
  assert.equal(who(s.room).filter((x) => x !== 'you').length, 0);
  const clean: RoomTransport = { async turn() { return 'PASS'; } };
  assert.equal(await runFast(setup('ship?'), clean), 'passed', 'with no failure an all-PASS round still ends the run');
});

test('a failure while the others keep talking does not end the run: the failed member is asked again next round', async () => {
  let bravo = 0;
  const t: RoomTransport = { async turn(a, p) { if (a === 'bravo') { bravo++; if (bravo === 1) throw new Error('chat.send failed'); } return scriptedReply(p); } };
  const s = setup('ship?');
  assert.equal(await runFast(s, t), 'passed', 'bravo recovered in round 2 and the final round was clean');
  assert.ok(bravo >= 2);
});

test('a one-member room whose only turn fails is "failed"', async () => {
  const t: RoomTransport = { async turn() { throw new Error('chat.send failed'); } };
  assert.equal(await runFast(setup('hi', [M[0]]), t, [M[0]]), 'failed');
});

test('Stop cancels, also while a transient failure waits to be retried', async () => {
  const ac = new AbortController();
  const aborted: string[] = [];
  const p = setup('pingpong forever');
  const slow: RoomTransport = { turn: (_a, _p, sig) => new Promise<string>((_res, rej) => { sig.addEventListener('abort', () => rej(new Error('cancelled'))); setTimeout(() => ac.abort(), 5); }), abort: (id) => { aborted.push(id); } };
  assert.equal(await runDiscussion(p.room, M, p.trigger, slow, p.hooks, ac.signal), 'cancelled');
  assert.deepEqual(aborted.sort(), ['bravo', 'forge-coder']);

  const ac2 = new AbortController();
  const q = setup('ship?', [M[0]]);
  const limited: RoomTransport = { async turn() { setTimeout(() => ac2.abort(), 20); throw new Error('429 rate limit'); } };
  const t0 = Date.now();
  assert.equal(await runDiscussion(q.room, [M[0]], q.trigger, limited, q.hooks, ac2.signal, { retryDelayMs: () => 60_000 }), 'cancelled');
  assert.ok(Date.now() - t0 < 5000, 'the backoff sleep ended at Stop');
  assert.deepEqual(sysNotes(q.room), [], 'no failure note after Stop');
});

test('a one-member room just answers once; the prompt carries the whole thread', async () => {
  const one = setup('hello?', [M[0]]);
  assert.equal(await run(one, scripted, [M[0]]), 'complete');
  assert.deepEqual(who(one.room), ['you', 'alpha']);
  const { room, trigger } = setup('q', M, 'alpha');
  room.messages.push({ id: 'x', ts: 9, from: 'bravo', text: 'first reply' });
  const p = memberPrompt({ room, members: M, agent: M[1], lead: M[0], trigger, round: 2, directed: false });
  assert.match(p, /Zach's message:\nq/);
  assert.match(p, /Bravo: first reply/);
  assert.equal(discussionBlock(room.messages, trigger, (id) => id).discussion, 'bravo: first reply');
});

// ---- rooms v2: modes, soft pause, queue, usage, notes, speak filter, end now

import { addUsage, detectLoop, emptyUsage, estimateUsage, handoffsOf, judgePrompt, parseJudge, sharedMemoryBlock, similarity, type RunHooks } from './rooms.ts';
import { PASS_TOKEN } from './rooms.ts';

const FRESH = ['The vendor quote doubled since last year.', 'A pilot with one team limits the blast radius.', 'Audits begin in March, so timing is tight.', 'Nobody owns the rollback if the pilot fails.', 'Exclude the legacy import path from scope.', 'We need a staging copy of production data.',
  'Training for support takes two weeks at least.', 'Docs lag behind the API by a full release.', 'Finance wants a forecast before approving spend.', 'Security must review the new data flow first.', 'Mobile clients cannot upgrade until the app ships.', 'Alerts are noisy and will hide real failures.',
  'The migration locks a hot table for minutes.', 'Customers on the old plan keep their current pricing.', 'Support volume doubles in the first week.'];
const speakOnce = (text = 'a fresh point') => { const seen = new Set<string>(); return async (a: string) => (seen.has(a) ? PASS_TOKEN : (seen.add(a), `${a}: ${text}`)); };
const runWith = (s: ReturnType<typeof setup>, t: RoomTransport, extra: Partial<RunHooks> = {}, members = M) =>
  runDiscussion(s.room, members, s.trigger, t, { ...s.hooks, ...extra }, new AbortController().signal);
/** Same as run(), with extra hooks (pause, queue, end, usage) layered over the setup's. */
const runH = (s: ReturnType<typeof setup>, t: RoomTransport, hooks: Partial<RunHooks>) => runWith(s, t, hooks);

test('responder modes: lead-first answers an unaddressed message alone, mentions-only answers nobody, @mentions and @all still work', () => {
  assert.deepEqual(selectResponders('status?', M, true, 'lead', 'bravo'), ['bravo']);
  assert.deepEqual(selectResponders('@forgecoder status?', M, true, 'lead', 'bravo'), ['forge-coder']);
  assert.deepEqual(selectResponders('@all status?', M, true, 'lead', 'bravo'), ['alpha', 'bravo', 'forge-coder']);
  assert.deepEqual(selectResponders('status?', M, true, 'mentions', 'bravo'), []);
  assert.deepEqual(selectResponders('@alpha status?', M, true, 'mentions', 'bravo'), ['alpha']);
  assert.deepEqual(selectResponders('status?', M, false, 'lead', 'bravo'), ['alpha', 'bravo', 'forge-coder'], 'gating off still means everyone');
  assert.deepEqual(selectResponders('status?', M, true, 'everyone', 'bravo'), ['alpha', 'bravo', 'forge-coder']);
});

test('lead-first: only the lead replies to an unaddressed message; a member it @mentions is pulled in; nobody else speaks', async () => {
  const s = setup('Where are we?', M, 'alpha', { responderMode: 'lead' });
  const asked: string[] = [];
  const reason = await run(s, { async turn(a, p) { asked.push(a); return a === 'alpha' && /round 1\./.test(p) ? 'Over to @bravo for the numbers.' : a === 'bravo' ? 'Numbers look fine.' : PASS_TOKEN; } });
  assert.equal(reason, 'complete');
  assert.deepEqual(who(s.room), ['you', 'alpha', 'bravo']);
  assert.ok(!asked.includes('forge-coder'), 'a member nobody addressed is never asked');
});

test('mentions-only: an unaddressed message starts no turns', async () => {
  const s = setup('anyone?', M, 'alpha', { responderMode: 'mentions' });
  let turns = 0;
  assert.equal(await run(s, { async turn() { turns++; return 'x'; } }), 'complete');
  assert.equal(turns, 0);
});

test('similarity and loop detection: identical or near-identical repeats and 3-lap rings are caught, genuine back-and-forth is not', () => {
  assert.equal(similarity('Ship it Thursday.', 'ship it   thursday.'), 1);
  assert.ok(similarity('we should add a rollback owner and a dry run before the flag flips', 'we should add a rollback owner and a dry run before flipping the flag') > 0.6);
  assert.equal(similarity('ok', 'yes'), 0);
  assert.deepEqual(detectLoop([{ from: 'a', text: 'please pick an owner for the rollback plan' }, { from: 'b', text: 'noted' }, { from: 'a', text: 'Please pick an owner for the rollback plan' }]), { kind: 'repeat', agents: ['a'] });
  // each lap paraphrases the last (word overlap ~0.6, below the repeat threshold) but the same members hand the same point round
  const lap = (extra: string) => ['a', 'b', 'c'].map((from) => ({ from, text: `${from} still wants an owner for the rollback plan before the flag flips ${extra}` }));
  assert.equal(detectLoop([...lap('please now'), ...lap('thanks again')]), null, 'two laps is not a ring yet');
  const ring = detectLoop([...lap('first time'), ...lap('second time'), ...lap('third time')]);
  assert.equal(ring?.kind, 'ring');
  assert.deepEqual(ring?.agents, ['a', 'b', 'c']);
  const talk = ['a', 'b', 'a', 'b', 'a', 'b'].map((from, i) => ({ from, text: ['Cost first: the vendor quote is double last year.', 'Risk is lower if we pilot with one team only.', 'Timing matters because audits start in March.', 'Who owns the rollback if the pilot fails?', 'Scope should exclude the legacy import path.', 'Tests need a staging copy of production data.'][i] }));
  assert.equal(detectLoop(talk), null, 'two members alternating with new content is a conversation');
  assert.equal(detectLoop([{ from: 'a', text: 'ok' }, { from: 'a', text: 'ok' }])?.kind, 'repeat', 'identical short text is still a repeat');
});

test('handoffs: a reply that @mentions members is a visible A -> B edge with a hop count; Zach speaking resets the chain', () => {
  const msgs: RoomMessage[] = [
    { id: '1', ts: 1, from: 'you', text: 'plan?' },
    { id: '2', ts: 2, from: 'alpha', text: 'Over to @bravo and @forge-coder' },
    { id: '3', ts: 3, from: 'bravo', text: 'Handing on to @alpha' },
    { id: '4', ts: 4, from: 'alpha', text: 'Done, thanks @alpha' }, // self mention is not a hand-off
    { id: '5', ts: 5, from: 'you', text: 'again' },
    { id: '6', ts: 6, from: 'bravo', text: 'no handoff here, just @all' },
    { id: '7', ts: 7, from: 'forge-coder', text: 'See @bravo' },
  ];
  const h = handoffsOf(msgs, M);
  assert.deepEqual(h.get('2'), { from: 'alpha', to: ['bravo', 'forge-coder'], hop: 1 });
  assert.deepEqual(h.get('3'), { from: 'bravo', to: ['alpha'], hop: 2 });
  assert.ok(!h.has('4') && !h.has('6'));
  assert.deepEqual(h.get('7'), { from: 'forge-coder', to: ['bravo'], hop: 1 });
});

test('soft pause after N posts: the run holds (status paused), Continue releases it, nothing is capped, and it still ends on an all-PASS round', async () => {
  const s = setup('go', M, 'alpha', { pauseAfterPosts: 3 });
  const states: Array<string | undefined> = [];
  let pauses = 0;
  let n = 0;
  const reason = await runH(s, { async turn(a, p) { // everybody keeps talking for 5 rounds with fresh text, then all PASS
    const round = Number(/It is round (\d+)\./.exec(p)?.[1] ?? 1);
    return round <= 5 ? FRESH[n++ % FRESH.length] : PASS_TOKEN;
  } }, { waitForContinue: async () => { pauses++; states.push(s.state.pause?.reason); }, state: (p) => { Object.assign(s.state, p); } });
  assert.equal(reason, 'passed', 'it never stopped by itself: it ended when everyone passed');
  assert.ok(pauses >= 4, `paused repeatedly (${pauses})`);
  assert.ok(states.every((r) => r === 'posts'));
  assert.equal(s.room.messages.filter((m) => m.from !== 'system' && m.from !== 'you').length, 15, 'every reply of all five rounds was posted: the pause only waits');
});

test('soft pause: with no pause hook (or the limit off) a long run is never paused', async () => {
  const s = setup('go', M, 'alpha', { pauseAfterPosts: 0 });
  let paused = 0;
  let r = 0;
  await runH(s, { async turn(a) { return r++ < 12 ? `${a} new ${r}` : PASS_TOKEN; } }, { waitForContinue: async () => { paused++; } });
  assert.equal(paused, 0);
});

test('soft pause on a repeat: an agent saying the same thing again pauses the run; Continue clears the history so it is not paused again at once', async () => {
  const s = setup('pingpong');
  const reasons: string[] = [];
  let rounds = 0;
  const reason = await runH(s, { async turn(a, p) { rounds = Math.max(rounds, Number(/It is round (\d+)\./.exec(p)?.[1] ?? 1)); return rounds > 4 ? PASS_TOKEN : scriptedReply(p); } },
    { waitForContinue: async () => { reasons.push(s.state.pause?.reason ?? ''); } });
  assert.equal(reason, 'passed');
  assert.equal(reasons[0], 'repeat');
  assert.match(s.state.pause?.detail ?? 'repeated an earlier reply', /repeated an earlier reply/);
});

test('soft pause on tokens: the ceiling counts tokens since Zach last spoke', async () => {
  const s = setup('go', M, 'alpha', { pauseAfterPosts: 0, pauseAfterTokens: 500 });
  const why: string[] = [];
  let r = 0;
  await runH(s, { async turn(a) { return r++ < 6 ? { text: `${a} new thought ${r}`, usage: { inputTokens: 100, outputTokens: 50 } } : PASS_TOKEN; } },
    { waitForContinue: async () => { why.push(s.state.pause?.reason ?? ''); } });
  assert.ok(why.length >= 1 && why.every((x) => x === 'tokens'), why.join());
});

test('Stop during a soft pause ends the run as cancelled (the hold is not a deadlock)', async () => {
  const s = setup('go', M, 'alpha', { pauseAfterPosts: 1 });
  const ac = new AbortController();
  const p = runDiscussion(s.room, M, s.trigger, { async turn(a) { return `${a} new ${Math.random()}`; } }, { ...s.hooks, waitForContinue: (sig) => new Promise<void>((res) => sig.addEventListener('abort', () => res(), { once: true })) }, ac.signal);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(s.state.status, 'paused');
  ac.abort();
  assert.equal(await p, 'cancelled');
});

test('queued Zach messages: hidden from the agents until the next round boundary, then they join, reset the pause counters, and the run answers them', async () => {
  const s = setup('first', M, 'alpha', { pauseAfterPosts: 4 });
  const prompts: string[] = [];
  const q: RoomMessage = { id: 'q1', ts: 99, from: 'you', text: 'also, what about cost?', queued: true };
  let handed = false;
  let answered = false;
  const reason = await runH(s, { async turn(a, p) { prompts.push(p); if (a === 'bravo' && !handed) { handed = true; s.room.messages.push(q); } if (a === 'forge-coder' && /round [2-9]/.test(p) && /what about cost/.test(p) && !answered) { answered = true; return 'Cost is small.'; } return a === 'alpha' || /round [2-9]/.test(p) ? PASS_TOKEN : `${a} ok`; } },
    { takeQueued: () => { const out = s.room.messages.filter((m) => m.queued); out.forEach((m) => delete m.queued); return out; } });
  assert.equal(reason, 'passed');
  const round1 = prompts.filter((p) => /round 1\./.test(p));
  assert.ok(round1.every((p) => !/what about cost/.test(p)), 'round 1 prompts do not contain the queued message');
  const later = prompts.filter((p) => /It is round [2-9]\./.test(p));
  assert.ok(later.length && later.every((p) => /You: also, what about cost\?/.test(p) && /Zach has posted again/.test(p)), 'later rounds show it and tell members to answer it');
  assert.ok(s.room.messages.some((m) => m.from === 'forge-coder' && /Cost is small/.test(m.text)));
});

test('a queued message that @mentions a member makes the next round a direct question to them', async () => {
  const s = setup('first');
  const asked: string[] = [];
  const q: RoomMessage = { id: 'q1', ts: 99, from: 'you', text: '@bravo and the budget?', queued: true };
  let handed = false;
  await runH(s, { async turn(a, p) { asked.push(`${a}@${/It is round (\d+)\./.exec(p)?.[1]}`); if (!handed) { handed = true; s.room.messages.push(q); } return Number(/It is round (\d+)\./.exec(p)?.[1]) === 1 ? `${a} ok` : PASS_TOKEN; } },
    { takeQueued: () => { const out = s.room.messages.filter((m) => m.queued); out.forEach((m) => delete m.queued); return out; } });
  assert.deepEqual(asked.filter((x) => x.endsWith('@2')), ['bravo@2'], 'only the addressed member answers round 2');
});

test('End now: turns in flight finish and post, nothing new starts, the run reports ended', async () => {
  const s = setup('go');
  let ending = false;
  const asked: string[] = [];
  const reason = await runH(s, { async turn(a) { asked.push(a); if (a === 'bravo') ending = true; return `${a} says hi`; } }, { ended: () => ending });
  assert.equal(reason, 'ended');
  assert.ok(who(s.room).includes('bravo') && who(s.room).includes('forge-coder'), 'in-flight replies were posted');
  assert.ok(!asked.includes('alpha') || asked.length <= 3, 'no second round');
  assert.equal(Math.max(...s.room.messages.map((m) => m.round ?? 1)), 1);
});

test('usage: the run totals tokens/cost per turn (estimated when the Gateway reports none) and tells the room via the hook', async () => {
  const s = setup('go', M.slice(0, 2), 'alpha');
  const perTurn: Array<[string, number]> = [];
  await runWith(s, { async turn(a, p) { return a === 'bravo' ? (/round 1\./.test(p) ? { text: 'hello there', usage: { inputTokens: 1000, outputTokens: 20, costUsd: 0.01 } } : PASS_TOKEN) : scriptedReply(p); } }, { usage: (a, u) => perTurn.push([a, u.inputTokens + u.outputTokens]) }, M.slice(0, 2));
  const u = s.state.usage!;
  assert.ok(u.turns >= 2 && u.inputTokens >= 1000 && u.costUsd >= 0.01);
  assert.equal(u.estimated, true, 'alpha reported nothing, so the total is flagged as estimated');
  assert.ok(perTurn.some(([a, n]) => a === 'bravo' && n === 1020));
  assert.equal(s.state.lastSpeaker !== undefined, true);
  assert.deepEqual(estimateUsage('abcdefgh', 'abcd'), { inputTokens: 2, outputTokens: 1, estimated: true });
  assert.deepEqual(addUsage(emptyUsage(), { inputTokens: 5, outputTokens: 6, costUsd: 0.5 }), { turns: 1, inputTokens: 5, outputTokens: 6, costUsd: 0.5, estimated: false });
});

test('participants strip: a member shows thinking, then the tool it is using; the lead shows waiting on the others', async () => {
  const s = setup('go', M.slice(0, 2), 'alpha');
  const seen: string[] = [];
  const hooks = { ...s.hooks, state(p: Partial<RoomRunState>) { Object.assign(s.state, p); for (const a of p.activity ?? []) seen.push(`${a.id}:${a.state}${a.tool ? `:${a.tool}` : ''}${a.waitingOn ? `:${a.waitingOn.join('+')}` : ''}`); } };
  await runDiscussion(s.room, M.slice(0, 2), s.trigger, { async turn(a, p, _sig, progress) { if (a === 'bravo') { progress?.({ tool: 'web_search' }); await new Promise((r) => setTimeout(r, 5)); } return scriptedReply(p); } }, hooks, new AbortController().signal);
  assert.ok(seen.includes('alpha:waiting:bravo'), 'the lead waits for bravo');
  assert.ok(seen.includes('bravo:tool:web_search'));
  assert.ok(seen.includes('bravo:thinking'));
  assert.deepEqual(s.state.activity, [], 'nobody is active once the run is over');
});

test('shared notes and pinned decisions are quoted to every member each turn; queued and system messages are not', () => {
  const room = { notes: 'Budget is 5k. Never touch prod.', messages: [
    { id: '1', ts: 1, from: 'you', text: 'q' }, { id: '2', ts: 2, from: 'alpha', text: 'We ship Thursday behind the flag.', pinned: true }, { id: '3', ts: 3, from: 'system', text: 'x', pinned: true },
  ] as RoomMessage[] };
  const block = sharedMemoryBlock(room, (id) => (id === 'alpha' ? 'Alpha' : id));
  assert.match(block, /Room notes \(kept by Zach\):\nBudget is 5k/);
  assert.match(block, /Pinned decisions:\n- Alpha: We ship Thursday/);
  assert.ok(!/system|: x/.test(block));
  assert.equal(sharedMemoryBlock({ messages: [] }, String), '');
  const s = setup('q', M, 'alpha', { notes: 'Budget is 5k.' });
  s.room.messages.push({ id: 'm9', ts: 9, from: 'alpha', text: 'Pinned point', pinned: true });
  const p = memberPrompt({ room: s.room, members: M, agent: M[1], lead: M[0], trigger: s.trigger, round: 1, directed: false });
  assert.match(p, /Room notes \(kept by Zach\):\nBudget is 5k\./);
  assert.match(p, /Pinned decisions:\n- Alpha: Pinned point/);
});

test('speak filter (opt-in): off by default it is never called; on, it skips members with nothing to add from round 2, never skips a member handed a point, never filters round 1, and fails open', async () => {
  const mk = (extra: Partial<Room>) => setup('go', M, 'alpha', extra);
  const roundsOf = (log: string[]) => Math.max(...log.map((l) => Number(l.split('@')[1])));
  // off: judge never called
  let judged = 0;
  const log0: string[] = [];
  await run(mk({}), { async turn(a, p) { log0.push(`${a}@${/It is round (\d+)\./.exec(p)?.[1] ?? 1}`); return scriptedReply(p); }, async judge() { judged++; return '{"speak":[]}'; } });
  assert.equal(judged, 0);
  assert.equal(roundsOf(log0), 3);
  // on, judge says nobody has anything to add: the run ends after round 1 and turns were saved
  const on = mk({ speakFilter: true });
  const log1: string[] = [];
  const reason = await run(on, { async turn(a, p) { log1.push(`${a}@${/It is round (\d+)\./.exec(p)?.[1] ?? 1}`); return scriptedReply(p); }, async judge() { return '{"speak":[]}'; } });
  assert.equal(reason, 'passed');
  assert.equal(roundsOf(log1), 1, 'round 1 is never filtered, later rounds were skipped');
  assert.equal(on.state.filtered, 3);
  // a member who was @mentioned in the last round always answers, even if the judge would skip them
  const handoff = mk({ speakFilter: true });
  const log2: string[] = [];
  await run(handoff, { async turn(a, p) { const r = Number(/It is round (\d+)\./.exec(p)?.[1] ?? 1); log2.push(`${a}@${r}`); return r === 1 && a === 'bravo' ? 'Passing to @forge-coder' : r === 1 ? `${a} ok` : PASS_TOKEN; }, async judge() { return '{"speak":[]}'; } });
  assert.ok(log2.includes('forge-coder@2') && !log2.includes('bravo@2'));
  // unreadable or throwing judge: everyone speaks
  for (const judge of [async () => 'no idea', async () => { throw new Error('model down'); }, async () => null] as Array<RoomTransport['judge']>) {
    const log3: string[] = [];
    await run(mk({ speakFilter: true }), { async turn(a, p) { log3.push(`${a}@${/It is round (\d+)\./.exec(p)?.[1] ?? 1}`); return scriptedReply(p); }, judge });
    assert.equal(roundsOf(log3), 3, 'fails open: same turns as with no filter');
  }
});

test('judge prompt and parser: ids by name or @id, junk and wrong shapes are null, unknown ids are dropped', () => {
  const s = setup('go');
  const p = judgePrompt({ room: s.room, members: M, candidates: M.slice(0, 2), trigger: s.trigger, round: 2 });
  assert.match(p, /Candidates: Alpha \(@alpha\), Bravo \(@bravo\)\./);
  assert.match(p, /JSON only/);
  assert.deepEqual(parseJudge('Sure!\n{"speak":["@Bravo","nope"]}', ['alpha', 'bravo']), ['bravo']);
  assert.deepEqual(parseJudge('{"speak":[]}', ['alpha']), []);
  for (const bad of ['', null, 'plain text', '{"speak":"alpha"}', '{"speak":[1]}', '{bad json}']) assert.equal(parseJudge(bad, ['alpha']), null, String(bad));
});
