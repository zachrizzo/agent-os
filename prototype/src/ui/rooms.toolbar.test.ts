// The room header's ⋯ menu: host actions appear only when the framing plugin offers them, and act on the captain's room session.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { setDomWindow } from '../../shared/markdown.ts';

const dom = new JSDOM('<!doctype html><html><body><div id="a"></div><div id="b"></div></body></html>', { url: 'http://localhost/agent-os/' });
const w = dom.window as unknown as Window & typeof globalThis;
Object.assign(globalThis, { window: w, document: w.document, HTMLElement: w.HTMLElement, Event: w.Event, MouseEvent: w.MouseEvent, KeyboardEvent: w.KeyboardEvent });
setDomWindow(dom.window);
const { mountRooms } = await import('./rooms.ts');

const agent = { id: 'alpha', name: 'Alpha' };
const room = { id: 'r00000001', name: 'Test', members: ['alpha'], captain: 'alpha', mode: 'council', maxRounds: 1, maxSteps: 3, archived: false, councils: [], messages: [] };
(globalThis as { fetch: unknown }).fetch = async (u: string) => {
  const body = /rooms\/r00000001/.test(String(u)) ? { room, members: [agent], run: null } : { rooms: [{ ...room, last: null, running: false }], agents: [agent] };
  return { ok: true, status: 200, json: async () => body };
};
const tick = () => new Promise((r) => setTimeout(r, 25));

async function open(host?: Parameters<typeof mountRooms>[3], id = 'a') {
  const el = w.document.getElementById(id)!;
  const rooms = mountRooms(el, { source: 'live' } as never, () => {}, host);
  rooms.show(); await tick();
  el.querySelector<HTMLElement>('[data-room]')!.click(); await tick();
  return { el, rooms };
}

test('without host actions the menu holds only the room actions (notes, settings, wrap up, end, rename, archive)', async () => {
  const { el, rooms } = await open(undefined, 'a');
  el.querySelector<HTMLElement>('[data-act=more]')!.click();
  const items = [...el.querySelectorAll('.rm-menu [role=menuitem]')].map((b) => b.textContent!.trim());
  assert.deepEqual(items, ['Notes & decisions', 'Room settings', 'Ask lead to summarize', 'End discussion now', 'Rename room', 'Archive room']);
  rooms.hide();
});

test("with open-session the menu offers the captain's chat and runs it on the captain's room session; Escape closes the menu", async () => {
  const calls: Array<[string, string]> = [];
  const host = { has: (a: string) => a === 'open-session', run: async (a: string, k: string) => { calls.push([a, k]); }, onChange: () => {} };
  const { el, rooms } = await open(host as never, 'b');
  assert.equal(el.querySelector('.rm-menu'), null, 'menu starts closed');
  el.querySelector<HTMLElement>('[data-act=more]')!.click();
  const cap = el.querySelector<HTMLElement>('[data-act=open-captain]')!;
  assert.ok(cap, "captain's chat item present");
  cap.click();
  assert.deepEqual(calls, [['open-session', 'agent:alpha:room-r00000001']]);
  assert.equal(el.querySelector('.rm-menu'), null, 'menu closes after choosing');
  el.querySelector<HTMLElement>('[data-act=more]')!.click();
  assert.ok(el.querySelector('.rm-menu'));
  el.querySelector<HTMLElement>('.rm-menu button')!.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(el.querySelector('.rm-menu'), null, 'Escape closes the menu');
  rooms.hide();
  dom.window.close();
});
