import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import './style.css';

import type { CreateMap, MapApi } from './contract';
import { createHostBridge } from './hostbridge';
import { createStore, resolveSource } from './store';
import { mountBoard } from './ui/board';
import { mountActivity } from './ui/activity';
import { mountCenter, mountPlaceholder } from './ui/center';
import { mountDocs } from './ui/docs';
import { mountDrawer } from './ui/drawer';
import { mountRail } from './ui/rail';
import { mountSessions } from './ui/sessions';
import { mountRooms } from './ui/rooms';
import { mountTopbar } from './ui/topbar';
import { mountWork } from './ui/work';
import type { View } from './store';
import { fileParam } from '../shared/docs';
import { initTheme } from './theme';

// The map renderer lives in src/map/index.ts (owned separately). A glob import keeps the shell
// booting before that module exists; Vite re-evaluates this when the file appears.
const mapModules = import.meta.glob<{ createMap: CreateMap }>('./map/index.ts');

const $ = (id: string) => document.getElementById(id)!;

async function boot() {
  initTheme();
  const app = $('app');
  const source = await resolveSource();
  const store = createStore(source);
  document.documentElement.dataset.source = source;

  const drawer = mountDrawer($('drawer'), store);
  const center = mountCenter($('center'), store, {
    onFocusMode: () => { app.classList.toggle('focus'); setTimeout(() => center.resize(), 260); },
    onOpenSession: (key) => drawer.openSession(key, true),
  });
  const activity = mountActivity($('activity'), store, (e) => drawer.open(e));
  const sessionsEl = $('sessions');
  const sessions = mountSessions(sessionsEl, store, { onOpenSession: (key) => drawer.openSession(key), activeKey: () => null });
  const applySide = () => {
    const sessionsTab = store.get().sideTab === 'sessions';
    $('activity').hidden = sessionsTab;
    sessionsEl.hidden = !sessionsTab;
    sessions.update();
  };
  for (const panel of [$('activity'), sessionsEl]) panel.addEventListener('click', (e) => {
    const t = (e.target as HTMLElement).closest<HTMLElement>('[data-side-tab]');
    if (t) store.setSideTab(t.dataset.sideTab as 'activity' | 'sessions');
  });
  const workEl = $('work');
  const work = mountWork(workEl, store, { onOpenSession: (key) => drawer.openSession(key) });
  const closeOverlays = () => { rooms.hide(); board.hide(); docs.hide(); renderTop.setRooms(roomCount, false); renderTop.setBoard(false); renderTop.setDocs(false); };
  const showView = (v: View) => {
    closeOverlays();
    store.setView(v);
    applyView();
  };
  const applyView = () => {
    const v = store.get().view;
    app.dataset.view = v;
    workEl.hidden = v !== 'work';
    if (v === 'work') work.paintNow(); else requestAnimationFrame(() => center.resize());
  };
  const renderRail = mountRail($('rail'), store, (sel) => { if (store.get().view !== 'fleet') { store.setView('fleet'); applyView(); } center.focus(sel); app.classList.remove('rail-open'); });
  let roomCount = 0;
  const rooms = mountRooms($('rooms'), store, (n) => { roomCount = n; renderTop.setRooms(n, rooms.isOpen()); }, createHostBridge());
  const board = mountBoard($('board'), store);
  const docs = mountDocs($('docs'), store);
  const renderTop = mountTopbar($('topbar'), store, {
    onNeeds: () => activity.showNeeds(),
    onMenu: () => app.classList.toggle('rail-open'),
    onRooms: () => { board.hide(); renderTop.setBoard(false); docs.hide(); renderTop.setDocs(false); rooms.toggle(); renderTop.setRooms(roomCount, rooms.isOpen()); },
    onBoard: () => { rooms.hide(); renderTop.setRooms(roomCount, false); docs.hide(); renderTop.setDocs(false); board.toggle(); renderTop.setBoard(board.isOpen()); },
    onDocs: () => { rooms.hide(); renderTop.setRooms(roomCount, false); board.hide(); renderTop.setBoard(false); docs.toggle(); renderTop.setDocs(docs.isOpen()); },
    onView: showView,
  });
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || drawer.isOpen()) return;
    if (rooms.isOpen()) { rooms.hide(); renderTop.setRooms(roomCount, false); }
    else if (board.isOpen()) { board.hide(); renderTop.setBoard(false); }
    else if (docs.isOpen()) { docs.hide(); renderTop.setDocs(false); }
  });

  store.subscribe(() => {
    const s = store.get();
    app.classList.toggle('loading', !s.loaded);
    renderTop(s);
    renderRail(s);
    center.update(s);
    activity.update(s);
    work.update();
    applySide();
  });

  let map: MapApi;
  const load = mapModules['./map/index.ts'];
  if (load) {
    try {
      const { createMap } = await load();
      map = createMap(center.host, store);
      center.setMap(map);
    } catch (e) {
      console.error('[agent-os] map failed to load; using placeholder', e);
      map = mountPlaceholder(center.host, store);
      center.setMap(null);
    }
  } else {
    map = mountPlaceholder(center.host, store);
    center.setMap(null);
  }
  new ResizeObserver(() => map.resize()).observe(center.host);

  store.connect();
  applyView();
  void rooms.prime();
  // Deep link: ?file=reports/x.md opens straight into Docs.
  const deepFile = fileParam(location.search);
  if (deepFile) { rooms.hide(); board.hide(); renderTop.setRooms(roomCount, false); renderTop.setBoard(false); docs.show(); renderTop.setDocs(true); void docs.openFile(deepFile); }
  // Paint loading/skeleton state immediately.
  store.setQuery('');
  renderTop(store.get()); renderRail(store.get()); center.update(store.get()); activity.update(store.get());

  if (import.meta.hot) import.meta.hot.dispose(() => { store.close(); map.destroy(); });
}

boot();
