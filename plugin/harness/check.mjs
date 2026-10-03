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

// Council mode (default): one captain reply + a collapsible "Council thinking" panel, live statuses, @mention bypass, captain setting, Stop, persistence.
async function councilChecks(browser, tag) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 860 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const bad = [];
  const expect = (name, ok, detail = "") => { if (!ok) bad.push([name, detail]); };
  const name = `Council ${tag} ${Date.now() % 100000}`;
  await page.goto(base + "agent-os/?source=mock");
  await page.waitForSelector(".rooms-btn");
  await page.click(".rooms-btn");
  await page.click("#rooms [data-act=new]");
  await page.fill(".rm-name-in", name);
  for (const id of ["spark", "forge", "research"]) await page.locator(`input[data-pick=${id}]`).check();
  await page.click("[data-act=create]");
  await page.waitForSelector(".rm-bar h3");
  const send = async (text) => { await page.locator(".rm-compose textarea").fill(text); await page.keyboard.press("Enter"); };
  const idle = () => page.waitForFunction(() => !document.querySelector(".rm-compose .rm-typing") && !document.querySelector(".rm-compose textarea[disabled]"), null, { timeout: 25000 });
  const go = async (text) => { await send(text); await page.waitForSelector(".rm-status .rm-typing", { timeout: 8000 }); await idle(); };
  expect("captain defaults to the first member (Spark), shown on its chip", (await page.locator("[data-set=captain]").inputValue()) === "spark" && (await page.locator(".rm-chip.captain").innerText()).includes("Spark"));

  // live: statuses move through planning/working/critiquing while the panel is open; Stop is offered
  await send("slow: is the migration safe? conflict");
  await page.waitForSelector(".rm-council[open]", { timeout: 8000 });
  const seen = new Set();
  for (let i = 0; i < 60 && !(seen.has("deciding") && seen.has("done")); i++) {
    for (const t of await page.locator(".rm-cst").allInnerTexts()) seen.add(t);
    await page.waitForTimeout(250);
  }
  expect("live statuses planning, working and the captain deciding were all shown", ["planning", "working", "deciding"].every((x) => seen.has(x)), [...seen].join(","));
  expect("Stop is offered while the council runs", (await page.locator(".rm-status [data-act=stop]").count()) === 1);
  expect("placeholder captain reply while working", (await page.locator(".rm-msg.captain.pending").count()) === 1 || seen.has("synthesizing"));
  await idle();
  const names = await page.locator(".rm-msg .rm-meta b").allInnerTexts();
  expect("thread = You + ONE captain reply", names.join(",") === "You,Spark", names.join(","));
  expect("panel collapsed once the council is done", (await page.locator(".rm-council").getAttribute("open")) === null);
  expect("captain reply lists disagreements/trade-offs", /Disagreements resolved/.test(await page.locator(".rm-msg.captain .rm-text").innerText()));
  await page.locator(".rm-council > summary").click();
  await page.waitForSelector(".rm-council[open] .rm-note");
  const rows = await page.locator(".rm-note").count();
  expect("panel has compact note rows (plan + answers + decision + follow-ups + stop)", rows >= 8, String(rows));
  const sub = await page.locator(".rm-council > summary").innerText();
  expect("panel summary shows the step count and why the captain stopped", /step 1\/3/.test(sub) && /stopped: done/.test(sub), sub.replace(/\s+/g, " "));
  expect("the captain's decision is a row: 'Step 1: asked X, Y about: ...'", (await page.locator(".rm-note.decision").count()) === 1 && /^Step 1: asked .+ about: /.test((await page.locator(".rm-note.decision .rm-note-text").innerText()).trim()));
  expect("the step settings control is shown (1-4, default 3)", (await page.locator("[data-set=maxSteps]").inputValue()) === "3");
  expect("panel shows done chips for every agent", (await page.locator(".rm-cagent.st-done").count()) === 3);
  await page.waitForTimeout(1500); // a poll repaint must not collapse what the user opened
  expect("a poll repaint keeps the panel the user opened", (await page.locator(".rm-council[open]").count()) === 1);

  // @mention bypass: goes straight to that agent, no council
  await go("@research quick opinion?");
  const after = await page.locator(".rm-msg .rm-meta b").allInnerTexts();
  expect("@research: reply shows in the thread, no council flow", after.slice(2).join(",") === "You,Research" && (await page.locator(".rm-council").count()) === 1, after.join(","));

  // captain is selectable
  await page.selectOption("[data-set=captain]", "forge");
  await page.waitForFunction(() => document.querySelector(".rm-chip.captain")?.textContent.includes("Forge"));
  expect("captain can be changed in room settings", true);

  // bad plan: fallback
  await go("badplan: any risks?");
  const lastPanel = page.locator(".rm-council").last();
  await lastPanel.locator("summary").click();
  expect("unparseable captain plan falls back (flagged) and still answers once", (await page.locator(".rm-cwarn").count()) === 1 && (await page.locator(".rm-msg.captain").count()) === 2);

  // Stop cancels an in-flight council
  await send("slow: stop me");
  await page.waitForSelector(".rm-status [data-act=stop]", { timeout: 8000 });
  await page.waitForTimeout(600);
  await page.click(".rm-status [data-act=stop]");
  await idle();
  const sys = await page.locator(".rm-sys").allInnerTexts();
  expect("Stop cancels the council (system note, no extra captain reply)", sys.some((t) => /council was cancelled/.test(t)) && (await page.locator(".rm-msg.captain").count()) === 2, sys.join("|"));

  // persistence across reload
  await page.reload();
  await page.waitForSelector(".rooms-btn");
  await page.click(".rooms-btn");
  await page.locator(".rm-row", { hasText: name }).click();
  await page.waitForSelector(".rm-msg");
  expect("reload shows the same captain replies and panels", (await page.locator(".rm-msg.captain").count()) === 2 && (await page.locator(".rm-council").count()) === 3);
  await page.click("[data-act=archive]"); // leave the mock data server's active rooms as we found them
  if (errors.length) bad.push(["pageerrors", errors.join("; ")]);
  if (bad.length) failed++;
  console.log(`${bad.length ? "FAIL" : "ok  "} ${tag} · council mode (one captain reply, live panel, bypass, captain, fallback, Stop, persistence)${bad.length ? " <- " + JSON.stringify(bad) : ""}`);
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
  expect("new rooms default to council mode, captain = first member", (await page.locator("[data-set=mode]").inputValue()) === "council" && (await page.locator("[data-set=captain]").inputValue()) === "forge");
  // The classic everyone-answers loop is kept as the Round-table mode; these checks run in it (council mode is covered by councilChecks).
  await page.selectOption("[data-set=mode]", "roundtable");
  await page.waitForSelector("[data-set=maxRounds]");

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
  await page.waitForTimeout(700); // let the first update land (the view ignores a second change while one is in flight)
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
// The mock fleet randomly flips workers to/from `error` every few seconds (mock.ts `churn`/`emit`), which made the two reads
// differ by chance (flaked on 1157b63 too). So the page stops applying stream deltas once settled: the fleet is frozen and the
// two reads must match exactly; the assertion itself is unchanged.
async function erroringCountChecks(browser, tag) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 860 } });
  await page.addInitScript(() => {
    const add = EventSource.prototype.addEventListener;
    EventSource.prototype.addEventListener = function (type, fn, opts) {
      return add.call(this, type, type === "delta" ? (e) => { if (!window.__freezeFleet) fn(e); } : fn, opts);
    };
  });
  await page.goto(base + "agent-os/?source=mock");
  await page.waitForSelector(".hist-btn");
  await page.waitForTimeout(2500);
  await page.evaluate(() => { window.__freezeFleet = true; });
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

