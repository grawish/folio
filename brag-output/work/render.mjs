import { chromium } from 'playwright';
import fs from 'node:fs';
fs.mkdirSync('brag-output/work/frames', { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
page.on('pageerror', (e) => console.log('pageerror:', e.message));
await page.goto('http://127.0.0.1:8765/brag-output/work/video.html');
await page.waitForFunction(() => window.READY, null, { timeout: 60000 });
const dur = await page.evaluate(() => window.DURATION);
const N = Math.round(dur * 30);
for (let f = 0; f < N; f++) {
  await page.evaluate((t) => window.renderAt(t), f / 30);
  await page.screenshot({ path: `brag-output/work/frames/f${String(f).padStart(4, '0')}.png` });
  if (f % 60 === 0) console.log('frame', f, '/', N);
}
await browser.close();
console.log('done', N);
