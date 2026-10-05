// Screenshots of the Docs view (rendered + raw, light + dark) against the mock harness: node harness/docs-shots.mjs <outDir>
import { createRequire } from "node:module";
import path from "node:path";
const { chromium } = createRequire("/Users/zachrizzo/.openclaw/tools/node-v24.21.0/lib/node_modules/openclaw/")("playwright-core");
import { ensureServer } from "./ensure-server.mjs";
const base = await ensureServer("http://127.0.0.1:5299/");
const out = path.resolve(process.argv[2] ?? ".");
const browser = await chromium.launch();
for (const scheme of ["light", "dark"]) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, colorScheme: scheme });
  await page.goto(base + "agent-os/?source=mock&file=reports/sample-report.md");
  await page.waitForSelector(".dc-md");
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(out, `docs-rendered-${scheme}.png`) });
  await page.click(".dc-toggle [data-mode=raw]");
  await page.waitForSelector("pre.dc-raw");
  await page.screenshot({ path: path.join(out, `docs-raw-${scheme}.png`) });
  await page.close();
}
await browser.close();
process.exit(0);
