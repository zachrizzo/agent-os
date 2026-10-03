// Rooms service: council wiring over a fake Gateway, the @mention bypass, Stop -> gateway abort, persistence, and loading an old (version 1) rooms.json.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { scriptedReply } from '../shared/scripted.ts';
import { createRoomsService, type RoomAgent, type RoomGateway } from './rooms.ts';

const AGENTS: RoomAgent[] = [{ id: 'rfc-lead', name: 'RFC Lead' }, { id: 'rfc-skeptic', name: 'RFC Skeptic' }, { id: 'rfc-scribe', name: 'RFC Scribe' }, { id: 'phi', name: 'PHI' }];
function fakeGateway(delays: Record<string, number> = {}) {
  const log: Array<{ agent: string; role: string | undefined }> = [];
  const aborted: string[] = [];
  const gw: RoomGateway = {
    async listAgents() { return AGENTS; },
    async ensureSession() {},
    async turn(agent, _room, prompt, signal) {
      log.push({ agent, role: /Council role: ([A-Z-]+)\./.exec(prompt)?.[1] });
      await new Promise<void>((res, rej) => { const t = setTimeout(res, delays[agent] ?? 15); signal.addEventListener('abort', () => { clearTimeout(t); rej(new Error('cancelled')); }, { once: true }); });
      return scriptedReply(prompt);
    },
    async abort(agent) { aborted.push(agent); },
  };
  return { gw, log, aborted };
}
const tmp = () => mkdtempSync(join(tmpdir(), 'aos-rooms-'));

test('new rooms: council by default, captain = first member (or rfc-lead when present), maxSteps 3, no turn/timeout settings', async () => {
  const { gw } = fakeGateway();
  const svc = createRoomsService({ gateway: gw });
  const a = await svc.create({ name: 'A', members: ['rfc-skeptic', 'rfc-scribe'] });
  assert.equal(a.room.mode, 'council');
  assert.equal(a.room.captain, 'rfc-skeptic');
  assert.ok(!('maxTurns' in a.room) && !('memberTimeoutSec' in a.room));
  const patched = (await svc.update(a.room.id, { maxTurns: 6, memberTimeoutSec: 30 } as never)).room; // retired fields are ignored
  assert.ok(!('maxTurns' in patched) && !('memberTimeoutSec' in patched));
  assert.equal(a.room.maxSteps, 3);
  assert.equal((await svc.update(a.room.id, { maxSteps: 9 })).room.maxSteps, 4); // clamped to 1-4
  assert.equal((await svc.update(a.room.id, { maxSteps: 2 })).room.maxSteps, 2);
  const b = await svc.create({ name: 'B', members: ['rfc-skeptic', 'rfc-lead'] });
  assert.equal(b.room.captain, 'rfc-lead');
  const c = await svc.update(b.room.id, { captain: 'rfc-skeptic' });
  assert.equal(c.room.captain, 'rfc-skeptic');
  await assert.rejects(svc.update(b.room.id, { captain: 'rfc-scribe' }), /captain must be a member/);
  const d = await svc.update(b.room.id, { removeMembers: ['rfc-skeptic'] });
  assert.equal(d.room.captain, 'rfc-lead'); // the captain stays a member
  svc.close();
});

test('a message runs the council: ONE captain reply, persisted plan/notes/final, panel data in the view', async () => {
  const dir = tmp();
  const file = join(dir, 'rooms.json');
  const { gw, log } = fakeGateway();
  const svc = createRoomsService({ gateway: gw, file });
  const { room } = await svc.create({ name: 'Council', members: ['rfc-lead', 'rfc-skeptic', 'rfc-scribe'] });
  await svc.send(room.id, 'Ship the RFC? conflict');
  await svc.idle(room.id);
  const v = await svc.get(room.id);
  assert.deepEqual(v.room.messages.filter((m) => m.from !== 'system').map((m) => m.from), ['you', 'rfc-lead']);
  assert.equal(log.length, 9); // plan + 3 answers + 2 steer decisions + 2 follow-ups + synthesis
  assert.deepEqual(log.map((l) => l.role), ['CAPTAIN-PLAN', 'SPECIALIST', 'SPECIALIST', 'SPECIALIST', 'CAPTAIN-STEER', 'FOLLOW-UP', 'FOLLOW-UP', 'CAPTAIN-STEER', 'CAPTAIN-SYNTHESIZE']);
  assert.equal(v.room.councils.length, 1);
  const c = v.room.councils[0];
  assert.equal(c.maxSteps, 3);
  assert.equal(c.steps?.length, 1);
  assert.deepEqual(c.stop, { reason: 'done' });
  assert.equal(c.phase, 'done');
  assert.equal(c.finalId, v.room.messages.find((m) => m.council)!.id);
  assert.ok(c.plan && !c.plan.fallback && c.notes.length >= 7);
  assert.equal(v.run?.status, 'done');
  // reload: same thread and panel from disk
  const svc2 = createRoomsService({ gateway: gw, file });
  const again = await svc2.get(room.id);
  assert.deepEqual(again.room.councils, v.room.councils);
  assert.deepEqual(again.room.messages, v.room.messages);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).version, 2);
  svc.close(); svc2.close(); rmSync(dir, { recursive: true });
});

