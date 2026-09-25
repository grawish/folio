import { chromium, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
const root = path.resolve('.site');
const types = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};
const server = createServer(async (req, res) => {
  try {
    const route = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const file = path.resolve(root, `.${route === '/' ? '/index.html' : route}`);
    if (!file.startsWith(root + path.sep)) throw new Error('Invalid path');
    const content = await fs.readFile(file);
    res.setHeader('Content-Type', types[path.extname(file)] ?? 'application/octet-stream');
    res.end(content);
  } catch {
    res.statusCode = 404;
    res.end('Not found');
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();
await fs.mkdir('test-results/website', { recursive: true });
const errors = [];
const checks = [];
try {
  for (const width of [1440, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 960 }, deviceScaleFactor: 1 });
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('response', (response) => {
      if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`);
    });
    for (const route of ['/', '/demos.html']) {
      await page.goto(origin + route);
      await page.locator('footer').scrollIntoViewIfNeeded();
      // Lazy screenshots may not have entered the viewport yet; load every asset
      // for a real decode check instead of checking only filenames.
      await page.evaluate(async () => {
        await document.fonts.ready;
        await Promise.all(
          [...document.images].map(async (img) => {
            img.loading = 'eager';
            await img.decode();
          }),
        );
      });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      const anchors = await page
        .locator('a[href^="#"]')
        .evaluateAll((links) => links.map((link) => link.getAttribute('href')));
      for (const anchor of anchors) expect(await page.locator(anchor).count()).toBeGreaterThan(0);
      await page.getByRole('button', { name: 'Switch to light theme' }).click();
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
      await page.reload();
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
      await page.getByRole('button', { name: 'Switch to dark theme' }).click();
      await page.evaluate(() => scrollTo(0, 0));
      await page.screenshot({
        path: `test-results/website/${width}-${route === '/' ? 'home' : 'demos'}.png`,
        fullPage: true,
      });
      await page.screenshot({
        path: `test-results/website/${width}-${route === '/' ? 'home' : 'demos'}-viewport.png`,
      });
      checks.push({
        width,
        route,
        images: await page.locator('img').count(),
        overflow: false,
        themePersistence: true,
      });
    }
    await page.close();
  }
  expect(errors).toEqual([]);
  await fs.writeFile(
    'test-results/website/result.json',
    JSON.stringify({ checks, errors }, null, 2) + '\n',
  );
  console.log(JSON.stringify({ checks, errors }, null, 2));
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
