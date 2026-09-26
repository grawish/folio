import { promises as fs } from 'node:fs';
import path from 'node:path';
const names = [
  'first-resume',
  'ai-connections',
  'chat-and-feedback',
  'files-and-import',
  'save-and-recover',
  'recover-an-import',
  'editor-and-pdf',
  'settings-and-compiler',
  'resource-packs',
];
const sources = [
  ...names.map((name) => `docs/tutorials/${name}.md`),
  'docs/ARCHITECTURE.md',
  'docs/RELEASE_GAP_AUDIT.md',
];
const targets = new Map(sources.map((source) => [source, path.basename(source)]));
const destination = 'skills/folio-resume/references';
await fs.mkdir(destination, { recursive: true });
for (const source of sources) {
  let text = await fs.readFile(source, 'utf8');
  text = text.replace(/(!?)\[([^\]]+)\]\(([^)]+)\)/g, (match, image, label, url) => {
    if (/^(https?:|#)/.test(url)) return match;
    const [file, anchor] = url.split('#');
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(source), file));
    const target =
      targets.get(resolved) ?? `https://github.com/grawish/folio/blob/main/${resolved}`;
    return `[${image ? 'Screenshot: ' : ''}${label}](${target}${anchor ? `#${anchor}` : ''})`;
  });
  await fs.writeFile(
    path.join(destination, path.basename(source)),
    `<!-- Generated from ${source}; run npm run skill:build after editing the guide. -->\n\n${text}`,
  );
}
await fs.copyFile('LICENSE', 'skills/folio-resume/LICENSE');
await fs.copyFile('NOTICE', 'skills/folio-resume/NOTICE');
console.log(`Updated ${sources.length} standalone skill references.`);
