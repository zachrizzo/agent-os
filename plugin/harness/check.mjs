// Scenario checks (WebKit + Chromium): (1) Agent OS live-only map/fleet against the mock fleet's finished/aborted
// sessions, (2) the Talk to Voice button against the mock host's faithful composer.
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

let failed = 0;
for (const [tag, engine] of [["webkit", webkit], ["chromium", chromium]]) {
  const browser = await engine.launch();
  await liveOnlyChecks(browser, tag);
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
