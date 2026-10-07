// Tiny local API: JSON + SSE, bound to 127.0.0.1 only. Reads are GET; the only write is POST /api/send.
//   GET /api/config
//   GET /api/snapshot?source=live|mock
//   GET /api/stream?source=live|mock      (SSE: "snapshot" once, then "delta")
//   GET /api/history?source=..&key=<sessionKey>
//   GET /api/board?source=..           read-only Workboard cards (boards spark + forge) for the Board view
//   GET  /api/rooms            rooms + the live agent list (PHI excluded)      GET /api/rooms/:id   one room with its thread and run state
//   POST /api/rooms {name, members, captain?}   create             POST /api/rooms/:id {name?, addMembers?, removeMembers?, archived?, captain?}
//   POST /api/rooms/:id/send {message}   starts an open discussion: every member replies, then rounds of reply-or-PASS; the lead (captain) moderates; it ends when a whole round is PASS or on Stop
//   POST /api/rooms/:id/stop   aborts every in-flight member run (chat.abort, room sessions only)
//   POST /api/rooms/:id/continue   releases a soft pause (a long run pauses, never stops)     POST /api/rooms/:id/end   soft stop: turns in flight finish, nothing new starts
//   POST /api/rooms/:id/wrapup   asks the lead to summarize, as a normal message              POST /api/rooms/:id/pin {messageId, pinned}   pin a message as a decision
//   A send while a discussion is running is queued and joins at the next round boundary. The update body also takes notes, responderMode, pauseAfterPosts, pauseAfterTokens, speakFilter.
//   GET  /api/docs                list of .md/.markdown files under the workspace      GET /api/docs/file?path=reports/x.md   one file (256 KiB cap)
//   Docs reads are read-only, allowlisted to ONE root (server/docs.ts) and need the same x-agent-os-send header as the writes.
//   Room writes use the same guard as /api/send (JSON + x-agent-os-send: 1, same body cap).
// Every payload passes through redactDeep() before it is written.
import { fileURLToPath } from 'node:url';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createLiveSource } from './live.ts';
import { createMockSource } from './mock.ts';
import { redactDeep } from './redact.ts';
import { DocsError, createDocsService, defaultDocsRoot } from './docs.ts';
import { RoomError, ROOM_ID_RE } from './rooms.ts';
import type { Source } from './source.ts';

const HOST = '127.0.0.1';
const PORT = Number(process.env.AGENT_OS_API_PORT ?? 5198);
const DEFAULT_SOURCE: 'mock' | 'live' = process.argv.includes('--mock') ? 'mock' : 'live';
// Docs root: the main workspace only (AGENT_OS_DOCS_ROOT for a throwaway root; the mock server serves a fixture folder, never the real workspace).
const docs = createDocsService({ root: process.env.AGENT_OS_DOCS_ROOT ?? (process.argv.includes('--mock') ? fileURLToPath(new URL('./fixtures/docs', import.meta.url)) : defaultDocsRoot()) });
const ALLOWED_HOSTS = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/; // blocks DNS-rebinding reads

const sources = new Map<string, Source>();
function source(name: string | null): Source & { ready?: Promise<void> } {
  const n = name === 'mock' || name === 'live' ? name : DEFAULT_SOURCE;
  let s = sources.get(n);
  if (!s) sources.set(n, (s = n === 'mock' ? createMockSource() : createLiveSource()));
  return s;
}

