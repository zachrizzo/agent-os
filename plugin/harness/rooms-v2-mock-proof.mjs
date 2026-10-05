// Rooms v2 against the MOCK fleet (no Gateway, no CLI): the real data server + the built app in a browser. Fast and deterministic; rooms-v2-proof.mjs does the same on a throwaway Gateway.
//   node harness/rooms-v2-mock-proof.mjs <screenshot-dir> [port=5391]     uses port (harness) and port+1000 (data server)
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire("/Users/zachrizzo/.openclaw/tools/node-v24.21.0/lib/node_modules/openclaw/");
const { webkit } = require("playwright-core");
const here = path.dirname(fileURLToPath(import.meta.url));
const proto = path.join(here, "..", "..", "prototype");
const outDir = path.resolve(process.argv[2] ?? ".");
const WEB = Number(process.argv[3] ?? 5391), API = WEB + 1000;
mkdirSync(outDir, { recursive: true });
const work = mkdtempSync("/tmp/agentos-mockproof.");
const ROOMS_FILE = path.join(work, "rooms.json");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const wait = async (fn, what, ms = 30000) => { const t0 = Date.now(); for (;;) { try { const v = await fn(); if (v) return v; } catch { /* retry */ } if (Date.now() - t0 > ms) throw new Error(`timeout: ${what}`); await sleep(100); } };
let failed = false;
const check = (name, ok, detail = "") => { if (!ok) failed = true; console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? " · " + detail : ""}`); };
const kids = [];
const run = (cmd, args, env, cwd) => { const c = spawn(cmd, args, { env, cwd, stdio: "ignore" }); kids.push(c); return c; };
const startData = () => run(path.join(proto, "node_modules", ".bin", "tsx"), ["server/index.ts", "--mock"], { ...process.env, AGENT_OS_API_PORT: String(API), AGENT_OS_MOCK_ROOMS_FILE: ROOMS_FILE }, proto);
const listenerPids = () => { try { return execFileSync("lsof", ["-t", "-nP", `-iTCP:${API}`, "-sTCP:LISTEN"], { encoding: "utf8" }).split("\n").filter(Boolean).map(Number); } catch { return []; } };
const base = `http://127.0.0.1:${WEB}/agent-os/api`;
const api = async (p, body) => { const r = await fetch(`${base}/${p}${p.includes("?") ? "&" : "?"}source=mock`, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json", "x-agent-os-send": "1" }, body: JSON.stringify(body) }); return { status: r.status, json: await r.json().catch(() => ({})) }; };

try {
  let data = startData();
  run(process.execPath, [path.join(here, "serve.mjs"), String(WEB)], { PATH: process.env.PATH, AGENT_OS_API_PORT: String(API) }, here);
  await wait(async () => (await fetch(`${base}/config`)).ok, "harness + data server");
  const browser = await webkit.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${WEB}/agent-os/?source=mock`);
  await page.waitForSelector(".rooms-btn:not(.board-btn)");
  await page.click(".rooms-btn:not(.board-btn)");
  await page.waitForSelector("#rooms [data-act=new]");
  await page.click("#rooms [data-act=new]");
  await page.fill(".rm-name-in", "Mock v2 room");
  for (const id of ["forge", "spark", "research"]) await page.locator(`input[data-pick=${id}]`).check();
  await page.click("[data-act=create]");
  await page.waitForSelector(".rm-bar h3");
  const ID = (await api("rooms")).json.rooms[0].id;
  const ui = (s) => page.locator(s);
  const shot = (n) => page.screenshot({ path: path.join(outDir, n) });
  const view = async () => (await api(`rooms/${ID}`)).json;
  const status = async () => (await view()).run?.status;
  const until = (st, ms = 30000) => wait(async () => (await status()) === st, `run ${st}`, ms);
  const finished = () => wait(async () => ["done", "stopped", "interrupted"].includes(await status()), "run finished", 60000);
  const type = async (t) => { await sleep(700); await ui(".rm-compose textarea").fill(t); await page.keyboard.press("Enter"); };
  const openPanel = async (act, probe) => { if ((await ui(probe).count()) === 0) { await ui(".rm-tool").click(); await ui(`[data-act=${act}]`).click(); } await ui(probe).first().waitFor(); };
  /** Wait for the run started by the message matching `pred` to finish (the previous run's "done" must not count). */
  const waitRunOf = async (pred) => {
    const m = await wait(async () => [...(await view()).room.messages].reverse().find(pred), "message stored");
    await wait(async () => { const r = (await view()).run; return r && r.id === `run${m.id}` && ["done", "stopped", "interrupted"].includes(r.status); }, "its run finished", 90000);
    await sleep(400);
  };
  const sendRun = async (text) => { await type(text); await waitRunOf((m) => m.from === "you" && m.text === text); };
  const turns = async () => (await view()).run?.usage?.turns ?? 0;

  // #2 usage chip + #7 hand-off chip
  await sendRun("Status check please");
  let v = await view();
  const chip = (await ui("[data-usage]").first().innerText()).replace(/\s+/g, " ");
  check("#2 usage chip: turns, tokens, cost, last speaker", /\d+ turns · .*tok · \$[\d.]+ · last: /.test(chip), chip);
  check("#2 the room keeps a running total across runs", v.room.usage.turns === v.run.usage.turns && v.run.usage.costUsd > 0 && v.run.usage.estimated === false);
  check("#7 'A → B' hand-off chip with hop count", /hop 1/i.test((await ui(".rm-hand").first().innerText()).replace(/\s+/g, " ")));
  await shot("m-1-usage-chip-and-handoff.png");

  // #3 responder modes
  const setMode = async (m) => { await ui("[data-set=responderMode]").selectOption(m); await wait(async () => (await view()).room.responderMode === m, "mode saved"); };
  await setMode("lead");
  let n = (await view()).room.messages.length;
  await sendRun("Where do we stand?");
  let after = (await view()).room.messages.slice(n);
  check("#3 lead-first: only the lead answers an unaddressed message", after.filter((m) => m.from !== "you" && m.from !== "system").every((m) => m.from === "forge") && after.some((m) => m.from === "forge"), after.map((m) => m.from).join(","));
  await setMode("mentions");
  n = (await view()).room.messages.length;
  await type("anyone there?"); await wait(async () => (await view()).room.messages.length >= n + 2, "note");
  v = await view();
  check("#3 mentions-only: no turns, a note says why", /only answers @mentions/.test(v.room.messages.at(-1).text) && v.room.messages.length === n + 2);
  await sendRun("@spark your view?");
  after = (await view()).room.messages.slice(n + 2).filter((m) => m.from !== "you" && m.from !== "system");
  check("#3 mentions-only: an @mention is answered by that agent only", after.length >= 1 && after.every((m) => m.from === "spark"), after.map((m) => m.from).join(","));
  await setMode("everyone");

  // #1 soft pause + Continue, #6 strip
  await openPanel("settings-toggle", "[data-set=pauseAfterPosts]");
  await ui("[data-set=pauseAfterPosts]").fill("3"); await ui("[data-set=pauseAfterPosts]").press("Tab");
  await wait(async () => (await view()).room.pauseAfterPosts === 3, "limit saved");
  await shot("m-2-settings-panel.png");
  await type("pingpong slow tools");
  await until("running");
  await wait(async () => (await ui(".rm-st[data-state=tool]").count()) > 0 && (await ui(".rm-st[data-state=waiting]").count()) > 0, "a member on a tool while the lead waits", 20000);
  const states = await ui(".rm-st").evaluateAll((els) => els.map((e) => `${e.querySelector("b").textContent}:${e.dataset.state}:${e.querySelector("small").textContent}`));
  check("#6 strip: a member is using a tool, the lead waits on the others", states.some((s) => /:tool:using (exec|web_search)/.test(s)) && states.some((s) => /:waiting:waiting on/.test(s)), states.join(" | "));
  await shot("m-3-participants-strip.png");
  await until("paused", 60000);
  await page.waitForSelector(".rm-banner.pause");
  let t0 = await turns(); await sleep(3500);
  v = await view();
  check("#1 soft pause after N posts: paused (not stopped), banner offers Continue, nothing is capped", v.run.pause.reason === "posts" && /Continue/.test(await ui(".rm-banner.pause").innerText()) && /Nothing is capped/.test(await ui(".rm-banner.pause").innerText()));
  check("#1 while paused no agent runs", (await turns()) === t0 && v.run.active.length === 0);
  await shot("m-4-soft-pause.png");
  await ui(".rm-banner [data-act=resume]").click();
  await wait(async () => (await turns()) > t0, "turns after Continue", 20000);
  check("#1 Continue resumes the same discussion", true);
  await until("paused", 60000);
  check("#1 a repeating agent pauses the run (repeat/ring/posts)", ["repeat", "ring", "posts"].includes((await view()).run.pause.reason), (await view()).run.pause.reason);
  await ui(".rm-banner [data-act=stop]").click(); await finished();
  check("#1 Stop ends a paused run", (await status()) === "stopped");
  await ui("[data-set=pauseAfterPosts]").fill("0"); await ui("[data-set=pauseAfterPosts]").press("Tab");
  await wait(async () => (await view()).room.pauseAfterPosts === 0, "limit off");

  // #4 queue
  await type("slow poll"); await until("running"); await sleep(600);
  const n1 = (await view()).room.messages.length;
  await type("Also: what about cost?");
  await wait(async () => (await view()).room.messages.length > n1, "queued stored");
  await page.waitForSelector(".rm-msg.queued");
  v = await view();
  check("#4 a message sent mid-run is queued and the run continues", v.run.status === "running" && v.room.messages.at(-1).queued === true && /queued/i.test(await ui(".rm-msg.queued .rm-q").innerText()));
  await shot("m-5-queued-message.png");
  await finished(); await sleep(800);
  v = await view();
  const cost = v.room.messages.findIndex((m) => m.text === "Also: what about cost?");
  check("#4 it joined at a round boundary (flag cleared) and the agents replied after it", !v.room.messages.some((m) => m.queued) && v.room.messages.slice(cost + 1).some((m) => m.from !== "you" && m.from !== "system"));

  // #5 notes + pins
  await openPanel("notes-toggle", ".rm-notes-in");
  await ui(".rm-notes-in").fill("Budget is 5k. Never touch prod.");
  await ui("[data-act=notes-save]").click();
  await wait(async () => (await view()).room.notes === "Budget is 5k. Never touch prod.", "notes saved");
  await ui(".rm-msg:not(.me)").first().hover();
  await ui(".rm-msg:not(.me) [data-pin]").first().click();
  await wait(async () => (await view()).room.messages.some((m) => m.pinned), "pinned");
  await page.waitForSelector(".rm-decisions li");
  check("#5 notes saved, a message pinned and listed under Decisions; the composer is untouched", (await ui(".rm-compose textarea").inputValue()) === "" && (await ui(".rm-decisions li").count()) === 1);
  await shot("m-6-notes-and-decisions.png");

  // #9 speak filter
  await openPanel("settings-toggle", "[data-setbool=speakFilter]");
  const unfiltered = (await view()).room.messages.length;
  await sendRun("plain question");
  const plainTurns = await turns();
  await ui("[data-setbool=speakFilter]").check();
  await wait(async () => (await view()).room.speakFilter === true, "filter on");
  await sendRun("filtered question");
  v = await view();
  check("#9 off by default; on, the judge skips members with nothing to add and the run uses fewer turns", v.run.filtered >= 1 && v.run.usage.turns < plainTurns, `filtered=${v.run.filtered}, turns ${v.run.usage.turns} < ${plainTurns} (${unfiltered} msgs before)`);
  check("#9 the chip shows the saving", await wait(async () => /skipped/.test(await ui("[data-usage]").first().innerText()), "chip updated", 5000));
  await shot("m-7-speak-filter.png");
  await sendRun("judgefail question");
  check("#9 a judge that returns junk lets everyone speak (fail open)", (await turns()) === plainTurns, `${await turns()} vs ${plainTurns}`);
  await ui("[data-setbool=speakFilter]").uncheck();
  await wait(async () => (await view()).room.speakFilter === false, "filter off");

  // #10 wrap up + End now
  await ui(".rm-tool").click(); await ui("[data-act=wrapup]").click();
  await waitRunOf((m) => m.from === "you" && /Please wrap up/.test(m.text));
  v = await view();
  const wrap = v.room.messages.findIndex((m) => m.from === "you" && /Please wrap up/.test(m.text));
  const wrapAnswers = v.room.messages.slice(wrap + 1).filter((m) => m.from !== "system");
  check("#10 'Ask lead to summarize': a normal @lead message, only the lead answers", /^@forge /.test(v.room.messages[wrap].text) && wrapAnswers.length >= 1 && wrapAnswers.every((m) => m.from === "forge"), wrapAnswers.map((m) => m.from).join(","));
  await type("slow long discussion"); await until("running"); await sleep(1200);
  await ui(".rm-status [data-act=end]").click(); await finished(); await sleep(500);
  v = await view();
  const trig = v.room.messages.findIndex((m) => m.text === "slow long discussion");
  const rounds = new Set(v.room.messages.slice(trig + 1).filter((m) => m.from !== "system").map((m) => m.round));
  check("#10 End now: in-flight replies land, no second round, reason 'ended'", v.run.stopReason === "ended" && v.run.status === "done" && [...rounds].every((r) => r === 1) && rounds.size === 1, `rounds=${[...rounds]}`);
  await shot("m-8-end-now-and-wrapup.png");

  // #8 interrupted after a crash
  await type("slow restart test"); await until("running"); await sleep(500);
  const n2 = (await view()).room.messages.length;
  await type("queued across the restart"); await wait(async () => (await view()).room.messages.length > n2, "queued");
  await sleep(600);
  check("#8 live run state is on disk while running", JSON.parse(readFileSync(ROOMS_FILE, "utf8")).runs[ID]?.status === "running");
  for (const pid of listenerPids()) process.kill(pid, "SIGKILL");
  data.kill("SIGKILL"); await sleep(800);
  data = startData();
  await wait(async () => (await fetch(`${base}/config`)).ok, "data server restart");
  v = await view();
  const sys = v.room.messages.filter((m) => m.from === "system").map((m) => m.text).join(" | ");
  check("#8 after the crash the run shows as interrupted, with the reason", v.run.status === "interrupted" && /interrupted by a restart and was not replayed/.test(sys));
  check("#8 queued message reported as not delivered, flag cleared", /1 queued message was never delivered/.test(sys) && !v.room.messages.some((m) => m.queued));
  const cnt = v.room.messages.length;
  await sleep(6000);
  v = await view();
  check("#8 nothing is replayed: no new messages or turns after the restart", v.room.messages.length === cnt && v.run.status === "interrupted");
  await page.reload(); await page.click(".rooms-btn:not(.board-btn)");
  await page.locator(".rm-row", { hasText: "Mock v2 room" }).click();
  await page.waitForSelector(".rm-banner.interrupted");
  check("#8 the UI shows the interrupted banner", /not replayed/.test(await ui(".rm-banner.interrupted").innerText()));
  await shot("m-9-interrupted-after-restart.png");
  await sendRun("back again");
  check("a message after the restart starts a fresh run", (await status()) === "done");
  check("no page errors", errors.length === 0, errors.join("; "));
  await browser.close();
} catch (e) {
  failed = true; console.log("FAIL", e.stack ?? e);
} finally {
  for (const c of kids) { try { c.kill("SIGTERM"); } catch { /* gone */ } }
  for (const pid of listenerPids()) { try { process.kill(pid, "SIGTERM"); } catch { /* gone */ } }
  await sleep(500);
  rmSync(work, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}