// Replay strip is gone: no element/text, and the map/panels run to the bottom of the viewport.
async function noReplayChecks(browser, tag) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 860 } });
  await page.goto(base + "agent-os/?source=mock");
  await page.waitForSelector(".hist-btn");
  await page.waitForTimeout(1500);
  const r = await page.evaluate(() => {
    const bottom = (sel) => Math.round(document.querySelector(sel).getBoundingClientRect().bottom);
    return { dom: document.querySelectorAll("#replay, [class^=rp-], canvas.rp").length, text: /Replay|Last 60 min|Go live/.test(document.body.innerText), center: bottom("#center"), rail: bottom("#rail"), act: bottom("#activity"), vh: innerHeight };
  });
  const bad = [];
  if (r.dom || r.text) bad.push(["replay UI removed", JSON.stringify(r)]);
  for (const k of ["center", "rail", "act"]) if (r[k] !== r.vh) bad.push([`${k} reaches viewport bottom`, `${r[k]} != ${r.vh}`]);
  if (bad.length) failed++;
  console.log(`${bad.length ? "FAIL" : "ok  "} ${tag} · replay removed, map/panels fill height {${r.center}/${r.vh}}${bad.length ? " <- " + JSON.stringify(bad) : ""}`);
  await page.close();
}

// ---- Theme: Agent OS follows the Control UI's light/dark mode live, with readable contrast -----------------------------------
const parseRgb = (c) => { const m = c.match(/^(rgba?|color)\(([^)]*)\)/); if (!m) return null; const n = m[2].replace("srgb", "").replace("/", " ").split(/[\s,]+/).filter(Boolean).map(Number); const k = m[1] === "color" ? 255 : 1; return { r: n[0] * k, g: n[1] * k, b: n[2] * k, a: n.length > 3 ? n[3] : 1 }; };
const HOST = { dark: { bg: [14, 16, 21], card: [22, 25, 32], accent: [255, 92, 92], textStrong: [244, 244, 245] }, light: { bg: [250, 249, 247], card: [255, 255, 255], accent: [189, 69, 49], textStrong: [33, 30, 26] } };
const near = (a, b, t = 3) => a.every((v, i) => Math.abs(v - b[i]) <= t);

