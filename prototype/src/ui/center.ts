// Center column: map host + overlays (breadcrumb, title, zoom pills, legend) and empty/loading states.
import type { MapApi, Selection, Zoom } from '../contract';
import type { ShellState, ShellStore } from '../store';
import { mountComposer } from './composer';
import { esc, openNeeds, svg } from './format';

export function mountCenter(el: HTMLElement, store: ShellStore, opts: { onFocusMode: () => void; onOpenSession: (key: string) => void }) {
  el.innerHTML = `
    <div class="map-host"></div>
    <div class="map-vignette"></div>
    <div class="c-head">
      <div class="crumbs"><button class="crumb-back" title="Back to fleet">${svg('back', 14)}</button><span>Workspace</span><span class="slash">/</span><span class="crumb-cur">All teams</span></div>
      <h1 class="c-title">Fleet overview</h1>
      <div class="c-sub"></div>
    </div>
    <div class="c-tools"><button class="icon-btn tool focus-btn" title="Focus map (hide panels)">${svg('expand', 16)}</button></div>
    <div class="c-state" hidden></div>
    <div class="c-compose" hidden><div class="cmp-mount"></div><button class="cmp-thread" title="Open this session's thread">Thread</button></div>
    <div class="c-bottom">
      <div class="seg zoom-seg">${(['fleet', 'team', 'agent'] as Zoom[]).map((z) => `<button data-z="${z}">${z[0].toUpperCase() + z.slice(1)}</button>`).join('')}</div>
      <div class="legend"></div>
    </div>`;

  const host = el.querySelector<HTMLElement>('.map-host')!;
  const title = el.querySelector<HTMLElement>('.c-title')!;
  const sub = el.querySelector<HTMLElement>('.c-sub')!;
  const cur = el.querySelector<HTMLElement>('.crumb-cur')!;
  const back = el.querySelector<HTMLElement>('.crumb-back')!;
  const legend = el.querySelector<HTMLElement>('.legend')!;
  const stateEl = el.querySelector<HTMLElement>('.c-state')!;
  const seg = el.querySelector<HTMLElement>('.zoom-seg')!;
  const compose = el.querySelector<HTMLElement>('.c-compose')!;
  const composer = mountComposer(compose.querySelector<HTMLElement>('.cmp-mount')!, store);
  let composeKey = '';
  compose.querySelector('.cmp-thread')!.addEventListener('click', () => { if (composeKey) opts.onOpenSession(composeKey); });
  let map: MapApi | null = null;

  seg.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button');
    if (!b) return;
    const z = b.dataset.z as Zoom;
    store.setZoom(z);
    const s = store.get();
    if (z === 'fleet') { store.select({ type: 'none' }); map?.focus({ type: 'none' }); }
    else map?.focus(s.selection);
  });
  back.addEventListener('click', () => {
    store.select({ type: 'none' });
    store.setZoom('fleet');
    map?.focus({ type: 'none' });
  });
  el.querySelector('.focus-btn')!.addEventListener('click', opts.onFocusMode);

  return {
    host,
    setMap(m: MapApi | null) { map = m; el.classList.toggle('no-map', !m); },
    focus(sel: Selection) { map?.focus(sel); },
    resize() { map?.resize(); },
    update(s: ShellState) {
      for (const b of seg.querySelectorAll<HTMLButtonElement>('button')) b.classList.toggle('on', b.dataset.z === s.zoom);
      const agents = [...s.agentsById.values()];
      const active = agents.filter((a) => a.status === 'active').length;
      const idle = agents.filter((a) => a.status === 'idle').length;
      const needs = openNeeds(s, store.events()).length;
      const sel = s.selection;
      let t = 'Fleet overview', crumb = 'All teams', subtitle = `${agents.length} agents across ${s.teamsById.size} teams`;
      const team = sel.type === 'team' ? s.teamsById.get(sel.id) : sel.type === 'agent' ? s.teamsById.get(s.agentsById.get(sel.id)?.team ?? '') : undefined;
      if (team) {
        const members = agents.filter((a) => a.team === team.id);
        crumb = team.name;
        t = team.name;
        subtitle = `${members.length} agents · ${members.filter((a) => a.status === 'active').length} active`;
      }
      if (sel.type === 'agent') {
        const a = s.agentsById.get(sel.id);
        if (a) { t = a.name; subtitle = a.now; }
      }
      // "Message agent": the selected agent, or a selected team's lead (else its first main session).
      let target: { key: string; label: string } | null = null;
      if (sel.type === 'agent') {
        const a = s.agentsById.get(sel.id);
        if (a) target = { key: a.id, label: a.name };
      } else if (sel.type === 'team' && team) {
        const lead = (team.lead && s.agentsById.get(team.lead)) || agents.find((a) => a.team === team.id && a.kind === 'main');
        if (lead) target = { key: lead.id, label: `${team.name} lead` };
      }
      composeKey = target?.key ?? '';
      compose.hidden = !target;
      compose.style.setProperty('--hue', team?.hue ?? '#7c9cff');
      if (target) composer.setTarget(target);
      title.textContent = t;
      title.style.setProperty('--hue', team?.hue ?? 'transparent');
      title.classList.toggle('has-hue', !!team);
      cur.textContent = crumb;
      back.hidden = sel.type === 'none';
      if (!s.loaded) subtitle = s.reconnecting ? 'Reconnecting…' : 'Connecting…';
      sub.innerHTML = `${esc(subtitle)}<span class="dot-sep">·</span><span>Real-time communication map</span>`;
      legend.innerHTML = `<span><i class="s-active"></i>Active <b>${active}</b></span><span><i class="s-idle"></i>Idle <b>${idle}</b></span><span class="lg-needs"><i class="s-needs"></i>Needs you <b>${needs}</b></span>`;

      let msg = '';
      if (!s.loaded) msg = `<div class="spinner"></div><b>Connecting to the fleet…</b><span>Waiting for the first snapshot from the Agent OS API.</span>`;
      else if (!agents.length) msg = `<b>No agents running</b><span>When agents start on this Mac they’ll appear here.</span>`;
      stateEl.hidden = !msg;
      if (msg) stateEl.innerHTML = msg;
    },
  };
}

