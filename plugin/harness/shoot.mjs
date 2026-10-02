// First shoots the Agent OS map live-only (default) and with History on, then the "Message agent" composer (agent view, team view, session drawer after a send), then drives the mock-host harness in WebKit: Agent OS tab -> click "Talk to Voice" -> Voice pane live ->
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
await page.click(".hist-btn"); // back to live-only

// Message agent: agent view, team view, and the drawer after sending.
const agentRow = page.locator("#rail .row.agent").first();
await agentRow.click();
await page.waitForSelector(".c-compose:visible");
await page.locator(".c-compose textarea").fill("Status check from Zach: what are you on right now?");
await page.waitForTimeout(900);
await shot("0c-message-agent-agent-view");
await page.keyboard.press("Enter");
await page.waitForSelector(".c-compose .cmp-status.ok");
await page.fill(".search input", "Status check from Zach"); // narrow the busy mock feed to the sent message
await page.waitForTimeout(700);
await page.locator("#activity .ev", { hasText: "Status check from Zach" }).first().click();
await page.waitForSelector("#drawer.open .thread .msg");
await page.locator("#drawer .d-compose textarea").fill("Thanks. Hold off on the merge until I review.");
await page.locator("#drawer .cmp-send").click();
await page.waitForSelector("#drawer .cmp-status.ok");
await page.waitForTimeout(900);
await shot("0e-message-agent-drawer");
await page.keyboard.press("Escape");
await page.fill(".search input", "");
await page.locator("#rail .row.team").nth(1).click();
await page.waitForSelector(".c-compose:visible");
await page.locator(".c-compose textarea").fill("Team: please post a short status.");
await page.waitForTimeout(900);
await shot("0d-message-agent-team-view");
await page.locator(".c-compose textarea").fill("");
console.log("message agent shots done");
// Compact agent-to-agent row (drawer thread), then group rooms: create, members, a multi-agent thread with gating and caps.
await page.keyboard.press("Escape");
await page.locator("#rail .row.agent").first().click();
await page.waitForSelector(".c-compose:visible");
await page.click(".cmp-thread");
await page.waitForSelector("#drawer.open .thread .a2a");
await page.locator("#drawer .a2a-routing summary").first().click();
await page.waitForTimeout(500);
await shot("0f-compact-a2a-drawer");
await page.keyboard.press("Escape");
await page.click(".rooms-btn");
await page.waitForSelector("#rooms:not([hidden])");
await page.click("#rooms [data-act=new]");
await page.fill(".rm-name-in", "Launch review");
for (const id of ["forge", "spark", "research"]) await page.locator(`input[data-pick=${id}]`).check();
await page.waitForTimeout(400);
await shot("1a-room-create");
await page.click("[data-act=create]");
await page.waitForSelector(".rm-bar h3");
const say = async (t, n) => { await page.locator(".rm-compose textarea").fill(t); await page.keyboard.press("Enter"); await page.waitForFunction((k) => document.querySelectorAll(".rm-msg, .rm-sys").length >= k && !document.querySelector(".rm-typing"), n, { timeout: 15000 }); };
await say("Where are we on the launch checklist?", 4);
await say("@spark can you take the rollout comms?", 6);
await page.waitForTimeout(300);
await page.click("[data-act=add-toggle]");
await page.waitForTimeout(400);
await shot("1b-room-members-add");
await page.locator("input[data-addpick=ops]").check();
await page.waitForFunction(() => document.querySelectorAll(".rm-members .rm-chip").length === 4);
await page.click("[data-act=add-close]");
await page.locator(".rm-chip", { hasText: "Research" }).locator("button").click();
await page.waitForFunction(() => document.querySelectorAll(".rm-members .rm-chip").length === 3);
await page.waitForTimeout(300);
await shot("1c-room-members-removed");
await page.selectOption("[data-set=maxRounds]", "3");
await page.locator("[data-set=maxTurns]").fill("5");
await page.locator("[data-set=maxTurns]").dispatchEvent("change");
await page.waitForTimeout(500);
await say("pingpong between you all", 9);
await page.waitForTimeout(400);
await shot("1d-room-multi-agent-thread-caps");
await page.click(".rooms-btn");
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
