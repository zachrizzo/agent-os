import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isExcludedAgent, isPass, normalizeSettings, parseMentions, runRound, selectResponders, type Room, type RoomMember, type RoomMessage, type RoomRunState, type RoomTransport } from './rooms.ts';

const M: RoomMember[] = [{ id: 'alpha', name: 'Alpha' }, { id: 'bravo', name: 'Bravo' }, { id: 'forge-coder', name: 'Forge Coder' }];

test('mentions: by id or display name, case-insensitive, member order; @all means everyone', () => {
  assert.deepEqual(parseMentions('hey @bravo and @ALPHA', M), ['alpha', 'bravo']);
  assert.deepEqual(parseMentions('@forgecoder please', M), ['forge-coder']);
  assert.deepEqual(parseMentions('@forge-coder, take it', M), ['forge-coder']);
  assert.deepEqual(parseMentions('mail me at a@bravo.com', M), []); // not a mention: "@" glued to a word
  assert.equal(parseMentions('@all status?', M), null);
  assert.deepEqual(parseMentions('bravo without an at sign', M), []);
});

test('gating: no mention = everyone, mention = only those, gating off = everyone', () => {
  assert.deepEqual(selectResponders('status?', M, true), ['alpha', 'bravo', 'forge-coder']);
  assert.deepEqual(selectResponders('@bravo status?', M, true), ['bravo']);
  assert.deepEqual(selectResponders('@nobody status?', M, true), ['alpha', 'bravo', 'forge-coder']);
  assert.deepEqual(selectResponders('@bravo status?', M, false), ['alpha', 'bravo', 'forge-coder']);
});

test('settings clamp: rounds 1-4 default 1, turns default = member count', () => {
  assert.deepEqual(normalizeSettings(undefined, 3), { maxRounds: 1, maxTurns: 3, mentionGating: true });
  assert.equal(normalizeSettings({ maxRounds: 99 } as never, 3).maxRounds, 4);
  assert.equal(normalizeSettings({ maxRounds: 0 } as never, 3).maxRounds, 1);
  assert.equal(normalizeSettings({ maxTurns: 500 } as never, 3).maxTurns, 32);
  assert.equal(normalizeSettings({ maxRounds: 'x' as never }, 3).maxRounds, 1);
});

test('phi is excluded, near-misses are not', () => {
  for (const id of ['phi', 'PHI', 'phi-gateway', 'phi_x']) assert.ok(isExcludedAgent(id), id);
  for (const id of ['phil', 'sophie', 'alpha']) assert.ok(!isExcludedAgent(id), id);
});

test('pass detection', () => {
  for (const t of ['NO_REPLY', ' no_reply. ', '', null]) assert.ok(isPass(t as never), String(t));
  assert.ok(!isPass('NO_REPLY but actually here is more'));
});

function harness(settings: Partial<Room>, members = M) {
  const room: Room = { id: 'r1', name: 'T', members: members.map((m) => m.id), archived: false, createdAt: 0, updatedAt: 0, messages: [], maxRounds: 1, maxTurns: 3, mentionGating: true, ...settings };
  let n = 0;
  const state: Partial<RoomRunState> = {};
  const hooks = {
    append: (m: Omit<RoomMessage, 'id' | 'ts'>) => { const x = { ...m, id: `m${n++}`, ts: n }; room.messages.push(x); return x; },
    state: (p: Partial<RoomRunState>) => Object.assign(state, p),
  };
  const trigger = hooks.append({ from: 'you', text: '' });
  const run = (text: string, transport: RoomTransport, signal = new AbortController().signal) => { trigger.text = text; return runRound(room, members, trigger, transport, hooks, signal); };
  return { room, run, state };
}
const log: Array<{ id: string; prompt: string }> = [];
const echo: RoomTransport = { async turn(id, prompt) { log.push({ id, prompt }); return `${id} says hi`; } };

