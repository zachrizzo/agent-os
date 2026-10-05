// Dev harness server: serves the built plugin, a mock Control UI host page, the packaged app at
// /agent-os/, and GET proxying of /agent-os/api/* (plus POST /api/send "Message agent" and POST /api/rooms* group rooms incl. /end /continue /wrapup /pin) to the local data server (:5198, or the mock one with --mock).
import { spawn } from "node:child_process";
import { createServer, request } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.argv[2] ?? 5299);
// `--mock`: run the prototype's mock data server on its own port (port + 1000) and proxy to it, so the
// harness never touches a live Gateway or the default :5198 data server.
const mock = process.argv.includes("--mock");
const apiPort = Number(process.env.AGENT_OS_API_PORT) || (mock ? port + 1000 : 5198); // AGENT_OS_API_PORT points the harness at a throwaway data server
if (mock) {
  const proto = path.join(root, "..", "prototype");
  const api = spawn(path.join(proto, "node_modules", ".bin", "tsx"), ["server/index.ts", "--mock"], { cwd: proto, env: { ...process.env, AGENT_OS_API_PORT: String(apiPort) }, stdio: "inherit" });
  const stop = () => { api.kill(); process.exit(0); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  process.on("exit", () => api.kill());
}
const cors = { "access-control-allow-origin": "*", "cross-origin-resource-policy": "cross-origin" };
const types = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".woff2": "font/woff2", ".woff": "font/woff", ".png": "image/png", ".svg": "image/svg+xml" };

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://harness");
  if (url.pathname.startsWith("/agent-os/api/")) {
    const method = req.method === "POST" && (url.pathname === "/agent-os/api/send" || /^\/agent-os\/api\/rooms(\/r[0-9a-f]{8}(\/(send|stop|end|continue|wrapup|pin))?)?$/.test(url.pathname)) ? "POST" : "GET";
    const headers = method === "POST" ? { "content-type": req.headers["content-type"] ?? "", "x-agent-os-send": req.headers["x-agent-os-send"] ?? "" } : {};
    const up = request({ host: "127.0.0.1", port: apiPort, path: url.pathname.slice("/agent-os".length) + url.search, method, headers }, (r) => {
      res.writeHead(r.statusCode ?? 502, { ...cors, "content-type": r.headers["content-type"] ?? "application/json" });
      r.pipe(res);
      setTimeout(() => up.destroy(), 20_000);
    });
    up.on("error", () => { res.writeHead(502); res.end(); });
    if (method === "POST") req.pipe(up); else up.end();
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
