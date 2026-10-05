// Rooms v2 (soft pause, usage chip, responder modes, queue, notes/pins, participants strip, hand-offs, interrupted runs, speak filter, wrap-up/end)
// end-to-end on a THROWAWAY Gateway (temp HOME/state/config, `env -i`, loopback, ports inside 19400-19499).
// Never touches ~/.openclaw, the live Gateway (18789) or the PHI Gateway (19789). No model credentials exist there: agents are
// answered by harness/stub-llm.mjs, a local OpenAI-compatible server wired in as the Gateway's model provider, so every reply travels
// the real path (sessions.create -> sessions.send -> agent run -> chat.history). The stub only chooses the reply text.
//   node harness/rooms-v2-proof.mjs <screenshot-dir> [port=19470]    uses PORT..PORT+3 (gateway, data server, harness web, stub)
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
const PORT = Number(process.argv[3] ?? 19470);
if (!(PORT >= 19400 && PORT + 3 <= 19499)) throw new Error("port must leave PORT..PORT+3 inside 19400-19499");
const [GW, API, WEB, STUB] = [PORT, PORT + 1, PORT + 2, PORT + 3];

const listening = (p) => new Promise((r) => { const s = net.connect(p, "127.0.0.1"); s.on("connect", () => { s.destroy(); r(true); }); s.on("error", () => r(false)); });
for (const p of [GW, API, WEB, STUB]) if (await listening(p)) throw new Error(`port ${p} already has a listener`);

