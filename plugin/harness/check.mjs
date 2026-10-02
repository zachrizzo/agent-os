// Scenario checks (WebKit + Chromium): (1) Agent OS live-only map/fleet against the mock fleet's finished/aborted
// sessions, (2) the "Message agent" composer (drawer + agent/team view) and the live-only erroring count, (3) the Talk to Voice button against the mock host's faithful composer.
// Usage: node harness/check.mjs [baseUrl]   (serve first: node harness/serve.mjs 5299 --mock)
import { createRequire } from "node:module";
const require = createRequire("/Users/zachrizzo/.openclaw/tools/node-v24.21.0/lib/node_modules/openclaw/");
const { webkit, chromium } = require("playwright-core");
import { ensureServer } from "./ensure-server.mjs";

const base = await ensureServer(process.argv[2] ?? "http://127.0.0.1:5299/");
// expect: live = Talk went live; talk/dict/sends/picker = counters; status = substring of the on-tab status line, if any.
const scenarios = [
  { name: "desktop, catalog settles after composer mounts", query: "", expect: { live: true, talk: 1, dict: 0, sends: 0 } },
  { name: "narrow layout (Talk button display:none)", query: "", viewport: { width: 480, height: 760 }, expect: { live: true, talk: 1, dict: 0, sends: 0 } },
  { name: "catalog answers out of order (slow UI status)", query: "?fastCatalog=1&catalogMs=2500", expect: { live: true, talk: 1, dict: 0, sends: 0, picker: 1 } },
  { name: "realtime unavailable", query: "?status=unavailable", expect: { live: false, talk: 0, dict: 0, sends: 0, status: "isn't ready" } },
  { name: "draft in composer must not be sent", query: "?draft=do%20not%20send", expect: { live: false, talk: 0, dict: 0, sends: 0, status: "draft" } },
  { name: "no mic in composer", query: "?nomic=1", wait: 10500, expect: { live: false, talk: 0, dict: 0, sends: 0, status: "isn't available" } },
];

// Mock fleet (prototype/server/mock.ts): 60 live agents; every team also retains finished/aborted/archived sessions.
const LIVE_AGENTS = 60;
const num = async (page, sel) => Number((await page.locator(sel).first().innerText()).replace(/\D+/g, ""));

async function liveOnlyChecks(browser, tag) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 860 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(base + "agent-os/?source=mock");
  await page.waitForSelector(".hist-btn");
  await page.waitForFunction(() => document.querySelector(".meter[data-k=agents] b")?.textContent !== "–", null, { timeout: 15000 });
  await page.waitForTimeout(2500); // let the count tween settle
  const bad = [];
  const agents = () => num(page, ".meter[data-k=agents] b");
  const hidden = () => num(page, ".hist-btn b");
  const subtitle = () => page.locator(".c-sub").first().innerText();
  const fleetCount = async () => Number(((await subtitle()).match(/(\d+) agents across/) ?? [])[1] ?? NaN);
  const a0 = await agents(), h0 = await hidden();
  if (a0 !== LIVE_AGENTS) bad.push(["default live count", `${a0} != ${LIVE_AGENTS}`]);
  if (h0 < 100) bad.push(["hidden count shown on toggle", String(h0)]);
  if ((await page.getAttribute(".hist-btn", "aria-pressed")) !== "false") bad.push(["history off by default", "aria-pressed"]);
  if ((await fleetCount()) !== a0) bad.push(["fleet subtitle is live-only", (await subtitle()).slice(0, 80)]);
  await page.click(".hist-btn");
  await page.waitForTimeout(600);
  const a1 = await agents(), h1 = await hidden();
  if ((await page.getAttribute(".hist-btn", "aria-pressed")) !== "true") bad.push(["history on after click", "aria-pressed"]);
  if (a1 !== a0) bad.push(["headline stays live-only with history on", `${a1} != ${a0}`]);
  const shown = await fleetCount();
  if (!(shown >= a0 + 100)) bad.push(["history reveals finished sessions", `fleet shows ${shown}`]);
  await page.click(".hist-btn");
  await page.waitForTimeout(600);
  if ((await fleetCount()) !== a0 || (await page.getAttribute(".hist-btn", "aria-pressed")) !== "false") bad.push(["toggle off restores live-only", (await subtitle()).slice(0, 80)]);
  if (errors.length) bad.push(["pageerrors", errors.join("; ")]);
  if (bad.length) failed++;
  console.log(`${bad.length ? "FAIL" : "ok  "} ${tag} · agent-os live-only default + history toggle {live:${a0}, hidden:${h0}, withHistory:${a1}/${h1}}${bad.length ? " <- " + JSON.stringify(bad) : ""}`);
  await page.close();
}

