// Group rooms: create a room, pick agents from the live list, chat with all of them in one thread.
// Everything is server-side (persisted rooms, bounded runs); this view only renders it and polls while a run is in flight.
import { installMarkdownHandlers, renderInline, renderMarkdown } from '../../shared/markdown';
import { MAX_MEMBERS, YOU, type Council, type CouncilAgentStatus, type CouncilNote, type CouncilStopReason } from '../../shared/rooms';
import { createRoomsApi, type RoomAgent, type RoomSummary, type RoomView } from '../rooms-api';
import type { ShellStore } from '../store';
import { avatarHtml, avatarHue, esc, fmtHM, svg } from './format';

const POLL_RUNNING_MS = 1200;
const POLL_IDLE_MS = 5000;

type Mode = { t: 'empty' } | { t: 'create' } | { t: 'room'; id: string };

export function mountRooms(el: HTMLElement, store: ShellStore, onCount: (n: number) => void) {
  const api = createRoomsApi(store.source);
  let open = false;
  let mode: Mode = { t: 'empty' };
  let rooms: RoomSummary[] = [];
  let agents: RoomAgent[] = [];
  let view: RoomView | null = null;
  let showArchived = false;
  let renaming = false;
  let adding = false;
  let notice = '';
  let draft = '';
  const picked = new Set<string>();
  let createName = '';
  let timer: number | undefined;
  let busy = false;
  // Council panel open/closed + expanded notes: a poll repaints the thread, so what the user toggled is remembered here.
  // Default: open while the council runs, collapsed once it is done.
  const councilOpen = new Map<string, boolean>();
  const noteOpen = new Set<string>();

  const agentOf = (id: string): RoomAgent => agents.find((a) => a.id === id) ?? view?.members.find((a) => a.id === id) ?? { id, name: id };
  const who = (id: string): { name: string; html: string } => id === YOU
    ? { name: 'You', html: `<span class="avatar you" title="You">Y</span>` }
    : { name: agentOf(id).name, html: avatarHtml(id, agentOf(id).name, agentOf(id).emoji) };

  el.innerHTML = `<div class="rm-wrap"><aside class="rm-list"></aside><section class="rm-main"></section></div>`;
  const listEl = el.querySelector<HTMLElement>('.rm-list')!;
  const mainEl = el.querySelector<HTMLElement>('.rm-main')!;

  async function refresh() {
    try {
      const l = await api.list();
      rooms = l.rooms; agents = l.agents;
      onCount(rooms.filter((r) => !r.archived).length);
      if (mode.t === 'room') view = await api.get(mode.id);
      notice = notice.startsWith('Could not reach') ? '' : notice;
    } catch (e) {
      notice = `Could not reach the rooms service (${(e as Error).message}).`;
    }
    paint();
    schedule();
  }
  function schedule() {
    clearTimeout(timer);
    if (!open) return;
    timer = window.setTimeout(refresh, view?.run?.status === 'running' ? POLL_RUNNING_MS : POLL_IDLE_MS);
  }

  function paintList() {
    const live = rooms.filter((r) => !r.archived);
    const arch = rooms.filter((r) => r.archived);
    const row = (r: RoomSummary) => {
      const last = r.last ? `<span class="rm-last"><b>${esc(r.last.from === YOU ? 'You' : agentOf(r.last.from).name)}:</b> ${renderInline(r.last.text.replace(/^\s{0,3}(?:#{1,6}|[-*>]|\d+\.)\s+/gm, ''))}</span>` : '<span class="rm-last muted">No messages yet</span>';
      return `<button class="rm-row${mode.t === 'room' && mode.id === r.id ? ' on' : ''}" data-room="${r.id}">
        <span class="rm-stack">${r.members.slice(0, 4).map((m) => avatarHtml(m, agentOf(m).name, agentOf(m).emoji, 'sm')).join('')}</span>
        <span class="rm-name">${esc(r.name)}${r.running ? '<i class="rm-run" title="agents are answering"></i>' : ''}</span>${last}</button>`;
    };
    listEl.innerHTML = `
      <header class="rm-head"><h2>Rooms</h2><button class="rm-new" data-act="new">${svg('plus', 14)}<span>New room</span></button></header>
      <div class="rm-rows">${live.map(row).join('') || '<div class="rm-none">No rooms yet. Create one and add some agents.</div>'}</div>
      ${arch.length ? `<button class="rm-arch-toggle" data-act="toggle-archived">${showArchived ? 'Hide' : 'Show'} archived (${arch.length})</button>${showArchived ? `<div class="rm-rows archived">${arch.map(row).join('')}</div>` : ''}` : ''}`;
  }

  const agentPicker = (selected: Set<string>, exclude: string[] = [], attr = 'data-pick') => {
    const list = agents.filter((a) => !exclude.includes(a.id));
    return list.length ? `<div class="rm-picker">${list.map((a) => `<label class="rm-pick${selected.has(a.id) ? ' on' : ''}"><input type="checkbox" ${attr}="${esc(a.id)}" ${selected.has(a.id) ? 'checked' : ''}/>${avatarHtml(a.id, a.name, a.emoji, 'sm')}<span>${esc(a.name)}<small class="mono">@${esc(a.id)}</small></span></label>`).join('')}</div>` : '<div class="rm-none">No other agents available.</div>';
  };

  const STATUS_LABEL: Record<CouncilAgentStatus, string> = { idle: 'waiting', planning: 'planning', working: 'working', steering: 'deciding', critiquing: 'critiquing', synthesizing: 'synthesizing', done: 'done', timeout: 'timed out', error: 'failed', skipped: 'skipped', stopped: 'stopped' };
  const PHASE_LABEL: Record<Council['phase'], string> = { planning: 'Captain is planning', working: 'Members are working', steering: 'Captain is deciding the next step', critiquing: 'Members are critiquing each other', synthesizing: 'Captain is writing the answer', done: 'Done', stopped: 'Stopped' };
  const NOTE_KIND: Record<CouncilNote['kind'], string> = { plan: 'plan', decision: 'decision', answer: 'answer', followup: 'follow-up', critique: 'critique', system: 'note' };
  const STOP_LABEL: Record<CouncilStopReason, string> = { done: 'done: good enough', stepLimit: 'step limit', cap: 'turn cap', noProgress: 'no progress', malformed: 'unusable decision', captainFailed: 'captain failed', cancelled: 'cancelled' };
  const NOTE_CLAMP = 260;
  const mentionize = (text: string, room: RoomView['room']) => renderMarkdown(text, { mentions: room.members });
  const fmtDur = (ms: number) => (ms < 1000 ? '<1s' : ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`);

  function noteRow(n: CouncilNote, room: RoomView['room']): string {
    const w = who(n.agent);
    const long = n.text.length > NOTE_CLAMP;
    const body = n.pass ? '<span class="rm-pass">PASS · no objection</span>' : long
      ? `<details class="rm-note-more" data-nid="${esc(n.id)}" ${noteOpen.has(n.id) ? 'open' : ''}><summary><span class="rm-note-prev">${renderInline(n.text.slice(0, NOTE_CLAMP).trimEnd())}…</span><span class="rm-more">more</span></summary><div class="rm-note-full">${mentionize(n.text, room)}</div></details>`
      : mentionize(n.text, room);
    return `<div class="rm-note ${n.kind}${n.pass ? ' pass' : ''}" style="--hue:${avatarHue(n.agent)}">
      <div class="rm-note-line"><b>${esc(w.name)}</b><span class="rm-kind">${NOTE_KIND[n.kind]}</span><time>${fmtHM(n.ts)}</time></div>
      <div class="rm-note-text md">${body}</div></div>`;
  }

  /** The collapsible "Council thinking" panel under the captain's reply: per-agent status chips + compact note rows. */
  function councilPanel(c: Council, room: RoomView['room']): string {
    const live = c.phase !== 'done' && c.phase !== 'stopped';
    const open = councilOpen.get(c.id) ?? live;
    const ids = Object.keys(c.agents).length ? Object.keys(c.agents) : room.members;
    const chips = ids.map((id) => {
      const st = c.agents[id]?.status ?? 'idle';
      const w = who(id);
      return `<span class="rm-cagent st-${st}" title="${esc(w.name)}: ${STATUS_LABEL[st]}">${avatarHtml(id, w.name, agentOf(id).emoji, 'sm')}<span class="rm-cname">${esc(w.name)}${id === c.captain ? '<small>captain</small>' : ''}</span><i class="rm-cst">${STATUS_LABEL[st]}</i></span>`;
    }).join('');
    const plan = c.plan?.fallback ? '<span class="rm-cwarn" title="The captain\'s plan could not be parsed, so every member got the whole question">fallback plan</span>' : '';
    const elapsed = fmtDur((c.endedAt ?? Date.now()) - c.startedAt);
    const nSteps = c.steps?.length ?? 0;
    const steps = c.maxSteps ? ` · step ${nSteps}/${c.maxSteps}` : '';
    const stopped = c.stop && c.stop.reason !== 'cancelled' ? `<span class="rm-cstop ${c.stop.reason}" title="${esc(c.stop.detail ?? '')}">stopped: ${esc(STOP_LABEL[c.stop.reason])}</span>` : '';
    return `<details class="rm-council ${c.phase}" data-cid="${esc(c.id)}" data-live="${live ? 1 : 0}" ${open ? 'open' : ''}>
      <summary><span class="rm-chev">${svg('chevron', 12)}</span><b>Council thinking</b>${live ? '<i class="rm-run"></i>' : ''}<span class="rm-csub">${esc(PHASE_LABEL[c.phase])} · ${ids.length} agents · ${c.turnsUsed}/${c.maxTurns} turns${steps} · ${elapsed}</span>${plan}${stopped}</summary>
      <div class="rm-cagents">${chips}</div>
      <div class="rm-notes">${c.notes.map((n) => noteRow(n, room)).join('') || '<div class="rm-none">Waiting for the first notes…</div>'}</div>
    </details>`;
  }

  /** Zach's message, then ONE captain reply (or a placeholder while the council works), then the collapsible panel. */
  function councilBlock(c: Council, view: RoomView): string {
    const { room } = view;
    const final = c.finalId ? room.messages.find((m) => m.id === c.finalId) : undefined;
    const w = who(c.captain);
    const reply = final
      ? `<div class="rm-msg captain">${w.html}<div class="rm-body"><div class="rm-meta"><b>${esc(w.name)}</b><span class="rm-rnd">captain · council answer</span><time>${fmtHM(final.ts)}</time></div><div class="rm-text md">${mentionize(final.text, room)}</div></div></div>`
      : c.phase === 'stopped' ? ''
      : `<div class="rm-msg captain pending">${w.html}<div class="rm-body"><div class="rm-meta"><b>${esc(w.name)}</b><span class="rm-rnd">captain</span></div><div class="rm-text muted"><span class="rm-typing"><i></i>${esc(PHASE_LABEL[c.phase])}…</span></div></div></div>`;
    return `${reply}<div class="rm-council-wrap">${councilPanel(c, room)}</div>`;
  }

  function paintMain() {
    if (mode.t === 'empty') {
      mainEl.innerHTML = `<div class="rm-blank">${svg('users', 28)}<b>Group rooms</b><span>Chat with several agents in one thread. Each agent answers from its own room session, so nothing lands in its main chat.</span><button class="rm-new" data-act="new">${svg('plus', 14)}<span>New room</span></button></div>`;
      return;
    }
    if (mode.t === 'create') {
      mainEl.innerHTML = `<div class="rm-create">
        <h3>New room</h3>
        <label class="rm-field"><span>Name</span><input class="rm-name-in" maxlength="60" placeholder="e.g. Launch review" value="${esc(createName)}"/></label>
        <div class="rm-field"><span>Agents <small>${picked.size} selected · pick from the live agent list</small></span>${agentPicker(picked)}</div>
        <div class="rm-actions"><button class="rm-primary" data-act="create" ${picked.size && createName.trim() ? '' : 'disabled'}>Create room</button><button class="rm-ghost" data-act="cancel">Cancel</button></div>
        <div class="rm-notice" role="status">${esc(notice)}</div></div>`;
      return;
    }
    if (!view) { mainEl.innerHTML = '<div class="rm-blank"><span>Loading…</span></div>'; return; }
    const { room, run } = view;
    const running = run?.status === 'running';
    const nonMembers = agents.filter((a) => !room.members.includes(a.id));
    const councils = new Map(room.councils.map((c) => [c.id, c]));
    const finals = new Set(room.councils.map((c) => c.finalId).filter(Boolean));
    const msgs = room.messages.map((m) => {
      if (finals.has(m.id)) return ''; // the captain's reply is drawn with its council, right under Zach's message
      if (m.from === 'system') return `<div class="rm-sys">${esc(m.text)}</div>`;
      const w = who(m.from);
      const text = mentionize(m.text, room);
      const mine = `<div class="rm-msg${m.from === YOU ? ' me' : ''}">${w.html}<div class="rm-body"><div class="rm-meta"><b>${esc(w.name)}</b>${m.round && m.round > 1 ? `<span class="rm-rnd">round ${m.round}</span>` : ''}<time>${fmtHM(m.ts)}</time></div><div class="rm-text md">${text}</div></div></div>`;
      const c = councils.get(m.id);
      return c ? mine + councilBlock(c, view!) : mine;
    }).join('');
    const status = running
      ? run!.mode === 'council' && run!.phase
        ? `<span class="rm-typing"><i></i>Council · ${esc(PHASE_LABEL[run!.phase].toLowerCase())} · turn ${run!.turnsUsed}/${run!.maxTurns}</span><button class="rm-ghost" data-act="stop">Stop</button>`
        : `<span class="rm-typing"><i></i>${run!.current ? `${esc(agentOf(run!.current).name)} is answering` : 'Working'} · round ${run!.round}/${run!.maxRounds} · turn ${run!.turnsUsed}/${run!.maxTurns}</span><button class="rm-ghost" data-act="stop">Stop</button>`
      : '';
    mainEl.innerHTML = `
      <header class="rm-bar">
        ${renaming ? `<input class="rm-rename" maxlength="60" value="${esc(room.name)}" aria-label="Room name"/><button class="rm-primary sm" data-act="rename-ok">Save</button><button class="rm-ghost sm" data-act="rename-cancel">Cancel</button>`
          : `<h3>${esc(room.name)}${room.archived ? ' <small class="rm-tag">archived</small>' : ''}</h3><button class="rm-ghost sm" data-act="rename">Rename</button>`}
        <span class="grow"></span>
        <button class="rm-ghost sm" data-act="archive">${room.archived ? 'Restore' : 'Archive'}</button>
      </header>
      <div class="rm-members">
        ${view.members.map((a) => `<span class="rm-chip${a.id === room.captain && room.mode === 'council' ? ' captain' : ''}" title="${a.id === room.captain && room.mode === 'council' ? 'Council captain' : ''}">${avatarHtml(a.id, a.name, a.emoji, 'sm')}<span>${esc(a.name)}</span>${a.id === room.captain && room.mode === 'council' ? '<small class="rm-cap">captain</small>' : ''}<button data-remove="${esc(a.id)}" title="Remove ${esc(a.name)}" aria-label="Remove ${esc(a.name)}" ${running ? 'disabled' : ''}>${svg('close', 12)}</button></span>`).join('') || '<span class="muted">No agents in this room.</span>'}
        ${room.members.length < MAX_MEMBERS && nonMembers.length ? `<button class="rm-add" data-act="add-toggle" ${running ? 'disabled' : ''}>${svg('plus', 12)}<span>Add agent</span></button>` : ''}
        <span class="grow"></span>
        <span class="rm-limits" title="Council: the captain splits your message, members answer in parallel, then the captain steers (a follow-up to chosen members, a critique round, or stop) for at most the set number of steps, and gives ONE answer. Only the captain routes turns. An @mention goes straight to that agent. Round-table: everyone answers in turn. turns caps agent runs per message across all phases; timeout cuts off a slow member.">
          mode <select data-set="mode" aria-label="Room mode"><option value="council" ${room.mode === 'council' ? 'selected' : ''}>Council</option><option value="roundtable" ${room.mode === 'roundtable' ? 'selected' : ''}>Round-table</option></select>
          ${room.mode === 'council' ? `captain <select data-set="captain" class="wide" aria-label="Council captain" ${running ? 'disabled' : ''}>${view.members.map((a) => `<option value="${esc(a.id)}" ${a.id === room.captain ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select>` : `rounds <select data-set="maxRounds">${[1, 2, 3, 4].map((n) => `<option ${n === room.maxRounds ? 'selected' : ''}>${n}</option>`).join('')}</select>`}
          ${room.mode === 'council' ? `steps <input type="number" min="1" max="4" value="${room.maxSteps}" data-set="maxSteps" title="How many follow-up decisions the captain may make before it must answer (1-4)"/>` : ''}
          turns <input type="number" min="1" max="32" value="${room.maxTurns}" data-set="maxTurns" title="Hard cap on agent runs per message, across all phases"/>
          timeout <input type="number" min="1" max="600" value="${room.memberTimeoutSec}" data-set="memberTimeoutSec" title="Seconds before a slow member is cut off"/>s</span>
      </div>
      ${adding ? `<div class="rm-addbox">${agentPicker(new Set(), room.members, 'data-addpick')}<div class="rm-actions"><button class="rm-ghost sm" data-act="add-close">Done</button></div></div>` : ''}
      <div class="rm-thread" tabindex="0">${msgs || '<div class="rm-blank small"><span>No messages yet. Ask something: the captain splits it across the council and gives you one answer. <span class="rm-at">@name</span> goes straight to just that agent.</span></div>'}</div>
      <footer class="rm-compose">
        <div class="rm-status">${status}</div>
        <div class="rm-mentions">${view.members.map((a) => `<button class="rm-mention" data-mention="${esc(a.id)}">@${esc(a.id)}</button>`).join('')}</div>
        <div class="rm-row2"><textarea rows="1" maxlength="4000" placeholder="${room.archived ? 'Archived room' : running ? 'Agents are answering…' : 'Message the room… (@name to address one agent)'}" ${room.archived || running || !room.members.length ? 'disabled' : ''} aria-label="Message the room">${esc(draft)}</textarea>
          <button class="cmp-send rm-send" data-act="send" ${room.archived || running || !room.members.length ? 'disabled' : ''}>${svg('send', 15)}<span>Send</span></button></div>
        <div class="cmp-status ${notice ? 'err' : ''}" role="status">${esc(notice)}</div>
      </footer>`;
    const th = mainEl.querySelector<HTMLElement>('.rm-thread')!;
    if (stick) th.scrollTop = th.scrollHeight;
    th.addEventListener('scroll', () => { stick = th.scrollTop + th.clientHeight >= th.scrollHeight - 40; });
    const box = mainEl.querySelector('textarea');
    box?.addEventListener('input', () => { draft = box.value; (mainEl.querySelector<HTMLButtonElement>('[data-act=send]')!).disabled = !draft.trim(); });
    if (box && focusBox) { box.focus(); box.setSelectionRange(box.value.length, box.value.length); }
    const sendBtn = mainEl.querySelector<HTMLButtonElement>('[data-act=send]');
    if (sendBtn && !room.archived && !running) sendBtn.disabled = !draft.trim();
  }
  let stick = true;
  let focusBox = false;

  function paint() {
    // Keep typing intact: a poll must not rebuild the view under the user's cursor.
    const active = document.activeElement as HTMLElement | null;
    const typing = active && el.contains(active) && (active.matches('textarea, input[type=text], .rm-name-in, .rm-rename') || active.matches('input:not([type=checkbox])'));
    paintList();
    if (typing && mode.t !== 'room') return;
    if (typing && mode.t === 'room' && active.matches('textarea')) { patchThread(); return; }
    if (typing && active.matches('.rm-rename, .rm-name-in')) return;
    focusBox = false;
    paintMain();
  }
  /** While the composer has focus, rebuild around it and put the caret back, so a poll never eats typing. */
  function patchThread() {
    const box = mainEl.querySelector('textarea');
    if (box) draft = box.value;
    paintMain();
    const nb = mainEl.querySelector('textarea');
    if (nb) { nb.focus(); nb.setSelectionRange(nb.value.length, nb.value.length); }
  }

  async function act(fn: () => Promise<RoomView | void>, after?: () => void) {
    if (busy) return;
    busy = true; notice = '';
    try { const v = await fn(); if (v) view = v; after?.(); } catch (e) { notice = (e as Error).message; }
    busy = false;
    await refresh();
  }

  installMarkdownHandlers(el);

  // <details> toggles do not bubble: remember what the user opened/closed so the next poll repaint keeps it.
  el.addEventListener('toggle', (e) => {
    const d = e.target as HTMLDetailsElement;
    // Only a state that differs from the default (open while running, collapsed once done) is a user choice; the repaint's own toggles are not.
    if (d.dataset?.cid) { if (d.open === (d.dataset.live === '1')) councilOpen.delete(d.dataset.cid); else councilOpen.set(d.dataset.cid, d.open); }
    else if (d.dataset?.nid) { if (d.open) noteOpen.add(d.dataset.nid); else noteOpen.delete(d.dataset.nid); }
  }, true);
  el.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    const roomBtn = t.closest<HTMLElement>('[data-room]');
    if (roomBtn) { mode = { t: 'room', id: roomBtn.dataset.room! }; view = null; renaming = adding = false; notice = ''; draft = ''; stick = true; void refresh(); return; }
    const rm = t.closest<HTMLElement>('[data-remove]');
    if (rm && mode.t === 'room') { const id = mode.id; void act(() => api.update(id, { removeMembers: [rm.dataset.remove] })); return; }
    const mention = t.closest<HTMLElement>('[data-mention]');
    if (mention) { draft = `${draft}${draft && !/\s$/.test(draft) ? ' ' : ''}@${mention.dataset.mention} `; focusBox = true; paintMain(); return; }
    const a = t.closest<HTMLElement>('[data-act]')?.dataset.act;
    if (!a) return;
    const id = mode.t === 'room' ? mode.id : '';
    switch (a) {
      case 'new': mode = { t: 'create' }; picked.clear(); createName = ''; notice = ''; paint(); break;
      case 'cancel': mode = { t: 'empty' }; notice = ''; paint(); break;
      case 'toggle-archived': showArchived = !showArchived; paintList(); break;
      case 'create': void act(async () => {
        const v = await api.create({ name: createName, members: [...picked] });
        mode = { t: 'room', id: v.room.id }; view = v; picked.clear(); createName = ''; return v;
      }); break;
      case 'rename': renaming = true; paintMain(); mainEl.querySelector<HTMLInputElement>('.rm-rename')?.select(); break;
      case 'rename-cancel': renaming = false; paintMain(); break;
      case 'rename-ok': { const name = mainEl.querySelector<HTMLInputElement>('.rm-rename')!.value; void act(() => api.update(id, { name }), () => { renaming = false; }); break; }
      case 'archive': void act(() => api.update(id, { archived: !view!.room.archived })); break;
      case 'add-toggle': adding = !adding; paintMain(); break;
      case 'add-close': adding = false; paintMain(); break;
      case 'stop': void act(() => api.stop(id)); break;
      case 'send': void submit(); break;
    }
  });
  el.addEventListener('change', (e) => {
    const t = e.target as HTMLInputElement | HTMLSelectElement;
    if (t.matches('[data-pick]')) {
      const id = (t as HTMLInputElement).dataset.pick!;
      if ((t as HTMLInputElement).checked) picked.add(id); else picked.delete(id);
      if (picked.size > MAX_MEMBERS) { picked.delete(id); }
      t.closest('.rm-pick')?.classList.toggle('on', (t as HTMLInputElement).checked);
      el.querySelector('.rm-field small')!.textContent = `${picked.size} selected · pick from the live agent list`;
      el.querySelector<HTMLButtonElement>('[data-act=create]')!.disabled = !(picked.size && createName.trim());
    } else if (t.matches('[data-addpick]') && mode.t === 'room') {
      const id = mode.id;
      void act(() => api.update(id, { addMembers: [(t as HTMLInputElement).dataset.addpick] }));
    } else if (t.matches('[data-set]') && mode.t === 'room') {
      const id = mode.id;
      const key = (t as HTMLElement).dataset.set!;
      void act(() => api.update(id, { [key]: key === 'mode' || key === 'captain' ? t.value : Number(t.value) }));
    }
  });
  el.addEventListener('input', (e) => {
    const t = e.target as HTMLInputElement;
    if (t.matches('.rm-name-in')) { createName = t.value; el.querySelector<HTMLButtonElement>('[data-act=create]')!.disabled = !(picked.size && createName.trim()); }
  });
  el.addEventListener('keydown', (e) => {
    const t = e.target as HTMLElement;
    if (e.key !== 'Escape') e.stopPropagation(); // typing stays out of global shortcuts
    if (t.matches('textarea') && e.key === 'Enter' && !e.shiftKey && !(e as KeyboardEvent).isComposing) { e.preventDefault(); void submit(); }
    if (t.matches('.rm-rename') && e.key === 'Enter') { e.preventDefault(); el.querySelector<HTMLButtonElement>('[data-act=rename-ok]')?.click(); }
  });

  async function submit() {
    if (mode.t !== 'room') return;
    const box = mainEl.querySelector('textarea');
    const text = (box?.value ?? draft).trim();
    if (!text || busy) return;
    const id = mode.id;
    busy = true; notice = '';
    try {
      view = await api.send(id, text);
      draft = ''; stick = true;
    } catch (e) { notice = (e as Error).message; draft = text; }
    busy = false;
    paintMain();
    await refresh();
  }

  return {
    show() { open = true; el.hidden = false; void refresh(); },
    hide() { open = false; el.hidden = true; clearTimeout(timer); },
    toggle() { if (open) this.hide(); else this.show(); },
    isOpen: () => open,
    /** Background count for the topbar badge. */
    async prime() { try { const l = await api.list(); rooms = l.rooms; agents = l.agents; onCount(rooms.filter((r) => !r.archived).length); } catch { /* optional */ } },
  };
}
