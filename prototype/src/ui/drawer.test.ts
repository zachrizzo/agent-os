import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { setDomWindow } from '../../shared/markdown.ts';
import type { HistoryItem } from '../../shared/types.ts';
import type { SessionThread } from '../../shared/transcript.ts';

const dom = new JSDOM('<!doctype html><html><body><div id="app"><main id="center"></main><section id="drawer"></section></div></body></html>', { url: 'http://localhost/agent-os/', pretendToBeVisual: true });
const w = dom.window as unknown as Window & typeof globalThis;
Object.assign(globalThis, { window: w, document: w.document, HTMLElement: w.HTMLElement, Event: w.Event, MouseEvent: w.MouseEvent, KeyboardEvent: w.KeyboardEvent, localStorage: w.localStorage });
setDomWindow(dom.window);
const { mountDrawer } = await import('./drawer.ts');

const SUB = 'agent:engineering-lead:subagent:8f00';
const LEAD = 'agent:engineering-lead:main';
const agent = (id: string, name: string, agentId: string) => ({ id, name, agentName: name, team: 'eng', role: 'worker', status: 'active', now: 'Working', costUsd: 0, tokens: 0, updatedAt: 1, agentId, kind: id.includes(':subagent:') ? 'subagent' : 'main', model: 'claude-opus-5-5' });
const state = {
  agentsAll: new Map([[SUB, agent(SUB, 'engineering-lead', 'engineering-lead')], [LEAD, agent(LEAD, 'engineering-lead', 'engineering-lead')], ['agent:main:main', agent('agent:main:main', 'Chief of Staff', 'main')]]),
  teamsById: new Map([['eng', { id: 'eng', name: 'Engineering', hue: '#3ad1f0' }]]),
  selection: { type: 'none' },
};
const sent: Array<Record<string, unknown>> = [];
const store = {
  source: 'live',
  get: () => state,
  select: () => {},
  async sendMessage(key: string, text: string, direct = false) { sent.push({ key, text, direct }); return { to: direct ? key : 'agent:main:main', relayed: !direct, agent: 'engineering-lead' }; },
};

