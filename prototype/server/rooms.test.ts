// Rooms service: the open discussion over a fake Gateway, Stop -> gateway abort, persistence, and loading old (captain-led council) rooms.json files.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { scriptedReply } from '../shared/scripted.ts';
import { createRoomsService, type RoomAgent, type RoomGateway } from './rooms.ts';

const AGENTS: RoomAgent[] = [{ id: 'rfc-lead', name: 'RFC Lead' }, { id: 'rfc-skeptic', name: 'RFC Skeptic' }, { id: 'rfc-scribe', name: 'RFC Scribe' }, { id: 'phi', name: 'PHI' }];
function fakeGateway(delays: Record<string, number> = {}) {
  const log: Array<{ agent: string; round: number }> = [];
  const aborted: string[] = [];
  const gw: RoomGateway = {
    async listAgents() { return AGENTS; },
    async ensureSession() {},
    async turn(agent, _room, prompt, signal) {
      log.push({ agent, round: Number(/It is round (\d+)\./.exec(prompt)?.[1] ?? 1) });
      await new Promise<void>((res, rej) => { const t = setTimeout(res, delays[agent] ?? 15); signal.addEventListener('abort', () => { clearTimeout(t); rej(new Error('cancelled')); }, { once: true }); });
      return scriptedReply(prompt);
    },
    async abort(agent) { aborted.push(agent); },
  };
  return { gw, log, aborted };
}
const tmp = () => mkdtempSync(join(tmpdir(), 'aos-rooms-'));

test('new rooms: the lead is rfc-lead when present, else the first member; no pipeline settings exist', async () => {
  const svc = createRoomsService({ gateway: fakeGateway().gw });
  const a = await svc.create({ name: 'A', members: ['rfc-skeptic', 'rfc-scribe'] });
  assert.equal(a.room.captain, 'rfc-skeptic');
  for (const k of ['mode', 'maxRounds', 'maxSteps', 'councils', 'maxTurns', 'memberTimeoutSec']) assert.ok(!(k in a.room), k);
  const b = await svc.create({ name: 'B', members: ['rfc-skeptic', 'rfc-lead'] });
  assert.equal(b.room.captain, 'rfc-lead');
  assert.equal((await svc.update(b.room.id, { captain: 'rfc-skeptic' })).room.captain, 'rfc-skeptic');
  await assert.rejects(svc.update(b.room.id, { captain: 'rfc-scribe' }), /lead must be a member/);
  assert.equal((await svc.update(b.room.id, { removeMembers: ['rfc-skeptic'] })).room.captain, 'rfc-lead');
  const patched = (await svc.update(a.room.id, { mode: 'roundtable', maxSteps: 2 } as never)).room;
  assert.ok(!('mode' in patched) && !('maxSteps' in patched)); // retired settings are ignored
  svc.close();
});

test('a message starts an open discussion: member bubbles in the thread, a second round, and it ends when a whole round is PASS (no final answer); persisted', async () => {
  const dir = tmp();
  const file = join(dir, 'rooms.json');
  const { gw, log } = fakeGateway();
  const svc = createRoomsService({ gateway: gw, file });
  const { room } = await svc.create({ name: 'Talk', members: ['rfc-lead', 'rfc-skeptic', 'rfc-scribe'] });
  await svc.send(room.id, 'Ship the RFC?');
  await new Promise((r) => setTimeout(r, 5));
  assert.equal((await svc.get(room.id)).run?.status, 'running');
  await svc.idle(room.id);
  const v = await svc.get(room.id);
  const thread = v.room.messages.filter((m) => m.from !== 'system');
  assert.equal(thread[0].from, 'you');
  assert.deepEqual(new Set(thread.slice(1, 3).map((m) => m.from)), new Set(['rfc-skeptic', 'rfc-scribe'])); // round 1: members in parallel
  assert.equal(thread[3].from, 'rfc-lead'); // then the lead's own round-1 take
  assert.ok(thread.some((m) => /Building on/.test(m.text)), 'members talk to each other');
  assert.ok(v.room.messages.every((m) => !('final' in m)), 'no final bubble');
  assert.equal(Math.max(...log.map((l) => l.round)), 3); // round 3 was all PASS: that ended it
  assert.equal(v.run?.stopReason, 'passed');
  assert.equal(v.run?.status, 'done');
  assert.deepEqual(v.run?.active, []);
  assert.ok(!('councils' in v.room));
  // reload: same thread from disk
  const svc2 = createRoomsService({ gateway: gw, file });
  assert.deepEqual((await svc2.get(room.id)).room.messages, v.room.messages);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).version, 4);
  svc.close(); svc2.close(); rmSync(dir, { recursive: true });
});

