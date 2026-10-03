// Board: Spark + Forge Workboard cards in four read-only columns. The data server reads the cards (GET /api/board); this view only renders them.
import { BOARDS, COLUMNS, ageLabel, boardHref, groupBoard, type BoardCard } from '../../shared/board';
import type { ShellStore } from '../store';
import { avatarHtml, esc, svg } from './format';

const POLL_MS = 10_000;

export function mountBoard(el: HTMLElement, store: ShellStore) {
  let open = false;
  let cards: BoardCard[] = [];
  let error = '';
  let loaded = false;
  let timer: number | undefined;
  let seq = 0;

  const url = () => new URL(`api/board?source=${store.source}`, document.baseURI).toString();
  const href = (b: BoardCard['board']) => new URL(`..${boardHref(b)}`, document.baseURI).toString();

  async function refresh() {
    const mine = ++seq;
    try {
      const r = await fetch(url());
      const j = await r.json().catch(() => ({})) as { cards?: BoardCard[]; error?: string };
      if (mine !== seq) return;
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      cards = j.cards ?? []; error = ''; loaded = true;
    } catch (e) {
      if (mine !== seq) return;
      error = `Could not read the board (${(e as Error).message}).`;
    }
    paint();
    clearTimeout(timer);
    if (open) timer = window.setTimeout(refresh, POLL_MS);
  }

  const cardHtml = (c: BoardCard, now: number) => `<a class="bd-card ${esc(c.status)}" href="${esc(href(c.board))}" target="_blank" rel="noopener noreferrer" title="${esc(c.title)}&#10;${esc(c.board)} board · ${esc(c.status)} · ${esc(c.priority)} priority&#10;created ${esc(new Date(c.createdAt).toLocaleString())} · updated ${esc(new Date(c.updatedAt).toLocaleString())}">
      <span class="bd-title">${esc(c.title)}</span>
      <span class="bd-meta">${c.agent ? `${avatarHtml(c.agent, c.agent, undefined, 'sm')}<span class="bd-agent">${esc(c.agent)}</span>` : '<span class="bd-agent muted">unassigned</span>'}
        <span class="bd-board ${esc(c.board)}">${esc(c.board)}</span>${c.status === 'blocked' ? '<span class="bd-flag blocked">blocked</span>' : ''}${c.priority === 'high' || c.priority === 'urgent' ? `<span class="bd-flag pri">${esc(c.priority)}</span>` : ''}
        <time class="bd-age">${ageLabel(c.updatedAt, now)}</time></span></a>`;

  function paint() {
    const now = Date.now();
    const g = groupBoard(cards);
    el.innerHTML = `<div class="bd-wrap">
      <header class="bd-head"><h2>Board</h2><span class="muted">${BOARDS.join(' + ')} · read-only · ${cards.length} cards</span>
        <span class="grow"></span>${BOARDS.map((b) => `<a class="bd-link" href="${esc(href(b))}" target="_blank" rel="noopener noreferrer">Open ${esc(b)} in Workboard ${svg('arrowRight', 12)}</a>`).join('')}</header>
      ${error ? `<div class="bd-error" role="status">${esc(error)}</div>` : ''}
      <div class="bd-cols">${COLUMNS.map((col) => `<section class="bd-col ${col.key}" aria-label="${esc(col.label)}">
        <h3>${esc(col.label)}<b>${g[col.key].length}</b></h3>
        <div class="bd-list">${g[col.key].map((c) => cardHtml(c, now)).join('') || `<div class="bd-empty">${loaded ? 'Nothing here' : 'Loading…'}</div>`}</div></section>`).join('')}</div></div>`;
  }

  return {
    show() { open = true; el.hidden = false; paint(); void refresh(); },
    hide() { open = false; el.hidden = true; clearTimeout(timer); seq++; },
    toggle() { if (open) this.hide(); else this.show(); },
    isOpen: () => open,
  };
}
