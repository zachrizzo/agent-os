// Council mode end-to-end on a THROWAWAY Gateway (temp HOME/state/config, `env -i`, loopback, ports inside 19400-19499).
// Never touches ~/.openclaw, the live Gateway (18789) or the PHI Gateway (19789). No model credentials exist there: agents are
// answered by harness/stub-llm.mjs, a local OpenAI-compatible server wired in as the Gateway's model provider, so every reply travels
// the real path (sessions.create -> sessions.send -> agent run -> chat.history). The stub only chooses the reply text.
//   node harness/council-proof.mjs <screenshot-dir> [port=19480]    uses PORT..PORT+3 (gateway, data server, harness web, stub)
// Proves: old rooms.json migrates (RFC Council -> rfc-lead captain, maxSteps 3, 2n+2 -> 3n+3), parallel dispatch (overlapping runs), the captain's steering
// (directed follow-up to chosen members only, critique round), ONE synthesized reply, the not-a-loop limits on the real path (step limit, repeat -> no progress,
// malformed decision -> synthesis, hard turn cap), member timeout (run aborted on the Gateway), Stop cancels in-flight runs, @mention bypass,
// persistence across a data-server restart, phi refused.
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, chmodSync, readFileSync, existsSync } from "node:fs";
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
const PORT = Number(process.argv[3] ?? 19480);
if (!(PORT >= 19400 && PORT + 3 <= 19499)) throw new Error("port must leave PORT..PORT+3 inside 19400-19499");
const [GW, API, WEB, STUB] = [PORT, PORT + 1, PORT + 2, PORT + 3];

const listening = (p) => new Promise((r) => { const s = net.connect(p, "127.0.0.1"); s.on("connect", () => { s.destroy(); r(true); }); s.on("error", () => r(false)); });
for (const p of [GW, API, WEB, STUB]) if (await listening(p)) throw new Error(`port ${p} already has a listener`);

const work = mkdtempSync("/tmp/agentos-council.");
for (const d of ["home", "state", "bin"]) mkdirSync(path.join(work, d));
mkdirSync(outDir, { recursive: true });
const token = [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, "0")).join("");
const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
writeFileSync(path.join(work, "openclaw.json"), JSON.stringify({
  gateway: { mode: "local", port: GW, bind: "loopback", auth: { mode: "token", token } },
  agents: {
    defaults: { model: { primary: "stub/echo" } },
    list: [{ id: "rfc-lead", default: true, identity: { name: "RFC Lead", emoji: "🧭" } }, { id: "rfc-skeptic", identity: { name: "RFC Skeptic" } }, { id: "rfc-scribe", identity: { name: "RFC Scribe" } }, { id: "phi", identity: { name: "Phi" } }],
  },
  models: { mode: "merge", providers: { stub: { baseUrl: `http://127.0.0.1:${STUB}/v1`, apiKey: "stub-not-a-credential", api: "openai-completions", models: [{ id: "echo", name: "Echo", reasoning: false, input: ["text"], cost: zero, contextWindow: 32000, maxTokens: 1024 }] } } },
}));
chmodSync(path.join(work, "openclaw.json"), 0o600);
const OC = path.join(OPENCLAW_ROOT, "openclaw.mjs");
const isoEnv = { HOME: path.join(work, "home"), OPENCLAW_STATE_DIR: path.join(work, "state"), OPENCLAW_CONFIG_PATH: path.join(work, "openclaw.json"), OPENCLAW_GATEWAY_PORT: String(GW), PATH: `${path.join(work, "bin")}:${NODE_BIN}:/usr/bin:/bin:/usr/sbin:/sbin`, TMPDIR: work };
writeFileSync(path.join(work, "bin", "openclaw"), `#!/bin/sh\nexec "${process.execPath}" "${OC}" "$@"\n`); chmodSync(path.join(work, "bin", "openclaw"), 0o755);
const ROOMS_FILE = path.join(work, "rooms.json");

