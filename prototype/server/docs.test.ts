// Docs: the allowlisted, read-only Markdown reader. Every way out of the root (traversal, absolute, symlink, hard link, PHI, odd names, size, extension) must fail closed;
// plus the HTTP guard on the real data server (mock mode serves a fixture folder).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { DOCS_MAX_BYTES, DocsError, cleanDocPath, createDocsService, isPhiDir } from './docs.ts';

const base = mkdtempSync(join(tmpdir(), 'aos-docs-'));
const root = join(base, 'workspace');
const outside = join(base, 'outside');
for (const d of ['reports', 'memory', 'phi', 'phi-notes', 'openclaw-phi', 'workspace-phi', 'reports/deep', '.git', 'node_modules/x', 'phi/reports']) mkdirSync(join(root, d), { recursive: true });
mkdirSync(outside, { recursive: true });
const put = (p: string, text = '# hi\n') => writeFileSync(join(root, p), text);
put('MEMORY.md', '# Memory\n'); put('reports/a.md', '# A\n\n| x | y |\n|---|---|\n| 1 | 2 |\n'); put('reports/deep/b.markdown'); put('memory/2026-10-05.MD');
put('reports/phi-gateway-setup.md', '# a document about the gateway\n'); put('reports/notes.txt', 'not markdown'); put('.git/HEAD.md'); put('.hidden.md'); put('node_modules/x/readme.md');
put('phi/secret.md', 'PHI'); put('phi-notes/n.md', 'PHI'); put('openclaw-phi/n.md', 'PHI'); put('workspace-phi/n.md', 'PHI'); put('phi/reports/deeper.md', 'PHI');
writeFileSync(join(outside, 'secret.md'), 'TOP SECRET');
writeFileSync(join(root, 'big.md'), 'x'.repeat(DOCS_MAX_BYTES + 1));
writeFileSync(join(root, 'exactly.md'), 'y'.repeat(DOCS_MAX_BYTES));
symlinkSync(join(outside, 'secret.md'), join(root, 'reports/link-out.md'));
symlinkSync(outside, join(root, 'linked-dir'));
symlinkSync(join(root, 'MEMORY.md'), join(root, 'reports/link-in.md'));
symlinkSync(join(root, 'phi'), join(root, 'reports/phi-link'));
linkSync(join(outside, 'secret.md'), join(root, 'reports/hard.md'));
const svc = createDocsService({ root });
after(() => rmSync(base, { recursive: true, force: true }));

const status = (fn: () => unknown) => { try { fn(); return 200; } catch (e) { assert.ok(e instanceof DocsError, String(e)); return e.status; } };

test('list: only .md/.markdown (any case), newest first; no dotfiles, node_modules, symlinks, hard links, PHI directories or oversize-agnostic leaks', () => {
  const { files, truncated } = svc.list();
  assert.equal(truncated, false);
  const paths = files.map((f) => f.path).sort();
  assert.deepEqual(paths, ['MEMORY.md', 'big.md', 'exactly.md', 'memory/2026-10-05.MD', 'reports/a.md', 'reports/deep/b.markdown', 'reports/phi-gateway-setup.md']);
  for (const f of files) assert.ok(f.size > 0 && f.mtime > 0);
  assert.ok(files.every((f, i) => i === 0 || files[i - 1].mtime >= f.mtime), 'newest first');
});

test('read: a normal file, a nested file, an upper-case extension, and a file NAMED phi-… that is just a document', () => {
  assert.equal(svc.read('MEMORY.md').text, '# Memory\n');
  assert.match(svc.read('reports/a.md').text, /\| x \| y \|/);
  assert.equal(svc.read('reports/deep/b.markdown').path, 'reports/deep/b.markdown');
  assert.equal(svc.read('memory/2026-10-05.MD').text, '# hi\n');
  assert.match(svc.read('reports/phi-gateway-setup.md').text, /gateway/);
  assert.equal(svc.read('exactly.md').size, DOCS_MAX_BYTES, 'exactly the cap is fine');
});

test('traversal, absolute paths and odd names are refused (400)', () => {
  for (const p of ['../outside/secret.md', 'reports/../../outside/secret.md', '/etc/passwd.md', join(outside, 'secret.md'), 'reports/..%2f..%2foutside/secret.md', '..', '.', '', 'reports//a.md', './reports/a.md', 'reports/./a.md', 'reports\\a.md', 'C:\\x.md', 'C:/x.md', 'reports/a.md\0.txt', '.git/HEAD.md', '.hidden.md', 'reports/.hidden.md', 'a'.repeat(500) + '.md', undefined, null, 5, {}, ['reports/a.md']]) {
    const s = status(() => svc.read(p as never));
    assert.ok(s === 400 || s === 404, `${JSON.stringify(p)} -> ${s}`);
    assert.notEqual(s, 200, JSON.stringify(p));
  }
  assert.equal(status(() => svc.read('../outside/secret.md')), 400);
  assert.equal(status(() => cleanDocPath('reports/../a.md')), 400);
});