// Runs inside the Agent OS frame: sweeps every visible text node, composites its colour over the opaque ancestors, returns WCAG ratios.
const contrastSweep = () => {
  const parse = (c) => { const m = c.match(/^(rgba?|color)\(([^)]*)\)/); if (!m) return null; const n = m[2].replace("srgb", "").replace("/", " ").split(/[\s,]+/).filter(Boolean).map(Number); const k = m[1] === "color" ? 255 : 1; return [n[0] * k, n[1] * k, n[2] * k, n.length > 3 ? n[3] : 1]; };
  const over = (f, b) => [0, 1, 2].map((i) => f[i] * f[3] + b[i] * (1 - f[3]));
  const lum = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  const bgOf = (el) => { const chain = []; for (let e = el; e; e = e.parentElement) { const c = parse(getComputedStyle(e).backgroundColor); if (c && c[3] > 0) chain.push(c); if (c && c[3] >= 1) break; } let base = [255, 255, 255]; for (const c of chain.reverse()) base = over(c, base); return base; };
  const out = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n; (n = walker.nextNode());) {
    const t = n.textContent.trim(); const el = n.parentElement;
    if (!t || /^[^\p{L}\p{N}]+$/u.test(t) || !el || /^(SCRIPT|STYLE)$/.test(el.tagName) || el.closest(":disabled")) continue; // disabled controls are exempt (WCAG 1.4.3)
    const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
    if (r.width < 1 || r.height < 1 || cs.visibility === "hidden" || cs.display === "none" || Number(cs.opacity) < 0.05) continue;
    let op = 1; for (let e = el; e; e = e.parentElement) op *= Number(getComputedStyle(e).opacity);
    if (op < 0.05) continue; // a fully faded-out ancestor (closed drawer) is not visible text
    const fg = parse(cs.color); if (!fg) continue;
    const bg = bgOf(el); const fgc = over([fg[0], fg[1], fg[2], fg[3] * op], bg);
    out.push({ t: t.slice(0, 28), cls: (el.className?.baseVal ?? el.className ?? "").toString().slice(0, 24), ratio: +ratio(fgc, bg).toFixed(2), px: parseFloat(cs.fontSize) });
  }
  return out;
};
const canvasPx = (frame) => frame.evaluate(() => { const c = document.querySelector(".aos-map canvas"); const g = c.getContext("2d"); const d = g.getImageData(c.width - 6, c.height - 6, 1, 1).data; return [d[0], d[1], d[2]]; });

