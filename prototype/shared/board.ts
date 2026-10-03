// Read-only Workboard view: Spark + Forge cards in four columns. Pure helpers shared by the data server and the page.
export const BOARDS = ['spark', 'forge'] as const;
export type BoardId = (typeof BOARDS)[number];

export type ColumnKey = 'queued' | 'working' | 'review' | 'closed';
export const COLUMNS: { key: ColumnKey; label: string }[] = [
  { key: 'queued', label: 'Queued' },
  { key: 'working', label: 'Working' },
  { key: 'review', label: 'Review / QA' },
  { key: 'closed', label: 'Done / Blocked' },
];

export interface BoardCard {
  id: string;
  board: BoardId;
  title: string;
  /** Assigned agent id, or the claim owner, or ''. */
  agent: string;
  status: string;
  priority: string;
  createdAt: number;
  updatedAt: number;
}

export function columnOf(status: string): ColumnKey {
  if (status === 'running') return 'working';
  if (status === 'review') return 'review';
  if (status === 'done' || status === 'blocked') return 'closed';
  return 'queued'; // triage, backlog, todo, scheduled, ready, and any status a newer Workboard adds
}

/** Raw Workboard card (Gateway `workboard.cards.list`) -> the few fields the page shows. Archived cards are dropped. */
export function normalizeCard(raw: any, board: BoardId): BoardCard | null {
  if (!raw || typeof raw.id !== 'string' || typeof raw.title !== 'string' || raw.archivedAt) return null;
  const owner = raw.metadata?.claim?.ownerId;
  return {
    id: raw.id,
    board,
    title: raw.title.replace(/\s+/g, ' ').trim().slice(0, 200),
    agent: String(raw.agentId ?? owner ?? '').slice(0, 60),
    status: String(raw.status ?? ''),
    priority: String(raw.priority ?? 'normal'),
    createdAt: Number(raw.createdAt) || 0,
    updatedAt: Number(raw.updatedAt) || Number(raw.createdAt) || 0,
  };
}

const PRIORITY_RANK: Record<string, number> = { urgent: 0, high: 1, normal: 2, low: 3 };
const CLOSED_KEEP = 15; // done cards are a long tail: keep the latest ones per board; blocked cards are never dropped

/** Group cards into the four columns. Open columns sort by priority then oldest-first; closed shows blocked first, then latest done. */
export function groupBoard(cards: BoardCard[]): Record<ColumnKey, BoardCard[]> {
  const out: Record<ColumnKey, BoardCard[]> = { queued: [], working: [], review: [], closed: [] };
  for (const c of cards) out[columnOf(c.status)].push(c);
  for (const k of ['queued', 'working', 'review'] as const) {
    out[k].sort((a, b) => (PRIORITY_RANK[a.priority] ?? 2) - (PRIORITY_RANK[b.priority] ?? 2) || a.createdAt - b.createdAt);
  }
  const blocked = out.closed.filter((c) => c.status === 'blocked').sort((a, b) => b.updatedAt - a.updatedAt);
  const perBoard = new Map<string, number>();
  const done = out.closed.filter((c) => c.status !== 'blocked').sort((a, b) => b.updatedAt - a.updatedAt).filter((c) => {
    const n = (perBoard.get(c.board) ?? 0) + 1;
    perBoard.set(c.board, n);
    return n <= CLOSED_KEEP;
  });
  out.closed = [...blocked, ...done];
  return out;
}

/** "5m", "3h", "2d": time since the card last changed. */
export function ageLabel(ts: number, now: number): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

/** Control UI route for a board (the Workboard page); cards have no deep link of their own. */
export const boardHref = (board: BoardId) => `/workboard/${board}`;
