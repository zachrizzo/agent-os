// Safe Markdown for agent text: marked (parse) -> DOMPurify (allow-list sanitize) -> DOM post-pass (links, @mentions, path:line, code-copy wrapper).
// Raw HTML in the source is never passed through: marked's html tokens are escaped to text before sanitizing, and DOMPurify then
// drops anything outside the allow-list (script/style/iframe/forms, on* handlers, javascript:/data:/vbscript: URLs).
import DOMPurify from 'dompurify';
import { Marked } from 'marked';

type Purifier = ReturnType<typeof DOMPurify>;

const BLOCK_TAGS = ['p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote', 'pre', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'input'];
const INLINE_TAGS = ['strong', 'b', 'em', 'i', 'del', 's', 'code', 'a', 'span'];
const ATTRS = ['href', 'title', 'class', 'align', 'start', 'type', 'checked', 'disabled'];
/** Only web links and mail: everything else (javascript:, data:, vbscript:, file:, relative script tricks) is dropped by DOMPurify. */
const URI_RE = /^(?:https?:|mailto:|#|\/(?!\/))/i;

const md = new Marked({ gfm: true, breaks: true, async: false });
md.use({
  renderer: {
    // No raw HTML pass-through: show it as literal text.
    html({ text }) { return escapeHtml(text); },
    // Images could beacon to arbitrary hosts and are not wanted in agent chat: keep the alt text as a plain link-less label.
    image({ text }) { return escapeHtml(text || ''); },
  },
});

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

let purify: Purifier | null = null;
/** Browser: the global window. Node (unit tests): call `setDomWindow(new JSDOM().window)` first. */
export function setDomWindow(win: unknown) {
  purify = installHooks(DOMPurify(win as never));
}
function getPurify(): Purifier {
  if (!purify) {
    if (typeof window === 'undefined') throw new Error('markdown: no DOM; call setDomWindow() first');
    purify = installHooks(DOMPurify(window));
  }
  return purify;
}
function installHooks(p: Purifier) {
  p.addHook('afterSanitizeAttributes', (node: Element) => {
    if (node.tagName === 'A') {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    }
    if (node.tagName === 'INPUT') { node.setAttribute('disabled', ''); node.setAttribute('type', 'checkbox'); } // task-list boxes only
  });
  return p;
}

export interface MdOptions {
  /** Member ids that become `@id` chips (case-insensitive). */
  mentions?: readonly string[];
}

const MENTION_RE = /(^|[^\w@])@([A-Za-z0-9][\w-]*)/g;
const PATH_RE = /(^|[\s(])((?:\.{0,2}\/)?(?:[\w.@-]+\/)+[\w.@-]+\.[A-Za-z0-9]{1,8}(?::\d+(?::\d+)?)?)(?=$|[\s),.;:!?])/g;

const PATH_ONLY_RE = /^(?:\.{0,2}\/)?(?:[\w.@-]+\/)+[\w.@-]+\.[A-Za-z0-9]{1,8}(?::\d+(?::\d+)?)?$|^[\w.@-]+\.[A-Za-z0-9]{1,8}:\d+(?::\d+)?$/;

/** Text nodes outside links/code get @mention chips and path:line spans. */
function decorate(root: ParentNode, doc: Document, opts: MdOptions) {
  const members = new Set((opts.mentions ?? []).map((m) => m.toLowerCase()));
  const walker = doc.createTreeWalker(root as Node, 4 /* SHOW_TEXT */);
  const texts: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!(n.parentElement?.closest('a, code, pre, .rm-at'))) texts.push(n as Text);
  }
  // Inline `path/to/file.ts:42` (agents usually backtick paths): the code span itself becomes the copyable path.
  for (const c of Array.from((root as Element).querySelectorAll('code'))) {
    if (c.closest('pre, a')) continue;
    const txt = c.textContent ?? '';
    if (PATH_ONLY_RE.test(txt)) { c.classList.add('md-path'); c.setAttribute('data-copy', txt); c.setAttribute('title', 'Click to copy'); c.setAttribute('role', 'button'); c.setAttribute('tabindex', '0'); }
  }
  for (const t of texts) {
    const src = t.data;
    if (!src.includes('@') && !src.includes('/')) continue;
    const parts: Array<{ at?: string; path?: string; text: string }> = [];
    const marks: Array<{ idx: number; len: number; kind: 'at' | 'path'; text: string; pre: string }> = [];
    for (const m of src.matchAll(MENTION_RE)) {
      if (members.has(m[2].toLowerCase())) marks.push({ idx: m.index! + m[1].length, len: m[2].length + 1, kind: 'at', text: `@${m[2]}`, pre: m[1] });
    }
    for (const m of src.matchAll(PATH_RE)) {
      marks.push({ idx: m.index! + m[1].length, len: m[2].length, kind: 'path', text: m[2], pre: m[1] });
    }
    if (!marks.length) continue;
    marks.sort((a, b) => a.idx - b.idx);
    let pos = 0;
    for (const m of marks) {
      if (m.idx < pos) continue;
      if (m.idx > pos) parts.push({ text: src.slice(pos, m.idx) });
      parts.push(m.kind === 'at' ? { at: m.text, text: m.text } : { path: m.text, text: m.text });
      pos = m.idx + m.len;
    }
    if (pos < src.length) parts.push({ text: src.slice(pos) });
    const frag = doc.createDocumentFragment();
    for (const p of parts) {
      if (p.at || p.path) {
        const span = doc.createElement('span');
        span.className = p.at ? 'rm-at' : 'md-path';
        if (p.path) { span.setAttribute('data-copy', p.path); span.setAttribute('title', 'Click to copy'); span.setAttribute('role', 'button'); span.setAttribute('tabindex', '0'); }
        span.textContent = p.text;
        frag.appendChild(span);
      } else frag.appendChild(doc.createTextNode(p.text));
    }
    t.replaceWith(frag);
  }
}