const tools = (n: number, from = 0) => Array.from({ length: n }, (_, i) => ({ id: `t${from + i}`, name: i % 2 ? 'Read' : 'Bash', summary: `step ${from + i}`, result: 'ok', ...(i === 1 ? { error: true } : {}) }));
let threads: Record<string, SessionThread> = {};
const items: HistoryItem[] = [
  { role: 'user', ts: 1, id: 'm1', from: 'agent:main:main', text: 'AIPIT-6435: fix the voice UX.\n\nRequester: agent:main:main.', task: { depth: '1/5' } },
  { role: 'user', ts: 2, id: 'm2', from: 'zach', text: 'also check staging' },
  { role: 'user', ts: 3, id: 'm3', from: 'agent:main:main', sender: 'main', text: 'Relayed from Zach: hold the push', a2a: { from: 'agent:main:main', routing: '[Inter-session message] sourceSession=agent:main:main' } },
  { role: 'assistant', ts: 4, id: 'm4', from: SUB, text: '## Plan\n\n- read the code', tools: tools(2) },
  { role: 'assistant', ts: 5, id: 'm6', from: SUB, text: Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n') },
  { role: 'assistant', ts: 6, id: 'm5', from: SUB, text: '', tools: tools(6, 2) },
  { role: 'custom', ts: 7, id: 'm7', text: 'This turn ended before a reply', notice: 'error' },
];
const reset = () => {
  threads = {
    [SUB]: { items: [...items], status: { key: SUB, state: 'running', running: true, model: 'claude-opus-5-5', startedAt: Date.now() - 6 * 60_000, usagePending: true }, live: { text: 'Reading context.', tools: [{ id: 'l1', name: 'Bash', summary: 'list files', running: true }] } },
    [LEAD]: { items: [{ role: 'assistant', ts: 1, id: 'x1', from: LEAD, text: 'done' }], status: { key: LEAD, state: 'done', running: false, tokens: 111874, costUsd: 0.0243, updatedAt: Date.now() - 120_000 } },
    'agent:main:main': { items: [], status: { key: 'agent:main:main', state: 'idle', running: false } },
  };
};
(globalThis as { fetch: unknown }).fetch = async (u: URL | string) => {
  const url = new URL(String(u));
  if (url.pathname.endsWith('/api/thread')) return { ok: true, status: 200, json: async () => threads[url.searchParams.get('key')!] ?? { items: [] } };
  return { ok: true, status: 200, json: async () => ({ items: [] }) };
};
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const el = w.document.getElementById('drawer')!;
const drawer = mountDrawer(el, store as never);
const text = (sel: string) => el.querySelector<HTMLElement>(sel)?.textContent?.replace(/\s+/g, ' ').trim() ?? '';

test('a subagent thread: compact task card from the Chief of Staff, You only for Zach, markdown replies, one line per tool call, long messages collapsed', async () => {
  reset();
  await drawer.openSession(SUB);
  const card = el.querySelector<HTMLDetailsElement>('.task-card')!;
  assert.ok(card && !card.open, 'task card is collapsed');
  assert.match(text('.task-card summary'), /Task\s*from Chief of Staff\s*depth 1\/5/);
  assert.ok(text('.task-card .tc-preview').startsWith('AIPIT-6435: fix the voice UX.'));
  assert.ok(!el.querySelector('.thread')!.textContent!.includes('[Subagent Context]'));
  const who = [...el.querySelectorAll('.thread .msg:not(.lr-msg) .m-who')].map((n) => n.textContent);
  assert.deepEqual(who, ['You', 'engineering-lead', 'engineering-lead']);
  assert.equal(text('.a2a .a2a-from'), 'Chief of Staff');
  assert.ok(el.querySelector('.msg.r-assistant .m-text.md h2'), 'markdown is rendered');
  const firstTools = el.querySelectorAll('.thread > .tools > .tl');
  assert.equal(firstTools.length, 2);
  assert.equal(firstTools[1].querySelector('.tl-flag')?.textContent, 'error');
  const group = el.querySelector<HTMLDetailsElement>('.thread > .tl-group')!;
  assert.match(text('.thread > .tl-group > summary'), /^6 tool calls/);
  assert.equal(group.querySelectorAll('.tl').length, 6);
  const long = el.querySelector<HTMLElement>('.m-long')!;
  assert.ok(long.textContent!.includes('line 39'), 'the whole message is in the DOM, not truncated');
  (long.nextElementSibling as HTMLElement).click();
  assert.ok(long.classList.contains('expanded'));
  assert.equal(long.nextElementSibling!.textContent, 'Show less');
  assert.equal(text('.notice.n-error .n-tag'), 'Error');
});

test('the header shows Working with the run time, and Spend says usage is pending while the first turn runs', async () => {
  reset();
  await drawer.openSession(SUB);
  assert.match(text('.d-status'), /^Working · 6m$/);
  assert.match(text('.d-spend'), /^Counting/);
  assert.match(text('.live-run .lr-head'), /Working\s*· Running a command/);
  assert.equal(el.querySelectorAll('.live-run .tl.run').length, 1);
});

test('a finished session shows real tokens and cost and an idle/done badge', async () => {
  reset();
  await drawer.openSession(LEAD);
  assert.equal(text('.d-spend'), '112k tok · $0.02');
  assert.match(text('.d-status'), /^Done · 2m ago$/);
  assert.equal(el.querySelector('.live-run'), null);
});

test('while running, new messages appear without a reload and open tool lines stay open', async () => {
  reset();
  await drawer.openSession(SUB);
  const grp = el.querySelector<HTMLDetailsElement>('.thread > .tl-group')!;
  grp.open = true;
  threads[SUB].items.push({ role: 'assistant', ts: 9, id: 'm9', from: SUB, text: 'Pushed the fix.' });
  w.document.dispatchEvent(new w.Event('visibilitychange'));
  await tick(80);
  assert.ok(el.querySelector('.thread')!.textContent!.includes('Pushed the fix.'));
  assert.ok(el.querySelector<HTMLDetailsElement>('.thread > .tl-group')!.open, 'expanded group survives the refresh');
  drawer.close();
});

test('the drawer is resizable, remembers its width, and expands to full width', async () => {
  reset();
  await drawer.openSession(LEAD);
  assert.ok(el.querySelector('.d-resize'));
  assert.equal(el.style.getPropertyValue('--drawer-w'), '600px');
  el.querySelector<HTMLElement>('.d-expand')!.click();
  assert.ok(el.classList.contains('full'));
  assert.equal(w.localStorage.getItem('agent-os:drawer-full'), '1');
  assert.equal(el.querySelector('.d-expand')!.getAttribute('aria-pressed'), 'true');
  el.querySelector<HTMLElement>('.d-expand')!.click();
  assert.ok(!el.classList.contains('full'));
  el.querySelector<HTMLElement>('.d-resize')!.dispatchEvent(new w.MouseEvent('dblclick', { bubbles: true }));
  assert.equal(w.localStorage.getItem('agent-os:drawer-width'), '600');
  drawer.close();
});

test('the composer defaults to Direct for a non-main session, can switch to Via Chief of Staff, and has no toggle for main', async () => {
  reset();
  sent.length = 0;
  await drawer.openSession(SUB);
  const mode = el.querySelector<HTMLElement>('.cmp-mode')!;
  assert.ok(!mode.hidden);
  assert.equal(el.querySelector('.cmp-mode [aria-checked=true]')!.textContent, 'Direct');
  assert.match(text('.cmp-via'), /straight to this @engineering-lead session/);
  const box = el.querySelector<HTMLTextAreaElement>('.d-compose textarea')!;
  box.value = 'ship it';
  box.dispatchEvent(new w.Event('input'));
  el.querySelector<HTMLElement>('.cmp-send')!.click();
  await tick();
  assert.deepEqual(sent.pop(), { key: SUB, text: 'ship it', direct: true });
  el.querySelector<HTMLElement>('[data-mode=relay]')!.click();
  assert.match(text('.cmp-via'), /Chief of Staff, who relays it to @engineering-lead/);
  assert.match(box.placeholder, /via Chief of Staff/);
  box.value = 'hold';
  box.dispatchEvent(new w.Event('input'));
  el.querySelector<HTMLElement>('.cmp-send')!.click();
  await tick();
  assert.deepEqual(sent.pop(), { key: SUB, text: 'hold', direct: false });
  await drawer.openSession('agent:main:main');
  assert.ok(el.querySelector<HTMLElement>('.cmp-mode')!.hidden);
  assert.match(text('.cmp-via'), /straight to this Chief of Staff session/);
  drawer.close();
});
