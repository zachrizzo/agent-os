// Rooms v2 #11 (failure classification + retry) and #12 (abort cutoff) against the MOCK fleet: the real data server + rooms service + the built app in a browser.
// Cues in Zach's message (server/mock.ts): flaky = research gets a 429 on its first try; authfail = research always gets a 401; down = every agent gets a 503; late = spark ignores Stop and answers 3s later.
//   node harness/rooms-v2-failures-proof.mjs <screenshot-dir> [port=5393]     uses port (harness) and port+1000 (data server)
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
const WEB = Number(process.argv[3] ?? 5393), API = WEB + 1000;
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
  await page.fill(".rm-name-in", "Failure proof room");
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

  const sysAfter = (v, text) => { const i = v.room.messages.findIndex((m) => m.from === "you" && m.text === text); return v.room.messages.slice(i + 1).filter((m) => m.from === "system").map((m) => m.text); };
  const postsAfter = (v, text) => { const i = v.room.messages.findIndex((m) => m.from === "you" && m.text === text); return v.room.messages.slice(i + 1).filter((m) => m.from !== "system").map((m) => m.from); };

  // #11a transient: research gets a 429 on its first try, is retried with backoff, then answers; nothing is shown as failed
  let t0 = Date.now();
  await sendRun("flaky check");
  let v = await view();
  check("#11 429 on the first try: retried, research answers, no failure note", postsAfter(v, "flaky check").includes("research") && sysAfter(v, "flaky check").length === 0, `posts=${postsAfter(v, "flaky check")} sys=${sysAfter(v, "flaky check")}`);
  check("#11 the retry waited (jittered backoff ~0.75-1.25s)", Date.now() - t0 > 700, `${Date.now() - t0}ms`);
  check("#11 and the run ended as a normal all-PASS round", v.run.stopReason === "passed");

  // #11b terminal: a 401 is not retried, is shown in the room, the others still talk, and the run is not 'passed'
  await sendRun("authfail check");
  v = await view();
  const authNote = sysAfter(v, "authfail check").find((t) => /Research could not answer \(auth error, not retried\)/.test(t));
  check("#11 401: one try, 'could not answer (auth error, not retried)' shown in the room", !!authNote, authNote ?? sysAfter(v, "authfail check").join(" | "));
  check("#11 research is not asked again (one note) and the others still replied", sysAfter(v, "authfail check").filter((t) => /Research/.test(t)).length === 1 && postsAfter(v, "authfail check").includes("forge") && !postsAfter(v, "authfail check").includes("research"));
  check("#11 the run ends 'failed', not 'passed'", v.run.stopReason === "failed" && v.run.status === "done", `${v.run.stopReason}`);
  check("#11 the failure is visible in the thread (UI)", /auth error, not retried/.test(await ui(".rm-sys").allInnerTexts().then((a) => a.join(" "))));
  await shot("f-1-auth-failure-in-thread.png");

  // #11c everything down: transient errors exhaust 2 retries, every failure is shown, and an all-failed round is not an all-PASS ending
  t0 = Date.now();
  await sendRun("down check");
  v = await view();
  const downs = sysAfter(v, "down check");
  check("#11 503 everywhere: each member shows 'overloaded, still failing after 2 retries'", ["Forge", "Spark", "Research"].every((n) => downs.some((t) => new RegExp(`${n} could not answer \\(overloaded, still failing after 2 retries\\)`).test(t))), downs.join(" | "));
  check("#11 nobody posted, and the run is 'failed' with an explanation, never 'passed'", postsAfter(v, "down check").length === 0 && v.run.stopReason === "failed" && downs.some((t) => /Not treated as everyone passing/.test(t)), `${v.run.stopReason}`);
  check("#11 retries were bounded (~1s + ~2s of backoff per round)", Date.now() - t0 > 2500 && Date.now() - t0 < 20000, `${Date.now() - t0}ms`);
  await shot("f-2-all-down-not-a-pass.png");

  // #12 abort cutoff: spark ignores Stop and answers late; the reply must not land in the thread
  await type("late reply check"); await until("running"); await sleep(1000);
  const stopAt = Date.now();
  await ui(".rm-status [data-act=stop]").click();
  await wait(async () => (await view()).run?.cutoffAt, "cutoff recorded", 5000);
  v = await view();
  check("#12 Stop records a cutoff time on the run", v.run.cutoffAt >= stopAt - 50 && v.run.cutoffAt <= Date.now(), `${v.run.cutoffAt - stopAt}ms after the click`);
  await finished(); await sleep(300);
  v = await view();
  check("#12 the run ends 'stopped'", v.run.status === "stopped" && v.run.stopReason === "cancelled");
  check("#12 spark's late reply was dropped, not added to the thread", !postsAfter(v, "late reply check").includes("spark") && v.run.dropped === 1, `posts=${postsAfter(v, "late reply check")} dropped=${v.run.dropped}`);
  check("#12 the thread says so", sysAfter(v, "late reply check").some((t) => /Stopped: 1 late reply from the stopped discussion was dropped \(spark\)/.test(t)), sysAfter(v, "late reply check").join(" | "));
  await sleep(500);
  v = await view();
  check("#12 and it stays dropped (nothing arrives afterwards)", !postsAfter(v, "late reply check").includes("spark"));
  await shot("f-3-late-reply-dropped.png");
  // a new message after Stop is a new run: its replies are kept
  await sendRun("after the stop");
  v = await view();
  check("#12 the next message runs normally, spark's reply is kept", postsAfter(v, "after the stop").includes("spark") && v.run.status === "done" && !v.run.dropped, `posts=${postsAfter(v, "after the stop")}`);
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
