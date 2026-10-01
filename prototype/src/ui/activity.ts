// Right panel: filter chips, pinned "Needs you", and a team-grouped stream (newest first).
// Rendering is coalesced to at most ~10 fps and the DOM is capped at MAX_ROWS keyed rows.
import type { FleetEvent } from '../contract';
import type { Filter, ShellState, ShellStore } from '../store';
import { KIND_COLOR, esc, fmtTime, hueOf, matchesFilter, matchesQuery, nameOf, openNeeds, svg } from './format';

const MAX_ROWS = 300;
const PER_GROUP = 4;
const PER_GROUP_OPEN = 60;
const MIN_FRAME_MS = 100;

const CHIPS: Array<[Filter, string]> = [['all', 'All'], ['needs', 'Needs you'], ['errors', 'Errors'], ['handoffs', 'Handoffs'], ['approvals', 'Approvals']];

export function mountActivity(el: HTMLElement, store: ShellStore, openEvent: (e: FleetEvent) => void) {
  el.innerHTML = `
    <div class="panel-head"><h2>Activity</h2><span class="live-ind"><i></i><span>Live</span></span></div>
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
  const liveInd = el.querySelector<HTMLElement>('.live-ind')!;

  const expanded = new Set<string>();
  const rowEls = new Map<string, HTMLElement>();
  const groupEls = new Map<string, HTMLElement>();
  let frozen: FleetEvent[] | null = null; // snapshot of the ring while paused
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
    return `<span class="edot" style="--hue:${hueOf(s, e.from)}"></span>
      <div class="eline"><span class="who">${esc(nameOf(s, e.from))}</span><span class="arr">→</span><span class="who">${esc(nameOf(s, e.to))}</span>
        <span class="kchip" style="--k:${kc}">${e.kind}</span></div>
      <div class="etext">${esc(e.text)}</div>
      <time>${fmtTime(e.ts)}</time>`;
  }

  function paint(s: ShellState) {
    for (const b of chips.querySelectorAll<HTMLButtonElement>('button')) b.classList.toggle('on', b.dataset.f === s.filter);
    liveInd.classList.toggle('paused', s.paused);
    liveInd.querySelector('span')!.textContent = s.paused ? 'Paused' : 'Live';

    byId.clear();
    if (!s.loaded) {
      stream.innerHTML = Array.from({ length: 8 }, () => '<div class="skel-row"><i></i><b></b></div>').join('');
      return;
    }
    const all = frozen ?? store.events();
    const q = s.query;

    // Needs you: pinned, up to 5.
    const needs = openNeeds(s, all).filter((e) => matchesQuery(s, e, q));
    needsBox.hidden = !needs.length || s.filter === 'errors' || s.filter === 'handoffs';
    needsN.textContent = `(${needs.length})`;
    needsList.innerHTML = needs.slice(0, 5).map((e) => {
      byId.set(e.id, e);
      const a = s.agentsById.get(e.from);
      const team = a ? s.teamsById.get(a.team)?.name ?? a.team : '';
      return `<div class="need" data-ev="${e.id}"><span class="ndot"></span>
        <div class="grow"><div class="ntitle">${esc(e.text)}</div><div class="nsub">${esc(team)} · <span class="mono">${esc(nameOf(s, e.from))}</span></div></div>
        <time>${fmtTime(e.ts)}</time><span class="go">${svg('arrowRight', 14)}</span></div>`;
    }).join('');

    // Stream: newest first, grouped by team in stable team order.
    const groups = new Map<string, FleetEvent[]>();
    let total = 0;
    for (let i = all.length - 1; i >= 0 && total < MAX_ROWS * 3; i--) {
      const e = all[i];
      if (!matchesFilter(s, e, s.filter) || !matchesQuery(s, e, q)) continue;
      const team = s.agentsById.get(e.from)?.team ?? '?';
      if (s.hiddenTeams.has(team)) continue;
      let g = groups.get(team);
      if (!g) groups.set(team, (g = []));
      g.push(e);
      total++;
    }
    const narrowed = s.filter !== 'all' || !!q;
    const order = [...s.snapshot.teams.map((t) => t.id), '?'].filter((id) => groups.has(id));
    const keepRows = new Set<string>();
    const keepGroups = new Set<string>();
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
      g.style.setProperty('--hue', team?.hue ?? '#7a8494');
      g.querySelector('.gname')!.textContent = team?.name ?? 'Unassigned';
      g.querySelector('.gcount')!.textContent = String(evs.length);
      const body = g.querySelector<HTMLElement>('.gbody')!;
      const nodes: HTMLElement[] = [];
      for (const e of slice) {
        byId.set(e.id, e);
        keepRows.add(e.id);
        let r = rowEls.get(e.id);
        if (!r) {
          r = document.createElement('div');
          r.className = `ev${firstPaint ? '' : ' new'}`;
          r.dataset.ev = e.id;
          r.innerHTML = rowHtml(s, e);
          r.addEventListener('animationend', () => r!.classList.remove('new'), { once: true });
          rowEls.set(e.id, r);
        }
        nodes.push(r);
      }
      // Only touch the DOM when order actually changed.
      const cur = body.children;
      let same = cur.length === nodes.length;
      for (let i = 0; same && i < nodes.length; i++) if (cur[i] !== nodes[i]) same = false;
      if (!same) body.replaceChildren(...nodes);
      const more = g.querySelector<HTMLButtonElement>('.g-more')!;
      const hiddenN = evs.length - slice.length;
      more.hidden = narrowed || (hiddenN <= 0 && !expanded.has(id));
      more.textContent = expanded.has(id) ? 'Show less' : `Show ${Math.min(hiddenN, PER_GROUP_OPEN - PER_GROUP)} more`;
      frag.push(g);
    }
    const cur = stream.children;
    let same = cur.length === frag.length;
    for (let i = 0; same && i < frag.length; i++) if (cur[i] !== frag[i]) same = false;
    if (!same) stream.replaceChildren(...frag);
    for (const [k, r] of rowEls) if (!keepRows.has(k)) { rowEls.delete(k); r.remove(); }
    for (const [k, g] of groupEls) if (!keepGroups.has(k)) { groupEls.delete(k); g.remove(); }
    firstPaint = false;

    const nothing = !frag.length && needsBox.hidden;
    empty.hidden = !nothing;
    if (nothing) empty.innerHTML = q || s.filter !== 'all'
      ? `<b>No matching activity</b><span>Try another filter or clear the search.</span>`
      : `<b>Quiet for now</b><span>Messages between agents will stream in here.</span>`;
  }

  return {
    update(s: ShellState) {
      if (s.paused && !frozen) frozen = store.events().slice();
      if (!s.paused) frozen = null;
      schedule();
    },
    showNeeds() { store.setFilter('needs'); scroller.scrollTo({ top: 0, behavior: 'smooth' }); },
  };
}