test('@mention goes straight to that agent; one-member rooms answer once', async () => {
  const { gw, log } = fakeGateway();
  const svc = createRoomsService({ gateway: gw });
  const { room } = await svc.create({ name: 'B', members: ['rfc-lead', 'rfc-skeptic', 'rfc-scribe'] });
  await svc.send(room.id, '@rfc-skeptic what do you think?');
  await svc.idle(room.id);
  assert.deepEqual(log.map((l) => l.agent), ['rfc-skeptic']);
  assert.deepEqual((await svc.get(room.id)).room.messages.map((m) => m.from), ['you', 'rfc-skeptic']);
  const solo = await svc.create({ name: 'Solo', members: ['rfc-lead'] });
  log.length = 0;
  await svc.send(solo.room.id, 'anything');
  await svc.idle(solo.room.id);
  assert.equal(log.length, 1);
  svc.close();
});

test('while members are working the run state lists them as typing; Stop aborts every in-flight run and ends it stopped', async () => {
  const { gw, aborted } = fakeGateway({ 'rfc-skeptic': 5000, 'rfc-scribe': 5000 });
  const svc = createRoomsService({ gateway: gw });
  const { room } = await svc.create({ name: 'S', members: ['rfc-lead', 'rfc-skeptic', 'rfc-scribe'] });
  await svc.send(room.id, 'long one');
  await new Promise((r) => setTimeout(r, 300));
  const mid = await svc.get(room.id);
  assert.equal(mid.run?.status, 'running');
  assert.deepEqual([...(mid.run?.active ?? [])].sort(), ['rfc-scribe', 'rfc-skeptic']);
  await svc.stop(room.id);
  await svc.idle(room.id);
  assert.deepEqual([...aborted].sort(), ['rfc-scribe', 'rfc-skeptic']);
  const v = await svc.get(room.id);
  assert.equal(v.run?.status, 'stopped');
  svc.close();
});

test('phi stays refused', async () => {
  const svc = createRoomsService({ gateway: fakeGateway().gw });
  await assert.rejects(svc.create({ name: 'P', members: ['phi'] }), /cannot join/);
  svc.close();
});

test('old rooms.json (captain-led council, with mode/steps/councils and the retired caps) loads as a plain discussion room (no council or final flags); nothing is written on load', async () => {
  const dir = tmp();
  const file = join(dir, 'rooms.json');
  const old = {
    version: 2,
    rooms: [
      { id: 'rc1cabea9', name: 'RFC Council', members: ['rfc-skeptic', 'rfc-scribe', 'rfc-lead'], captain: 'rfc-lead', mode: 'council', maxRounds: 1, maxSteps: 3, maxTurns: 12, memberTimeoutSec: 90, noLimitMigrated: true, mentionGating: true,
        archived: false, createdAt: 1, updatedAt: 2, councils: [{ id: 'm1', captain: 'rfc-lead', phase: 'working', startedAt: 1, agents: {}, notes: [], turnsUsed: 2, finalId: 'm2' }],
        messages: [{ id: 'm1', ts: 1, from: 'you', text: 'hi' }, { id: 'm2', ts: 2, from: 'rfc-lead', text: 'answer', council: 'm1' }] },
      { id: 'r11111111', name: 'Other', members: ['forge', 'spark'], archived: true, createdAt: 1, updatedAt: 2, messages: [], maxRounds: 2, mentionGating: false },
    ],
  };
  const raw = JSON.stringify(old);
  writeFileSync(file, raw);
  const svc = createRoomsService({ gateway: fakeGateway().gw, file });
  const rfc = (await svc.get('rc1cabea9')).room as unknown as Record<string, unknown> & { messages: Array<Record<string, unknown>> };
  for (const k of ['mode', 'maxRounds', 'maxSteps', 'councils', 'maxTurns', 'memberTimeoutSec', 'noLimitMigrated']) assert.ok(!(k in rfc), k);
  assert.equal(rfc.captain, 'rfc-lead');
  assert.deepEqual(rfc.messages[1], { id: 'm2', ts: 2, from: 'rfc-lead', text: 'answer' });
  const other = (await svc.get('r11111111')).room;
  assert.equal(other.captain, 'forge');
  assert.equal(other.mentionGating, false);
  assert.equal(readFileSync(file, 'utf8'), raw, 'load does not rewrite the file');
  await svc.update('rc1cabea9', { name: 'RFC Council' });
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(saved.version, 4);
  assert.ok(saved.rooms.every((r: any) => !('mode' in r) && !('councils' in r) && !('maxSteps' in r)));
  svc.close(); rmSync(dir, { recursive: true });
});

