// Group rooms: create a room, pick agents from the live list, chat with all of them in one thread.
// Everything is server-side (persisted rooms, the open discussion run); this view only renders the thread and polls while a discussion is in flight.
import { installMarkdownHandlers, renderInline, renderMarkdown } from '../../shared/markdown';
import { MAX_MEMBERS, YOU, handoffsOf, roomSessionKey, totalTokens, type PauseInfo, type RoomUsage } from '../../shared/rooms';
import { createRoomsApi, type RoomAgent, type RoomSummary, type RoomView } from '../rooms-api';
import type { HostBridge } from '../hostbridge';
import type { ShellStore } from '../store';
import { avatarHtml, avatarHue, esc, fmtHM, fmtK, svg } from './format';

const POLL_RUNNING_MS = 1200;
const POLL_IDLE_MS = 5000;

type Mode = { t: 'empty' } | { t: 'create' } | { t: 'room'; id: string };

const MODE_LABEL = { everyone: 'Everyone', mentions: 'Mentions only', lead: 'Lead first' } as const;
const MODE_HINT = 'Who answers a message that does not @mention anyone: everyone talks it through; only @mentioned agents answer; or the lead answers first and others join when @mentioned or handed a point.';
const PAUSE_TITLE: Record<PauseInfo['reason'], string> = { posts: 'Paused to check in', tokens: 'Paused at the token ceiling', repeat: 'Paused: an agent repeated itself', ring: 'Paused: a hand-off loop' };
const money = (n: number) => `$${n.toFixed(n < 1 ? 3 : 2)}`;
const secs = (since: number) => { const s = Math.max(0, Math.round((Date.now() - since) / 1000)); return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`; };
const clipTxt = (t: string, n: number) => (t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t);
const usageLine = (u: RoomUsage | undefined, label: string) => u?.turns ? `${label}: ${u.turns} turns, ${totalTokens(u).toLocaleString('en-US')} tokens${u.estimated ? ' (partly estimated)' : ''}${u.costUsd ? `, ${money(u.costUsd)}` : ''}` : '';

export function mountRooms(el: HTMLElement, store: ShellStore, onCount: (n: number) => void, host?: HostBridge) {
  const api = createRoomsApi(store.source);
  let open = false;
  let mode: Mode = { t: 'empty' };
  let rooms: RoomSummary[] = [];
  let agents: RoomAgent[] = [];
  let view: RoomView | null = null;
  let showArchived = false;
  let renaming = false;
  let adding = false;
  let menuOpen = false;
  let notesOpen = false;
  let settingsOpen = false;
  let notesDraft: string | null = null;
  let notice = '';
  let draft = '';
  const picked = new Set<string>();
  let createName = '';
  let timer: number | undefined;
  let busy = false;
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
    timer = window.setTimeout(refresh, view?.run?.status === 'running' || view?.run?.status === 'paused' ? POLL_RUNNING_MS : POLL_IDLE_MS);
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

  const mentionize = (text: string, room: RoomView['room']) => renderMarkdown(text, { mentions: room.members });

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
    const paused = run?.status === 'paused';
    const live = running || paused; // the room is busy: no member edits; Zach's messages are queued (or wake a pause)
    const canWrite = !room.archived && room.members.length > 0;
    const nonMembers = agents.filter((a) => !room.members.includes(a.id));
    const hand = handoffsOf(room.messages, view.members.map((m) => ({ id: m.id, name: m.name })));
    const msgs = room.messages.map((m) => {
      if (m.from === 'system') return `<div class="rm-sys">${esc(m.text)}</div>`;
      const w = who(m.from);
      const h = hand.get(m.id);
      const handHtml = h ? `<div class="rm-hand" title="${esc(w.name)} handed this to ${esc(h.to.map((id) => agentOf(id).name).join(', '))} (hop ${h.hop})"><span class="rm-harrow">${svg('arrowRight', 12)}</span>${h.to.map((id) => `<span class="rm-hchip">${avatarHtml(id, agentOf(id).name, agentOf(id).emoji, 'sm')}${esc(agentOf(id).name)}</span>`).join('')}<small>hop ${h.hop}</small></div>` : '';
      const pin = m.queued ? '' : `<button class="rm-pin${m.pinned ? ' on' : ''}" data-pin="${esc(m.id)}" title="${m.pinned ? 'Unpin this decision' : 'Pin as a decision: every agent sees it'}" aria-label="${m.pinned ? 'Unpin' : 'Pin as a decision'}" aria-pressed="${!!m.pinned}">${svg('pin', 12)}</button>`;
      return `<div class="rm-msg${m.from === YOU ? ' me' : ''}${m.queued ? ' queued' : ''}${m.pinned ? ' pinned' : ''}" data-msg="${esc(m.id)}">${w.html}<div class="rm-body"><div class="rm-meta"><b>${esc(w.name)}</b>${m.queued ? '<small class="rm-q" title="Written while the agents were talking: it joins at the next round">queued</small>' : ''}${m.pinned ? '<small class="rm-pinned">decision</small>' : ''}<time>${fmtHM(m.ts)}</time>${pin}</div><div class="rm-text md">${mentionize(m.text, room)}</div>${handHtml}</div></div>`;
    }).join('');
    // Agents with a turn in flight show as typing bubbles at the end of the thread, like a group chat.
    const typing = (running ? run?.active ?? [] : []).map((id) => {
      const w = who(id);
      return `<div class="rm-msg pending" data-typing="${esc(id)}">${w.html}<div class="rm-body"><div class="rm-meta"><b>${esc(w.name)}</b></div><div class="rm-text muted"><span class="rm-typing"><i></i><i></i><i></i></span></div></div></div>`;
    }).join('');
    const names = (run?.active ?? []).map((id) => agentOf(id).name);
    const status = running
      ? `<span class="rm-typing"><i></i>${names.length ? `${esc(names.slice(0, 3).join(', '))}${names.length > 3 ? ` +${names.length - 3}` : ''} ${names.length === 1 ? 'is' : 'are'} typing…` : 'Discussion in progress…'}</span><button class="rm-ghost" data-act="end" title="Let the replies in flight land, then finish. Nothing new starts.">End now</button><button class="rm-ghost" data-act="stop" title="Abort every agent run right away">Stop</button>`
      : '';
    const pauseBanner = paused && run?.pause
      ? `<div class="rm-banner pause" role="status"><span class="rm-btxt"><b>${svg('pause', 13)} ${esc(PAUSE_TITLE[run.pause.reason])}</b><small>${esc(run.pause.detail)}. Nothing is capped: Continue picks the discussion up where it left off, or write a message to steer it.</small></span><button class="rm-primary sm" data-act="resume">Continue</button><button class="rm-ghost sm" data-act="end" title="Finish now without another round">End now</button><button class="rm-ghost sm" data-act="stop">Stop</button></div>`
      : run?.status === 'interrupted'
        ? `<div class="rm-banner interrupted" role="status"><span class="rm-btxt"><b>${svg('warn', 13)} Interrupted by a restart</b><small>The last discussion was cut off and is not replayed (its tools may already have run). Send a message to start again.</small></span></div>`
        : '';
    const acts = new Map((run?.activity ?? []).map((a) => [a.id, a]));
    const stateText = (id: string) => {
      const a = acts.get(id);
      if (paused) return ['paused', 'paused'];
      if (!a) return ['idle', 'idle'];
      if (a.state === 'tool') return ['tool', `using ${esc(a.tool ?? 'a tool')} · ${secs(a.since)}`];
      if (a.state === 'waiting') return ['waiting', `waiting on ${esc((a.waitingOn ?? []).map((w) => agentOf(w).name).join(', ') || 'the others')}`];
      return ['thinking', `thinking · ${secs(a.since)}`];
    };
    const strip = live
      ? `<div class="rm-strip" aria-label="What each agent is doing">${view.members.map((a) => { const [st, txt] = stateText(a.id); return `<span class="rm-st ${st}" data-state="${st}"><i></i><b>${esc(a.name)}</b><small>${txt}</small></span>`; }).join('')}</div>`
      : '';
    const u = run?.usage?.turns ? run.usage : undefined;
    const usageChip = u || room.usage?.turns
      ? `<span class="rm-usage${run?.usage?.estimated ? ' est' : ''}" data-usage title="${esc([usageLine(run?.usage, 'This discussion'), usageLine(room.usage, 'Whole room'), run?.lastSpeaker ? `Last speaker: ${agentOf(run.lastSpeaker).name}` : '', run?.filtered ? `Speak filter saved ${run.filtered} turn${run.filtered === 1 ? '' : 's'}` : ''].filter(Boolean).join('\n'))}">${svg('chat', 12)}<span>${u ? `${u.turns} turn${u.turns === 1 ? '' : 's'} · ${u.estimated ? '~' : ''}${fmtK(totalTokens(u))} tok${u.costUsd ? ` · ${u.estimated ? '~' : ''}${money(u.costUsd)}` : ''}` : `${room.usage!.turns} turns total`}${run?.lastSpeaker ? ` · last: ${esc(agentOf(run.lastSpeaker).name)}` : ''}${run?.filtered ? ` · ${run.filtered} skipped` : ''}</span></span>`
      : '';
    const pinned = room.messages.filter((m) => m.pinned && m.from !== 'system');
    const notesText = notesDraft ?? room.notes ?? '';
    const notesPanel = notesOpen
      ? `<div class="rm-notes">
          <div class="rm-note-col"><label class="rm-field"><span>Shared notes <small data-notes-count>${notesText.length}/4000 · every agent reads these each turn</small></span><textarea class="rm-notes-in" maxlength="4000" rows="5" placeholder="Goals, constraints, names, anything every agent should keep in mind…" aria-label="Shared room notes">${esc(notesText)}</textarea></label><div class="rm-actions"><button class="rm-primary sm" data-act="notes-save" ${notesDraft === null || notesDraft === (room.notes ?? '') ? 'disabled' : ''}>Save notes</button><button class="rm-ghost sm" data-act="notes-close">Close</button></div></div>
          <div class="rm-note-col"><div class="rm-field"><span>Decisions <small>${pinned.length} pinned · every agent reads these too</small></span>${pinned.length ? `<ul class="rm-decisions">${pinned.map((m) => `<li><b>${esc(who(m.from).name)}</b><span>${esc(clipTxt(m.text.replace(/\s+/g, ' '), 220))}</span><button data-pin="${esc(m.id)}" title="Unpin" aria-label="Unpin">${svg('close', 11)}</button></li>`).join('')}</ul>` : '<div class="rm-none">Nothing pinned yet. Use the pin on a message to keep it here.</div>'}</div></div>
        </div>`
      : '';
    const settingsPanel = settingsOpen
      ? `<div class="rm-settings">
          <label class="rm-set"><span>Pause after</span><input class="rm-set-in" type="number" min="0" max="500" data-set="pauseAfterPosts" value="${room.pauseAfterPosts ?? 24}" aria-label="Pause after this many replies"/><span>replies since you last wrote <small>0 = never pause on count</small></span></label>
          <label class="rm-set"><span>or after</span><input class="rm-set-in" type="number" min="0" step="1000" data-set="pauseAfterTokens" value="${room.pauseAfterTokens ?? 0}" aria-label="Pause after this many tokens"/><span>tokens <small>0 = off</small></span></label>
          <label class="rm-set check"><input type="checkbox" data-setbool="speakFilter" ${room.speakFilter ? 'checked' : ''}/><span>Skip turns with nothing to add <small>a small model decides who speaks in later rounds. Off by default; if it fails, everyone speaks.</small></span></label>
          <div class="rm-hint">A pause is soft: the discussion waits for you and never stops by itself. Repeats and hand-off loops pause it too.</div>
          <div class="rm-actions"><button class="rm-ghost sm" data-act="settings-close">Close</button></div>
        </div>`
      : '';
    const placeholder = room.archived ? 'Archived room' : running ? 'Queue a message: it joins the discussion at the next round…' : paused ? 'Write to the room: this also resumes the discussion…' : 'Message the room… (@name to address one agent)';
    // The repaint below replaces the whole thread element, which resets scrollTop to 0: read where the user is first.
    const prevTh = mainEl.querySelector<HTMLElement>('.rm-thread');
    let keepTop = 0;
    if (prevTh) { keepTop = prevTh.scrollTop; stick = keepTop + prevTh.clientHeight >= prevTh.scrollHeight - 40; }
    mainEl.innerHTML = `
      <header class="rm-bar">
        ${renaming ? `<input class="rm-rename" maxlength="60" value="${esc(room.name)}" aria-label="Room name"/><button class="rm-primary sm" data-act="rename-ok">Save</button><button class="rm-ghost sm" data-act="rename-cancel">Cancel</button>`
          : `<h3>${esc(room.name)}${room.archived ? ' <small class="rm-tag">archived</small>' : ''}</h3>`}
        <span class="grow"></span>
        ${usageChip}
        <div class="rm-tools">
          <button class="rm-tool${menuOpen ? ' on' : ''}" data-act="more" title="More" aria-label="More" aria-haspopup="menu" aria-expanded="${menuOpen}">${svg('more', 16)}</button>
          ${menuOpen ? `<div class="rm-menu" role="menu">
            <button role="menuitem" data-act="notes-toggle">Notes &amp; decisions${pinned.length ? ` (${pinned.length})` : ''}</button>
            <button role="menuitem" data-act="settings-toggle">Room settings</button>
            <i class="rm-sep" role="separator"></i>
            <button role="menuitem" data-act="wrapup" ${!canWrite || !room.captain ? 'disabled' : ''} title="Posts a normal message asking the lead to summarize where the discussion landed">Ask lead to summarize</button>
            <button role="menuitem" data-act="end" ${live ? '' : 'disabled'} title="Let replies in flight land, then finish. Nothing new starts.">End discussion now</button>
            <i class="rm-sep" role="separator"></i>
            <button role="menuitem" data-act="rename">Rename room</button>
            <button role="menuitem" data-act="archive">${room.archived ? 'Restore room' : 'Archive room'}</button>
            ${host?.has('open-session') && room.captain ? `<i class="rm-sep" role="separator"></i><button role="menuitem" data-act="open-captain" title="Open ${esc(agentOf(room.captain).name)}'s room session in the Control UI chat">${svg('chat', 14)}<span>Open lead's chat</span></button>` : ''}
          </div>` : ''}
        </div>
      </header>
      <div class="rm-members">
        ${view.members.map((a) => `<span class="rm-chip${a.id === room.captain ? ' captain' : ''}" title="${a.id === room.captain ? 'Lead: moderates the discussion' : ''}">${avatarHtml(a.id, a.name, a.emoji, 'sm')}<span>${esc(a.name)}</span>${a.id === room.captain && view!.members.length > 1 ? '<small class="rm-cap">lead</small>' : ''}<button data-remove="${esc(a.id)}" title="Remove ${esc(a.name)}" aria-label="Remove ${esc(a.name)}" ${live ? 'disabled' : ''}>${svg('close', 12)}</button></span>`).join('') || '<span class="muted">No agents in this room.</span>'}
        ${room.members.length < MAX_MEMBERS && nonMembers.length ? `<button class="rm-add" data-act="add-toggle" ${live ? 'disabled' : ''}>${svg('plus', 12)}<span>Add agent</span></button>` : ''}
        <span class="grow"></span>
        <span class="rm-limits" title="${esc(MODE_HINT)}">
          answers <select data-set="responderMode" class="wide" aria-label="Who answers a message with no @mention">${(Object.keys(MODE_LABEL) as Array<keyof typeof MODE_LABEL>).map((k) => `<option value="${k}" ${(room.responderMode ?? 'everyone') === k ? 'selected' : ''}>${MODE_LABEL[k]}</option>`).join('')}</select></span>
        <span class="rm-limits" title="The lead moderates the discussion. An @mention in your message goes straight to that agent.">
          lead <select data-set="captain" class="wide" aria-label="Discussion lead" ${live ? 'disabled' : ''}>${view.members.map((a) => `<option value="${esc(a.id)}" ${a.id === room.captain ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select></span>
      </div>
      ${strip}
      ${settingsPanel}
      ${notesPanel}
      ${adding ? `<div class="rm-addbox">${agentPicker(new Set(), room.members, 'data-addpick')}<div class="rm-actions"><button class="rm-ghost sm" data-act="add-close">Done</button></div></div>` : ''}
      <div class="rm-thread" tabindex="0">${msgs || typing ? msgs + typing : '<div class="rm-blank small"><span>No messages yet. Ask something: every agent replies and they talk it through together until nobody has more to add. <span class="rm-at">@name</span> goes straight to just that agent.</span></div>'}</div>
      <footer class="rm-compose">
        ${pauseBanner}
        <div class="rm-status">${status}</div>
        <div class="rm-mentions">${view.members.map((a) => `<button class="rm-mention" data-mention="${esc(a.id)}">@${esc(a.id)}</button>`).join('')}</div>
        <div class="rm-row2"><textarea rows="1" maxlength="4000" placeholder="${placeholder}" ${canWrite ? '' : 'disabled'} aria-label="Message the room">${esc(draft)}</textarea>
          <button class="cmp-send rm-send" data-act="send" ${canWrite ? '' : 'disabled'}>${svg('send', 15)}<span>${running ? 'Queue' : 'Send'}</span></button></div>
        <div class="cmp-status ${notice ? 'err' : ''}" role="status">${esc(notice)}</div>
      </footer>`;
    const th = mainEl.querySelector<HTMLElement>('.rm-thread')!;
    th.scrollTop = stick ? th.scrollHeight : keepTop; // follow new messages only when already near the bottom; otherwise stay put
    th.addEventListener('scroll', () => { stick = th.scrollTop + th.clientHeight >= th.scrollHeight - 40; });
    const box = mainEl.querySelector('textarea');
    box?.addEventListener('input', () => { draft = box.value; (mainEl.querySelector<HTMLButtonElement>('[data-act=send]')!).disabled = !draft.trim(); });
    if (box && focusBox) { box.focus(); box.setSelectionRange(box.value.length, box.value.length); }
    const sendBtn = mainEl.querySelector<HTMLButtonElement>('[data-act=send]');
    if (sendBtn && canWrite) sendBtn.disabled = !draft.trim();
  }
  let stick = true;
  let focusBox = false;

  function paint() {
    // Keep typing intact: a poll must not rebuild the view under the user's cursor.
    const active = document.activeElement as HTMLElement | null;
    const typing = active && el.contains(active) && (active.matches('textarea, input[type=text], .rm-name-in, .rm-rename') || active.matches('input:not([type=checkbox])'));
    paintList();
    if (typing && mode.t !== 'room') return;
    if (typing && active.matches('.rm-notes-in, .rm-set-in')) return; // a poll must not eat what is being typed in the notes or a limit field
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
  host?.onChange(() => { if (open && mode.t === 'room') paint(); }); // the plugin answers after boot

  el.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    const roomBtn = t.closest<HTMLElement>('[data-room]');
    if (roomBtn) { mode = { t: 'room', id: roomBtn.dataset.room! }; view = null; renaming = adding = notesOpen = settingsOpen = false; notesDraft = null; notice = ''; draft = ''; stick = true; void refresh(); return; }
    const rm = t.closest<HTMLElement>('[data-remove]');
    if (rm && mode.t === 'room') { const id = mode.id; void act(() => api.update(id, { removeMembers: [rm.dataset.remove] })); return; }
    const pin = t.closest<HTMLElement>('[data-pin]');
    if (pin && mode.t === 'room') {
      const id = mode.id, mid = pin.dataset.pin!;
      const on = !view?.room.messages.find((m) => m.id === mid)?.pinned;
      void act(() => api.pin(id, mid, on));
      return;
    }
    const mention = t.closest<HTMLElement>('[data-mention]');
    if (mention) { draft = `${draft}${draft && !/\s$/.test(draft) ? ' ' : ''}@${mention.dataset.mention} `; focusBox = true; paintMain(); return; }
    const a = t.closest<HTMLElement>('[data-act]')?.dataset.act;
    if (menuOpen && !t.closest('.rm-tools')) { menuOpen = false; paintMain(); }
    if (!a) return;
    if (a !== 'more') menuOpen = false;
    const id = mode.t === 'room' ? mode.id : '';
    switch (a) {
      case 'more': menuOpen = !menuOpen; paintMain(); mainEl.querySelector<HTMLElement>(menuOpen ? '.rm-menu button' : '.rm-tool')?.focus(); break;
      case 'open-captain': {
        const room = view?.room;
        if (!room || !host) break;
        paintMain();
        host.run('open-session', roomSessionKey(room.captain, room.id)).catch((err: Error) => { notice = err.message; paintMain(); });
        break;
      }
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
      case 'end': void act(() => api.end(id)); break;
      case 'resume': void act(() => api.resume(id)); break;
      case 'wrapup': void act(() => api.wrapUp(id)); break;
      case 'notes-toggle': notesOpen = !notesOpen; notesDraft = null; paintMain(); break;
      case 'notes-close': notesOpen = false; notesDraft = null; paintMain(); break;
      case 'notes-save': { const text = notesDraft ?? ''; void act(() => api.update(id, { notes: text }), () => { notesDraft = null; }); break; }
      case 'settings-toggle': settingsOpen = !settingsOpen; paintMain(); break;
      case 'settings-close': settingsOpen = false; paintMain(); break;
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
    } else if (t.matches('[data-setbool]') && mode.t === 'room') {
      const id = mode.id;
      const key = (t as HTMLElement).dataset.setbool!;
      void act(() => api.update(id, { [key]: (t as HTMLInputElement).checked }));
    } else if (t.matches('[data-set]') && mode.t === 'room') {
      const id = mode.id;
      const key = (t as HTMLElement).dataset.set!;
      void act(() => api.update(id, { [key]: t.value }));
    }
  });
  el.addEventListener('input', (e) => {
    const t = e.target as HTMLInputElement;
    if (t.matches('.rm-notes-in')) {
      notesDraft = t.value;
      el.querySelector('[data-notes-count]')!.textContent = `${t.value.length}/4000 · every agent reads these each turn`;
      const save = el.querySelector<HTMLButtonElement>('[data-act=notes-save]');
      if (save) save.disabled = t.value === (view?.room.notes ?? '');
    }
    if (t.matches('.rm-name-in')) { createName = t.value; el.querySelector<HTMLButtonElement>('[data-act=create]')!.disabled = !(picked.size && createName.trim()); }
  });
  el.addEventListener('keydown', (e) => {
    const t = e.target as HTMLElement;
    if (e.key === 'Escape' && menuOpen) { menuOpen = false; paintMain(); mainEl.querySelector<HTMLElement>('.rm-tool')?.focus(); e.stopPropagation(); return; }
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