function json(res: ServerResponse, code: number, body: unknown) {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(redactDeep(body)));
}
const sse = (res: ServerResponse, event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(redactDeep(data))}\n\n`);

// Anything a web page can fire without a preflight is refused: JSON content type + a custom header, and no CORS
// headers here, so another origin cannot pass the preflight. Body is capped.
/** Shared write guard: custom header + JSON content type, capped body. Replies and returns null when refused. */
async function guardedJson(req: IncomingMessage, res: ServerResponse): Promise<Record<string, unknown> | null> {
  if (req.headers['x-agent-os-send'] !== '1' || !String(req.headers['content-type'] ?? '').startsWith('application/json')) { json(res, 403, { error: 'forbidden' }); return null; }
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 16_384) { json(res, 413, { error: 'body too large' }); return null; }
  }
  try {
    const body = JSON.parse(raw || '{}');
    if (body && typeof body === 'object' && !Array.isArray(body)) return body as Record<string, unknown>;
  } catch { /* fall through */ }
  json(res, 400, { error: 'bad JSON' });
  return null;
}

async function send(req: IncomingMessage, res: ServerResponse, src: string | null) {
  const body = await guardedJson(req, res);
  if (!body) return;
  if (typeof body.key !== 'string' || typeof body.message !== 'string') return json(res, 400, { error: 'key and message are required strings' });
  try {
    const s = source(src);
    await s.ready;
    const routed = await s.send(body.key, body.message, body.direct === true);
    json(res, 200, { ok: true, to: routed.key, relayed: routed.relayed, agent: routed.agent });
  } catch (e) {
    json(res, /unknown session|empty|too long|direct send/.test((e as Error).message) ? 400 : 502, { error: (e as Error).message });
  }
}

/** GET /api/docs and /api/docs/file?path=: the same header guard as the writes (a cross-origin page cannot add it without a preflight, and there is no CORS here). */
function docsApi(req: IncomingMessage, res: ServerResponse, url: URL) {
  if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' });
  if (req.headers['x-agent-os-send'] !== '1') return json(res, 403, { error: 'forbidden' });
  try {
    if (url.pathname === '/api/docs') return json(res, 200, docs.list());
    return json(res, 200, docs.read(url.searchParams.get('path')));
  } catch (e) {
    if (e instanceof DocsError) return json(res, e.status, { error: e.message });
    json(res, 500, { error: 'could not read docs' });
  }
}

// /api/rooms[/:id[/send|/stop|/end|/continue|/wrapup|/pin]]: reads are GET, writes share the /api/send guard.
const ROOMS_PATH = /^\/api\/rooms(?:\/([^/]+)(?:\/(send|stop|end|continue|wrapup|pin))?)?$/;
async function roomsApi(req: IncomingMessage, res: ServerResponse, url: URL, src: string | null) {
  const m = ROOMS_PATH.exec(url.pathname)!;
  const [, id, action] = m;
  if (id && !ROOM_ID_RE.test(id)) return json(res, 404, { error: 'unknown room' });
  try {
    const s = source(src);
    await s.ready;
    const rooms = s.rooms;
    if (req.method === 'GET') {
      if (action) return json(res, 405, { error: 'method not allowed' });
      return json(res, 200, id ? await rooms.get(id) : await rooms.list());
    }
    if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
    const body = await guardedJson(req, res);
    if (!body) return;
    if (!id) return json(res, 200, await rooms.create(body as never));
    if (action === 'send') return json(res, 200, await rooms.send(id, body.message));
    if (action === 'stop') return json(res, 200, await rooms.stop(id));
    if (action === 'end') return json(res, 200, await rooms.end(id));
    if (action === 'continue') return json(res, 200, await rooms.resume(id));
    if (action === 'wrapup') return json(res, 200, await rooms.wrapUp(id));
    if (action === 'pin') return json(res, 200, await rooms.pin(id, body.messageId, body.pinned));
    return json(res, 200, await rooms.update(id, body as never));
  } catch (e) {
    if (e instanceof RoomError) return json(res, e.status, { error: e.message });
    json(res, 502, { error: (e as Error).message });
  }
}

const server = createServer(async (req, res) => {
  if (!ALLOWED_HOSTS.test(req.headers.host ?? '')) return json(res, 403, { error: 'forbidden host' });
  const url = new URL(req.url ?? '/', `http://${HOST}`);
  const src = url.searchParams.get('source');
  if (req.method === 'POST' && url.pathname === '/api/send') return send(req, res, src);
  if (ROOMS_PATH.test(url.pathname)) return roomsApi(req, res, url, src);
  if (url.pathname === '/api/docs' || url.pathname === '/api/docs/file') return docsApi(req, res, url);
  if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' });
  try {
    if (url.pathname === '/api/config') return json(res, 200, { defaultSource: DEFAULT_SOURCE, sources: ['live', 'mock'] });
    if (url.pathname === '/api/snapshot') {
      const s = source(src);
      await s.ready;
      return json(res, 200, s.snapshot());
    }
    if (url.pathname === '/api/board') {
      const s = source(src);
      await s.ready;
      return json(res, 200, { ts: Date.now(), cards: await s.board() });
    }
    if (url.pathname === '/api/history') {
      const key = url.searchParams.get('key') ?? '';
      const s = source(src);
      await s.ready;
      return json(res, 200, { items: await s.history(key) });
    }
    if (url.pathname === '/api/stream') {
      const s = source(src);
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
      res.write('retry: 2000\n\n');
      await s.ready;
      if (res.destroyed) return;
      sse(res, 'snapshot', s.snapshot());
      const off = s.subscribe((d) => sse(res, 'delta', d));
      const ka = setInterval(() => res.write(': ka\n\n'), 15_000);
      req.on('close', () => { off(); clearInterval(ka); });
      return;
    }
    json(res, 404, { error: 'not found' });
  } catch (e) {
    if (res.headersSent) return void res.end();
    json(res, 500, { error: (e as Error).message });
  }
});

server.listen(PORT, HOST, () => console.log(`[agent-os api] http://${HOST}:${PORT} (default source: ${DEFAULT_SOURCE})`));
const shutdown = () => { for (const s of sources.values()) s.close(); server.close(); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
