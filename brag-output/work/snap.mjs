import { chromium } from 'playwright';
const times = process.argv.slice(2).map(Number);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
page.on('console', (m) => console.log('console:', m.text()));
page.on('pageerror', (e) => console.log('pageerror:', e.message));
await page.goto('http://127.0.0.1:8765/brag-output/work/video.html');
await page.waitForFunction(() => window.READY, null, { timeout: 60000 });
for (const t of times) {
  await page.evaluate((t) => window.renderAt(t), t);
  await page.screenshot({ path: `brag-output/work/stills/t${t.toFixed(2)}.png` });
}
await browser.close();
