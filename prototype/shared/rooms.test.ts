import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  addsNothingNew, discussionBlock, isExcludedAgent, isPass, memberPrompt, migrateRoom, normalizeSettings, parseFinal, parseMentions, runDiscussion, selectResponders,
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

test('settings: only mention gating; the pipeline settings are gone', () => {
  assert.deepEqual(normalizeSettings(undefined), { mentionGating: true });
  assert.deepEqual(normalizeSettings({ mentionGating: false }), { mentionGating: false });
  assert.deepEqual(normalizeSettings({ maxSteps: 3, mode: 'council', maxRounds: 4 } as never), { mentionGating: true });
});

test('phi is excluded, near-misses are not', () => {
  for (const id of ['phi', 'PHI', 'phi-gateway']) assert.ok(isExcludedAgent(id), id);
  for (const id of ['phil', 'sophie', 'alpha']) assert.ok(!isExcludedAgent(id), id);
});

test('pass and FINAL detection', () => {
  for (const r of ['PASS', ' pass. ', 'NO_REPLY', '', null]) assert.ok(isPass(r), String(r));
  assert.ok(!isPass('PASS on that, but here is why'));
  assert.deepEqual(parseFinal('FINAL: Ship it.'), { final: true, text: 'Ship it.' });
  assert.deepEqual(parseFinal('final:\nShip it.'), { final: true, text: 'Ship it.' });
  assert.deepEqual(parseFinal('Not final: ship it.'), { final: false, text: 'Not final: ship it.' });
});

test('addsNothingNew: acknowledgements and repeats do not count, a new point does', () => {
  const prior = ['We should ship behind a flag and keep a manual rollback ready for the migration.'];
  assert.ok(addsNothingNew('Agreed, makes sense.', prior));
  assert.ok(addsNothingNew('Ship behind a flag, keep a manual rollback ready for the migration.', prior));
  assert.ok(!addsNothingNew('The backfill needs an owner and a dry run on a copy of production before Thursday.', prior));
});

test('migrateRoom: retired pipeline fields dropped, a former council answer becomes a final bubble', () => {
  const old = { id: 'r00000001', name: 'x', members: ['a', 'b'], mode: 'council', maxRounds: 2, maxSteps: 3, councils: [{ id: 'm1' }], maxTurns: 6, captain: 'b', archived: false, createdAt: 1, updatedAt: 1,
    messages: [{ id: 'm1', ts: 1, from: 'you', text: 'q' }, { id: 'm2', ts: 2, from: 'b', text: 'answer', council: 'm1' }] } as unknown as Room;
  const r = migrateRoom(old) as Room & Record<string, unknown>;
  for (const k of ['mode', 'maxRounds', 'maxSteps', 'councils', 'maxTurns']) assert.ok(!(k in r), k);
  assert.equal(r.captain, 'b');
  assert.deepEqual(r.messages[1], { id: 'm2', ts: 2, from: 'b', text: 'answer', final: true });
});

// ---- the discussion loop, against a scripted transport

function setup(text: string, members = M, captain = 'alpha', extra: Partial<Room> = {}) {
  const room: Room = { id: 'r00000001', name: 'Test', members: members.map((m) => m.id), captain, mentionGating: true, archived: false, createdAt: 0, updatedAt: 0, messages: [], ...extra };
  let n = 0;
  const hooks = {
    append(m: Omit<RoomMessage, 'id' | 'ts'>) { const msg = { ...m, id: `m${n++}`, ts: n }; room.messages.push(msg); return msg; },
    state(p: Partial<RoomRunState>) { Object.assign(state, p); },
  };
  const state = { round: 1, turnsUsed: 0, active: [] as string[] } as RoomRunState;
  const trigger = hooks.append({ from: 'you', text });
  return { room, hooks, trigger, state };
}
const log: Array<{ agent: string; round: number }> = [];
const scripted: RoomTransport = { async turn(agent, prompt) { log.push({ agent, round: Number(/It is round (\d+)\./.exec(prompt)?.[1] ?? 1) }); return scriptedReply(prompt); } };
const texts = (room: Room) => room.messages.filter((m) => m.from !== 'system').map((m) => `${m.from}${m.final ? '*' : ''}`);

test('open discussion: everyone replies, members build on each other, the lead posts the final answer', async () => {
  log.length = 0;
  const { room, hooks, trigger } = setup('Should we ship Thursday?');
  const reason = await runDiscussion(room, M, trigger, scripted, hooks, new AbortController().signal);
  assert.equal(reason, 'complete');
  // round 1: bravo + forge-coder (in parallel), then the lead alpha; round 2: bravo builds on forge-coder; round 3 all pass -> wrap-up
  assert.deepEqual(texts(room).slice(0, 1), ['you']);
  assert.deepEqual(new Set(texts(room).slice(1, 3)), new Set(['bravo', 'forge-coder']));
  assert.equal(texts(room)[3], 'alpha');
  assert.ok(room.messages.some((m) => m.from === 'bravo' && /Building on/.test(m.text)), 'a member replies to another member in the open');
  const last = room.messages[room.messages.length - 1];
  assert.equal(last.from, 'alpha');
  assert.ok(last.final, 'the lead closes with the final answer');
  assert.ok(!/^FINAL/i.test(last.text), 'the FINAL marker is not shown');
  assert.equal(room.messages.filter((m) => m.final).length, 1);
  assert.ok(log.some((l) => l.round === 3), 'a second full round happened before the wrap-up');
});

