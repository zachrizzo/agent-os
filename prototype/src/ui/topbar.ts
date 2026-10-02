import type { ShellState, ShellStore } from '../store';
import { fmtK, openNeeds, svg } from './format';

interface Meter { key: string; label: string; value: (s: ShellState) => number; fmt: (n: number) => string }

const METERS: Meter[] = [
  { key: 'agents', label: 'agents', value: (s) => s.liveCount, fmt: (n) => String(Math.round(n)) },
  { key: 'active', label: 'active', value: (s) => count(s, 'active'), fmt: (n) => String(Math.round(n)) },
  { key: 'tok', label: 'tok/min', value: (s) => s.snapshot.meters.tokPerMin, fmt: fmtK },
  { key: 'cost', label: '/hr', value: (s) => s.snapshot.meters.costPerHr, fmt: (n) => `$${n.toFixed(2)}` },
];

function count(s: ShellState, status: string) {
  let n = 0;
  for (const a of s.agentsById.values()) if (a.status === status) n++;
  return n;
}

export function mountTopbar(el: HTMLElement, store: ShellStore, opts: { onNeeds: () => void; onMenu: () => void; onRooms: () => void }) {
  el.innerHTML = `
    <button class="icon-btn menu-btn" title="Teams">${svg('menu', 18)}</button>
    <div class="brand">
      <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" style="stop-color:color-mix(in srgb, var(--accent) 65%, var(--fg))"/><stop offset="1" style="stop-color:var(--accent)"/></linearGradient></defs><path d="M12 3.2 21 19.6H3Z" fill="none" stroke="url(#bg)" stroke-width="2.3" stroke-linejoin="round"/><path d="M12 10.5 15.6 17H8.4Z" fill="url(#bg)" opacity=".35"/></svg>
      <span>Agent OS</span>
    </div>
    <span class="src-pill ${store.source}"><i></i>${store.source === 'live' ? 'LIVE' : 'MOCK'}</span>
    <span class="conn-pill" hidden>${svg('wifiOff', 13)}<span>Reconnecting…</span></span>
    <span class="err-pill" hidden></span>
    <div class="meters">
      ${METERS.map((m) => `<div class="meter" data-k="${m.key}"><b class="num">–</b><span>${m.label}</span></div>`).join('<i class="sep"></i>')}
    </div>
    <div class="spacer"></div>
    <button class="rooms-btn" aria-pressed="false" title="Group rooms: chat with several agents in one thread">${svg('users', 15)}<span>Rooms</span><b>0</b></button>
    <button class="hist-btn" aria-pressed="false" title="Show finished, aborted and archived sessions"><span>History</span><b>0</b></button>
    <button class="needs-btn" data-zero="1">${svg('warn', 15)}<span>Needs you</span><span class="dotsep">·</span><b>0</b></button>
    <label class="search">
      ${svg('search', 15)}
      <input type="search" placeholder="Search agents, messages…" spellcheck="false" autocomplete="off" />
      <kbd>⌘K</kbd>
    </label>`;

  const input = el.querySelector('input')!;
  const needsBtn = el.querySelector<HTMLButtonElement>('.needs-btn')!;
  const histBtn = el.querySelector<HTMLButtonElement>('.hist-btn')!;
  const conn = el.querySelector<HTMLElement>('.conn-pill')!;
  const err = el.querySelector<HTMLElement>('.err-pill')!;
  const nums = new Map<string, HTMLElement>();
  for (const m of METERS) nums.set(m.key, el.querySelector(`.meter[data-k="${m.key}"] b`)!);

  input.addEventListener('input', () => store.setQuery(input.value.trim().toLowerCase()));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { input.value = ''; store.setQuery(''); input.blur(); }
  });
  window.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); input.focus(); input.select(); }
  });
  needsBtn.addEventListener('click', opts.onNeeds);
  el.querySelector('.rooms-btn')!.addEventListener('click', opts.onRooms);
  histBtn.addEventListener('click', () => store.setShowHistory(!store.get().showHistory));
  el.querySelector('.menu-btn')!.addEventListener('click', opts.onMenu);

  // Numerals ease toward their target so the bar feels alive without flicker.
  const shown = new Map<string, number>();
  const target = new Map<string, number>();
  let raf = 0;
  function tween() {
    raf = 0;
    let moving = false;
    for (const m of METERS) {
      const t = target.get(m.key) ?? 0;
      const c = shown.get(m.key) ?? t;
      const n = Math.abs(t - c) < 0.01 * Math.max(1, Math.abs(t)) ? t : c + (t - c) * 0.18;
      if (n !== t) moving = true;
      shown.set(m.key, n);
      nums.get(m.key)!.textContent = m.fmt(n);
    }
    if (moving) raf = requestAnimationFrame(tween);
  }

  const roomsBtn = el.querySelector<HTMLButtonElement>('.rooms-btn')!;
  const setRooms = (count: number, open: boolean) => {
    roomsBtn.querySelector('b')!.textContent = String(count);
    roomsBtn.setAttribute('aria-pressed', String(open));
    roomsBtn.classList.toggle('on', open);
  };
  const render = (s: ShellState) => {
    if (s.loaded) {
      for (const m of METERS) target.set(m.key, m.value(s));
      if (!raf) raf = requestAnimationFrame(tween);
    }
    const n = openNeeds(s, store.events()).length;
    needsBtn.querySelector('b')!.textContent = String(n);
    needsBtn.dataset.zero = n ? '0' : '1';
    histBtn.querySelector('b')!.textContent = String(s.historyCount);
    histBtn.setAttribute('aria-pressed', String(s.showHistory));
    histBtn.classList.toggle('on', s.showHistory);
    conn.hidden = !s.reconnecting;
    err.hidden = !s.snapshot.error;
    if (s.snapshot.error) { err.textContent = 'Source error'; err.title = s.snapshot.error; }
  };
  return Object.assign(render, { setRooms });
}

