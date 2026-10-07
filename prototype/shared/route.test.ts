import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canSendDirect, routeMessage } from './route.ts';

test('a message to any agent but main goes to agent:main:main with the relay prefix', () => {
  assert.deepEqual(routeMessage('agent:agent-service-lead:main', 'rebase onto !980'), {
    key: 'agent:main:main', message: '[agent-os] Zach → @agent-service-lead: rebase onto !980', relayed: true, agent: 'agent-service-lead',
  });
  assert.equal(routeMessage('agent:agent-service-coder:subagent:abc', 'stop').message, '[agent-os] Zach → @agent-service-coder: stop\n(session: agent:agent-service-coder:subagent:abc)');
});

test('main sessions are messaged directly', () => {
  assert.deepEqual(routeMessage('agent:main:dashboard:d1', 'hi'), { key: 'agent:main:dashboard:d1', message: 'hi', relayed: false, agent: 'main' });
  assert.equal(routeMessage('agent:main:main', 'hi').relayed, false);
});

test('send direct only for agents with no lead or main approval chain', () => {
  for (const k of ['agent:coder:main', 'agent:radar:cron:x', 'agent:scout:main']) {
    assert.ok(canSendDirect(k), k);
    assert.deepEqual(routeMessage(k, 'go', true), { key: k, message: 'go', relayed: false, agent: k.split(':')[1] });
  }
  for (const k of ['agent:agent-service-lead:main', 'agent:security:subagent:s', 'agent:main:main']) assert.ok(!canSendDirect(k), k);
  assert.throws(() => routeMessage('agent:agent-service-coder:main', 'go', true), /direct send is only for agents/);
  assert.equal(routeMessage('agent:coder:main', 'go', false).relayed, true, 'direct is opt-in');
  assert.throws(() => routeMessage('nonsense', 'x'), /unknown session/);
});