test('round 1, no mention: every member answers once, in order, and later agents see earlier replies', async () => {
  log.length = 0;
  const h = harness({});
  const stop = await h.run('status?', echo);
  assert.deepEqual(log.map((l) => l.id), ['alpha', 'bravo', 'forge-coder']);
  assert.deepEqual(h.room.messages.filter((m) => m.from !== 'you').map((m) => m.from), ['alpha', 'bravo', 'forge-coder']);
  assert.match(log[0].prompt, /New message from You:\nstatus\?/);
  assert.match(log[0].prompt, /\(no earlier messages\)/);
  assert.match(log[1].prompt, /Alpha: alpha says hi/);
  assert.match(log[2].prompt, /Bravo: bravo says hi/);
  assert.equal(stop, 'complete'); // nobody was @mentioned, maxRounds 1
});

test('mention gating: only the mentioned member runs', async () => {
  log.length = 0;
  const h = harness({});
  await h.run('@Bravo what do you think?', echo);
  assert.deepEqual(log.map((l) => l.id), ['bravo']);
});

test('ping-pong is bounded by maxRounds', async () => {
  log.length = 0;
  const pingpong: RoomTransport = { async turn(id, p) { log.push({ id, prompt: p }); return `@${id === 'alpha' ? 'bravo' : 'alpha'} your turn`; } };
  const h = harness({ maxRounds: 3, maxTurns: 32 }, M.slice(0, 2));
  const stop = await h.run('go', pingpong);
  assert.equal(log.length, 6); // 3 rounds x 2 members
  assert.equal(stop, 'maxRounds');
  assert.match(h.room.messages.at(-1)!.text, /round cap reached \(3 rounds\)/);
  assert.match(log[2].prompt, /Follow-up round 2/);
  assert.match(log[2].prompt, /Original message from You:\ngo/);
});

test('maxTurns caps total agent runs and says so in the thread', async () => {
  log.length = 0;
  const pingpong: RoomTransport = { async turn(id, p) { log.push({ id, prompt: p }); return `@${id === 'alpha' ? 'bravo' : 'alpha'} again`; } };
  const h = harness({ maxRounds: 4, maxTurns: 3 }, M.slice(0, 2));
  const stop = await h.run('go', pingpong);
  assert.equal(log.length, 3);
  assert.equal(stop, 'maxTurns');
  assert.match(h.room.messages.at(-1)!.text, /turn cap reached \(3 turns/);
  assert.equal(h.room.messages.at(-1)!.from, 'system');
});

test('NO_REPLY passes and is not shown; all passing ends the thread early', async () => {
  const quiet: RoomTransport = { async turn() { return 'NO_REPLY'; } };
  const h = harness({ maxRounds: 4 });
  const stop = await h.run('anyone?', quiet);
  assert.equal(stop, 'passed');
  assert.equal(h.room.messages.filter((m) => m.from !== 'you').length, 0);
});

test('an agent failure becomes a system note and spends a turn; the others still run', async () => {
  const flaky: RoomTransport = { async turn(id) { if (id === 'bravo') throw new Error('timed out'); return 'ok'; } };
  const h = harness({});
  await h.run('hi', flaky);
  const notes = h.room.messages.filter((m) => m.from === 'system');
  assert.equal(notes.length, 1);
  assert.match(notes[0].text, /Bravo did not answer: timed out/);
  assert.deepEqual(h.room.messages.filter((m) => m.from !== 'you' && m.from !== 'system').map((m) => m.from), ['alpha', 'forge-coder']);
});

test('abort stops before the next turn', async () => {
  const ac = new AbortController();
  const seen: string[] = [];
  const t: RoomTransport = { async turn(id) { seen.push(id); ac.abort(); return 'x'; } };
  const h = harness({});
  const stop = await h.run('hi', t, ac.signal);
  assert.deepEqual(seen, ['alpha']);
  assert.equal(stop, 'cancelled');
});
