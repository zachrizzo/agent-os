// Returns a reachable harness base URL. If none is serving at `base`, starts serve.mjs --mock on that port
// (own mock data server; never a live Gateway) and stops it when the calling script exits.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const up = async (url) => { try { return (await fetch(url, { signal: AbortSignal.timeout(1500) })).ok; } catch { return false; } };

export async function ensureServer(base = "http://127.0.0.1:5299/") {
  if (await up(base)) return base;
  const port = new URL(base).port || "5299";
  const child = spawn(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), "serve.mjs"), port, "--mock"], { stdio: "ignore" });
  process.on("exit", () => child.kill());
  for (let i = 0; i < 60; i++) {
    // The page must load AND the mock API must be answering through the proxy.
    if ((await up(base)) && (await up(new URL("agent-os/api/config", base).toString()))) return base;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`harness server did not start on ${base}`);
}