// "Message agent": composer in the agent/team view and in the drawer; the message lands in the thread and in Activity as You -> agent.
async function messageAgentChecks(browser, tag) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 860 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const bad = [];
  await page.goto(base + "agent-os/?source=mock");
  await page.waitForSelector(".hist-btn");
  await page.waitForFunction(() => document.querySelector(".meter[data-k=agents] b")?.textContent !== "–", null, { timeout: 15000 });
  if (await page.locator(".c-compose:visible").count()) bad.push(["no composer without a selection", "visible"]);
  // Agent view: select the first live agent row in the rail.
  const row = page.locator("#rail .row.agent").first();
  await row.waitFor();
  const agentName = (await row.locator(".nm").innerText()).replace(/\s*lead\s*$/i, "").trim();
  await row.click();
  await page.waitForSelector(".c-compose:visible");
  const sent1 = `harness ping ${tag} ${Date.now()}`;
  await page.locator(".c-compose textarea").fill(sent1);
  await page.keyboard.press("Enter");
  await page.waitForSelector(".c-compose .cmp-status.ok", { timeout: 8000 }).catch(() => bad.push(["agent view send ok", "no success status"]));
  await page.fill(".search input", sent1); // the mock feed is busy: narrow Activity to this message
  await page.waitForTimeout(700);
  const feed = await page.locator("#activity .stream").innerText();
  if (!feed.includes(sent1)) bad.push(["Activity shows the sent message", "missing"]);
  const youRow = page.locator("#activity .ev", { hasText: sent1 });
  const eline = (await youRow.locator(".eline").innerText()).replace(/\s+/g, " ");
  if (!/^You\s*→\s*\S/.test(eline)) bad.push(["Activity row reads You -> agent", eline]);
  if (!eline.includes(agentName)) bad.push(["Activity row targets the selected agent", `${eline} vs ${agentName}`]);
  // Drawer: open it from that Activity row; thread shows the message, composer sends again.
  await youRow.click();
  await page.waitForSelector("#drawer.open .d-compose textarea:not([disabled])");
  await page.waitForFunction((t) => document.querySelector("#drawer .thread")?.textContent.includes(t), sent1, { timeout: 8000 }).catch(() => bad.push(["drawer thread shows the message", "missing"]));
  const sent2 = `drawer ping ${tag} ${Date.now()}`;
  await page.locator("#drawer .d-compose textarea").fill(sent2);
  await page.locator("#drawer .cmp-send").click();
  await page.waitForFunction((t) => document.querySelector("#drawer .thread")?.textContent.includes(t), sent2, { timeout: 8000 }).catch(() => bad.push(["drawer send lands in thread", "missing"]));
  await page.fill(".search input", sent2);
  await page.waitForTimeout(700);
  if (!(await page.locator("#activity .stream").innerText()).includes(sent2)) bad.push(["Activity shows the drawer message", "missing"]);
  // Empty / over-long input is refused by the server, not silently sent.
  const refused = await page.evaluate(async () => {
    const r = await fetch(new URL("api/send?source=mock", document.baseURI), { method: "POST", headers: { "content-type": "application/json", "x-agent-os-send": "1" }, body: JSON.stringify({ key: "agent:nope:main", message: "x" }) });
    const nohdr = await fetch(new URL("api/send?source=mock", document.baseURI), { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    return [r.status, nohdr.status];
  });
  if (refused[0] !== 400 || refused[1] !== 403) bad.push(["unknown session 400 / missing header 403", JSON.stringify(refused)]);
  // Team view: a team row targets its lead.
  await page.keyboard.press("Escape");
  await page.fill(".search input", "");
  await page.locator("#rail .row.team").nth(1).click();
  await page.waitForSelector(".c-compose:visible");
  if (!(await page.locator(".c-compose textarea").getAttribute("placeholder"))?.includes("lead")) bad.push(["team view composer targets the lead", await page.locator(".c-compose textarea").getAttribute("placeholder")]);
  if (errors.length) bad.push(["pageerrors", errors.join("; ")]);
  if (bad.length) failed++;
  console.log(`${bad.length ? "FAIL" : "ok  "} ${tag} · Message agent composer (agent view, team view, drawer, Activity You -> agent)${bad.length ? " <- " + JSON.stringify(bad) : ""}`);
  await page.close();
}

// Compact agent-to-agent rows: a sessions_send shows as "from -> to: text"; the routing wrapper is collapsed, never the headline.
async function a2aChecks(browser, tag) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 860 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const bad = [];
  await page.goto(base + "agent-os/?source=mock");
  await page.waitForSelector(".hist-btn");
  await page.waitForFunction(() => document.querySelector(".meter[data-k=agents] b")?.textContent !== "–", null, { timeout: 15000 });
  await page.locator("#rail .row.agent").first().click();
  await page.waitForSelector(".c-compose:visible");
  await page.click(".cmp-thread");
  await page.waitForSelector("#drawer.open .thread .a2a");
  const row = page.locator("#drawer .thread .a2a").first();
  const line = (await row.locator(".a2a-line").innerText()).replace(/\s+/g, " ");
  if (!/\S+ → \S+/.test(line)) bad.push(["row reads from -> to", line]);
  if (!(await row.locator(".a2a-text").innerText()).startsWith("Brief:")) bad.push(["row shows the sender's text", await row.locator(".a2a-text").innerText()]);
  const visible = await page.locator("#drawer .thread").innerText();
  if (/routed by OpenClaw|Inter-session message|isUser=false/.test(visible)) bad.push(["wrapper hidden by default", visible.slice(0, 120)]);
  if (await page.locator("#drawer .a2a-routing[open]").count()) bad.push(["routing collapsed by default", "open"]);
  await row.locator(".a2a-routing summary").click();
  if (!(await row.locator(".a2a-routing pre").innerText()).includes("sourceTool=sessions_send")) bad.push(["routing detail available on expand", "missing"]);
  if (await page.locator("#drawer .thread .msg.r-user .m-text", { hasText: "Inter-session" }).count()) bad.push(["no full-bubble wrapper", "found"]);
  if (errors.length) bad.push(["pageerrors", errors.join("; ")]);
  if (bad.length) failed++;
  console.log(`${bad.length ? "FAIL" : "ok  "} ${tag} · compact agent-to-agent row in the drawer thread {${line}}${bad.length ? " <- " + JSON.stringify(bad) : ""}`);
  await page.close();
}

