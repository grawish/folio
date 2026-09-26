import type { Project } from '../../src/shared/types';
import { fingerprint, safeRelative, validateProject } from './project';

export class InvalidModelEdit extends Error {}
const field = { type: 'string' };
export const editSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['message', 'needsInput', 'edits'],
  properties: {
    message: field,
    needsInput: { type: 'boolean' },
    edits: {
      type: 'array',
      items: {
        anyOf: [
          {
            type: 'object',
            additionalProperties: false,
            required: ['path', 'search', 'replacement'],
            properties: { path: field, search: field, replacement: field },
          },
          {
            type: 'object',
            additionalProperties: false,
            required: ['path', 'content'],
            properties: { path: field, content: field },
          },
        ],
      },
    },
  },
};
const structure = (source: string) =>
  source.match(/\\(?:[a-zA-Z@]+\*?|.)|[{}$%&#_^~\r\n]/g)?.join('\0') ?? '';
function textRange(source: string, start: number, end: number) {
  const body = source.indexOf('\\begin{document}');
  if (body < 0 || start < body + 16 || end > source.indexOf('\\end{document}')) return false;
  const lines = source.slice(
    source.lastIndexOf('\n', start - 1) + 1,
    source.indexOf('\n', end) < 0 ? source.length : source.indexOf('\n', end),
  );
  const commands = lines.match(/\\[a-zA-Z@]+/g) ?? [];
  return (
    commands.every((c) =>
      [
        '\\item',
        '\\textbf',
        '\\textit',
        '\\emph',
        '\\section',
        '\\subsection',
        '\\resumeItem',
      ].includes(c),
    ) && !/[$%&#_^~]/.test(lines)
  );
}

export function applyModelEdits(project: Project, value: unknown) {
  try {
    const reply = value as { message?: unknown; needsInput?: unknown; edits?: unknown };
    if (
      !reply ||
      typeof reply.message !== 'string' ||
      reply.message.length > 100_000 ||
      typeof reply.needsInput !== 'boolean' ||
      !Array.isArray(reply.edits) ||
      reply.edits.length > 100
    )
      throw new Error('The AI returned an invalid edit.');
    if (reply.needsInput && reply.edits.length)
      throw new Error('The AI requested more information and edits at the same time.');
    const originals = new Map(project.files.map((f) => [f.path, f.content]));
    const files = new Map(originals);
    const groups = new Map<
      string,
      { path: string; edits: { start: number; end: number; replacement: string }[]; full?: string }
    >();
    let narrow = reply.edits.length > 0 && reply.edits.length <= 3,
      changedCharacters = 0;
    for (const edit of reply.edits) {
      const name = safeRelative(edit?.path),
        key = name.toLowerCase();
      let group = groups.get(key);
      if (group && group.path !== name)
        throw new Error('The AI returned duplicate or invalid file edits.');
      if (!group) {
        group = { path: name, edits: [] };
        groups.set(key, group);
      }
      if ('content' in edit) {
        if (
          typeof edit.content !== 'string' ||
          'search' in edit ||
          'replacement' in edit ||
          group.full !== undefined ||
          group.edits.length
        )
          throw new Error('The AI returned duplicate or invalid file edits.');
        group.full = edit.content;
        narrow = false;
        continue;
      }
      const source = originals.get(name);
      if (
        source === undefined ||
        typeof edit.search !== 'string' ||
        !edit.search ||
        typeof edit.replacement !== 'string' ||
        group.full !== undefined
      )
        throw new Error('An exact replacement requires an existing file and nonempty search text.');
      const start = source.indexOf(edit.search),
        end = start + edit.search.length;
      if (start < 0 || source.indexOf(edit.search, start + 1) >= 0)
        throw new Error(
          'Replacement search text must match exactly once. Include more surrounding text.',
        );
      if (group.edits.some((e) => start < e.end && end > e.start))
        throw new Error('The AI returned overlapping replacements.');
      group.edits.push({ start, end, replacement: edit.replacement });
      let prefix = 0,
        suffix = 0;
      while (
        prefix < edit.search.length &&
        prefix < edit.replacement.length &&
        edit.search[prefix] === edit.replacement[prefix]
      )
        prefix++;
      while (
        suffix < edit.search.length - prefix &&
        suffix < edit.replacement.length - prefix &&
        edit.search.at(-suffix - 1) === edit.replacement.at(-suffix - 1)
      )
        suffix++;
      changedCharacters += Math.max(edit.search.length, edit.replacement.length) - prefix - suffix;
      narrow &&= textRange(source, start + prefix, end - suffix);
    }
    for (const group of groups.values()) {
      let content = group.full ?? originals.get(group.path)!;
      for (const edit of group.edits.sort((a, b) => b.start - a.start))
        content = content.slice(0, edit.start) + edit.replacement + content.slice(edit.end);
      files.set(group.path, content);
      narrow &&=
        group.path.endsWith('.tex') &&
        structure(content) === structure(originals.get(group.path) ?? '');
    }
    const next = validateProject({
      ...project,
      revision: project.revision + 1,
      files: [...files].map(([path, content]) => ({ path, content })),
    });
    return {
      project: next,
      message: reply.message.trim(),
      needsInput: reply.needsInput,
      changed: fingerprint(next) !== fingerprint(project),
      narrow: narrow && groups.size === 1 && changedCharacters <= 200,
    };
  } catch (error) {
    throw new InvalidModelEdit(error instanceof Error ? error.message : 'Invalid edit.');
  }
}