test('@mention bypass: straight to that agent, no council record; @all and no-mention run the council; round-table and one-member rooms never do', async () => {
  const { gw, log } = fakeGateway();
  const svc = createRoomsService({ gateway: gw });
  const { room } = await svc.create({ name: 'B', members: ['rfc-lead', 'rfc-skeptic', 'rfc-scribe'] });
  await svc.send(room.id, '@rfc-skeptic what do you think?');
  await svc.idle(room.id);
  let v = await svc.get(room.id);
  assert.deepEqual(log.map((l) => [l.agent, l.role]), [['rfc-skeptic', undefined]]);
  assert.equal(v.room.councils.length, 0);
  assert.deepEqual(v.room.messages.map((m) => m.from), ['you', 'rfc-skeptic']);
  log.length = 0;
  await svc.send(room.id, '@all status?');
  await svc.idle(room.id);
  v = await svc.get(room.id);
  assert.equal(v.room.councils.length, 1);
  assert.equal(log.length, 6); // no cue: the captain stops right after the first answers
  const rt = await svc.update(room.id, { mode: 'roundtable' });
  assert.equal(rt.room.mode, 'roundtable');
  log.length = 0;
  await svc.send(room.id, 'hello all');
  await svc.idle(room.id);
  assert.deepEqual(log.map((l) => l.agent), ['rfc-lead', 'rfc-skeptic', 'rfc-scribe']);
  const solo = await svc.create({ name: 'Solo', members: ['rfc-lead'] });
  log.length = 0;
  await svc.send(solo.room.id, 'anything');
  await svc.idle(solo.room.id);
  assert.equal(log.length, 1); // a one-member room has nothing to split
  svc.close();
});

test('Stop aborts every in-flight member run on the Gateway and ends the council as stopped', async () => {
  const { gw, aborted } = fakeGateway({ 'rfc-skeptic': 5000, 'rfc-scribe': 5000 });
  const svc = createRoomsService({ gateway: gw });
  const { room } = await svc.create({ name: 'S', members: ['rfc-lead', 'rfc-skeptic', 'rfc-scribe'] });
  await svc.send(room.id, 'long one');
  await new Promise((r) => setTimeout(r, 300));
  assert.equal((await svc.get(room.id)).run?.status, 'running');
  await svc.stop(room.id);
  await svc.idle(room.id);
  assert.deepEqual([...aborted].sort(), ['rfc-scribe', 'rfc-skeptic']);
  const v = await svc.get(room.id);
  assert.equal(v.run?.status, 'stopped');
  assert.equal(v.room.councils[0].phase, 'stopped');
  assert.equal(v.room.messages.filter((m) => m.council).length, 0);
  svc.close();
});

test('phi stays refused', async () => {
  const svc = createRoomsService({ gateway: fakeGateway().gw });
  await assert.rejects(svc.create({ name: 'P', members: ['phi'] }), /cannot join/);
  svc.close();
});

test('old rooms.json (version 1, no mode/captain/councils) loads: RFC Council gets rfc-lead, others the first member; nothing is written on load', async () => {
  const dir = tmp();
  const file = join(dir, 'rooms.json');
  const old = {
    version: 1,
    rooms: [
      { id: 'rc1cabea9', name: 'RFC Council', members: ['rfc-skeptic', 'rfc-scribe', 'rfc-lead'], archived: false, createdAt: 1, updatedAt: 2, messages: [{ id: 'm1', ts: 1, from: 'you', text: 'hi' }, { id: 'm2', ts: 2, from: 'rfc-lead', text: 'hello' }], maxRounds: 1, maxTurns: 3, mentionGating: true },
      { id: 'r11111111', name: 'Other', members: ['forge', 'spark'], archived: true, createdAt: 1, updatedAt: 2, messages: [], maxRounds: 2, maxTurns: 5, mentionGating: false },
    ],
  };
  const raw = JSON.stringify(old);
  writeFileSync(file, raw);
  const { gw } = fakeGateway();
  const svc = createRoomsService({ gateway: gw, file });
  const rfc = (await svc.get('rc1cabea9')).room;
  assert.equal(rfc.captain, 'rfc-lead');
  assert.equal(rfc.mode, 'council');
  assert.ok(!('maxTurns' in rfc) && !('memberTimeoutSec' in rfc)); // retired fields dropped on load
  assert.equal(rfc.maxSteps, 3);
  assert.equal(rfc.messages.length, 2);
  const other = (await svc.get('r11111111')).room;
  assert.equal(other.captain, 'forge');
  assert.ok(!('maxTurns' in other));
  assert.equal(other.maxSteps, 3);
  assert.equal(other.mentionGating, false);
  assert.equal(readFileSync(file, 'utf8'), raw, 'load does not rewrite the file');
  await svc.update('rc1cabea9', { name: 'RFC Council' }); // first save writes the migrated shape
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(saved.version, 2);
  assert.equal(saved.rooms.find((r: any) => r.id === 'rc1cabea9').captain, 'rfc-lead');
  assert.ok(saved.rooms.every((r: any) => r.mode === 'council' && Array.isArray(r.councils)));
  svc.close(); rmSync(dir, { recursive: true });
});