async function themeChecks(browser, tag) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 860 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const bad = [];
  // 1) Embedded in the (mock) Control UI host, starting light: the host's own variables must drive the app.
  await page.goto(base + "?theme=light");
  await page.waitForSelector(".agent-os-voice__btn");
  const frame = () => page.frames().find((f) => f.url().includes("/agent-os/"));
  await page.waitForFunction(() => document.querySelector("iframe"), null, { timeout: 8000 });
  await page.waitForTimeout(3500);
  const snap = (f) => f.evaluate(() => { const cs = (s, p) => getComputedStyle(document.querySelector(s))[p]; return { mode: document.documentElement.dataset.mode, body: cs("body", "backgroundColor"), rail: cs("#rail", "backgroundColor"), title: cs(".brand span", "color"), chip: cs(".chips button.on", "backgroundColor"), font: cs("body", "fontFamily"), scheme: cs("html", "colorScheme") }; });
  const checkMode = async (mode, what) => {
    const s = await snap(frame());
    const want = HOST[mode];
    const body = parseRgb(s.body), rail = parseRgb(s.rail), chip = parseRgb(s.chip), title = parseRgb(s.title);
    if (s.mode !== mode) bad.push([what + " mode attr", s.mode]);
    if (!body || !near([body.r, body.g, body.b], want.bg)) bad.push([what + " page background = host --bg", s.body]);
    if (!rail || !near([rail.r, rail.g, rail.b], want.card)) bad.push([what + " panel background = host --card", s.rail]);
    if (!chip || !near([chip.r, chip.g, chip.b], want.accent)) bad.push([what + " active chip = host --accent", s.chip]);
    if (!title || !near([title.r, title.g, title.b], want.textStrong)) bad.push([what + " text = host --text-strong", s.title]);
    if (!s.font.includes("Instrument Sans")) bad.push([what + " font follows host --font-body", s.font]);
    if (s.scheme !== mode) bad.push([what + " color-scheme", s.scheme]);
    const px = await canvasPx(frame());
    if (!near(px, want.bg, 6)) bad.push([what + " map canvas background", px.join(",")]);
    const sweep = await frame().evaluate(contrastSweep);
    const low = sweep.filter((x) => x.ratio < (x.px >= 18 ? 3 : 4.5));
    if (low.length) bad.push([what + " text contrast < 4.5 (3 for large)", `${low.length}/${sweep.length}: ` + low.slice(0, 6).map((x) => `${x.cls || "?"}:"${x.t}" ${x.ratio}`).join("; ")]);
    return { sweep: sweep.length, min: Math.min(...sweep.map((x) => x.ratio)) };
  };
  const light = await checkMode("light", "light");
  await frame().evaluate(() => { window.__noReload = 7; });
  // 2) Live toggle, no reload.
  await page.click("#theme-toggle");
  await page.waitForFunction(() => document.querySelector("iframe") && true);
  await frame().waitForFunction(() => document.documentElement.dataset.mode === "dark", null, { timeout: 4000 }).catch(() => {});
  await page.waitForTimeout(600);
  const dark = await checkMode("dark", "dark after live toggle");
  if ((await frame().evaluate(() => window.__noReload)) !== 7) bad.push(["toggle reloads the app", "frame state lost"]);
  // Open the drawer in dark, flip back to light with the drawer open (overlays follow too).
  await frame().locator("#activity .ev").first().click();
  await frame().waitForSelector("#drawer.open .thread");
  await page.click("#theme-toggle");
  await page.waitForTimeout(900);
  const drawerBg = parseRgb(await frame().evaluate(() => getComputedStyle(document.querySelector("#drawer")).backgroundColor));
  if (!drawerBg || drawerBg.r < 200) bad.push(["drawer follows light theme", JSON.stringify(drawerBg)]);
  const lightDrawer = await frame().evaluate(contrastSweep);
  const lowD = lightDrawer.filter((x) => x.ratio < (x.px >= 18 ? 3 : 4.5));
  if (lowD.length) bad.push(["light drawer text contrast", lowD.slice(0, 5).map((x) => `${x.cls}:"${x.t}" ${x.ratio}`).join("; ")]);
  // Light: composer in the agent view and the rooms UI (create form + thread) are readable too.
  await frame().evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))); // focus lives in the host page, so dispatch inside the frame
  await frame().waitForFunction(() => !document.querySelector("#drawer.open"));
  await page.waitForTimeout(500); // let the drawer fade out
  await frame().locator("#rail .row.agent").first().click();
  await frame().waitForSelector(".c-compose:visible");
  await frame().locator(".c-compose textarea").fill("Draft to check contrast");
  await page.waitForTimeout(400); // Send fades in once there is a draft
  const lowC = (await frame().evaluate(contrastSweep)).filter((x) => x.ratio < (x.px >= 18 ? 3 : 4.5));
  if (lowC.length) bad.push(["light composer/agent view contrast", lowC.slice(0, 5).map((x) => `${x.cls}:"${x.t}" ${x.ratio}`).join("; ")]);
  // 3) Voice UI (host-side) follows the same variables.
  await page.click("#theme-toggle");
  await page.waitForTimeout(400);
  const voice = await page.evaluate(() => { const b = document.querySelector(".agent-os-voice__btn"); const cs = getComputedStyle(b); return { color: cs.color, border: cs.borderTopColor }; });
  const vc = parseRgb(voice.color);
  if (!vc || !near([vc.r, vc.g, vc.b], [188, 188, 192], 3)) bad.push(["voice button uses host --text (dark)", voice.color]);
  // 4) Standalone (no host): prefers-color-scheme drives it, live.
  const solo = await browser.newPage({ viewport: { width: 1440, height: 860 }, colorScheme: "light" });
  await solo.goto(base + "agent-os/?source=mock");
  await solo.waitForSelector(".hist-btn");
  await solo.waitForTimeout(2500);
  await solo.click(".rooms-btn");
  await solo.waitForSelector("#rooms:not([hidden])");
  await solo.click("#rooms [data-act=new]");
  await solo.fill(".rm-name-in", "Theme room");
  for (const id of ["forge", "spark"]) await solo.locator(`input[data-pick=${id}]`).check();
  await solo.click("[data-act=create]");
  await solo.waitForSelector(".rm-bar h3");
  await solo.locator(".rm-compose textarea").fill("hello @spark");
  await solo.keyboard.press("Enter");
  await solo.waitForFunction(() => document.querySelectorAll(".rm-msg, .rm-sys").length >= 2, null, { timeout: 15000 });
  await solo.waitForTimeout(800);
  const lowR = (await solo.evaluate(contrastSweep)).filter((x) => x.ratio < (x.px >= 18 ? 3 : 4.5));
  if (lowR.length) bad.push(["light rooms contrast (rooms need the data server's POST, so standalone)", lowR.slice(0, 5).map((x) => `${x.cls}:"${x.t}" ${x.ratio}`).join("; ")]);
  await solo.click("[data-act=archive]"); // leave the mock data server's active rooms as we found them
  await solo.waitForTimeout(400);
  const m1 = await solo.evaluate(() => document.documentElement.dataset.mode);
  await solo.emulateMedia({ colorScheme: "dark" });
  await solo.waitForTimeout(800);
  const m2 = await solo.evaluate(() => document.documentElement.dataset.mode);
  const sp = await canvasPx(solo.mainFrame());
  if (m1 !== "light" || m2 !== "dark") bad.push(["standalone follows prefers-color-scheme live", `${m1} -> ${m2}`]);
  if (!near(sp, HOST.dark.bg, 6)) bad.push(["standalone map follows scheme", sp.join(",")]);
  await solo.close();
  if (errors.length) bad.push(["pageerrors", errors.join("; ")]);
  if (bad.length) failed++;
  console.log(`${bad.length ? "FAIL" : "ok  "} ${tag} · theme: host light/dark live toggle (no reload), tokens, map canvas, drawer, voice, standalone {minContrast light:${light.min} dark:${dark.min}, text nodes:${light.sweep}}${bad.length ? " <- " + JSON.stringify(bad) : ""}`);
  await page.close();
}

