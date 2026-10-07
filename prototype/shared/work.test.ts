import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Agent, FleetEvent } from './types.ts';
import { deriveWork, isHiddenByDefault, milestoneOf, mrsIn, ticketsIn, visibleWork } from './work.ts';

const NOW = 1_800_000_000_000;
const MIN = 60_000;

const agent = (id: string, extra: Partial<Agent> = {}): Agent => ({
  id, name: extra.label ?? id, team: 'x', role: 'worker', status: 'idle', now: '', costUsd: 0, tokens: 0, updatedAt: NOW - 10 * MIN,
  agentId: /^agent:([^:]+):/.exec(id)![1], kind: id.endsWith(':main') ? 'main' : id.includes(':cron:') ? 'cron' : 'subagent', ...extra,
});
let n = 0;
const ev = (ago: number, from: string, to: string, kind: FleetEvent['kind'], text: string, extra: Partial<FleetEvent> = {}): FleetEvent =>
  ({ id: `e${n++}`, ts: NOW - ago * MIN, from, to, kind, text, session: from, ...extra });

const LEAD = 'agent:agent-service-lead:main';
const CODER = 'agent:agent-service-coder:subagent:c1';
const REVIEWER = 'agent:agent-service-reviewer:subagent:r1';
const fleet = () => [
  agent(LEAD, { agentName: 'agent-service Lead/PM', status: 'idle' }),
  agent(CODER, { label: 'AIPIT-6358 !980 correction r2', agentName: 'agent-service Coder', status: 'active', now: 'Running a command · Full gate', parent: LEAD, updatedAt: NOW - MIN }),
  agent(REVIEWER, { label: 'AIPIT-6358 !980 re-review r1', agentName: 'agent-service Reviewer', retired: true, parent: LEAD, updatedAt: NOW - 40 * MIN }),
];

test('keys: Jira tickets and MRs, without version-like false positives', () => {
  assert.deepEqual(ticketsIn('AIPIT-6358 and MER-12, UTF-8, SHA-256, ISO-8601, AIPIT-6358 again'), ['AIPIT-6358', 'MER-12']);
  assert.deepEqual(mrsIn('[!980 AIPIT-6358: x] and MR !965; not a!b or &!12 or !5'), ['!980', '!965']);
});

test('milestones: commits, pushes, review and security verdicts, QA; negations and chatter are not milestones', () => {
  const m = (text: string, from = CODER, label?: string) => milestoneOf({ text, ts: NOW, from, ...(label ? { label } : {}) })?.label ?? null;
  assert.equal(m('Both items are fixed and committed locally. Nothing is pushed.'), 'Committed');
  assert.equal(m('I merged the latest main into the branch and pushed it.'), 'Pushed');
  assert.equal(m('The branch hadn\'t been pushed yet.'), null);
  assert.equal(m('CHANGES_REQUESTED for MR !980 at d6186c38.', REVIEWER), 'Review: changes requested');
  assert.equal(m('CLEAN — no must-fix findings in the diff.', REVIEWER), 'Review: clean');
  assert.equal(m('PASS. No high or critical issues.', 'agent:security:subagent:s1'), 'Security: pass');
  assert.equal(m('Targeted tests pass (173).'), 'QA: tests passed');
  assert.equal(m('Full gate: 5432 passed, 5 skipped.'), 'QA: tests passed');
  assert.equal(m('MR !980 was merged to main.'), 'MR merged');
  assert.equal(m('Opened an MR for the fix.'), 'MR opened');
  assert.equal(m('Reading the existing worker tests first.'), null);
  assert.equal(m('PASS on that idea', LEAD), null, 'PASS from a non-security agent is not a verdict');
  assert.equal(milestoneOf({ text: 'CHANGES_REQUESTED', ts: NOW, from: REVIEWER })?.bad, true);
});

test('one row per ticket: MRs fold into their ticket, the lead owns it, the last real milestone and the active session show', () => {
  const events = [
    ev(120, LEAD, CODER, 'handoff', 'AIPIT-6358 !980 correction r1', { label: 'AIPIT-6358 !980 correction r1' }),
    ev(60, CODER, LEAD, 'done', 'The correction is committed; 5,429 passed.', { label: 'AIPIT-6358 !980 correction r1' }),
    ev(40, REVIEWER, LEAD, 'done', 'CHANGES_REQUESTED for MR !980: one must-fix.', { label: 'AIPIT-6358 !980 re-review r1' }),
    ev(30, LEAD, CODER, 'handoff', 'AIPIT-6358 !980 correction r2', { label: 'AIPIT-6358 !980 correction r2' }),
    ev(20, 'agent:main:main', '', 'message', 'Status on !980: the coder is fixing the must-fix.'),
  ];
  const rows = deriveWork({ agents: fleet(), events, openNeeds: [], now: NOW });
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.equal(r.key, 'AIPIT-6358');
  assert.deepEqual(r.mrs, ['!980']);
  assert.equal(r.state, 'working');
  assert.equal(r.lead, 'agent-service-lead');
  assert.equal(r.leadName, 'agent-service Lead/PM');
  assert.equal(r.milestone?.label, 'Review: changes requested');
  assert.equal(r.blocker, 'Review: changes requested');
  assert.equal(r.title, 'correction r2');
  assert.equal(r.now, 'agent-service Coder: Running a command · Full gate');
  assert.equal(r.session, CODER);
  assert.equal(r.startedAt, NOW - 120 * MIN);
});

