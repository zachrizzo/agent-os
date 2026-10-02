// "Message agent" end-to-end on a THROWAWAY Gateway (temp HOME/state/config, `env -i`, loopback, port in 19400-19499).
// Never touches ~/.openclaw, the live Gateway (18789) or the PHI Gateway (19789); the real data server (:5198) is not used.
//   node harness/live-proof.mjs <screenshot-dir> [port=19450]
// Starts: throwaway Gateway -> its own data server (:port+1) -> harness proxy (:port+2). Creates a test session,
// sends a message from the built UI, and checks the Gateway's chat.history and the UI's Activity feed. Cleans up.
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, chmodSync } from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const OPENCLAW_ROOT = "/Users/zachrizzo/.openclaw/tools/node-v24.21.0/lib/node_modules/openclaw";
const NODE_BIN = path.dirname(process.execPath);
const require = createRequire(OPENCLAW_ROOT + "/");
const { webkit } = require("playwright-core");
const here = path.dirname(fileURLToPath(import.meta.url));
const proto = path.join(here, "..", "..", "prototype");
const outDir = path.resolve(process.argv[2] ?? ".");
const PORT = Number(process.argv[3] ?? 19450);
if (!(PORT >= 19400 && PORT + 2 <= 19499)) throw new Error("port must leave PORT..PORT+2 inside 19400-19499");
const [GW, API, WEB] = [PORT, PORT + 1, PORT + 2];

const listening = (p) => new Promise((r) => { const s = net.connect(p, "127.0.0.1"); s.on("connect", () => { s.destroy(); r(true); }); s.on("error", () => r(false)); });
for (const p of [GW, API, WEB]) if (await listening(p)) throw new Error(`port ${p} already has a listener`);

const work = mkdtempSync("/tmp/agentos-proof.");
mkdirSync(path.join(work, "home")); mkdirSync(path.join(work, "state")); mkdirSync(path.join(work, "bin")); mkdirSync(outDir, { recursive: true });
const token = [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, "0")).join("");
writeFileSync(path.join(work, "openclaw.json"), JSON.stringify({ gateway: { mode: "local", port: GW, bind: "loopback", auth: { mode: "token", token } } }));
chmodSync(path.join(work, "openclaw.json"), 0o600);
const OC = path.join(OPENCLAW_ROOT, "openclaw.mjs");
const isoEnv = { HOME: path.join(work, "home"), OPENCLAW_STATE_DIR: path.join(work, "state"), OPENCLAW_CONFIG_PATH: path.join(work, "openclaw.json"), OPENCLAW_GATEWAY_PORT: String(GW), PATH: `${path.join(work, "bin")}:${NODE_BIN}:/usr/bin:/bin:/usr/sbin:/sbin`, TMPDIR: work };
// `openclaw` shim for the data server (it shells out to `openclaw gateway call`).
writeFileSync(path.join(work, "bin", "openclaw"), `#!/bin/sh\nexec "${process.execPath}" "${OC}" "$@"\n`); chmodSync(path.join(work, "bin", "openclaw"), 0o755);

