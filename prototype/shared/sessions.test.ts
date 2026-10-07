import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ageShort, inScope, scopedRows, scopeParams, sessionKindOf, sessionStateOf, sessionTree, toSessionRow, type SessionRow } from './sessions.ts';

const row = (key: string, updatedAt: number, parent?: string): SessionRow => ({ key, agentId: 'agent-service-lead', kind: sessionKindOf(key), label: key, state: 'idle', updatedAt, ...(parent ? { parent } : {}) });

test('session kinds come from the key', () => {
  assert.equal(sessionKindOf('agent:x:main'), 'main');
  assert.equal(sessionKindOf('agent:x:subagent:abc'), 'subagent');
  assert.equal(sessionKindOf('agent:x:cron:abc'), 'automation');
  assert.equal(sessionKindOf('agent:x:room-abc'), 'room');
  assert.equal(sessionKindOf('agent:x:dashboard:abc'), 'dashboard');
  assert.equal(sessionKindOf('agent:x:other'), 'other');
});

test('state: running beats error, attention is needs, done is done', () => {
  assert.equal(sessionStateOf({ hasActiveRun: true, abortedLastRun: true }), 'running');
  assert.equal(sessionStateOf({ abortedLastRun: true }), 'error');
  assert.equal(sessionStateOf({ status: 'failed' }), 'error');
  assert.equal(sessionStateOf({ attention: 'hand' }), 'needs');
  assert.equal(sessionStateOf({ status: 'done' }), 'done');
  assert.equal(sessionStateOf({}), 'idle');
});

test('toSessionRow maps a gateway session', () => {
  const r = toSessionRow({ key: 'agent:a-lead:subagent:11112222', label: 'coder: fix', updatedAt: 5, parentSessionKey: 'agent:a-lead:main', model: 'm' });
  assert.deepEqual(r, { key: 'agent:a-lead:subagent:11112222', agentId: 'a-lead', kind: 'subagent', label: 'coder: fix', state: 'idle', updatedAt: 5, parent: 'agent:a-lead:main', model: 'm' });
  assert.equal(toSessionRow({ key: 'agent:a-lead:subagent:11112222' }).label, 'Subagent 11112222');
  assert.equal(toSessionRow({ key: 'agent:a-lead:main' }).label, 'Main session');
});

test('tree: newest roots first, children nested under their parent newest first', () => {
  const rows = [row('agent:a:main', 10), row('agent:a:subagent:1', 30, 'agent:a:main'), row('agent:a:subagent:2', 50, 'agent:a:main'), row('agent:a:subagent:3', 40, 'agent:a:subagent:1'), row('agent:a:room-x', 100)];
  const t = sessionTree(rows).map((n) => `${n.depth}:${n.row.key}`);
  assert.deepEqual(t, ['0:agent:a:room-x', '0:agent:a:main', '1:agent:a:subagent:2', '1:agent:a:subagent:1', '2:agent:a:subagent:3']);
});

test('tree: orphans and cycles still appear once', () => {
  const rows = [row('a', 1, 'missing'), row('b', 2, 'c'), row('c', 3, 'b')];
  const keys = sessionTree(rows).map((n) => n.row.key).sort();
  assert.deepEqual(keys, ['a', 'b', 'c']);
});

test('scope: agent exact, team by prefix, nothing otherwise', () => {
  assert.equal(inScope('agent-service-lead', { agent: 'agent-service-lead' }), true);
  assert.equal(inScope('agent-service-coder', { agent: 'agent-service-lead' }), false);
  assert.equal(inScope('agent-service-coder', { team: 'agent' }), true);
  assert.equal(inScope('main', { team: 'cos' }), true);
  assert.equal(inScope('main', {}), false);
  assert.equal(scopeParams({ agent: 'a b' }), 'agent=a%20b');
  assert.equal(scopeParams({}), '');
});

test('age is short', () => {
  assert.equal(ageShort(1000, 1000), 'now');
  assert.equal(ageShort(0, 5 * 60_000), '5m ago');
  assert.equal(ageShort(0, 3 * 3600_000), '3h ago');
  assert.equal(ageShort(0, 72 * 3600_000), '3d ago');
});

test('scopedRows adds subagents of the agent even when they run under another agent id', () => {
  const lead = { ...row('agent:lead:main', 10), agentId: 'lead' };
  const coder = { ...row('agent:coder:subagent:1', 20, 'agent:lead:main'), agentId: 'coder' };
  const nested = { ...row('agent:simplifier:subagent:2', 30, 'agent:coder:subagent:1'), agentId: 'simplifier' };
  const other = { ...row('agent:other:main', 40), agentId: 'other' };
  assert.deepEqual(scopedRows([lead, coder, nested, other], { agent: 'lead' }).map((r) => r.key), ['agent:lead:main', 'agent:coder:subagent:1', 'agent:simplifier:subagent:2']);
});
