import type { EventKind } from '../../shared/types';
import type { FleetEvent } from '../contract';
import type { ShellState, Filter } from '../store';

export const KIND_COLOR: Record<EventKind, string> = {
  handoff: '#a78bfa', report: '#60a5fa', approval: '#f5b544', finding: '#34d399',
  message: '#9aa4b2', event: '#f472b6', steer: '#fb923c', check: '#22d3ee',
};

export const STATUS_COLOR = { active: '#34d399', idle: '#5b6472', needs: '#f5b544', error: '#f87171' } as const;

export function esc(s: string) {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

export function fmtK(n: number) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(Math.round(n));
}

export function fmtTime(ts: number) {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function fmtHM(ts: number) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function rgba(hex: string, a: number) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.replace(/./g, (c) => c + c) : h.slice(0, 6), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/** Short display name for an agent id, falling back to a trimmed session key. */
export function nameOf(s: ShellState, id: string) {
  if (id === 'zach') return 'You';
  const a = s.agentsAll.get(id);
  if (a) return a.name;
  const parts = id.split(':');
  return parts[1] ?? id;
}

export function hueOf(s: ShellState, agentId: string) {
  const a = s.agentsAll.get(agentId === 'zach' ? '' : agentId);
  return (a && s.teamsById.get(a.team)?.hue) || '#7a8494';
}

const ERR_RE = /\b(error|fail(ed|ure)?|exception|regression|crash|timeout)\b/i;
export function isError(s: ShellState, e: FleetEvent) {
  return s.agentsAll.get(e.from)?.status === 'error' || ERR_RE.test(e.text);
}

export function matchesFilter(s: ShellState, e: FleetEvent, f: Filter) {
  switch (f) {
    case 'needs': return !!e.needsYou;
    case 'errors': return isError(s, e);
    case 'handoffs': return e.kind === 'handoff';
    case 'approvals': return e.kind === 'approval';
    default: return true;
  }
}

export function matchesQuery(s: ShellState, e: FleetEvent, q: string) {
  if (!q) return true;
  return (
    e.text.toLowerCase().includes(q) ||
    e.kind.includes(q) ||
    nameOf(s, e.from).toLowerCase().includes(q) ||
    nameOf(s, e.to).toLowerCase().includes(q)
  );
}

/** Open "needs you" items: needsYou events whose sender is still waiting (or unknown). */
export function openNeeds(s: ShellState, events: FleetEvent[]) {
  const out: FleetEvent[] = [];
  const seenFrom = new Set<string>();
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (!e.needsYou || seenFrom.has(e.from)) continue;
    const st = s.agentsAll.get(e.from)?.status;
    if (st && st !== 'needs') continue;
    seenFrom.add(e.from);
    out.push(e);
  }
  return out;
}

/** Stable accent for an agent id (rooms: avatar + name colour). */
const AVATAR_HUES = ['#f5a524', '#3ad1f0', '#a35cff', '#34d399', '#ff5c8a', '#3b9cff', '#22d3c5', '#e879f9', '#facc15', '#fb7185'];
export function avatarHue(id: string) {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return AVATAR_HUES[h % AVATAR_HUES.length];
}
/** Round avatar: the agent's emoji if it has one, else its initial. */
export function avatarHtml(id: string, name: string, emoji?: string, cls = '') {
  const label = emoji || (name.trim()[0] ?? '?').toUpperCase();
  return `<span class="avatar ${cls}" style="--hue:${avatarHue(id)}" title="${esc(name)}">${esc(label)}</span>`;
}

export function svg(name: keyof typeof ICONS, size = 16) {
  return `<svg class="ic" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
}

export const ICONS = {
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  warn: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4M12 17h.01"/>',
  eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="M9.9 4.2A10 10 0 0 1 12 4c6.4 0 10 8 10 8a17 17 0 0 1-2.2 3.2M6.6 6.6A17 17 0 0 0 2 12s3.6 8 10 8a9.7 9.7 0 0 0 5.4-1.6"/><path d="m2 2 20 20"/><path d="M14.1 14.1a3 3 0 1 1-4.2-4.2"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
  arrowRight: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  close: '<path d="M18 6 6 18M6 6l12 12"/>',
  play: '<path d="M7 4.5v15l12-7.5-12-7.5Z" fill="currentColor"/>',
  pause: '<path d="M8 5v14M16 5v14"/>',
  expand: '<path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  crown: '<path d="m3 7 4.5 4L12 4l4.5 7L21 7l-2 12H5L3 7Z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  dots: '<circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/>',
  back: '<path d="m15 18-6-6 6-6"/>',
  send: '<path d="M22 2 11 13M22 2l-7 20-4-9-9-4 20-7Z"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8"/>',
  wifiOff: '<path d="M2 8.8a15 15 0 0 1 4.2-2.7M10.7 5.1A15 15 0 0 1 22 8.8M5 12.9a10 10 0 0 1 5.2-2.8M19 12.9a10 10 0 0 0-2-1.5M8.5 16.4a5 5 0 0 1 7 0M12 20h.01M2 2l20 20"/>',
} as const;
