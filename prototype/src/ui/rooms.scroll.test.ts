// Regression: a poll repaint of the room thread must not reset the user's scroll position.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { setDomWindow } from '../../shared/markdown.ts';

const dom = new JSDOM('<!doctype html><html><body><div id="host"></div></body></html>', { url: 'http://localhost/agent-os/' });
const w = dom.window as unknown as Window & typeof globalThis;
Object.assign(globalThis, { window: w, document: w.document, HTMLElement: w.HTMLElement, Event: w.Event, MouseEvent: w.MouseEvent });
setDomWindow(dom.window);

// jsdom has no layout: give every .rm-thread a 1000px-tall content in a 300px viewport and a real, settable scrollTop.
const tops = new WeakMap<Element, number>();
const proto = w.HTMLElement.prototype;
Object.defineProperty(proto, 'scrollTop', { configurable: true, get() { return tops.get(this) ?? 0; }, set(v: number) { tops.set(this, Math.max(0, Math.min(v, 700))); } });
Object.defineProperty(proto, 'scrollHeight', { configurable: true, get() { return 1000; } });
Object.defineProperty(proto, 'clientHeight', { configurable: true, get() { return 300; } });

const { mountRooms } = await import('./rooms.ts');

const messages = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `m${i}`, from: i % 2 ? 'alpha' : 'you', text: `message ${i}`, ts: 1700000000000 + i * 1000 }));
let n = 5;
const room = () => ({ id: 'r1', name: 'Test', members: ['alpha'], captain: 'alpha', mode: 'roundtable', maxRounds: 1, maxTurns: 3, maxSteps: 3, memberTimeoutSec: 60, archived: false, councils: [], messages: messages(n) });
const agent = { id: 'alpha', name: 'Alpha' };
(globalThis as { fetch: unknown }).fetch = async (u: string) => {
  const body = /rooms\/r1/.test(String(u)) ? { room: room(), members: [agent], run: null } : { rooms: [{ ...room(), last: null, running: false }], agents: [agent] };
  return { ok: true, status: 200, json: async () => body };
};

test('poll repaint keeps scroll position when scrolled up, and follows new messages when at the bottom', async () => {
  const host = w.document.getElementById('host')!;
  const rooms = mountRooms(host, { source: 'live' } as never, () => {});
  const poll = async () => { rooms.show(); await new Promise((r) => setTimeout(r, 20)); };
  await poll();
  host.querySelector<HTMLElement>('[data-room="r1"]')!.click();
  await new Promise((r) => setTimeout(r, 20));
  const th = () => host.querySelector<HTMLElement>('.rm-thread')!;
  assert.equal(th().scrollTop, 700, 'opens at the bottom');

  // user scrolls up, then a poll lands with a new message
  th().scrollTop = 200; th().dispatchEvent(new w.Event('scroll'));
  n = 6; await poll();
  assert.equal(th().querySelectorAll('.rm-msg').length, 6, 'new message rendered');
  assert.equal(th().scrollTop, 200, 'stays where the user put it (was jumping to 0)');
  await poll();
  assert.equal(th().scrollTop, 200, 'idle poll keeps it too');

  // scrolled back near the bottom: new messages are followed
  th().scrollTop = 690; th().dispatchEvent(new w.Event('scroll'));
  n = 7; await poll();
  assert.equal(th().scrollTop, 700, 'follows new messages near the bottom');
  rooms.hide();
});
