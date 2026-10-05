// Docs view helpers (pure): grouping and filtering the file list, and the human labels.
export interface DocEntry { path: string; size: number; mtime: number }
export interface DocGroup { dir: string; files: DocEntry[] }

/** Files grouped by directory ("" = the workspace root first, then A-Z); newest first inside a group. `query` filters by path, case-insensitive, every word must match. */
export function groupDocs(files: readonly DocEntry[], query = ''): DocGroup[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const by = new Map<string, DocEntry[]>();
  for (const f of files) {
    const p = f.path.toLowerCase();
    if (!words.every((w) => p.includes(w))) continue;
    const i = f.path.lastIndexOf('/');
    const dir = i < 0 ? '' : f.path.slice(0, i);
    (by.get(dir) ?? by.set(dir, []).get(dir)!).push(f);
  }
  return [...by.entries()]
    .sort(([a], [b]) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b)))
    .map(([dir, fs]) => ({ dir, files: fs.sort((x, y) => y.mtime - x.mtime || x.path.localeCompare(y.path)) }));
}
export const baseName = (p: string) => p.slice(p.lastIndexOf('/') + 1);
export function fmtBytes(n: number) {
  if (n < 1024) return `${n} B`;
  return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KiB`;
}
/** Deep link: `?file=<path>` (a root-relative .md/.markdown path), or null. Anything else is ignored. */
export function fileParam(search: string): string | null {
  const v = new URLSearchParams(search).get('file');
  return v && v.length <= 400 && /\.(md|markdown)$/i.test(v) ? v : null;
}
