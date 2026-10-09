import assert from 'node:assert/strict';
import { test } from 'node:test';
import { liveRunOf, parseRelay, parseSubagentTask, sessionStatusOf, toHistoryItems, toolSummary, usageFromSessionsUsage } from './transcript.ts';

const SUB = 'agent:engineering-lead:subagent:8f00';
const WRAPPER = '[Subagent Context] You are running as a subagent (depth 1/5). Complete the current [Subagent Task]; inherited conversation is background context, not your assignment.\n\n[Subagent Task]\n\n[from main] AIPIT-6435: fix the voice UX.\n\nRequester: agent:main:main.\n\nBegin. Execute the assigned task to completion.';
const OWNER = { senderIsOwner: true, senderId: 'gateway-owner', senderName: 'Zach Rizzo' };

test('the subagent wrapper becomes a task from the spawning session, wrapper text removed', () => {
  assert.deepEqual(parseSubagentTask(WRAPPER), { task: '[from main] AIPIT-6435: fix the voice UX.\n\nRequester: agent:main:main.', depth: '1/5' });
  const [item] = toHistoryItems([{ role: 'user', content: WRAPPER, timestamp: 5, __openclaw: { senderIsOwner: true, id: 'm1' } }], { key: SUB, spawnedBy: 'agent:main:main' });
  assert.equal(item.from, 'agent:main:main');
  assert.deepEqual(item.task, { depth: '1/5' });
  assert.equal(item.id, 'm1');
  assert.ok(!item.text.includes('[Subagent Context]'));
  assert.equal(parseSubagentTask('hello'), null);
});

test('only owner-tagged or Agent OS messages are from Zach; relays and inter-session messages keep their sender', () => {
  const items = toHistoryItems([
    { role: 'user', content: 'pull main', __openclaw: OWNER },
    { role: 'user', content: '[agent-os] Zach → @coder: rebase\n(session: agent:coder:subagent:x)' },
    { role: 'user', content: '[agent-os] Zach: stop after tests' },
    { role: 'user', content: '[Inter-session message] sourceSession=agent:main:main sourceTool=sessions_send isUser=false\nThis content was routed by OpenClaw from another session or internal tool.\nPlease also check staging.' },
    { role: 'user', content: 'keep going', __openclaw: { senderIsOwner: true } },
  ], { key: SUB, spawnedBy: 'agent:main:dashboard:d1' });
  assert.deepEqual(items.map((i) => i.from), ['zach', 'zach', 'zach', 'agent:main:main', 'agent:main:dashboard:d1']);
  assert.equal(items[1].relay, 'coder');
  assert.equal(items[1].text, 'rebase');
  assert.equal(items[2].text, 'stop after tests');
  assert.equal(items[3].text, 'Please also check staging.');
  assert.deepEqual(parseRelay('[agent-os] Zach: hi'), { body: 'hi' });
});

test('outside subagent sessions an untagged user message has no sender', () => {
  const [item] = toHistoryItems([{ role: 'user', content: 'hello' }], { key: 'agent:coder:main' });
  assert.equal(item.from, undefined);
});

test('assistant messages keep full text and one tool entry per call, with results and errors attached', () => {
  const long = 'x'.repeat(5000);
  const items = toHistoryItems([
    { role: 'assistant', content: [
      { type: 'text', text: long },
      { type: 'toolcall', id: 't1', name: 'Bash', arguments: JSON.stringify({ command: 'ls -la', description: 'list files' }) },
      { type: 'tool_result', tool_use_id: 't1', content: 'a\nb', is_error: false },
      { type: 'toolCall', id: 't2', name: 'Read', arguments: { file_path: '/tmp/x.ts' } },
    ] },
    { role: 'toolResult', toolCallId: 't2', content: [{ type: 'text', text: 'ENOENT' }], isError: true },
  ], { key: 'agent:coder:main' });
  assert.equal(items.length, 1);
  assert.equal(items[0].text.length, 5000);
  assert.equal(items[0].from, 'agent:coder:main');
  assert.deepEqual(items[0].tools!.map((t) => [t.name, t.summary, t.result, !!t.error]), [['Bash', 'list files', 'a\nb', false], ['Read', '/tmp/x.ts', 'ENOENT', true]]);
});

test('system and custom rows become notices; a failed model call becomes an error notice', () => {
  const items = toHistoryItems([
    { role: 'user', content: 'System: [2026-10-07 19:30:10 EDT] Node connected' },
    { role: 'custom', customType: 'run-failed-before-reply', content: 'This turn ended before a reply', display: true },
    { role: 'custom', content: 'hidden', display: false },
    { role: 'assistant', content: [], errorMessage: '429 rate limited' },
  ], { key: 'agent:coder:main', redact: (s) => s.replace('429', '[n]') });
  assert.deepEqual(items.map((i) => [i.notice, i.text]), [['system', 'System: [2026-10-07 19:30:10 EDT] Node connected'], ['error', 'This turn ended before a reply'], ['error', '[n] rate limited']]);
});

test('tool summary prefers the description, then the command or path, on one line', () => {
  assert.equal(toolSummary('{"command":"git status\\n--short","description":"Show status"}'), 'Show status');
  assert.equal(toolSummary({ command: 'git   status\n--short' }), 'git status --short');
  assert.equal(toolSummary({ other: 1 }), '');
  assert.equal(toolSummary('x'.repeat(300)).length, 200);
});

test('the in-flight run yields the streaming text and tool lines not already in the transcript', () => {
  const live = liveRunOf({
    text: 'Reading context.',
    events: [
      { stream: 'tool', data: { phase: 'start', name: 'Bash', toolCallId: 'a' } },
      { stream: 'item', data: { kind: 'tool', phase: 'end', name: 'Bash', toolCallId: 'a', title: 'Bash list files in ~/x', status: 'completed' } },
      { stream: 'tool', data: { phase: 'start', name: 'Read', toolCallId: 'b' } },
      { stream: 'tool', data: { phase: 'start', name: 'Edit', toolCallId: 'old' } },
    ],
  }, new Set(['old']));
  assert.deepEqual(live, { text: 'Reading context.', tools: [{ id: 'a', name: 'Bash', summary: 'list files in ~/x' }, { id: 'b', name: 'Read', summary: '', running: true }] });
  assert.equal(liveRunOf(undefined, new Set()), undefined);
});

test('status reports real tokens and cost, falls back to sessions.usage, and marks a running turn with no usage yet as pending', () => {
  assert.deepEqual(sessionStatusOf('k', { status: 'done', totalTokens: 111874, estimatedCostUsd: 0.0243, model: 'claude-opus-5-5', updatedAt: 9 }), { key: 'k', state: 'done', running: false, model: 'claude-opus-5-5', tokens: 111874, costUsd: 0.0243, updatedAt: 9 });
  assert.deepEqual(sessionStatusOf('k', { status: 'done' }, { tokens: 320451, costUsd: 0 }), { key: 'k', state: 'done', running: false, tokens: 320451 });
  const running = sessionStatusOf('k', { status: 'running', hasActiveRun: true, startedAt: 100 });
  assert.equal(running.running, true);
  assert.equal(running.usagePending, true);
  assert.equal(running.startedAt, 100);
  assert.deepEqual(usageFromSessionsUsage({ sessions: [{ usage: { totalTokens: 320451, totalCost: 0 } }] }), { tokens: 320451, costUsd: 0 });
  assert.equal(usageFromSessionsUsage({ sessions: [{ usage: null }] }), undefined);
});