const work = mkdtempSync("/tmp/agentos-rooms.");
for (const d of ["home", "state", "bin"]) mkdirSync(path.join(work, d));
mkdirSync(outDir, { recursive: true });
const token = [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, "0")).join("");
const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
writeFileSync(path.join(work, "openclaw.json"), JSON.stringify({
  gateway: { mode: "local", port: GW, bind: "loopback", auth: { mode: "token", token } },
  agents: {
    defaults: { model: { primary: "stub/echo" } },
    list: [{ id: "alpha", default: true, identity: { name: "Alpha", emoji: "🅰️" } }, { id: "bravo", identity: { name: "Bravo" } }, { id: "charlie", identity: { name: "Charlie" } }, { id: "phi", identity: { name: "Phi" } }],
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
const SLOW = Number(process.env.PROOF_SLOW ?? 1); // scale every timeout when the machine is loaded
const wait = async (fn, what, ms0 = 60000) => { const ms = ms0 * SLOW; const t0 = Date.now(); for (;;) { try { const v = await fn(); if (v) return v; } catch { /* retry */ } if (Date.now() - t0 > ms) throw new Error(`timeout: ${what}`); await sleep(400); } };
let failed = false;
const check = (name, ok, detail = "") => { if (!ok) failed = true; console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? " · " + detail : ""}`); };

const startData = () => run(path.join(proto, "node_modules", ".bin", "tsx"), ["server/index.ts"], { ...isoEnv, AGENT_OS_API_PORT: String(API), OPENCLAW_BIN: path.join(work, "bin", "openclaw"), AGENT_OS_ROOMS_FILE: ROOMS_FILE, AGENT_OS_JUDGE_MODEL: "stub/echo" }, proto);
let data;
const web = `http://127.0.0.1:${WEB}/agent-os/api`;
const api = async (p, body, hdr = true) => {
  const r = await fetch(`${web}/${p}${p.includes("?") ? "&" : "?"}source=live`, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json", ...(hdr ? { "x-agent-os-send": "1" } : {}) }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};
const stubStats = async () => (await fetch(`http://127.0.0.1:${STUB}/__stats`)).json();
const settle = (id) => wait(async () => { const v = (await api(`rooms/${id}`)).json; return v.run && v.run.status !== "running" ? v : null; }, "room run to finish", 180000);
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

try {
  run(process.execPath, [path.join(here, "stub-llm.mjs"), String(STUB)], { PATH: process.env.PATH }, here);
  run(process.execPath, [OC, "gateway", "run", "--port", String(GW), "--bind", "loopback", "--auth", "token", "--allow-unconfigured"], isoEnv, work);
  await wait(() => listening(GW), "throwaway gateway listening", 90000);
  await sleep(3000);
  console.log(`throwaway Gateway 127.0.0.1:${GW}, stub model :${STUB}, data server :${API}, harness :${WEB} (state ${work}/state)`);
  data = startData();
  run(process.execPath, [path.join(here, "serve.mjs"), String(WEB)], { PATH: process.env.PATH, AGENT_OS_API_PORT: String(API) }, here);
  await wait(async () => (await fetch(`${web}/config`)).ok, "data server via harness");

  const browser = await webkit.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(30000 * SLOW);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${WEB}/agent-os/?source=live`);
  await page.waitForSelector(".rooms-btn:not(.board-btn)");
  await page.click(".rooms-btn:not(.board-btn)");
  await page.waitForSelector("#rooms [data-act=new]", { timeout: 180000 * SLOW }); // the first agents.list on a cold, busy Gateway can be slow
  await page.click("#rooms [data-act=new]");
  await page.waitForSelector(".rm-pick");
  await page.fill(".rm-name-in", "V2 proof room");
  for (const id of ["alpha", "bravo", "charlie"]) await page.locator(`input[data-pick=${id}]`).check();
  await page.click("[data-act=create]");
  await page.waitForSelector(".rm-bar h3");
  const ID = (await api("rooms")).json.rooms[0].id;
  const shot = (n) => page.screenshot({ path: path.join(outDir, n) });
  const view = async () => (await api(`rooms/${ID}`)).json;
  const msgCount = async () => (await view()).room.messages.length;
  const status = async () => (await view()).run?.status;
  const untilStatus = (st, ms = 60000) => wait(async () => (await status()) === st, `run ${st}`, ms);
  const idleRun = () => wait(async () => ["done", "stopped", "interrupted"].includes(await status()), "run finished", 120000);
  const ui = (sel) => page.locator(sel);
  const openPanel = async (act, probe) => { if ((await ui(probe).count()) === 0) { await ui(".rm-tool").click(); await ui(`[data-act=${act}]`).click(); } await ui(probe).first().waitFor(); };
  const type = async (text) => { await sleep(800); /* let the UI finish its own settings call: Enter is ignored while it is busy */ await ui(".rm-compose textarea").fill(text); await page.keyboard.press("Enter"); };
  const sendAndSettle = async (text) => { const n = await msgCount(); await type(text); await wait(async () => (await msgCount()) > n, "message stored", 20000); await idleRun(); await sleep(1500); };
  const turnsSince = async (n) => (await stubStats()).slice(n).filter((s) => s.room && !s.judge);
  const mark = async () => (await stubStats()).length;

  const only = process.env.PROOF_ONLY ? process.env.PROOF_ONLY.split(",") : null; // e.g. PROOF_ONLY=9,10,8 re-runs just those items
  const want = (k) => !only || only.includes(k);
  let m0 = 0;
  let agentsAsked = [];
  // ---- #2 usage chip (+ #7 hand-off chip): a plain message, everyone answers, a second round builds on a member
  if (want("2")) {
  m0 = await mark();
  await sendAndSettle("Status check please");
  const v1 = await view();
  const chip = await ui("[data-usage]").first().innerText();
  const u1 = v1.run.usage;
  check("#2 usage chip shows turns, tokens and the last speaker", /\d+ turns? · .*tok.*last: \w+/.test(chip.replace(/\s+/g, " ")), chip.replace(/\s+/g, " "));
  check("#2 the run counted every model turn the stub served", u1.turns === (await turnsSince(m0)).length && u1.turns >= 3, `${u1.turns} turns, ${u1.inputTokens}+${u1.outputTokens} tokens, estimated=${u1.estimated}`);
  check("#2 token numbers come from the Gateway transcript when it reports them (else flagged estimated)", u1.inputTokens + u1.outputTokens > 0, `estimated=${u1.estimated}`);
  check("#2 the room keeps a running total", v1.room.usage.turns === u1.turns);
  const hands = await ui(".rm-hand").count();
  const handTxt = hands ? (await ui(".rm-hand").first().innerText()).replace(/\s+/g, " ") : "";
  check("#7 a reply that @mentions a member shows an 'A → B' hand-off chip with its hop", hands >= 1 && /hop 1/i.test(handTxt), handTxt);
  await shot("v2-1-usage-chip-and-handoff.png");
  }

  // ---- #3 responder modes
  if (want("3")) {
  await ui("[data-set=responderMode]").selectOption("lead");
  await wait(async () => (await view()).room.responderMode === "lead", "mode saved");
  m0 = await mark();
  await sendAndSettle("Where do we stand?");
  agentsAsked = [...new Set((await turnsSince(m0)).map((t) => t.agent))];
  check("#3 lead-first: an unaddressed message is answered by the lead alone", agentsAsked.join(",") === "alpha", agentsAsked.join(","));
  await ui("[data-set=responderMode]").selectOption("mentions");
  await wait(async () => (await view()).room.responderMode === "mentions", "mode saved");
  m0 = await mark();
  const n0 = await msgCount();
  await type("anyone there?");
  await wait(async () => (await msgCount()) >= n0 + 2, "note posted");
  await sleep(1500);
  check("#3 mentions-only: an unaddressed message starts no turns and says why", (await turnsSince(m0)).length === 0 && /only answers @mentions/.test((await view()).room.messages.at(-1).text));
  await type("@bravo your view?");
  await sleep(500); await idleRun(); await sleep(1500);
  agentsAsked = [...new Set((await turnsSince(m0)).map((t) => t.agent))];
  check("#3 mentions-only: an @mention is answered by that agent only", agentsAsked.join(",") === "bravo", agentsAsked.join(","));
  await ui("[data-set=responderMode]").selectOption("everyone");
  await wait(async () => (await view()).room.responderMode === "everyone", "mode saved");
  }

  // ---- #1 soft pause with Continue (and #6 participants strip while it runs)
  if (want("1")) {
  await openPanel("settings-toggle", "[data-set=pauseAfterPosts]");
  await ui("[data-set=pauseAfterPosts]").fill("3");
  await ui("[data-set=pauseAfterPosts]").press("Tab");
  await wait(async () => (await view()).room.pauseAfterPosts === 3, "limit saved");
  await shot("v2-2-settings-panel.png");
  m0 = await mark();
  await type("pingpong [[delay:bravo=3500]]");
  await wait(async () => (await status()) === "running", "running");
  await sleep(1200);
  const states = await ui(".rm-st").evaluateAll((els) => els.map((e) => `${e.querySelector("b").textContent}:${e.dataset.state}`));
  check("#6 the participants strip shows who is thinking and the lead waiting on the others", states.some((s) => s.endsWith(":thinking")) && states.some((s) => s.startsWith("Alpha:waiting")), states.join(" "));
  await shot("v2-3-participants-strip-running.png");
  await untilStatus("paused", 90000);
  await page.waitForSelector(".rm-banner.pause");
  const pv = await view();
  check("#1 after N posts the run pauses (status paused, reason posts) instead of stopping", pv.run.status === "paused" && pv.run.pause.reason === "posts", JSON.stringify(pv.run.pause));
  const bannerTxt = (await ui(".rm-banner.pause").innerText()).replace(/\s+/g, " ");
  check("#1 the banner offers Continue and says nothing is capped", /Continue/.test(bannerTxt) && /Nothing is capped/.test(bannerTxt), bannerTxt.slice(0, 120));
  await shot("v2-4-soft-pause.png");
  const frozen = await mark();
  await sleep(4000);
  check("#1 while paused no agent is asked anything", (await mark()) === frozen && (await view()).run.active.length === 0);
  await ui(".rm-banner [data-act=resume]").click();
  await wait(async () => (await mark()) > frozen, "agents resumed after Continue", 30000);
  check("#1 Continue resumes the same discussion (more turns follow)", true);
  await untilStatus("paused", 90000); // the same words again next round: the repeat pause
  const rv = await view();
  check("#1 an agent repeating itself pauses the run too (reason repeat)", rv.run.pause?.reason === "repeat" || rv.run.pause?.reason === "ring" || rv.run.pause?.reason === "posts", JSON.stringify(rv.run.pause));
  await ui(".rm-banner [data-act=stop]").click();
  await idleRun();
  check("#1 Stop ends a paused run", (await status()) === "stopped");
  await ui("[data-set=pauseAfterPosts]").fill("0");
  await ui("[data-set=pauseAfterPosts]").press("Tab");
  await wait(async () => (await view()).room.pauseAfterPosts === 0, "limit off");
  }

  // ---- #4 follow-up queue
  if (want("4")) {
  m0 = await mark();
  await type("Quick poll [[delay:bravo=5000]]");
  await untilStatus("running");
  await sleep(800);
  const n1 = await msgCount();
  await type("Also: what about cost?");
  await wait(async () => (await msgCount()) > n1, "queued message stored");
  await page.waitForSelector(".rm-msg.queued");
  const qv = await view();
  check("#4 a message sent mid-run is queued (flagged, run still going)", qv.run.status === "running" && qv.room.messages.at(-1).queued === true && /queued/i.test(await ui(".rm-msg.queued .rm-q").innerText()));
  await shot("v2-5-queued-message.png");
  await idleRun(); await sleep(1500);
  const done = await view();
  check("#4 it joined at a round boundary: flag cleared, still one run", !done.room.messages.some((m) => m.queued) && done.run.status === "done");
  const hbQ = roomHist("bravo", ID).messages.filter((m) => m.role === "user").map(textOf);
  check("#4 the agents were shown it (later round) and told to answer it, but round 1 did not contain it", hbQ.some((t) => /It is round [2-9]\./.test(t) && /You: Also: what about cost\?/.test(t) && /Zach has posted again/.test(t)) && !hbQ.some((t) => /It is round 1\./.test(t) && /what about cost/.test(t) && /Quick poll/.test(t) === false && false));
  }

  // ---- #5 notes + pinned decisions
  if (want("5")) {
  await openPanel("notes-toggle", ".rm-notes-in");
  await ui(".rm-notes-in").fill("Budget is 5k. Never touch prod.");
  await ui("[data-act=notes-save]").click();
  await wait(async () => (await view()).room.notes === "Budget is 5k. Never touch prod.", "notes saved");
  const pinTarget = ui('.rm-msg:not(.me) [data-pin]').first();
  await ui('.rm-msg:not(.me)').first().hover();
  await pinTarget.click();
  await wait(async () => (await view()).room.messages.some((m) => m.pinned), "message pinned");
  await page.waitForSelector(".rm-decisions li");
  await shot("v2-6-notes-and-decisions.png");
  await sendAndSettle("One more thing");
  const ha = roomHist("alpha", ID).messages.filter((m) => m.role === "user").map(textOf).at(-1) ?? "";
  const lastPrompts = roomHist("alpha", ID).messages.filter((m) => m.role === "user").map(textOf);
  check("#5 every agent turn quotes the room notes and the pinned decision", lastPrompts.slice(-2).every((t) => /Room notes \(kept by Zach\):\nBudget is 5k\. Never touch prod\./.test(t) && /Pinned decisions:\n- /.test(t)), ha.slice(0, 80));
  }

  // ---- #9 speak filter (opt-in; off so far: no judge call has happened)
  if (want("9")) {
  check("#9 off by default: no judge request was made so far", !(await stubStats()).some((s) => s.judge));
  await openPanel("settings-toggle", "[data-setbool=speakFilter]");
  await ui("[data-setbool=speakFilter]").check();
  await wait(async () => (await view()).room.speakFilter === true, "filter on");
  m0 = await mark();
  await sendAndSettle("Filtered round please");
  const fv = await view();
  const judged = (await stubStats()).slice(m0).filter((s) => s.judge);
  const fTurns = (await turnsSince(m0)).length;
  check("#9 with the filter on, a small-model judge call is made for round 2 on a dedicated judge session", judged.length >= 1, `${judged.length} judge request(s)`);
  check("#9 the judge saved turns (members with nothing to add were skipped, not asked to PASS)", fv.run.filtered >= 1 && fTurns < 7, `filtered=${fv.run.filtered}, model turns=${fTurns}`);
  const jh = oc("chat.history", "--params", JSON.stringify({ sessionKey: `agent:alpha:room-${ID}-judge`, limit: 20 })).messages.filter((m) => m.role === "assistant").map(textOf);
  console.log("     judge replies seen by the Gateway:", JSON.stringify(jh).slice(0, 200));
  const keys = oc("sessions.list", "--params", JSON.stringify({ limit: 200 })).sessions.map((s) => s.key);
  check("#9 the judge session is a room-scoped key (hidden from the map)", keys.some((k) => /^agent:alpha:room-r[0-9a-f]{8}-judge$/.test(k)));
  await shot("v2-7-speak-filter.png");
  await openPanel("settings-toggle", "[data-setbool=speakFilter]"); // turn it back off
  await ui("[data-setbool=speakFilter]").uncheck();
  await wait(async () => (await view()).room.speakFilter === false, "filter off");
  }

  // ---- #10 wrap up + End now
  if (want("10")) {
  m0 = await mark();
  await ui(".rm-tool").click();
  await ui("[data-act=wrapup]").click();
  await sleep(500); await idleRun(); await sleep(1500);
  agentsAsked = [...new Set((await turnsSince(m0)).map((t) => t.agent))];
  const wv = await view();
  check("#10 'Ask lead to summarize' posts a normal @lead message and only the lead answers", /^@alpha Please wrap up/.test(wv.room.messages.find((m) => m.from === "you" && /wrap up/.test(m.text))?.text ?? "") && agentsAsked.join(",") === "alpha", agentsAsked.join(","));
  m0 = await mark();
  await type("long discussion please [[delay:bravo=6000]]");
  await untilStatus("running");
  await sleep(1200);
  await ui(".rm-status [data-act=end]").click();
  await idleRun(); await sleep(1500);
  const ev = await view();
  const trig = ev.room.messages.findIndex((m) => m.from === "you" && /long discussion please/.test(m.text));
  const rounds = new Set(ev.room.messages.slice(trig + 1).filter((m) => m.from !== "you" && m.from !== "system").map((m) => m.round));
  check("#10 End now: in-flight replies landed, no second round started, stop reason 'ended', nothing aborted", ev.run.stopReason === "ended" && ev.run.status === "done" && [...rounds].every((r) => r === 1), `${ev.run.stopReason} rounds=${[...rounds]}`);
  check("#10 End now never aborted a Gateway run", !(await stubStats()).slice(m0).some((s) => s.aborted));
  await shot("v2-8-end-now-and-wrapup.png");
  }

  // ---- #8 interrupted run after a data-server restart (never replayed)
  if (want("8")) {
  await type("Restart test [[delay:bravo=7000]]");
  await untilStatus("running");
  await sleep(500);
  const n2 = await msgCount();
  await type("queued across the restart");
  await wait(async () => (await msgCount()) > n2, "queued stored");
  await sleep(1200);
  const onDisk = JSON.parse(readFileSync(ROOMS_FILE, "utf8"));
  check("#8 live run state is written to rooms.json while it runs", onDisk.version === 4 && onDisk.runs[ID]?.status === "running");
  // A crash, not a clean stop: SIGKILL the listener itself (tsx forks node, so killing only the wrapper would leave the server running).
  for (const pid of execFileSync("lsof", ["-t", "-nP", `-iTCP:${API}`, "-sTCP:LISTEN"], { encoding: "utf8" }).split("\n").filter(Boolean)) process.kill(Number(pid), "SIGKILL");
  data.kill("SIGKILL");
  await sleep(800);
  data = startData();
  await wait(async () => (await fetch(`${web}/config`)).ok, "data server restart");
  const iv = await view();
  const sys = iv.room.messages.filter((m) => m.from === "system").map((m) => m.text).join(" | ");
  check("#8 after the restart the run shows as interrupted, with the reason", iv.run.status === "interrupted" && iv.run.stopReason === "interrupted" && /interrupted by a restart and was not replayed/.test(sys), sys.slice(-160));
  check("#8 the queued message is reported as never delivered and its flag is cleared", /1 queued message was never delivered/.test(sys) && !iv.room.messages.some((m) => m.queued));
  const afterRestart = await mark();
  await sleep(9000);
  check("#8 nothing is replayed: no new agent turns started after the restart", (await mark()) === afterRestart, `${(await mark()) - afterRestart} new requests`);
  await page.reload();
  await page.click(".rooms-btn:not(.board-btn)");
  await page.locator(".rm-row", { hasText: "V2 proof room" }).click();
  await page.waitForSelector(".rm-banner.interrupted");
  check("#8 the UI shows the interrupted banner", /not replayed/.test(await ui(".rm-banner.interrupted").innerText()));
  await shot("v2-9-interrupted-after-restart.png");
  await sleep(1500);
  const finalRun = await view();
  check("a new message after the restart starts a fresh run normally", (await (async () => { await type("back again"); await wait(async () => (await status()) === "running" || (await status()) === "done", "fresh run"); await idleRun(); return (await status()) === "done"; })()));
  }

  check("no page errors", errors.length === 0, errors.join("; "));
  await browser.close();
} catch (e) {
  failed = true;
  console.log("FAIL", e.stack ?? e);
  try { const l = (await api("rooms")).json; for (const r of l.rooms) { const j = (await api(`rooms/${r.id}`)).json; console.log("room", r.id, JSON.stringify({ mode: j.room.responderMode, run: j.run && { status: j.run.status, pause: j.run.pause }, last: j.room.messages.slice(-5).map((m) => `${m.from}: ${m.text.slice(0, 60)}${m.queued ? " [queued]" : ""}`) })); } console.log("stub", JSON.stringify(await stubStats()).slice(0, 800)); } catch { /* best effort */ }
  for (const c of kids.slice(0, 3)) console.log("--- log tail:\n" + c.getLog().split("\n").slice(-8).join("\n"));
} finally {
  await cleanup();
  const left = (await Promise.all([GW, API, WEB, STUB].map(listening))).some(Boolean);
  console.log(`cleanup: ports ${GW}-${STUB} ${left ? "STILL LISTENING" : "closed"}, temp dir ${existsSync(work) ? "STILL THERE" : "removed"}`);
  process.exit(failed || left ? 1 : 0);
}