// Group rooms: create (live agent list, phi absent), one thread with per-agent avatar+name and "You", mention gating,
// member add/remove, rename, archive, round/turn caps, persistence across reload, write guards.
async function roomsChecks(browser, tag) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 860 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const bad = [];
  const expect = (name, ok, detail = "") => { if (!ok) bad.push([name, detail]); };
  const name = `Launch review ${tag} ${Date.now() % 100000}`;
  await page.goto(base + "agent-os/?source=mock");
  await page.waitForSelector(".rooms-btn");
  await page.click(".rooms-btn");
  await page.waitForSelector("#rooms:not([hidden])");
  await page.click("#rooms [data-act=new]");
  await page.waitForSelector(".rm-picker .rm-pick");
  const picks = await page.locator(".rm-pick span:last-child").allInnerTexts();
  expect("agent picker lists the live agents", picks.length === 6, picks.join("|"));
  expect("phi is never listed", !picks.some((t) => /phi/i.test(t)), picks.join("|"));
  await page.fill(".rm-name-in", name);
  expect("create disabled without members", await page.locator("[data-act=create]").isDisabled());
  for (const id of ["forge", "spark", "research"]) await page.locator(`input[data-pick=${id}]`).check();
  await page.click("[data-act=create]");
  await page.waitForSelector(".rm-bar h3");
  expect("room opens after create", (await page.locator(".rm-bar h3").innerText()).includes(name));
  expect("three members shown", (await page.locator(".rm-members .rm-chip").count()) === 3);

  // no mention -> everyone answers, in one thread, with name + avatar; Zach is "You"
  const send = async (text) => { await page.locator(".rm-compose textarea").fill(text); await page.keyboard.press("Enter"); };
  await send("Status check please");
  await page.waitForFunction(() => document.querySelectorAll(".rm-msg").length >= 4, null, { timeout: 12000 }).catch(async () => bad.push(["everyone answers with no @mention", String(await page.locator(".rm-msg").count())]));
  const names = await page.locator(".rm-msg .rm-meta b").allInnerTexts();
  expect("thread order You, Forge, Spark, Research", names.join(",") === "You,Forge,Spark,Research", names.join(","));
  expect("each message has an avatar", (await page.locator(".rm-msg .avatar").count()) === 4);
  await page.waitForFunction(() => !document.querySelector(".rm-typing"), null, { timeout: 8000 });

  // mention gating
  await send("@spark only you, please");
  await page.waitForFunction(() => document.querySelectorAll(".rm-msg").length >= 6, null, { timeout: 12000 });
  await page.waitForFunction(() => !document.querySelector(".rm-typing"), null, { timeout: 8000 });
  const after = await page.locator(".rm-msg .rm-meta b").allInnerTexts();
  expect("@spark: only Spark answers", after.slice(4).join(",") === "You,Spark" && after.length === 6, after.join(","));

  // members: add Ops, remove Research
  await page.click("[data-act=add-toggle]");
  await page.locator("input[data-addpick=ops]").check();
  await page.waitForFunction(() => document.querySelectorAll(".rm-members .rm-chip").length === 4);
  await page.click("[data-act=add-close]");
  await page.locator(".rm-chip", { hasText: "Research" }).locator("button").click();
  await page.waitForFunction(() => document.querySelectorAll(".rm-members .rm-chip").length === 3);
  const chips = (await page.locator(".rm-members .rm-chip").allInnerTexts()).join("|");
  expect("members now Forge, Spark, Ops", /Forge/.test(chips) && /Spark/.test(chips) && /Ops/.test(chips) && !/Research/.test(chips), chips);

  // caps
  await page.selectOption("[data-set=maxRounds]", "3");
  await page.locator("[data-set=maxTurns]").fill("4");
  await page.locator("[data-set=maxTurns]").dispatchEvent("change");
  await page.waitForTimeout(500);
  await send("pingpong forever");
  await page.waitForFunction(() => document.querySelector(".rm-sys"), null, { timeout: 15000 });
  const sys = await page.locator(".rm-sys").allInnerTexts();
  expect("turn cap stops the loop", sys.some((t) => /turn cap reached \(4 turns/.test(t)), sys.join("|"));
  const agentTurns = await page.locator(".rm-msg:not(.me)").count();
  expect("loop produced a bounded number of replies", agentTurns <= 3 + 1 + 4 + 1, String(agentTurns));
  await page.waitForFunction(() => !document.querySelector(".rm-typing"), null, { timeout: 8000 });

  // rename + archive + persistence
  await page.click("[data-act=rename]");
  await page.fill(".rm-rename", name + " v2");
  await page.click("[data-act=rename-ok]");
  await page.waitForFunction((n) => document.querySelector(".rm-bar h3")?.textContent.includes(n), name + " v2");
  await page.reload();
  await page.waitForSelector(".rooms-btn");
  await page.click(".rooms-btn");
  await page.waitForSelector(`.rm-row`);
  expect("rooms persist across a reload", (await page.locator(".rm-row", { hasText: name + " v2" }).count()) === 1);
  await page.locator(".rm-row", { hasText: name + " v2" }).click();
  await page.waitForSelector(".rm-msg");
  expect("thread persists across a reload", (await page.locator(".rm-msg").count()) >= 8);
  await page.click("[data-act=archive]");
  await page.waitForFunction((n) => ![...document.querySelectorAll(".rm-rows:not(.archived) .rm-row")].some((r) => r.textContent.includes(n)), name + " v2");
  await page.click("[data-act=toggle-archived]");
  expect("archived room moves behind the toggle", (await page.locator(".rm-rows.archived .rm-row", { hasText: name + " v2" }).count()) === 1);
  await page.locator(".rm-rows.archived .rm-row").first().click();
  await page.waitForSelector(".rm-compose textarea[disabled]");

  // API guards
  const g = await page.evaluate(async () => {
    const u = (p) => new URL("api/" + p + "?source=mock", document.baseURI);
    const post = (p, body, hdr = true) => fetch(u(p), { method: "POST", headers: { "content-type": "application/json", ...(hdr ? { "x-agent-os-send": "1" } : {}) }, body: JSON.stringify(body) }).then((r) => r.status);
    return [await post("rooms", { name: "x", members: ["forge"] }, false), await post("rooms", { name: "x", members: ["phi"] }), await post("rooms/r00000000/send", { message: "hi" }), await post("rooms", { name: "x", members: ["nope"] })];
  });
  expect("guards: no header 403, phi 400, unknown room 404, unknown agent 400", JSON.stringify(g) === "[403,400,404,400]", JSON.stringify(g));
  if (errors.length) bad.push(["pageerrors", errors.join("; ")]);
  if (bad.length) failed++;
  console.log(`${bad.length ? "FAIL" : "ok  "} ${tag} · group rooms (create, gating, members, caps, rename/archive, persistence, guards)${bad.length ? " <- " + JSON.stringify(bad) : ""}`);
  await page.close();
}

