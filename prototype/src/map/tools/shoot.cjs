// Headless check for the map: screenshots + fps. Needs playwright (e.g. from an npx cache):
//   PW=<dir>/node_modules/playwright node src/map/tools/shoot.cjs [outDir]
// Expects `npx vite` on 127.0.0.1:5199 (and optionally the API on 5198).
const { chromium } = require(process.env.PW || 'playwright');
const path = require('path');

const BASE = process.env.BASE || 'http://127.0.0.1:5199/src/map/dev.html';
const out = path.resolve(process.argv[2] || 'screens');
const only = process.env.ONLY;

(async () => {
  const browser = await chromium.launch({ args: ['--use-angle=metal', '--enable-gpu-rasterization', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  const logs = [];
  page.on('console', (m) => logs.push(m.text()));
  page.on('pageerror', (e) => logs.push('PAGEERROR ' + e.message));
  const shots = [
    ['map-fleet', ''],
    ['map-team', '?zoom=team&team=swarm'],
    ['map-agent', '?zoom=agent'],
  ];
  for (const [name, qs] of shots) {
    if (only && !only.split(',').includes(name)) continue;
    await page.goto(BASE + qs);
    await page.waitForTimeout(Number(process.env.WAIT || 3500));
    await page.screenshot({ path: path.join(out, `${name}.png`) });
    console.log('shot', name);
  }
  if (!only || only.includes('bench')) {
    const p2 = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    p2.on('console', (m) => { if (m.text().startsWith('[map bench]')) console.log(m.text()); });
    p2.on('pageerror', (e) => console.log('PAGEERROR ' + e.message));
    await p2.goto(BASE + '?bench=1');
    await p2.waitForTimeout(9000);
    await p2.screenshot({ path: path.join(out, 'map-bench.png') });
  }
  for (const l of logs) if (/error|PAGEERROR/i.test(l)) console.log(l);
  await browser.close();
})();
