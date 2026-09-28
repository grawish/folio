import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

// Maintainer-only conversion. Normal app builds use the reviewed, committed icon.
// macOS renders the existing website mark at each native pixel size, avoiding
// enlargement of the 64-pixel favicon and any third-party icon generator.
if (process.platform !== 'darwin') throw new Error('Icon conversion requires macOS.');
const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, 'resources/branding');
const source = await fs.readFile(path.join(root, 'website/favicon.svg'), 'utf8');
if (!source.includes('viewBox="0 0 64 64"') || /\b(?:width|height)=/.test(source.split('>')[0]))
  throw new Error('Review the changed favicon canvas before regenerating the app icon.');
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-icon-'));
try {
  const iconset = path.join(scratch, 'Folio.iconset');
  await fs.mkdir(iconset);
  const rendered = new Map();
  for (const points of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) {
      const size = points * scale;
      const png = path.join(iconset, `icon_${points}x${points}${scale === 2 ? '@2x' : ''}.png`);
      if (rendered.has(size)) {
        await fs.copyFile(rendered.get(size), png);
      } else {
        const svg = path.join(scratch, `mark-${size}.svg`);
        await fs.writeFile(svg, source.replace('<svg ', `<svg width="${size}" height="${size}" `));
        execFileSync('/usr/bin/sips', ['-s', 'format', 'png', svg, '--out', png], {
          stdio: 'pipe',
        });
        rendered.set(size, png);
      }
    }
  }
  const icon = path.join(scratch, 'folio.icns');
  execFileSync('/usr/bin/iconutil', ['-c', 'icns', iconset, '-o', icon], { stdio: 'pipe' });
  await fs.mkdir(output, { recursive: true });
  await fs.copyFile(rendered.get(1024), path.join(output, 'folio-1024.png'));
  await fs.copyFile(icon, path.join(output, 'folio.icns'));
  console.log(
    'Rendered Folio’s existing mark at 16–1024 pixels and wrote resources/branding/folio.icns.',
  );
} finally {
  await fs.rm(scratch, { recursive: true, force: true });
}
