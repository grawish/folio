import { promises as fs } from 'node:fs';
import path from 'node:path';
const out = path.resolve('.site');
await fs.mkdir(out, { recursive: true });
await fs.cp('website', out, { recursive: true });
await fs.copyFile('src/theme.css', path.join(out, 'theme.css'));
await fs.cp('docs/images', path.join(out, 'images'), { recursive: true });
await fs.cp('public/templates', path.join(out, 'templates'), { recursive: true });
await fs.cp('public/licenses', path.join(out, 'licenses'), { recursive: true });
await fs.mkdir(path.join(out, 'fonts'), { recursive: true });
await fs.copyFile(
  'src/assets/fonts/manrope-normal-latin.woff2',
  path.join(out, 'fonts/manrope-latin.woff2'),
);
await fs.copyFile('LICENSE', path.join(out, 'LICENSE.txt'));
await fs.copyFile('NOTICE', path.join(out, 'NOTICE.txt'));
await fs.writeFile(path.join(out, '.nojekyll'), '');
const demos = JSON.parse(await fs.readFile('docs/demos/catalog.json', 'utf8'));
const escape = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
for (const demo of demos) {
  if (!/^[a-z0-9-]+$/.test(demo.id) || !/^[a-z0-9-]+\.png$/.test(demo.image))
    throw new Error('Invalid demo path');
  await fs.access(path.join('docs/images', demo.image));
  await fs.access(path.join('docs', demo.guide.split('#')[0]));
}
const cards = demos
  .map(
    (d) =>
      `<article class="demo-card" id="${d.id}"><a href="images/${d.image}"><img src="images/${d.image}" alt="${escape(d.alt)}" width="1480" height="960" loading="lazy"></a><div class="demo-card-content"><p class="tag">${escape(d.kind)}</p><h2>${escape(d.title)}</h2><p>${escape(d.description)}</p><ol>${d.steps.map((s) => `<li>${escape(s)}</li>`).join('')}</ol><a class="text-link" href="https://github.com/grawish/folio/blob/main/docs/${escape(d.guide)}">Read the tutorial →</a><a class="text-link" href="images/${d.image}">Full screenshot ↗</a></div></article>`,
  )
  .join('\n');
const home = await fs.readFile('website/index.html', 'utf8');
const header = home.slice(home.indexOf('<header'), home.indexOf('<main'));
const footer = home.slice(home.indexOf('<footer'), home.indexOf('</body>'));
await fs.writeFile(
  path.join(out, 'demos.html'),
  `<!doctype html><html lang="en" data-theme="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="description" content="Real Folio screenshots and step-by-step feature demos, using synthetic resumes."><title>Folio — demos and tutorials</title><link rel="icon" href="favicon.svg" type="image/svg+xml"><link rel="stylesheet" href="theme.css"><link rel="stylesheet" href="site.css"><script src="site.js" defer></script></head><body><a class="skip-link" href="#main">Skip to content</a>${header.replace('href="#workflow"', 'href="./#workflow"')}<main id="main" class="wrap"><section class="demo-intro"><p class="eyebrow">A WALK THROUGH FOLIO</p><h1>See the details.<br>Try them yourself.</h1><p class="muted">Real app screenshots, simple steps, and synthetic sample resumes.<br>AI fixture demos and empty connection forms are labeled. These are screenshot walkthroughs, not videos.</p></section><nav class="demo-index" aria-label="Demo topics">${demos.map((d) => `<a href="#${d.id}">${escape(d.title)}</a>`).join('')}</nav><div class="demo-grid">${cards}</div></main>${footer}</body></html>`,
);
console.log(`Built website with ${demos.length} screenshot demos in .site/`);
