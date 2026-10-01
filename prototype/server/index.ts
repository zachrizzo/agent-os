// Tiny read-only API: JSON + SSE, bound to 127.0.0.1 only.
//   GET /api/config
//   GET /api/snapshot?source=live|mock
//   GET /api/stream?source=live|mock      (SSE: "snapshot" once, then "delta")
//   GET /api/history?source=..&key=<sessionKey>
// Every payload passes through redactDeep() before it is written.
import { createServer, type ServerResponse } from 'node:http';
import { createLiveSource } from './live.ts';
import { createMockSource } from './mock.ts';
import { redactDeep } from './redact.ts';
import type { Source } from './source.ts';

const HOST = '127.0.0.1';
const PORT = Number(process.env.AGENT_OS_API_PORT ?? 5198);
const DEFAULT_SOURCE: 'mock' | 'live' = process.argv.includes('--mock') ? 'mock' : 'live';
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

const server = createServer(async (req, res) => {
  if (!ALLOWED_HOSTS.test(req.headers.host ?? '')) return json(res, 403, { error: 'forbidden host' });
  const url = new URL(req.url ?? '/', `http://${HOST}`);
  if (req.method !== 'GET') return json(res, 405, { error: 'read-only' });
  const src = url.searchParams.get('source');
  try {
    if (url.pathname === '/api/config') return json(res, 200, { defaultSource: DEFAULT_SOURCE, sources: ['live', 'mock'] });
    if (url.pathname === '/api/snapshot') {
      const s = source(src);
      await s.ready;
      return json(res, 200, s.snapshot());
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
