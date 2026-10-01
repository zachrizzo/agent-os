// Tiny read-only API: JSON + SSE, bound to 127.0.0.1 only.
//   GET /api/snapshot?source=live|mock
//   GET /api/stream?source=live|mock      (SSE: "snapshot" once, then "delta")
//   GET /api/history?source=..&key=<sessionKey>
import { createServer, type ServerResponse } from 'node:http';
import { createLiveSource } from './live.ts';
import { createMockSource } from './mock.ts';
import type { Source } from './source.ts';

const HOST = '127.0.0.1';
const PORT = Number(process.env.AGENT_OS_API_PORT ?? 5198);
const DEFAULT_SOURCE: 'mock' | 'live' = process.argv.includes('--mock') ? 'mock' : 'live';

const sources = new Map<string, Source>();
function source(name: string | null): Source {
  const n = name === 'mock' || name === 'live' ? name : DEFAULT_SOURCE;
  let s = sources.get(n);
  if (!s) sources.set(n, (s = n === 'mock' ? createMockSource() : createLiveSource()));
  return s;
}

function json(res: ServerResponse, code: number, body: unknown) {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${HOST}`);
  if (req.method !== 'GET') return json(res, 405, { error: 'read-only' });
  const src = url.searchParams.get('source');
  try {
    if (url.pathname === '/api/config') return json(res, 200, { defaultSource: DEFAULT_SOURCE });
    if (url.pathname === '/api/snapshot') {
      const s = source(src) as Source & { ready?: Promise<void> };
      await s.ready;
      return json(res, 200, s.snapshot());
    }
    if (url.pathname === '/api/history') {
      const key = url.searchParams.get('key') ?? '';
      return json(res, 200, { items: await source(src).history(key) });
    }
    if (url.pathname === '/api/stream') {
      const s = source(src) as Source & { ready?: Promise<void> };
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
      await s.ready;
      res.write(`event: snapshot\ndata: ${JSON.stringify(s.snapshot())}\n\n`);
      const off = s.subscribe((d) => res.write(`event: delta\ndata: ${JSON.stringify(d)}\n\n`));
      const ka = setInterval(() => res.write(': ka\n\n'), 15_000);
      req.on('close', () => { off(); clearInterval(ka); });
      return;
    }
    json(res, 404, { error: 'not found' });
  } catch (e) {
    json(res, 500, { error: (e as Error).message });
  }
});

server.listen(PORT, HOST, () => console.log(`[agent-os api] http://${HOST}:${PORT} (default source: ${DEFAULT_SOURCE})`));
const shutdown = () => { for (const s of sources.values()) s.close(); server.close(); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
