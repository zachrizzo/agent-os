import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { renderInline, renderMarkdown, setDomWindow } from './markdown.ts';

const dom = new JSDOM('<!doctype html><html><body></body></html>');
setDomWindow(dom.window);
const MEMBERS = ['rfc-lead', 'rfc-skeptic'];
const parse = (html: string) => { const d = new JSDOM(`<body>${html}</body>`).window.document; return d.body; };
const r = (s: string) => renderMarkdown(s, { mentions: MEMBERS });

test('renders headings, bold, italic, inline code, strikethrough, line breaks', () => {
  const b = parse(r('# Title\n\n**bold** and *it* and `code` and ~~gone~~\nsecond line'));
  assert.equal(b.querySelector('h1')?.textContent, 'Title');
  assert.equal(b.querySelector('strong')?.textContent, 'bold');
  assert.equal(b.querySelector('em')?.textContent, 'it');
  assert.equal(b.querySelector('p code')?.textContent, 'code');
  assert.equal(b.querySelector('del')?.textContent, 'gone');
  assert.ok(b.querySelector('br'), 'single newline is a line break');
});

test('lists, blockquote, table', () => {
  const b = parse(r('- a\n- b\n\n1. one\n2. two\n\n> quoted\n\n| h1 | h2 |\n|---|---|\n| c1 | c2 |'));
  assert.equal(b.querySelectorAll('ul li').length, 2);
  assert.equal(b.querySelectorAll('ol li').length, 2);
  assert.equal(b.querySelector('blockquote')?.textContent?.trim(), 'quoted');
  assert.equal(b.querySelectorAll('table th').length, 2);
  assert.equal(b.querySelectorAll('table td')[1].textContent, 'c2');
});

test('fenced code: monospace block with a copy button, content kept literal', () => {
  const b = parse(r('```ts\nconst a = "<b>x</b>" && 1;\n```'));
  const pre = b.querySelector('.md-code > pre');
  assert.ok(pre);
  assert.equal(pre!.textContent, 'const a = "<b>x</b>" && 1;\n');
  assert.equal(b.querySelector('.md-code > button.md-copy')?.textContent, 'Copy');
  assert.equal(b.querySelector('b'), null);
});

test('links: new tab, noopener noreferrer; bare URLs autolink', () => {
  const b = parse(r('[x](https://example.com/a) and https://example.org/b'));
  const as = Array.from(b.querySelectorAll('a'));
  assert.equal(as.length, 2);
  for (const a of as) { assert.equal(a.getAttribute('target'), '_blank'); assert.equal(a.getAttribute('rel'), 'noopener noreferrer'); }
  assert.equal(as[1].getAttribute('href'), 'https://example.org/b');
});

test('@mentions of members become chips; non-members, code and links are left alone', () => {
  const b = parse(r('ping @rfc-lead and @nobody, `@rfc-skeptic` and [@rfc-lead](https://e.com)'));
  const chips = Array.from(b.querySelectorAll('.rm-at')).map((x) => x.textContent);
  assert.deepEqual(chips, ['@rfc-lead']);
  assert.ok(b.textContent!.includes('@nobody'));
  assert.equal(b.querySelector('code')?.textContent, '@rfc-skeptic');
});

test('path:line references are marked and copyable; URLs are not mistaken for paths', () => {
  const b = parse(r('see src/ui/rooms.ts:86 and ./a/b.c, but https://example.com/x/y.html stays a link'));
  const paths = Array.from(b.querySelectorAll('.md-path')).map((x) => x.getAttribute('data-copy'));
  assert.deepEqual(paths, ['src/ui/rooms.ts:86', './a/b.c']);
  assert.equal(b.querySelectorAll('a').length, 1);
});

test('backticked path:line is marked; plain inline code is not', () => {
  const b = parse(r('open `src/a/b.ts:12` and `npm test` and `x.ts:9`'));
  assert.deepEqual(Array.from(b.querySelectorAll('code.md-path')).map((x) => x.getAttribute('data-copy')), ['src/a/b.ts:12', 'x.ts:9']);
  assert.equal(b.querySelectorAll('code').length, 3);
});

