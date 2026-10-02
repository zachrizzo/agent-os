// Dev harness server: serves the built plugin, a mock Control UI host page, the packaged app at
// /agent-os/, and read-only GET proxying of /agent-os/api/* to the local data server (:5198).
import { createServer, request } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.argv[2] ?? 5299);
const cors = { "access-control-allow-origin": "*", "cross-origin-resource-policy": "cross-origin" };
const types = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".woff2": "font/woff2", ".woff": "font/woff", ".png": "image/png", ".svg": "image/svg+xml" };

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://harness");
  if (url.pathname.startsWith("/agent-os/api/")) {
    const up = request({ host: "127.0.0.1", port: 5198, path: url.pathname.slice("/agent-os".length) + url.search, method: "GET" }, (r) => {
      res.writeHead(r.statusCode ?? 502, { ...cors, "content-type": r.headers["content-type"] ?? "application/json" });
      r.pipe(res);
      setTimeout(() => up.destroy(), 20_000);
    });
    up.on("error", () => { res.writeHead(502); res.end(); });
    up.end();
    return;
  }
  let rel = url.pathname === "/" ? "/harness/index.html" : url.pathname;
  if (rel === "/agent-os/") rel = "/app/index.html";
  else if (rel.startsWith("/agent-os/")) rel = "/app/" + rel.slice("/agent-os/".length);
  const file = path.normalize(path.join(root, rel));
  if (!file.startsWith(root + path.sep)) { res.writeHead(404); res.end(); return; }
  try {
    res.writeHead(200, { ...cors, "content-type": types[path.extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
    res.end(await readFile(file));
  } catch { res.writeHead(404); res.end(); }
}).listen(port, "127.0.0.1", () => console.log(`harness on http://127.0.0.1:${port}/`));
