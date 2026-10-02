import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import './style.css';

import type { CreateMap, MapApi } from './contract';
import { createStore, resolveSource } from './store';
import { mountActivity } from './ui/activity';
import { mountCenter, mountPlaceholder } from './ui/center';
import { mountDrawer } from './ui/drawer';
import { mountRail } from './ui/rail';
import { mountRooms } from './ui/rooms';
import { mountTopbar } from './ui/topbar';

// The map renderer lives in src/map/index.ts (owned separately). A glob import keeps the shell
// booting before that module exists; Vite re-evaluates this when the file appears.
const mapModules = import.meta.glob<{ createMap: CreateMap }>('./map/index.ts');

const $ = (id: string) => document.getElementById(id)!;

async function boot() {
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
  const renderRail = mountRail($('rail'), store, (sel) => { center.focus(sel); app.classList.remove('rail-open'); });
  let roomCount = 0;
  const rooms = mountRooms($('rooms'), store, (n) => { roomCount = n; renderTop.setRooms(n, rooms.isOpen()); });
  const renderTop = mountTopbar($('topbar'), store, {
    onNeeds: () => activity.showNeeds(),
    onMenu: () => app.classList.toggle('rail-open'),
    onRooms: () => { rooms.toggle(); renderTop.setRooms(roomCount, rooms.isOpen()); },
  });
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && rooms.isOpen() && !drawer.isOpen()) { rooms.hide(); renderTop.setRooms(roomCount, false); } });

  store.subscribe(() => {
    const s = store.get();
    app.classList.toggle('loading', !s.loaded);
    renderTop(s);
    renderRail(s);
    center.update(s);
    activity.update(s);
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
  void rooms.prime();
  // Paint loading/skeleton state immediately.
  store.setQuery('');
  renderTop(store.get()); renderRail(store.get()); center.update(store.get()); activity.update(store.get());

  if (import.meta.hot) import.meta.hot.dispose(() => { store.close(); map.destroy(); });
}

boot();