test('XSS: script tags and raw HTML are shown as text, never elements', () => {
  const h = r('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n<b onclick="x()">raw</b>\n\n<iframe src="https://evil.test"></iframe>\n\n<style>*{display:none}</style>');
  const b = parse(h);
  for (const t of ['script', 'img', 'iframe', 'style', 'b']) assert.equal(b.querySelector(t), null, t);
  assert.ok(b.textContent!.includes('<script>alert(1)</script>'));
  assert.doesNotMatch(h, /<(script|img|iframe|style)\b/i);
});

test('XSS: javascript:, data:, vbscript: links lose their href', () => {
  for (const u of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', ' javascript:alert(1)', 'data:text/html;base64,PHNjcmlwdD4=', 'vbscript:msgbox(1)', 'java\tscript:alert(1)']) {
    const h = r(`[click](${u.replace(/ /g, '%20')}) <a href="${u}">raw</a>`);
    const b = parse(h);
    for (const a of Array.from(b.querySelectorAll('a'))) assert.ok(!/^\s*(javascript|data|vbscript)/i.test(a.getAttribute('href') ?? ''), `${u} -> ${a.outerHTML}`);
    assert.equal(b.querySelectorAll('a[href]').length, 0, u);
  }
  const auto = parse(r('<javascript:alert(1)>'));
  assert.equal(auto.querySelector('a[href^="javascript"]'), null);
});

test('XSS: images are dropped (no beacons, no onerror)', () => {
  const b = parse(r('![alt text](https://evil.test/p.png "t") ![x](javascript:alert(1)) ![](data:image/svg+xml;base64,AAAA)'));
  assert.equal(b.querySelector('img'), null);
  assert.ok(b.textContent!.includes('alt text'));
});

test('XSS: malicious table cell and code fence stay inert', () => {
  const h = r('| a | b |\n|---|---|\n| <img src=x onerror=alert(1)> | [x](javascript:alert(1)) |\n\n```html\n<script>alert(1)</script><img src=x onerror=alert(2)>\n```');
  const b = parse(h);
  assert.equal(b.querySelector('script'), null);
  assert.equal(b.querySelector('img'), null);
  assert.equal(b.querySelector('table a[href^="javascript"]'), null);
  assert.equal(b.querySelector('pre')!.textContent, '<script>alert(1)</script><img src=x onerror=alert(2)>\n');
  assert.equal(b.querySelectorAll('[onerror],[onclick],[onload]').length, 0);
});

test('XSS: attributes inside markdown titles and code language cannot break out', () => {
  const h = r('[a](https://e.com "x\\" onmouseover=\\"alert(1)") \n\n```" onmouseover="alert(1)\ncode\n```');
  const b = parse(h);
  assert.equal(b.querySelectorAll('[onmouseover]').length, 0);
  assert.equal(b.querySelectorAll('[style]').length, 0);
});

test('XSS: svg/math/form/base/meta and style attributes are stripped', () => {
  const h = r('<svg onload=alert(1)><circle/></svg><math><mi xlink:href="javascript:alert(1)">x</mi></math><form action=x><input name=a></form><base href="https://evil"><meta http-equiv=refresh content="0;url=x"><p style="position:fixed">hi</p>');
  const b = parse(h);
  for (const t of ['svg', 'math', 'form', 'base', 'meta']) assert.equal(b.querySelector(t), null, t);
  assert.equal(b.querySelectorAll('[style]').length, 0);
});

test('mention names cannot inject through id characters', () => {
  const h = renderMarkdown('hi @a"onmouseover="x', { mentions: ['a"onmouseover="x'] });
  assert.equal(parse(h).querySelectorAll('[onmouseover]').length, 0);
});

test('empty and non-string input', () => {
  assert.equal(r(''), '');
  assert.equal(renderMarkdown(undefined as unknown as string), '');
});

test('renderInline: single line, inline markup only, links safe', () => {
  const h = renderInline('# Head\n\n**bold** `code` [l](https://e.com)\n- item\n<script>x</script> [bad](javascript:alert(1))');
  assert.doesNotMatch(h, /\n/);
  const b = parse(h);
  assert.equal(b.querySelector('strong')?.textContent, 'bold');
  assert.equal(b.querySelector('code')?.textContent, 'code');
  assert.equal(b.querySelector('a[href="https://e.com"]')?.getAttribute('rel'), 'noopener noreferrer');
  assert.equal(b.querySelector('script'), null);
  assert.equal(b.querySelector('a[href^="javascript"]'), null);
  assert.equal(b.querySelector('h1, ul, li, p'), null);
});
