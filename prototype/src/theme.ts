// Theme: follows the Control UI's light/dark mode live (no reload).
//  - Embedded in the Control UI tab: the host page (plugin/src/theme-bridge.ts) posts its mode and its CSS variable
//    values ({ type: 'agent-os:theme', mode, vars }); they land on :root as --h-* and drive every token in style.css.
//  - Standalone: prefers-color-scheme.
// Canvas colours can't use CSS variables, so `P` holds the resolved palette for the map and is refreshed on every change.
export type Mode = 'dark' | 'light';
export const THEME_MSG = 'agent-os:theme';
export const THEME_REQ = 'agent-os:theme-request';

/** Host variable -> the --h-* token it feeds. Keep in sync with plugin/src/theme-bridge.ts. */
export const HOST_VARS: Record<string, string> = {
  '--bg': '--h-bg', '--card': '--h-card', '--text': '--h-text', '--text-strong': '--h-text-strong', '--muted': '--h-muted',
  '--border': '--h-border', '--accent': '--h-accent', '--accent-foreground': '--h-accent-fg', '--ok': '--h-ok', '--warn': '--h-warn',
  '--danger': '--h-danger', '--info': '--h-info', '--accent-2': '--h-accent-2', '--font-body': '--h-font', '--mono': '--h-mono',
};

/** Canvas palette, resolved from the CSS tokens (rgb()/rgba()/#hex strings the 2D context understands). */
export const P = {
  mode: 'dark' as Mode,
  blend: 'lighter' as GlobalCompositeOperation,
  starK: 1,
  font: '',
  bg: '', glowA: '', glowB: '', star: '', fg: '', fg2: '', muted: '', halo: '', chipBg: '', chipText: '',
  tipBg: '', tipBorder: '', amber: '', red: '', idle: '', cos: '', hot: '', ring: '', ringHover: '', linkHi: '', miniIdle: '', miniView: '',
  kind: { handoff: '', done: '', blocked: '', needs: '', approval: '', message: '' } as Record<string, string>,
};

let probe: HTMLElement | null = null;
/** Resolve any CSS colour expression (var(), color-mix(), ...) to a string canvas can parse. */
export function resolveColor(expr: string): string {
  probe ??= Object.assign(document.createElement('i'), { ariaHidden: 'true' });
  probe.style.cssText = 'position:absolute;width:0;height:0;visibility:hidden;pointer-events:none;';
  if (!probe.isConnected) document.body.appendChild(probe);
  probe.style.color = '';
  probe.style.color = expr;
  const c = getComputedStyle(probe).color;
  const m = c.match(/^(rgba?|color)\(([^)]*)\)/);
  if (!m) return c;
  const n = m[2].replace('srgb', '').replace('/', ' ').split(/[\s,]+/).filter(Boolean).map(Number);
  const k = m[1] === 'color' ? 255 : 1;
  const [r, g, b] = [n[0] * k, n[1] * k, n[2] * k].map((v) => Math.round(Math.max(0, Math.min(255, v))));
  const a = n.length > 3 ? n[3] : 1;
  return a >= 0.999 ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},${+a.toFixed(3)})`;
}

const listeners = new Set<(m: Mode) => void>();
export const onTheme = (fn: (m: Mode) => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };

const root = () => document.documentElement;
const tok = (name: string) => resolveColor(`var(${name})`);

function refresh() {
  const cs = getComputedStyle(root());
  P.mode = root().dataset.mode === 'light' ? 'light' : 'dark';
  P.blend = (cs.getPropertyValue('--map-blend').trim() || 'lighter') as GlobalCompositeOperation;
  P.font = cs.getPropertyValue('--sans').trim();
  P.starK = parseFloat(cs.getPropertyValue('--star-k')) || 1;
  Object.assign(P, {
    bg: tok('--bg'), glowA: tok('--map-glow-a'), glowB: tok('--map-glow-b'),
    star: tok('--fg'), fg: tok('--fg'), fg2: tok('--fg-2'), muted: tok('--muted'), halo: tok('--map-halo'), chipBg: tok('--map-chip-bg'),
    chipText: tok('--accent-text'), tipBg: tok('--bg-1'), tipBorder: tok('--line-2'), amber: tok('--amber'), red: tok('--red'),
    idle: tok('--idle'), cos: tok('--cos'), hot: tok('--fg'), ring: tok('--map-ring'), ringHover: tok('--map-ring-hover'),
    linkHi: tok('--map-link-hi'), miniIdle: tok('--map-mini-idle'), miniView: tok('--map-mini-view'),
  });
  for (const k of Object.keys(P.kind)) P.kind[k] = tok(`--k-${k}`);
}

function apply(mode: Mode, vars?: Record<string, string>) {
  const el = root();
  if (vars) for (const [host, mine] of Object.entries(HOST_VARS)) {
    const v = vars[host]?.trim();
    if (v) el.style.setProperty(mine, v); else el.style.removeProperty(mine);
  }
  el.dataset.mode = mode;
  refresh();
  for (const fn of listeners) fn(mode);
}

let hosted = false;
export function initTheme() {
  const mq = matchMedia('(prefers-color-scheme: light)');
  apply(mq.matches ? 'light' : 'dark');
  mq.addEventListener('change', () => { if (!hosted) apply(mq.matches ? 'light' : 'dark'); });
  window.addEventListener('message', (e: MessageEvent) => {
    if (e.source !== window.parent || e.data?.type !== THEME_MSG) return;
    hosted = true;
    apply(e.data.mode === 'light' ? 'light' : 'dark', e.data.vars ?? {});
  });
  if (window.parent !== window) window.parent.postMessage({ type: THEME_REQ }, '*');
}