test('every member sees the whole discussion so far in later rounds', async () => {
  const prompts: string[] = [];
  const t: RoomTransport = { async turn(a, p) { prompts.push(p); return scriptedReply(p); } };
  const { room, hooks, trigger } = setup('Should we ship Thursday?');
  await runDiscussion(room, M, trigger, t, hooks, new AbortController().signal);
  const round2 = prompts.find((p) => /It is round 2\./.test(p) && /You are Forge Coder/.test(p))!;
  assert.match(round2, /Alpha: Alpha here/);
  assert.match(round2, /Bravo: Bravo here/);
  assert.match(round2, /Reply if you can add something/);
  assert.ok(!/FINAL:/.test(prompts.find((p) => /It is round 1\./.test(p) && /You are Alpha/.test(p))!), 'no FINAL instruction in round 1');
  assert.ok(!/FINAL:/.test(prompts.find((p) => /You are Forge Coder/.test(p))!), 'members never get the FINAL instruction');
});

test('the lead may end it early with FINAL in round 2, never in round 1', async () => {
  const early = setup('earlyfinal: ship?');
  assert.equal(await runDiscussion(early.room, M, early.trigger, scripted, early.hooks, new AbortController().signal), 'complete');
  assert.ok(early.room.messages.at(-1)!.final);
  assert.equal(early.room.messages.at(-1)!.round, 2);
  const t: RoomTransport = { async turn(a) { return a === 'alpha' ? 'FINAL: done already' : 'my take'; } };
  const r1 = setup('ship?');
  await runDiscussion(r1.room, M, r1.trigger, t, r1.hooks, new AbortController().signal, { maxRounds: 1 });
  const lead = r1.room.messages.filter((m) => m.from === 'alpha');
  assert.equal(lead[0].final, undefined, 'a round-1 FINAL is just a message');
  assert.equal(lead[0].text, 'done already');
});

test('everyone passing ends the discussion with a lead wrap-up', async () => {
  const t: RoomTransport = { async turn(a, p) { return /WRAP-UP/.test(p) ? 'FINAL: nothing to add; go.' : /round 1/.test(p) ? 'My take: the migration is additive so rollback is cheap, but the backfill still needs an owner.' : 'PASS'; } };
  const { room, hooks, trigger } = setup('ship?');
  await runDiscussion(room, M, trigger, t, hooks, new AbortController().signal);
  assert.equal(room.messages.at(-1)!.final, true);
  assert.equal(room.messages.at(-1)!.round, 2); // round 1 replies, round 2 all pass, then the wrap-up
});

test('a runaway conversation hits the silent backstop and the lead still wraps up, with no note about it', async () => {
  const { room, hooks, trigger } = setup('pingpong please');
  let turns = 0;
  const t: RoomTransport = { async turn(a, p) { turns++; return /WRAP-UP/.test(p) ? 'FINAL: wrapped.' : scriptedReply(p); } };
  assert.equal(await runDiscussion(room, M, trigger, t, hooks, new AbortController().signal, { maxRounds: 4 }), 'complete');
  assert.equal(room.messages.at(-1)!.final, true);
  assert.ok(!room.messages.some((m) => m.from === 'system'), 'nothing about the cap is shown');
  assert.ok(turns <= 4 * M.length + 1);
});

test('an @mention to Zach\'s message is a direct question: only they reply, handoffs pull others in, no lead wrap-up', async () => {
  const { room, hooks, trigger } = setup('@bravo status?');
  assert.equal(await runDiscussion(room, M, trigger, scripted, hooks, new AbortController().signal), 'complete');
  assert.deepEqual(texts(room), ['you', 'bravo']);
  const hand: RoomTransport = { async turn(a, p) { return a === 'bravo' && /round 1/.test(p) ? '@forge-coder can you check?' : a === 'forge-coder' ? 'Checked: fine.' : 'PASS'; } };
  const h = setup('@bravo status?');
  await runDiscussion(h.room, M, h.trigger, hand, h.hooks, new AbortController().signal);
  assert.deepEqual(texts(h.room), ['you', 'bravo', 'forge-coder']);
});

test('a failing agent becomes a system note and the discussion goes on; Stop cancels', async () => {
  const t: RoomTransport = { async turn(a, p) { if (a === 'bravo') throw new Error('boom'); return scriptedReply(p); } };
  const { room, hooks, trigger } = setup('ship?');
  assert.equal(await runDiscussion(room, M, trigger, t, hooks, new AbortController().signal), 'complete');
  assert.ok(room.messages.some((m) => m.from === 'system' && /Bravo did not answer: boom/.test(m.text)));
  assert.ok(room.messages.at(-1)!.final);
  const ac = new AbortController();
  const s = setup('ship?');
  const slow: RoomTransport = { turn: (a, p, sig) => new Promise((res, rej) => { sig.addEventListener('abort', () => rej(new Error('cancelled'))); setTimeout(() => ac.abort(), 5); }) };
  assert.equal(await runDiscussion(s.room, M, s.trigger, slow, s.hooks, ac.signal), 'cancelled');
});

test('a one-member room just answers once; the prompt carries the whole thread', async () => {
  const one = setup('hello?', [M[0]]);
  assert.equal(await runDiscussion(one.room, [M[0]], one.trigger, scripted, one.hooks, new AbortController().signal), 'complete');
  assert.deepEqual(texts(one.room), ['you', 'alpha']);
  const { room, trigger } = setup('q', M, 'alpha');
  room.messages.push({ id: 'x', ts: 9, from: 'bravo', text: 'first reply' });
  const p = memberPrompt({ room, members: M, agent: M[1], lead: M[0], trigger, round: 2, directed: false });
  assert.match(p, /Zach's message:\nq/);
  assert.match(p, /Bravo: first reply/);
  assert.equal(discussionBlock(room.messages, trigger, (id) => id).discussion, 'bravo: first reply');
});
