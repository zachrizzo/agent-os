// Event drawer: full message + the sender session's history as a readable thread (read-only).
import type { HistoryItem } from '../../shared/types';
import type { FleetEvent } from '../contract';
import type { ShellStore } from '../store';
import { KIND_COLOR, esc, fmtTime, hueOf, nameOf, svg } from './format';

export function mountDrawer(el: HTMLElement, store: ShellStore) {
  let current: FleetEvent | null = null;
  let req = 0;

  el.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    if (t.closest('.d-close')) close();
    const who = t.closest<HTMLElement>('[data-agent]');
    if (who) store.select({ type: 'agent', id: who.dataset.agent! });
  });
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && current) close(); });

  function close() {
    current = null;
    el.classList.remove('open');
    el.setAttribute('aria-hidden', 'true');
    if (store.get().selection.type === 'event') store.select({ type: 'none' });
  }

  async function open(ev: FleetEvent) {
    current = ev;
    const s = store.get();
    const a = s.agentsAll.get(ev.from);
    const team = a ? s.teamsById.get(a.team) : undefined;
    const hue = hueOf(s, ev.from);
    el.style.setProperty('--hue', hue);
    el.innerHTML = `
      <header class="d-head">
        <div class="d-crumb"><span class="gdot"></span>${esc(team?.name ?? 'Unassigned')}<span class="kchip" style="--k:${KIND_COLOR[ev.kind]}">${ev.kind}</span>${ev.needsYou ? '<span class="kchip need">needs you</span>' : ''}</div>
        <button class="icon-btn d-close" title="Close (Esc)">${svg('close', 16)}</button>
      </header>
      <div class="d-route">
        <button class="who-btn" data-agent="${esc(ev.from)}">${esc(nameOf(s, ev.from))}</button><span class="arr">→</span>
        ${ev.to === 'zach' ? '<span class="who-btn you">You</span>' : `<button class="who-btn" data-agent="${esc(ev.to)}">${esc(nameOf(s, ev.to))}</button>`}
        <time>${new Date(ev.ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} · ${fmtTime(ev.ts)}</time>
      </div>
      <div class="d-body">
        <blockquote class="d-text">${esc(ev.text)}</blockquote>
        <dl class="d-meta">
          <div><dt>Session</dt><dd class="mono">${esc(ev.from)}</dd></div>
          ${a ? `<div><dt>Now</dt><dd>${esc(a.now)}</dd></div><div><dt>Model</dt><dd class="mono">${esc(a.model ?? '—')}</dd></div><div><dt>Spend</dt><dd>$${a.costUsd.toFixed(2)} · ${Math.round(a.tokens / 1000)}k tok</dd></div>` : ''}
        </dl>
        <h3>Session thread</h3>
        <div class="thread"><div class="skel-row"><i></i><b></b></div><div class="skel-row"><i></i><b></b></div></div>
      </div>`;
    el.classList.add('open');
    el.setAttribute('aria-hidden', 'false');
    store.select({ type: 'event', id: ev.id });

    const my = ++req;
    const thread = el.querySelector<HTMLElement>('.thread')!;
    try {
      const url = new URL(`api/history?source=${store.source}&key=${encodeURIComponent(ev.from)}`, document.baseURI);
      const r = await fetch(url);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const { items } = (await r.json()) as { items: HistoryItem[] };
      if (my !== req) return;
      thread.innerHTML = items.length
        ? items.map((it) => {
            const mine = it.role === 'assistant';
            const who = mine ? nameOf(s, ev.from) : it.sender ? nameOf(s, it.sender) : it.role === 'user' ? 'User' : it.role;
            return `<div class="msg ${mine ? 'me' : 'them'} r-${esc(it.role)}" style="--hue:${mine ? hue : it.sender ? hueOf(s, it.sender) : '#7a8494'}">
              <div class="m-head"><span class="m-who">${esc(who)}</span><span class="m-role">${esc(it.role)}</span><time>${fmtTime(it.ts)}</time></div>
              <div class="m-text">${esc(it.text)}</div></div>`;
          }).join('')
        : '<div class="empty-mini">No transcript available for this session.</div>';
    } catch (e) {
      if (my !== req) return;
      thread.innerHTML = `<div class="empty-mini">Couldn’t load history (${esc((e as Error).message)}).</div>`;
    }
  }

  return { open, close, isOpen: () => !!current };
}
