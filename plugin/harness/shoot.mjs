// First shoots the Agent OS map live-only (default) and with History on, then drives the mock-host harness in WebKit: Agent OS tab -> click "Talk to Voice" -> Voice pane live ->
// header "Stop voice · Agent OS" -> back on the tab. Screenshots go to the directory in argv[2].
import { createRequire } from "node:module";
import path from "node:path";
const require = createRequire("/Users/zachrizzo/.openclaw/tools/node-v24.21.0/lib/node_modules/openclaw/");
const { webkit, chromium } = require("playwright-core");
import { ensureServer } from "./ensure-server.mjs";

const out = process.argv[2];
const base = await ensureServer(process.argv[3] ?? "http://127.0.0.1:5299/");
const engine = process.argv[4] === "chromium" ? chromium : webkit;
const tag = process.argv[4] === "chromium" ? "chromium" : "webkit";
const browser = await engine.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 760 } });
const logs = [];
page.on("console", (m) => logs.push(m.text()));
page.on("pageerror", (e) => logs.push("PAGEERROR " + e.message));
const shot = (name) => page.screenshot({ path: path.join(out, `${tag}-${name}.png`) });

// Live-only fleet: default view hides finished/aborted sessions; the History button carries the hidden count.
await page.setViewportSize({ width: 1440, height: 860 });
await page.goto(base + "agent-os/?source=mock");
await page.waitForSelector(".hist-btn");
await page.waitForFunction(() => document.querySelector(".meter[data-k=agents] b")?.textContent !== "–");
await page.waitForTimeout(3500); // count tween + map layout settle
await shot("0a-agent-os-live-only");
console.log("live-only:", await page.locator(".meter[data-k=agents] b").innerText(), "agents; History", await page.locator(".hist-btn b").innerText());
await page.click(".hist-btn");
await page.waitForTimeout(2500);
await shot("0b-agent-os-history-on");
console.log("history on:", await page.locator(".c-sub").innerText());
await page.setViewportSize({ width: 1280, height: 760 });

await page.goto(base);
await page.waitForSelector(".agent-os-voice__btn");
await page.waitForTimeout(1500); // let the dashboard frame load
await shot("1-agent-os-tab");

await page.click(".agent-os-voice__btn");
await page.waitForSelector(".chat-send-btn--voice-live", { timeout: 15000 });
await page.waitForTimeout(300);
await shot("2-voice-live");
console.log("voice live after click:", await page.locator(".chat-send-btn--voice-live").count() === 1);
console.log("header action visible:", await page.getByText("Stop voice · Agent OS").count() === 1);

await page.getByText("Stop voice · Agent OS").click();
await page.waitForSelector(".agent-os-voice__btn");
await page.waitForTimeout(800);
await shot("3-back-on-tab");
console.log("talk stopped, back on tab:", await page.locator(".chat-send-btn--voice-live").count() === 0);

// Failure path: composer without a mic button.
await page.goto(base + "?nomic=1");
await page.waitForSelector(".agent-os-voice__btn");
await page.click(".agent-os-voice__btn");
await page.waitForTimeout(500);
await shot("4-no-mic-landed-in-voice");
console.log("logs:", JSON.stringify(logs));
await browser.close();