test('a member that never replies is never timed out; Stop ends it', async () => {
  const { gw, aborted } = fakeGateway({ 'rfc-scribe': 3_600_000 });
  const svc = createRoomsService({ gateway: gw });
  const { room } = await svc.create({ name: 'T', members: ['rfc-lead', 'rfc-skeptic', 'rfc-scribe'] });
  await svc.send(room.id, 'x');
  await new Promise((r) => setTimeout(r, 500));
  assert.equal((await svc.get(room.id)).run?.status, 'running');
  await svc.stop(room.id);
  await svc.idle(room.id);
  assert.equal((await svc.get(room.id)).run?.status, 'stopped');
  assert.ok(aborted.includes('rfc-scribe'));
  svc.close();
});

// ---- rooms v2 service behavior

const nap = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => Promise<boolean> | boolean, ms = 3000) { const t0 = Date.now(); while (!(await fn())) { if (Date.now() - t0 > ms) throw new Error('timed out waiting'); await nap(10); } }

test('a message sent while a discussion runs is queued (flagged, hidden from agents), joins at the next round boundary, and is answered; no second run is started', async () => {
  const prompts: string[] = [];
  const base = fakeGateway({ 'rfc-skeptic': 60 });
  const gw: RoomGateway = { ...base.gw, async turn(a, r, p, s, pr) { prompts.push(p); return base.gw.turn(a, r, p, s, pr); } };
  const svc = createRoomsService({ gateway: gw });
  const { room } = await svc.create({ name: 'Q', members: ['rfc-lead', 'rfc-skeptic'] });
  await svc.send(room.id, 'first question');
  await nap(20);
  const v = await svc.send(room.id, 'and what about cost?'); // busy: queued, not a 409
  const queued = v.room.messages.find((m) => m.text === 'and what about cost?')!;
  assert.equal(queued.queued, true);
  assert.equal(v.run?.status, 'running');
  await svc.idle(room.id);
  const after = (await svc.get(room.id)).room;
  assert.ok(!after.messages.some((m) => m.queued), 'the flag is cleared once it joined');
  const round1 = prompts.filter((p) => /It is round 1\./.test(p));
  assert.ok(round1.length && round1.every((p) => !/what about cost/.test(p)));
  assert.ok(prompts.some((p) => /You: and what about cost\?/.test(p)), 'a later round shows it');
  assert.equal((await svc.get(room.id)).run?.status, 'done');
  for (let i = 0; i < 5; i++) await svc.send(room.id, `more ${i}`).catch(() => undefined); // starts a new run, then queues
  await svc.stop(room.id); await svc.idle(room.id);
  svc.close();
});

test('too many queued messages are refused; Stop drops the queued ones with a note (not replayed, not silently lost)', async () => {
  const { gw } = fakeGateway({ 'rfc-lead': 3_600_000 });
  const svc = createRoomsService({ gateway: gw });
  const { room } = await svc.create({ name: 'Q', members: ['rfc-lead', 'rfc-skeptic'] });
  await svc.send(room.id, 'start');
  for (let i = 0; i < 5; i++) await svc.send(room.id, `q${i}`);
  await assert.rejects(svc.send(room.id, 'q5'), /already queued/);
  await svc.stop(room.id);
  await svc.idle(room.id);
  const v = await svc.get(room.id);
  assert.ok(!v.room.messages.some((m) => m.queued));
  assert.ok(v.room.messages.some((m) => m.from === 'system' && /5 queued messages were not sent/.test(m.text)));
  assert.equal(v.run?.status, 'stopped');
  svc.close();
});