// Rail footer "N agents erroring" counts live sessions only, with History on too.
async function erroringCountChecks(browser, tag) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 860 } });
  await page.goto(base + "agent-os/?source=mock");
  await page.waitForSelector(".hist-btn");
  await page.waitForTimeout(2500);
  const foot = () => page.locator(".sys-text").innerText();
  const n = (t) => Number((t.match(/^(\d+) agent/) ?? [])[1] ?? 0);
  const off = await foot();
  await page.click(".hist-btn");
  await page.waitForTimeout(800);
  const on = await foot();
  const bad = n(off) !== n(on) ? [["erroring count unchanged by History", `${off} vs ${on}`]] : [];
  if (bad.length) failed++;
  console.log(`${bad.length ? "FAIL" : "ok  "} ${tag} · rail erroring count is live-only {off:"${off}", on:"${on}"}${bad.length ? " <- " + JSON.stringify(bad) : ""}`);
  await page.close();
}

let failed = 0;
for (const [tag, engine] of [["webkit", webkit], ["chromium", chromium]]) {
  const browser = await engine.launch();
  await liveOnlyChecks(browser, tag);
  await messageAgentChecks(browser, tag);
  await a2aChecks(browser, tag);
  await roomsChecks(browser, tag);
  await erroringCountChecks(browser, tag);
  for (const sc of scenarios) {
    const page = await browser.newPage({ viewport: sc.viewport ?? { width: 1280, height: 760 } });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(base + sc.query);
    await page.waitForSelector(".agent-os-voice__btn");
    await page.click(".agent-os-voice__btn");
    // Opening Voice disposes the tab; a failure then surfaces as a toast on the Voice view, so look at the whole body.
    await page.waitForTimeout(sc.wait ?? (sc.expect.live ? 6000 : 3500));
    const stats = await page.evaluate(() => window.__stats);
    const live = (await page.locator(".chat-send-btn--voice-live").count()) === 1;
    const got = { live, talk: stats.talkStarts, dict: stats.dictationStarts, sends: stats.sends, picker: stats.pickerOpens };
    const bad = Object.entries(sc.expect).filter(([k, v]) => k !== "status" && got[k] !== v);
    if (sc.expect.status) {
      const text = (await page.locator(".agent-os-voice__status").allTextContents()).join("|") + (await page.locator("body").innerText());
      if (!text.includes(sc.expect.status)) bad.push(["status", `missing "${sc.expect.status}"`]);
    }
    if (errors.length) bad.push(["pageerrors", errors.join("; ")]);
    if (bad.length) failed++;
    console.log(`${bad.length ? "FAIL" : "ok  "} ${tag} · ${sc.name} ${JSON.stringify(got)}${bad.length ? " <- " + JSON.stringify(bad) : ""} activeAtTalk=${stats.activeAtTalk}`);
    await page.close();
  }
  await browser.close();
}
process.exit(failed ? 1 : 0);