test('a council that was mid-run when the server died loads as stopped, not forever working', async () => {
  const dir = tmp();
  const file = join(dir, 'rooms.json');
  const room = { id: 'r22222222', name: 'X', members: ['rfc-lead', 'rfc-skeptic'], captain: 'rfc-lead', mode: 'council', archived: false, createdAt: 1, updatedAt: 2, maxRounds: 1, maxTurns: 6, mentionGating: true, memberTimeoutSec: 90, messages: [{ id: 'm1', ts: 1, from: 'you', text: 'q' }],
    councils: [{ id: 'm1', captain: 'rfc-lead', phase: 'working', startedAt: 1, agents: { 'rfc-skeptic': { status: 'working' } }, notes: [], turnsUsed: 2, maxTurns: 6 }] };
  writeFileSync(file, JSON.stringify({ version: 2, rooms: [room] }));
  const svc = createRoomsService({ gateway: fakeGateway().gw, file });
  const c = (await svc.get('r22222222')).room.councils[0];
  assert.equal(c.phase, 'stopped');
  assert.equal(c.agents['rfc-skeptic'].status, 'stopped');
  svc.close(); rmSync(dir, { recursive: true });
});

test('rooms.json with the retired maxTurns / memberTimeoutSec / noLimitMigrated fields loads without them and never writes them back', async () => {
  const dir = tmp();
  const file = join(dir, 'rooms.json');
  const mk = (id: string, over: Record<string, unknown>) => ({ id, name: id, members: ['rfc-lead', 'rfc-skeptic', 'rfc-scribe'], captain: 'rfc-lead', mode: 'council', archived: false, createdAt: 1, updatedAt: 2, maxRounds: 1, mentionGating: true, messages: [], councils: [], ...over });
  writeFileSync(file, JSON.stringify({ version: 2, rooms: [
    mk('r10000001', { maxTurns: 12, memberTimeoutSec: 90 }),
    mk('r10000002', { maxTurns: 7, maxSteps: 2, memberTimeoutSec: 45, noLimitMigrated: true }),
  ] }));
  const svc = createRoomsService({ gateway: fakeGateway().gw, file });
  for (const id of ['r10000001', 'r10000002']) {
    const r = (await svc.get(id)).room as unknown as Record<string, unknown>;
    assert.ok(!('maxTurns' in r) && !('memberTimeoutSec' in r) && !('noLimitMigrated' in r), id);
  }
  assert.equal((await svc.get('r10000002')).room.maxSteps, 2);
  await svc.update('r10000001', { name: 'renamed' });
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  assert.ok(saved.rooms.every((r: any) => !('maxTurns' in r) && !('memberTimeoutSec' in r) && !('noLimitMigrated' in r)));
  svc.close(); rmSync(dir, { recursive: true });
});

test('a member that never replies is never timed out; Stop ends it', async () => {
  const { gw, aborted } = fakeGateway({ 'rfc-scribe': 3_600_000 });
  const svc = createRoomsService({ gateway: gw });
  const { room } = await svc.create({ name: 'T', members: ['rfc-lead', 'rfc-skeptic', 'rfc-scribe'] });
  await svc.send(room.id, 'x');
  await new Promise((r) => setTimeout(r, 500));
  const mid = await svc.get(room.id);
  assert.equal(mid.run?.status, 'running');
  assert.equal(mid.room.councils[0].agents['rfc-scribe'].status, 'working'); // still hanging, not timed out
  await svc.stop(room.id);
  await svc.idle(room.id);
  const end = await svc.get(room.id);
  assert.equal(end.run?.status, 'stopped');
  assert.equal(end.room.councils[0].agents['rfc-scribe'].status, 'stopped');
  assert.ok(aborted.includes('rfc-scribe'));
  svc.close();
});