test('soft pause end to end: a repeating room pauses (never stops), the room stays busy, Continue carries on, and Stop ends a pause', async () => {
  const { gw } = fakeGateway();
  const svc = createRoomsService({ gateway: gw });
  const { room } = await svc.create({ name: 'P', members: ['rfc-lead', 'rfc-skeptic', 'rfc-scribe'] });
  await svc.send(room.id, 'pingpong'); // every member @mentions the next one with the same words every round
  await until(async () => (await svc.get(room.id)).run?.status === 'paused');
  let v = await svc.get(room.id);
  assert.equal(v.run?.pause?.reason, 'repeat');
  assert.equal((await svc.list()).rooms.find((r) => r.id === room.id)?.paused, true);
  assert.equal(v.run?.active.length, 0);
  const posts = v.room.messages.length;
  await nap(60);
  assert.equal((await svc.get(room.id)).room.messages.length, posts, 'nothing is said while paused');
  await svc.resume(room.id);
  await until(async () => (await svc.get(room.id)).room.messages.length > posts);
  assert.ok(['running', 'paused'].includes((await svc.get(room.id)).run!.status));
  await until(async () => (await svc.get(room.id)).run?.status === 'paused'); // it pauses again on the next repeat: still no stop
  await svc.stop(room.id);
  await svc.idle(room.id);
  v = await svc.get(room.id);
  assert.equal(v.run?.status, 'stopped');
  assert.equal(v.run?.pause, undefined);
  svc.close();
});

test('writing while paused releases the pause and the message joins; End now while paused ends the run softly', async () => {
  const { gw } = fakeGateway();
  const svc = createRoomsService({ gateway: gw });
  const { room } = await svc.create({ name: 'P', members: ['rfc-lead', 'rfc-skeptic'] });
  await svc.update(room.id, { pauseAfterPosts: 1 });
  await svc.send(room.id, 'hello');
  await until(async () => (await svc.get(room.id)).run?.status === 'paused');
  await svc.send(room.id, 'actually, focus on cost');
  await until(async () => (await svc.get(room.id)).room.messages.some((m) => m.text === 'actually, focus on cost' && !m.queued));
  await until(async () => (await svc.get(room.id)).run?.status === 'paused'); // the next round pauses again (limit 1)
  await svc.end(room.id);
  await svc.idle(room.id);
  const v = await svc.get(room.id);
  assert.equal(v.run?.status, 'done');
  assert.equal(v.run?.stopReason, 'ended');
  svc.close();
});

test('usage: each run totals turns/tokens/cost, the room keeps a running total across runs, estimated when the Gateway reports nothing', async () => {
  const base = fakeGateway();
  const gw: RoomGateway = { ...base.gw, async turn(a, r, p, s) { const text = (await base.gw.turn(a, r, p, s)) as string; return a === 'rfc-skeptic' ? { text, usage: { inputTokens: 400, outputTokens: 40, costUsd: 0.02 } } : text; } };
  const svc = createRoomsService({ gateway: gw });
  const { room } = await svc.create({ name: 'U', members: ['rfc-lead', 'rfc-skeptic'] });
  await svc.send(room.id, 'one');
  await svc.idle(room.id);
  const first = await svc.get(room.id);
  assert.ok(first.run!.usage!.turns >= 2);
  assert.ok(first.run!.usage!.inputTokens >= 400 && first.run!.usage!.costUsd >= 0.02);
  assert.equal(first.run!.usage!.estimated, true, 'the lead reported no usage: flagged as estimated');
  assert.ok(first.run!.lastSpeaker);
  const total1 = first.room.usage!.turns;
  assert.equal(total1, first.run!.usage!.turns);
  await svc.send(room.id, 'two');
  await svc.idle(room.id);
  const second = await svc.get(room.id);
  assert.ok(second.room.usage!.turns > total1 && second.room.usage!.turns > second.run!.usage!.turns, 'the room total spans both runs');
  svc.close();
});

