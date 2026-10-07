import { ageLabel } from '../../shared/board';
import { openNeedsOf } from '../../shared/activity';
import { STATE_LABEL, deriveWork, isHiddenByDefault, visibleWork, type WorkRow, type WorkState } from '../../shared/work';
import type { ShellState, ShellStore } from '../store';
import { avatarHtml, esc, nameOf, svg } from './format';

const PAINT_MS = 1000;
const STATES: WorkState[] = ['needs', 'blocked', 'working', 'done'];

export function mountWork(el: HTMLElement, store: ShellStore, opts: { onOpenSession: (key: string) => void }) {
  el.innerHTML = `<div class="wk-wrap">
    <header class="wk-head">
      <h2>Work in flight</h2>
      <div class="wk-counts"></div>
      <span class="grow"></span>
      <button class="wk-toggle" aria-pressed="false" title="Also show finished work older than 4 hours and automation / cron runs"><span>Show idle + automation</span><b>0</b></button>
    </header>
    <div class="wk-cols" aria-hidden="true"><span>State</span><span>Work</span><span>Lead</span><span>Last milestone</span><span>Blocker</span><span>Age</span></div>
    <div class="wk-list" role="list"></div>
  </div>`;
  const list = el.querySelector<HTMLElement>('.wk-list')!;
  const counts = el.querySelector<HTMLElement>('.wk-counts')!;
  const toggle = el.querySelector<HTMLButtonElement>('.wk-toggle')!;
  let timer: number | undefined;
  let last = 0;

  toggle.addEventListener('click', () => store.setShowAllWork(!store.get().showAllWork));
  list.addEventListener('click', (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>('.wk-row');
    if (row?.dataset.session) opts.onOpenSession(row.dataset.session);
  });

  const matches = (r: WorkRow, q: string) => !q || [r.key, r.title, r.leadName, r.blocker ?? '', r.mrs.join(' '), r.milestone?.label ?? '', r.now ?? ''].some((x) => x.toLowerCase().includes(q));

  function rowHtml(s: ShellState, r: WorkRow, now: number) {
    const ms = r.milestone;
    const keyChip = r.ticket ? `<span class="wk-key">${esc(r.ticket)}</span>` : '';
    const mrs = r.mrs.map((m) => `<span class="wk-mr">${esc(m)}</span>`).join('');
    return `<button class="wk-row st-${r.state}" role="listitem" data-key="${esc(r.key)}" data-session="${esc(r.session)}" title="Open ${esc(nameOf(s, r.session) || r.session)}">
      <span class="wk-state"><i></i>${STATE_LABEL[r.state]}</span>
      <span class="wk-main"><span class="wk-line">${keyChip}${mrs}<span class="wk-title">${esc(r.title)}</span></span>${r.now ? `<span class="wk-now">${esc(r.now)}</span>` : ''}</span>
      <span class="wk-lead">${avatarHtml(r.lead || 'main', r.leadName, undefined, 'sm')}<span>${esc(r.leadName)}</span></span>
      <span class="wk-ms${ms?.bad ? ' bad' : ''}">${ms ? `<b>${esc(ms.label)}</b><small>${esc(nameOf(s, ms.by))} · ${ageLabel(ms.ts, now)} ago</small>` : '<span class="wk-none">—</span>'}</span>
      <span class="wk-block">${r.blocker ? esc(r.blocker) : '<span class="wk-none">—</span>'}</span>
      <span class="wk-age" title="First seen ${esc(new Date(r.startedAt).toLocaleString())}; last activity ${ageLabel(r.updatedAt, now)} ago">${ageLabel(r.startedAt, now)}</span>
    </button>`;
  }

  function paint() {
    timer = undefined;
    last = Date.now();
    const s = store.get();
    const now = Date.now();
    const events = store.events();
    const rows = deriveWork({ agents: [...s.agentsAll.values()], events, openNeeds: openNeedsOf(events, now), now });
    const { rows: shown } = visibleWork(rows, s.showAllWork, now);
    const filtered = shown.filter((r) => matches(r, s.query));
    const n = (st: WorkState) => shown.filter((r) => r.state === st).length;
    counts.innerHTML = STATES.map((st) => `<span class="wk-count st-${st}"><i></i>${STATE_LABEL[st]} <b>${n(st)}</b></span>`).join('');
    toggle.setAttribute('aria-pressed', String(s.showAllWork));
    toggle.classList.toggle('on', s.showAllWork);
    toggle.querySelector('b')!.textContent = String(rows.filter((r) => isHiddenByDefault(r, now)).length);
    if (!s.loaded) list.innerHTML = `<div class="wk-empty"><div class="spinner"></div><b>Connecting to the fleet…</b></div>`;
    else if (!filtered.length) list.innerHTML = `<div class="wk-empty">${svg('board', 22)}<b>${s.query ? 'No work matches the search' : 'Nothing in flight'}</b><span>Rows appear when an agent works on a Jira ticket or an MR, or asks you something.</span></div>`;
    else list.innerHTML = filtered.map((r) => rowHtml(s, r, now)).join('');
  }

  return {
    update() {
      if (el.hidden || timer !== undefined) return;
      const wait = Math.max(0, PAINT_MS - (Date.now() - last));
      timer = window.setTimeout(paint, wait);
    },
    paintNow() { clearTimeout(timer); paint(); },
  };
}
