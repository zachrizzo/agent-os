// Session drawer: an Activity event (or any agent/session) with its transcript as a readable thread, plus the "Message agent" composer.
import type { HistoryItem } from '../../shared/types';
import type { SessionStatus, SessionThread } from '../../shared/transcript';
import type { FleetEvent } from '../contract';
import type { ShellStore } from '../store';
import { installMarkdownHandlers, renderInline } from '../../shared/markdown';
import { mountComposer } from './composer';
import { mountSessionPicker } from './session-picker';
import { KIND_COLOR, KIND_LABEL, esc, fmtTime, hueOf, nameOf, svg } from './format';
import { renderThread, spendText, stateBadge, threadSignature } from './thread';

const WIDTH_KEY = 'agent-os:drawer-width';
const FULL_KEY = 'agent-os:drawer-full';
const MIN_WIDTH = 380;
const DEFAULT_WIDTH = 600;
const POLL_RUNNING_MS = 3000;
const POLL_IDLE_MS = 15_000;
const NEAR_BOTTOM_PX = 80;

const recall = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const remember = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { return; } };

export function mountDrawer(el: HTMLElement, store: ShellStore) {
  let current: string | null = null; // session key shown
  let req = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let sig = '';
  let status: SessionStatus | undefined;
  installMarkdownHandlers(el);

  const maxWidth = () => Math.max(MIN_WIDTH, window.innerWidth - 80);
  const applyWidth = (w: number) => el.style.setProperty('--drawer-w', `${Math.round(Math.min(maxWidth(), Math.max(MIN_WIDTH, w)))}px`);
  applyWidth(Number(recall(WIDTH_KEY)) || DEFAULT_WIDTH);
  el.classList.toggle('full', recall(FULL_KEY) === '1');

  el.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    if (t.closest('.d-close')) close();
    if (t.closest('.d-expand')) toggleFull();
    const more = t.closest<HTMLElement>('[data-more]');
    if (more) {
      const open = !!more.previousElementSibling?.classList.toggle('expanded');
      more.textContent = open ? 'Show less' : 'Show more';
      return;
    }
    const who = t.closest<HTMLElement>('[data-agent]');
    if (who) store.select({ type: 'agent', id: who.dataset.agent! });
  });
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && current) close(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && current) schedule(0); });

  function toggleFull() {
    remember(FULL_KEY, el.classList.toggle('full') ? '1' : '0');
    syncExpand();
  }
  function syncExpand() {
    const b = el.querySelector<HTMLElement>('.d-expand');
    if (!b) return;
    const full = el.classList.contains('full');
    b.title = full ? 'Restore drawer width' : 'Expand to full width';
    b.setAttribute('aria-pressed', String(full));
    b.innerHTML = svg(full ? 'shrink' : 'expand', 15);
  }

  function startResize(e: PointerEvent) {
    if (e.button !== 0 || el.classList.contains('full')) return;
    e.preventDefault();
    const handle = e.currentTarget as HTMLElement;
    handle.setPointerCapture(e.pointerId);
    const right = el.getBoundingClientRect().right;
    el.classList.add('resizing');
    const move = (ev: PointerEvent) => applyWidth(right - ev.clientX);
    const up = () => {
      el.classList.remove('resizing');
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      remember(WIDTH_KEY, String(parseInt(el.style.getPropertyValue('--drawer-w'), 10) || DEFAULT_WIDTH));
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  }
  function resetWidth() { applyWidth(DEFAULT_WIDTH); remember(WIDTH_KEY, String(DEFAULT_WIDTH)); }

  function close() {
    current = null;
    clearTimeout(timer);
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
    sig = '';
    status = undefined;
    clearTimeout(timer);
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
      <div class="d-resize" role="separator" aria-orientation="vertical" aria-label="Resize drawer" title="Drag to resize · double-click to reset"></div>
      <header class="d-head">
        <div class="d-crumb"><span class="gdot"></span>${esc(team?.name ?? 'Unassigned')}${ev ? `<span class="kchip" style="--k:${KIND_COLOR[ev.kind]}">${KIND_LABEL[ev.kind]}</span>` : ''}${ev?.needsYou && ev.kind !== 'needs' ? '<span class="kchip need">needs you</span>' : ''}<span class="d-status"></span></div>
        <div class="d-actions"><button class="icon-btn d-expand" aria-pressed="false"></button><button class="icon-btn d-close" title="Close (Esc)">${svg('close', 16)}</button></div>
      </header>
      <div class="d-route">${route}</div>
      <div class="d-pick"><select class="d-sessions" aria-label="Sessions of this agent" title="All sessions of this agent"></select></div>
      <div class="d-body">
        ${ev ? `<blockquote class="d-text">${renderInline(ev.text)}${ev.label && ev.label !== ev.text ? `<small class="d-label">${esc(ev.label)}</small>` : ''}</blockquote>` : ''}
        <dl class="d-meta">
          <div><dt>Session</dt><dd class="mono">${esc(key)}</dd></div>
          ${a ? `<div><dt>Now</dt><dd>${esc(a.now)}</dd></div>` : ''}
          <div><dt>Model</dt><dd class="mono d-model">${esc(a?.model ?? '—')}</dd></div>
          <div><dt>Spend</dt><dd class="d-spend">…</dd></div>
        </dl>
        <h3>Session thread</h3>
        <div class="thread"><div class="skel-row"><i></i><b></b></div><div class="skel-row"><i></i><b></b></div></div>
      </div>
      <footer class="d-compose"><div class="cmp-mount"></div></footer>`;
    el.classList.add('open');
    el.setAttribute('aria-hidden', 'false');
    syncExpand();
    const handle = el.querySelector<HTMLElement>('.d-resize')!;
    handle.addEventListener('pointerdown', startResize);
    handle.addEventListener('dblclick', resetWidth);
    if (ev) store.select({ type: 'event', id: ev.id });

    mountSessionPicker(el.querySelector<HTMLSelectElement>('.d-sessions')!, store, (k) => { void show(k, undefined, false); }).set(/^agent:([^:]+):/.exec(key)?.[1] ?? '', key);
    const composer = mountComposer(el.querySelector<HTMLElement>('.cmp-mount')!, store, (k, text, result) => {
      if (current === k && result.to === k) void loadThread(k, text);
    });
    composer.setTarget(a ? { key, label: a.name } : null);
    if (focusComposer) composer.focus();
    await loadThread(key);
  }

  function schedule(ms: number) {
    clearTimeout(timer);
    if (!current) return;
    timer = setTimeout(() => { if (current && !document.hidden) void loadThread(current); else schedule(POLL_IDLE_MS); }, ms);
  }

  function paintStatus(st: SessionStatus | undefined) {
    const badge = el.querySelector<HTMLElement>('.d-status');
    if (badge) badge.innerHTML = stateBadge(st, Date.now());
    const spend = el.querySelector<HTMLElement>('.d-spend');
    if (spend) spend.textContent = spendText(st);
    const model = el.querySelector<HTMLElement>('.d-model');
    if (model && st?.model) model.textContent = st.model;
  }

  /** Renders the transcript; `justSent` is appended locally if the Gateway hasn't persisted it to history yet. */
  async function loadThread(key: string, justSent?: string) {
    const s = store.get();
    const my = ++req;
    const thread = el.querySelector<HTMLElement>('.thread');
    const body = el.querySelector<HTMLElement>('.d-body');
    if (!thread || !body) return;
    try {
      const r = await fetch(new URL(`api/thread?source=${store.source}&key=${encodeURIComponent(key)}`, document.baseURI));
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = (await r.json()) as SessionThread;
      if (my !== req || current !== key) return;
      status = data.status;
      paintStatus(status);
      const items: HistoryItem[] = [...data.items];
      if (justSent && !items.slice(-6).some((it) => it.role === 'user' && it.text.includes(justSent.slice(0, 80)))) items.push({ role: 'user', ts: Date.now(), text: justSent, from: 'zach' });
      const running = !!status?.running;
      const next = threadSignature(items, data.live, running);
      if (next !== sig) {
        const first = !sig;
        sig = next;
        const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < NEAR_BOTTOM_PX;
        const openKeys = new Set([...thread.querySelectorAll<HTMLElement>('details[open][data-k]')].map((d) => d.dataset.k!));
        const expanded = new Set([...thread.querySelectorAll<HTMLElement>('.m-long.expanded[data-k]')].map((d) => d.dataset.k!));
        thread.innerHTML = items.length || data.live || running ? renderThread(s, key, items, data.live, running) : '<div class="empty-mini">No transcript available for this session.</div>';
        for (const d of thread.querySelectorAll<HTMLDetailsElement>('details[data-k]')) if (openKeys.has(d.dataset.k!)) d.open = true;
        for (const m of thread.querySelectorAll<HTMLElement>('.m-long[data-k]')) {
          if (!expanded.has(m.dataset.k!)) continue;
          m.classList.add('expanded');
          if (m.nextElementSibling?.hasAttribute('data-more')) m.nextElementSibling.textContent = 'Show less';
        }
        if (first || atBottom || justSent) body.scrollTo({ top: body.scrollHeight, behavior: justSent ? 'smooth' : 'auto' });
      }
      schedule(running ? POLL_RUNNING_MS : POLL_IDLE_MS);
    } catch (e) {
      if (my !== req || current !== key) return;
      if (!sig) thread.innerHTML = `<div class="empty-mini">Couldn’t load history (${esc((e as Error).message)}).</div>`;
      paintStatus(status);
      schedule(POLL_IDLE_MS);
    }
  }

  return { open, openSession, close, isOpen: () => !!current };
}
