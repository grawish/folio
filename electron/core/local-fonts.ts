import { promises as fs, constants } from 'node:fs';
import path from 'node:path';
import type { Project } from '../../src/shared/types';
import { addSource } from '../../src/shared/project-files';
import { fontStyles, type FontStyle, type FontTarget } from '../../src/shared/fonts';
import { validateProject } from './project';

export const fontByteLimit = 20 * 1024 * 1024;
export type LocalFont = { name: string; extension: 'otf' | 'ttf'; data: Buffer };

// Basic OpenType container checks, not a font sanitizer. Actual font loading
// takes place only in the existing bounded, offline compiler sandbox.
// https://learn.microsoft.com/en-us/typography/opentype/spec/otff
export function checkFont(data: Buffer) {
  if (data.length < 12 || data.length > fontByteLimit)
    throw new Error('Choose an OTF or TTF font file up to 20 MB.');
  if (![0x00010000, 0x4f54544f].includes(data.readUInt32BE(0)))
    throw new Error(
      'This is not a supported single OTF or TTF font. Font collections and web fonts are not supported.',
    );
  const count = data.readUInt16BE(4),
    end = 12 + count * 16;
  if (!count || count > 4095 || end > data.length)
    throw new Error('The font table directory is damaged. Choose another font file.');
  const tags = new Set<string>();
  for (let at = 12; at < end; at += 16) {
    const tag = data.toString('latin1', at, at + 4);
    const offset = data.readUInt32BE(at + 8),
      length = data.readUInt32BE(at + 12);
    if (
      tags.has(tag) ||
      !/^[\x20-\x7e]{4}$/.test(tag) ||
      offset < end ||
      offset + length > data.length
    )
      throw new Error('The font contains an invalid table. Choose another font file.');
    tags.add(tag);
  }
  if (!tags.has('cmap') || !tags.has('head') || !tags.has('name'))
    throw new Error('The font is missing required tables. Choose another font file.');
}

export async function readLocalFont(filename: string): Promise<LocalFont> {
  const extension = path.extname(filename).slice(1).toLowerCase();
  if (extension !== 'otf' && extension !== 'ttf')
    throw new Error('Choose an .otf or .ttf font file.');
  const file = await fs.open(
    filename,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(fontByteLimit))
      throw new Error('Choose a regular font file up to 20 MB, without symbolic links.');
    const data = Buffer.alloc(Number(before.size) + 1);
    let size = 0;
    while (size < data.length) {
      const read = await file.read(data, size, data.length - size, size);
      if (!read.bytesRead) break;
      size += read.bytesRead;
    }
    const after = await file.stat({ bigint: true });
    if (
      size !== Number(before.size) ||
      after.size !== before.size ||
      after.mtimeNs !== before.mtimeNs ||
      after.ctimeNs !== before.ctimeNs
    )
      throw new Error('The font file changed while reading it. Choose it again.');
    const bytes = data.subarray(0, size);
    checkFont(bytes);
    return { name: path.basename(filename).slice(0, 240), extension, data: bytes };
  } finally {
    await file.close();
  }
}

function documentStart(source: string): number {
  let depth = 0;
  const begin = /\\begin\s*\{document\}/y;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (char === '%') {
      const end = source.indexOf('\n', i);
      if (end < 0) break;
      i = end;
    } else if (char === '\\') {
      begin.lastIndex = i;
      if (!depth && begin.test(source)) return i;
      // A control symbol such as \% or \{ does not start a comment/group.
      i++;
      if (/[a-zA-Z]/.test(source[i] ?? '')) while (/[a-zA-Z]/.test(source[i + 1] ?? '')) i++;
    } else if (char === '{') depth++;
    else if (char === '}') depth--;
    if (depth < 0) break;
  }
  throw new Error(
    'Folio could not find a plain \\begin{document} in the main file. Fix its structure before adding fonts.',
  );
}

export function fontProject(
  project: Project,
  id: string,
  fonts: Map<FontStyle, LocalFont>,
  target: FontTarget,
) {
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id) || target !== 'body')
    throw new Error('Invalid font setup.');
  const regular = fonts.get('regular');
  if (!regular) throw new Error('Choose the regular font first.');
  const folder = `fonts/folio-${id}`;
  const assets = new Map<string, Buffer>();
  const names = new Map<FontStyle, string>();
  for (const style of fontStyles) {
    const font = fonts.get(style);
    if (!font) continue;
    const filename = `${style}.${font.extension}`;
    assets.set(`${folder}/${filename}`, font.data);
    names.set(style, filename);
  }
  const options = [
    `Path={${folder}/}`,
    `BoldFont={${names.get('bold') ?? names.get('regular')}}`,
    `ItalicFont={${names.get('italic') ?? names.get('regular')}}`,
    `BoldItalicFont={${names.get('boldItalic') ?? names.get('regular')}}`,
  ].join(',\n  ');
  const commands = ['setmainfont', 'setsansfont'];
  const savedFamily = `FolioSavedFamily${id.replaceAll('-', '')}`;
  const setup =
    '% Local fonts added by Folio. Keep this file with its font files.\n' +
    `\\expandafter\\let\\csname ${savedFamily}\\endcsname\\familydefault\n` +
    '\\renewcommand{\\familydefault}{\\rmdefault}\n\\usepackage{fontspec}\n' +
    commands
      .map((command) => `\\${command}[\n  ${options}\n]{${names.get('regular')}}\n`)
      .join('') +
    `\\expandafter\\let\\expandafter\\familydefault\\csname ${savedFamily}\\endcsname\n\\normalfont\n`;
  const setupFile = `${folder}/font-setup.tex`;
  const main = project.files.find((file) => file.path === project.mainFile)!;
  const at = documentStart(main.content);
  const next = addSource(
    {
      ...project,
      files: project.files.map((file) =>
        file.path === main.path
          ? {
              ...file,
              content: `${main.content.slice(0, at)}\n\\input{${setupFile}}\n${main.content.slice(at)}`,
            }
          : file,
      ),
    },
    setupFile,
    setup,
  );
  return { project: validateProject(next), assets, setupFile };
}
