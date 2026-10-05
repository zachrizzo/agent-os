// Dev page (vite: /creatures.html): every creature in every state, using the same avatarHtml as the app. Used for the screenshots in prototype/screens/.
import './style.css';
import { CREATURES } from './ui/creatures.gen';
import { CREATURE_STATES } from './ui/creature';
import { avatarHtml, esc } from './ui/format';

const states = [undefined, ...CREATURE_STATES] as const;
const ids = Object.keys(CREATURES);
const only = new URLSearchParams(location.search).get('ids')?.split(',');
const list = only?.length ? only : ids;
document.getElementById('app')!.innerHTML = `
<style>
  body.creatures-dev { padding: 18px; background: var(--bg-1, #fff); color: var(--fg, #222); font: 12px/1.3 Inter, system-ui, sans-serif; }
  .cd-grid { display: grid; grid-template-columns: 150px repeat(${states.length}, 92px) 70px; gap: 6px 10px; align-items: center; }
  .cd-grid > b { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted, #888); }
  .cd-grid .avatar { width: 64px; height: 64px; }
  .cd-grid .avatar.sm { width: 22px; height: 22px; }
  .cd-name { font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 11px; }
</style>
<div class="cd-grid">
  <b>agent</b>${states.map((s) => `<b>${s ?? 'default'}</b>`).join('')}<b>small</b>
  ${list.map((id) => `<span class="cd-name">${esc(id)}</span>${states.map((s) => avatarHtml(id, id, undefined, '', { status: s })).join('')}${avatarHtml(id, id, undefined, 'sm')}`).join('')}
  <span class="cd-name">no creature</span>${states.map(() => avatarHtml('mystery', 'mystery', undefined, '', { hue: '#6a63e6' })).join('')}${avatarHtml('mystery', 'mystery', undefined, 'sm', { hue: '#6a63e6' })}
</div>`;
