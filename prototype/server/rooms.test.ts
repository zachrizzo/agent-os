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
