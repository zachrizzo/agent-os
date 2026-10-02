// Session drawer: an Activity event (or any agent/session) with its transcript as a readable thread, plus the "Message agent" composer.
import type { HistoryItem } from '../../shared/types';
import type { FleetEvent } from '../contract';
import type { ShellStore } from '../store';
import { mountComposer } from './composer';
import { KIND_COLOR, KIND_LABEL, esc, fmtTime, hueOf, nameOf, svg } from './format';

export function mountDrawer(el: HTMLElement, store: ShellStore) {
  let current: string | null = null; // session key shown
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

  /** The session whose thread the drawer shows: the sender, or the receiver of a message from Zach. */
  const sessionOf = (ev: FleetEvent) => ev.session ?? (ev.from === 'zach' ? ev.to : ev.from);

  function open(ev: FleetEvent) { return show(sessionOf(ev), ev); }
  /** Open any session without an event (agent/team views). */
  function openSession(key: string, focusComposer = false) { return show(key, undefined, focusComposer); }

  async function show(key: string, ev?: FleetEvent, focusComposer = false) {
    current = key;
    const s = store.get();
    const a = s.agentsAll.get(key);
    const team = a ? s.teamsById.get(a.team) : undefined;
    const hue = hueOf(s, key);
    el.style.setProperty('--hue', hue);
    const who = (id: string) => id === 'zach' ? '<span class="who-btn you">You</span>' : `<button class="who-btn" data-agent="${esc(id)}">${esc(nameOf(s, id))}</button>`;
    const route = ev
      ? `${who(ev.from)}${ev.to ? `<span class="arr">→</span>${who(ev.to)}` : ''}
        <time>${new Date(ev.ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} · ${fmtTime(ev.ts)}</time>`
      : who(key);
    el.innerHTML = `
      <header class="d-head">
        <div class="d-crumb"><span class="gdot"></span>${esc(team?.name ?? 'Unassigned')}${ev ? `<span class="kchip" style="--k:${KIND_COLOR[ev.kind]}">${KIND_LABEL[ev.kind]}</span>` : ''}${ev?.needsYou && ev.kind !== 'needs' ? '<span class="kchip need">needs you</span>' : ''}</div>
        <button class="icon-btn d-close" title="Close (Esc)">${svg('close', 16)}</button>
      </header>
      <div class="d-route">${route}</div>
      <div class="d-body">
        ${ev ? `<blockquote class="d-text">${esc(ev.text)}${ev.label && ev.label !== ev.text ? `<small class="d-label">${esc(ev.label)}</small>` : ''}</blockquote>` : ''}
        <dl class="d-meta">
          <div><dt>Session</dt><dd class="mono">${esc(key)}</dd></div>
          ${a ? `<div><dt>Now</dt><dd>${esc(a.now)}</dd></div><div><dt>Model</dt><dd class="mono">${esc(a.model ?? '—')}</dd></div><div><dt>Spend</dt><dd>$${a.costUsd.toFixed(2)} · ${Math.round(a.tokens / 1000)}k tok</dd></div>` : ''}
        </dl>
        <h3>Session thread</h3>
        <div class="thread"><div class="skel-row"><i></i><b></b></div><div class="skel-row"><i></i><b></b></div></div>
      </div>
      <footer class="d-compose"><div class="cmp-mount"></div></footer>`;
    el.classList.add('open');
    el.setAttribute('aria-hidden', 'false');
    if (ev) store.select({ type: 'event', id: ev.id });

    const composer = mountComposer(el.querySelector<HTMLElement>('.cmp-mount')!, store, (k, text) => {
      if (current === k) void loadThread(k, text);
    });
    composer.setTarget(a ? { key, label: a.name } : null);
    if (focusComposer) composer.focus();
    await loadThread(key);
  }

  /** Renders the transcript; `justSent` is appended locally if the Gateway hasn't persisted it to history yet. */
  async function loadThread(key: string, justSent?: string) {
    const s = store.get();
    const hue = hueOf(s, key);
    const my = ++req;
    const thread = el.querySelector<HTMLElement>('.thread');
    if (!thread) return;
    const bubble = (role: string, text: string, ts: number, sender?: string) => {
      const mine = role === 'assistant';
      const name = mine ? nameOf(s, key) : sender ? nameOf(s, sender) : role === 'user' ? 'You' : role;
      return `<div class="msg ${mine ? 'me' : 'them'} r-${esc(role)}" style="--hue:${mine ? hue : sender ? hueOf(s, sender) : 'var(--idle)'}">
        <div class="m-head"><span class="m-who">${esc(name)}</span><span class="m-role">${esc(role)}</span><time>${fmtTime(ts)}</time></div>
        <div class="m-text">${esc(text)}</div></div>`;
    };
    // Agent-to-agent traffic (sessions_send): one compact "from → to: text" row; the routing wrapper sits behind a details toggle.
    const a2aRow = (it: HistoryItem) => {
      const from = it.a2a!.from;
      const tool = it.a2a!.tool && it.a2a!.tool !== 'sessions_send' ? `<span class="kchip a2a-tool">${esc(it.a2a!.tool.replace(/_/g, ' '))}</span>` : '';
      return `<div class="a2a" style="--hue:${hueOf(s, from)}">
        <div class="a2a-line"><button class="who-btn a2a-from" data-agent="${esc(from)}">${esc(nameOf(s, from))}</button><span class="arr">→</span><span class="a2a-to">${esc(nameOf(s, key))}</span>${tool}<time>${fmtTime(it.ts)}</time></div>
        <div class="a2a-text">${esc(it.text)}</div>
        <details class="a2a-routing"><summary>routing</summary><pre>${esc(it.a2a!.routing)}</pre></details></div>`;
    };
    try {
      const url = new URL(`api/history?source=${store.source}&key=${encodeURIComponent(key)}`, document.baseURI);
      const r = await fetch(url);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const { items } = (await r.json()) as { items: HistoryItem[] };
      if (my !== req) return;
      const rows = items.map((it) => it.a2a ? a2aRow(it) : bubble(it.role, it.text, it.ts, it.sender));
      if (justSent && !items.slice(-6).some((it) => it.role === 'user' && it.text.includes(justSent.slice(0, 80)))) rows.push(bubble('user', justSent, Date.now()));
      thread.innerHTML = rows.length ? rows.join('') : '<div class="empty-mini">No transcript available for this session.</div>';
      thread.closest('.d-body')?.scrollTo({ top: 1e9, behavior: justSent ? 'smooth' : 'auto' });
    } catch (e) {
      if (my !== req) return;
      thread.innerHTML = `<div class="empty-mini">Couldn’t load history (${esc((e as Error).message)}).</div>`;
    }
  }

  return { open, openSession, close, isOpen: () => !!current };
}