// Activity panel semantics: one chronological stream (newest first), honest kinds, agent names that never truncate, noise hidden behind System,
// "-> You" only on what truly went to Zach, click opens the session, optional team grouping.
async function activityChecks(browser, tag) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 860 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(base + "agent-os/?source=mock");
  await page.waitForSelector("#activity .ev");
  await page.waitForTimeout(5000); // the mock emits ~10 events/s, ~15% internal heartbeat rows
  const bad = [];
  const KINDS = ["message", "handoff", "done", "blocked", "needs you", "approval"];
  const rows = await page.evaluate(() => [...document.querySelectorAll("#activity .stream .ev")].map((r) => ({
    kind: r.querySelector(".kchip")?.textContent?.trim().toLowerCase() ?? "",
    time: r.querySelector("time")?.textContent ?? "",
    whos: [...r.querySelectorAll(".eline .who")].map((w) => ({ t: w.textContent, trunc: w.scrollWidth > w.clientWidth + 1, ell: getComputedStyle(w).textOverflow === "ellipsis" })),
    text: r.querySelector(".esum")?.textContent ?? "",
    ell: getComputedStyle(r.querySelector(".esum")).textOverflow === "ellipsis",
    hue: r.querySelector(".edot")?.getAttribute("style") ?? "",
    toYou: /→/.test(r.querySelector(".eline")?.textContent ?? "") && r.querySelectorAll(".eline .who")[1]?.textContent === "You",
  })));
  if (rows.length < 8) bad.push(["stream has rows", String(rows.length)]);
  if (await page.locator("#activity .stream .group").count()) bad.push(["default is a single stream, not team groups", "found .group"]);
  const times = rows.map((r) => r.time);
  if (times.some((t, i) => i && t > times[i - 1])) bad.push(["newest first", times.slice(0, 6).join(" ")]);
  const badKind = rows.filter((r) => !KINDS.includes(r.kind)).map((r) => r.kind);
  if (badKind.length) bad.push(["only Message/Handoff/Done/Blocked/Needs you/Approval", [...new Set(badKind)].join(",")]);
  if (rows.some((r) => /heartbeat|NO_REPLY|exec completion|no reply/i.test(r.text))) bad.push(["system noise hidden by default", rows.find((r) => /heartbeat|NO_REPLY|no reply/i.test(r.text)).text]);
  if (rows.some((r) => r.whos.some((w) => w.trunc || w.ell))) bad.push(["actor names never truncate", JSON.stringify(rows.find((r) => r.whos.some((w) => w.trunc || w.ell)).whos)]);
  if (!rows.every((r) => r.ell)) bad.push(["summary is ellipsized", "text-overflow"]);
  if (!rows.every((r) => /--hue:/.test(r.hue))) bad.push(["team colour dot on every row", "missing --hue"]);
  if (rows.some((r) => r.toYou && !["approval", "needs you", "message"].includes(r.kind))) bad.push(["-> You only for real asks/replies", rows.find((r) => r.toYou && !["approval", "needs you", "message"].includes(r.kind)).kind]);
  if (!rows.some((r) => r.kind === "handoff")) bad.push(["handoff rows exist", "none"]);
  // System filter reveals the hidden rows.
  await page.click('#activity .chips button[data-f=system]');
  await page.waitForTimeout(500);
  const sys = await page.locator("#activity .stream .ev").allInnerTexts();
  if (!sys.length || !sys.every((t) => /heartbeat|no reply|system/i.test(t))) bad.push(["System filter shows only internal rows", `${sys.length}: ${(sys[0] ?? "").replace(/\s+/g, " ").slice(0, 80)}`]);
  await page.click('#activity .chips button[data-f=all]');
  await page.waitForTimeout(400);
  // Optional team grouping.
  await page.click("#activity .grp-btn");
  await page.waitForTimeout(500);
  if (!(await page.locator("#activity .stream .group").count())) bad.push(["By team groups the stream", "no .group"]);
  await page.click("#activity .grp-btn");
  await page.waitForTimeout(400);
  if (await page.locator("#activity .stream .group").count()) bad.push(["By team toggles back to one stream", "still grouped"]);
  // Click opens the relevant session thread.
  const first = await page.locator("#activity .stream .ev .who").first().innerText();
  await page.locator("#activity .stream .ev").first().click();
  await page.waitForSelector("#drawer.open .thread");
  const route = await page.locator("#drawer .d-route").innerText();
  if (!route.includes(first)) bad.push(["click opens the row's session", `${first} not in "${route}"`]);
  if (errors.length) bad.push(["pageerrors", errors.join("; ")]);
  if (bad.length) failed++;
  console.log(`${bad.length ? "FAIL" : "ok  "} ${tag} · Activity semantics (${rows.length} rows, kinds ${[...new Set(rows.map((r) => r.kind))].join("/")})${bad.length ? " <- " + JSON.stringify(bad) : ""}`);
  await page.close();
}

