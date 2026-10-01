// Colour + sprite helpers for the canvas map. Everything is cached so the frame loop allocates little.
import type { EventKind } from '../../shared/types';

export const KIND_COLOR: Record<EventKind, string> = {
  handoff: '#b18cff', report: '#5aa9ff', approval: '#f5c542', finding: '#34d399',
  message: '#dbe4f3', event: '#ff6fa8', steer: '#ff9a4d', check: '#2fd8f0',
};
export const AMBER = '#f5a524';
export const ERROR = '#ff5c5c';
export const IDLE = '#7d8799';
export const COS_COLOR = '#ffe7a8';
export const FONT = 'Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';

const rgbCache = new Map<string, [number, number, number]>();
let probe: CanvasRenderingContext2D | null = null;

export function rgbOf(c: string): [number, number, number] {
  let v = rgbCache.get(c);
  if (v) return v;
  probe ??= document.createElement('canvas').getContext('2d')!;
  probe.fillStyle = '#000';
  probe.fillStyle = c;
  const s = String(probe.fillStyle);
  if (s.startsWith('#')) v = [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];
  else { const m = s.match(/[\d.]+/g) ?? ['128', '128', '128']; v = [+m[0], +m[1], +m[2]]; }
  rgbCache.set(c, v);
  return v;
}

const rgbaCache = new Map<string, string>();
export function rgba(c: string, a: number): string {
  const q = Math.max(0, Math.min(100, Math.round(a * 100)));
  const key = c + '|' + q;
  let s = rgbaCache.get(key);
  if (!s) {
    const [r, g, b] = rgbOf(c);
    s = `rgba(${r},${g},${b},${q / 100})`;
    rgbaCache.set(key, s);
  }
  return s;
}

/** Blend colour c toward d by t (0..1). */
export function mix(c: string, d: string, t: number): string {
  const a = rgbOf(c), b = rgbOf(d);
  const h = (i: number) => Math.round(a[i] + (b[i] - a[i]) * t).toString(16).padStart(2, '0');
  return `#${h(0)}${h(1)}${h(2)}`;
}

const sprites = new Map<string, HTMLCanvasElement>();
export const SPRITE = 64;
/** Soft radial glow sprite, white-hot core fading to the colour then transparent. */
export function glow(c: string, hot = 0.0): HTMLCanvasElement {
  const key = c + '|' + hot;
  let cv = sprites.get(key);
  if (cv) return cv;
  cv = document.createElement('canvas');
  cv.width = cv.height = SPRITE;
  const g = cv.getContext('2d')!;
  const h = SPRITE / 2;
  const gr = g.createRadialGradient(h, h, 0, h, h, h);
  const core = hot > 0 ? mix(c, '#ffffff', hot) : c;
  gr.addColorStop(0, rgba(core, 0.85));
  gr.addColorStop(0.12, rgba(c, 0.55));
  gr.addColorStop(0.35, rgba(c, 0.16));
  gr.addColorStop(0.7, rgba(c, 0.04));
  gr.addColorStop(1, rgba(c, 0));
  g.fillStyle = gr;
  g.fillRect(0, 0, SPRITE, SPRITE);
  sprites.set(key, cv);
  return cv;
}

/** Repeating star-field tile (device pixels). Seeded so it never flickers between reloads. */
export function starTile(dpr: number): HTMLCanvasElement {
  const css = 480;
  const cv = document.createElement('canvas');
  cv.width = cv.height = Math.round(css * dpr);
  const g = cv.getContext('2d')!;
  g.scale(dpr, dpr);
  let s = 7;
  const r = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let i = 0; i < 150; i++) {
    const x = r() * css, y = r() * css, z = r();
    const big = z > 0.94;
    g.fillStyle = r() < 0.25 ? `rgba(150,180,255,${0.12 + z * 0.35})` : `rgba(220,228,245,${0.08 + z * 0.32})`;
    g.beginPath();
    g.arc(x, y, big ? 1.1 : 0.45 + z * 0.45, 0, Math.PI * 2);
    g.fill();
  }
  return cv;
}

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