test('wrong extension is refused (415), a missing file is 404, a directory is 404', () => {
  for (const p of ['reports/notes.txt', 'reports/a.md.txt', 'reports/a.mdx', 'package.json', 'reports/a', 'reports/']) assert.ok([400, 415].includes(status(() => svc.read(p))), p);
  assert.equal(status(() => svc.read('reports/notes.txt')), 415);
  assert.equal(status(() => svc.read('reports/missing.md')), 404);
  assert.equal(status(() => svc.read('missing/x.md')), 404);
  assert.equal(status(() => svc.read('reports/deep')), 415);
  assert.equal(status(() => svc.read('reports.md')), 404);
});

test('size cap: over 256 KiB is 413, never read', () => {
  assert.equal(status(() => svc.read('big.md')), 413);
});

test('symlinks (file or directory, in or out of the root) and hard links are 404', () => {
  assert.equal(status(() => svc.read('reports/link-out.md')), 404, 'symlink to a file outside');
  assert.equal(status(() => svc.read('reports/link-in.md')), 404, 'even a symlink to a file inside');
  assert.equal(status(() => svc.read('linked-dir/secret.md')), 404, 'symlinked directory to outside');
  assert.equal(status(() => svc.read('reports/phi-link/secret.md')), 404, 'symlinked directory to phi');
  assert.equal(status(() => svc.read('reports/hard.md')), 404, 'a hard link may be a file outside the root');
});

test('PHI: directories named phi, phi-*, openclaw-phi, workspace-phi are invisible, at any depth', () => {
  for (const p of ['phi/secret.md', 'phi-notes/n.md', 'openclaw-phi/n.md', 'workspace-phi/n.md', 'phi/reports/deeper.md', 'Phi/secret.md']) assert.equal(status(() => svc.read(p)), 404, p);
  for (const n of ['phi', 'PHI', 'phi-notes', 'phi_x', 'openclaw-phi', '.openclaw-phi', 'workspace-phi', 'phi.d']) assert.ok(isPhiDir(n), n);
  for (const n of ['physics', 'alpha', 'sophie', 'graphi', 'reports', 'philosophy']) assert.ok(!isPhiDir(n), n);
});

test('a root that does not exist is 503, not a path leak', () => {
  const gone = createDocsService({ root: join(base, 'nope') });
  assert.equal(status(() => gone.list()), 503);
  assert.equal(status(() => gone.read('a.md')), 503);
});

// ---- HTTP: the real data server in mock mode (fixture root), on a throwaway port
const PORT = 6200 + Math.floor(Math.random() * 500);
const get = (path: string, headers: Record<string, string> = {}) => new Promise<{ status: number; body: string }>((resolve, reject) => {
  const req = request({ host: '127.0.0.1', port: PORT, path, headers: { host: `127.0.0.1:${PORT}`, ...headers } }, (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode ?? 0, body: b })); });
  req.on('error', reject); req.end();
});
test('HTTP: needs the x-agent-os-send header, serves the fixture root in mock mode, refuses escapes and bad hosts, answers JSON errors', async () => {
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts', '--mock'], { env: { ...process.env, AGENT_OS_API_PORT: String(PORT) }, stdio: 'ignore' });
  try {
    for (let i = 0; i < 60; i++) { try { if ((await get('/api/config')).status === 200) break; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 200)); }
    const H = { 'x-agent-os-send': '1' };
    assert.equal((await get('/api/docs')).status, 403, 'no header');
    assert.equal((await get('/api/docs/file?path=MEMORY.md')).status, 403, 'no header');
    const list = await get('/api/docs', H);
    assert.equal(list.status, 200);
    const files = (JSON.parse(list.body) as { files: Array<{ path: string }> }).files.map((f) => f.path);
    assert.ok(files.includes('reports/sample-report.md') && files.includes('reports/phi-gateway-setup.md') && files.includes('MEMORY.md'), files.join(','));
    const one = await get('/api/docs/file?path=reports/sample-report.md', H);
    assert.equal(one.status, 200);
    assert.match((JSON.parse(one.body) as { text: string }).text, /^# Quarterly sync/);
    assert.equal((await get('/api/docs/file?path=..%2F..%2Fpackage.json', H)).status, 400);
    assert.equal((await get('/api/docs/file?path=%2Fetc%2Fpasswd.md', H)).status, 400);
    assert.equal((await get('/api/docs/file?path=package.json', H)).status, 415);
    assert.equal((await get('/api/docs/file?path=nope.md', H)).status, 404);
    assert.equal((await get('/api/docs/file', H)).status, 400);
    assert.equal((await get('/api/docs', { ...H, host: 'evil.example.com' })).status, 403, 'DNS rebinding');
    assert.equal(JSON.parse((await get('/api/docs/file?path=nope.md', H)).body).error, 'not found');
    const post = await new Promise<number>((resolve) => { const r = request({ host: '127.0.0.1', port: PORT, path: '/api/docs', method: 'POST', headers: { ...H, 'content-type': 'application/json' } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); }); r.end('{}'); });
    assert.equal(post, 405, 'read-only');
  } finally { child.kill('SIGTERM'); }
});
