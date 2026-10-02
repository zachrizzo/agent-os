// Scenario checks for the Talk to Voice button against the mock host's faithful composer (WebKit + Chromium).
// Usage: node harness/check.mjs [baseUrl]   (serve first: node harness/serve.mjs 5299)
import { createRequire } from "node:module";
const require = createRequire("/Users/zachrizzo/.openclaw/tools/node-v24.21.0/lib/node_modules/openclaw/");
const { webkit, chromium } = require("playwright-core");

const base = process.argv[2] ?? "http://127.0.0.1:5299/";
// expect: live = Talk went live; talk/dict/sends/picker = counters; status = substring of the on-tab status line, if any.
const scenarios = [
  { name: "desktop, catalog settles after composer mounts", query: "", expect: { live: true, talk: 1, dict: 0, sends: 0 } },
  { name: "narrow layout (Talk button display:none)", query: "", viewport: { width: 480, height: 760 }, expect: { live: true, talk: 1, dict: 0, sends: 0 } },
  { name: "catalog answers out of order (slow UI status)", query: "?fastCatalog=1&catalogMs=2500", expect: { live: true, talk: 1, dict: 0, sends: 0, picker: 1 } },
  { name: "realtime unavailable", query: "?status=unavailable", expect: { live: false, talk: 0, dict: 0, sends: 0, status: "isn't ready" } },
  { name: "draft in composer must not be sent", query: "?draft=do%20not%20send", expect: { live: false, talk: 0, dict: 0, sends: 0, status: "draft" } },
  { name: "no mic in composer", query: "?nomic=1", wait: 10500, expect: { live: false, talk: 0, dict: 0, sends: 0, status: "isn't available" } },
];

let failed = 0;
for (const [tag, engine] of [["webkit", webkit], ["chromium", chromium]]) {
  const browser = await engine.launch();
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
