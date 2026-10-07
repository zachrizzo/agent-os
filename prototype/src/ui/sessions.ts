import type { SessionRow, SessionScope } from '../../shared/sessions';
import { createSessionsApi } from '../sessions-api';
import type { ShellState, ShellStore } from '../store';
import { esc, nameOf } from './format';
import { sessionRowsHtml } from './session-rows';

const REFRESH_MS = 5000;

export function sessionScopeOf(s: ShellState): { scope: SessionScope; title: string } | null {
  const sel = s.scopeSel;
  if (sel.type === 'agent') {
    const a = s.agentsAll.get(sel.id);
    const agentId = a?.agentId ?? /^agent:([^:]+):/.exec(sel.id)?.[1];
    return agentId ? { scope: { agent: agentId }, title: a?.agentName ?? agentId } : null;
  }
  if (sel.type === 'team') return { scope: { team: sel.id }, title: s.teamsById.get(sel.id)?.name ?? sel.id };
  return null;
}

export function mountSessions(el: HTMLElement, store: ShellStore, opts: { onOpenSession: (key: string) => void; activeKey: () => string | null }) {
  el.innerHTML = `
    <div class="panel-head"><h2>Sessions</h2><span class="head-meta ss-count"></span></div>
    <div class="ss-title"></div>
    <div class="act-scroll"><div class="ss-list" role="list"></div><div class="act-empty ss-empty" hidden></div></div>`;
  const api = createSessionsApi(store.source);
  const list = el.querySelector<HTMLElement>('.ss-list')!;
  const empty = el.querySelector<HTMLElement>('.ss-empty')!;
  const count = el.querySelector<HTMLElement>('.ss-count')!;
  const title = el.querySelector<HTMLElement>('.ss-title')!;
  let scopeKey = '';
  let rows: SessionRow[] = [];
  let loading = false;
  let failed = '';
  let seq = 0;
  let timer: number | undefined;

  list.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('.ss-row');
    if (!b?.dataset.session) return;
    for (const r of list.querySelectorAll('.ss-row.on')) r.classList.remove('on');
    b.classList.add('on');
    opts.onOpenSession(b.dataset.session);
  });

  function paint() {
    const s = store.get();
    const cur = sessionScopeOf(s);
    title.textContent = cur ? `${cur.title} · all sessions, newest first` : '';
    count.textContent = cur && !loading ? String(rows.length) : '';
    if (!cur) {
      list.innerHTML = '';
      empty.hidden = false;
      empty.innerHTML = '<b>Pick an agent or team</b><span>Select one on the map or in the rail to see all of its sessions: main, subagents, automations, rooms and dashboard chats.</span>';
      return;
    }
    const multi = new Set(rows.map((r) => r.agentId)).size > 1;
    list.innerHTML = sessionRowsHtml(rows, { now: Date.now(), activeKey: opts.activeKey() ?? undefined, agentName: (id) => nameOf(s, `agent:${id}:main`), showAgent: multi });
    empty.hidden = rows.length > 0;
    if (!rows.length) empty.innerHTML = loading ? '<div class="spinner"></div><b>Loading sessions…</b>' : failed ? `<b>Couldn’t load sessions</b><span>${esc(failed)}</span>` : '<b>No sessions</b><span>This agent has no sessions on record.</span>';
  }

  async function refresh() {
    const cur = sessionScopeOf(store.get());
    const key = cur ? JSON.stringify(cur.scope) : '';
    if (key !== scopeKey) { scopeKey = key; rows = []; failed = ''; seq++; loading = !!cur; }
    paint();
    if (!cur || el.hidden) return;
    const mine = ++seq;
    try {
      const next = await api.list(cur.scope);
      if (mine !== seq) return;
      rows = next; failed = '';
    } catch (e) {
      if (mine !== seq) return;
      failed = (e as Error).message;
    }
    loading = false;
    paint();
  }

  return {
    update() {
      if (el.hidden) { clearInterval(timer); timer = undefined; return; }
      const key = JSON.stringify(sessionScopeOf(store.get())?.scope ?? '');
      if (key !== scopeKey) void refresh();
      timer ??= window.setInterval(() => void refresh(), REFRESH_MS);
    },
    refresh,
  };
}
