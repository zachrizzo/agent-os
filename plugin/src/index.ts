import { readFile } from "node:fs/promises";
import { request } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineFeaturePlugin } from "openclaw/plugin-sdk/feature-plugin";
import { contract } from "./contract.js";

// Serves the built Agent OS app at /agent-os/ on the Gateway origin and proxies its read-only
// /agent-os/api/* calls to the local data server (:5198). The Control UI tab frames it sandboxed
// (opaque origin), so responses carry permissive CORS; nothing here mutates state.
const ROUTE = "/agent-os";
const API = { host: "127.0.0.1", port: 5198 };
const APP_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "app");
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".woff2": "font/woff2", ".woff": "font/woff", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json",
};
const cors = { "Access-Control-Allow-Origin": "*", "Cross-Origin-Resource-Policy": "cross-origin", "X-Content-Type-Options": "nosniff" };

function apiUp(): Promise<boolean> {
  return new Promise((resolve) => {
    const req = request({ ...API, path: "/api/config", method: "GET", timeout: 2000 }, (res) => { res.resume(); resolve(res.statusCode === 200); });
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
    req.end();
  });
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
        if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405, cors); res.end(); return true; }
        let rel = url.pathname.slice(ROUTE.length) || "/";
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
