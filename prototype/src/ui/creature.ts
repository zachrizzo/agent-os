// Animated creature avatars. The SVGs (make-creatures.py, inlined by tools/gen-creatures.mjs) carry their own CSS animation, so each one is used as a CSS background image
// (an isolated SVG image: its styles cannot leak into the page, and prefers-reduced-motion inside the SVG still applies). One rule per (creature, state) is added to a
// <style> element the first time it is used, so the markup of a message or a chip stays a short <span>.
import type { AgentStatus } from '../../shared/types';
import { CREATURES, CREATURE_STYLE } from './creatures.gen';

export type CreatureState = AgentStatus;
export const CREATURE_STATES: readonly CreatureState[] = ['active', 'idle', 'needs', 'error'];

/** Creature key for an agent id, a session key (`agent:<id>:...`), or Zach (`you` / `zach`). '' when that agent has no creature. */
export function creatureKey(id: string | undefined): string {
  let k = (id ?? '').trim();
  if (k === 'you') k = 'zach';
  const m = /^agent:([^:]+)(?::|$)/.exec(k);
  if (m) k = m[1];
  return Object.prototype.hasOwnProperty.call(CREATURES, k) ? k : '';
}

/** The creature for an agent, falling back to its parent's (subagents, cron jobs): the first of `agentId`, the session id, then each parent up the chain that has one. */
export function creatureKeyFor(agent: { id: string; agentId?: string; parent?: string } | undefined, lookup: (id: string) => { id: string; agentId?: string; parent?: string } | undefined): string {
  const seen = new Set<string>();
  for (let a = agent; a && !seen.has(a.id); a = a.parent ? lookup(a.parent) : undefined) {
    seen.add(a.id);
    const k = creatureKey(a.agentId) || creatureKey(a.id);
    if (k) return k;
  }
  return '';
}

/** The SVG text for one creature in one state: the state is a class on the root, nothing else changes. */
export function creatureSvg(key: string, state?: CreatureState): string {
  const c = CREATURES[key];
  if (!c) return '';
  const open = state ? c[0].replace(/ class="([^"]*)"/, ` class="$1 st-${state}"`) : c[0];
  return `${open}<style>${CREATURE_STYLE}</style>${c[1]}</svg>`;
}

const registered = new Set<string>();
let sheet: HTMLStyleElement | null = null;
const cls = (key: string, state?: CreatureState) => `cr-${key}${state ? `-${state}` : ''}`;
/** Make sure the CSS class for this creature+state exists; returns its name. */
export function creatureClass(key: string, state?: CreatureState): string {
  const name = cls(key, state);
  if (registered.has(name)) return name;
  registered.add(name);
  if (typeof document === 'undefined') return name;
  if (!sheet || !sheet.isConnected) {
    sheet = document.createElement('style');
    sheet.id = 'creature-css';
    document.head.appendChild(sheet);
  }
  sheet.appendChild(document.createTextNode(`.avatar.${name}{background-image:url("data:image/svg+xml;charset=utf-8,${encodeURIComponent(creatureSvg(key, state))}")}\n`));
  return name;
}
