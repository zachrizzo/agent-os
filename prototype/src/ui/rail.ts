// Left rail: Chief of Staff pinned, collapsible teams, agent rows. Keyed + virtualized (>200 rows).
import { COS_ID } from '../../shared/types';
import type { Agent, Selection } from '../contract';
import type { ShellState, ShellStore } from '../store';
import { esc, svg } from './format';

type Row =
  | { kind: 'cos'; key: string; a: Agent }
  | { kind: 'team'; key: string; id: string; name: string; hue: string; total: number; active: number; needs: number; act: number; open: boolean; hidden: boolean }
  | { kind: 'agent'; key: string; a: Agent; hue: string; last: boolean }
  | { kind: 'more'; key: string; team: string; n: number; hue: string; open: boolean };

const H = { cos: 66, team: 58, agent: 42, more: 30 } as const;
const VIRTUAL_AT = 200;
const ORDER = { needs: 0, error: 1, active: 2, idle: 3 } as const;

export function mountRail(el: HTMLElement, store: ShellStore, focus: (sel: Selection) => void) {
  el.innerHTML = `
    <div class="panel-head"><h2>Teams</h2><span class="head-meta"></span></div>
    <div class="rail-scroll"><div class="rail-inner"></div></div>
    <div class="rail-foot"><span class="sys-dot"></span><span class="sys-text">Connecting…</span></div>`;
  const scroller = el.querySelector<HTMLElement>('.rail-scroll')!;
  const inner = el.querySelector<HTMLElement>('.rail-inner')!;
  const meta = el.querySelector<HTMLElement>('.head-meta')!;
  const sysText = el.querySelector<HTMLElement>('.sys-text')!;
  const sysDot = el.querySelector<HTMLElement>('.sys-dot')!;

  const open = new Set<string>();
  const showIdle = new Set<string>();
  let initialized = false;
  let rows: Row[] = [];
  let offsets: number[] = [];
  const els = new Map<string, HTMLElement>();
  let lastSel = '';

  inner.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    const rowEl = t.closest<HTMLElement>('.row');
    if (!rowEl) return;
    const row = rows.find((r) => r.key === rowEl.dataset.key);
    if (!row) return;
    if (row.kind === 'team') {
      if (t.closest('.eye')) { store.toggleTeam(row.id); return; }
      if (t.closest('.chev')) { toggle(open, row.id); render(store.get()); return; }
      const sel: Selection = { type: 'team', id: row.id };
      if (!open.has(row.id)) open.add(row.id);
      store.select(sel);
      if (store.get().zoom === 'fleet') store.setZoom('team');
      focus(sel);
    } else if (row.kind === 'more') {
      toggle(showIdle, row.team);
      render(store.get());
    } else {
      const sel: Selection = { type: 'agent', id: row.a.id };
      store.select(sel);
      focus(sel);
    }
  });
  scroller.addEventListener('scroll', () => { if (rows.length > VIRTUAL_AT) paint(); }, { passive: true });

  function toggle(set: Set<string>, id: string) { if (set.has(id)) set.delete(id); else set.add(id); }

  function build(s: ShellState): Row[] {
    const q = s.query;
    const byTeam = new Map<string, Agent[]>();
    for (const a of s.agentsById.values()) {
      if (a.id === COS_ID) continue;
      let l = byTeam.get(a.team);
      if (!l) byTeam.set(a.team, (l = []));
      l.push(a);
    }
    // Recent activity per team (last 2 min) for the tiny bars.
    const act = new Map<string, number>();
    const evs = store.events();
    const since = Date.now() - 120_000;
    for (let i = evs.length - 1; i >= 0 && evs[i].ts >= since; i--) {
      const t = s.agentsById.get(evs[i].from)?.team;
      if (t) act.set(t, (act.get(t) ?? 0) + 1);
    }
    const maxAct = Math.max(1, ...act.values());

    if (!initialized && s.teamsById.size) {
      initialized = true;
      const biggest = [...byTeam.entries()].sort((a, b) => b[1].length - a[1].length)[0];
      if (biggest) open.add(biggest[0]);
    }
    const sel = s.selection;
    const selKey = sel.type === 'none' ? '' : `${sel.type}:${(sel as { id: string }).id}`;
    if (selKey !== lastSel) {
      lastSel = selKey;
      if (sel.type === 'team') open.add(sel.id);
      if (sel.type === 'agent') { const a = s.agentsById.get(sel.id); if (a) { open.add(a.team); if (a.status === 'idle') showIdle.add(a.team); } }
    }

    const out: Row[] = [];
    const cos = s.agentsById.get(COS_ID);
    if (cos && (!q || match(cos, q) || 'chief of staff'.includes(q))) out.push({ kind: 'cos', key: 'cos', a: cos });

    for (const t of s.snapshot.teams) {
      const members = (byTeam.get(t.id) ?? []).sort((a, b) =>
        (a.role === 'lead' ? -1 : 0) - (b.role === 'lead' ? -1 : 0) || ORDER[a.status] - ORDER[b.status] || a.name.localeCompare(b.name));
      const teamHit = !q || t.name.toLowerCase().includes(q);
      const shown = teamHit ? members : members.filter((a) => match(a, q));
      if (!teamHit && !shown.length) continue;
      const isOpen = open.has(t.id) || (!!q && !teamHit);
      const active = members.filter((a) => a.status === 'active').length;
      const needs = members.filter((a) => a.status === 'needs').length;
      out.push({
        kind: 'team', key: `t:${t.id}`, id: t.id, name: t.name, hue: t.hue, total: members.length + (cos?.team === t.id ? 1 : 0),
        active, needs, act: (act.get(t.id) ?? 0) / maxAct, open: isOpen, hidden: s.hiddenTeams.has(t.id),
      });
      if (!isOpen) continue;
      const busy = q ? shown : shown.filter((a) => a.status !== 'idle' || a.role === 'lead');
      const idle = q ? [] : shown.filter((a) => a.status === 'idle' && a.role !== 'lead');
      const list = showIdle.has(t.id) ? [...busy, ...idle] : busy;
      list.forEach((a, i) => out.push({ kind: 'agent', key: `a:${a.id}`, a, hue: t.hue, last: i === list.length - 1 && !idle.length }));
      if (idle.length) out.push({ kind: 'more', key: `m:${t.id}`, team: t.id, n: idle.length, hue: t.hue, open: showIdle.has(t.id) });
    }
    return out;
  }

  function match(a: Agent, q: string) {
    return a.name.toLowerCase().includes(q) || a.id.toLowerCase().includes(q) || a.now.toLowerCase().includes(q);
  }

  function html(r: Row, s: ShellState): string {
    const sel = s.selection;
    switch (r.kind) {
      case 'cos':
        return `<span class="cos-mark">${svg('crown', 15)}</span>
          <div class="grow"><div class="nm">Chief of Staff <span class="tag">pinned</span></div><div class="sub">${esc(r.a.now)}</div></div>
          <span class="sdot s-${r.a.status}"></span>`;
      case 'team':
        return `<span class="tdot"></span>
          <div class="grow"><div class="nm">${esc(r.name)}</div>
            <div class="sub"><span>${r.active} active</span>${r.needs ? `<span class="needs-n">· ${r.needs} waiting</span>` : ''}<span class="tbar"><i style="width:${Math.max(4, Math.round(r.act * 100))}%"></i></span></div></div>
          <span class="count">${r.total}</span>
          <button class="eye" title="${r.hidden ? 'Show team on map' : 'Hide team on map'}">${svg(r.hidden ? 'eyeOff' : 'eye', 15)}</button>
          <button class="chev" title="${r.open ? 'Collapse' : 'Expand'}">${svg('chevron', 14)}</button>`;
      case 'agent':
        return `<span class="sdot s-${r.a.status}"></span>
          <div class="grow"><div class="nm">${esc(r.a.name)}${r.a.role === 'lead' ? '<span class="tag">lead</span>' : ''}</div><div class="sub">${esc(r.a.now)}</div></div>`;
      case 'more':
        return `${svg('arrowRight', 13)}<span>${r.open ? 'Hide' : '+' + r.n} idle agent${r.n === 1 ? '' : 's'}</span>`;
    }
    void sel;
  }

  function classes(r: Row, s: ShellState) {
    const sel = s.selection;
    const on = (r.kind === 'team' && sel.type === 'team' && sel.id === r.id) ||
      ((r.kind === 'agent' || r.kind === 'cos') && sel.type === 'agent' && sel.id === r.a.id);
    let c = `row ${r.kind}${on ? ' on' : ''}`;
    if (r.kind === 'team') c += `${r.open ? ' open' : ''}${r.hidden ? ' off' : ''}`;
    if (r.kind === 'agent' && r.last) c += ' last';
    return c;
  }

  function paint() {
    const s = store.get();
    const virtual = rows.length > VIRTUAL_AT;
    let lo = 0, hi = rows.length;
    if (virtual) {
      const top = scroller.scrollTop - 300, bottom = scroller.scrollTop + scroller.clientHeight + 300;
      while (lo < rows.length && offsets[lo + 1] < top) lo++;
      hi = lo;
      while (hi < rows.length && offsets[hi] < bottom) hi++;
    }
    const keep = new Set<string>();
    for (let i = lo; i < hi; i++) {
      const r = rows[i];
      keep.add(r.key);
      let node = els.get(r.key);
      if (!node) {
        node = document.createElement('div');
        node.dataset.key = r.key;
        inner.appendChild(node);
        els.set(r.key, node);
      }
      const h = html(r, s);
      const c = classes(r, s);
      if (node.dataset.h !== h) { node.innerHTML = h; node.dataset.h = h; }
      if (node.className !== c) node.className = c;
      if ('hue' in r) node.style.setProperty('--hue', r.hue);
      node.style.transform = `translateY(${offsets[i]}px)`;
      node.style.height = `${H[r.kind]}px`;
    }
    for (const [k, node] of els) if (!keep.has(k)) { node.remove(); els.delete(k); }
  }

  function render(s: ShellState) {
    if (!s.loaded) {
      inner.innerHTML = Array.from({ length: 7 }, () => '<div class="skel-row"><i></i><b></b></div>').join('');
      inner.style.height = '';
      return;
    }
    if (inner.querySelector('.skel-row')) inner.innerHTML = '';
    inner.querySelector('.empty-mini')?.remove();
    rows = build(s);
    offsets = [0];
    for (const r of rows) offsets.push(offsets[offsets.length - 1] + H[r.kind]);
    inner.style.height = `${offsets[offsets.length - 1]}px`;
    paint();
    if (!rows.length) inner.innerHTML = `<div class="empty-mini">${s.query ? 'No agents match “' + esc(s.query) + '”' : 'No agents running'}</div>`, els.clear();

    meta.textContent = s.teamsById.size ? `${s.teamsById.size} teams` : '';
    const errs = [...s.agentsById.values()].filter((a) => a.status === 'error').length;
    const state = s.reconnecting ? 'warn' : errs || s.snapshot.error ? 'err' : 'ok';
    sysDot.className = `sys-dot ${state}`;
    sysText.textContent = s.reconnecting ? 'Reconnecting to fleet…' : s.snapshot.error ? 'Source degraded' : errs ? `${errs} agent${errs > 1 ? 's' : ''} erroring` : 'All systems operational';
  }

  return render;
}