const kids = [];
const run = (cmd, args, env, cwd) => { const c = spawn(cmd, args, { env, cwd, stdio: ["ignore", "pipe", "pipe"] }); let out = ""; c.stdout.on("data", (d) => (out += d)); c.stderr.on("data", (d) => (out += d)); c.getLog = () => out; kids.push(c); return c; };
const oc = (...args) => JSON.parse(execFileSync(process.execPath, [OC, "gateway", "call", ...args, "--json", "--timeout", "20000"], { env: isoEnv, encoding: "utf8" }).replace(/^[^{]*/, ""));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const wait = async (fn, what, ms = 60000) => { const t0 = Date.now(); for (;;) { try { const v = await fn(); if (v) return v; } catch { /* retry */ } if (Date.now() - t0 > ms) throw new Error(`timeout: ${what}`); await sleep(400); } };
let failed = false;
const check = (name, ok, detail = "") => { if (!ok) failed = true; console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? " · " + detail : ""}`); };

const startData = () => run(path.join(proto, "node_modules", ".bin", "tsx"), ["server/index.ts"], { ...isoEnv, AGENT_OS_API_PORT: String(API), OPENCLAW_BIN: path.join(work, "bin", "openclaw"), AGENT_OS_ROOMS_FILE: ROOMS_FILE }, proto);
let data;
const web = `http://127.0.0.1:${WEB}/agent-os/api`;
const api = async (p, body, hdr = true) => {
  const r = await fetch(`${web}/${p}${p.includes("?") ? "&" : "?"}source=live`, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json", ...(hdr ? { "x-agent-os-send": "1" } : {}) }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};
const stubStats = async () => (await fetch(`http://127.0.0.1:${STUB}/__stats`)).json();
const roomHist = (agent, id) => oc("chat.history", "--params", JSON.stringify({ sessionKey: `agent:${agent}:room-${id}`, limit: 40 }));
const textOf = (m) => (typeof m.content === "string" ? m.content : (m.content ?? []).map((c) => c.text ?? "").join("\n"));

async function cleanup() {
  for (const c of kids) { try { c.kill("SIGTERM"); } catch { /* gone */ } }
  try {
    for (const pid of execFileSync("lsof", ["-t", "-nP", `-iTCP:${GW}`, "-sTCP:LISTEN"], { encoding: "utf8" }).split("\n").filter(Boolean)) {
      const owns = execFileSync("sh", ["-c", `ps -o command= -p ${pid}; lsof -nP -p ${pid} 2>/dev/null`], { encoding: "utf8" }).includes(work);
      if (owns) process.kill(Number(pid), "SIGTERM");
    }
  } catch { /* no listener */ }
  await sleep(2500);
  rmSync(work, { recursive: true, force: true });
}


const getRoom = async (id) => (await api(`rooms/${id}`)).json;
/** Send, then poll the room while it runs: returns the final view plus every sampled council snapshot (to prove what ran when). */
async function sendAndWatch(id, text, { maxMs = 120000, onSample } = {}) {
  const prev = (await getRoom(id)).run?.id;
  const r = await api(`rooms/${id}/send`, { message: text });
  if (r.status !== 200) throw new Error(`send failed ${r.status} ${JSON.stringify(r.json)}`);
  const samples = [];
  const t0 = Date.now();
  for (;;) {
    const v = await getRoom(id);
    const c = v.room.councils.at(-1);
    if (c) { const s = { t: Date.now() - t0, phase: c.phase, agents: Object.fromEntries(Object.entries(c.agents).map(([k, a]) => [k, a.status])), turns: c.turnsUsed }; samples.push(s); await onSample?.(s, v); }
    if (v.run && v.run.id !== prev && v.run.status !== "running") return { view: v, samples, ms: Date.now() - t0 };
    if (Date.now() - t0 > maxMs) throw new Error("run did not finish");
    await sleep(250);
  }
}
const overlaps = (a, b) => a.at < b.end && b.at < a.end;
const stubSince = async (n) => (await stubStats()).slice(n);
const sessActive = (agent, id) => Boolean(roomHist(agent, id).sessionInfo?.hasActiveRun);

try {
  // The old on-disk format (version 1: no mode / captain / councils), written BEFORE the data server starts.
  const RFC = "rc1cabea9";
  const OLD = { version: 1, rooms: [
    { id: RFC, name: "RFC Council", members: ["rfc-skeptic", "rfc-scribe", "rfc-lead"], archived: false, createdAt: 1, updatedAt: 2, messages: [{ id: "m1", ts: 1, from: "you", text: "earlier question" }, { id: "m2", ts: 2, from: "rfc-skeptic", text: "earlier reply" }], maxRounds: 1, maxTurns: 3, mentionGating: true },
    { id: "r1a2b3c4d", name: "Old other room", members: ["rfc-scribe", "rfc-skeptic"], archived: false, createdAt: 1, updatedAt: 1, messages: [], maxRounds: 2, maxTurns: 5, mentionGating: true },
  ] };
  const oldRaw = JSON.stringify(OLD);
  writeFileSync(ROOMS_FILE, oldRaw, { mode: 0o600 });

  run(process.execPath, [path.join(here, "stub-llm.mjs"), String(STUB)], { PATH: process.env.PATH }, here);
  run(process.execPath, [OC, "gateway", "run", "--port", String(GW), "--bind", "loopback", "--auth", "token", "--allow-unconfigured"], isoEnv, work);
  await wait(() => listening(GW), "throwaway gateway listening", 90000);
  await sleep(3000);
  console.log(`throwaway Gateway 127.0.0.1:${GW}, stub model :${STUB}, data server :${API}, harness :${WEB} (state ${work}/state)`);
  data = startData();
  run(process.execPath, [path.join(here, "serve.mjs"), String(WEB)], { PATH: process.env.PATH, AGENT_OS_API_PORT: String(API) }, here);
  await wait(async () => (await fetch(`${web}/config`)).ok, "data server via harness");

  // ---- migration of an old rooms.json ----
  const roster = (await api("rooms")).json.agents.map((a) => a.id);
  check("agent list from the Gateway excludes phi", [...roster].sort().join(",") === "rfc-lead,rfc-scribe,rfc-skeptic", roster.join(","));
  const rfc = (await getRoom(RFC)).room;
  const other = (await getRoom("r1a2b3c4d")).room;
  check("migration: old RFC Council gets captain rfc-lead (council mode, thread kept)", rfc.captain === "rfc-lead" && rfc.mode === "council" && rfc.messages.length === 2, `captain=${rfc.captain} mode=${rfc.mode} msgs=${rfc.messages.length} maxTurns=${rfc.maxTurns}`);
  check("migration: old turn cap raised to 3n+3 = 12 and maxSteps defaults to 3", rfc.maxTurns === 12 && rfc.maxSteps === 3, `maxTurns=${rfc.maxTurns} maxSteps=${rfc.maxSteps}`);
  check("migration: another old room gets its first member as captain; explicit caps kept (maxSteps still defaulted)", other.captain === "rfc-scribe" && other.maxTurns === 5 && other.maxRounds === 2 && other.maxSteps === 3, `captain=${other.captain}`);
  check("migration: loading did not rewrite the old file", readFileSync(ROOMS_FILE, "utf8") === oldRaw);

  const browser = await webkit.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${WEB}/agent-os/?source=live`);
  await page.waitForSelector(".rooms-btn");
  await page.click(".rooms-btn");
  await page.locator(".rm-row", { hasText: "RFC Council" }).click();
  await page.waitForSelector(".rm-bar h3");
  check("UI: settings show Council mode and rfc-lead as captain", (await page.locator("[data-set=mode]").inputValue()) === "council" && (await page.locator("[data-set=captain]").inputValue()) === "rfc-lead");

  // ---- 1) captain-led council on the migrated room: parallel work, directed follow-up to two members, ONE reply ----
  let before = (await stubStats()).length;
  const DELAY = 1500;
  const cue = `[[delay:rfc-lead=${DELAY}]][[delay:rfc-skeptic=${DELAY}]][[delay:rfc-scribe=${DELAY}]]`;
  let sawParallel = false;
  let shot = false;
  const r1 = await sendAndWatch(RFC, `${cue} Should we ship the RFC this week? conflict`, {
    onSample: async (s) => {
      if (Object.values(s.agents).filter((x) => x === "working").length >= 2) sawParallel = true;
      if (!shot && s.phase === "working") { shot = true; await page.waitForTimeout(1200); await page.screenshot({ path: path.join(outDir, "council-1-live-working.png") }); }
    },
  });
  const st1 = await stubSince(before);
  const roleOf = (r) => st1.filter((x) => x.role === r);
  check("flow ran: 1 plan, 3 specialist, 2 captain decisions, 2 follow-ups, 1 synthesize model turns (9 total)", roleOf("CAPTAIN-PLAN").length === 1 && roleOf("SPECIALIST").length === 3 && roleOf("CAPTAIN-STEER").length === 2 && roleOf("FOLLOW-UP").length === 2 && roleOf("CRITIQUE").length === 0 && roleOf("CAPTAIN-SYNTHESIZE").length === 1 && st1.length === 9, st1.map((x) => `${x.agent}:${x.role}`).join(" "));
  check("plan was made by the captain rfc-lead", roleOf("CAPTAIN-PLAN")[0].agent === "rfc-lead");
  const sp = roleOf("SPECIALIST");
  const allOverlap = sp.every((a, i) => sp.every((b, j) => i === j || overlaps(a, b)));
  const span = Math.max(...sp.map((x) => x.end)) - Math.min(...sp.map((x) => x.at));
  check("PARALLEL dispatch: all 3 specialist model runs overlap in time", allOverlap && sp.every((x) => x.end), `intervals ms-since-first: ${sp.map((x) => `${x.agent}[${x.at - sp[0].at}..${x.end - sp[0].at}]`).join(" ")}`);
  check(`parallel wall time ~${DELAY}ms, not 3x (${3 * DELAY}ms sequential)`, span < DELAY * 2, `${span}ms for the whole working phase`);
  check("the room view sampled 2+ agents 'working' at the same moment", sawParallel);
  const fu = roleOf("FOLLOW-UP");
  check("captain-directed follow-up went ONLY to the two members it named (rfc-lead was not asked), in parallel, after the work phase", fu.map((x) => x.agent).sort().join(",") === "rfc-scribe,rfc-skeptic" && overlaps(fu[0], fu[1]) && Math.min(...fu.map((x) => x.at)) >= Math.max(...sp.map((x) => x.end)) - 5, fu.map((x) => `${x.agent}[${x.at - sp[0].at}..${x.end - sp[0].at}]`).join(" "));
  const steer = roleOf("CAPTAIN-STEER");
  check("both decisions were the captain's (rfc-lead): decision 1 before the follow-ups, decision 2 after", steer.every((x) => x.agent === "rfc-lead") && steer[0].end <= Math.min(...fu.map((x) => x.at)) + 5 && steer[1].at >= Math.max(...fu.map((x) => x.end)) - 5);
  check("synthesis came after the second decision", roleOf("CAPTAIN-SYNTHESIZE")[0].at >= steer[1].end - 5);
  const room1 = r1.view.room;
  const thread = room1.messages.slice(2).filter((m) => m.from !== "system");
  check("ONE synthesized captain reply in the thread (You, then rfc-lead only)", thread.map((m) => m.from).join(",") === "you,rfc-lead" && thread[1].council === room1.councils.at(-1).id, thread.map((m) => m.from).join(","));
  check("reply says which disagreements were resolved and the trade-off", /Disagreements resolved/.test(thread[1].text) && /Your call/.test(thread[1].text), thread[1].text.replace(/\n+/g, " | ").slice(0, 160));
  const c1 = room1.councils.at(-1);
  check("council recorded: plan, answers, the decision, follow-ups, final id", c1.phase === "done" && c1.plan && !c1.plan.fallback && c1.notes.filter((n) => n.kind === "answer").length === 3 && c1.notes.filter((n) => n.kind === "decision").length === 1 && c1.notes.filter((n) => n.kind === "followup").length === 2 && c1.finalId === thread[1].id, `${c1.notes.length} notes, turns ${c1.turnsUsed}/${c1.maxTurns}`);
  check("captain step trace: step 1 asked rfc-skeptic+rfc-scribe (answered); stop reason = done", c1.steps?.length === 1 && c1.steps[0].action === "ask" && c1.steps[0].targets.join(",") === "rfc-skeptic,rfc-scribe" && c1.steps[0].outcome === "answered" && c1.stop?.reason === "done" && c1.maxSteps === 3, JSON.stringify({ steps: c1.steps, stop: c1.stop }));
  check("turn accounting: 9 of maxTurns 12", c1.turnsUsed === 9 && c1.maxTurns === 12 && r1.view.run.turnsUsed === 9 && r1.view.run.steps === 1 && r1.view.run.maxSteps === 3);
  const hs = roomHist("rfc-skeptic", RFC);
  const prompts = hs.messages.filter((m) => m.role === "user").map(textOf);
  check("protocol is injected into the agent's room session (roles + captain), no AGENTS.md involved", prompts.some((t) => /Council role: SPECIALIST/.test(t) && /Your sub-question:/.test(t)) && prompts.some((t) => /Council role: FOLLOW-UP/.test(t) && /The captain's question:/.test(t)));
  check("rfc-lead's room session never saw a follow-up (members cannot route)", !roomHist("rfc-lead", RFC).messages.map(textOf).some((t) => /Council role: FOLLOW-UP/.test(t)));
  check("agents' MAIN sessions untouched", (oc("chat.history", "--params", JSON.stringify({ sessionKey: "agent:rfc-lead:main", limit: 5 })).messages ?? []).length === 0);
  await page.waitForFunction(() => document.querySelector(".rm-msg.captain:not(.pending)") && !document.querySelector(".rm-compose .rm-typing"), null, { timeout: 20000 });
  check("UI: thread shows You + ONE captain reply; panel collapsed once done", (await page.locator(".rm-msg.captain").count()) === 1 && (await page.locator(".rm-council").getAttribute("open")) === null);
  await page.screenshot({ path: path.join(outDir, "council-2-done-collapsed.png") });
  await page.locator(".rm-council > summary").click();
  await page.waitForSelector(".rm-council[open] .rm-note");
  check("UI: panel shows the captain's decision row, 'step 1/3' and why it stopped", (await page.locator(".rm-note.decision").count()) === 1 && /step 1\/3/.test(await page.locator(".rm-council > summary").innerText()) && /stopped: done/.test(await page.locator(".rm-cstop").innerText()), (await page.locator(".rm-note.decision .rm-note-text").first().innerText()).slice(0, 120));
  await page.screenshot({ path: path.join(outDir, "council-3-done-expanded.png") });

  // ---- 2) timeout path ----
  await api(`rooms/${RFC}`, { memberTimeoutSec: 5 });
  before = (await stubStats()).length;
  const r2 = await sendAndWatch(RFC, `[[delay:rfc-skeptic=60000]] Timeout drill: any blockers? crit`);
  const st2 = await stubSince(before);
  const c2 = r2.view.room.councils.at(-1);
  check("timeout: the slow member is marked timed out, the others done", c2.agents["rfc-skeptic"].status === "timeout" && c2.agents["rfc-lead"].status === "done" && c2.agents["rfc-scribe"].status === "done", JSON.stringify(Object.fromEntries(Object.entries(c2.agents).map(([k, a]) => [k, a.status]))));
  check("timeout: the captain proceeded (one reply) well before the slow agent's 60s", c2.phase === "done" && r2.ms < 45000 && r2.view.room.messages.filter((m) => m.council === c2.id).length === 1, `${r2.ms}ms`);
  check("timeout: the captain's critique step ran only for the members that answered; synthesis names who timed out", st2.filter((x) => x.role === "CRITIQUE").length === 2 && c2.notes.some((n) => n.agent === "rfc-skeptic" && /Timed out/.test(n.text)));
  const slow = st2.find((x) => x.agent === "rfc-skeptic" && x.role === "SPECIALIST");
  await sleep(1500);
  check("timeout: the slow member's model run was aborted on the Gateway (request cancelled, session idle)", (await stubStats()).slice(before).find((x) => x.agent === "rfc-skeptic" && x.role === "SPECIALIST").aborted === true && !sessActive("rfc-skeptic", RFC), `aborted=${(await stubStats()).slice(before).find((x) => x.agent === "rfc-skeptic")?.aborted}`);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(outDir, "council-4-timeout.png") });

  // ---- 3) Stop cancels in-flight runs ----
  await api(`rooms/${RFC}`, { memberTimeoutSec: 120 });
  before = (await stubStats()).length;
  const stopT0 = Date.now();
  const stopRes = await sendAndWatch(RFC, `[[delay:rfc-skeptic=90000]][[delay:rfc-scribe=90000]] Stop drill`, {
    onSample: async (s, v) => { if (s.phase === "working" && s.agents["rfc-skeptic"] === "working" && s.agents["rfc-scribe"] === "working" && !v.stopped) { v.stopped = true; await sleep(1500); await api(`rooms/${RFC}/stop`, {}); } },
  });
  const st3 = await stubSince(before);
  const c3 = stopRes.view.room.councils.at(-1);
  await sleep(2500);
  const st3b = await stubSince(before);
  check("Stop: run ended 'stopped' quickly, council marked stopped, no captain reply", stopRes.view.run.status === "stopped" && c3.phase === "stopped" && !c3.finalId && Date.now() - stopT0 < 40000, `${Date.now() - stopT0}ms`);
  check("Stop: both in-flight model runs were cancelled on the Gateway and their sessions are idle", ["rfc-skeptic", "rfc-scribe"].every((a) => st3b.find((x) => x.agent === a && x.role === "SPECIALIST")?.aborted) && !sessActive("rfc-skeptic", RFC) && !sessActive("rfc-scribe", RFC), st3b.map((x) => `${x.agent}:${x.role}:${x.aborted ? "aborted" : "done"}`).join(" "));
  check("Stop: nothing further was dispatched (no critique/synthesis)", !st3b.some((x) => x.role === "CRITIQUE" || x.role === "CAPTAIN-SYNTHESIZE"));
  check("Stop: statuses show stopped; thread has the cancel note", c3.agents["rfc-skeptic"].status === "stopped" && stopRes.view.room.messages.some((m) => m.from === "system" && /council was cancelled/.test(m.text)));
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(outDir, "council-5-stopped.png") });

  // ---- 4) @mention bypass ----
  await api(`rooms/${RFC}`, { memberTimeoutSec: 90 });
  before = (await stubStats()).length;
  const councilsBefore = (await getRoom(RFC)).room.councils.length;
  const r4 = await sendAndWatch(RFC, "@rfc-skeptic quick gut check on the rollback?");
  const st4 = await stubSince(before);
  const tail4 = r4.view.room.messages.slice(-2);
  check("@mention bypass: exactly ONE model turn, to rfc-skeptic, with no council role", st4.length === 1 && st4[0].agent === "rfc-skeptic" && st4[0].role === null, st4.map((x) => `${x.agent}:${x.role}`).join(" "));
  check("@mention bypass: reply shows in the thread as rfc-skeptic; no new council", tail4.map((m) => m.from).join(",") === "you,rfc-skeptic" && r4.view.room.councils.length === councilsBefore);

  // ---- 4b) the not-a-loop limits on the real path (stub captain driven by cues in the message) ----
  const drill = async (text, label) => {
    const b = (await stubStats()).length;
    const r = await sendAndWatch(RFC, text);
    const st = await stubSince(b);
    const c = r.view.room.councils.at(-1);
    const rl = (x) => st.filter((y) => y.role === x).length;
    console.log(`     ${label}: ${st.map((x) => `${x.agent.replace("rfc-", "")}:${x.role}`).join(" ")} | steps ${JSON.stringify((c.steps ?? []).map((x) => `${x.step}:${x.action}:${x.targets.join("+")}:${x.outcome}`))} | stop ${c.stop?.reason} (${c.stop?.detail ?? ""}) | turns ${c.turnsUsed}/${c.maxTurns}`);
    return { r, st, c, rl };
  };
  const dEnd = await drill("endless: keep going", "endless");
  check("step limit: a captain that never stops is cut at 3 decisions, then ONE synthesis (turns <= maxTurns)", dEnd.c.stop?.reason === "stepLimit" && dEnd.c.steps.length === 3 && dEnd.rl("CAPTAIN-STEER") === 3 && dEnd.rl("FOLLOW-UP") === 3 && dEnd.rl("CAPTAIN-SYNTHESIZE") === 1 && dEnd.st.at(-1).role === "CAPTAIN-SYNTHESIZE" && dEnd.c.turnsUsed === dEnd.st.length && dEnd.st.length <= dEnd.c.maxTurns && dEnd.r.view.room.messages.filter((m) => m.council === dEnd.c.id).length === 1, `${dEnd.st.length} turns, stop=${dEnd.c.stop?.reason}`);
  await page.waitForFunction(() => document.querySelectorAll(".rm-council").length >= 4, null, { timeout: 20000 });
  await page.locator(".rm-council").last().locator("summary").click();
  check("UI: the endless run's panel lists 3 decisions and 'stopped: step limit'", (await page.locator(".rm-council").last().locator(".rm-note.decision").count()) === 3 && /stopped: step limit/.test(await page.locator(".rm-council").last().locator(".rm-cstop").innerText()));
  await page.screenshot({ path: path.join(outDir, "council-7-step-limit.png") });
  const dRep = await drill("repeat: same question again", "repeat");
  check("repeat: the same question to the same member twice -> no progress, synthesis (the repeat was never sent)", dRep.c.stop?.reason === "noProgress" && dRep.rl("FOLLOW-UP") === 1 && dRep.rl("CAPTAIN-STEER") === 2 && dRep.st.at(-1).role === "CAPTAIN-SYNTHESIZE" && dRep.c.steps.at(-1).outcome === "repeat", dRep.c.stop?.detail);
  const dPass = await drill("allpass: anything?", "allpass");
  check("all-PASS: every asked member replies PASS -> no progress, synthesis, no further decision", dPass.c.stop?.reason === "noProgress" && dPass.rl("CAPTAIN-STEER") === 1 && dPass.rl("FOLLOW-UP") === 2 && dPass.st.at(-1).role === "CAPTAIN-SYNTHESIZE", dPass.c.stop?.detail);
  const dBad = await drill("badsteer: wrap it up", "badsteer");
  check("malformed decision (prose) -> synthesis, exactly one decision turn, no retry", dBad.c.stop?.reason === "malformed" && dBad.rl("CAPTAIN-STEER") === 1 && dBad.rl("FOLLOW-UP") === 0 && dBad.st.at(-1).role === "CAPTAIN-SYNTHESIZE");
  const dMem = await drill("routeme: hello", "routeme");
  check("members @mentioning each other start nothing (no extra turns); the captain stopped after one decision", dMem.st.length === 6 && dMem.rl("SPECIALIST") === 3 && dMem.c.stop?.reason === "done" && dMem.c.notes.filter((n) => n.kind === "answer").every((n) => /@rfc-/.test(n.text)));
  await api(`rooms/${RFC}`, { maxTurns: 7 });
  const dCap = await drill("endless: with a tight cap", "endless @ maxTurns 7");
  check("hard cap: maxTurns 7 stops the steering and STILL synthesizes (one reply, 7 turns, stop reason cap)", dCap.c.stop?.reason === "cap" && dCap.st.length <= 7 && dCap.st.at(-1).role === "CAPTAIN-SYNTHESIZE" && dCap.r.view.room.messages.filter((m) => m.council === dCap.c.id).length === 1 && dCap.r.view.run.stopReason === "maxTurns", `${dCap.st.length} turns, stop=${dCap.c.stop?.reason}`);
  await api(`rooms/${RFC}`, { maxTurns: 12 });
  const planB = (await getRoom(RFC)).room;
  check("settings: maxSteps is editable and clamped 1-4 through the API", (await api(`rooms/${RFC}`, { maxSteps: 9 })).json.room.maxSteps === 4 && (await api(`rooms/${RFC}`, { maxSteps: 3 })).json.room.maxSteps === 3 && planB.maxTurns === 12);

  // ---- 5) persistence across a data-server restart ----
  const beforeRestart = await getRoom(RFC);
  data.kill("SIGTERM");
  await sleep(1000);
  data = startData();
  await wait(async () => (await fetch(`${web}/config`)).ok, "data server restart");
  const back = await getRoom(RFC);
  check("restart: same thread, plan, notes and final answers", JSON.stringify(back.room.messages) === JSON.stringify(beforeRestart.room.messages) && JSON.stringify(back.room.councils) === JSON.stringify(beforeRestart.room.councils) && back.room.councils.length === 9, `${back.room.messages.length} msgs, ${back.room.councils.length} councils`);
  const saved = JSON.parse(readFileSync(ROOMS_FILE, "utf8"));
  check("rooms.json is 0600, version 2, and now carries the captain for BOTH migrated rooms", execFileSync("stat", ["-f", "%Lp", ROOMS_FILE], { encoding: "utf8" }).trim() === "600" && saved.version === 2 && saved.rooms.find((r) => r.id === RFC)?.captain === "rfc-lead" && saved.rooms.find((r) => r.id === "r1a2b3c4d")?.captain === "rfc-scribe");
  await page.reload();
  await page.click(".rooms-btn");
  await page.locator(".rm-row", { hasText: "RFC Council" }).click();
  await page.waitForSelector(".rm-msg.captain");
  check("restart: UI reload shows the same captain replies and Council panels", (await page.locator(".rm-msg.captain").count()) === 8 && (await page.locator(".rm-council").count()) === 9, `${await page.locator(".rm-msg.captain").count()} replies, ${await page.locator(".rm-council").count()} panels`);
  check("restart: finished panels are collapsed by default", (await page.locator(".rm-council[open]").count()) === 0);
  await page.screenshot({ path: path.join(outDir, "council-6-after-restart.png") });

  // ---- 6) phi stays excluded; guards unchanged ----
  const phiCreate = await api("rooms", { name: "x", members: ["phi"] });
  const phiSend = await api("send", { key: "agent:phi:main", message: "hello" });
  const noHdr = (await api("rooms", { name: "x", members: ["rfc-lead"] }, false)).status;
  const badCaptain = (await api(`rooms/${RFC}`, { captain: "phi" })).status;
  check("phi refused (create 400, send 400, captain 400); no header 403", phiCreate.status === 400 && phiSend.status === 400 && badCaptain === 400 && noHdr === 403, JSON.stringify([phiCreate.status, phiSend.status, badCaptain, noHdr]));
  check("the stub model never served phi", !(await stubStats()).some((s) => s.agent === "phi"));
  check("no page errors", errors.length === 0, errors.join("; "));
  await browser.close();
} catch (e) {
  failed = true;
  console.log("FAIL", e.stack ?? e);
  try { const l = (await api("rooms")).json; for (const r of l.rooms) console.log("room", JSON.stringify((await api(`rooms/${r.id}`)).json).slice(0, 2500)); console.log("stub", JSON.stringify(await stubStats()).slice(0, 1500)); } catch { /* best effort */ }
  for (const c of kids.slice(0, 3)) console.log("--- log tail:\n" + c.getLog().split("\n").slice(-8).join("\n"));
} finally {
  await cleanup();
  const left = (await Promise.all([GW, API, WEB, STUB].map(listening))).some(Boolean);
  console.log(`cleanup: ports ${GW}-${STUB} ${left ? "STILL LISTENING" : "closed"}, temp dir ${existsSync(work) ? "STILL THERE" : "removed"}`);
  process.exit(failed || left ? 1 : 0);
}