const kids = [];
const run = (cmd, args, env, cwd, log) => {
  const c = spawn(cmd, args, { env, cwd, stdio: ["ignore", "pipe", "pipe"] });
  let out = ""; c.stdout.on("data", (d) => (out += d)); c.stderr.on("data", (d) => (out += d));
  c.getLog = () => out; kids.push(c); return c;
};
const oc = (...args) => JSON.parse(execFileSync(process.execPath, [OC, "gateway", "call", ...args, "--json", "--timeout", "20000"], { env: isoEnv, encoding: "utf8" }).replace(/^[^{]*/, ""));
const wait = async (fn, what, ms = 60000) => { const t0 = Date.now(); for (;;) { try { const v = await fn(); if (v) return v; } catch { /* retry */ } if (Date.now() - t0 > ms) throw new Error(`timeout: ${what}`); await new Promise((r) => setTimeout(r, 500)); } };

let failed = false;
const check = (name, ok, detail = "") => { if (!ok) failed = true; console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? " · " + detail : ""}`); };

async function cleanup() {
  for (const c of kids) { try { c.kill("SIGTERM"); } catch { /* gone */ } }
  // The Gateway may re-exec detached; stop only a listener on our port that carries this run's temp dir.
  try {
    for (const pid of execFileSync("lsof", ["-t", "-nP", `-iTCP:${GW}`, "-sTCP:LISTEN"], { encoding: "utf8" }).split("\n").filter(Boolean)) {
      const owns = execFileSync("sh", ["-c", `ps -o command= -p ${pid}; lsof -nP -p ${pid} 2>/dev/null`], { encoding: "utf8" }).includes(work);
      if (owns) process.kill(Number(pid), "SIGTERM");
    }
  } catch { /* no listener */ }
  await new Promise((r) => setTimeout(r, 2500));
  rmSync(work, { recursive: true, force: true });
}

try {
  const gw = run(process.execPath, [OC, "gateway", "run", "--port", String(GW), "--bind", "loopback", "--auth", "token", "--allow-unconfigured"], isoEnv, work);
  await wait(() => listening(GW), "throwaway gateway listening", 90000);
  await new Promise((r) => setTimeout(r, 3000));
  console.log(`throwaway Gateway on 127.0.0.1:${GW} (state ${work}/state)`);

  const KEY = "agent:main:proof-target";
  oc("sessions.create", "--params", JSON.stringify({ key: KEY, label: "proof target" }));

  run(path.join(proto, "node_modules", ".bin", "tsx"), ["server/index.ts"], { ...isoEnv, AGENT_OS_API_PORT: String(API), OPENCLAW_BIN: path.join(work, "bin", "openclaw") }, proto);
  run(process.execPath, [path.join(here, "serve.mjs"), String(WEB)], { PATH: process.env.PATH, AGENT_OS_API_PORT: String(API) }, here);
  await wait(async () => (await fetch(`http://127.0.0.1:${WEB}/agent-os/api/config`)).ok, "data server via harness");

  const text = `Proof message from Zach ${Date.now()}: please acknowledge.`;
  const browser = await webkit.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 860 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${WEB}/agent-os/?source=live`);
  await page.waitForSelector(".hist-btn");
  // A turn with no model credentials fails at once, so the target is a finished session: reveal it with History.
  await page.click(".hist-btn");
  const row = page.locator("#rail .row", { hasText: "proof target" }).first();
  await wait(async () => (await row.count()) > 0, "target session in the rail", 30000);
  await row.click();
  await page.waitForSelector(".c-compose:visible");
  check("composer shown for the selected live-source session", (await page.locator(".c-compose textarea").getAttribute("placeholder")).includes("proof target"));
  await page.locator(".c-compose textarea").fill(text);
  await page.keyboard.press("Enter");
  await page.waitForSelector(".c-compose .cmp-status.ok, .c-compose .cmp-status.err", { timeout: 30000 });
  const statusText = await page.locator(".c-compose .cmp-status").innerText();
  check("UI reports the send as delivered", statusText.startsWith("Sent to"), statusText);

  // 1) The Gateway's own transcript for the session.
  const hist = await wait(() => { const h = oc("chat.history", "--params", JSON.stringify({ sessionKey: KEY, limit: 20 })); return h.messages?.some((m) => m.role === "user" && String(m.content).includes(text)) ? h : null; }, "message in chat.history", 20000);
  const um = hist.messages.find((m) => m.role === "user" && String(m.content).includes(text));
  check("Gateway chat.history has the user message", !!um, JSON.stringify({ role: um.role, content: um.content, seq: um.__openclaw?.seq, via: um.__openclaw?.transport?.clients?.[0] }));
  const after = hist.messages.filter((m) => m.__openclaw?.seq > um.__openclaw.seq).map((m) => `${m.role}${m.customType ? "/" + m.customType : ""}: ${String(m.content).slice(0, 110)}`);
  check("the agent run received it (turn started on that session)", after.length > 0 || hist.sessionInfo?.hasActiveRun, after.join(" | ") || "active run");

  // 2) Activity feed: Zach -> agent, once.
  await page.waitForTimeout(1200);
  const evRows = page.locator("#activity .ev", { hasText: text });
  const line = (await evRows.first().locator(".eline").innerText()).replace(/\s+/g, " ");
  check("Activity feed shows You -> agent", /^You\s*→\s*proof target/.test(line), line);
  check("Activity shows it exactly once (no echo from the session preview)", (await evRows.count()) === 1, `${await evRows.count()} row(s)`);
  await page.screenshot({ path: path.join(outDir, "live-1-agent-view-sent.png") });

  // 3) Drawer thread (history from the Gateway) shows the message; composer sends a second one.
  await evRows.first().click();
  await page.waitForSelector("#drawer.open .thread .msg");
  const thread = await page.locator("#drawer .thread").innerText();
  check("drawer thread (Gateway history) shows the message", thread.includes(text));
  const text2 = `Second message via the drawer ${Date.now()}`;
  await page.locator("#drawer .d-compose textarea").fill(text2);
  await page.locator("#drawer .cmp-send").click();
  await page.waitForSelector("#drawer .cmp-status.ok");
  await wait(() => oc("chat.history", "--params", JSON.stringify({ sessionKey: KEY, limit: 20 })).messages.some((m) => m.role === "user" && String(m.content).includes(text2)), "drawer message in chat.history", 20000);
  check("drawer send also lands in chat.history", true);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(outDir, "live-2-drawer-sent.png") });

  // 4) Rail footer counts live sessions only: the finished target is not "erroring" even with History on.
  const foot = await page.locator(".sys-text").innerText();
  check("rail footer ignores finished sessions with History on", !/erroring/.test(foot) || !/^[1-9]\d* agent/.test(foot), foot);

  // 5) Write path is guarded: no header / foreign key refused, nothing reaches the Gateway.
  const guard = await page.evaluate(async () => {
    const u = new URL("api/send?source=live", document.baseURI);
    const a = await fetch(u, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const b = await fetch(u, { method: "POST", headers: { "content-type": "application/json", "x-agent-os-send": "1" }, body: JSON.stringify({ key: "agent:main:main-not-listed", message: "x" }) });
    return [a.status, b.status];
  });
  check("guards: missing header 403, unlisted session 400", guard[0] === 403 && guard[1] === 400, JSON.stringify(guard));
  check("no page errors", errors.length === 0, errors.join("; "));
  await browser.close();
} catch (e) {
  failed = true;
  console.log("FAIL", e.stack ?? e);
} finally {
  await cleanup();
  const left = await listening(GW);
  console.log(`cleanup: gateway port ${GW} ${left ? "STILL LISTENING" : "closed"}, temp dir removed`);
  process.exit(failed || (await listening(GW)) ? 1 : 0);
}