// Markdown rendering + XSS (prototype/shared/markdown.ts): the mock council answers "richmd" with headings, lists, a table, a long code fence,
// an @mention, a path:line and hostile HTML. Checks the room thread, the council panel, the session drawer (bubbles + A2A row) and Activity previews.
async function markdownChecks(browser, tag) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 860 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  let dialogs = 0;
  page.on("dialog", (d) => { dialogs++; d.dismiss(); });
  const popups = [];
  page.on("popup", (p) => popups.push(p.url()));
  const bad = [];
  const expect = (name, ok, detail = "") => { if (!ok) bad.push([name, detail]); };
  const name = `Markdown ${tag} ${Date.now() % 100000}`;
  await page.goto(base + "agent-os/?source=mock");
  await page.waitForSelector(".rooms-btn");
  await page.click(".rooms-btn");
  await page.click("#rooms [data-act=new]");
  await page.fill(".rm-name-in", name);
  for (const id of ["spark", "forge", "research"]) await page.locator(`input[data-pick=${id}]`).check();
  await page.click("[data-act=create]");
  await page.waitForSelector(".rm-bar h3");
  await page.locator(".rm-compose textarea").fill("richmd: how should we roll this out? **bold from Zach** and `code`");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".rm-status .rm-typing", { timeout: 8000 });
  await page.waitForFunction(() => !document.querySelector(".rm-compose .rm-typing") && document.querySelector(".rm-msg.captain:not(.pending) .rm-text.md h2"), null, { timeout: 25000 });
  const cap = page.locator(".rm-msg.captain .rm-text.md");
  expect("captain reply: heading, bold, inline code", (await cap.locator("h2").innerText()) === "Recommendation" && (await cap.locator("strong").first().innerText()) === "Thursday" && (await cap.locator("p code").first().innerText()) === "npm test");
  expect("captain reply: no raw markdown markers left", !/\*\*|```|^## |^- /m.test(await cap.innerText()), (await cap.innerText()).slice(0, 80));
  expect("captain reply: bullets, numbered list, blockquote, table", (await cap.locator("ul li").count()) === 3 && (await cap.locator("ol li").count()) === 3 && (await cap.locator("blockquote").count()) === 1 && (await cap.locator("table tr").count()) === 3);
  const code = cap.locator(".md-code pre");
  const cs = await code.evaluate((el) => ({ ff: getComputedStyle(el).fontFamily, ox: getComputedStyle(el).overflowX, sw: el.scrollWidth, cw: el.clientWidth }));
  expect("code fence is monospace and scrolls horizontally", /mono|menlo|monospace/i.test(cs.ff) && cs.ox === "auto" && cs.sw > cs.cw, JSON.stringify(cs));
  expect("code fence has a copy button", (await cap.locator(".md-code .md-copy").count()) === 1);
  expect("@mention keeps its chip", (await cap.locator(".rm-at").first().innerText()) === "@spark");
  expect("path:line is marked", (await cap.locator(".md-path").first().innerText()) === "plugin/src/index.ts:42");
  const link = cap.locator("a", { hasText: "the runbook" });
  expect("link opens in a new tab, noopener noreferrer", (await link.getAttribute("target")) === "_blank" && (await link.getAttribute("rel")) === "noopener noreferrer" && (await link.getAttribute("href")) === "https://example.com/runbook");
  const danger = await page.evaluate(() => ({
    bad: document.querySelectorAll("#rooms script, #rooms iframe, #rooms img, #rooms style, #rooms [onerror], #rooms [onclick], #rooms [onload]").length,
    js: [...document.querySelectorAll("#rooms a")].filter((a) => /^\s*(javascript|data|vbscript):/i.test(a.getAttribute("href") ?? "")).length,
  }));
  expect("hostile HTML/links in the reply are inert", danger.bad === 0 && danger.js === 0, JSON.stringify(danger));
  expect("hostile source shows as plain text", (await cap.innerText()).includes("<script>alert(1)</script>"));
  const font = await cap.evaluate((el) => ({ w: el.getBoundingClientRect().width, max: parseFloat(getComputedStyle(el).fontSize) * 72 }));
  expect("long text keeps a readable max width", font.w <= font.max + 4, JSON.stringify(font));
  await cap.locator(".md-code").hover();
  await cap.locator(".md-copy").click();
  expect("copy button gives feedback", (await cap.locator(".md-copy").innerText()) === "Copied");

  // council panel notes
  await page.locator(".rm-council > summary").click();
  await page.waitForSelector(".rm-council[open] .rm-note");
  expect("council notes render markdown", (await page.locator(".rm-note-text.md strong").count()) >= 2 && (await page.locator(".rm-note.answer .rm-note-text.md").first().innerText()).indexOf("**") === -1);
  expect("council notes: @mention chip stays", (await page.locator(".rm-note-text .rm-at").count()) >= 1);
  // Zach's own message is rendered too
  expect("Zach's message renders bold and code", (await page.locator(".rm-msg.me .rm-text.md strong").first().innerText()) === "bold from Zach");
  expect("page-wide: no dialogs, popups, or pageerrors from hostile text", dialogs === 0 && popups.length === 0 && errors.length === 0, `${dialogs} ${popups} ${errors}`);
  await page.click("[data-act=archive]"); // leave the mock data server's active rooms as we found them
  await page.click(".rooms-btn");

  // session drawer: assistant bubble and the A2A row
  await page.waitForFunction(() => document.querySelector(".meter[data-k=agents] b")?.textContent !== "–", null, { timeout: 15000 });
  await page.locator("#rail .row.agent").first().click();
  await page.waitForSelector(".c-compose:visible");
  await page.click(".cmp-thread");
  await page.waitForSelector("#drawer.open .thread .a2a");
  const th = page.locator("#drawer .thread");
  expect("drawer bubble renders headings, table, code block", (await th.locator(".m-text.md h2").count()) >= 1 && (await th.locator(".m-text.md table").count()) >= 1 && (await th.locator(".m-text.md .md-code pre").count()) >= 1);
  expect("drawer bubble: no raw markers", !/\*\*|```/.test(await th.locator(".m-text.md").first().innerText()));
  expect("A2A row renders markdown when expanded", (await th.locator(".a2a-text.md strong").first().innerText()) === "Brief:" && (await th.locator(".a2a-text.md li").count()) === 2);
  expect("drawer: hostile content inert", (await page.locator("#drawer script, #drawer iframe, #drawer img, #drawer [onerror]").count()) === 0);
  await page.keyboard.press("Escape");

  // Activity previews: inline only, single line
  await page.waitForSelector("#activity .stream .esum strong, #activity .stream .esum code", { timeout: 15000 });
  const act = await page.evaluate(() => {
    const els = [...document.querySelectorAll("#activity .stream .esum")];
    const rich = els.filter((e) => e.querySelector("strong, code, a"));
    return { rich: rich.length, raw: els.filter((e) => /\*\*|`/.test(e.textContent ?? "")).length, block: document.querySelectorAll("#activity .esum h1, #activity .esum h2, #activity .esum ul, #activity .esum p, #activity .esum pre, #activity .esum table").length, oneLine: rich.every((e) => e.getBoundingClientRect().height < 24) };
  });
  expect("Activity previews render bold/code/links inline", act.rich > 0 && act.raw === 0, JSON.stringify(act));
  expect("Activity previews stay single-line and inline-only", act.block === 0 && act.oneLine, JSON.stringify(act));
  if (errors.length) bad.push(["pageerrors", errors.join("; ")]);
  if (bad.length) failed++;
  console.log(`${bad.length ? "FAIL" : "ok  "} ${tag} · Markdown rendering + XSS (room thread, council notes, drawer, A2A, Activity)${bad.length ? " <- " + JSON.stringify(bad) : ""}`);
  await page.close();
}

let failed = 0;
for (const [tag, engine] of [["webkit", webkit], ["chromium", chromium]]) {
  const browser = await engine.launch();
  await liveOnlyChecks(browser, tag);
  await noReplayChecks(browser, tag);
  await themeChecks(browser, tag);
  await messageAgentChecks(browser, tag);
  await a2aChecks(browser, tag);
  await roomsChecks(browser, tag);
  await councilChecks(browser, tag);
  await erroringCountChecks(browser, tag);
  await activityChecks(browser, tag);
  await markdownChecks(browser, tag);
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
