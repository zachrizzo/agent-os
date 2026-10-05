import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  discussionBlock, isExcludedAgent, isPass, memberPrompt, migrateRoom, normalizeSettings, parseMentions, runDiscussion, selectResponders,
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

test('a failing agent becomes a system note and counts as a pass; Stop cancels', async () => {
  const t: RoomTransport = { async turn(a, p) { if (a === 'bravo') throw new Error('boom'); return scriptedReply(p); } };
  const s = setup('ship?');
  assert.equal(await run(s, t), 'passed');
  assert.ok(s.room.messages.some((m) => m.from === 'system' && /Bravo did not answer: boom/.test(m.text)));
  const down: RoomTransport = { async turn() { throw new Error('down'); } };
  assert.equal(await run(setup('ship?'), down), 'passed', 'everyone failing ends the run instead of looping');
  const ac = new AbortController();
  const aborted: string[] = [];
  const p = setup('pingpong forever');
  const slow: RoomTransport = { turn: (_a, _p, sig) => new Promise<string>((_res, rej) => { sig.addEventListener('abort', () => rej(new Error('cancelled'))); setTimeout(() => ac.abort(), 5); }), abort: (id) => { aborted.push(id); } };
  assert.equal(await runDiscussion(p.room, M, p.trigger, slow, p.hooks, ac.signal), 'cancelled');
  assert.deepEqual(aborted.sort(), ['bravo', 'forge-coder']);
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
