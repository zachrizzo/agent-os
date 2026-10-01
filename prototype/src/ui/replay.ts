// Bottom strip: stacked-by-team event density (streamgraph) for the last 60 minutes.
// Clicking the canvas pauses at that moment (stub scrub: freezes the activity stream).
import type { ShellState, ShellStore } from '../store';
import { BUCKET_MS } from '../store';
import { esc, fmtHM, rgba, svg } from './format';

const SPAN = 60 * 60_000;
const PAD_L = 8, PAD_R = 46, PAD_T = 22, PAD_B = 26;

export function mountReplay(el: HTMLElement, store: ShellStore) {
  el.innerHTML = `
    <div class="rp-left">
      <div class="rp-title"><b>Replay</b><button class="rp-play" title="Pause / play">${svg('pause', 14)}</button><span class="rp-range">Last 60 min</span></div>
      <div class="rp-sub">By team · event density</div>
      <div class="rp-legend"></div>
    </div>
    <div class="rp-canvas"><canvas></canvas><div class="rp-tip" hidden></div></div>
    <div class="rp-right"><button class="rp-live on">Live</button></div>`;
  const wrap = el.querySelector<HTMLElement>('.rp-canvas')!;
  const canvas = el.querySelector('canvas')!;
  const ctx = canvas.getContext('2d')!;
  const legend = el.querySelector<HTMLElement>('.rp-legend')!;
  const play = el.querySelector<HTMLButtonElement>('.rp-play')!;
  const live = el.querySelector<HTMLButtonElement>('.rp-live')!;
  const tip = el.querySelector<HTMLElement>('.rp-tip')!;
  let w = 0, h = 0, dpr = 1;
  let legendKey = '';
  let queued = false;
  let lastDraw = 0;

  const ro = new ResizeObserver(() => {
    dpr = Math.min(2, devicePixelRatio || 1);
    w = wrap.clientWidth; h = wrap.clientHeight;
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    draw();
  });
  ro.observe(wrap);

  const xToTs = (x: number) => Date.now() - SPAN + ((x - PAD_L) / (w - PAD_L - PAD_R)) * SPAN;
  const tsToX = (ts: number, now: number) => PAD_L + ((ts - (now - SPAN)) / SPAN) * (w - PAD_L - PAD_R);

  play.addEventListener('click', () => store.setPaused(!store.get().paused));
  live.addEventListener('click', () => store.setPaused(false));
  canvas.addEventListener('click', (e) => {
    const r = canvas.getBoundingClientRect();
    const ts = Math.min(Date.now(), xToTs(e.clientX - r.left));
    store.setPaused(true, ts);
  });
  canvas.addEventListener('mousemove', (e) => {
    const r = canvas.getBoundingClientRect();
    const x = e.clientX - r.left;
    const ts = xToTs(x);
    if (ts > Date.now() || x < PAD_L) { tip.hidden = true; return; }
    const b = store.density().get(Math.floor(ts / BUCKET_MS) * BUCKET_MS);
    let n = 0; if (b) for (const v of b.values()) n += v;
    tip.hidden = false;
    tip.style.left = `${x}px`;
    tip.textContent = `${fmtHM(ts)} · ${n} events`;
  });
  canvas.addEventListener('mouseleave', () => { tip.hidden = true; });
  setInterval(() => draw(), 1000);

  function draw() {
    lastDraw = performance.now();
    const s = store.get();
    if (!w || !h) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const now = Date.now();
    const teams = s.snapshot.teams;
    const buckets = store.density();
    const n = SPAN / BUCKET_MS;
    const start = Math.floor((now - SPAN) / BUCKET_MS) * BUCKET_MS;
    const cw = w - PAD_L - PAD_R;
    const mid = PAD_T + (h - PAD_T - PAD_B) / 2;

    // Grid + time ticks every 15 min.
    ctx.font = '500 10.5px Inter, system-ui, sans-serif';
    ctx.textAlign = 'center';
    const step = 15 * 60_000;
    for (let t = Math.ceil((now - SPAN) / step) * step; t <= now - 3 * 60_000; t += step) {
      const x = tsToX(t, now);
      ctx.fillStyle = 'rgba(148,160,180,.55)';
      ctx.fillText(fmtHM(t), x, 13);
      ctx.fillStyle = 'rgba(148,160,180,.08)';
      ctx.fillRect(Math.round(x), PAD_T, 1, h - PAD_T - PAD_B);
    }
    // Baseline.
    ctx.fillStyle = 'rgba(148,160,180,.10)';
    ctx.fillRect(PAD_L, Math.round(mid), cw, 1);

    // Per-team series (lightly smoothed), partial last bucket extrapolated.
    const series = teams.map((t) => {
      const v: number[] = [];
      for (let i = 0; i <= n; i++) {
        const k = start + i * BUCKET_MS;
        let c = buckets.get(k)?.get(t.id) ?? 0;
        if (k + BUCKET_MS > now) c = c / Math.max(0.25, (now - k) / BUCKET_MS);
        v.push(c);
      }
      return v.map((_, i) => (v[Math.max(0, i - 1)] + 2 * v[i] + v[Math.min(v.length - 1, i + 1)]) / 4);
    });
    const totals = series[0]?.map((_, i) => series.reduce((a, sr) => a + sr[i], 0)) ?? [];
    const max = Math.max(4, ...totals);
    const scale = (h - PAD_T - PAD_B) / max * 0.92;
    const xs = totals.map((_, i) => tsToX(start + i * BUCKET_MS + BUCKET_MS / 2, now));
    const visibleTeams = teams.map((t, i) => ({ t, i })).filter(({ t }) => !s.hiddenTeams.has(t.id));

    let lower = totals.map((tot) => mid - (tot * scale) / 2);
    for (const { t, i } of visibleTeams) {
      const upper = lower.map((y, j) => y + series[i][j] * scale);
      ctx.beginPath();
      curve(xs, lower, false);
      curve(xs, upper, true);
      ctx.closePath();
      const g = ctx.createLinearGradient(0, PAD_T, 0, h - PAD_B);
      g.addColorStop(0, rgba(t.hue, 0.55));
      g.addColorStop(0.5, rgba(t.hue, 0.9));
      g.addColorStop(1, rgba(t.hue, 0.55));
      ctx.fillStyle = g;
      ctx.shadowColor = rgba(t.hue, 0.6);
      ctx.shadowBlur = 8;
      ctx.fill();
      ctx.shadowBlur = 0;
      lower = upper;
    }
    // Fade the oldest edge.
    const fade = ctx.createLinearGradient(PAD_L, 0, PAD_L + 60, 0);
    fade.addColorStop(0, 'rgba(12,14,18,1)'); fade.addColorStop(1, 'rgba(12,14,18,0)');
    ctx.fillStyle = fade; ctx.fillRect(PAD_L, PAD_T - 2, 60, h - PAD_T - PAD_B + 4);

    // Needs-you markers.
    ctx.fillStyle = '#f5b544';
    for (const e of store.events()) {
      if (!e.needsYou || e.ts < now - SPAN) continue;
      const x = tsToX(e.ts, now), y = h - 13;
      ctx.beginPath(); ctx.moveTo(x, y - 4); ctx.lineTo(x + 4, y); ctx.lineTo(x, y + 4); ctx.lineTo(x - 4, y); ctx.closePath(); ctx.fill();
    }

    // Playhead: "now" when live, scrub position when paused.
    const px = s.paused && s.scrubTs ? tsToX(s.scrubTs, now) : tsToX(now, now);
    if (s.paused) {
      ctx.fillStyle = 'rgba(11,13,16,.62)';
      ctx.fillRect(px, PAD_T - 4, w - PAD_R - px + 4, h - PAD_T - PAD_B + 8);
    }
    const col = s.paused ? '#f5b544' : '#7cc4ff';
    const lg = ctx.createLinearGradient(0, PAD_T, 0, h - PAD_B);
    lg.addColorStop(0, rgba(col, 1)); lg.addColorStop(1, rgba(col, 0.15));
    ctx.fillStyle = lg;
    ctx.shadowColor = col; ctx.shadowBlur = 10;
    ctx.fillRect(Math.round(px) - 1, PAD_T, 2, h - PAD_T - PAD_B);
    ctx.beginPath(); ctx.arc(px, PAD_T, 3.5, 0, Math.PI * 2); ctx.fillStyle = col; ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle = s.paused ? '#f5b544' : '#e6ebf2';
    ctx.font = '600 10.5px Inter, system-ui, sans-serif';
    ctx.fillText(s.paused && s.scrubTs ? fmtHM(s.scrubTs) : 'Now', Math.min(px, w - 22), 13);

    if (!s.loaded) {
      ctx.fillStyle = 'rgba(148,160,180,.5)'; ctx.font = '500 12px Inter, system-ui, sans-serif';
      ctx.fillText('Waiting for events…', w / 2, mid + 4);
    }
  }

  function curve(xs: number[], ys: number[], reverse: boolean) {
    const idx = xs.map((_, i) => i);
    if (reverse) idx.reverse();
    idx.forEach((i, k) => {
      if (k === 0) { reverse ? ctx.lineTo(xs[i], ys[i]) : ctx.moveTo(xs[i], ys[i]); return; }
      const p = idx[k - 1];
      const cx = (xs[p] + xs[i]) / 2;
      ctx.bezierCurveTo(cx, ys[p], cx, ys[i], xs[i], ys[i]);
    });
  }

  return (s: ShellState) => {
    play.innerHTML = svg(s.paused ? 'play' : 'pause', 14);
    play.classList.toggle('paused', s.paused);
    live.classList.toggle('on', !s.paused);
    live.textContent = s.paused ? 'Go live' : 'Live';
    const key = s.snapshot.teams.map((t) => `${t.id}${s.hiddenTeams.has(t.id) ? '-' : ''}`).join();
    if (key !== legendKey) {
      legendKey = key;
      legend.innerHTML = s.snapshot.teams.map((t) => `<span class="${s.hiddenTeams.has(t.id) ? 'off' : ''}" style="--hue:${t.hue}"><i></i>${esc(t.name)}</span>`).join('');
    }
    if (!queued && performance.now() - lastDraw > 250) {
      queued = true;
      requestAnimationFrame(() => { queued = false; draw(); });
    }
  };
}
