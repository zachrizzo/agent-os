import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ageLabel, columnOf, groupBoard, normalizeCard, type BoardCard } from './board.ts';

const card = (o: Partial<BoardCard>): BoardCard => ({ id: 'x', board: 'spark', title: 't', agent: 'spark', status: 'todo', priority: 'normal', createdAt: 1, updatedAt: 1, ...o });

test('statuses map onto the four columns', () => {
  for (const s of ['triage', 'backlog', 'todo', 'scheduled', 'ready']) assert.equal(columnOf(s), 'queued', s);
  assert.equal(columnOf('running'), 'working');
  assert.equal(columnOf('review'), 'review');
  assert.equal(columnOf('done'), 'closed');
  assert.equal(columnOf('blocked'), 'closed');
  assert.equal(columnOf('something-new'), 'queued');
});

test('normalizeCard keeps the shown fields, falls back to the claim owner, drops archived and malformed cards', () => {
  const raw = { id: 'a', title: ' Fix   it\n', status: 'running', priority: 'high', createdAt: 5, updatedAt: 9, notes: 'long', events: [1, 2], metadata: { claim: { ownerId: 'forge-coder', token: 'secret' } } };
  const n = normalizeCard(raw, 'forge')!;
  assert.deepEqual(n, { id: 'a', board: 'forge', title: 'Fix it', agent: 'forge-coder', status: 'running', priority: 'high', createdAt: 5, updatedAt: 9 });
  assert.equal(normalizeCard({ ...raw, agentId: 'spark' }, 'forge')!.agent, 'spark');
  assert.equal(normalizeCard({ ...raw, archivedAt: 1 }, 'forge'), null);
  assert.equal(normalizeCard({ title: 'no id' }, 'forge'), null);
  assert.equal(normalizeCard(null, 'forge'), null);
});

test('groupBoard: open columns by priority then oldest; blocked first in the closed column; done capped per board', () => {
  const g = groupBoard([
    card({ id: 'n1', status: 'todo', createdAt: 30 }), card({ id: 'n2', status: 'backlog', createdAt: 10 }), card({ id: 'n3', status: 'ready', priority: 'urgent', createdAt: 50 }),
    card({ id: 'r1', status: 'review' }), card({ id: 'w1', status: 'running' }),
    card({ id: 'd-old', status: 'done', updatedAt: 1 }), card({ id: 'b1', status: 'blocked', updatedAt: 2 }), card({ id: 'd-new', status: 'done', updatedAt: 99 }),
  ]);
  assert.deepEqual(g.queued.map((c) => c.id), ['n3', 'n2', 'n1']);
  assert.deepEqual(g.working.map((c) => c.id), ['w1']);
  assert.deepEqual(g.review.map((c) => c.id), ['r1']);
  assert.deepEqual(g.closed.map((c) => c.id), ['b1', 'd-new', 'd-old']);
  const many = groupBoard(Array.from({ length: 40 }, (_, i) => card({ id: `d${i}`, status: 'done', updatedAt: i })));
  assert.equal(many.closed.length, 15);
  assert.equal(many.closed[0].id, 'd39');
});

test('ageLabel', () => {
  const now = 10_000_000_000;
  assert.equal(ageLabel(now - 20_000, now), 'now');
  assert.equal(ageLabel(now - 5 * 60_000, now), '5m');
  assert.equal(ageLabel(now - 3 * 3_600_000, now), '3h');
  assert.equal(ageLabel(now - 2 * 86_400_000, now), '2d');
  assert.equal(ageLabel(now + 5_000, now), 'now');
});
