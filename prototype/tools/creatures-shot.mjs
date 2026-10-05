// Headless-Chrome screenshots of the creatures: the dev page (every state) and a live Rooms view (mock fleet) with members hopping while their turn is in flight.
//   node tools/creatures-shot.mjs [outDir=screens] [vitePort=5391]     (vite on vitePort, mock data server on vitePort+1000; nothing installed, no live Gateway)
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const proto = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.resolve(process.argv[2] ?? path.join(proto, 'screens'));
const WEB = Number(process.argv[3] ?? 5391), API = WEB + 1000;
const CHROME = process.env.CHROME_BIN ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const { chromium } = createRequire('/Users/zachrizzo/.openclaw/tools/node-v24.21.0/lib/node_modules/openclaw/')('playwright-core');
mkdirSync(out, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const kids = [];
const run = (cmd, args, env) => { const c = spawn(cmd, args, { cwd: proto, env: { ...process.env, ...env }, stdio: 'ignore' }); kids.push(c); return c; };
let failed = false;
const check = (name, ok, detail = '') => { if (!ok) failed = true; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ' · ' + detail : ''}`); };
try {
  run(path.join(proto, 'node_modules/.bin/tsx'), ['server/index.ts', '--mock'], { AGENT_OS_API_PORT: String(API) });
  run(path.join(proto, 'node_modules/.bin/vite'), ['--port', String(WEB)], { AGENT_OS_API_PORT: String(API), HMR_CLIENT_PORT: String(WEB) });
  const base = `http://127.0.0.1:${WEB}`;
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`${base}/api/rooms?source=mock`)).ok) break; } catch { /* starting */ } await sleep(300); }
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  // 1. every creature in every state
  await page.goto(`${base}/creatures.html?ids=main,coder,scout,radar,security,rfc-doug,agent-service-lead,agent-service-reviewer,zach`);
  await page.waitForSelector('.cd-grid .avatar.cr');
  await sleep(1500);
  await page.screenshot({ path: path.join(out, 'creatures-states.png') });
  const states = await page.$$eval('.cd-grid .avatar.cr', (els) => [...new Set(els.map((e) => e.className.match(/cr-[a-z-]+?-(active|idle|needs|error)\b/)?.[1] ?? 'default'))]);
  check('dev page shows default + the four states', ['default', 'active', 'idle', 'needs', 'error'].every((s) => states.includes(s)), states.join(','));
  const painted = await page.evaluate(async () => {
    const el = document.querySelector('.avatar.cr-coder-error');
    const url = getComputedStyle(el).backgroundImage;
    return { url: url.slice(0, 30), anim: el && getComputedStyle(el).width };
  });
  check('a creature is painted as a background image', painted.url.startsWith('url("data:image/svg+xml'), painted.url);

  // 2. the Rooms view, members mid-turn
  const api = (p, body) => fetch(`${base}/api/${p}${p.includes('?') ? '&' : '?'}source=mock`, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json', 'x-agent-os-send': '1' }, body: JSON.stringify(body) }).then((r) => r.json());
  const created = await api('rooms', { name: 'Creature crew', members: ['main', 'coder', 'scout', 'radar', 'security'] });
  const id = created.room.id;
  await page.goto(`${base}/?source=mock`);
  await page.waitForSelector('.rooms-btn:not(.board-btn)');
  await page.click('.rooms-btn:not(.board-btn)');
  await page.locator('.rm-row', { hasText: 'Creature crew' }).click();
  await page.waitForSelector('.rm-bar h3');
  await page.fill('.rm-compose textarea', 'slow status check, who is on what?');
  await page.keyboard.press('Enter');
  await sleep(1600);
  const typing = await page.$$eval('.rm-msg.pending .avatar', (els) => els.map((e) => e.className));
  check('members with a turn in flight use the active look', typing.length >= 2 && typing.every((c) => /cr-[a-z-]+-active/.test(c)), typing.join(' | '));
  const chips = await page.$$eval('.rm-chip .avatar', (els) => els.map((e) => e.className));
  check('chips: active members hop, the waiting lead keeps the default look', chips.some((c) => /-active/.test(c)) && chips.some((c) => !/-active/.test(c)), chips.join(' | '));
  await page.screenshot({ path: path.join(out, 'creatures-rooms-active.png') });
  await page.waitForFunction(() => document.querySelectorAll('.rm-msg:not(.pending) .avatar.cr').length >= 4, null, { timeout: 30000 });
  await page.waitForFunction(() => !document.querySelector('.rm-msg.pending'), null, { timeout: 60000 });
  await sleep(500);
  const you = await page.$eval('.rm-msg.me .avatar', (e) => e.className);
  check('"You" is the zach creature', /cr-zach/.test(you), you);
  await page.screenshot({ path: path.join(out, 'creatures-rooms-done.png') });
  check('no page errors', errors.length === 0, errors.join('; '));
  await browser.close();
} catch (e) { failed = true; console.log('FAIL', e.stack ?? e); }
finally { for (const c of kids) { try { c.kill('SIGTERM'); } catch { /* gone */ } } await sleep(300); process.exit(failed ? 1 : 0); }
