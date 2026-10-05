// Docs: a read-only Markdown viewer for the workspace (.md / .markdown). The data server lists and reads (GET /api/docs, /api/docs/file); this view renders with the
// same sanitising renderer as the rooms (shared/markdown.ts). Rendered is the default; the toggle at the top right switches to the raw text.
import { baseName, fmtBytes, groupDocs, type DocEntry } from '../../shared/docs';
import { installMarkdownHandlers, renderMarkdown } from '../../shared/markdown';
import type { ShellStore } from '../store';
import { esc, svg } from './format';

type Mode = 'rendered' | 'raw';
interface Opened { path: string; size: number; mtime: number; text: string }

export function mountDocs(el: HTMLElement, store: ShellStore) {
  let open = false;
  let files: DocEntry[] = [];
  let truncated = false;
  let listError = '';
  let loaded = false;
  let query = '';
  let mode: Mode = 'rendered';
  let doc: Opened | null = null;
  let docError = '';
  let loading = '';
  let seq = 0;

  // The custom header is the same guard the writes use: a cross-origin page cannot send it without a preflight (and the data server has no CORS).
  const get = async <T>(rel: string): Promise<T> => {
    const r = await fetch(new URL(`api/${rel}`, document.baseURI).toString(), { headers: { 'x-agent-os-send': '1' } });
    const j = await r.json().catch(() => ({})) as T & { error?: string };
    if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
    return j;
  };

  el.innerHTML = `<div class="dc-wrap">
    <aside class="dc-list" aria-label="Markdown files">
      <header class="dc-lhead"><h2>Docs</h2><button class="dc-icon" data-act="reload-list" title="Reload the file list" aria-label="Reload the file list">${svg('refresh', 14)}</button></header>
      <label class="dc-search">${svg('search', 14)}<input type="search" placeholder="Filter files…" spellcheck="false" autocomplete="off" aria-label="Filter files" /></label>
      <div class="dc-files" role="list"></div>
    </aside>
    <section class="dc-main"></section></div>`;
  const filesEl = el.querySelector<HTMLElement>('.dc-files')!;
  const mainEl = el.querySelector<HTMLElement>('.dc-main')!;
  const input = el.querySelector<HTMLInputElement>('.dc-search input')!;
  installMarkdownHandlers(mainEl);

  function paintList() {
    const groups = groupDocs(files, query);
    filesEl.innerHTML = listError ? `<div class="dc-note err" role="status">${esc(listError)}</div>`
      : !loaded ? '<div class="dc-note">Loading…</div>'
      : !groups.length ? `<div class="dc-note">${files.length ? 'No file matches.' : 'No Markdown files here.'}</div>`
      : groups.map((g) => `<div class="dc-group" role="group" aria-label="${esc(g.dir || 'workspace root')}"><h3>${g.dir ? esc(g.dir) : 'workspace'}<b>${g.files.length}</b></h3>${g.files.map((f) =>
        `<button class="dc-file${doc?.path === f.path || loading === f.path ? ' on' : ''}" role="listitem" data-path="${esc(f.path)}" title="${esc(f.path)}"><span>${esc(baseName(f.path))}</span><small>${esc(ago(f.mtime))}</small></button>`).join('')}</div>`).join('')
        + (truncated ? '<div class="dc-note">The list is cut off at 3000 files.</div>' : '');
  }

  function paintDoc() {
    if (docError) { mainEl.innerHTML = `<div class="dc-empty err" role="status"><b>Could not open that file</b><span>${esc(docError)}</span></div>`; return; }
    if (!doc) { mainEl.innerHTML = `<div class="dc-empty"><b>${loading ? 'Opening…' : 'Pick a document'}</b><span>${loading ? esc(loading) : 'Markdown files in the workspace open here, rendered. Use the toggle to see the raw text.'}</span></div>`; return; }
    const d = doc;
    mainEl.innerHTML = `<header class="dc-bar">
        <div class="dc-title"><h2 title="${esc(d.path)}">${esc(baseName(d.path))}</h2><span class="muted" title="${esc(d.path)}">${esc(d.path)} · ${fmtBytes(d.size)} · ${esc(ago(d.mtime))}</span></div>
        <span class="grow"></span>
        <button class="dc-icon" data-act="reload-doc" title="Reload this file" aria-label="Reload this file">${svg('refresh', 14)}</button>
        <div class="dc-toggle" role="group" aria-label="View">
          <button data-mode="rendered" aria-pressed="${mode === 'rendered'}">Rendered</button><button data-mode="raw" aria-pressed="${mode === 'raw'}">Raw</button>
        </div></header>
      <div class="dc-scroll">${mode === 'rendered' ? `<article class="md dc-md" data-view="rendered">${renderMarkdown(d.text)}</article>` : `<pre class="dc-raw" data-view="raw"><code>${esc(d.text)}</code></pre>`}</div>`;
  }

  async function loadList() {
    const mine = ++seq;
    try {
      const r = await get<{ files: DocEntry[]; truncated: boolean }>('docs');
      if (mine !== seq) return;
      files = r.files; truncated = r.truncated; listError = ''; loaded = true;
    } catch (e) {
      if (mine !== seq) return;
      listError = `Could not list the docs (${(e as Error).message}).`;
    }
    paintList();
  }

  async function openFile(path: string) {
    loading = path; docError = '';
    paintList(); if (!doc) paintDoc();
    try {
      const d = await get<Opened>(`docs/file?path=${encodeURIComponent(path)}`);
      if (loading !== path) return; // a newer click won
      doc = d; docError = '';
    } catch (e) {
      if (loading !== path) return;
      doc = null; docError = `${path}: ${(e as Error).message}`;
    }
    loading = '';
    paintList(); paintDoc();
    mainEl.querySelector('.dc-scroll')?.scrollTo?.(0, 0);
  }

  filesEl.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-path]');
    if (b) void openFile(b.dataset.path!);
  });
  input.addEventListener('input', () => { query = input.value; paintList(); });
  el.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    const m = t.closest<HTMLElement>('[data-mode]');
    if (m) { mode = m.dataset.mode === 'raw' ? 'raw' : 'rendered'; paintDoc(); return; }
    const act = t.closest<HTMLElement>('[data-act]')?.dataset.act;
    if (act === 'reload-list') void loadList();
    if (act === 'reload-doc' && doc) void openFile(doc.path);
  });

  return {
    show() { open = true; el.hidden = false; paintList(); paintDoc(); void loadList(); },
    hide() { open = false; el.hidden = true; seq++; },
    toggle() { if (open) this.hide(); else this.show(); },
    isOpen: () => open,
    /** Deep link / programmatic open: `path` is relative to the workspace root. */
    openFile,
  };
}

function ago(ts: number) {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 90) return 'just now';
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 129600) return `${Math.round(s / 3600)}h ago`;
  if (s < 86400 * 45) return `${Math.round(s / 86400)}d ago`;
  return new Date(ts).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}
