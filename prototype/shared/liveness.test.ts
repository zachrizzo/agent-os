// Run: npm test   (node:test; Node strips the types, no extra tooling)
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FINISHED_STATUSES, RECENT_ACTIVITY_MS, classifySession, visibleView } from './liveness.ts';
import { COS_ID, type Agent, type Team } from './types.ts';

const NOW = 1_800_000_000_000;
const fresh = NOW - 60_000;
const stale = NOW - RECENT_ACTIVITY_MS - 1;

test('every terminal status is finished, even when freshly updated', () => {
  for (const status of ['done', 'aborted', 'timeout', 'timed_out', 'killed', 'failed', 'cancelled', 'canceled', 'error', 'crashed', 'DONE']) {
    assert.equal(classifySession({ status, updatedAt: fresh }, NOW), 'finished', status);
  }
  for (const status of FINISHED_STATUSES) assert.equal(classifySession({ status, updatedAt: fresh }, NOW), 'finished', status);
  assert.equal(classifySession({ abortedLastRun: true, updatedAt: fresh }, NOW), 'finished');
  assert.equal(classifySession({ archived: true, updatedAt: fresh }, NOW), 'finished');
});

test('running work is always live', () => {
  assert.equal(classifySession({ hasActiveRun: true, status: 'done', archived: true, updatedAt: stale }, NOW), 'running');
  assert.equal(classifySession({ status: 'running', updatedAt: stale }, NOW), 'running');
  assert.equal(classifySession({ subagentRunState: 'active', abortedLastRun: true }, NOW), 'running');
});

test('recently active is live; stale and idle is finished; boundary is inclusive', () => {
  assert.equal(classifySession({ updatedAt: fresh }, NOW), 'recent');
  assert.equal(classifySession({ status: 'idle', lastActivityAt: fresh }, NOW), 'recent');
  assert.equal(classifySession({ updatedAt: NOW - RECENT_ACTIVITY_MS }, NOW), 'recent');
  assert.equal(classifySession({ updatedAt: stale }, NOW), 'finished');
  assert.equal(classifySession({}, NOW), 'finished');
});

const team = (id: string, lead?: string): Team => ({ id, name: id, hue: '#fff', ...(lead ? { lead } : {}) });
const agent = (id: string, teamId: string, over: Partial<Agent> = {}): Agent => ({
  id, name: id, team: teamId, role: 'worker', status: 'active', now: '', costUsd: 0, tokens: 0, updatedAt: NOW, ...over,
});

const fleet = (): { agents: Agent[]; teams: Team[] } => ({
  teams: [team('cos', COS_ID), team('forge', 'agent:forge:main'), team('spark', 'agent:spark:main'), team('scout', 'agent:scout:main')],
  agents: [
    agent(COS_ID, 'cos', { role: 'cos' }),
    agent('agent:forge:main', 'forge', { role: 'lead', parent: COS_ID, retired: true, status: 'idle' }),
    agent('agent:forge-coder:subagent:live', 'forge', { parent: 'agent:forge:main' }),
    ...Array.from({ length: 5 }, (_, i) => agent(`agent:forge-coder:subagent:old${i}`, 'forge', { parent: 'agent:forge:main', retired: true, status: 'error' })),
    agent('agent:spark:main', 'spark', { role: 'lead', parent: COS_ID }),
    agent('agent:spark-a:subagent:done', 'spark', { parent: 'agent:spark:main', retired: true, status: 'idle' }),
    agent('agent:scout:main', 'scout', { role: 'lead', parent: COS_ID, retired: true, status: 'idle' }),
  ],
});

test('default view hides retired sessions and counts only live agents', () => {
  const { agents, teams } = fleet();
  const v = visibleView(agents, teams, false, COS_ID);
  assert.deepEqual(v.agents.map((a) => a.id).sort(), [COS_ID, 'agent:forge-coder:subagent:live', 'agent:spark:main'].sort());
  assert.equal(v.liveCount, 3);
  assert.equal(v.historyCount, 8);
});

test('a running worker stays visible and is re-parented when its finished lead is hidden', () => {
  const { agents, teams } = fleet();
  const v = visibleView(agents, teams, false, COS_ID);
  assert.equal(v.agents.find((a) => a.id === 'agent:forge-coder:subagent:live')?.parent, COS_ID);
  assert.equal(v.teams.find((t) => t.id === 'forge')?.lead, undefined);
  assert.equal(v.teams.find((t) => t.id === 'spark')?.lead, 'agent:spark:main');
});

test('teams with no live members disappear', () => {
  const { agents, teams } = fleet();
  assert.deepEqual(visibleView(agents, teams, false, COS_ID).teams.map((t) => t.id).sort(), ['cos', 'forge', 'spark']);
});

test('history toggle reveals everything; live count is unchanged, hidden count stays', () => {
  const { agents, teams } = fleet();
  const v = visibleView(agents, teams, true, COS_ID);
  assert.equal(v.agents.length, agents.length);
  assert.equal(v.teams.length, 4);
  assert.equal(v.liveCount, 3);
  assert.equal(v.historyCount, 8);
  assert.equal(v.agents.find((a) => a.id === 'agent:forge-coder:subagent:old0')?.parent, 'agent:forge:main');
});

test('does not mutate its input', () => {
  const { agents, teams } = fleet();
  const before = JSON.stringify([agents, teams]);
  visibleView(agents, teams, false, COS_ID);
  assert.equal(JSON.stringify([agents, teams]), before);
});
