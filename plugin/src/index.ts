import { readFile } from "node:fs/promises";
import { request, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineFeaturePlugin } from "openclaw/plugin-sdk/feature-plugin";
import { contract } from "./contract.js";

// Serves the built Agent OS app at /agent-os/ on the Gateway origin and proxies its /agent-os/api/* calls to
// the local data server (:5198): GETs for reads (docs reads go through proxyDocs, which adds the guard header), plus the guarded writes POST /api/send ("Message agent") and POST /api/rooms[/:id[/send|/stop|/end|/continue|/wrapup|/pin]] (group rooms).
// The Control UI tab frames it sandboxed (opaque origin), so responses carry permissive CORS.
const ROUTE = "/agent-os";
const API = { host: "127.0.0.1", port: 5198 };
const APP_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "app");
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".woff2": "font/woff2", ".woff": "font/woff", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json",
};
const SEND_PATH = "/api/send";
const ROOMS_WRITE = /^\/api\/rooms(\/r[0-9a-f]{8}(\/(send|stop|end|continue|wrapup|pin))?)?$/; // the only other write route; the data server applies the same header/body guard
const DOCS_PATH = /^\/api\/docs(\/file)?$/; // read-only Markdown viewer; the data server needs the x-agent-os-send header, which this proxy adds (the browser's own copy of it only forces a preflight, answered below)
const SEND_BODY_MAX = 16_384;
const cors = { "Access-Control-Allow-Origin": "*", "Cross-Origin-Resource-Policy": "cross-origin", "X-Content-Type-Options": "nosniff" };

function apiUp(): Promise<boolean> {
  return new Promise((resolve) => {
    const req = request({ ...API, path: "/api/config", method: "GET", timeout: 2000 }, (res) => { res.resume(); resolve(res.statusCode === 200); });
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
    req.end();
  });
}

// The tab's iframe is sandboxed, so its Origin is "null"; a same-origin page is also fine. Any other web origin is refused.
function sendOriginOk(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin || origin === "null") return true;
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}

function proxyWrite(req: IncomingMessage, res: ServerResponse, url: URL, rel: string): boolean {
  const head = { ...cors, "cache-control": "no-store", "content-type": "application/json" };
  if (!sendOriginOk(req)) { res.writeHead(403, head); res.end('{"error":"forbidden origin"}'); return true; }
  if (req.method === "OPTIONS") {
    res.writeHead(204, { ...cors, "access-control-allow-methods": "POST", "access-control-allow-headers": "content-type, x-agent-os-send", "access-control-max-age": "600" });
    res.end();
    return true;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  let over = false;
  req.on("data", (c: Buffer) => { size += c.length; if (size > SEND_BODY_MAX) over = true; else chunks.push(c); });
  req.on("end", () => {
    if (over) { res.writeHead(413, head); res.end('{"error":"body too large"}'); return; }
    const body = Buffer.concat(chunks);
    const up = request({ ...API, path: rel + url.search, method: "POST", headers: { "content-type": "application/json", "x-agent-os-send": "1", "content-length": body.length } }, (r) => {
      res.writeHead(r.statusCode ?? 502, { ...head, "content-type": r.headers["content-type"] ?? "application/json" });
      r.pipe(res);
    });
    up.on("error", () => { if (!res.headersSent) res.writeHead(502, head); res.end('{"error":"agent-os data server unavailable"}'); });
    up.end(body);
  });
  return true;
}

function proxyDocs(req: IncomingMessage, res: ServerResponse, url: URL, rel: string): boolean {
  const head = { ...cors, "cache-control": "no-store", "content-type": "application/json" };
  if (!sendOriginOk(req)) { res.writeHead(403, head); res.end('{"error":"forbidden origin"}'); return true; }
  if (req.method === "OPTIONS") {
    res.writeHead(204, { ...cors, "access-control-allow-methods": "GET", "access-control-allow-headers": "content-type, x-agent-os-send", "access-control-max-age": "600" });
    res.end();
    return true;
  }
  if (req.method !== "GET") { res.writeHead(405, head); res.end('{"error":"method not allowed"}'); return true; }
  const up = request({ ...API, path: rel + url.search, method: "GET", headers: { accept: "application/json", "x-agent-os-send": "1" } }, (r) => {
    res.writeHead(r.statusCode ?? 502, { ...head, "content-type": r.headers["content-type"] ?? "application/json" });
    r.pipe(res);
  });
  up.on("error", () => { if (!res.headersSent) res.writeHead(502, head); res.end('{"error":"agent-os data server unavailable"}'); });
  up.end();
  return true;
}

export default defineFeaturePlugin({
  contract,
  name: "Agent OS",
  description: "God's-eye view of the agent fleet as a Control UI tab.",
  setup(api) {
    api.registerHttpRoute({
      path: ROUTE,
      auth: "plugin",
      match: "prefix",
      handler: async (req, res) => {
        const url = new URL(req.url ?? "/", "http://gateway");
        let rel = url.pathname.slice(ROUTE.length) || "/";
        if ((rel === SEND_PATH || ROOMS_WRITE.test(rel)) && (req.method === "POST" || req.method === "OPTIONS")) return proxyWrite(req, res, url, rel);
        if (DOCS_PATH.test(rel)) return proxyDocs(req, res, url, rel);
        if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405, cors); res.end(); return true; }
        if (rel.startsWith("/api/")) {
          const up = request({ ...API, path: rel + url.search, method: "GET", headers: { accept: req.headers.accept ?? "*/*" } }, (r) => {
            res.writeHead(r.statusCode ?? 502, { ...cors, "content-type": r.headers["content-type"] ?? "application/json", "cache-control": "no-store" });
            r.pipe(res);
          });
          up.on("error", () => { if (!res.headersSent) res.writeHead(502, { ...cors, "content-type": "application/json" }); res.end('{"error":"agent-os data server unavailable"}'); });
          // Cap streams so Gateway plugin reloads can drain; EventSource reconnects on its own.
          const cap = setTimeout(() => { up.destroy(); res.end(); }, 20_000);
          req.on("close", () => { clearTimeout(cap); up.destroy(); });
          res.on("close", () => clearTimeout(cap));
          up.end();
          return true;
        }
        if (rel === "/") rel = "/index.html";
        const file = path.normalize(path.join(APP_DIR, rel));
        if (!file.startsWith(APP_DIR + path.sep)) { res.writeHead(404, cors); res.end(); return true; }
        try {
          const body = await readFile(file);
          res.writeHead(200, { ...cors, "content-type": TYPES[path.extname(file)] ?? "application/octet-stream", "cache-control": rel.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-store" });
          res.end(req.method === "HEAD" ? undefined : body);
        } catch {
          res.writeHead(404, cors); res.end();
        }
        return true;
      },
    });
    return {
      status: async () => ({ up: await apiUp(), url: ROUTE + "/" }),
    };
  },
});
