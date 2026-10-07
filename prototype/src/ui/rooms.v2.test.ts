// Rooms v2 rendering: usage chip, participants strip, soft-pause and interrupted banners, queued/pinned messages, hand-off chips, notes + settings, and the calls the buttons make.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { setDomWindow } from '../../shared/markdown.ts';

const dom = new JSDOM('<!doctype html><html><body><div id="a"></div></body></html>', { url: 'http://localhost/agent-os/' });
const w = dom.window as unknown as Window & typeof globalThis;
Object.assign(globalThis, { window: w, document: w.document, HTMLElement: w.HTMLElement, Event: w.Event, MouseEvent: w.MouseEvent, KeyboardEvent: w.KeyboardEvent });
setDomWindow(dom.window);
const { mountRooms } = await import('./rooms.ts');

const members = [{ id: 'alpha', name: 'Alpha' }, { id: 'bravo', name: 'Bravo' }];
let run: Record<string, unknown> | null = null;
let room: Record<string, any> = {};
const calls: Array<[string, unknown]> = [];
const resetRoom = () => {
  room = { id: 'r00000001', name: 'Test', members: ['alpha', 'bravo'], captain: 'alpha', mentionGating: true, responderMode: 'everyone', pauseAfterPosts: 24, pauseAfterTokens: 0, speakFilter: false, archived: false, createdAt: 1, updatedAt: 1, notes: '',
    usage: { turns: 9, inputTokens: 9000, outputTokens: 900, costUsd: 0.2, estimated: false },
    messages: [
      { id: 'm1', ts: 1, from: 'you', text: 'plan?' },
      { id: 'm2', ts: 2, from: 'alpha', text: 'Over to @bravo for numbers', round: 1 },
      { id: 'm3', ts: 3, from: 'bravo', text: 'Numbers fine.', round: 2, pinned: true },
      { id: 'm4', ts: 4, from: 'you', text: 'also cost?', queued: true },
    ] };
};
(globalThis as { fetch: unknown }).fetch = async (u: string, init?: { body?: string }) => {
  const url = String(u);
  if (init?.body !== undefined) calls.push([url.replace(/^.*\/api\//, '').replace(/\?.*$/, ''), JSON.parse(init.body)]);
  const body = /rooms\/r00000001/.test(url) ? { room, members, run } : { rooms: [{ id: room.id, name: room.name, members: room.members, captain: room.captain, archived: false, updatedAt: 1, running: !!run, paused: false }], agents: members };
  return { ok: true, status: 200, json: async () => body };
};
const tick = (ms = 25) => new Promise((r) => setTimeout(r, ms));
async function open() {
  const el = w.document.createElement('div'); // a fresh element per test: mountRooms leaves its listeners on it
  w.document.body.append(el);
  const rooms = mountRooms(el, { source: 'live' } as never, () => {});
  rooms.show(); await tick();
  el.querySelector<HTMLElement>('[data-room]')!.click(); await tick();
  return { el, rooms };
}

test('a running discussion: usage chip with last speaker, per-agent strip (thinking / tool / waiting), queued tag, hand-off chip with hop, pin state, and the composer queues', async () => {
  resetRoom();
  run = { id: 'run1', status: 'running', round: 2, turnsUsed: 4, active: ['bravo'], activity: [{ id: 'bravo', state: 'tool', tool: 'web_search', since: Date.now() - 4000 }, { id: 'alpha', state: 'waiting', since: Date.now(), waitingOn: ['bravo'] }],
    posts: 2, usage: { turns: 4, inputTokens: 3000, outputTokens: 500, costUsd: 0.05, estimated: false }, lastSpeaker: 'bravo' };
  const { el, rooms } = await open();
  const chip = el.querySelector<HTMLElement>('[data-usage]')!;
  assert.match(chip.textContent!, /4 turns · 4k tok · \$0\.050 · last: Bravo/);
  assert.match(chip.title, /This discussion: 4 turns, 3,500 tokens, \$0\.050/);
  assert.match(chip.title, /Whole room: 9 turns, 9,900 tokens, \$0\.200/);
  const st = [...el.querySelectorAll<HTMLElement>('.rm-st')];
  assert.deepEqual(st.map((s) => `${s.dataset.state}:${s.querySelector('b')!.textContent}`), ['waiting:Alpha', 'tool:Bravo']);
  assert.match(st[0].querySelector('small')!.textContent!, /waiting on Bravo/);
  assert.match(st[1].querySelector('small')!.textContent!, /using web_search · [0-9]s/);
  const hand = el.querySelector<HTMLElement>('[data-msg=m2] .rm-hand')!;
  assert.match(hand.textContent!, /Bravo/);
  assert.match(hand.textContent!, /hop 1/);
  assert.ok(el.querySelector('[data-msg=m4].queued .rm-q'), 'the queued message is tagged');
  assert.equal(el.querySelector('[data-msg=m4] [data-pin]'), null, 'a queued message cannot be pinned yet');
  assert.equal(el.querySelector('[data-msg=m3] .rm-pin')!.getAttribute('aria-pressed'), 'true');
  assert.ok(el.querySelector('[data-msg=m3].pinned .rm-pinned'));
  const box = el.querySelector<HTMLTextAreaElement>('.rm-compose textarea')!;
  assert.equal(box.disabled, false, 'you can write while agents are talking');
  assert.match(box.placeholder, /Queue a message/);
  assert.match(el.querySelector('[data-act=send]')!.textContent!, /Queue/);
  assert.ok(el.querySelector('.rm-status [data-act=end]') && el.querySelector('.rm-status [data-act=stop]'));
  assert.ok(el.querySelector<HTMLButtonElement>('[data-remove]')!.disabled, 'members cannot change mid-run');
  rooms.hide();
});

test('a soft pause shows Continue / End now / Stop and says nothing is capped; the buttons call continue/end/stop; writing is allowed', async () => {
  resetRoom();
  run = { id: 'run1', status: 'paused', round: 5, turnsUsed: 20, active: [], activity: [], posts: 24, usage: { turns: 20, inputTokens: 1, outputTokens: 1, costUsd: 0, estimated: true }, pause: { reason: 'posts', detail: '24 replies since you last wrote', at: 1 } };
  const { el, rooms } = await open();
  const b = el.querySelector<HTMLElement>('.rm-banner.pause')!;
  assert.match(b.textContent!, /Paused to check in/);
  assert.match(b.textContent!, /24 replies since you last wrote/);
  assert.match(b.textContent!, /Nothing is capped/);
  assert.equal(el.querySelector('.rm-st')!.getAttribute('data-state'), 'paused');
  assert.equal(el.querySelector<HTMLTextAreaElement>('.rm-compose textarea')!.disabled, false);
  assert.match(el.querySelector('[data-usage]')!.textContent!, /~/, 'an estimated total is marked');
  calls.length = 0;
  el.querySelector<HTMLElement>('.rm-banner [data-act=resume]')!.click(); await tick();
  el.querySelector<HTMLElement>('.rm-banner [data-act=end]')!.click(); await tick();
  el.querySelector<HTMLElement>('.rm-banner [data-act=stop]')!.click(); await tick();
  assert.deepEqual(calls.map((c) => c[0]), ['rooms/r00000001/continue', 'rooms/r00000001/end', 'rooms/r00000001/stop']);
  rooms.hide();
});

test('after a restart the room says the last run was interrupted and not replayed', async () => {
  resetRoom();
  run = { id: 'run1', status: 'interrupted', round: 2, turnsUsed: 4, active: [], activity: [], stopReason: 'interrupted' };
  const { el, rooms } = await open();
  const b = el.querySelector<HTMLElement>('.rm-banner.interrupted')!;
  assert.match(b.textContent!, /Interrupted by a restart/);
  assert.match(b.textContent!, /not replayed/);
  assert.equal(el.querySelector('.rm-strip'), null);
  rooms.hide();
});

test('regression: with the notes box open, typing in it never leaks into the composer and Send posts the composer text, not the notes', async () => {
  resetRoom();
  run = null;
  const { el, rooms } = await open();
  el.querySelector<HTMLElement>('[data-act=more]')!.click();
  el.querySelector<HTMLElement>('.rm-menu [data-act=notes-toggle]')!.click();
  const notes = el.querySelector<HTMLTextAreaElement>('.rm-notes-in')!;
  notes.value = 'Budget is 5k'; notes.dispatchEvent(new w.Event('input', { bubbles: true }));
  await tick(1300); // a poll repaints the view while the notes box has text
  const box = el.querySelector<HTMLTextAreaElement>('.rm-compose textarea')!;
  assert.equal(box.value, '', 'the composer stays empty');
  box.value = 'hello room'; box.dispatchEvent(new w.Event('input', { bubbles: true }));
  calls.length = 0;
  el.querySelector<HTMLElement>('[data-act=send]')!.click(); await tick();
  assert.deepEqual(calls.map((c) => c[1]), [{ message: 'hello room' }]);
  assert.equal(el.querySelector<HTMLTextAreaElement>('.rm-notes-in')!.value, 'Budget is 5k', 'the unsaved notes draft survives the repaint');
  rooms.hide();
});

test('menu actions and panels: wrap up, end, notes (save + decisions + unpin), settings (mode, limits, opt-in speak filter)', async () => {
  resetRoom();
  run = null;
  const { el, rooms } = await open();
  const modeSel = el.querySelector<HTMLSelectElement>('[data-set=responderMode]')!;
  assert.deepEqual([...modeSel.options].map((o) => o.textContent), ['Quiet', 'Everyone', 'Mentions only', 'Lead first']);
  calls.length = 0;
  modeSel.value = 'lead'; modeSel.dispatchEvent(new w.Event('change', { bubbles: true })); await tick();
  assert.deepEqual(calls[0], ['rooms/r00000001', { responderMode: 'lead' }]);

  el.querySelector<HTMLElement>('[data-act=more]')!.click();
  assert.equal(el.querySelector<HTMLButtonElement>('.rm-menu [data-act=end]')!.disabled, true, 'nothing to end while idle');
  calls.length = 0;
  el.querySelector<HTMLElement>('.rm-menu [data-act=wrapup]')!.click(); await tick();
  assert.deepEqual(calls[0], ['rooms/r00000001/wrapup', {}]);

  el.querySelector<HTMLElement>('[data-act=more]')!.click();
  el.querySelector<HTMLElement>('.rm-menu [data-act=notes-toggle]')!.click();
  const notes = el.querySelector<HTMLTextAreaElement>('.rm-notes-in')!;
  assert.equal(el.querySelector<HTMLButtonElement>('[data-act=notes-save]')!.disabled, true);
  notes.value = 'Budget is 5k'; notes.dispatchEvent(new w.Event('input', { bubbles: true }));
  assert.equal(el.querySelector<HTMLButtonElement>('[data-act=notes-save]')!.disabled, false);
  assert.match(el.querySelector('.rm-decisions')!.textContent!, /Bravo.*Numbers fine/);
  calls.length = 0;
  el.querySelector<HTMLElement>('[data-act=notes-save]')!.click(); await tick();
  assert.deepEqual(calls[0], ['rooms/r00000001', { notes: 'Budget is 5k' }]);
  calls.length = 0;
  el.querySelector<HTMLElement>('.rm-decisions [data-pin]')!.click(); await tick();
  assert.deepEqual(calls[0], ['rooms/r00000001/pin', { messageId: 'm3', pinned: false }]);

  el.querySelector<HTMLElement>('[data-act=more]')!.click();
  el.querySelector<HTMLElement>('.rm-menu [data-act=settings-toggle]')!.click();
  const posts = el.querySelector<HTMLInputElement>('[data-set=pauseAfterPosts]')!;
  assert.equal(posts.value, '24');
  calls.length = 0;
  posts.value = '40'; posts.dispatchEvent(new w.Event('change', { bubbles: true })); await tick();
  assert.deepEqual(calls[0], ['rooms/r00000001', { pauseAfterPosts: '40' }]);
  const filter = el.querySelector<HTMLInputElement>('[data-setbool=speakFilter]')!;
  assert.equal(filter.checked, false, 'the speak filter is off by default');
  calls.length = 0;
  filter.checked = true; filter.dispatchEvent(new w.Event('change', { bubbles: true })); await tick();
  assert.deepEqual(calls[0], ['rooms/r00000001', { speakFilter: true }]);
  rooms.hide();
  dom.window.close();
});
