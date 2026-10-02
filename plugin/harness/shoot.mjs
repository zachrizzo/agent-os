// Runs twice (dark, then light): shoots the Agent OS map live-only (default) and with History on, then the "Message agent" composer (agent view, team view, session drawer after a send), then drives the mock-host harness in WebKit: Agent OS tab -> click "Talk to Voice" -> Voice pane live ->
// header "Stop voice · Agent OS" -> back on the tab; finally a live theme toggle in the host (no reload). Screenshots go to argv[2], named <engine>-<scheme>-<step>.png. Usage: node harness/shoot.mjs <outdir> [baseUrl] [chromium].
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
// One full click-through per colour scheme. The standalone Agent OS page follows prefers-color-scheme (emulated); the host-embedded
// part uses the mock Control UI host's own theme switch (?theme=), which is what the plugin's theme bridge listens to.
async function run(scheme) {
const page = await browser.newPage({ viewport: { width: 1280, height: 760 }, colorScheme: scheme });
const logs = [];
page.on("console", (m) => logs.push(m.text()));
page.on("pageerror", (e) => logs.push("PAGEERROR " + e.message));
const shot = (name) => page.screenshot({ path: path.join(out, `${tag}-${scheme}-${name}.png`) });

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
await page.selectOption("[data-set=mode]", "roundtable"); // the classic everyone-answers thread; council mode is shot further down
await page.waitForSelector("[data-set=maxRounds]");
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
// Council mode (the default): live statuses, ONE captain reply with the panel collapsed / expanded, and the @mention bypass.
await page.click("#rooms [data-act=new]");
await page.fill(".rm-name-in", "RFC Council");
for (const id of ["spark", "forge", "research"]) await page.locator(`input[data-pick=${id}]`).check();
await page.click("[data-act=create]");
await page.waitForSelector(".rm-bar h3");
await page.locator(".rm-compose textarea").fill("slow: should we ship the migration this week? conflict");
await page.keyboard.press("Enter");
await page.waitForSelector(".rm-council .rm-cst");
await page.waitForFunction(() => [...document.querySelectorAll(".rm-cst")].some((e) => e.textContent === "working"), null, { timeout: 15000 });
await page.waitForTimeout(500);
await shot("2a-council-live-working");
await page.waitForFunction(() => [...document.querySelectorAll(".rm-cst")].some((e) => e.textContent === "critiquing"), null, { timeout: 15000 });
await page.waitForTimeout(400);
await shot("2b-council-live-critiquing");
await page.waitForFunction(() => !document.querySelector(".rm-compose .rm-typing") && document.querySelector(".rm-msg.captain:not(.pending)"), null, { timeout: 25000 });
await page.waitForTimeout(400);
await shot("2c-council-done-collapsed");
await page.locator(".rm-council > summary").click();
await page.waitForSelector(".rm-council[open] .rm-note");
await page.waitForTimeout(300);
await shot("2d-council-done-expanded");
await page.locator(".rm-compose textarea").fill("@research quick opinion on the rollback plan?");
await page.keyboard.press("Enter");
await page.waitForSelector(".rm-status .rm-typing");
await page.waitForFunction(() => !document.querySelector(".rm-compose .rm-typing"), null, { timeout: 15000 });
await page.locator(".rm-council > summary").click(); // fold the panel so the bypass reads clearly
await page.waitForTimeout(300);
await shot("2e-mention-bypass");
await page.click(".rooms-btn");
await page.setViewportSize({ width: 1280, height: 760 });

await page.goto(base + `?theme=${scheme}`);
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
await page.goto(base + `?nomic=1&theme=${scheme}`);
await page.waitForSelector(".agent-os-voice__btn");
await page.click(".agent-os-voice__btn");
await page.waitForTimeout(500);
await shot("4-no-mic-landed-in-voice");
console.log(scheme, "shots done; logs:", JSON.stringify(logs));
await page.close();
}
await run("dark");
await run("light");

// Live theme toggle inside the host: map -> drawer -> back, flipping the host's theme with no reload (screenshots before/after).
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 860 } });
  await page.goto(base + "?theme=dark");
  await page.waitForSelector(".agent-os-voice__btn");
  await page.waitForTimeout(4000);
  const shot = (name) => page.screenshot({ path: path.join(out, `${tag}-toggle-${name}.png`) });
  const frame = page.frames().find((f) => f.url().includes("/agent-os/"));
  await frame.evaluate(() => { window.__noReload = 1; });
  await shot("1-dark");
  await page.click("#theme-toggle");
  await page.waitForTimeout(1200);
  await shot("2-light-same-page");
  await frame.locator("#activity .ev").first().click();
  await frame.waitForSelector("#drawer.open .thread");
  await page.waitForTimeout(600);
  await shot("3-light-drawer");
  await page.click("#theme-toggle");
  await page.waitForTimeout(1200);
  await shot("4-dark-drawer-after-toggle-back");
  console.log("no reload across toggles:", await frame.evaluate(() => window.__noReload === 1));
  await page.close();
}
await browser.close();
process.exit(0); // the harness server started by ensureServer would otherwise keep node alive