test('run state persists; after a restart a run that was running or paused shows as interrupted, is never replayed, and its queued messages are reported', async () => {
  const dir = tmp();
  const file = join(dir, 'rooms.json');
  const room = { id: 'r00000001', name: 'Old', members: ['rfc-lead', 'rfc-skeptic'], captain: 'rfc-lead', mentionGating: true, archived: false, createdAt: 1, updatedAt: 1,
    messages: [{ id: 'm1', ts: 1, from: 'you', text: 'q' }, { id: 'm2', ts: 2, from: 'rfc-lead', text: 'a' }, { id: 'm3', ts: 3, from: 'you', text: 'follow-up', queued: true }] };
  const other = { ...room, id: 'r00000002', name: 'Done', messages: [{ id: 'm1', ts: 1, from: 'you', text: 'q' }] };
  writeFileSync(file, JSON.stringify({ version: 4, rooms: [room, other], runs: {
    r00000001: { id: 'runm1', status: 'paused', round: 3, turnsUsed: 7, active: [], pause: { reason: 'posts', detail: 'x', at: 1 }, usage: { turns: 7, inputTokens: 10, outputTokens: 5, costUsd: 0, estimated: true } },
    r00000002: { id: 'runm1', status: 'done', round: 2, turnsUsed: 2, active: [], stopReason: 'passed' },
  } }));
  const fg = fakeGateway();
  const svc = createRoomsService({ gateway: fg.gw, file });
  const v = await svc.get('r00000001');
  assert.equal(v.run?.status, 'interrupted');
  assert.equal(v.run?.stopReason, 'interrupted');
  assert.equal(v.run?.pause, undefined);
  assert.equal(v.run?.turnsUsed, 7, 'what the run had spent is kept');
  assert.ok(!v.room.messages.some((m) => m.queued));
  const note = v.room.messages.filter((m) => m.from === 'system').map((m) => m.text).join(' ');
  assert.match(note, /interrupted by a restart and was not replayed/);
  assert.match(note, /1 queued message was never delivered/);
  assert.equal((await svc.get('r00000002')).run?.status, 'done');
  assert.equal((await svc.get('r00000002')).room.messages.length, 1, 'a finished run adds no note');
  await nap(30);
  assert.equal(fg.log.length, 0, 'nothing was replayed: no agent was asked');
  assert.equal((await svc.list()).rooms.find((r) => r.id === 'r00000001')?.running, false);
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(saved.runs.r00000001.status, 'interrupted');
  svc.close();
  const again = createRoomsService({ gateway: fakeGateway().gw, file }); // a second restart does not add a second note
  assert.equal((await again.get('r00000001')).room.messages.filter((m) => m.from === 'system').length, 1);
  again.close(); rmSync(dir, { recursive: true });
});

test('live run state is written to rooms.json as it changes (so a crash mid-run is detectable)', async () => {
  const dir = tmp();
  const file = join(dir, 'rooms.json');
  const svc = createRoomsService({ gateway: fakeGateway({ 'rfc-lead': 400 }).gw, file });
  const { room } = await svc.create({ name: 'W', members: ['rfc-lead', 'rfc-skeptic'] });
  await svc.send(room.id, 'x');
  await nap(60);
  const mid = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(mid.runs[room.id].status, 'running');
  await svc.idle(room.id);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).runs[room.id].status, 'done');
  svc.close(); rmSync(dir, { recursive: true });
});

test('responder modes via the service: lead-first answers alone, mentions-only adds a note and starts nothing, bad modes are 400, settings clamp', async () => {
  const fg = fakeGateway();
  const svc = createRoomsService({ gateway: fg.gw });
  const { room } = await svc.create({ name: 'M', members: ['rfc-lead', 'rfc-skeptic', 'rfc-scribe'], responderMode: 'lead' });
  assert.equal(room.responderMode, 'lead');
  await svc.send(room.id, 'where are we?');
  await svc.idle(room.id);
  assert.deepEqual([...new Set(fg.log.map((l) => l.agent))], ['rfc-lead'], 'only the lead was asked');
  await assert.rejects(svc.update(room.id, { responderMode: 'loud' } as never), /responderMode must be one of/);
  const m = await svc.update(room.id, { responderMode: 'mentions', pauseAfterPosts: 9999, pauseAfterTokens: 1234.9, speakFilter: true });
  assert.equal(m.room.responderMode, 'mentions');
  assert.equal(m.room.pauseAfterPosts, 500);
  assert.equal(m.room.pauseAfterTokens, 1234);
  assert.equal(m.room.speakFilter, true);
  const before = fg.log.length;
  const v = await svc.send(room.id, 'anyone there?');
  assert.equal(v.run?.status, 'done'); // the earlier run's state; no new run
  assert.equal(fg.log.length, before);
  assert.ok(v.room.messages.some((x) => x.from === 'system' && /only answers @mentions/.test(x.text)));
  await svc.send(room.id, '@rfc-skeptic your view?');
  await svc.idle(room.id);
  assert.ok(fg.log.slice(before).every((l) => l.agent === 'rfc-skeptic'));
  svc.close();
});

