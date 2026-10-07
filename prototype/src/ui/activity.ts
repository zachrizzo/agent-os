// Right panel: filter chips, pinned "Needs you", and ONE chronological stream (newest first) with team colour dots; grouping by team is optional.
// Rows read "Sender → Recipient · KIND" with agent names (never a subagent's task label, never truncated), the outcome as an ellipsized summary and the task label as secondary text.
// Rendering is coalesced to at most ~10 fps and the DOM is capped at MAX_ROWS keyed rows.
import type { FleetEvent } from '../contract';
import type { Filter, ShellState, ShellStore } from '../store';
import { renderInline } from '../../shared/markdown';
import { sideTabsHtml } from './session-rows';
import { KIND_COLOR, KIND_LABEL, esc, fmtTime, hueOf, matchesFilter, matchesQuery, nameOf, openNeeds, svg } from './format';

const MAX_ROWS = 300;
const PER_GROUP = 4;
const PER_GROUP_OPEN = 60;
const MIN_FRAME_MS = 100;

const CHIPS: Array<[Filter, string]> = [['all', 'All'], ['needs', 'Needs you'], ['blocked', 'Blocked'], ['handoffs', 'Handoffs'], ['approvals', 'Approvals'], ['system', 'System']];

export function mountActivity(el: HTMLElement, store: ShellStore, openEvent: (e: FleetEvent) => void) {
  el.innerHTML = `
    ${sideTabsHtml('activity')}
    <div class="panel-head"><h2>Activity</h2><button class="grp-btn" type="button" aria-pressed="false" title="Group the stream by team">By team</button><span class="live-ind"><i></i><span>Live</span></span></div>
    <div class="chips">${CHIPS.map(([k, l]) => `<button data-f="${k}">${l}</button>`).join('')}</div>
    <div class="act-scroll">
      <section class="needs-box" hidden><header>${svg('warn', 15)}<span>Needs you</span><b class="needs-n"></b></header><div class="needs-list"></div></section>
      <div class="stream"></div>
      <div class="act-empty" hidden></div>
    </div>`;

  const chips = el.querySelector<HTMLElement>('.chips')!;
  const scroller = el.querySelector<HTMLElement>('.act-scroll')!;
  const needsBox = el.querySelector<HTMLElement>('.needs-box')!;
  const needsList = el.querySelector<HTMLElement>('.needs-list')!;
  const needsN = el.querySelector<HTMLElement>('.needs-n')!;
  const stream = el.querySelector<HTMLElement>('.stream')!;
  const empty = el.querySelector<HTMLElement>('.act-empty')!;

  const grpBtn = el.querySelector<HTMLButtonElement>('.grp-btn')!;
  let grouped = false;
  grpBtn.addEventListener('click', () => { grouped = !grouped; grpBtn.setAttribute('aria-pressed', String(grouped)); stream.classList.toggle('grouped', grouped); schedule(true); });
  const expanded = new Set<string>();
  const rowEls = new Map<string, HTMLElement>();
  const groupEls = new Map<string, HTMLElement>();
  let lastPaint = 0;
  let pending = false;
  let firstPaint = true;
  const byId = new Map<string, FleetEvent>();

  chips.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button');
    if (b) store.setFilter(b.dataset.f as Filter);
  });
  el.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    const more = t.closest<HTMLElement>('.g-more');
    if (more) { const g = more.dataset.g!; if (expanded.has(g)) expanded.delete(g); else expanded.add(g); schedule(true); return; }
    if (t.closest('.esum a, .ntitle a')) return; // a link in a preview opens in its own tab, not the drawer
    const row = t.closest<HTMLElement>('[data-ev]');
    if (row) { const ev = byId.get(row.dataset.ev!); if (ev) openEvent(ev); }
  });

  function schedule(now = false) {
    if (pending) return;
    pending = true;
    const wait = now ? 0 : Math.max(0, MIN_FRAME_MS - (performance.now() - lastPaint));
    setTimeout(() => requestAnimationFrame(() => { pending = false; lastPaint = performance.now(); paint(store.get()); }), wait);
  }

  function rowHtml(s: ShellState, e: FleetEvent) {
    const kc = KIND_COLOR[e.kind];
    const to = e.to ? `<span class="arr">→</span><span class="who">${esc(nameOf(s, e.to))}</span>` : '';
    const task = e.label && e.label !== e.text ? `<div class="etask">${esc(e.label)}</div>` : '';
    return `<span class="edot" style="--hue:${hueOf(s, e.from === 'zach' ? e.to : e.from)}"></span>
      <div class="eline"><span class="who">${esc(nameOf(s, e.from))}</span>${to}</div>
      <div class="etext"><span class="kchip" style="--k:${kc}">${KIND_LABEL[e.kind]}</span><span class="esum">${renderInline(e.text)}</span></div>${task}
      <time>${fmtTime(e.ts)}</time>`;
  }
  /** The row element for an event; rebuilt when the names or team colour it shows change (agents load after events). */
  function rowFor(s: ShellState, e: FleetEvent, fresh: boolean) {
    const sig = `${nameOf(s, e.from)}|${nameOf(s, e.to)}|${hueOf(s, e.from === 'zach' ? e.to : e.from)}`;
    let r = rowEls.get(e.id);
    if (!r) {
      r = document.createElement('div');
      r.className = `ev${fresh ? ' new' : ''}${e.sys ? ' sys' : ''}`;
      r.dataset.ev = e.id;
      r.addEventListener('animationend', () => r!.classList.remove('new'), { once: true });
      rowEls.set(e.id, r);
    }
    if (r.dataset.sig !== sig) { r.dataset.sig = sig; r.innerHTML = rowHtml(s, e); }
    return r;
  }
  const sameChildren = (parent: HTMLElement, nodes: HTMLElement[]) => parent.children.length === nodes.length && nodes.every((n, i) => parent.children[i] === n);

  function paint(s: ShellState) {
    for (const b of chips.querySelectorAll<HTMLButtonElement>('button')) b.classList.toggle('on', b.dataset.f === s.filter);

    byId.clear();
    if (!s.loaded) {
      stream.innerHTML = Array.from({ length: 8 }, () => '<div class="skel-row"><i></i><b></b></div>').join('');
      return;
    }
    const all = store.events();
    const q = s.query;

    // Needs you: pinned, up to 5.
    const needs = openNeeds(s, all).filter((e) => matchesQuery(s, e, q));
    needsBox.hidden = !needs.length || !(s.filter === 'all' || s.filter === 'needs');
    needsN.textContent = `(${needs.length})`;
    needsList.innerHTML = needs.slice(0, 5).map((e) => {
      byId.set(e.id, e);
      return `<div class="need" data-ev="${e.id}"><span class="ndot"></span>
        <div class="grow"><div class="ntitle">${renderInline(e.text)}</div><div class="nsub"><span class="who">${esc(nameOf(s, e.from))}</span>${e.to ? ` → <span class="who">${esc(nameOf(s, e.to))}</span>` : ''} · ${KIND_LABEL[e.kind]}</div></div>
        <time>${fmtTime(e.ts)}</time><span class="go">${svg('arrowRight', 14)}</span></div>`;
    }).join('');

    // Stream: newest first. One chronological list by default; optionally grouped by team in stable team order.
    const groups = new Map<string, FleetEvent[]>();
    const flatList: FleetEvent[] = [];
    let total = 0;
    for (let i = all.length - 1; i >= 0 && total < MAX_ROWS * 3; i--) {
      const e = all[i];
      if (!matchesFilter(s, e, s.filter) || !matchesQuery(s, e, q)) continue;
      const team = s.agentsAll.get(e.from === 'zach' ? e.to : e.from)?.team ?? '?';
      if (s.hiddenTeams.has(team)) continue;
      let g = groups.get(team);
      if (!g) groups.set(team, (g = []));
      g.push(e);
      flatList.push(e);
      total++;
    }
    const narrowed = s.filter !== 'all' || !!q;
    const keepRows = new Set<string>();
    const keepGroups = new Set<string>();
    if (!grouped) {
      const nodes = flatList.slice(0, MAX_ROWS).map((e) => { byId.set(e.id, e); keepRows.add(e.id); return rowFor(s, e, !firstPaint); });
      if (!sameChildren(stream, nodes)) stream.replaceChildren(...nodes);
      for (const [k, r] of rowEls) if (!keepRows.has(k)) { rowEls.delete(k); r.remove(); }
      groupEls.clear();
      firstPaint = false;
      const none = !nodes.length && needsBox.hidden;
      empty.hidden = !none;
      if (none) empty.innerHTML = emptyHtml(s, q);
      return;
    }
    const order = [...s.snapshot.teams.map((t) => t.id), '?'].filter((id) => groups.has(id));
    let budget = MAX_ROWS;
    const frag: HTMLElement[] = [];
    for (const id of order) {
      if (budget <= 0) break;
      const evs = groups.get(id)!;
      const cap = Math.min(budget, expanded.has(id) || narrowed ? PER_GROUP_OPEN : PER_GROUP);
      const slice = evs.slice(0, cap);
      budget -= slice.length;
      const team = s.teamsById.get(id);
      let g = groupEls.get(id);
      if (!g) {
        g = document.createElement('section');
        g.className = 'group';
        g.innerHTML = `<header><span class="gdot"></span><span class="gname"></span><span class="gcount"></span></header><div class="gbody"></div><button class="g-more" data-g="${id}"></button>`;
        groupEls.set(id, g);
      }
      keepGroups.add(id);
      g.style.setProperty('--hue', team?.hue ?? 'var(--idle)');
      g.querySelector('.gname')!.textContent = team?.name ?? 'Unassigned';
      g.querySelector('.gcount')!.textContent = String(evs.length);
      const body = g.querySelector<HTMLElement>('.gbody')!;
      const nodes: HTMLElement[] = [];
      for (const e of slice) {
        byId.set(e.id, e);
        keepRows.add(e.id);
        nodes.push(rowFor(s, e, !firstPaint));
      }
      // Only touch the DOM when order actually changed.
      if (!sameChildren(body, nodes)) body.replaceChildren(...nodes);
      const more = g.querySelector<HTMLButtonElement>('.g-more')!;
      const hiddenN = evs.length - slice.length;
      more.hidden = narrowed || (hiddenN <= 0 && !expanded.has(id));
      more.textContent = expanded.has(id) ? 'Show less' : `Show ${Math.min(hiddenN, PER_GROUP_OPEN - PER_GROUP)} more`;
      frag.push(g);
    }
    if (!sameChildren(stream, frag)) stream.replaceChildren(...frag);
    for (const [k, r] of rowEls) if (!keepRows.has(k)) { rowEls.delete(k); r.remove(); }
    for (const [k, g] of groupEls) if (!keepGroups.has(k)) { groupEls.delete(k); g.remove(); }
    firstPaint = false;

    const nothing = !frag.length && needsBox.hidden;
    empty.hidden = !nothing;
    if (nothing) empty.innerHTML = emptyHtml(s, q);
  }
  const emptyHtml = (s: ShellState, q: string) => s.filter === 'system'
    ? `<b>No system activity</b><span>Heartbeat polls, silent turns and exec notices land here.</span>`
    : q || s.filter !== 'all'
      ? `<b>No matching activity</b><span>Try another filter or clear the search.</span>`
      : `<b>Quiet for now</b><span>Messages, handoffs and finished work will stream in here.</span>`;

  return {
    update(s: ShellState) {
      schedule();
    },
    showNeeds() { store.setFilter('needs'); scroller.scrollTo({ top: 0, behavior: 'smooth' }); },
  };
}
