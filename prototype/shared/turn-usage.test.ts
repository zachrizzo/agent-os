import assert from 'node:assert/strict';
import { test } from 'node:test';
import { toolInFlight, usageFromMessages } from './turn-usage.ts';

test('usage: sums assistant usage across spellings, adds cache tokens to input, reads cost; none -> undefined (the caller estimates)', () => {
  assert.equal(usageFromMessages([]), undefined);
  assert.equal(usageFromMessages([{ role: 'assistant', content: 'hi' }, { role: 'user', usage: { input: 5 } }]), undefined);
  assert.deepEqual(usageFromMessages([
    { role: 'assistant', usage: { input: 100, output: 10, cacheRead: 40, cost: { total: 0.002 } } },
    { role: 'assistant', usage: { input_tokens: 50, output_tokens: 5, cache_creation_input_tokens: 10, costUsd: 0.001 } },
  ]), { inputTokens: 200, outputTokens: 15, costUsd: 0.003 });
  assert.deepEqual(usageFromMessages([{ role: 'assistant', usage: { inputTokens: 7, outputTokens: 3 } }]), { inputTokens: 7, outputTokens: 3 });
  assert.equal(usageFromMessages([{ role: 'assistant', usage: { input: -5, output: 'x' } }]), undefined);
});

test('tool in flight: only while the newest message is an assistant tool call with no result yet', () => {
  const call = { role: 'assistant', content: [{ type: 'text', text: 'let me look' }, { type: 'toolCall', name: 'web_search' }] };
  assert.equal(toolInFlight([{ role: 'user', content: 'q' }, call]), 'web_search');
  assert.equal(toolInFlight([call, { role: 'toolResult', content: 'x' }]), undefined);
  assert.equal(toolInFlight([{ role: 'assistant', content: 'plain text' }]), undefined);
  assert.equal(toolInFlight([{ role: 'assistant', content: [{ type: 'tool_use', name: 'exec' }] }]), 'exec');
  assert.equal(toolInFlight([]), undefined);
});