/** Wrap each fenced block: scroll container + copy button (wired by installMarkdownHandlers). */
function wrapCode(root: ParentNode, doc: Document) {
  for (const pre of Array.from(root.querySelectorAll('pre'))) {
    const wrap = doc.createElement('div');
    wrap.className = 'md-code';
    const btn = doc.createElement('button');
    btn.className = 'md-copy';
    btn.setAttribute('type', 'button');
    btn.setAttribute('title', 'Copy code');
    btn.textContent = 'Copy';
    pre.replaceWith(wrap);
    wrap.append(btn, pre);
  }
}

/** Full block Markdown -> sanitized HTML string. */
export function renderMarkdown(text: string, opts: MdOptions = {}): string {
  const p = getPurify();
  const dirty = md.parse(String(text ?? ''), { async: false }) as string;
  const frag = p.sanitize(dirty, { ALLOWED_TAGS: [...BLOCK_TAGS, ...INLINE_TAGS], ALLOWED_ATTR: ATTRS, ALLOWED_URI_REGEXP: URI_RE, RETURN_DOM_FRAGMENT: true, FORBID_ATTR: ['style'] }) as DocumentFragment;
  const doc = frag.ownerDocument;
  decorate(frag, doc, opts);
  wrapCode(frag, doc);
  const box = doc.createElement('div');
  box.appendChild(frag);
  return box.innerHTML;
}

/** Single-line inline Markdown (bold, italic, code, links) for previews; every block construct is flattened to plain text. */
export function renderInline(text: string): string {
  const p = getPurify();
  const flat = String(text ?? '').replace(/\s*\n\s*/g, ' ').trim();
  const dirty = md.parseInline(flat, { async: false }) as string;
  return p.sanitize(dirty, { ALLOWED_TAGS: ['strong', 'b', 'em', 'i', 'del', 's', 'code', 'a'], ALLOWED_ATTR: ['href', 'title'], ALLOWED_URI_REGEXP: URI_RE, FORBID_ATTR: ['style'] }) as string;
}

/** Delegated click handling for rendered output under `root`: code copy buttons and path:line copy. Links open natively (target=_blank). */
export function installMarkdownHandlers(root: HTMLElement) {
  const copy = (text: string, flash: HTMLElement) => {
    // Feedback is immediate: clipboard.writeText can stay pending (permission prompt) or be refused in a sandboxed frame.
    const done = () => {
      const prev = flash.textContent;
      flash.classList.add('copied');
      if (flash.classList.contains('md-copy')) flash.textContent = 'Copied';
      setTimeout(() => { flash.classList.remove('copied'); if (flash.classList.contains('md-copy')) flash.textContent = prev; }, 1200);
    };
    const fallback = () => {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); } catch { /* sandboxed: nothing to do */ }
      ta.remove();
    };
    done();
    try { navigator.clipboard.writeText(text).catch(fallback); } catch { fallback(); }
  };
  root.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    const btn = t.closest<HTMLElement>('.md-copy');
    if (btn) { e.stopPropagation(); copy(btn.parentElement?.querySelector('pre')?.textContent ?? '', btn); return; }
    const path = t.closest<HTMLElement>('.md-path');
    if (path) { e.stopPropagation(); copy(path.dataset.copy ?? path.textContent ?? '', path); }
  });
}
