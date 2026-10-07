import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lastStep, nowFromProgress, progressOf, toolVerb } from './progress.ts';

const tool = (phase: string, name: string, id: string) => ({ stream: 'tool', data: { phase, name, toolCallId: id } });

test('the tool in flight is the one started without a result; the step is the latest progress line', () => {
  const p = progressOf({
    text: 'Reading the worker.\n\nTest fails without the fix, passes with it. Full gate, then commit.',
    events: [tool('start', 'Read', 'a'), tool('result', 'Read', 'a'), { stream: 'item', data: { phase: 'end', name: 'Read' } }, tool('start', 'Bash', 'b')],
  });
  assert.deepEqual(p, { tool: 'Bash', step: 'Test fails without the fix, passes with it.' });
  assert.equal(nowFromProgress(p, 'Working'), 'Running a command · Test fails without the fix, passes with it.');
});

test('no open tool: the step alone; nothing usable: the fallback', () => {
  assert.equal(nowFromProgress(progressOf({ text: '**Checking** the `router` tests.', events: [tool('start', 'Grep', 'a'), tool('result', 'Grep', 'a')] }), 'x'), 'Checking the router tests.');
  assert.equal(nowFromProgress(progressOf({ events: [tool('start', 'sessions_spawn', 'a')] }), 'x'), 'Starting a worker');
  assert.equal(nowFromProgress(progressOf(null), 'Working: AIPIT-1'), 'Working: AIPIT-1');
  assert.equal(nowFromProgress(progressOf({ text: '', events: [] }), 'Working'), 'Working');
});

test('tables and rules are skipped when picking the step; unknown and MCP tools read naturally', () => {
  assert.equal(lastStep('Both items are fixed.\n\n| Item | SHA |\n|---|---|\n| a | b |'), 'Both items are fixed.');
  assert.equal(toolVerb('mcp__gitlab__get_merge_request'), 'Using gitlab get merge request');
  assert.equal(toolVerb('Edit'), 'Editing files');
});