test('notes and pins: notes are saved and capped, pinned messages survive the transcript cap and reach every prompt', async () => {
  const prompts: string[] = [];
  const base = fakeGateway();
  const gw: RoomGateway = { ...base.gw, async turn(a, r, p, s, pr) { prompts.push(p); return base.gw.turn(a, r, p, s, pr); } };
  const svc = createRoomsService({ gateway: gw });
  const { room } = await svc.create({ name: 'N', members: ['rfc-lead', 'rfc-skeptic'] });
  await svc.update(room.id, { notes: '  Budget is 5k.  ' });
  assert.equal((await svc.get(room.id)).room.notes, 'Budget is 5k.');
  await assert.rejects(svc.update(room.id, { notes: 'x'.repeat(4001) }), /notes must be text/);
  await svc.send(room.id, 'kick off');
  await svc.idle(room.id);
  const reply = (await svc.get(room.id)).room.messages.find((m) => m.from === 'rfc-skeptic')!;
  await svc.pin(room.id, reply.id, true);
  assert.equal((await svc.get(room.id)).room.messages.find((m) => m.id === reply.id)?.pinned, true);
  await assert.rejects(svc.pin(room.id, 'nope', true), /unknown message/);
  prompts.length = 0;
  await svc.send(room.id, 'next');
  await svc.idle(room.id);
  assert.ok(prompts.length && prompts.every((p) => /Room notes \(kept by Zach\):\nBudget is 5k\./.test(p) && /Pinned decisions:\n- RFC Skeptic:/.test(p)));
  // flood the room past the cap: the pinned message is kept
  for (let i = 0; i < 410; i++) { await svc.send(room.id, `noise ${i}`); await svc.stop(room.id); await svc.idle(room.id); if (i > 3) break; }
  const huge = await svc.get(room.id);
  assert.ok(huge.room.messages.some((m) => m.id === reply.id && m.pinned));
  await svc.pin(room.id, reply.id, false);
  assert.ok(!(await svc.get(room.id)).room.messages.find((m) => m.id === reply.id)?.pinned);
  svc.close();
});

test('wrap up: a normal @lead message (no special phase); End now never aborts the gateway runs', async () => {
  const fg = fakeGateway();
  const svc = createRoomsService({ gateway: fg.gw });
  const { room } = await svc.create({ name: 'W', members: ['rfc-lead', 'rfc-skeptic'] });
  await svc.send(room.id, 'start');
  await svc.idle(room.id);
  const before = fg.log.length;
  const v = await svc.wrapUp(room.id);
  assert.match(v.room.messages.at(-1)!.text, /^@rfc-lead Please wrap up/);
  await svc.idle(room.id);
  assert.ok(fg.log.slice(before).every((l) => l.agent === 'rfc-lead'), 'only the lead answers a wrap-up');
  await svc.send(room.id, 'again');
  await nap(5);
  await svc.end(room.id);
  await svc.idle(room.id);
  assert.deepEqual(fg.aborted, [], 'a soft end lets turns finish instead of aborting them');
  svc.close();
});

test('speak filter via the service: opt-in, uses the gateway judge when present; a throwing judge lets everyone speak', async () => {
  const base = fakeGateway();
  let judged = 0;
  let broken = false;
  const gw: RoomGateway = { ...base.gw, async judge() { judged++; if (broken) throw new Error('model down'); return '{"speak":[]}'; } };
  const svc = createRoomsService({ gateway: gw });
  const { room } = await svc.create({ name: 'F', members: ['rfc-lead', 'rfc-skeptic', 'rfc-scribe'] });
  await svc.send(room.id, 'plain');
  await svc.idle(room.id);
  assert.equal(judged, 0, 'off by default');
  const rounds = (log: typeof base.log) => Math.max(...log.map((l) => l.round));
  assert.equal(rounds(base.log), 3);
  await svc.update(room.id, { speakFilter: true });
  base.log.length = 0;
  await svc.send(room.id, 'filtered');
  await svc.idle(room.id);
  assert.equal(rounds(base.log), 1);
  assert.ok(judged >= 1);
  assert.ok((await svc.get(room.id)).run!.filtered! >= 1);
  broken = true; base.log.length = 0;
  await svc.send(room.id, 'filtered but the judge is down');
  await svc.idle(room.id);
  assert.equal(rounds(base.log), 3, 'fails open');
  svc.close();
});