test('states: needs Zach wins, a blocked outcome or an aborted last session is blocked, an open must-fix with nobody working is blocked, otherwise done', () => {
  const needs = ev(5, CODER, 'zach', 'needs', 'Ship AIPIT-6358 today or hold?', { needsYou: true });
  assert.equal(deriveWork({ agents: fleet(), events: [needs], openNeeds: [needs], now: NOW })[0].state, 'needs');
  assert.equal(deriveWork({ agents: fleet(), events: [needs], openNeeds: [needs], now: NOW })[0].blocker, 'Ship AIPIT-6358 today or hold?');

  const idle = fleet().map((a) => ({ ...a, status: 'idle' as const, retired: a.id !== LEAD }));
  const blocked = [ev(50, CODER, LEAD, 'blocked', 'Blocked: the EE lease for AIPIT-6358 expired.', { label: 'AIPIT-6358 !980 correction r2' })];
  assert.equal(deriveWork({ agents: idle, events: blocked, openNeeds: [], now: NOW })[0].state, 'blocked');

  const aborted = idle.map((a) => (a.id === CODER ? { ...a, status: 'error' as const, now: 'Aborted · AIPIT-6358 !980 correction r2', updatedAt: NOW - 2 * MIN } : a));
  const ab = deriveWork({ agents: aborted, events: [], openNeeds: [], now: NOW })[0];
  assert.equal(ab.state, 'blocked');
  assert.match(ab.blocker!, /Aborted/);

  const review = [ev(40, REVIEWER, LEAD, 'done', 'CHANGES_REQUESTED for MR !980.', { label: 'AIPIT-6358 !980 re-review r1' })];
  assert.equal(deriveWork({ agents: idle, events: review, openNeeds: [], now: NOW })[0].state, 'blocked');

  const done = [ev(40, REVIEWER, LEAD, 'done', 'CLEAN — no findings.', { label: 'AIPIT-6358 !980 re-review r1' })];
  assert.equal(deriveWork({ agents: idle, events: done, openNeeds: [], now: NOW })[0].state, 'done');
});

test('sessions with no ticket: a running labelled worker and an unanswered question still get a row; idle chat sessions do not', () => {
  const coder = agent('agent:coder:subagent:x1', { label: 'Agent OS: work view', status: 'active', parent: 'agent:main:dashboard:d1', now: 'Editing files' });
  const chat = agent('agent:main:dashboard:d2', { kind: 'other', status: 'active' });
  const ask = ev(2, 'agent:main:dashboard:d3', 'zach', 'needs', 'Which branch should I use?', { needsYou: true });
  const rows = deriveWork({ agents: [coder, chat, agent('agent:main:dashboard:d3', { kind: 'other' })], events: [ask], openNeeds: [ask], now: NOW });
  assert.deepEqual(rows.map((r) => [r.key, r.state]).sort(), [['session:agent:coder:subagent:x1', 'working'], ['session:agent:main:dashboard:d3', 'needs']]);
  assert.equal(rows.find((r) => r.key.includes('coder'))!.leadName, 'Chief of Staff');
});

test('default view: needs pinned first, automation and long-idle done work hidden until the toggle', () => {
  const cron = agent('agent:scrum:cron:j1', { label: 'jira-sync AIPIT-6000', status: 'active' });
  const old = agent('agent:infra:subagent:i1', { label: 'MER-9 teardown', retired: true, updatedAt: NOW - 10 * 3600_000 });
  const asker = agent('agent:provider-voice-app-lead:subagent:p1', { label: 'AIPIT-6401 rollout', status: 'needs', ask: 'Ship it?', updatedAt: NOW - 30 * MIN });
  const rows = deriveWork({ agents: [...fleet(), cron, old, asker], events: [], openNeeds: [], now: NOW });
  const auto = rows.find((r) => r.key === 'AIPIT-6000')!;
  assert.ok(auto.automation && isHiddenByDefault(auto, NOW));
  assert.ok(isHiddenByDefault(rows.find((r) => r.key === 'MER-9')!, NOW));
  const def = visibleWork(rows, false, NOW);
  assert.deepEqual(def.rows.map((r) => r.key), ['AIPIT-6401', 'AIPIT-6358']);
  assert.equal(def.hidden, 2);
  const all = visibleWork(rows, true, NOW);
  assert.equal(all.rows.length, 4);
  assert.equal(all.rows[0].state, 'needs');
});

test('a ticket with no brief label is titled from the words after its key', () => {
  const lead = agent(LEAD, { agentName: 'agent-service Lead/PM' });
  const rows = deriveWork({ agents: [lead], events: [ev(30, LEAD, '', 'message', 'Status check. MER-77: rotate the staging certs before Friday. More later.')], openNeeds: [], now: NOW });
  assert.equal(rows[0].title, 'rotate the staging certs before Friday');
  const linked = deriveWork({ agents: [lead], events: [ev(30, LEAD, '', 'message', '[!965 AIPIT-6357: Draft: AI Connect tool to book](https://gitlab.com/x/-/merge_requests/965) is green.')], openNeeds: [], now: NOW });
  assert.equal(linked[0].title, 'Draft: AI Connect tool to book is green');
});
