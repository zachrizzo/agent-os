// Docs: a read-only list + read of Markdown files under ONE allowlisted root (the main workspace). Fail closed.
//   - paths are relative to the root: no `..`, no absolute paths, no backslashes/NUL, no dot-segments (so no .git, .dreams, .env), .md/.markdown only
//   - no symlink anywhere on the path, realpath containment as a second check; the file itself must not be a symlink and must not have other hard links (a hard link to a file outside the root cannot be told apart by path)
//   - 256 KiB cap, read through one file descriptor that is checked after opening (no swap between check and read)
//   - anything PHI is invisible: a directory named phi / phi-* / openclaw-phi / workspace-phi is never listed or read (a FILE called phi-gateway-setup.md is just a document)
//   - not-found, outside-the-root, symlink and phi all look the same to the caller (404), so probing teaches nothing
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, readdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export const DOCS_MAX_BYTES = 256 * 1024;
export const DOCS_MAX_FILES = 3000;
const MAX_DEPTH = 8;
const SKIP_DIRS = new Set(['node_modules']);
const MD_EXT = /\.(md|markdown)$/i;
/** Directories that belong to the PHI agent or its data. Matches the name of a directory, never of a file. */
export const isPhiDir = (name: string) => /^(?:\.?openclaw-|workspace-)?phi(?:[-_.].*)?$/i.test(name);

export class DocsError extends Error { constructor(readonly status: number, message: string) { super(message); } }
const NOT_FOUND = () => new DocsError(404, 'not found');

export interface DocEntry { path: string; size: number; mtime: number }
export interface DocFile extends DocEntry { text: string }

/** Default root: the main workspace only. */
export const defaultDocsRoot = () => path.join(homedir(), '.openclaw', 'workspace');

/** A clean, root-relative path or a DocsError. */
export function cleanDocPath(raw: unknown): string {
  if (typeof raw !== 'string' || !raw || raw.length > 400) throw new DocsError(400, 'path is required');
  if (raw.includes('\0') || raw.includes('\\') || raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) throw new DocsError(400, 'invalid path');
  const parts = raw.split('/');
  if (parts.some((p) => !p || p === '.' || p === '..' || p.startsWith('.'))) throw new DocsError(400, 'invalid path');
  if (!MD_EXT.test(raw)) throw new DocsError(415, 'only .md and .markdown files can be opened');
  return parts.join('/');
}

export function createDocsService(opts: { root: string }) {
  const rootOf = (): string => {
    try { return realpathSync(opts.root); } catch { throw new DocsError(503, 'docs root is not available'); }
  };
  const inside = (root: string, p: string) => p === root || p.startsWith(root + path.sep);
  const phiPath = (p: string) => p.split(path.sep).some(isPhiDir);

  /** Real path of the directory that holds the file: every segment must be a plain directory (no symlinks at all), inside the root, and not PHI. */
  function resolveDir(root: string, parts: string[]): string {
    let cur = root;
    for (const part of parts) {
      if (isPhiDir(part)) throw NOT_FOUND();
      cur = path.join(cur, part);
      let st; try { st = lstatSync(cur); } catch { throw NOT_FOUND(); }
      if (st.isSymbolicLink() || !st.isDirectory()) throw NOT_FOUND();
    }
    const real = realpathSync(cur);
    if (!inside(root, real) || phiPath(path.relative(root, real))) throw NOT_FOUND();
    return real;
  }

  return {
    /** Every .md/.markdown file under the root, newest first. Symlinks, hard-linked files and PHI directories are left out. */
    list(): { files: DocEntry[]; truncated: boolean } {
      const root = rootOf();
      const files: DocEntry[] = [];
      let truncated = false;
      const walk = (dir: string, rel: string, depth: number) => {
        if (truncated || depth > MAX_DEPTH) return;
        let names: string[];
        try { names = readdirSync(dir); } catch { return; }
        for (const name of names.sort()) {
          if (name.startsWith('.')) continue;
          const full = path.join(dir, name);
          let st; try { st = lstatSync(full); } catch { continue; }
          if (st.isSymbolicLink()) continue;
          if (st.isDirectory()) {
            if (isPhiDir(name) || SKIP_DIRS.has(name)) continue;
            walk(full, rel ? `${rel}/${name}` : name, depth + 1);
          } else if (st.isFile() && MD_EXT.test(name) && st.nlink === 1) {
            if (files.length >= DOCS_MAX_FILES) { truncated = true; return; }
            files.push({ path: rel ? `${rel}/${name}` : name, size: st.size, mtime: Math.round(st.mtimeMs) });
          }
        }
      };
      walk(root, '', 0);
      files.sort((a, b) => b.mtime - a.mtime || a.path.localeCompare(b.path));
      return { files, truncated };
    },

    read(rawPath: unknown): DocFile {
      const rel = cleanDocPath(rawPath);
      const root = rootOf();
      const parts = rel.split('/');
      const name = parts.pop()!;
      const dir = resolveDir(root, parts);
      const full = path.join(dir, name);
      let before; try { before = lstatSync(full); } catch { throw NOT_FOUND(); }
      if (before.isSymbolicLink() || !before.isFile()) throw NOT_FOUND();
      if (before.nlink !== 1) throw NOT_FOUND(); // a hard link may point at a file outside the root
      if (before.size > DOCS_MAX_BYTES) throw new DocsError(413, `file is larger than ${DOCS_MAX_BYTES / 1024} KiB`);
      let fd: number;
      try { fd = openSync(full, constants.O_RDONLY | constants.O_NOFOLLOW); } catch { throw NOT_FOUND(); }
      try {
        const st = fstatSync(fd);
        if (!st.isFile() || st.ino !== before.ino || st.dev !== before.dev || st.nlink !== 1) throw NOT_FOUND(); // swapped after the check
        if (st.size > DOCS_MAX_BYTES) throw new DocsError(413, `file is larger than ${DOCS_MAX_BYTES / 1024} KiB`);
        const buf = Buffer.alloc(Math.min(st.size, DOCS_MAX_BYTES) + 1);
        let n = 0;
        for (let r = readSync(fd, buf, n, buf.length - n, null); r > 0 && n < buf.length; r = readSync(fd, buf, n, buf.length - n, null)) n += r;
        if (n > DOCS_MAX_BYTES) throw new DocsError(413, `file is larger than ${DOCS_MAX_BYTES / 1024} KiB`); // grew while reading
        return { path: rel, size: n, mtime: Math.round(st.mtimeMs), text: buf.subarray(0, n).toString('utf8') };
      } finally { closeSync(fd); }
    },
  };
}
export type DocsService = ReturnType<typeof createDocsService>;