/** Lightweight stand-in until src/map/index.ts lands: team constellations as DOM. */
export function mountPlaceholder(host: HTMLElement, store: ShellStore): MapApi {
  host.innerHTML = `<div class="ph"><div class="ph-orbits"></div><div class="ph-note">Map renderer not loaded yet · showing team summary</div></div>`;
  const orbits = host.querySelector<HTMLElement>('.ph-orbits')!;
  let key = '';
  const off = store.subscribe((s) => {
    const teams = s.snapshot.teams.filter((t) => !s.hiddenTeams.has(t.id));
    const k = teams.map((t) => t.id).join() + s.agentsById.size + (s.selection.type === 'team' ? s.selection.id : '');
    const counts = (id: string) => {
      let n = 0, a = 0;
      for (const ag of s.agentsById.values()) if (ag.team === id) { n++; if (ag.status === 'active') a++; }
      return [n, a];
    };
    if (k !== key) {
      key = k;
      orbits.innerHTML = teams.map((t, i) => {
        const ang = (i / Math.max(1, teams.length)) * Math.PI * 2 - Math.PI / 2;
        const center = t.id === 'main';
        const x = center ? 50 : 50 + Math.cos(ang) * 34, y = center ? 50 : 50 + Math.sin(ang) * 32;
        const on = s.selection.type === 'team' && s.selection.id === t.id;
        return `<button class="ph-team${on ? ' on' : ''}" data-t="${t.id}" style="left:${x}%;top:${y}%;--hue:${t.hue}"><span class="ph-blob"></span><b>${esc(t.name)}</b><small data-c></small></button>`;
      }).join('');
    }
    for (const b of orbits.querySelectorAll<HTMLElement>('.ph-team')) {
      const [n, a] = counts(b.dataset.t!);
      b.querySelector('[data-c]')!.textContent = `${n} agents · ${a} active`;
    }
  });
  orbits.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('.ph-team');
    if (b) { store.select({ type: 'team', id: b.dataset.t! }); store.setZoom('team'); }
  });
  return { focus() {}, resize() {}, destroy() { off(); host.innerHTML = ''; } };
}
